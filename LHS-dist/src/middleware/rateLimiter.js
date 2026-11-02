const rateLimit = require('express-rate-limit');
const config = require('../config');

/**
 * 登录失败次数限制（5次锁定30分钟）
 */
const loginLimiter = rateLimit({
  windowMs: 30 * 60 * 1000, // 30分钟
  max: 50000, // 最多5次
  message: {
    success: false,
    message: '登录失败次数过多，请30分钟后再试',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // 只在登录失败时计数
  skipSuccessfulRequests: true,
});

/**
 * API 请求频率限制（通用）
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: config.isProduction ? 10000 : 10000,
  message: {
    success: false,
    message: '请求过于频繁，请稍后再试',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !config.isProduction && req.method === 'GET',
});

/**
 * 敏感操作限制（提现、状态变更等）
 */
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1小时
  max: 100, // 最多10次
  message: {
    success: false,
    message: '操作过于频繁，请稍后再试',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  loginLimiter,
  apiLimiter,
  sensitiveLimiter,
};
