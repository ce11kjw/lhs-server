const { Schema, model } = require('mongoose');

const roleSchema = new Schema(
  {
    roleId: { type: String, required: true },
    userId: { type: String, required: true },
    serverId: { type: Number, required: true, default: 1001 },
    serverName: { type: String, default: '' },
    name: { type: String, required: true },
    createTime: { type: Number, required: true },
    lastLoginTime: { type: Number, default: 0 },
    status: { type: Number, default: 1 },
  },
  { _id: false }
);

const accountSchema = new Schema(
  {
    accountId: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    inviteCode: { type: String, default: null, index: true },
    agentId: { type: String, default: null, index: true },
    roles: { type: [roleSchema], default: [] },
    activeRoleByServer: { type: Schema.Types.Mixed, default: () => ({}) },
    lastSelectedServerId: { type: Number, default: 0 },
    lastLoginTime: { type: Number, default: 0 },
    status: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

module.exports = model('Account', accountSchema);
