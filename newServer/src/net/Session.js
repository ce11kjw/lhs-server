/**
 * Session - 玩家会话管理
 * 基于 Redis 存储会话状态，支持断线重连
 */

const redis = require('../db/redis');
const logger = require('../logger');

// 会话默认 TTL（秒）：30 分钟，心跳续期
const SESSION_TTL = 1800;

/**
 * 创建/更新玩家会话
 * @param {string} userId - 玩家 ID
 * @param {Object} data - 会话数据（wsId, serverId 等）
 * @returns {Promise<void>}
 */
async function set(userId, data) {
  const client = redis.getClient();
  if (!client) throw new Error('Redis 未连接');

  const sessionData = JSON.stringify({
    ...data,
    userId,
    loginTime: data.loginTime || Date.now(),
    lastActive: Date.now(),
  });
  await client.set(`session:${userId}`, sessionData, 'EX', SESSION_TTL);
}

/**
 * 获取玩家会话
 * @param {string} userId - 玩家 ID
 * @returns {Promise<Object|null>}
 */
async function get(userId) {
  const client = redis.getClient();
  if (!client) return null;

  const raw = await client.get(`session:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

// Lua 脚本：原子更新 lastActive 并续期 TTL
const RENEW_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local data = cjson.decode(raw)
data.lastActive = tonumber(ARGV[1])
redis.call('SET', KEYS[1], cjson.encode(data), 'EX', tonumber(ARGV[2]))
return 1
`;

/**
 * 心跳续期（原子操作）
 * @param {string} userId - 玩家 ID
 * @returns {Promise<boolean>} 是否续期成功
 */
async function renew(userId) {
  const client = redis.getClient();
  if (!client) return false;

  const result = await client.eval(RENEW_LUA, 1, `session:${userId}`, Date.now(), SESSION_TTL);
  return result === 1;
}

/**
 * 删除玩家会话（下线/踢人）
 * @param {string} userId - 玩家 ID
 * @returns {Promise<void>}
 */
async function remove(userId) {
  const client = redis.getClient();
  if (!client) return;

  await client.del(`session:${userId}`);
  logger.info(`[Session] 已移除会话: ${userId}`);
}

/**
 * 检查玩家是否在线
 * @param {string} userId - 玩家 ID
 * @returns {Promise<boolean>}
 */
async function isOnline(userId) {
  const client = redis.getClient();
  if (!client) return false;

  return (await client.exists(`session:${userId}`)) === 1;
}

/**
 * 增加在线人数计数
 */
async function incrOnline() {
  const client = redis.getClient();
  if (client) await client.incr('online:count');
}

/**
 * 减少在线人数计数
 */
async function decrOnline() {
  const client = redis.getClient();
  if (client) await client.decr('online:count');
}

/**
 * 获取在线人数
 * @returns {Promise<number>}
 */
async function getOnlineCount() {
  const client = redis.getClient();
  if (!client) return 0;

  const count = await client.get('online:count');
  return parseInt(count || '0', 10);
}

module.exports = {
  set,
  get,
  renew,
  remove,
  isOnline,
  incrOnline,
  decrOnline,
  getOnlineCount,
  SESSION_TTL,
};
