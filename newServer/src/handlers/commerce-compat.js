/**
 * Commerce compatibility handlers.
 * tag: 1211, 1220, 1240, 1241
 */

const playerService = require('../services/PlayerService');
const configService = require('../services/ConfigService');
const { addRewardToPlayer } = require('./raid');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensureObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function isConfiguredChainPackageId(value) {
  const id = Math.max(0, toSafeInt(value, 0));
  if (id <= 0) return false;
  const condConfig = ensureObject(configService.get('ShopGiftCondConfig'));
  const giftConfig = ensureObject(configService.get('ShopGiftConfig'));
  return !!(condConfig[id] || condConfig[String(id)])
    && !!(giftConfig[id] || giftConfig[String(id)]);
}

function buildRewardInfo(items = []) {
  return {
    items,
    equips: [],
    pets: [],
    bloodline: [],
  };
}

function normalizeRewardRows(rows = []) {
  return ensureArray(rows)
    .map((row) => ({
      id: Math.max(0, toSafeInt(row && row.id, 0)),
      count: Math.max(0, toSafeInt(row && row.count, 0)),
    }))
    .filter((row) => row.id > 0 && row.count > 0);
}

function grantRows(player, rows) {
  const normalized = normalizeRewardRows(rows);
  normalized.forEach((row) => addRewardToPlayer(player, row.id, row.count));
  return normalized;
}

function ensureRechargeInfo(player) {
  player.rechargeInfo = ensureObject(player.rechargeInfo);
  const info = player.rechargeInfo;
  info.monthCardRecords = ensureObject(info.monthCardRecords);
  return info;
}

function ensureShopInfo(player) {
  player.shopInfo = ensureObject(player.shopInfo);
  const info = player.shopInfo;
  info.triggerRecords = ensureArray(info.triggerRecords);
  info.chainPack = ensureArray(info.chainPack).filter((row) => (
    isConfiguredChainPackageId(row && row.id)
  ));
  return info;
}

function ensureAdInfo(player) {
  player.other_attr_info = ensureObject(player.other_attr_info);
  player.other_attr_info.adInfo = ensureObject(player.other_attr_info.adInfo);
  player.rechargeInfo = ensureObject(player.rechargeInfo);
  const info = player.other_attr_info.adInfo;
  const rechargeInfo = player.rechargeInfo;

  const mergedRecords = {
    ...ensureObject(rechargeInfo.adRecords),
    ...ensureObject(info.records),
  };
  const mergedTimeRecords = {
    ...ensureObject(rechargeInfo.adTimeRecords),
    ...ensureObject(info.timeRecords),
  };

  info.records = mergedRecords;
  info.timeRecords = mergedTimeRecords;
  rechargeInfo.adRecords = mergedRecords;
  rechargeInfo.adTimeRecords = mergedTimeRecords;
  return info;
}

async function persistPlayer(session, player) {
  if (!session || !session.userId || !player) return;
  const saved = await playerService.savePlayer(session.userId, player);
  if (saved) session.player = saved;
}

async function handleMonthcardsReward(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 1211,
      msgUid,
      data: { result: -1, id: Math.max(0, toSafeInt(params.id, 0)), rewardInfo: buildRewardInfo([]) },
    };
  }

  const info = ensureRechargeInfo(player);
  const id = Math.max(0, toSafeInt(params.id, 0));
  const now = Date.now();
  const rows = grantRows(player, [{ id: 1, count: 50 }]);
  info.monthCardRecords[String(id)] = now;
  await persistPlayer(session, player);

  return {
    tag: 1211,
    msgUid,
    data: {
      result: 0,
      id,
      rewardInfo: buildRewardInfo(rows),
    },
  };
}

async function handleAdReward(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 1220,
      msgUid,
      data: {
        result: -1,
        adId: Math.max(0, toSafeInt(params.adId, 0)),
        itemId: Math.max(0, toSafeInt(params.adId, 0)),
        time: 0,
        rewardInfo: buildRewardInfo([]),
      },
    };
  }

  const adId = Math.max(0, toSafeInt(params.adId, 0));
  const now = Date.now();
  const adInfo = ensureAdInfo(player);
  const key = String(adId);
  adInfo.records[key] = Math.max(0, toSafeInt(adInfo.records[key], 0)) + 1;
  adInfo.timeRecords[key] = now;

  const rows = grantRows(player, [{ id: 3, count: 20 + adId }]);
  await persistPlayer(session, player);

  return {
    tag: 1220,
    msgUid,
    data: {
      result: 0,
      adId,
      itemId: adId,
      time: now,
      rewardInfo: buildRewardInfo(rows),
    },
  };
}

async function handleTriggerPackage(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1240, msgUid, data: { result: -1 } };
  }

  const info = ensureShopInfo(player);
  const trigger = Math.max(0, toSafeInt(params.trigger, 0));
  const param = Math.max(0, toSafeInt(params.param, 0));
  info.triggerRecords.push({
    trigger,
    param,
    time: Date.now(),
  });
  const packageId = param > 0 ? param : trigger;
  let chainPack = null;
  if (isConfiguredChainPackageId(packageId)) {
    chainPack = {
      id: packageId,
      index: 0,
      expireTime: Date.now() + 24 * 60 * 60 * 1000,
      trigger,
    };
    const rowIndex = info.chainPack.findIndex((row) => toSafeInt(row && row.id, 0) === packageId);
    if (rowIndex >= 0) info.chainPack[rowIndex] = chainPack;
    else info.chainPack.push(chainPack);
  }
  await persistPlayer(session, player);

  const response = {
    tag: 1240,
    msgUid,
    data: {
      result: 0,
      trigger,
      param,
    },
  };
  return chainPack
    ? [{ tag: 1231, msgUid: 0, data: chainPack }, response]
    : response;
}

async function handleChainPackageReward(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 1241,
      msgUid,
      data: {
        result: -1,
        id: Math.max(0, toSafeInt(params.id, 0)),
        index: Math.max(0, toSafeInt(params.index, 0)),
        rewardInfo: buildRewardInfo([]),
      },
    };
  }

  const id = Math.max(0, toSafeInt(params.id, 0));
  const index = Math.max(0, toSafeInt(params.index, 0));
  const info = ensureShopInfo(player);
  if (!isConfiguredChainPackageId(id)) {
    return {
      tag: 1241,
      msgUid,
      data: { result: 1, id, index, rewardInfo: buildRewardInfo([]) },
    };
  }
  info.chainPack = info.chainPack.filter((row) => !(toSafeInt(row && row.id, 0) === id
    && toSafeInt(row && row.index, 0) === index));

  const rows = grantRows(player, [{ id: 1, count: 30 + index * 10 }]);
  await persistPlayer(session, player);

  return {
    tag: 1241,
    msgUid,
    data: {
      result: 0,
      id,
      index,
      rewardInfo: buildRewardInfo(rows),
    },
  };
}

module.exports = {
  isConfiguredChainPackageId,
  handleMonthcardsReward,
  handleAdReward,
  handleTriggerPackage,
  handleChainPackageReward,
};
