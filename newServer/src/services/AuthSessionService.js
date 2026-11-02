const crypto = require('crypto');
const redis = require('../db/redis');

const memoryStore = new Map();
const DEFAULT_TTL_SEC = Number.parseInt(process.env.AUTH_SESSION_TTL_SEC || '', 10) || 86400;

function buildSessionKey(token) {
  return `auth:session:${token}`;
}

function buildToken() {
  const now = Date.now().toString(36);
  const rand = crypto.randomBytes(16).toString('hex');
  return `ats_${now}_${rand}`;
}

function sanitizePayload(payload = {}) {
  return {
    accountId: String(payload.accountId || '').trim().toLowerCase(),
    roleId: String(payload.roleId || '').trim(),
    userId: String(payload.userId || '').trim(),
    serverId: Number(payload.serverId) || 0,
    serverName: String(payload.serverName || '').trim(),
    serverSwitched: payload.serverSwitched === true,
    loginTime: Number(payload.loginTime) || Date.now(),
  };
}

function memorySet(token, payload, ttlSec) {
  const expiresAt = Date.now() + ttlSec * 1000;
  memoryStore.set(token, { payload, expiresAt });
}

function memoryGet(token) {
  const row = memoryStore.get(token);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    memoryStore.delete(token);
    return null;
  }
  return row.payload;
}

async function set(token, payload, ttlSec = DEFAULT_TTL_SEC) {
  const safePayload = sanitizePayload(payload);
  const safeTtl = Number.isFinite(Number(ttlSec)) && Number(ttlSec) > 0
    ? Math.floor(Number(ttlSec))
    : DEFAULT_TTL_SEC;
  const client = redis.getClient();
  if (client) {
    await client.set(buildSessionKey(token), JSON.stringify(safePayload), 'EX', safeTtl);
  } else {
    memorySet(token, safePayload, safeTtl);
  }
  return safePayload;
}

async function create(payload, ttlSec = DEFAULT_TTL_SEC) {
  const token = buildToken();
  const session = await set(token, payload, ttlSec);
  return { token, session };
}

async function get(tokenInput) {
  const token = String(tokenInput || '').trim();
  if (!token) return null;
  const client = redis.getClient();
  if (client) {
    const raw = await client.get(buildSessionKey(token));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_err) {
      return null;
    }
  }
  return memoryGet(token);
}

async function remove(tokenInput) {
  const token = String(tokenInput || '').trim();
  if (!token) return;
  const client = redis.getClient();
  if (client) {
    await client.del(buildSessionKey(token));
    return;
  }
  memoryStore.delete(token);
}

module.exports = {
  buildToken,
  create,
  set,
  get,
  remove,
};
