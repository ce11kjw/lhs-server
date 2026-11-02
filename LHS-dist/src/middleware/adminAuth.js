const { hasPermission } = require('../utils/permissionTree');

/**
 * 管理员权限检查中间件
 */
function requireAdmin(req, res, next) {
  if (!req.agent) {
    return res.status(401).json({
      success: false,
      message: '未登录',
    });
  }

  if (!hasPermission(req.agent, 'admin')) {
    return res.status(403).json({
      success: false,
      message: '需要管理员权限',
    });
  }

  next();
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.agent) {
      return res.status(401).json({ success: false, message: '未登录' });
    }

    if (!hasPermission(req.agent, permission)) {
      return res.status(403).json({ success: false, message: '权限不足' });
    }

    next();
  };
}

const { authenticate, authenticateInternal } = require('./auth');

module.exports = { authenticate, authenticateInternal, requireAdmin, requirePermission };
