const { Schema, model } = require('mongoose');

const adminAgentSchema = new Schema(
  {
    agentId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    name: { type: String, default: '' },
    status: { type: String, enum: ['active', 'disabled'], default: 'active', index: true },
    permissions: {
      type: Schema.Types.Mixed,
      default: () => ({ giveItems: false, recharge: false }),
    },
    limits: {
      type: Schema.Types.Mixed,
      default: () => ({
        giveCurrencyWhitelist: [],
        giveItemWhitelist: [],
        rechargeSingleLimit: 0,
        rechargeDailyLimit: 0,
      }),
    },
    note: { type: String, default: '' },
    createdBy: { type: String, default: '' },
    updatedBy: { type: String, default: '' },
    lastLoginAt: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

module.exports = model('AdminAgent', adminAgentSchema);
