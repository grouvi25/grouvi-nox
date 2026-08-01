import express from 'express';
import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { config } from '../config.js';
import { rateLimit, requireSameOrigin, clientIp } from '../security.js';
import {
  CHALLENGE_COOKIE, putChallenge, takeChallenge, setChallengeCookie, clearChallengeCookie,
  readCookies, createSession, destroySession, currentSession, requireAuth,
  findEnrollToken, consumeEnrollToken, createEnrollToken,
  useRecoveryCode, listCredentials, addCredential, touchCredential, audit,
} from '../auth.js';

const router = express.Router();

const slowLimit = rateLimit({ windowMs: 60_000, max: 20, name: 'auth' });
const enrollLimit = rateLimit({ windowMs: 15 * 60_000, max: 10, name: 'enroll' });
const recoverLimit = rateLimit({ windowMs: 60 * 60_000, max: 5, name: 'recover' });

router.use(requireSameOrigin);

const b64u = (v) => Buffer.from(v).toString('base64url');

/** Normalise verified registration output across simplewebauthn majors. */
function normaliseRegistration(info) {
  if (info?.credential) {
    return {
      id: info.credential.id,
      publicKey: b64u(info.credential.publicKey),
      counter: info.credential.counter ?? 0,
      transports: info.credential.transports || [],
    };
  }
  return {
    id: typeof info.credentialID === 'string' ? info.credentialID : b64u(info.credentialID),
    publicKey: b64u(info.credentialPublicKey),
    counter: info.counter ?? 0,
    transports: [],
  };
}

/* -------------------------- state -------------------------- */

router.get('/state', (req, res) => {
  res.json({
    authenticated: Boolean(currentSession(req)),
    enrolled: listCredentials().length > 0,
    rpID: config.rpID,
  });
});

/* ----------------------- registration ----------------------- */

router.post('/register/options', enrollLimit, async (req, res, next) => {
  try {
    const raw = String(req.body?.token || '');
    const token = findEnrollToken(raw);
    if (!token) {
      audit('enroll.reject', 'invalid or expired enrollment token', clientIp(req));
      return res.status(403).json({ error: 'invalid_enrollment_token' });
    }

    const existing = listCredentials();
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userID: new Uint8Array(Buffer.from('vps-admin')),
      userName: `admin@${config.rpID}`,
      userDisplayName: 'VPS Sentinel admin',
      attestationType: 'none',
      excludeCredentials: existing.map(c => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
      supportedAlgorithmIDs: [-7, -257],
    });

    const chid = putChallenge('register', options.challenge, { tokenId: token.id });
    setChallengeCookie(res, chid);
    res.json(options);
  } catch (e) { next(e); }
});

router.post('/register/verify', enrollLimit, async (req, res, next) => {
  try {
    const chid = readCookies(req)[CHALLENGE_COOKIE];
    const stored = takeChallenge(chid, 'register');
    clearChallengeCookie(res);
    if (!stored) return res.status(400).json({ error: 'challenge_expired' });

    const raw = String(req.body?.token || '');
    const token = findEnrollToken(raw);
    if (!token || token.id !== stored.tokenId) {
      return res.status(403).json({ error: 'invalid_enrollment_token' });
    }

    const verification = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: stored.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      audit('enroll.fail', 'attestation not verified', clientIp(req));
      return res.status(400).json({ error: 'verification_failed' });
    }

    const cred = normaliseRegistration(verification.registrationInfo);
    if (listCredentials().some(c => c.id === cred.id)) {
      return res.status(409).json({ error: 'credential_already_registered' });
    }

    addCredential({
      ...cred,
      label: String(req.body?.label || 'Passkey').slice(0, 60),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      deviceType: verification.registrationInfo.credentialDeviceType || 'unknown',
      backedUp: Boolean(verification.registrationInfo.credentialBackedUp),
    });
    consumeEnrollToken(token);
    audit('enroll.success', `credential ${cred.id.slice(0, 12)}…`, clientIp(req));

    createSession(res, { ip: clientIp(req), ua: req.get('user-agent'), credentialId: cred.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------------------- authentication ---------------------- */

router.post('/login/options', slowLimit, async (req, res, next) => {
  try {
    const creds = listCredentials();
    if (creds.length === 0) return res.status(409).json({ error: 'no_credentials_enrolled' });

    const options = await generateAuthenticationOptions({
      rpID: config.rpID,
      allowCredentials: creds.map(c => ({ id: c.id, transports: c.transports })),
      userVerification: 'required',
    });

    const chid = putChallenge('login', options.challenge);
    setChallengeCookie(res, chid);
    res.json(options);
  } catch (e) { next(e); }
});

router.post('/login/verify', slowLimit, async (req, res, next) => {
  try {
    const chid = readCookies(req)[CHALLENGE_COOKIE];
    const stored = takeChallenge(chid, 'login');
    clearChallengeCookie(res);
    if (!stored) return res.status(400).json({ error: 'challenge_expired' });

    const response = req.body?.response;
    const cred = listCredentials().find(c => c.id === response?.id);
    if (!cred) {
      audit('login.fail', 'unknown credential', clientIp(req));
      return res.status(403).json({ error: 'unknown_credential' });
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: true,
      credential: {
        id: cred.id,
        publicKey: Buffer.from(cred.publicKey, 'base64url'),
        counter: cred.counter,
        transports: cred.transports,
      },
    });

    if (!verification.verified) {
      audit('login.fail', 'assertion not verified', clientIp(req));
      return res.status(403).json({ error: 'verification_failed' });
    }

    const newCounter = verification.authenticationInfo?.newCounter ?? cred.counter;
    if (cred.counter > 0 && newCounter > 0 && newCounter <= cred.counter) {
      audit('login.fail', 'counter regression - possible cloned authenticator', clientIp(req));
      return res.status(403).json({ error: 'counter_regression' });
    }
    touchCredential(cred.id, newCounter);

    createSession(res, { ip: clientIp(req), ua: req.get('user-agent'), credentialId: cred.id });
    audit('login.success', cred.label, clientIp(req));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ------------------------- recovery ------------------------- */

router.post('/recover', recoverLimit, (req, res) => {
  const ok = useRecoveryCode(String(req.body?.code || ''));
  if (!ok) {
    audit('recover.fail', 'bad recovery code', clientIp(req));
    return res.status(403).json({ error: 'invalid_code' });
  }
  const token = createEnrollToken('issued via recovery code');
  audit('recover.success', 'enrollment token issued', clientIp(req));
  res.json({ ok: true, token });
});

/* -------------------------- logout -------------------------- */

router.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

router.get('/credentials', requireAuth, (req, res) => {
  res.json({
    credentials: listCredentials().map(c => ({
      id: `${c.id.slice(0, 10)}…`,
      label: c.label,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
      deviceType: c.deviceType,
      backedUp: c.backedUp,
    })),
  });
});

export default router;
