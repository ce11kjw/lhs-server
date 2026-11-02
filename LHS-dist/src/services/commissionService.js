const Agent = require('../models/Agent');
const Commission = require('../models/Commission');
const PlayerBinding = require('../models/PlayerBinding');
const RechargeOrder = require('../models/RechargeOrder');
const Transaction = require('../models/Transaction');
const { runInTransaction } = require('../utils/dbTransaction');
const { COMMISSION_RATE_KEYS, getCommissionRateByDistance } = require('../utils/agentRole');

let rechargeOrderIndexInitPromise = null;

function buildSaveOptions(session) {
  return session ? { session } : undefined;
}

function isDuplicateKeyError(error) {
  return Boolean(error && error.code === 11000);
}

async function ensureRechargeOrderIndexes() {
  if (!rechargeOrderIndexInitPromise) {
    rechargeOrderIndexInitPromise = RechargeOrder.init();
  }
  await rechargeOrderIndexInitPromise;
}

async function calculateCommission({ playerId, orderId, amount, inviteCode }) {
  await ensureRechargeOrderIndexes();

  try {
    return await runInTransaction(async (session) => {
      const processedOrder = new RechargeOrder({
        orderId,
        playerId,
        amount,
        inviteCode: inviteCode || '',
      });
      await processedOrder.save(buildSaveOptions(session));

      let sourceAgent = null;
      const binding = await PlayerBinding.findOne({ playerId }).session(session || null);

      if (binding) {
        sourceAgent = await Agent.findById(binding.agentId).session(session || null);
      } else if (inviteCode) {
        sourceAgent = await Agent.findOne({ inviteCode }).session(session || null);
      }

      if (!sourceAgent) {
        throw new Error('未找到代理商');
      }

      if (sourceAgent.status !== 'active') {
        throw new Error('代理已被禁用');
      }

      const agentChain = [sourceAgent];
      let currentAgent = sourceAgent;

      while (currentAgent.parentId && agentChain.length < COMMISSION_RATE_KEYS.length) {
        currentAgent = await Agent.findById(currentAgent.parentId).session(session || null);
        if (!currentAgent) {
          break;
        }
        agentChain.push(currentAgent);
      }

      const commissions = [];

      for (let i = 0; i < agentChain.length; i += 1) {
        const agent = agentChain[i];
        const rate = getCommissionRateByDistance(agent, i);

        const commissionAmount = Math.floor(amount * rate);

        const commission = new Commission({
          agentId: agent._id,
          playerId,
          orderId,
          amount,
          commission: commissionAmount,
          rate,
          level: i,
          sourceAgentId: sourceAgent._id,
          status: 'settled',
          settledAt: new Date(),
        });
        await commission.save(buildSaveOptions(session));

        const updatedAgent = await Agent.findByIdAndUpdate(
          agent._id,
          {
            $inc: {
              balance: commissionAmount,
              totalEarned: commissionAmount,
            },
          },
          {
            new: true,
            session,
          }
        );

        const transaction = new Transaction({
          agentId: agent._id,
          type: 'commission_in',
          amount: commissionAmount,
          balanceAfter: updatedAgent.balance,
          relatedId: commission._id,
          relatedType: 'Commission',
          description: `佣金入账 - 订单${orderId}`,
          metadata: {
            playerId,
            orderId,
            level: i,
            rate,
          },
        });
        await transaction.save(buildSaveOptions(session));

        commissions.push({
          agentId: agent._id.toString(),
          username: agent.username,
          level: i,
          rate,
          commission: commissionAmount,
        });
      }

      return {
        success: true,
        orderId,
        amount,
        commissions,
      };
    }, { label: 'commission.calculate' });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new Error('订单已处理');
    }
    throw error;
  }
}

async function getCommissionList(agentId, { page = 1, limit = 20, startDate, endDate } = {}) {
  const skip = (page - 1) * limit;
  const query = { agentId };

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) {
      query.createdAt.$gte = new Date(startDate);
    }
    if (endDate) {
      query.createdAt.$lte = new Date(endDate);
    }
  }

  const list = await Commission.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('sourceAgentId', 'username inviteCode');

  const total = await Commission.countDocuments(query);

  return {
    list,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
}

async function getCommissionSummary(agentId, { startDate, endDate } = {}) {
  const query = { agentId, status: 'settled' };

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) {
      query.createdAt.$gte = new Date(startDate);
    }
    if (endDate) {
      query.createdAt.$lte = new Date(endDate);
    }
  }

  const result = await Commission.aggregate([
    { $match: query },
    {
      $group: {
        _id: null,
        totalCommission: { $sum: '$commission' },
        count: { $sum: 1 },
      },
    },
  ]);

  return result[0] || { totalCommission: 0, count: 0 };
}

async function exportCommissions(agentId, { startDate, endDate }) {
  const query = { agentId };

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) {
      query.createdAt.$gte = new Date(startDate);
    }
    if (endDate) {
      query.createdAt.$lte = new Date(endDate);
    }
  }

  return Commission.find(query).sort({ createdAt: -1 }).limit(10000);
}

module.exports = {
  calculateCommission,
  getCommissionList,
  getCommissionSummary,
  exportCommissions,
};
