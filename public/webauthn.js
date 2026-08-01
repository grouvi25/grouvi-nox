export function b64uToBuf(b64u) {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const raw = atob(b64 + pad);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
  return arr.buffer;
}

export function bufToB64u(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function supported() {
  return Boolean(window.PublicKeyCredential && navigator.credentials);
}

export async function platformAvailable() {
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function prepareDescriptors(list) {
  return (list || []).map(c => ({
    ...c,
    id: b64uToBuf(c.id),
  }));
}

export async function register(options) {
  const publicKey = {
    ...options,
    challenge: b64uToBuf(options.challenge),
    user: { ...options.user, id: b64uToBuf(options.user.id) },
    excludeCredentials: prepareDescriptors(options.excludeCredentials),
  };
  const cred = await navigator.credentials.create({ publicKey });
  if (!cred) throw new Error('no_credential');
  const r = cred.response;
  return {
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    response: {
      clientDataJSON: bufToB64u(r.clientDataJSON),
      attestationObject: bufToB64u(r.attestationObject),
      transports: r.getTransports ? r.getTransports() : [],
    },
  };
}

export async function authenticate(options) {
  const publicKey = {
    ...options,
    challenge: b64uToBuf(options.challenge),
    allowCredentials: prepareDescriptors(options.allowCredentials),
  };
  const cred = await navigator.credentials.get({ publicKey });
  if (!cred) throw new Error('no_credential');
  const r = cred.response;
  return {
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    response: {
      clientDataJSON: bufToB64u(r.clientDataJSON),
      authenticatorData: bufToB64u(r.authenticatorData),
      signature: bufToB64u(r.signature),
      userHandle: r.userHandle ? bufToB64u(r.userHandle) : undefined,
    },
  };
}

export async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `http_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}
