const express = require('express');
const router = express.Router();
const withdrawalService = require('../services/withdrawalService');
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const { sensitiveLimiter } = require('../middleware/rateLimiter');
const { logOperation } = require('../utils/logger');
const { validate, withdrawalSchema } = require('../utils/validator');

/**
 * POST /api/withdrawal/apply - 申请提现
 */
router.post('/apply', authenticate, sensitiveLimiter, validate(withdrawalSchema), async (req, res, next) => {
  try {
    const withdrawal = await withdrawalService.applyWithdrawal(req.agent._id, req.body);

    // 记录操作日志
    await logOperation({
      operatorId: req.agent._id,
      operatorUsername: req.agent.username,
      action: 'withdrawal_apply',
      targetId: withdrawal._id,
      targetType: 'Withdrawal',
      details: { amount: req.body.amount },
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({
      success: true,
      message: '提现申请已提交',
      data: withdrawal,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/withdrawal/list - 获取提现记录列表
 */
router.get('/list', authenticate, async (req, res, next) => {
  try {
    const { page, limit, status } = req.query;
    const result = await withdrawalService.getWithdrawalList(req.agent._id, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      status,
    });
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/withdrawal/:id/approve - 审批提现（管理员）
 */
router.put('/:id/approve', authenticate, requireAdmin, sensitiveLimiter, async (req, res, next) => {
  try {
    const withdrawal = await withdrawalService.approveWithdrawal(req.params.id, req.agent.username);

    // 记录操作日志
    await logOperation({
      operatorId: req.agent._id,
      operatorUsername: req.agent.username,
      action: 'withdrawal_approve',
      targetId: withdrawal._id,
      targetType: 'Withdrawal',
      details: { amount: withdrawal.amount },
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({
      success: true,
      message: '提现已审批通过',
      data: withdrawal,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/withdrawal/:id/reject - 拒绝提现（管理员）
 */
router.put('/:id/reject', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { reason } = req.body;
    const withdrawal = await withdrawalService.rejectWithdrawal(
      req.params.id,
      req.agent.username,
      reason
    );
    res.json({
      success: true,
      message: '提现已拒绝',
      data: withdrawal,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
