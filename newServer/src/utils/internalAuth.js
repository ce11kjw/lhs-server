const crypto = require('crypto');

const NONCE_STORE = new Map();
const TIMESTAMP_WINDOW_MS = Number(process.env.INTERNAL_API_SIGNATURE_WINDOW_MS || 5 * 60 * 1000);
const NONCE_TTL_MS = Math.max(TIMESTAMP_WINDOW_MS, Number(process.env.INTERNAL_API_NONCE_TTL_MS || TIMESTAMP_WINDOW_MS));

function normalizeBody(body) {
  if (body === undefined || body === null || body === '') {
    return '';
  }
  if (Buffer.isBuffer(body)) {
    return body.toString('utf8');
  }
  if (typeof body === 'string') {
    return body;
  }
  return JSON.stringify(body);
}

function buildPayload({ method, path, timestamp, nonce, body }) {
  return [
    String(method || '').toUpperCase(),
    String(path || ''),
    String(timestamp || ''),
    String(nonce || ''),
    normalizeBody(body),
  ].join('\n');
}

function signInternalRequest({ secret, method, path, timestamp, nonce, body }) {
  return crypto
    .createHmac('sha256', String(secret || ''))
    .update(buildPayload({ method, path, timestamp, nonce, body }), 'utf8')
    .digest('hex');
}

function timingSafeEqualHex(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function cleanupExpiredNonces(now = Date.now()) {
  for (const [nonce, expiresAt] of NONCE_STORE.entries()) {
    if (expiresAt <= now) {
      NONCE_STORE.delete(nonce);
    }
  }
}

function verifyInternalRequest({ secret, method, path, timestamp, nonce, signature, body }) {
  const now = Date.now();
  cleanupExpiredNonces(now);

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: 'INVALID_TIMESTAMP' };
  }
  if (Math.abs(now - ts) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, error: 'TIMESTAMP_EXPIRED' };
  }

  const normalizedNonce = String(nonce || '').trim();
  if (!normalizedNonce || normalizedNonce.length < 8) {
    return { ok: false, error: 'INVALID_NONCE' };
  }
  if (NONCE_STORE.has(normalizedNonce)) {
    return { ok: false, error: 'NONCE_REPLAYED' };
  }

  const expected = signInternalRequest({ secret, method, path, timestamp: ts, nonce: normalizedNonce, body });
  if (!timingSafeEqualHex(signature, expected)) {
    return { ok: false, error: 'INVALID_SIGNATURE' };
  }

  NONCE_STORE.set(normalizedNonce, now + NONCE_TTL_MS);
  return { ok: true };
}

module.exports = {
  buildPayload,
  cleanupExpiredNonces,
  signInternalRequest,
  verifyInternalRequest,
};
