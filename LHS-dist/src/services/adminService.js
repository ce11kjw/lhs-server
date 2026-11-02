const Agent = require('../models/Agent');
const Commission = require('../models/Commission');
const OperationLog = require('../models/OperationLog');
const Withdrawal = require('../models/Withdrawal');
const config = require('../config');
const { generateUniqueInviteCode } = require('../utils/inviteCode');
const {
  AGENT_ROLE_KEYS,
  getAgentRoleByKey,
  getAgentRoleByLevel,
  normalizeCommissionRate,
  normalizePermissions,
} = require('../utils/agentRole');
const { assertAllowedUsername, normalizeUsername } = require('../utils/reservedUsername');
const {
  ALL_PERMISSION_KEYS,
  BUILTIN_ROLES,
  PERMISSION_TREE,
  hasPermission,
  uniquePermissions,
} = require('../utils/permissionTree');

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeBoundaryDate(value, boundary) {
  if (!value) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const suffix = boundary === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z';
    return new Date(`${value}${suffix}`);
  }

  return new Date(value);
}

function buildDateRange(startDate, endDate) {
  if (!startDate && !endDate) {
    return null;
  }

  const range = {};
  if (startDate) {
    range.$gte = normalizeBoundaryDate(startDate, 'start');
  }
  if (endDate) {
    range.$lte = normalizeBoundaryDate(endDate, 'end');
  }

  return range;
}

async function resolveAgentIdsByKeyword(keyword) {
  if (!keyword) {
    return null;
  }

  const agents = await Agent.find({
    $or: [
      { username: { $regex: keyword, $options: 'i' } },
      { phone: { $regex: keyword, $options: 'i' } },
      { inviteCode: { $regex: keyword, $options: 'i' } },
    ],
  }).select('_id');

  return agents.map((agent) => agent._id);
}

/**
 * 获取全局统计数据
 */
async function getGlobalStats() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const totalAgents = await Agent.countDocuments();
  const todayNewAgents = await Agent.countDocuments({
    createdAt: { $gte: todayStart },
  });

  const totalCommission = await Commission.aggregate([
    { $match: { status: 'settled' } },
    { $group: { _id: null, total: { $sum: '$commission' } } },
  ]);

  const totalRecharge = await Commission.aggregate([
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  const pendingWithdrawals = await Withdrawal.countDocuments({ status: 'pending' });
  const pendingAmount = await Withdrawal.aggregate([
    { $match: { status: 'pending' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  return {
    totalAgents,
    todayNewAgents,
    totalCommission: totalCommission[0]?.total || 0,
    totalRecharge: totalRecharge[0]?.total || 0,
    pendingWithdrawals,
    pendingWithdrawalAmount: pendingAmount[0]?.total || 0,
  };
}

/**
 * 获取代理商列表（分页 + 搜索 + 筛选）
 */
async function getAgentList({ page = 1, limit = 20, keyword, status, level, businessRole } = {}) {
  const parsedPage = parsePositiveInt(page, 1);
  const parsedLimit = parsePositiveInt(limit, 20);
  const query = {};

  if (keyword) {
    query.$or = [
      { username: { $regex: keyword, $options: 'i' } },
      { phone: { $regex: keyword, $options: 'i' } },
      { inviteCode: { $regex: keyword, $options: 'i' } },
    ];
  }

  if (status && status !== 'all') {
    query.status = status;
  }

  if (level !== undefined && level !== null && level !== '' && level !== 'all') {
    query.level = parseInt(level, 10);
  }

  if (businessRole && businessRole !== 'all') {
    query.businessRole = businessRole;
  }

  const total = await Agent.countDocuments(query);
  const agents = await Agent.find(query)
    .select('-password')
    .sort({ createdAt: -1 })
    .skip((parsedPage - 1) * parsedLimit)
    .limit(parsedLimit)
    .populate('parentId', 'username inviteCode');

  return {
    total,
    page: parsedPage,
    limit: parsedLimit,
    pages: Math.ceil(total / parsedLimit),
    data: agents,
  };
}

async function assertRoleFitsParent(agent, targetLevel) {
  if (!agent.parentId) return;
  const parent = await Agent.findById(agent.parentId).select('level username');
  if (parent && targetLevel <= parent.level) {
    throw new Error('代理角色必须低于上级角色');
  }
}

async function assertRoleFitsChildren(agentId, targetLevel) {
  const child = await Agent.findOne({ parentId: agentId, level: { $lte: targetLevel } }).select('username');
  if (child) {
    throw new Error('代理角色不能高于或等于直属下级角色');
  }
}

async function createAgent({
  username,
  password,
  phone,
  businessRole = 'chief_promoter',
  parentInviteCode,
  commissionRate,
  permissions,
  status = 'active',
} = {}) {
  const normalizedUsername = normalizeUsername(username);
  assertAllowedUsername(normalizedUsername);

  const role = getAgentRoleByKey(businessRole);
  if (!role) {
    throw new Error('无效的代理角色');
  }

  let parent = null;
  if (parentInviteCode) {
    parent = await Agent.findOne({ inviteCode: parentInviteCode });
    if (!parent) throw new Error('上级邀请码不存在');
    if (parent.status !== 'active') throw new Error('上级代理已被禁用');
    if (role.level !== parent.level + 1) {
      throw new Error('代理角色必须是上级角色的下一层级');
    }
  } else if (role.level !== 0) {
    throw new Error('非总推角色必须填写上级邀请码');
  }

  const inviteCode = await generateUniqueInviteCode();
  const agent = new Agent({
    username: normalizedUsername,
    password,
    phone,
    inviteCode,
    parentId: parent ? parent._id : null,
    businessRole: role.key,
    level: role.level,
    role: 'agent',
    status,
    commissionRate: normalizeCommissionRate(commissionRate, config.defaultCommissionRate),
    permissions: normalizePermissions(permissions || {}, role.key),
  });

  await agent.save();
  return Agent.findById(agent._id).select('-password').populate('parentId', 'username inviteCode');
}

async function updateAgentProfile(agentId, { businessRole, commissionRate, permissions } = {}) {
  const agent = await Agent.findById(agentId);
  if (!agent) {
    throw new Error('代理商不存在');
  }

  let nextRoleKey = agent.businessRole || getAgentRoleByLevel(agent.level).key;
  if (businessRole !== undefined) {
    if (!AGENT_ROLE_KEYS.includes(businessRole)) {
      throw new Error('无效的代理角色');
    }
    nextRoleKey = businessRole;
    const role = getAgentRoleByKey(nextRoleKey);
    await assertRoleFitsParent(agent, role.level);
    await assertRoleFitsChildren(agent._id, role.level);
    agent.businessRole = role.key;
    agent.level = role.level;
  }

  if (commissionRate) {
    agent.commissionRate = normalizeCommissionRate(commissionRate, agent.commissionRate || config.defaultCommissionRate);
  }

  if (permissions) {
    agent.permissions = normalizePermissions(permissions, nextRoleKey);
  } else if (businessRole !== undefined) {
    agent.permissions = normalizePermissions(agent.permissions || {}, nextRoleKey);
  }

  await agent.save();
  return Agent.findById(agent._id).select('-password').populate('parentId', 'username inviteCode');
}

/**
 * 变更代理商状态
 */
async function updateAgentStatus(agentId, status) {
  const agent = await Agent.findById(agentId);
  if (!agent) {
    throw new Error('代理商不存在');
  }

  if (!['active', 'suspended', 'banned'].includes(status)) {
    throw new Error('无效的状态');
  }

  agent.status = status;
  await agent.save();

  return agent;
}

async function getAccessRoles() {
  const agents = await Agent.find({})
    .select('_id username role accessPermissions status createdAt')
    .sort({ role: -1, createdAt: 1 });

  return {
    roles: Object.values(BUILTIN_ROLES),
    permissionTree: PERMISSION_TREE,
    permissionKeys: ALL_PERMISSION_KEYS,
    accounts: agents,
  };
}

async function updateAgentAccess(operator, agentId, { role, accessPermissions = [] } = {}) {
  if (!['root', 'admin', 'agent'].includes(role)) {
    throw createError('无效的访问角色');
  }

  const target = await Agent.findById(agentId);
  if (!target) {
    throw createError('账号不存在', 404);
  }

  const operatorIsRoot = hasPermission(operator, 'root');
  const targetIsRoot = target.role === 'root';
  if (!operatorIsRoot && (role === 'root' || targetIsRoot)) {
    throw createError('只有 root 权限可以授予或变更 root 角色', 403);
  }

  const nextPermissions = uniquePermissions(accessPermissions).filter((key) => ALL_PERMISSION_KEYS.includes(key));
  if (!operatorIsRoot && nextPermissions.includes('root')) {
    throw createError('只有 root 权限可以授予 root 权限', 403);
  }

  target.role = role;
  target.accessPermissions = role === 'root' ? ['root'] : nextPermissions.filter((key) => key !== 'root');
  await target.save();

  return Agent.findById(target._id).select('-password').populate('parentId', 'username inviteCode');
}

/**
 * 获取提现列表
 */
async function getWithdrawalList({ page = 1, limit = 20, status, keyword } = {}) {
  const parsedPage = parsePositiveInt(page, 1);
  const parsedLimit = parsePositiveInt(limit, 20);
  const query = {};

  if (status && status !== 'all') {
    query.status = status;
  }

  if (keyword) {
    const agentIds = await resolveAgentIdsByKeyword(keyword);
    query.agentId = { $in: agentIds.length > 0 ? agentIds : [] };
  }

  const total = await Withdrawal.countDocuments(query);
  const withdrawals = await Withdrawal.find(query)
    .sort({ createdAt: -1 })
    .skip((parsedPage - 1) * parsedLimit)
    .limit(parsedLimit)
    .populate('agentId', 'username phone inviteCode');

  return {
    total,
    page: parsedPage,
    limit: parsedLimit,
    pages: Math.ceil(total / parsedLimit),
    data: withdrawals,
  };
}

/**
 * 获取全局佣金流水
 */
async function getGlobalCommissions({
  page = 1,
  limit = 20,
  agentId,
  startDate,
  endDate,
} = {}) {
  const parsedPage = parsePositiveInt(page, 1);
  const parsedLimit = parsePositiveInt(limit, 20);
  const query = { status: 'settled' };

  if (agentId) {
    query.agentId = agentId;
  }

  const createdAt = buildDateRange(startDate, endDate);
  if (createdAt) {
    query.createdAt = createdAt;
  }

  const total = await Commission.countDocuments(query);
  const commissions = await Commission.find(query)
    .sort({ createdAt: -1 })
    .skip((parsedPage - 1) * parsedLimit)
    .limit(parsedLimit)
    .populate('agentId', 'username inviteCode')
    .populate('sourceAgentId', 'username inviteCode');

  return {
    total,
    page: parsedPage,
    limit: parsedLimit,
    pages: Math.ceil(total / parsedLimit),
    data: commissions,
  };
}

/**
 * 导出全局佣金流水
 */
async function exportGlobalCommissions({ agentId, startDate, endDate } = {}) {
  const query = { status: 'settled' };

  if (agentId) {
    query.agentId = agentId;
  }

  const createdAt = buildDateRange(startDate, endDate);
  if (createdAt) {
    query.createdAt = createdAt;
  }

  return Commission.find(query)
    .sort({ createdAt: -1 })
    .populate('agentId', 'username inviteCode')
    .populate('sourceAgentId', 'username inviteCode');
}

/**
 * 获取操作日志
 */
async function getOperationLogs({
  page = 1,
  limit = 20,
  action,
  operatorUsername,
  result,
} = {}) {
  const parsedPage = parsePositiveInt(page, 1);
  const parsedLimit = parsePositiveInt(limit, 20);
  const query = {};

  if (action && action !== 'all') {
    query.action = action;
  }

  if (result && result !== 'all') {
    query.result = result;
  }

  if (operatorUsername) {
    query.operatorUsername = { $regex: operatorUsername, $options: 'i' };
  }

  const total = await OperationLog.countDocuments(query);
  const logs = await OperationLog.find(query)
    .sort({ createdAt: -1 })
    .skip((parsedPage - 1) * parsedLimit)
    .limit(parsedLimit)
    .populate('operatorId', 'username role');

  return {
    total,
    page: parsedPage,
    limit: parsedLimit,
    pages: Math.ceil(total / parsedLimit),
    data: logs,
  };
}

module.exports = {
  createAgent,
  exportGlobalCommissions,
  getAgentList,
  getGlobalCommissions,
  getGlobalStats,
  getAccessRoles,
  getOperationLogs,
  getWithdrawalList,
  updateAgentProfile,
  updateAgentAccess,
  updateAgentStatus,
};
