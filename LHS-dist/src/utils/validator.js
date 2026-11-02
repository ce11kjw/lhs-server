const Joi = require('joi');
const { AGENT_ROLE_KEYS } = require('./agentRole');
const { validateAllowedUsername } = require('./reservedUsername');

const commissionRateSchema = Joi.object({
  direct: Joi.number().min(0).max(1).optional(),
  level1: Joi.number().min(0).max(1).optional(),
  level2: Joi.number().min(0).max(1).optional(),
  level3: Joi.number().min(0).max(1).optional(),
  level4: Joi.number().min(0).max(1).optional(),
  level5: Joi.number().min(0).max(1).optional(),
});

const agentPermissionsSchema = Joi.object({
  inviteAgent: Joi.boolean().optional(),
  viewTeam: Joi.boolean().optional(),
  viewCommission: Joi.boolean().optional(),
  withdraw: Joi.boolean().optional(),
  setSubCommission: Joi.boolean().optional(),
});

/**
 * 代理商注册参数校验
 */
const registerSchema = Joi.object({
  username: Joi.string().trim().min(3).max(20).custom(validateAllowedUsername).required().messages({
    'string.min': '用户名至少3个字符',
    'string.max': '用户名最多20个字符',
    'any.required': '用户名不能为空',
  }),
  password: Joi.string().min(6).required().messages({
    'string.min': '密码至少6个字符',
    'any.required': '密码不能为空',
  }),
  phone: Joi.string()
    .pattern(/^1[3-9]\d{9}$/)
    .allow('', null)
    .optional()
    .messages({
      'string.pattern.base': '手机号格式不正确',
    }),
  parentInviteCode: Joi.string().length(6).uppercase().required().messages({
    'string.length': '邀请码必须为6位',
    'any.required': '邀请码不能为空',
  }),
});

/**
 * 代理商登录参数校验
 */
const loginSchema = Joi.object({
  username: Joi.string().required().messages({
    'any.required': '用户名不能为空',
  }),
  password: Joi.string().required().messages({
    'any.required': '密码不能为空',
  }),
});

/**
 * 提现申请参数校验
 */
const withdrawalSchema = Joi.object({
  amount: Joi.number().integer().min(100).required().messages({
    'number.min': '提现金额至少1元（100分）',
    'any.required': '提现金额不能为空',
  }),
  bankInfo: Joi.object({
    bankName: Joi.string().required().messages({
      'any.required': '银行名称不能为空',
    }),
    accountName: Joi.string().required().messages({
      'any.required': '账户名不能为空',
    }),
    accountNumber: Joi.string().required().messages({
      'any.required': '账号不能为空',
    }),
  }).required(),
});

/**
 * 充值回调参数校验
 */
const rechargeCallbackSchema = Joi.object({
  playerId: Joi.string().required().messages({
    'any.required': '玩家ID不能为空',
  }),
  orderId: Joi.string().required().messages({
    'any.required': '订单ID不能为空',
  }),
  amount: Joi.number().integer().min(1).required().messages({
    'number.min': '充值金额必须大于0',
    'any.required': '充值金额不能为空',
  }),
  inviteCode: Joi.string().length(6).uppercase().optional().messages({
    'string.length': '邀请码必须为6位',
  }),
});

/**
 * 绑定邀请码参数校验
 */
const bindInviteSchema = Joi.object({
  playerId: Joi.string().required().messages({
    'any.required': '玩家ID不能为空',
  }),
  inviteCode: Joi.string().length(6).uppercase().required().messages({
    'string.length': '邀请码必须为6位',
    'any.required': '邀请码不能为空',
  }),
});

/**
 * 代理商状态变更参数校验
 */
const agentStatusSchema = Joi.object({
  status: Joi.string().valid('pending', 'active', 'rejected', 'suspended', 'banned').required().messages({
    'any.only': '状态必须是 pending、active、rejected、suspended 或 banned',
    'any.required': '状态不能为空',
  }),
  reason: Joi.string().allow('', null).messages({
    'string.base': '原因必须是字符串',
  }),
});

const adminAgentCreateSchema = Joi.object({
  username: Joi.string().trim().min(3).max(20).custom(validateAllowedUsername).required(),
  password: Joi.string().min(6).required(),
  phone: Joi.string().pattern(/^1[3-9]\d{9}$/).required(),
  businessRole: Joi.string().valid(...AGENT_ROLE_KEYS).required(),
  parentInviteCode: Joi.string().length(6).uppercase().allow('', null),
  status: Joi.string().valid('pending', 'active', 'rejected', 'suspended', 'banned').default('active'),
  commissionRate: commissionRateSchema.optional(),
  permissions: agentPermissionsSchema.optional(),
});

const adminAgentProfileSchema = Joi.object({
  businessRole: Joi.string().valid(...AGENT_ROLE_KEYS).optional(),
  commissionRate: commissionRateSchema.optional(),
  permissions: agentPermissionsSchema.optional(),
}).min(1);

/**
 * 提现审批参数校验
 */
const withdrawalApproveSchema = Joi.object({
  remark: Joi.string().allow('', null).messages({
    'string.base': '备注必须是字符串',
  }),
});

/**
 * 提现拒绝参数校验
 */
const withdrawalRejectSchema = Joi.object({
  reason: Joi.string().required().messages({
    'any.required': '拒绝原因不能为空',
  }),
});

const agentReviewSchema = Joi.object({
  action: Joi.string().valid('approve', 'reject').required(),
  reason: Joi.string().allow('', null).when('action', {
    is: 'reject',
    then: Joi.string().trim().min(1).required(),
    otherwise: Joi.string().allow('', null),
  }),
});

const childRoleUpdateSchema = Joi.object({
  businessRole: Joi.string().valid(...AGENT_ROLE_KEYS).required(),
});

const childPasswordResetSchema = Joi.object({
  password: Joi.string().min(6).required().messages({
    'string.min': '密码至少6个字符',
    'any.required': '密码不能为空',
  }),
});

const accessRoleSchema = Joi.object({
  role: Joi.string().valid('root', 'admin', 'agent').required(),
  accessPermissions: Joi.array().items(Joi.string()).default([]),
});

/**
 * 校验中间件工厂函数
 */
function validate(schema) {
  return (req, res, next) => {
    const { error } = schema.validate(req.body, { abortEarly: false });
    if (error) {
      const errors = error.details.map((detail) => detail.message);
      return res.status(400).json({ success: false, message: errors.join('; ') });
    }
    next();
  };
}

module.exports = {
  registerSchema,
  loginSchema,
  withdrawalSchema,
  rechargeCallbackSchema,
  bindInviteSchema,
  adminAgentCreateSchema,
  adminAgentProfileSchema,
  agentStatusSchema,
  agentReviewSchema,
  childRoleUpdateSchema,
  childPasswordResetSchema,
  accessRoleSchema,
  withdrawalApproveSchema,
  withdrawalRejectSchema,
  validate,
};
