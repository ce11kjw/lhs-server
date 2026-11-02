/**
 * 充值处理器
 * 处理充值成功回调，发放元宝、更新VIP、记录交易、通知分销系统
 */

const Transaction = require('../db/models/Transaction');
const Player = require('../db/models/Player');
const Mail = require('../db/models/Mail');
const config = require('../services/ConfigService');
const distClient = require('../services/DistClient');
const { buildItemSyncPayload } = require('../services/PlayerGrantService');
const {
  applyRechargeBenefits,
  buildMonthCardUpdatePackets,
  toSafeInt,
} = require('../services/RechargeBenefitService');
const rechargeConfigService = require('../services/RechargeConfigService');
const { toClientMail } = require('./mail');
const logger = require('../logger');

function buildRewardInfo(items = []) {
  return {
    items,
    equips: [],
    pets: [],
    bloodline: [],
  };
}

function mergeRewardItems(items = []) {
  const merged = new Map();
  (Array.isArray(items) ? items : []).forEach((row) => {
    const id = Math.max(1, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    merged.set(id, (merged.get(id) || 0) + count);
  });
  return Array.from(merged.entries())
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => a.id - b.id);
}

function normalizeText(value, maxLength = 0) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return maxLength > 0 ? text.slice(0, maxLength) : text;
}

function buildRechargeMailPayload(product = {}, attachmentRewards = []) {
  const productName = normalizeText(product.name, 64) || normalizeText(product.productId, 64) || '充值商品';
  return {
    title: normalizeText(product.mailTitle, 120) || `${productName}到账`,
    content: normalizeText(product.mailContent, 1000) || `你购买的${productName}已到账，请领取附件奖励。`,
    attachments: mergeRewardItems(attachmentRewards),
  };
}

/**
 * 根据充值金额计算元宝数量（1元=10元宝，首充双倍）
 */
async function calcDiamond(amount, isFirstRecharge, productId = '') {
  const resolvedProductId = rechargeConfigService.normalizeProductId(productId);
  if (resolvedProductId) {
    const customRow = await rechargeConfigService.getResolvedRow(resolvedProductId);
    if (customRow && customRow.enabled !== false && customRow.amount > 0) {
      return customRow.diamond + (isFirstRecharge && customRow.firstBonus ? customRow.firstBonus : 0);
    }
  }

  const rechargeCfg = config.get('RechargeConfig');
  if (rechargeCfg) {
    // 尝试从配置表匹配
    for (const key of Object.keys(rechargeCfg)) {
      const cfg = rechargeCfg[key];
      if (cfg.price === amount) {
        return cfg.diamond + (isFirstRecharge && cfg.firstBonus ? cfg.firstBonus : 0);
      }
    }
  }
  // 默认：1元=10元宝
  const base = Math.floor(amount * 10);
  return isFirstRecharge ? base * 2 : base;
}

/**
 * 根据累计充值更新 VIP 等级
 */
function calcVipLevel(totalRecharge) {
  const vipCfg = config.get('VipConfig');
  if (vipCfg) {
    let maxLevel = 0;
    for (const key of Object.keys(vipCfg)) {
      const cfg = vipCfg[key];
      if (totalRecharge >= (cfg.rechargeNeed || 0) && Number(key) > maxLevel) {
        maxLevel = Number(key);
      }
    }
    return maxLevel;
  }
  // 默认 VIP 等级：每100元升1级
  return Math.min(15, Math.floor(totalRecharge / 100));
}

/**
 * 处理充值回调（HTTP internal API）
 * POST /api/internal/recharge
 * @param {Object} params - { userId, orderId, amount, productId, channel }
 * @param {Object} [wsServer] - WSServer 实例（用于推送）
 * @returns {Promise<Object>} 处理结果
 */
async function handleRecharge(params, wsServer) {
  const { orderId, amount, channel } = params;
  const safeAmount = Number(amount);

  if (!orderId || !Number.isFinite(safeAmount) || safeAmount <= 0) {
    return { success: false, error: 'MISSING_PARAMS' };
  }

  const allowPendingOrder = params.allowPendingOrder === true;
  const idempotentSuccess = params.idempotentSuccess === true;
  let pendingTransaction = null;
  const existing = await Transaction.findOne({ orderId });
  if (existing) {
    if (existing.status === 'success' && idempotentSuccess) {
      logger.warn(`[Recharge] 重复成功订单回调: ${orderId}`);
      return {
        success: true,
        duplicate: true,
        data: {
          orderId: existing.orderId,
          amount: existing.amount,
          diamond: existing.diamond || 0,
          playerId: existing.playerId,
          payId: toSafeInt(existing.productId, 0),
        },
      };
    }
    if (existing.status === 'pending' && allowPendingOrder) {
      pendingTransaction = existing;
    } else {
      logger.warn(`[Recharge] 重复订单: ${orderId}`);
      return { success: false, error: 'DUPLICATE_ORDER' };
    }
  }

  const userId = params.userId || (pendingTransaction && pendingTransaction.userId);
  const productId = params.productId || (pendingTransaction && pendingTransaction.productId) || '';
  if (!userId) return { success: false, error: 'MISSING_PARAMS' };
  const resolvedProductId = rechargeConfigService.normalizeProductId(productId);
  const resolvedProduct = resolvedProductId
    ? await rechargeConfigService.getResolvedRow(resolvedProductId)
    : null;
  const attachmentRewards = resolvedProduct && resolvedProduct.enabled !== false && resolvedProduct.amount > 0
    ? rechargeConfigService.normalizeRewardItems(resolvedProduct.attachments)
    : [];

  // 查找玩家
  const player = await Player.findOne({ userId });
  if (!player) {
    logger.warn(`[Recharge] 玩家不存在: ${userId}`);
    return { success: false, error: 'PLAYER_NOT_FOUND' };
  }

  // 计算元宝
  player.rechargeInfo = player.rechargeInfo || { vipLevel: 0, totalRecharge: 0, totalrecharge: 0 };
  const previousTotalRecharge = Math.max(
    0,
    toSafeInt(player.rechargeInfo.totalRecharge, 0),
    toSafeInt(player.rechargeInfo.totalrecharge, 0)
  );
  const isFirst = previousTotalRecharge === 0;
  const diamond = await calcDiamond(safeAmount, isFirst, productId);

  // 更新玩家数据
  player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
  player.currencies.diamond = (player.currencies.diamond || 0) + diamond;

  const totalRecharge = previousTotalRecharge + safeAmount;
  player.rechargeInfo.totalRecharge = totalRecharge;
  player.rechargeInfo.totalrecharge = totalRecharge;
  if (isFirst) player.rechargeInfo.firstRecharge = safeAmount;

  const benefits = applyRechargeBenefits(player, { productId, payId: productId });
  const monthCardPackets = buildMonthCardUpdatePackets(benefits.monthCardUpdates);
  const rewardInfo = buildRewardInfo(mergeRewardItems([
    ...(diamond > 0 ? [{ id: 1, count: diamond }] : []),
  ]));

  const newVipLevel = calcVipLevel(player.rechargeInfo.totalRecharge);
  player.rechargeInfo.vipLevel = newVipLevel;

  player.markModified('currencies');
  player.markModified('rechargeInfo');
  await player.save();

  let rechargeMail = null;
  if (attachmentRewards.length > 0) {
    const mailPayload = buildRechargeMailPayload(resolvedProduct || { productId }, attachmentRewards);
    rechargeMail = await Mail.create({
      userId,
      title: mailPayload.title,
      content: mailPayload.content,
      sender: '系统',
      attachments: mailPayload.attachments,
    });
  }

  // 创建交易记录
  const transactionData = {
    orderId,
    userId,
    playerId: player.playerId,
    amount: safeAmount,
    diamond,
    productId: productId || '',
    channel: channel || '',
    status: 'success',
    agentId: player.agentId || null,
    extra: {
      ...(pendingTransaction && pendingTransaction.extra && typeof pendingTransaction.extra === 'object'
        ? pendingTransaction.extra
        : {}),
      ...(params.extra && typeof params.extra === 'object' ? params.extra : {}),
      rechargeMail: rechargeMail ? {
        mailId: String(rechargeMail._id || ''),
        attachments: mergeRewardItems(attachmentRewards),
      } : undefined,
    },
  };

  let transaction;
  if (pendingTransaction) {
    Object.assign(pendingTransaction, transactionData);
    transaction = pendingTransaction;
    await transaction.save();
  } else {
    transaction = await Transaction.create(transactionData);
  }

  logger.info(
    `[Recharge] 充值成功: userId=${userId} orderId=${orderId} amount=${safeAmount} diamond=${diamond} vip=${newVipLevel}`
  );

  // 推送充值结果给在线玩家
  if (wsServer) {
    wsServer.pushToUser(userId, 1202, buildItemSyncPayload(player, []));
    wsServer.pushToUser(userId, 1210, {
      result: 0,
      payid: benefits.payId || toSafeInt(productId, 0),
      totalrecharge: player.rechargeInfo.totalrecharge,
      totalRecharge: player.rechargeInfo.totalRecharge,
      rewardInfo,
    });
    monthCardPackets.forEach((packet) => wsServer.pushToUser(userId, packet.tag, packet.data));
    if (rechargeMail) {
      wsServer.pushToUser(userId, 1102, {
        result: 0,
        mailData: toClientMail(rechargeMail),
      });
    }
    if (typeof wsServer.syncSessionPlayer === 'function') {
      wsServer.syncSessionPlayer(userId, player);
    }
  }

  // 通知分销系统（异步，不阻塞充值流程）
  if (player.inviteCode) {
    const distResult = await distClient.rechargeCallback({
      playerId: player.playerId,
      orderId,
      amount: safeAmount,
      inviteCode: player.inviteCode,
    });
    if (distResult && distResult.pendingCompensation) {
      transaction.extra = {
        ...(transaction.extra && typeof transaction.extra === 'object' ? transaction.extra : {}),
        distCallback: {
          status: 'pending',
          error: distResult.error || '',
          updatedAt: new Date().toISOString(),
        },
      };
      await transaction.save();
    }
  }

  return {
    success: true,
    data: {
      orderId: transaction.orderId,
      amount: transaction.amount,
      diamond,
      playerId: player.playerId,
      vipLevel: newVipLevel,
      payId: benefits.payId || toSafeInt(productId, 0),
      monthCardUpdates: benefits.monthCardUpdates,
      attachments: attachmentRewards,
    },
  };
}

module.exports = { handleRecharge, calcDiamond, calcVipLevel };
