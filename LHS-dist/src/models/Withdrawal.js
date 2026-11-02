const mongoose = require('mongoose');

/**
 * Withdrawal（提现记录）数据模型
 */
const withdrawalSchema = new mongoose.Schema(
  {
    // 代理商ID
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Agent',
      required: true,
    },

    // 提现金额（单位：分）
    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    // 手续费（单位：分）
    fee: {
      type: Number,
      required: true,
      min: 0,
    },

    // 实际到账金额（单位：分）
    actualAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    // 银行信息
    bankInfo: {
      bankName: { type: String, required: true },
      accountName: { type: String, required: true },
      accountNumber: { type: String, required: true },
    },

    // 状态：pending/approved/rejected/completed
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'completed'],
      default: 'pending',
    },

    // 拒绝原因
    rejectReason: {
      type: String,
      default: '',
    },

    // 审批人ID（改为 String 支持用户名）
    approvedBy: {
      type: String,
      default: null,
    },

    // 审批时间
    approvedAt: {
      type: Date,
      default: null,
    },

    // 完成时间
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// 索引优化
withdrawalSchema.index({ agentId: 1, createdAt: -1 });
withdrawalSchema.index({ status: 1 });

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
