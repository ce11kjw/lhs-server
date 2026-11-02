const redis = require('../db/redis');

const NODE_KEY_PREFIX = 'cross:node:';
const DEFAULT_TTL_SEC = Number(process.env.CROSS_NODE_TTL_SEC || 30);

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function getNodeKey(nodeId) {
  return `${NODE_KEY_PREFIX}${nodeId}`;
}

function normalizeNode(payload = {}) {
  const now = Date.now();
  const nodeId = payload.nodeId || `node_${now}`;
  const node = {
    nodeId,
    serverId: payload.serverId || '',
    host: payload.host || '',
    port: toSafeInt(payload.port, 0),
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    updatedAt: now,
  };
  return node;
}

async function registerNode(payload = {}) {
  const client = redis.getClient();
  if (!client) throw new Error('redis not connected');
  const node = normalizeNode(payload);
  const ttl = Math.max(1, DEFAULT_TTL_SEC);
  await client.set(getNodeKey(node.nodeId), JSON.stringify(node), 'EX', ttl);
  return node;
}

async function heartbeat(nodeId) {
  const client = redis.getClient();
  if (!client) throw new Error('redis not connected');
  if (!nodeId) throw new Error('nodeId is required');

  const key = getNodeKey(nodeId);
  const raw = await client.get(key);
  if (!raw) return null;

  const node = JSON.parse(raw);
  node.updatedAt = Date.now();
  await client.set(key, JSON.stringify(node), 'EX', Math.max(1, DEFAULT_TTL_SEC));
  return node;
}

async function listNodes() {
  const client = redis.getClient();
  if (!client) throw new Error('redis not connected');
  const keys = await client.keys(`${NODE_KEY_PREFIX}*`);
  if (!keys || keys.length === 0) return [];
  const values = await client.mget(keys);
  return values
    .filter(Boolean)
    .map((raw) => {
      try {
        return JSON.parse(raw);
      } catch (_e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

module.exports = {
  DEFAULT_TTL_SEC,
  registerNode,
  heartbeat,
  listNodes,
  normalizeNode,
};
