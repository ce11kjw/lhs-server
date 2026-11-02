const jwt = require('jsonwebtoken');
const Agent = require('../models/Agent');
const config = require('../config');
const { generateUniqueInviteCode } = require('../utils/inviteCode');
const {
  MAX_AGENT_LEVEL,
  AGENT_ROLE_KEYS,
  getAgentRoleByKey,
  getAgentRoleByLevel,
  getNextAgentRole,
  normalizeCommissionRate,
  normalizePermissions,
} = require('../utils/agentRole');
const { assertAllowedUsername, normalizeUsername } = require('../utils/reservedUsername');

async function assertRoleFitsParent(agent, targetLevel) {
  if (!agent.parentId) return;
  const parent = await Agent.findById(agent.parentId).select('level');
  if (parent && targetLevel <= parent.level) {
    throw createError('代理角色必须低于上级角色', 400);
  }
}

async function assertRoleFitsChildren(agentId, targetLevel) {
  const child = await Agent.findOne({ parentId: agentId, level: { $lte: targetLevel } }).select('_id');
  if (child) {
    throw createError('代理角色不能高于或等于直属下级角色', 400);
  }
}

async function collectManagedAgentIds(agentId) {
  const ids = [String(agentId)];
  let currentIds = [agentId];
  while (currentIds.length) {
    const children = await Agent.find({ parentId: { $in: currentIds } }).select('_id').lean();
    if (!children.length) break;
    currentIds = children.map((item) => item._id);
    ids.push(...children.map((item) => String(item._id)));
  }
  return ids;
}

function createError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * 代理商注册
 */
async function register({ username, password, phone, parentInviteCode }) {
  const normalizedUsername = normalizeUsername(username);
  assertAllowedUsername(normalizedUsername);
  const inviteCode = String(parentInviteCode || '').trim().toUpperCase();
  if (!inviteCode) {
    throw createError('必须填写上级邀请码', 400);
  }

  const parent = await Agent.findOne({ inviteCode });
  if (!parent) {
    throw createError('邀请码不存在', 404);
  }
  if (parent.status !== 'active') {
    throw createError('上级代理当前不可用，无法邀请下级', 403);
  }
  if (parent.permissions && parent.permissions.inviteAgent === false) {
    throw createError('上级代理无发展下级权限', 403);
  }

  const businessRole = getNextAgentRole(parent.businessRole || parent.level)?.key;
  if (!businessRole) {
    throw createError('已达到最大代理层级', 400);
  }

  const normalizedPhone = String(phone || '').trim();

  // 生成唯一邀请码
  const newInviteCode = await generateUniqueInviteCode();

  // 创建代理商
  const agent = new Agent({
    username: normalizedUsername,
    password,
    phone: normalizedPhone || undefined,
    inviteCode: newInviteCode,
    parentId: parent._id,
    level: parent.level + 1,
    businessRole,
    status: 'pending',
    reviewReason: '等待上级审核',
    commissionRate: normalizeCommissionRate(config.defaultCommissionRate),
    permissions: normalizePermissions({}, businessRole),
  });

  await agent.save();
  return agent;
}

/**
 * 代理商登录
 */
async function login({ username, password }) {
  const normalizedUsername = normalizeUsername(username);
  assertAllowedUsername(normalizedUsername);

  // 查找代理商
  const agent = await Agent.findOne({ username: normalizedUsername });
  if (!agent) {
    throw createError('用户名或密码错误', 401);
  }

  // 验证密码
  const isMatch = await agent.comparePassword(password);
  if (!isMatch) {
    throw createError('用户名或密码错误', 401);
  }

  // 检查状态
  if (agent.status === 'pending') {
    throw createError('账号待上级审核', 403);
  }
  if (agent.status === 'rejected') {
    throw createError(agent.reviewReason || '账号申请已被上级拒绝', 403);
  }
  if (agent.status !== 'active') {
    throw createError('账号已被禁用', 403);
  }

  // 生成 JWT
  const token = jwt.sign({ id: agent._id }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });

  return { agent, token };
}

/**
 * 获取代理商信息
 */
async function getProfile(agentId) {
  const agent = await Agent.findById(agentId);
  if (!agent) {
    throw new Error('代理商不存在');
  }
  return agent;
}

/**
 * 获取下级代理列表
 */
async function getChildren(agentOrId, { page = 1, limit = 20 } = {}) {
  const skip = (page - 1) * limit;
  const isAdmin = agentOrId && typeof agentOrId === 'object' && ['root', 'admin'].includes(agentOrId.role);
  const agentId = isAdmin ? null : (agentOrId && agentOrId._id ? agentOrId._id : agentOrId);
  const query = isAdmin ? { role: 'agent' } : { parentId: agentId };
  const children = await Agent.find(query)
    .select('-password')
    .skip(skip)
    .limit(limit)
    .sort({ createdAt: -1 });

  const total = await Agent.countDocuments(query);

  return {
    list: children,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
}

async function getPendingChildren(agentId, { page = 1, limit = 20 } = {}) {
  const skip = (page - 1) * limit;
  const query = { parentId: agentId, status: 'pending' };
  const [children, total] = await Promise.all([
    Agent.find(query).select('-password').skip(skip).limit(limit).sort({ createdAt: -1 }),
    Agent.countDocuments(query),
  ]);

  return {
    list: children,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
}

async function reviewChildAgent(parentAgent, childAgentId, { action, reason = '' } = {}) {
  const child = await Agent.findOne({ _id: childAgentId, parentId: parentAgent._id, status: 'pending' });
  if (!child) {
    throw createError('待审核下级不存在或状态已变更', 404);
  }

  child.status = action === 'approve' ? 'active' : 'rejected';
  child.reviewedBy = parentAgent.username;
  child.reviewedAt = new Date();
  child.reviewReason = action === 'approve' ? (reason || '审核通过') : (reason || '审核拒绝');
  await child.save();
  return child;
}

async function updateManagedChildRole(operatorAgent, childAgentId, { businessRole } = {}) {
  if (Number(operatorAgent.level) > 1) {
    throw createError('只有总推或总代可以调整下级层级', 403);
  }
  if (!AGENT_ROLE_KEYS.includes(businessRole)) {
    throw createError('无效的代理角色', 400);
  }

  const managedIds = await collectManagedAgentIds(operatorAgent._id);
  if (!managedIds.includes(String(childAgentId)) || String(childAgentId) === String(operatorAgent._id)) {
    throw createError('无权调整该下级层级', 403);
  }

  const child = await Agent.findById(childAgentId);
  if (!child) {
    throw createError('下级代理不存在', 404);
  }

  const role = getAgentRoleByKey(businessRole);
  if (!role) {
    throw createError('无效的代理角色', 400);
  }
  if (role.level <= Number(operatorAgent.level)) {
    throw createError('下级层级必须低于当前操作者层级', 400);
  }

  await assertRoleFitsParent(child, role.level);
  await assertRoleFitsChildren(child._id, role.level);

  child.businessRole = role.key;
  child.level = role.level;
  child.permissions = normalizePermissions(child.permissions || {}, role.key);
  await child.save();
  return Agent.findById(child._id).select('-password').populate('parentId', 'username inviteCode businessRole level');
}

async function resetManagedChildPassword(operatorAgent, childAgentId, { password } = {}) {
  const nextPassword = String(password || '');
  if (nextPassword.length < 6) {
    throw createError('密码至少6个字符', 400);
  }

  const managedIds = await collectManagedAgentIds(operatorAgent._id);
  if (!managedIds.includes(String(childAgentId)) || String(childAgentId) === String(operatorAgent._id)) {
    throw createError('无权重置该代理密码', 403);
  }

  const child = await Agent.findById(childAgentId);
  if (!child) {
    throw createError('下级代理不存在', 404);
  }

  child.password = nextPassword;
  await child.save();
  return Agent.findById(child._id).select('-password').populate('parentId', 'username inviteCode businessRole level');
}

/**
 * 获取业绩统计
 */
async function getStats(agentId) {
  const agent = await Agent.findById(agentId);
  if (!agent) {
    throw new Error('代理商不存在');
  }

  // 统计下级数量
  const directChildren = await Agent.countDocuments({ parentId: agentId });

  // 统计所有非直属下级数量
  let indirectChildren = 0;
  let currentParentIds = [agent._id];
  for (let depth = 0; depth < MAX_AGENT_LEVEL; depth += 1) {
    const children = await Agent.find({ parentId: { $in: currentParentIds } }).select('_id');
    const childIds = children.map((child) => child._id);
    if (depth > 0) {
      indirectChildren += childIds.length;
    }
    if (childIds.length === 0) break;
    currentParentIds = childIds;
  }

  return {
    balance: agent.balance,
    totalEarned: agent.totalEarned,
    directChildren,
    indirectChildren,
  };
}

/**
 * 获取全局统计（管理员）
 */
async function getGlobalStats() {
  const totalAgents = await Agent.countDocuments();
  const activeAgents = await Agent.countDocuments({ status: 'active' });

  // 统计总余额和总收益
  const result = await Agent.aggregate([
    {
      $group: {
        _id: null,
        totalBalance: { $sum: '$balance' },
        totalEarned: { $sum: '$totalEarned' },
      },
    },
  ]);

  return {
    totalAgents,
    activeAgents,
    totalBalance: result[0]?.totalBalance || 0,
    totalEarned: result[0]?.totalEarned || 0,
  };
}

/**
 * 获取完整团队树（最多 5 个业务角色层级）
 */
async function getTeamTree(agentId) {
  const agent = await Agent.findById(agentId).select('-password');
  if (!agent) {
    throw new Error('代理商不存在');
  }

  // 递归获取下级
  async function getChildrenTree(parentId, currentLevel) {
    if (currentLevel >= MAX_AGENT_LEVEL) {
      return [];
    }

    const children = await Agent.find({ parentId })
      .select('-password')
      .sort({ createdAt: -1 });

    const result = [];
    for (const child of children) {
      const childData = child.toObject();
      childData.children = await getChildrenTree(child._id, currentLevel + 1);
      result.push(childData);
    }

    return result;
  }

  const tree = agent.toObject();
  tree.children = await getChildrenTree(agent._id, 0);

  return tree;
}

/**
 * 获取代理商实时数据统计
 */
async function getRealtimeStats(agentId) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const Commission = require('../models/Commission');

  // 今日佣金
  const todayCommission = await Commission.aggregate([
    {
      $match: {
        agentId,
        status: 'settled',
        createdAt: { $gte: todayStart },
      },
    },
    { $group: { _id: null, total: { $sum: '$commission' } } },
  ]);

  // 本月佣金
  const monthCommission = await Commission.aggregate([
    {
      $match: {
        agentId,
        status: 'settled',
        createdAt: { $gte: monthStart },
      },
    },
    { $group: { _id: null, total: { $sum: '$commission' } } },
  ]);

  // 累计佣金
  const totalCommission = await Commission.aggregate([
    {
      $match: {
        agentId,
        status: 'settled',
      },
    },
    { $group: { _id: null, total: { $sum: '$commission' } } },
  ]);

  // 下级代理数量
  const downlineCount = await Agent.countDocuments({ parentId: agentId });

  return {
    todayCommission: todayCommission[0]?.total || 0,
    monthCommission: monthCommission[0]?.total || 0,
    totalCommission: totalCommission[0]?.total || 0,
    downlineCount,
  };
}

module.exports = {
  register,
  login,
  getProfile,
  getChildren,
  getPendingChildren,
  getStats,
  getGlobalStats,
  getTeamTree,
  getRealtimeStats,
  reviewChildAgent,
  updateManagedChildRole,
  resetManagedChildPassword,
};
