const { Schema, model } = require('mongoose');

const adminActionLogSchema = new Schema(
  {
    operatorRole: { type: String, required: true, index: true },
    operatorUsername: { type: String, required: true, index: true },
    operatorAgentId: { type: String, default: '', index: true },
    action: { type: String, required: true, index: true },
    result: { type: String, required: true, index: true },
    targetUserId: { type: String, default: '', index: true },
    targetPlayerName: { type: String, default: '' },
    targetAgentId: { type: String, default: '', index: true },
    reason: { type: String, default: '' },
    detail: { type: Schema.Types.Mixed, default: () => ({}) },
    expireAt: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      index: { expires: 0 },
    },
  },
  { timestamps: true, minimize: false }
);

module.exports = model('AdminActionLog', adminActionLogSchema);
