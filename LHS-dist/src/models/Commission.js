const mongoose = require('mongoose');

/**
 * Commission（佣金记录）数据模型
 */
const commissionSchema = new mongoose.Schema(
  {
    // 代理商ID
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Agent',
      required: true,
    },

    // 玩家ID（游戏服务端的玩家ID）
    playerId: {
      type: String,
      required: true,
    },

    // 订单ID（游戏服务端的充值订单ID）
    orderId: {
      type: String,
      required: true,
    },

    // 充值金额（单位：分）
    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    // 佣金金额（单位：分）
    commission: {
      type: Number,
      required: true,
      min: 0,
    },

    // 佣金比例（如 0.10）
    rate: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
    },

    // 佣金层级（0=直接, 1~4=向上四级）
    level: {
      type: Number,
      required: true,
      min: 0,
      max: 4,
    },

    // 直接推广代理ID（L2）
    sourceAgentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Agent',
      required: true,
    },

    // 状态：pending/settled/cancelled
    status: {
      type: String,
      enum: ['pending', 'settled', 'cancelled'],
      default: 'settled',
    },

    // 结算时间
    settledAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// 索引优化
commissionSchema.index({ agentId: 1, createdAt: -1 });
commissionSchema.index({ orderId: 1 });
commissionSchema.index({ playerId: 1 });
commissionSchema.index({ sourceAgentId: 1 });

module.exports = mongoose.model('Commission', commissionSchema);
