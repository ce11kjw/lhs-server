const Agent = require('../models/Agent');
const Commission = require('../models/Commission');
const PlayerBinding = require('../models/PlayerBinding');
const RechargeOrder = require('../models/RechargeOrder');
const Transaction = require('../models/Transaction');
const Withdrawal = require('../models/Withdrawal');

function pageArgs({ page = 1, limit = 20 } = {}) {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
  return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
}

function dateRange(startDate, endDate) {
  if (!startDate && !endDate) return null;
  const range = {};
  if (startDate) range.$gte = new Date(startDate);
  if (endDate) range.$lte = new Date(endDate);
  return range;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getBoundPlayers(agentId, { page, limit, keyword, includeAllAgents = false } = {}) {
  const paging = pageArgs({ page, limit });
  const query = includeAllAgents ? {} : { agentId };
  if (keyword) query.playerId = { $regex: String(keyword), $options: 'i' };

  const [data, total] = await Promise.all([
    PlayerBinding.find(query)
      .populate('agentId', 'username inviteCode businessRole')
      .sort({ createdAt: -1 })
      .skip(paging.skip)
      .limit(paging.limit),
    PlayerBinding.countDocuments(query),
  ]);
  return { data, list: data, total, page: paging.page, limit: paging.limit, pages: Math.ceil(total / paging.limit) };
}

async function getMallOrders(agent, { page, limit, keyword, startDate, endDate } = {}) {
  const paging = pageArgs({ page, limit });
  const query = {};
  const isAdmin = agent && ['root', 'admin'].includes(agent.role);

  if (!isAdmin) {
    const agentId = agent && agent._id;
    const inviteCode = String(agent && agent.inviteCode || '').trim().toUpperCase();
    const bindings = agentId
      ? await PlayerBinding.find({ agentId }).select('playerId').lean()
      : [];
    const playerIds = bindings.map((binding) => binding.playerId).filter(Boolean);
    const ownership = [];
    if (playerIds.length > 0) ownership.push({ playerId: { $in: playerIds } });
    if (inviteCode) ownership.push({ inviteCode });
    query.$or = ownership.length > 0 ? ownership : [{ _id: { $exists: false } }];
  }

  if (keyword) {
    const pattern = { $regex: escapeRegex(keyword), $options: 'i' };
    query.$and = query.$and || [];
    query.$and.push({ $or: [{ orderId: pattern }, { playerId: pattern }, { inviteCode: pattern }] });
  }

  const createdAt = dateRange(startDate, endDate);
  if (createdAt) query.createdAt = createdAt;

  const [data, total] = await Promise.all([
    RechargeOrder.find(query)
      .sort({ createdAt: -1 })
      .skip(paging.skip)
      .limit(paging.limit)
      .lean(),
    RechargeOrder.countDocuments(query),
  ]);

  return {
    data,
    list: data,
    total,
    page: paging.page,
    limit: paging.limit,
    pages: Math.ceil(total / paging.limit),
  };
}

async function getTransactionFlows(agentId, { page, limit, type, startDate, endDate } = {}) {
  const paging = pageArgs({ page, limit });
  const query = { agentId };
  if (type) query.type = type;
  const createdAt = dateRange(startDate, endDate);
  if (createdAt) query.createdAt = createdAt;

  const [data, total] = await Promise.all([
    Transaction.find(query).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit),
    Transaction.countDocuments(query),
  ]);
  return { data, list: data, total, page: paging.page, limit: paging.limit, pages: Math.ceil(total / paging.limit) };
}

async function getWeeklySettlements(agentId, { limit = 8 } = {}) {
  const safeLimit = Math.min(52, Math.max(1, Number.parseInt(limit, 10) || 8));
  const since = new Date();
  since.setDate(since.getDate() - safeLimit * 7);
  const rows = await Commission.find({ agentId, status: 'settled', createdAt: { $gte: since } })
    .select('commission amount createdAt')
    .sort({ createdAt: -1 })
    .limit(10000)
    .lean();
  const buckets = new Map();
  for (const row of rows) {
    const date = new Date(row.createdAt);
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const offset = day.getUTCDay() || 7;
    day.setUTCDate(day.getUTCDate() - offset + 1);
    const key = day.toISOString().slice(0, 10);
    const bucket = buckets.get(key) || { week: key, commission: 0, amount: 0, count: 0 };
    bucket.commission += Number(row.commission) || 0;
    bucket.amount += Number(row.amount) || 0;
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return { data: [...buckets.values()].sort((a, b) => b.week.localeCompare(a.week)).slice(0, safeLimit), limit: safeLimit };
}

async function getPortalOverview(agentId) {
  const [agent, commission, withdrawals, players] = await Promise.all([
    Agent.findById(agentId).select('-password').lean(),
    Commission.aggregate([
      { $match: { agentId, status: 'settled' } },
      { $group: { _id: null, total: { $sum: '$commission' }, count: { $sum: 1 } } },
    ]),
    Withdrawal.aggregate([
      { $match: { agentId } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    PlayerBinding.countDocuments({ agentId }),
  ]);
  if (!agent) throw new Error('agent not found');
  return {
    agent,
    balance: agent.balance || 0,
    totalEarned: agent.totalEarned || 0,
    commission: commission[0] || { total: 0, count: 0 },
    withdrawals: withdrawals[0] || { total: 0, count: 0 },
    boundPlayers: players,
  };
}

async function getAgentDetail(operatorId, targetId, options = {}) {
  const operator = await Agent.findById(operatorId).select('role parentId').lean();
  const target = await Agent.findById(targetId).select('-password').lean();
  if (!operator || !target) throw new Error('agent not found');

  if (!['root', 'admin'].includes(operator.role)) {
    let current = target;
    let allowed = String(target._id) === String(operatorId);
    while (!allowed && current.parentId) {
      if (String(current.parentId) === String(operatorId)) allowed = true;
      current = await Agent.findById(current.parentId).select('parentId').lean();
      if (!current) break;
    }
    if (!allowed) throw new Error('agent access denied');
  }

  const [overview, players, transactions] = await Promise.all([
    getPortalOverview(target._id),
    getBoundPlayers(target._id, options),
    getTransactionFlows(target._id, options),
  ]);
  return { ...overview, players, transactions };
}

module.exports = {
  getBoundPlayers,
  getMallOrders,
  getTransactionFlows,
  getWeeklySettlements,
  getPortalOverview,
  getAgentDetail,
};
