/**
 * Transaction 模型 - 充值/交易记录
 * 独立集合，审计用途，不设过期
 */

const { Schema, model } = require('mongoose');

const transactionSchema = new Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    playerId: { type: String, required: true },
    amount: { type: Number, required: true }, // 金额（分）
    diamond: { type: Number, default: 0 },    // 发放元宝数
    currency: { type: String, default: 'CNY' },
    productId: { type: String, default: '' },
    status: { type: String, default: 'success', index: true }, // pending, success, failed
    agentId: { type: String, default: null, index: true }, // 关联代理商
    channel: { type: String, default: '' }, // 支付渠道
    extra: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true }
);

// 按时间范围 + 代理商查询（分销统计）
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ agentId: 1, createdAt: -1 });

module.exports = model('Transaction', transactionSchema);
