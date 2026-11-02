const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent', required: true, index: true },
    type: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true, min: 0 },
    relatedId: { type: mongoose.Schema.Types.Mixed, default: null },
    relatedType: { type: String, default: '' },
    description: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

transactionSchema.index({ agentId: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
