const jwt = require('jsonwebtoken');
const config = require('../config');
const Agent = require('../models/Agent');

/**
 * JWT 认证中间件
 */
async function authenticate(req, res, next) {
  try {
    // 从 Authorization header 获取 token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: '未提供认证令牌' });
    }

    const token = authHeader.substring(7);

    // 验证 token
    const decoded = jwt.verify(token, config.jwt.secret);

    // 查询代理商信息
    const agent = await Agent.findById(decoded.id);
    if (!agent) {
      return res.status(401).json({ success: false, message: '代理商不存在' });
    }

    if (agent.status !== 'active') {
      return res.status(403).json({ success: false, message: '账号已被禁用' });
    }

    // 将代理商信息挂载到 req 对象
    req.agent = agent;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, message: '无效的认证令牌' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: '认证令牌已过期' });
    }
    return res.status(500).json({ success: false, message: '认证失败' });
  }
}

/**
 * 内部接口认证中间件（验证 API Key）
 */
function authenticateInternal(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== config.internalApiKey) {
    return res.status(401).json({ success: false, message: '无效的 API Key' });
  }
  next();
}

module.exports = { authenticate, authenticateInternal };
