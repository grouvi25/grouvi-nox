import crypto from 'node:crypto';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';

/**
 * Proof that the operator, and not just their browser session, approved this.
 *
 * The broker runs as root and must not take the web service's word for an
 * approval: that service parses untrusted traffic all day. So the operator's
 * passkey signs a challenge that binds three things together:
 *
 *   purpose  - applying a proposal is not the same as rolling a change back
 *   hash     - the exact bytes of what will run (see proposalHash)
 *   nonce    - issued here, valid once, so a captured signature is worthless
 *
 * The broker verifies that signature itself against the public keys enrolled
 * for the dashboard. Compromising the web service, a session cookie or the
 * page's JavaScript is therefore not enough to run anything as root.
 */

const MAX_PENDING = 32;

export function createApprovalGate({ loadCredentials, rpID, origin, ttlMs = 90_000, now = Date.now }) {
  const pending = new Map();
  const lazy = value => (typeof value === 'function' ? value() : value);

  function sweep() {
    for (const [nonce, entry] of pending) if (now() > entry.expiresAt) pending.delete(nonce);
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
  }

  /** Hands out a challenge for the browser to sign. */
  function issue(hash, purpose = 'apply') {
    sweep();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw Object.assign(new Error('bad_hash'), { status: 400 });
    if (!['apply', 'rollback'].includes(purpose)) throw Object.assign(new Error('bad_purpose'), { status: 400 });
    const nonce = crypto.randomBytes(24).toString('base64url');
    const challenge = crypto.createHash('sha256').update(`${purpose}\n${hash}\n${nonce}`).digest('base64url');
    const expiresAt = now() + ttlMs;
    pending.set(nonce, { hash, purpose, challenge, expiresAt });
    return { nonce, challenge, expiresAt };
  }

  /** Consumes the nonce whatever the outcome, so a failed guess cannot be retried. */
  async function verify({ nonce, hash, purpose = 'apply', assertion }) {
    const entry = pending.get(String(nonce));
    pending.delete(String(nonce));
    if (!entry || now() > entry.expiresAt) throw Object.assign(new Error('approval_expired'), { status: 403 });
    if (entry.hash !== hash || entry.purpose !== purpose) throw Object.assign(new Error('approval_mismatch'), { status: 403 });
    const credential = loadCredentials().find(c => c.id === assertion?.id);
    if (!credential) throw Object.assign(new Error('unknown_credential'), { status: 403 });
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge: entry.challenge,
        expectedOrigin: lazy(origin),
        expectedRPID: lazy(rpID),
        requireUserVerification: true,
        credential: {
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey, 'base64url'),
          counter: credential.counter || 0,
          transports: credential.transports,
        },
      });
    } catch {
      throw Object.assign(new Error('approval_invalid'), { status: 403 });
    }
    if (!result.verified) throw Object.assign(new Error('approval_invalid'), { status: 403 });
    return { credentialId: credential.id, label: credential.label || 'Passkey' };
  }

  return { issue, verify, pendingCount: () => pending.size };
}
