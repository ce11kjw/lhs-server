const { Schema, model } = require('mongoose');

const rechargeProductConfigSchema = new Schema(
  {
    productId: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: '' },
    amount: { type: Number, default: 0 },
    diamond: { type: Number, default: 0 },
    firstBonus: { type: Number, default: 0 },
    payType: { type: String, default: '' },
    attachments: { type: Schema.Types.Mixed, default: () => ([]) },
    mailTitle: { type: String, default: '' },
    mailContent: { type: String, default: '' },
    enabled: { type: Boolean, default: true, index: true },
    sort: { type: Number, default: 0, index: true },
    note: { type: String, default: '' },
    createdBy: { type: String, default: '' },
    updatedBy: { type: String, default: '' },
  },
  {
    timestamps: true,
  }
);

module.exports = model('RechargeProductConfig', rechargeProductConfigSchema);
