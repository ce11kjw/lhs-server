/**
 * Invest game handlers
 * tag: 5600/5601/5602
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const { addRewardToPlayer } = require('./raid');
const { buildRewardItemSync } = require('../services/RewardSync');

const GAME_IDS = [2, 3, 4, 5, 6, 7];

const GAME_CFG = {
  2: { chapter: 'SoldierDefenseChapterConfig', base: 'SoldierDefenseBaseConfig', chapterIdKey: 'id', passKey: 'victoryScore' },
  3: { chapter: 'RelationshipNetChapterConfig', base: 'RelationshipNetBaseConfig', chapterIdKey: 'id', passKey: '' },
  4: { chapter: 'RotateKnifeLevelConfig', base: 'RelationshipNetBaseConfig', chapterIdKey: 'id', passKey: '' },
  5: { chapter: 'SurviveRepeatRewardConfig', base: 'SurviveBaseConfig', chapterIdKey: 'sceneID', passKey: 'passScore' },
  6: { chapter: 'HeroRoadLevelConfig', base: 'HeroRoadBaseConfig', chapterIdKey: 'id', passKey: '' },
  7: { chapter: 'ExorciseChapterConfig', base: 'ExorciseBaseConfig', chapterIdKey: 'id', passKey: '' },
};

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function normalizeObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function ensureArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function getDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return Number(`${y}${m}${day}`);
}

function getCfg(gameId) {
  return GAME_CFG[gameId] || null;
}

function getChapterTable(gameId) {
  const row = getCfg(gameId);
  if (!row) return {};
  return config.get(row.chapter) || {};
}

function getBaseTable(gameId) {
  const row = getCfg(gameId);
  if (!row) return {};
  return config.get(row.base) || {};
}

function getChapterRow(gameId, chapter) {
  const table = getChapterTable(gameId);
  const row = table[String(chapter)] || null;
  return row && typeof row === 'object' ? row : null;
}

function getChapterPassThreshold(gameId, chapter) {
  const cfg = getCfg(gameId);
  if (!cfg || !cfg.passKey) return 0;
  const row = getChapterRow(gameId, chapter);
  if (!row) return 0;
  return Math.max(0, toSafeInt(row[cfg.passKey], 0));
}

function getChapterRewards(gameId, chapter) {
  const row = getChapterRow(gameId, chapter);
  const list = ensureArray(row && row.rewards);
  return list
    .map((item) => ({
      id: Math.max(0, toSafeInt(item && item.id, 0)),
      count: Math.max(0, toSafeInt(item && item.count, 0)),
    }))
    .filter((item) => item.id > 0 && item.count > 0);
}

function getDailyRewards(gameId) {
  const base = getBaseTable(gameId);
  const list = ensureArray(base && base.dailyRewards);
  return list
    .map((item) => ({
      id: Math.max(0, toSafeInt(item && item.id, 0)),
      count: Math.max(0, toSafeInt(item && item.count, 0)),
    }))
    .filter((item) => item.id > 0 && item.count > 0);
}

function getChapterIds(gameId) {
  const table = getChapterTable(gameId);
  const cfg = getCfg(gameId);
  if (!cfg) return [];

  return Object.keys(table)
    .map((key) => {
      const row = normalizeObject(table[key]);
      const chapterId = toSafeInt(row[cfg.chapterIdKey], toSafeInt(key, 0));
      return chapterId;
    })
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
}

function ensureGameRow(raw, gameId) {
  const row = normalizeObject(raw);
  return {
    id: gameId,
    clearChapter: Math.max(0, toSafeInt(row.clearChapter, 0)),
    dailyReward: ensureArray(row.dailyReward)
      .map((chapter) => Math.max(0, toSafeInt(chapter, 0)))
      .filter((chapter) => chapter > 0),
    currentChapter: Math.max(1, toSafeInt(row.currentChapter, 1)),
    lastScore: Math.max(0, toSafeInt(row.lastScore, 0)),
    updatedAt: Math.max(0, toSafeInt(row.updatedAt, 0)),
  };
}

function ensureInvestGameInfo(player = {}) {
  player.other_attr_info = normalizeObject(player.other_attr_info);
  const holder = player.other_attr_info;

  holder.investGameInfo = normalizeObject(holder.investGameInfo);
  const info = holder.investGameInfo;
  info.dayKey = Math.max(0, toSafeInt(info.dayKey, getDayKey()));
  info.info = ensureArray(info.info);

  const map = {};
  for (const gameId of GAME_IDS) {
    const old = info.info.find((row) => toSafeInt(row && row.id, 0) === gameId);
    map[String(gameId)] = ensureGameRow(old, gameId);
  }

  if (info.dayKey !== getDayKey()) {
    info.dayKey = getDayKey();
    for (const gameId of GAME_IDS) {
      map[String(gameId)].dailyReward = [];
    }
  }

  info.info = GAME_IDS.map((gameId) => map[String(gameId)]);
  return info;
}

function buildInvestGamePayload(info) {
  return {
    info: ensureArray(info && info.info),
  };
}

function buildRewardInfo(items = []) {
  return {
    items: ensureArray(items),
    equips: [],
    swords: [],
    pets: [],
    artifacts: [],
    gems: [],
    bloodline: [],
    valhalla: [],
  };
}

function isChapterPassed(gameId, chapter, score) {
  const threshold = getChapterPassThreshold(gameId, chapter);
  if (threshold <= 0) return true;
  return Math.max(0, toSafeInt(score, 0)) >= threshold;
}

function mergeRewards(...groups) {
  const map = {};
  for (const group of groups) {
    for (const reward of ensureArray(group)) {
      const id = Math.max(0, toSafeInt(reward && reward.id, 0));
      const count = Math.max(0, toSafeInt(reward && reward.count, 0));
      if (id <= 0 || count <= 0) continue;
      map[String(id)] = Math.max(0, toSafeInt(map[String(id)], 0)) + count;
    }
  }

  return Object.keys(map).map((id) => ({ id: Number(id), count: map[id] }));
}

async function persistPlayer(session, player) {
  if (!session || !session.userId) return;
  const saved = await playerService.savePlayer(session.userId, player);
  if (saved && typeof saved === 'object') {
    session.player = saved;
  }
}

async function handleInvestGameInfo(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 5600,
      msgUid,
      data: { info: [] },
    };
  }

  const info = ensureInvestGameInfo(player);
  const gameId = Math.max(0, toSafeInt(params.id, 0));
  if (gameId > 0 && !GAME_IDS.includes(gameId)) {
    return {
      tag: 5600,
      msgUid,
      data: buildInvestGamePayload(info),
    };
  }

  await persistPlayer(session, player);
  return {
    tag: 5600,
    msgUid,
    data: buildInvestGamePayload(info),
  };
}

async function handleInvestGameStart(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 5601, msgUid, data: { result: -1, id: 0, chapter: 0 } };
  }

  const info = ensureInvestGameInfo(player);
  const id = Math.max(0, toSafeInt(params.id, 0));
  if (!GAME_IDS.includes(id)) {
    return { tag: 5601, msgUid, data: { result: -1, id, chapter: 0 } };
  }

  const row = info.info.find((gameRow) => gameRow.id === id);
  const chapterIds = getChapterIds(id);
  const reqChapter = Math.max(1, toSafeInt(params.chapter, 1));
  const maxUnlocked = Math.max(1, Math.min(chapterIds.length || 1, row.clearChapter + 1));
  const chapter = Math.max(1, Math.min(reqChapter, maxUnlocked));

  row.currentChapter = chapter;
  row.updatedAt = Date.now();

  await persistPlayer(session, player);

  return {
    tag: 5601,
    msgUid,
    data: {
      result: 0,
      id,
      chapter,
    },
  };
}

async function handleInvestGameEnd(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 5602, msgUid, data: { result: -1, info: {}, rewardInfo: buildRewardInfo([]) } };
  }

  const info = ensureInvestGameInfo(player);
  const id = Math.max(0, toSafeInt(params.id, 0));
  if (!GAME_IDS.includes(id)) {
    return { tag: 5602, msgUid, data: { result: -1, info: {}, rewardInfo: buildRewardInfo([]) } };
  }

  const row = info.info.find((gameRow) => gameRow.id === id);
  const chapterIds = getChapterIds(id);
  const maxChapter = Math.max(1, chapterIds.length || 1);
  const reqChapter = Math.max(1, toSafeInt(params.chapter, row.currentChapter || 1));
  const chapter = Math.max(1, Math.min(reqChapter, maxChapter));
  const score = Math.max(0, toSafeInt(params.score, 0));

  const passed = isChapterPassed(id, chapter, score);
  const rewards = [];

  if (passed) {
    if (chapter > row.clearChapter) {
      row.clearChapter = chapter;
      rewards.push(...getChapterRewards(id, chapter));
    }

    const todayDayKey = getDayKey();
    if (info.dayKey !== todayDayKey) {
      info.dayKey = todayDayKey;
      row.dailyReward = [];
    }

    if (!row.dailyReward.includes(chapter)) {
      row.dailyReward.push(chapter);
      rewards.push(...getDailyRewards(id));
    }
  }

  row.currentChapter = chapter;
  row.lastScore = score;
  row.updatedAt = Date.now();

  const mergedRewards = mergeRewards(rewards);
  for (const reward of mergedRewards) {
    addRewardToPlayer(player, reward.id, reward.count);
  }

  const rewardSync = mergedRewards.length > 0 ? buildRewardItemSync(player, mergedRewards) : null;
  await persistPlayer(session, player);

  if (rewardSync) {
    return [
      { tag: 1202, msgUid: 0, data: rewardSync },
      {
        tag: 5602,
        msgUid,
        data: {
          result: 0,
          info: row,
          rewardInfo: buildRewardInfo(mergedRewards),
        },
      },
    ];
  }

  return {
    tag: 5602,
    msgUid,
    data: {
      result: 0,
      info: row,
      rewardInfo: buildRewardInfo(mergedRewards),
    },
  };
}

module.exports = {
  ensureInvestGameInfo,
  buildInvestGamePayload,
  handleInvestGameInfo,
  handleInvestGameStart,
  handleInvestGameEnd,
};
