const mongoose = require('mongoose');

const operationLogSchema = new mongoose.Schema(
  {
    operatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent', default: null },
    operatorUsername: { type: String, default: '' },
    action: { type: String, required: true, index: true },
    targetId: { type: mongoose.Schema.Types.Mixed, default: null },
    targetType: { type: String, default: '' },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    result: { type: String, enum: ['success', 'failure'], default: 'success', index: true },
    error: { type: String, default: '' },
  },
  { timestamps: true, strict: false }
);

operationLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('OperationLog', operationLogSchema);
