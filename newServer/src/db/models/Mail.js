/**
 * Mail 模型 - 邮件
 * 独立集合，量大且需要 TTL 过期
 */

const { Schema, model } = require('mongoose');

const mailSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    title: { type: String, default: '' },
    content: { type: String, default: '' },
    text: { type: String, default: '' },
    sender: { type: String, default: '系统' },
    attachments: { type: Schema.Types.Mixed, default: () => ([]) },
    targetType: { type: String, default: 'user', index: true },
    targetServerId: { type: Number, default: 0, index: true },
    batchId: { type: String, default: '', index: true },
    createdBy: { type: String, default: '' },
    eventKey: { type: String, default: '', index: true },
    minClaimLevel: { type: Number, default: 0 },
    read: { type: Boolean, default: false },
    claimed: { type: Boolean, default: false },
    // 30 天后自动过期删除
    expireAt: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      index: { expires: 0 },
    },
  },
  { timestamps: true }
);

// 按玩家查询 + 时间排序
mailSchema.index({ userId: 1, createdAt: -1 });
mailSchema.index({ userId: 1, eventKey: 1 });
mailSchema.index({ batchId: 1, createdAt: -1 });

module.exports = model('Mail', mailSchema);
