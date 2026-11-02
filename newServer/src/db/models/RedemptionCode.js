const { Schema, model } = require('mongoose');

const redemptionCodeUseSchema = new Schema(
  {
    userId: { type: String, required: true },
    playerName: { type: String, default: '' },
    usedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const redemptionCodeSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: '' },
    status: { type: String, enum: ['active', 'disabled'], default: 'active', index: true },
    rewards: {
      diamond: { type: Number, default: 0 },
      gold: { type: Number, default: 0 },
      silver: { type: Number, default: 0 },
      items: { type: Map, of: Number, default: {} },
    },
    maxUses: { type: Number, default: 0 },
    perUserLimit: { type: Number, default: 1 },
    usedCount: { type: Number, default: 0, index: true },
    usedBy: { type: [redemptionCodeUseSchema], default: [] },
    startsAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    note: { type: String, default: '' },
    createdBy: { type: String, default: '' },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = model('RedemptionCode', redemptionCodeSchema);
