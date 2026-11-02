/**
 * 全局错误处理中间件
 */
function errorHandler(err, req, res, _next) {
  console.error('错误:', err);

  // Mongoose 验证错误
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ success: false, message: errors.join('; ') });
  }

  // Mongoose 重复键错误
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    return res.status(400).json({ success: false, message: `${field} 已存在` });
  }

  // 默认错误
  res.status(err.status || 500).json({
    success: false,
    message: err.message || '服务器内部错误',
  });
}

/**
 * 404 处理中间件
 */
function notFound(req, res) {
  res.status(404).json({ success: false, message: '接口不存在' });
}

module.exports = { errorHandler, notFound };
