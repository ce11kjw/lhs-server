const express = require('express');
const router = express.Router();
const agentService = require('../services/agentService');
const portalService = require('../services/portalService');
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const { loginLimiter } = require('../middleware/rateLimiter');
const { logOperation } = require('../utils/logger');
const { validate, registerSchema, loginSchema, agentReviewSchema, childRoleUpdateSchema, childPasswordResetSchema } = require('../utils/validator');

/**
 * POST /api/agent/register - 代理商注册
 */
router.post('/register', validate(registerSchema), async (req, res, next) => {
  try {
    const agent = await agentService.register(req.body);

    // 记录注册日志
    await logOperation({
      operatorId: agent._id,
      operatorUsername: agent.username,
      action: 'register',
      details: { username: agent.username, level: agent.level },
      ip: req.ip,
      userAgent: req.get('user-agent'),
      result: 'success',
    });

    res.json({
      success: true,
      message: '注册申请已提交，等待上级审核',
      data: agent,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/agent/login - 代理商登录
 */
router.post('/login', loginLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    const { agent, token } = await agentService.login(req.body);

    // 记录登录日志
    await logOperation({
      operatorId: agent._id,
      operatorUsername: agent.username,
      action: 'login',
      details: { username: req.body.username },
      ip: req.ip,
      userAgent: req.get('user-agent'),
      result: 'success',
    });

    res.json({
      success: true,
      message: '登录成功',
      data: { agent, token },
    });
  } catch (error) {
    // 记录登录失败日志
    await logOperation({
      operatorId: null,
      operatorUsername: req.body.username || 'unknown',
      action: 'login',
      details: { username: req.body.username },
      ip: req.ip,
      userAgent: req.get('user-agent'),
      result: 'failure',
      error: error.message,
    });

    next(error);
  }
});

/**
 * GET /api/agent/profile - 获取个人信息
 */
router.get('/profile', authenticate, async (req, res, next) => {
  try {
    const agent = await agentService.getProfile(req.agent._id);
    res.json({
      success: true,
      data: agent,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/agent/children - 获取下级代理列表
 */
router.get('/children', authenticate, async (req, res, next) => {
  try {
    const { page, limit } = req.query;
    const result = await agentService.getChildren(req.agent, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
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
 * GET /api/agent/pending-children - 获取待审核直属下级
 */
router.get('/pending-children', authenticate, async (req, res, next) => {
  try {
    const { page, limit } = req.query;
    const result = await agentService.getPendingChildren(req.agent._id, {
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/agent/child-agent/:id/review - 审核直属下级
 */
router.put('/child-agent/:id/review', authenticate, validate(agentReviewSchema), async (req, res, next) => {
  try {
    const child = await agentService.reviewChildAgent(req.agent, req.params.id, req.body);
    await logOperation({
      operatorId: req.agent._id,
      operatorUsername: req.agent.username,
      action: 'agent_review',
      targetId: child._id,
      targetType: 'Agent',
      details: {
        action: req.body.action,
        reason: req.body.reason || '',
        childUsername: child.username,
        childRole: child.businessRole,
      },
      ip: req.ip,
      userAgent: req.get('user-agent'),
      result: 'success',
    });
    res.json({
      success: true,
      message: req.body.action === 'approve' ? '下级审核通过' : '已拒绝下级申请',
      data: child,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/agent/stats - 获取业绩统计
 */
router.get('/stats', authenticate, async (req, res, next) => {
  try {
    const stats = await agentService.getStats(req.agent._id);
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/agent/global-stats - 获取全局统计（管理员）
 */
router.get('/global-stats', authenticate, requireAdmin, async (req, res, next) => {
  try {
    // TODO: 添加管理员权限检查
    const stats = await agentService.getGlobalStats();
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/agent/team-tree - 获取完整团队树（3级）
 */
router.get('/team-tree', authenticate, async (req, res, next) => {
  try {
    const tree = await agentService.getTeamTree(req.agent._id);
    res.json({
      success: true,
      data: tree,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/agent/realtime-stats - 获取实时数据统计
 */
router.get('/realtime-stats', authenticate, async (req, res, next) => {
  try {
    const stats = await agentService.getRealtimeStats(req.agent._id);
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/agent/players - 获取直属玩家列表
 */
router.get('/players', authenticate, async (req, res, next) => {
  try {
    const { page, limit, keyword } = req.query;
    const data = await portalService.getBoundPlayers(req.agent._id, {
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
      keyword,
      includeAllAgents: ['root', 'admin'].includes(req.agent.role),
    });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/agent/mall-orders - 获取商城订单
 */
router.get('/mall-orders', authenticate, async (req, res, next) => {
  try {
    const { page, limit, keyword, startDate, endDate } = req.query;
    const data = await portalService.getMallOrders(req.agent, {
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
      keyword,
      startDate,
      endDate,
    });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/agent/transactions - 获取资金流水
 */
router.get('/transactions', authenticate, async (req, res, next) => {
  try {
    const { page, limit, type, startDate, endDate } = req.query;
    const data = await portalService.getTransactionFlows(req.agent._id, {
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
      type,
      startDate,
      endDate,
    });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/agent/weekly-settlements - 获取周结统计
 */
router.get('/weekly-settlements', authenticate, async (req, res, next) => {
  try {
    const { limit } = req.query;
    const data = await portalService.getWeeklySettlements(req.agent._id, {
      limit: parseInt(limit, 10) || 8,
    });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/agent/portal-overview - 获取代理端模块附加统计
 */
router.get('/portal-overview', authenticate, async (req, res, next) => {
  try {
    const data = await portalService.getPortalOverview(req.agent._id);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/agent/children/:id/detail - 获取下级详情
 */
router.get('/children/:id/detail', authenticate, async (req, res, next) => {
  try {
    const data = await portalService.getAgentDetail(req.agent._id, req.params.id, req.query || {});
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.put('/children/:id/role', authenticate, validate(childRoleUpdateSchema), async (req, res, next) => {
  try {
    const data = await agentService.updateManagedChildRole(req.agent, req.params.id, req.body);
    res.json({ success: true, message: '下级层级已更新', data });
  } catch (error) {
    next(error);
  }
});

router.put('/children/:id/password', authenticate, validate(childPasswordResetSchema), async (req, res, next) => {
  try {
    const data = await agentService.resetManagedChildPassword(req.agent, req.params.id, req.body);
    await logOperation({
      operatorId: req.agent._id,
      operatorUsername: req.agent.username,
      action: 'agent_password_reset',
      targetId: data && data._id,
      targetType: 'Agent',
      details: { childUsername: data && data.username },
      ip: req.ip,
      userAgent: req.get('user-agent'),
      result: 'success',
    });
    res.json({ success: true, message: '下级代理密码已重置', data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
