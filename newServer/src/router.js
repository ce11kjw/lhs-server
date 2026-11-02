/**
 * 协议路由器
 * 基于 tag 数字分发消息到对应 handler
 */

const logger = require('./logger');

// handler 注册表: tag → handler(data, session, msgUid)
const handlers = {};

// fallback handler（处理未注册的 tag）
let fallbackHandler = null;

/**
 * 注册 handler
 * @param {number} tag - 协议标签
 * @param {Function} handler - 处理函数 (data, session, msgUid) => result
 */
function register(tag, handler) {
  handlers[tag] = handler;
}

/**
 * 批量注册 handler
 * @param {Object} map - { tag: handler } 映射
 */
function registerAll(map) {
  for (const [tag, handler] of Object.entries(map)) {
    handlers[Number(tag)] = handler;
  }
}

/**
 * 设置 fallback handler（处理所有未注册的 tag）
 * @param {Function} handler - (tag, data, session, msgUid) => result
 */
function setFallback(handler) {
  fallbackHandler = handler;
}

// 不需要登录的 tag（登录、心跳）
const NO_AUTH_TAGS = new Set([1, 11]);

/**
 * 路由消息到对应 handler
 * @param {number} tag - 协议标签
 * @param {number} msgUid - 消息唯一 ID
 * @param {*} data - 消息数据
 * @param {Object} session - 玩家会话上下文
 * @returns {*} handler 返回的响应
 */
function route(tag, msgUid, data, session) {
  // 临时调试日志
  if (tag === 1400) {
    logger.info(`[Router] tag=1400 收到请求, data=${JSON.stringify(data)}, hasPlayer=${!!session.player}`);
  }
  // 登录检查：未登录只允许 tag=1 和 tag=11
  if (!NO_AUTH_TAGS.has(tag) && !session.player) {
    logger.warn(`[Router] 未登录请求 tag=${tag}，拒绝`);
    return { tag, msgUid, data: { result: -1, msg: 'not logged in' } };
  }

  const handler = handlers[tag];
  if (handler) {
    return handler(data, session, msgUid);
  }

  // 未注册的 tag，尝试 fallback
  if (fallbackHandler) {
    return fallbackHandler(tag, data, session, msgUid);
  }

  // 返回空响应避免客户端超时
  logger.warn(`[Router] 未注册的 handler: tag=${tag}`);
  return { tag, msgUid, data: {} };
}

/**
 * 获取已注册的 tag 列表
 * @returns {number[]}
 */
function getRegisteredTags() {
  return Object.keys(handlers).map(Number);
}

/**
 * 检查 tag 是否已注册
 * @param {number} tag
 * @returns {boolean}
 */
function hasHandler(tag) {
  return tag in handlers;
}

module.exports = {
  register,
  registerAll,
  setFallback,
  route,
  getRegisteredTags,
  hasHandler,
};
