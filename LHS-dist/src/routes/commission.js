const express = require('express');
const router = express.Router();
const commissionService = require('../services/commissionService');
const { authenticate } = require('../middleware/auth');

/**
 * GET /api/commission/list - 获取佣金记录列表
 */
router.get('/list', authenticate, async (req, res, next) => {
  try {
    const { page, limit, startDate, endDate } = req.query;
    const result = await commissionService.getCommissionList(req.agent._id, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
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
 * GET /api/commission/summary - 获取佣金汇总
 */
router.get('/summary', authenticate, async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const summary = await commissionService.getCommissionSummary(req.agent._id, {
      startDate,
      endDate,
    });
    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/commission/export - 导出佣金明细（CSV）
 */
router.get('/export', authenticate, async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const commissions = await commissionService.exportCommissions(req.agent._id, {
      startDate,
      endDate,
    });

    // 生成 CSV
    const csv = [
      '时间,订单号,玩家ID,充值金额,佣金金额,佣金比例,层级,状态',
      ...commissions.map((c) =>
        [
          new Date(c.createdAt).toLocaleString('zh-CN'),
          c.orderId,
          c.playerId,
          c.amount / 100,
          c.commission / 100,
          (c.rate * 100).toFixed(0) + '%',
          c.level === 0 ? '直接' : `${c.level}级`,
          c.status === 'settled' ? '已结算' : '待结算',
        ].join(',')
      ),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=commissions.csv');
    res.send('\uFEFF' + csv); // BOM for Excel
  } catch (error) {
    next(error);
  }
});

module.exports = router;
