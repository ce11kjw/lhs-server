const OperationLog = require('../models/OperationLog');

async function logOperation(payload = {}) {
  try {
    return await OperationLog.create({
      operatorId: payload.operatorId || null,
      operatorUsername: payload.operatorUsername || '',
      action: payload.action || 'unknown',
      targetId: payload.targetId || null,
      targetType: payload.targetType || '',
      details: payload.details || {},
      ip: payload.ip || '',
      userAgent: payload.userAgent || '',
      result: payload.result || 'success',
      error: payload.error || '',
    });
  } catch (error) {
    console.error(`[OperationLog] ${error.message}`);
    return null;
  }
}

module.exports = { logOperation };
