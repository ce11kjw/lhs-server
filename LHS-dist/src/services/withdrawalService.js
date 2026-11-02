const Agent = require('../models/Agent');
const Withdrawal = require('../models/Withdrawal');
const Transaction = require('../models/Transaction');
const config = require('../config');
const { runInTransaction } = require('../utils/dbTransaction');

function buildSaveOptions(session) {
  return session ? { session } : undefined;
}

async function applyWithdrawal(agentId, { amount, bankInfo }) {
  const fee = Math.floor(amount * config.withdrawalFeeRate);
  const actualAmount = amount - fee;

  return runInTransaction(async (session) => {
    const agent = await Agent.findOneAndUpdate(
      {
        _id: agentId,
        balance: { $gte: amount },
      },
      {
        $inc: { balance: -amount },
      },
      {
        new: false,
        session,
      }
    );

    if (!agent) {
      throw new Error('余额不足或代理商不存在');
    }

    const withdrawal = new Withdrawal({
      agentId,
      amount,
      fee,
      actualAmount,
      bankInfo,
      status: 'pending',
    });
    await withdrawal.save(buildSaveOptions(session));

    const transaction = new Transaction({
      agentId,
      type: 'withdrawal_out',
      amount: -amount,
      balanceAfter: agent.balance - amount,
      relatedId: withdrawal._id,
      relatedType: 'Withdrawal',
      description: `提现申请 - ${actualAmount / 100}元`,
      metadata: {
        amount,
        fee,
        actualAmount,
        bankInfo,
      },
    });
    await transaction.save(buildSaveOptions(session));

    return withdrawal;
  }, { label: 'withdrawal.apply' });
}

async function getWithdrawalList(agentId, { page = 1, limit = 20, status } = {}) {
  const skip = (page - 1) * limit;
  const query = { agentId };

  if (status) {
    query.status = status;
  }

  const list = await Withdrawal.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit);
  const total = await Withdrawal.countDocuments(query);

  return {
    list,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
}

async function approveWithdrawal(withdrawalId, approvedBy) {
  return runInTransaction(async (session) => {
    const withdrawal = await Withdrawal.findOneAndUpdate(
      {
        _id: withdrawalId,
        status: 'pending',
      },
      {
        $set: {
          status: 'approved',
          approvedBy,
          approvedAt: new Date(),
        },
      },
      {
        new: true,
        session,
      }
    );

    if (!withdrawal) {
      const existing = await Withdrawal.findById(withdrawalId).session(session || null);
      if (!existing) {
        throw new Error('提现记录不存在');
      }
      throw new Error('提现记录状态不正确');
    }

    return withdrawal;
  }, { label: 'withdrawal.approve' });
}

async function rejectWithdrawal(withdrawalId, approvedBy, rejectReason) {
  return runInTransaction(async (session) => {
    const withdrawal = await Withdrawal.findOneAndUpdate(
      {
        _id: withdrawalId,
        status: 'pending',
      },
      {
        $set: {
          status: 'rejected',
          approvedBy,
          approvedAt: new Date(),
          rejectReason,
        },
      },
      {
        new: true,
        session,
      }
    );

    if (!withdrawal) {
      const existing = await Withdrawal.findById(withdrawalId).session(session || null);
      if (!existing) {
        throw new Error('提现记录不存在');
      }
      throw new Error('提现记录状态不正确');
    }

    const updatedAgent = await Agent.findByIdAndUpdate(
      withdrawal.agentId,
      {
        $inc: { balance: withdrawal.amount },
      },
      {
        new: true,
        session,
      }
    );

    const transaction = new Transaction({
      agentId: withdrawal.agentId,
      type: 'withdrawal_refund',
      amount: withdrawal.amount,
      balanceAfter: updatedAgent.balance,
      relatedId: withdrawal._id,
      relatedType: 'Withdrawal',
      description: `提现退款 - ${rejectReason}`,
      metadata: {
        amount: withdrawal.amount,
        rejectReason,
      },
    });
    await transaction.save(buildSaveOptions(session));

    return withdrawal;
  }, { label: 'withdrawal.reject' });
}

module.exports = {
  applyWithdrawal,
  getWithdrawalList,
  approveWithdrawal,
  rejectWithdrawal,
};
