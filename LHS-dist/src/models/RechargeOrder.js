const mongoose = require('mongoose');

const rechargeOrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    playerId: { type: String, required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    inviteCode: { type: String, default: '', uppercase: true },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('RechargeOrder', rechargeOrderSchema);
