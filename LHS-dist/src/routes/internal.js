const express = require('express');
const router = express.Router();
const commissionService = require('../services/commissionService');
const Agent = require('../models/Agent');
const PlayerBinding = require('../models/PlayerBinding');
const { authenticateInternal } = require('../middleware/auth');
const { validate, rechargeCallbackSchema } = require('../utils/validator');
const Joi = require('joi');

/**
 * POST /internal/bind-invite - 绑定邀请码（玩家注册时调用）
 *
 * 请求头：
 *   X-API-Key: <内部接口密钥>
 *
 * 请求体：
 *   {
 *     "playerId": "玩家ID",
 *     "inviteCode": "邀请码"
 *   }
 *
 * 响应：
 *   {
 *     "success": true,
 *     "data": {
 *       "playerId": "玩家ID",
 *       "agentId": "代理商ID",
 *       "inviteCode": "邀请码"
 *     }
 *   }
 */
router.post(
  '/bind-invite',
  authenticateInternal,
  validate(
    Joi.object({
      playerId: Joi.string().required().messages({
        'any.required': '玩家ID不能为空',
      }),
      inviteCode: Joi.string().length(6).uppercase().required().messages({
        'string.length': '邀请码必须为6位',
        'any.required': '邀请码不能为空',
      }),
    })
  ),
  async (req, res, next) => {
    try {
      const { playerId, inviteCode } = req.body;

      // 检查玩家是否已绑定
      const existingBinding = await PlayerBinding.findOne({ playerId });
      if (existingBinding) {
        return res.status(400).json({
          success: false,
          message: '该玩家已绑定邀请码',
        });
      }

      // 查找代理商
      const agent = await Agent.findOne({ inviteCode });
      if (!agent) {
        return res.status(400).json({
          success: false,
          message: '邀请码不存在',
        });
      }

      if (agent.status !== 'active') {
        return res.status(400).json({
          success: false,
          message: '代理已被禁用',
        });
      }

      // 创建绑定记录
      const binding = new PlayerBinding({
        playerId,
        agentId: agent._id,
        inviteCode,
      });

      await binding.save();

      res.json({
        success: true,
        data: {
          playerId: binding.playerId,
          agentId: binding.agentId.toString(),
          inviteCode: binding.inviteCode,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /internal/recharge-callback - 充值回调（游戏服务端调用）
 *
 * 请求头：
 *   X-API-Key: <内部接口密钥>
 *
 * 请求体：
 *   {
 *     "playerId": "玩家ID",
 *     "orderId": "订单ID",
 *     "amount": 充值金额（单位：分）,
 *     "inviteCode": "邀请码"
 *   }
 *
 * 响应：
 *   {
 *     "success": true,
 *     "data": {
 *       "orderId": "订单ID",
 *       "amount": 充值金额,
 *       "commissions": [
 *         {
 *           "agentId": "代理ID",
 *           "username": "代理用户名",
 *           "level": 0,
 *           "rate": 0.10,
 *           "commission": 1000
 *         }
 *       ]
 *     }
 *   }
 */
router.post(
  '/recharge-callback',
  authenticateInternal,
  validate(rechargeCallbackSchema),
  async (req, res, next) => {
    try {
      const result = await commissionService.calculateCommission(req.body);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
