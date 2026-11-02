const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const {
  AGENT_ROLE_KEYS,
  DEFAULT_COMMISSION_RATE,
  MAX_AGENT_LEVEL,
  getAgentRoleByKey,
  getAgentRoleByLevel,
  normalizePermissions,
} = require('../utils/agentRole');

/**
 * Agent（代理商）数据模型
 */
const agentSchema = new mongoose.Schema(
  {
    // 用户名（唯一）
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 20,
    },

    // 密码（bcrypt 加密）
    password: {
      type: String,
      required: true,
    },

    // 手机号（唯一）
    phone: {
      type: String,
      required: false,
      unique: true,
      sparse: true,
      trim: true,
      default: undefined,
    },

    // 邀请码（唯一，6位大写字母+数字）
    inviteCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      length: 6,
    },

    // 上级代理ID（null 表示顶层总推）
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Agent',
      default: null,
    },

    // 业务角色：总推 / 总代 / 一级 / 二级 / 三级代理
    businessRole: {
      type: String,
      enum: AGENT_ROLE_KEYS,
      default() {
        return getAgentRoleByLevel(this.level).key;
      },
    },

    // 代理等级（0=总推, 1=总代, 2=一级, 3=二级, 4=三级）
    level: {
      type: Number,
      required: true,
      min: 0,
      max: MAX_AGENT_LEVEL,
    },

    // 佣金比例配置
    commissionRate: {
      direct: { type: Number, default: DEFAULT_COMMISSION_RATE.direct },
      level1: { type: Number, default: DEFAULT_COMMISSION_RATE.level1 },
      level2: { type: Number, default: DEFAULT_COMMISSION_RATE.level2 },
      level3: { type: Number, default: DEFAULT_COMMISSION_RATE.level3 },
      level4: { type: Number, default: DEFAULT_COMMISSION_RATE.level4 },
      level5: { type: Number, default: DEFAULT_COMMISSION_RATE.level5 },
    },

    // 代理端权限开关，由业务角色给出默认值，管理端可覆盖
    permissions: {
      inviteAgent: { type: Boolean, default: true },
      viewTeam: { type: Boolean, default: true },
      viewCommission: { type: Boolean, default: true },
      withdraw: { type: Boolean, default: true },
      setSubCommission: { type: Boolean, default: false },
    },

    // 可提现余额（单位：分）
    balance: {
      type: Number,
      default: 0,
      min: 0,
    },

    // 累计收益（单位：分）
    totalEarned: {
      type: Number,
      default: 0,
      min: 0,
    },

    // 状态：active/suspended/banned
    status: {
      type: String,
      enum: ['pending', 'active', 'rejected', 'suspended', 'banned'],
      default: 'active',
    },

    reviewedBy: {
      type: String,
      default: '',
    },

    reviewedAt: {
      type: Date,
      default: null,
    },

    reviewReason: {
      type: String,
      default: '',
    },

    // 角色：root/admin/agent；root 是权限角色，不允许作为用户名。
    role: {
      type: String,
      enum: ['root', 'admin', 'agent'],
      default: 'agent',
    },

    // 角色之外的细粒度权限覆盖。
    accessPermissions: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true, // 自动添加 createdAt 和 updatedAt
  }
);

agentSchema.pre('validate', function (next) {
  if (!this.businessRole) {
    this.businessRole = getAgentRoleByLevel(this.level).key;
  }

  const role = getAgentRoleByKey(this.businessRole);
  if (role && this.isModified('businessRole')) {
    this.level = role.level;
  }

  this.permissions = normalizePermissions(this.permissions || {}, this.businessRole);
  next();
});

// 索引优化
agentSchema.index({ username: 1 });
agentSchema.index({ phone: 1 });
agentSchema.index({ inviteCode: 1 });
agentSchema.index({ parentId: 1 });

// 保存前自动加密密码
agentSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

// 验证密码方法
agentSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// 转换为 JSON 时移除敏感字段
agentSchema.methods.toJSON = function () {
    const obj = this.toObject();
    delete obj.password;
    obj.isRoot = obj.role === 'root';
    return obj;
  };

module.exports = mongoose.model('Agent', agentSchema);
