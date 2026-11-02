/**
 * Alchemy handlers.
 * tag: 2500 generate, 2501 auto-generate
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const { addAlchemyGenerateCount } = require('../services/MainTaskProgressService');
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

function buildRewardInfo(items = []) {
  return {
    items: Array.isArray(items) ? items : [],
    equips: [],
    pets: [],
    bloodline: [],
    artifacts: [],
  };
}

function getDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return y * 10000 + m * 100 + day;
}

function getAlchemyDailyLimit() {
  const baseCfg = config.get('AlchemyBaseConfig') || {};
  const limit = toSafeInt(baseCfg.alchemyDailyCount, 50);
  return Math.max(1, limit);
}

function ensureAlchemyInfo(player) {
  player.alchemyInfo = ensureObject(player.alchemyInfo);
  player.items = ensureObject(player.items);
  const info = player.alchemyInfo;
  const dayKey = getDayKey(Date.now());

  info.dayKey = Math.max(0, toSafeInt(info.dayKey, dayKey));
  if (info.dayKey !== dayKey) {
    info.dayKey = dayKey;
    info.dayCount = 0;
  }

  info.dayCount = Math.max(0, toSafeInt(info.dayCount, 0));
  info.level = Math.max(1, toSafeInt(info.level != null ? info.level : info.lv, 1));
  info.lv = info.level;
  info.exp = Math.max(0, toSafeInt(info.exp, 0), toSafeInt(player.items[41], 0));
  player.items[41] = info.exp;
  return info;
}

function applyExpLevel(info, gainExp) {
  const add = Math.max(0, toSafeInt(gainExp, 0));
  if (add <= 0) return;
  info.exp += add;
  // Simple stable growth curve for playable loop.
  info.level = Math.max(1, Math.floor(info.exp / 100) + 1);
  info.lv = info.level;
}

function syncAlchemyExpItem(player, info) {
  if (!player || !info) return;
  player.items = ensureObject(player.items);
  player.items[41] = Math.max(0, toSafeInt(info.exp, 0));
}

function buildTaskUpdatePacketsSafe(player, msgUid = 0) {
  try {
    // eslint-disable-next-line global-require
    const task = require('./task');
    if (task && typeof task.buildActiveTaskUpdatePackets === 'function') {
      return task.buildActiveTaskUpdatePackets(player, msgUid);
    }
  } catch (_err) {}
  return [];
}

async function persistPlayer(session, player) {
  if (!session || !session.userId || !player) return;
  const saved = await playerService.savePlayer(session.userId, player);
  if (saved) session.player = saved;
}

function grantGenerateRewards(player, recipeId, count, exchangeFlag = 0) {
  const safeRecipeId = Math.max(0, toSafeInt(recipeId, 0));
  const safeCount = Math.max(0, toSafeInt(count, 0));
  const exchange = Math.max(0, toSafeInt(exchangeFlag, 0));

  if (safeCount <= 0) return [];

  const assetsCfg = config.get('AssetsConfig') || {};
  const pillRow = assetsCfg[safeRecipeId] || assetsCfg[String(safeRecipeId)] || null;
  const rows = [];

  // 炼丹主产物应当是当前目标丹药本身，而不是额外给经验/银两。
  if (pillRow && toSafeInt(pillRow.type, 0) === 9) {
    rows.push({ id: safeRecipeId, count: safeCount });
  }

  // 自动炼丹的兑换开关保留一点兼容奖励，避免旧客户端流程完全空回包。
  if (exchange > 0) {
    rows.push({ id: 2, count: safeCount * 20 });
  }

  rows.forEach((row) => addRewardToPlayer(player, row.id, row.count));
  return rows;
}

async function handleGenerate(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 2500,
      msgUid,
      data: { result: -1, level: 1, exp: 0, dayCount: 0, count: 0, rewardInfo: buildRewardInfo([]) },
    };
  }

  const info = ensureAlchemyInfo(player);
  const reqCount = Math.max(0, toSafeInt(params.count, 0));
  const dayLimit = getAlchemyDailyLimit();
  const remain = Math.max(0, dayLimit - info.dayCount);
  const realCount = Math.min(reqCount, remain);

  if (realCount <= 0) {
    return {
      tag: 2500,
      msgUid,
      data: {
        result: 1,
        id: Math.max(0, toSafeInt(params.id, 0)),
        count: 0,
        level: info.level,
        exp: info.exp,
        dayCount: info.dayCount,
        rewardInfo: buildRewardInfo([]),
      },
    };
  }

  const rewardRows = grantGenerateRewards(player, params.id, realCount, 0);
  info.dayCount += realCount;
  applyExpLevel(info, realCount);
  syncAlchemyExpItem(player, info);
  const taskChanged = !!addAlchemyGenerateCount(player, realCount);
  await persistPlayer(session, player);

  const response = {
    tag: 2500,
    msgUid,
    data: {
      result: 0,
      id: Math.max(0, toSafeInt(params.id, 0)),
      count: realCount,
      level: info.level,
      lv: info.lv,
      exp: info.exp,
      dayCount: info.dayCount,
      rewardInfo: buildRewardInfo(rewardRows),
    },
  };
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

async function handleAutoGenerate(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 2501,
      msgUid,
      data: { result: -1, level: 1, exp: 0, dayCount: 0, count: 0, rewardInfo: buildRewardInfo([]) },
    };
  }

  const info = ensureAlchemyInfo(player);
  const reqCount = Math.max(0, toSafeInt(params.count, 0));
  const dayLimit = getAlchemyDailyLimit();
  const remain = Math.max(0, dayLimit - info.dayCount);
  const realCount = Math.min(reqCount, remain);

  if (realCount <= 0) {
    return {
      tag: 2501,
      msgUid,
      data: {
        result: 1,
        id: Math.max(0, toSafeInt(params.id, 0)),
        count: 0,
        level: info.level,
        exp: info.exp,
        dayCount: info.dayCount,
        rewardInfo: buildRewardInfo([]),
      },
    };
  }

  const rewardRows = grantGenerateRewards(player, params.id, realCount, params.exchange);
  info.dayCount += realCount;
  applyExpLevel(info, realCount);
  syncAlchemyExpItem(player, info);
  const taskChanged = !!addAlchemyGenerateCount(player, realCount);
  await persistPlayer(session, player);

  const response = {
    tag: 2501,
    msgUid,
    data: {
      result: 0,
      id: Math.max(0, toSafeInt(params.id, 0)),
      count: realCount,
      level: info.level,
      lv: info.lv,
      exp: info.exp,
      dayCount: info.dayCount,
      rewardInfo: buildRewardInfo(rewardRows),
    },
  };
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

module.exports = {
  ensureAlchemyInfo,
  handleGenerate,
  handleAutoGenerate,
};
