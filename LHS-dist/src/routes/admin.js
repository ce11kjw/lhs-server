const express = require('express');

const router = express.Router();
const adminService = require('../services/adminService');
const withdrawalService = require('../services/withdrawalService');
const { authenticate } = require('../middleware/auth');
const { requireAdmin, requirePermission } = require('../middleware/adminAuth');
const { logOperation } = require('../utils/logger');
const {
  validate,
  adminAgentCreateSchema,
  adminAgentProfileSchema,
  agentStatusSchema,
  accessRoleSchema,
  withdrawalApproveSchema,
  withdrawalRejectSchema,
} = require('../utils/validator');

function buildLogPayload(req, action, targetId, targetType, details, result = 'success', error) {
  return {
    operatorId: req.agent?._id,
    operatorUsername: req.agent?.username || 'unknown',
    action,
    targetId,
    targetType,
    details,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    result,
    error,
  };
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value).replace(/"/g, '""');
  return `"${stringValue}"`;
}

/**
 * GET /api/admin/stats - 全局统计数据
 */
router.get('/stats', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const stats = await adminService.getGlobalStats();
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/agents - 代理商列表（分页 + 搜索 + 筛选）
 */
router.get('/agents', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { page, limit, keyword, status, level, businessRole } = req.query;
    const result = await adminService.getAgentList({ page, limit, keyword, status, level, businessRole });
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/agents - 管理端创建代理
 */
router.post('/agents', authenticate, requireAdmin, validate(adminAgentCreateSchema), async (req, res, next) => {
  try {
    const agent = await adminService.createAgent(req.body);
    await logOperation(
      buildLogPayload(req, 'agent_create', agent._id, 'Agent', {
        username: agent.username,
        businessRole: agent.businessRole,
        level: agent.level,
      })
    );

    res.json({ success: true, message: '代理创建成功', data: agent });
  } catch (error) {
    await logOperation(
      buildLogPayload(req, 'agent_create', null, 'Agent', req.body, 'failure', error.message)
    );
    next(error);
  }
});

/**
 * PUT /api/admin/agent/:id/profile - 变更代理角色、权限和佣金
 */
router.put(
  '/agent/:id/profile',
  authenticate,
  requireAdmin,
  validate(adminAgentProfileSchema),
  async (req, res, next) => {
    try {
      const agent = await adminService.updateAgentProfile(req.params.id, req.body);
      await logOperation(
        buildLogPayload(req, 'agent_profile_update', agent._id, 'Agent', {
          businessRole: agent.businessRole,
          level: agent.level,
          commissionRate: agent.commissionRate,
          permissions: agent.permissions,
        })
      );

      res.json({ success: true, message: '代理配置已更新', data: agent });
    } catch (error) {
      await logOperation(
        buildLogPayload(req, 'agent_profile_update', req.params.id, 'Agent', req.body, 'failure', error.message)
      );
      next(error);
    }
  }
);

/**
 * PUT /api/admin/agent/:id/status - 变更代理商状态
 */
router.put(
  '/agent/:id/status',
  authenticate,
  requireAdmin,
  validate(agentStatusSchema),
  async (req, res, next) => {
    const { status, reason } = req.body;

    try {
      const agent = await adminService.updateAgentStatus(req.params.id, status);

      await logOperation(
        buildLogPayload(req, 'agent_status_change', agent._id, 'Agent', {
          status,
          reason: reason || '',
        })
      );

      res.json({
        success: true,
        message: '状态更新成功',
        data: agent,
      });
    } catch (error) {
      await logOperation(
        buildLogPayload(
          req,
          'agent_status_change',
          req.params.id,
          'Agent',
          {
            status,
            reason: reason || '',
          },
          'failure',
          error.message
        )
      );
      next(error);
    }
  }
);

router.get('/access-roles', authenticate, requirePermission('admin.roles'), async (req, res, next) => {
  try {
    const data = await adminService.getAccessRoles();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.put(
  '/agent/:id/access',
  authenticate,
  requirePermission('admin.roles'),
  validate(accessRoleSchema),
  async (req, res, next) => {
    try {
      const agent = await adminService.updateAgentAccess(req.agent, req.params.id, req.body);
      await logOperation(
        buildLogPayload(req, 'agent_access_update', agent._id, 'Agent', {
          username: agent.username,
          role: agent.role,
          accessPermissions: agent.accessPermissions || [],
        })
      );
      res.json({ success: true, message: '访问角色已更新', data: agent });
    } catch (error) {
      await logOperation(
        buildLogPayload(req, 'agent_access_update', req.params.id, 'Agent', req.body, 'failure', error.message)
      );
      next(error);
    }
  }
);

/**
 * GET /api/admin/withdrawals - 提现列表
 */
router.get('/withdrawals', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { page, limit, status, keyword } = req.query;
    const result = await adminService.getWithdrawalList({ page, limit, status, keyword });
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin/withdrawal/:id/approve - 审批提现
 */
router.put(
  '/withdrawal/:id/approve',
  authenticate,
  requireAdmin,
  validate(withdrawalApproveSchema),
  async (req, res, next) => {
    const { remark } = req.body;

    try {
      const withdrawal = await withdrawalService.approveWithdrawal(req.params.id, req.agent.username);

      await logOperation(
        buildLogPayload(req, 'withdrawal_approve', withdrawal._id, 'Withdrawal', {
          amount: withdrawal.amount,
          remark: remark || '',
        })
      );

      res.json({
        success: true,
        message: '提现已审批通过',
        data: withdrawal,
      });
    } catch (error) {
      await logOperation(
        buildLogPayload(
          req,
          'withdrawal_approve',
          req.params.id,
          'Withdrawal',
          {
            remark: remark || '',
          },
          'failure',
          error.message
        )
      );
      next(error);
    }
  }
);

/**
 * PUT /api/admin/withdrawal/:id/reject - 拒绝提现
 */
router.put(
  '/withdrawal/:id/reject',
  authenticate,
  requireAdmin,
  validate(withdrawalRejectSchema),
  async (req, res, next) => {
    const { reason } = req.body;

    try {
      const withdrawal = await withdrawalService.rejectWithdrawal(
        req.params.id,
        req.agent.username,
        reason
      );

      await logOperation(
        buildLogPayload(req, 'withdrawal_reject', withdrawal._id, 'Withdrawal', {
          amount: withdrawal.amount,
          reason,
        })
      );

      res.json({
        success: true,
        message: '提现已拒绝',
        data: withdrawal,
      });
    } catch (error) {
      await logOperation(
        buildLogPayload(
          req,
          'withdrawal_reject',
          req.params.id,
          'Withdrawal',
          {
            reason,
          },
          'failure',
          error.message
        )
      );
      next(error);
    }
  }
);

/**
 * GET /api/admin/commissions/export - 导出全局佣金流水
 */
router.get('/commissions/export', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { agentId, startDate, endDate } = req.query;
    const commissions = await adminService.exportGlobalCommissions({
      agentId,
      startDate,
      endDate,
    });

    const lines = [
      [
        '时间',
        '代理商',
        '邀请码',
        '来源代理',
        '玩家ID',
        '订单ID',
        '充值金额(元)',
        '佣金金额(元)',
        '佣金比例',
        '层级',
        '状态',
      ].join(','),
      ...commissions.map((item) =>
        [
          escapeCsvValue(new Date(item.createdAt).toLocaleString('zh-CN')),
          escapeCsvValue(item.agentId?.username || ''),
          escapeCsvValue(item.agentId?.inviteCode || ''),
          escapeCsvValue(item.sourceAgentId?.username || ''),
          escapeCsvValue(item.playerId),
          escapeCsvValue(item.orderId),
          escapeCsvValue((item.amount / 100).toFixed(2)),
          escapeCsvValue((item.commission / 100).toFixed(2)),
          escapeCsvValue(`${(item.rate * 100).toFixed(0)}%`),
          escapeCsvValue(item.level),
          escapeCsvValue(item.status),
        ].join(',')
      ),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=admin-commissions-${Date.now()}.csv`
    );
    res.send(`\uFEFF${lines.join('\n')}`);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/commissions - 全局佣金流水
 */
router.get('/commissions', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { page, limit, agentId, startDate, endDate } = req.query;
    const result = await adminService.getGlobalCommissions({
      page,
      limit,
      agentId,
      startDate,
      endDate,
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
 * GET /api/admin/logs - 操作日志
 */
router.get('/logs', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { page, limit, action, operatorUsername, result } = req.query;
    const data = await adminService.getOperationLogs({
      page,
      limit,
      action,
      operatorUsername,
      result,
    });

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
