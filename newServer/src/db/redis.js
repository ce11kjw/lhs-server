/**
 * Redis 连接管理
 * 使用 ioredis 连接 Redis，提供连接/断开/健康检查
 */

const Redis = require('ioredis');
const logger = require('../logger');

// 默认连接配置
const DEFAULT_HOST = process.env.REDIS_HOST || '127.0.0.1';
const DEFAULT_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const DEFAULT_PASSWORD = process.env.REDIS_PASSWORD || '';
const KEY_PREFIX = process.env.REDIS_PREFIX || '';
const COMMAND_TIMEOUT_MS = Math.max(500, Number(process.env.REDIS_COMMAND_TIMEOUT_MS || 3000) || 3000);
const MAX_RETRIES_PER_REQUEST = Math.max(
  0,
  Number(process.env.REDIS_MAX_RETRIES_PER_REQUEST || 2) || 2
);

let client = null;

/**
 * 连接 Redis
 * @param {Object} [options] - ioredis 连接选项
 * @returns {Redis}
 */
function connect(options) {
  if (client) return client;

  client = new Redis({
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    password: DEFAULT_PASSWORD || undefined,
    keyPrefix: KEY_PREFIX,
    // 断线自动重连，最大延迟 5 秒
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      return delay;
    },
    // 连接超时 10 秒
    connectTimeout: 10000,
    // Session bookkeeping must not hold a gameplay handler forever.
    commandTimeout: COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    ...options,
  });

  client.on('connect', () => {
    logger.info(`[Redis] 已连接: ${DEFAULT_HOST}:${DEFAULT_PORT}`);
  });

  client.on('error', (err) => {
    logger.error(`[Redis] 错误: ${err.message}`);
  });

  return client;
}

/**
 * 断开 Redis 连接
 */
async function disconnect() {
  if (client) {
    await client.quit();
    client = null;
    logger.info('[Redis] 已断开连接');
  }
}

/**
 * 获取 Redis 客户端实例
 * @returns {Redis|null}
 */
function getClient() {
  return client;
}

/**
 * 健康检查
 * @returns {Promise<boolean>}
 */
async function isConnected() {
  if (!client) return false;
  try {
    const result = await client.ping();
    return result === 'PONG';
  } catch (_err) {
    return false;
  }
}

module.exports = {
  connect,
  disconnect,
  getClient,
  isConnected,
};
