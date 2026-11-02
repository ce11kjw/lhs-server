/**
 * Team Fight handlers.
 * tag: 6100~6105, 6110~6118
 */

const playerService = require('../services/PlayerService');
const { addRewardToPlayer } = require('./raid');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureObject(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...fallback };
  }
  return value;
}

function normalizeDeck(value) {
  if (Array.isArray(value)) {
    return value.map((v) => Math.max(0, toSafeInt(v, 0))).filter((v) => v > 0);
  }
  return [];
}

function ensureRoundPack(roundData) {
  roundData.pack = ensureObject(roundData.pack);
  if (!Array.isArray(roundData.pack[1])) roundData.pack[1] = [];
  if (!Array.isArray(roundData.pack[2])) roundData.pack[2] = [];
  return roundData.pack;
}

function buildRewardInfo(items = []) {
  return {
    items: ensureArray(items),
    equips: [],
    extra: [],
  };
}

function grantRewards(player, rows = []) {
  const map = new Map();
  ensureArray(rows).forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    map.set(id, (map.get(id) || 0) + count);
  });
  const out = [];
  map.forEach((count, id) => {
    addRewardToPlayer(player, id, count);
    out.push({ id, count });
  });
  out.sort((a, b) => a.id - b.id);
  return out;
}

function buildShopItemByIndex(index, stage = 1) {
  const safeIndex = Math.max(0, toSafeInt(index, 0));
  const type = safeIndex % 2 === 0 ? 1 : 2;
  if (type === 1) {
    return {
      id: 29000 + ((safeIndex % 8) + 1),
      level: Math.max(1, toSafeInt(stage, 1)),
      type,
    };
  }
  return {
    id: 30000 + ((safeIndex % 12) + 1),
    level: Math.max(1, toSafeInt(stage, 1)),
    type,
  };
}

function buildShopItems(stage = 1) {
  const list = [];
  for (let i = 0; i < 5; i++) {
    list.push(buildShopItemByIndex(i, stage));
  }
  return list;
}

function buildEnemyData(player, stage = 1) {
  return {
    dbid: `tf_enemy_${Math.max(1, toSafeInt(stage, 1))}`,
    name: `试炼对手${Math.max(1, toSafeInt(stage, 1))}`,
    avatar: Math.max(0, toSafeInt(player && player.avatar, 11305)),
    avatarFrame: Math.max(-1, toSafeInt(player && player.avatarFrame, -1)),
    level: Math.max(1, toSafeInt(player && player.level, 1)),
    power: 1500 + Math.max(1, toSafeInt(stage, 1)) * 150,
  };
}

function createRoundData(info, deck = []) {
  const stage = Math.max(1, toSafeInt(info.stage, 1));
  return {
    stage,
    lifeCost: 0,
    shopLevel: 1,
    shopExp: 0,
    shopLock: 0,
    shopItems: buildShopItems(stage),
    pack: {
      1: [],
      2: [],
    },
    enemyInfos: {},
    cachedEnemy: null,
    fightSeed: 0,
    deck: normalizeDeck(deck),
  };
}

function ensureTeamFightInfo(player) {
  player.other_attr_info = ensureObject(player.other_attr_info);
  const root = player.other_attr_info;
  root.teamFightInfo = ensureObject(root.teamFightInfo);
  const info = root.teamFightInfo;

  info.stage = Math.max(0, toSafeInt(info.stage, 0));
  info.score = Math.max(0, toSafeInt(info.score, 0));
  info.rank = Math.max(1, toSafeInt(info.rank, 9999));
  info.maxScore = Math.max(0, toSafeInt(info.maxScore, info.score));
  info.dan = Math.max(1, toSafeInt(info.dan, 1));
  info.rankReward = ensureArray(info.rankReward).map((v) => Math.max(1, toSafeInt(v, 1)));
  info.deckMap = ensureObject(info.deckMap);
  Object.keys(info.deckMap).forEach((k) => {
    info.deckMap[k] = normalizeDeck(info.deckMap[k]);
  });
  if (Object.keys(info.deckMap).length <= 0) {
    info.deckMap['1'] = [29001];
    info.deckMap['2'] = [29002];
  }

  info.roundData = info.roundData && typeof info.roundData === 'object' && !Array.isArray(info.roundData)
    ? info.roundData
    : null;
  if (info.roundData) {
    info.roundData.stage = Math.max(1, toSafeInt(info.roundData.stage, Math.max(1, info.stage)));
    info.roundData.lifeCost = Math.max(0, toSafeInt(info.roundData.lifeCost, 0));
    info.roundData.shopLevel = Math.max(1, toSafeInt(info.roundData.shopLevel, 1));
    info.roundData.shopExp = Math.max(0, toSafeInt(info.roundData.shopExp, 0));
    info.roundData.shopLock = info.roundData.shopLock ? 1 : 0;
    info.roundData.shopItems = ensureArray(info.roundData.shopItems);
    if (info.roundData.shopItems.length <= 0) {
      info.roundData.shopItems = buildShopItems(info.roundData.stage);
    }
    ensureRoundPack(info.roundData);
    info.roundData.enemyInfos = ensureObject(info.roundData.enemyInfos);
    info.roundData.cachedEnemy = info.roundData.cachedEnemy == null ? null : ensureObject(info.roundData.cachedEnemy);
    info.roundData.fightSeed = Math.max(0, toSafeInt(info.roundData.fightSeed, 0));
    info.roundData.deck = normalizeDeck(info.roundData.deck);
  }

  info.topRankList = ensureArray(info.topRankList);
  info.logRecords = ensureArray(info.logRecords);
  return info;
}

function buildTopRankList(player, info) {
  const selfId = String(player && player.playerId ? player.playerId : '');
  const rows = [
    {
      dbid: selfId,
      name: player && player.name ? player.name : 'player',
      avatar: Math.max(0, toSafeInt(player && player.avatar, 11305)),
      score: Math.max(0, toSafeInt(info.score, 0)),
    },
  ];
  for (let i = 1; i <= 9; i++) {
    rows.push({
      dbid: `tf_rank_${i}`,
      name: `巅峰斗士${i}`,
      avatar: 11300 + (i % 8),
      score: Math.max(0, toSafeInt(info.score, 0) + 300 - i * 20),
    });
  }
  rows.sort((a, b) => b.score - a.score);
  rows.forEach((row, idx) => {
    row.rank = idx + 1;
  });
  return rows;
}

async function handleTeamFightDeckIndex(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6100, msgUid, data: { result: -1, deck: [] } };

  const info = ensureTeamFightInfo(player);
  const index = Math.max(1, toSafeInt(params && params.index, 1));
  const deck = normalizeDeck(params && params.deck);
  info.deckMap[String(index)] = deck;

  await playerService.savePlayer(session.userId, player);
  return { tag: 6100, msgUid, data: { result: 0, deck } };
}

async function handleTeamFightStartRound(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6101, msgUid, data: { result: -1, roundData: null } };

  const info = ensureTeamFightInfo(player);
  const deck = normalizeDeck(params && params.deck);
  info.roundData = createRoundData(info, deck);
  if (params && params.multi) {
    info.roundData.shopExp += 10;
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6101,
    msgUid,
    data: {
      result: 0,
      roundData: info.roundData,
    },
  };
}

async function handleTeamFightStartBattle(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6102, msgUid, data: { result: -1, enemyData: {} } };

  const info = ensureTeamFightInfo(player);
  if (!info.roundData) info.roundData = createRoundData(info, info.deckMap['1'] || []);
  const stage = Math.max(1, toSafeInt(params && params.stage, info.roundData.stage || 1));
  const enemyData = buildEnemyData(player, stage);
  info.roundData.cachedEnemy = enemyData;
  info.roundData.fightSeed = Date.now() % 1000000;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6102,
    msgUid,
    data: {
      result: 0,
      enemyData,
    },
  };
}

async function handleTeamFightRoundEnd(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6103, msgUid, data: { result: -1, roundData: null, rewardInfo: buildRewardInfo([]) } };

  const info = ensureTeamFightInfo(player);
  if (!info.roundData) info.roundData = createRoundData(info, info.deckMap['1'] || []);
  const currentStage = Math.max(1, toSafeInt(info.roundData.stage, 1));
  const passStage = Math.max(currentStage, toSafeInt(params && params.stage, currentStage));
  info.roundData.stage = passStage + 1;
  info.stage = Math.max(info.stage, passStage);

  info.roundData.shopExp += 20;
  while (info.roundData.shopExp >= 100) {
    info.roundData.shopExp -= 100;
    info.roundData.shopLevel += 1;
  }
  info.roundData.shopItems = buildShopItems(info.roundData.stage);

  const rewards = grantRewards(player, [
    { id: 170, count: 2 + Math.max(0, Math.floor(passStage / 2)) },
    { id: 171, count: 1 },
  ]);
  info.score += 15 + passStage;
  info.maxScore = Math.max(info.maxScore, info.score);

  const record = {
    time: Date.now(),
    stage: passStage,
    targetId: params && params.targetId != null ? String(params.targetId) : '',
    score: info.score,
    lifeCost: Math.max(0, toSafeInt(info.roundData.lifeCost, 0)),
    win: 1,
  };
  info.logRecords.push(record);
  if (info.logRecords.length > 80) {
    info.logRecords = info.logRecords.slice(info.logRecords.length - 80);
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6103,
    msgUid,
    data: {
      result: 0,
      roundData: info.roundData,
      rewardInfo: buildRewardInfo(rewards),
    },
  };
}

async function handleTeamFightEarlyEnd(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6104, msgUid, data: { result: -1, rank: 9999, record: { score: 0, lifeCost: 0, stage: 0 } } };

  const info = ensureTeamFightInfo(player);
  const roundData = info.roundData || createRoundData(info, info.deckMap['1'] || []);
  const rankList = buildTopRankList(player, info);
  const selfRow = rankList.find((row) => row.dbid === String(player.playerId || ''));
  const rank = selfRow ? selfRow.rank : Math.max(1, toSafeInt(info.rank, 9999));
  info.rank = rank;
  const record = {
    dbid: String(player.playerId || ''),
    name: player.name || '',
    score: Math.max(0, toSafeInt(info.score, 0)),
    lifeCost: Math.max(0, toSafeInt(roundData.lifeCost, 0)),
    stage: Math.max(0, toSafeInt(roundData.stage, 0)),
    time: Date.now(),
  };
  info.logRecords.push(record);
  if (info.logRecords.length > 80) {
    info.logRecords = info.logRecords.slice(info.logRecords.length - 80);
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6104,
    msgUid,
    data: {
      result: 0,
      rank,
      record,
    },
  };
}

async function handleTeamFightBattleSeed(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6105, msgUid, data: { result: -1, fightSeed: 0 } };

  const info = ensureTeamFightInfo(player);
  if (!info.roundData) info.roundData = createRoundData(info, normalizeDeck(params && params.elves));
  const stage = Math.max(1, toSafeInt(params && params.stage, info.roundData.stage || 1));
  info.roundData.cachedEnemy = info.roundData.cachedEnemy || buildEnemyData(player, stage);
  info.roundData.fightSeed = Date.now() % 1000000;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6105,
    msgUid,
    data: {
      result: 0,
      fightSeed: info.roundData.fightSeed,
      enemyData: info.roundData.cachedEnemy,
    },
  };
}

async function handleTeamFightBuyItem(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6110, msgUid, data: { result: -1, type: 1, itemData: { id: 0, level: 0 } } };

  const info = ensureTeamFightInfo(player);
  if (!info.roundData) info.roundData = createRoundData(info, info.deckMap['1'] || []);
  const roundData = info.roundData;
  ensureRoundPack(roundData);
  const index = Math.max(0, toSafeInt(params && params.index, 0));
  const shopRow = ensureObject(roundData.shopItems[index], buildShopItemByIndex(index, roundData.stage));
  const type = Math.max(1, Math.min(2, toSafeInt(shopRow.type, 1)));
  const list = roundData.pack[type];
  const exist = list.find((row) => toSafeInt(row && row.id, 0) === toSafeInt(shopRow.id, 0));
  let itemData;
  if (exist) {
    exist.level = Math.max(1, toSafeInt(exist.level, 1) + 1);
    itemData = { ...exist, type };
  } else {
    itemData = {
      id: Math.max(1, toSafeInt(shopRow.id, 1)),
      level: Math.max(1, toSafeInt(shopRow.level, 1)),
      type,
    };
    list.push(itemData);
  }
  roundData.shopItems[index] = null;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6110,
    msgUid,
    data: {
      result: 0,
      type,
      itemData,
    },
  };
}

async function handleTeamFightRefreshShop(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6111, msgUid, data: { result: -1, shopItems: [] } };

  const info = ensureTeamFightInfo(player);
  if (!info.roundData) info.roundData = createRoundData(info, info.deckMap['1'] || []);
  if (!info.roundData.shopLock) {
    info.roundData.shopItems = buildShopItems(info.roundData.stage);
  }

  await playerService.savePlayer(session.userId, player);
  return { tag: 6111, msgUid, data: { result: 0, shopItems: info.roundData.shopItems } };
}

async function handleTeamFightLockChange(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6112, msgUid, data: { result: -1, lock: 0 } };

  const info = ensureTeamFightInfo(player);
  if (!info.roundData) info.roundData = createRoundData(info, info.deckMap['1'] || []);
  info.roundData.shopLock = params && params.lock ? 1 : 0;

  await playerService.savePlayer(session.userId, player);
  return { tag: 6112, msgUid, data: { result: 0, lock: info.roundData.shopLock } };
}

async function handleTeamFightBuyShopExp(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6113, msgUid, data: { result: -1, shopExp: 0, shopLevel: 1 } };

  const info = ensureTeamFightInfo(player);
  if (!info.roundData) info.roundData = createRoundData(info, info.deckMap['1'] || []);
  info.roundData.shopExp += 35;
  while (info.roundData.shopExp >= 100) {
    info.roundData.shopExp -= 100;
    info.roundData.shopLevel += 1;
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6113,
    msgUid,
    data: {
      result: 0,
      shopExp: info.roundData.shopExp,
      shopLevel: info.roundData.shopLevel,
    },
  };
}

async function handleTeamFightSellItem(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6114, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([{ id: 170, count: 0 }]) } };

  const info = ensureTeamFightInfo(player);
  if (!info.roundData) info.roundData = createRoundData(info, info.deckMap['1'] || []);
  const type = Math.max(1, Math.min(2, toSafeInt(params && params.type, 1)));
  const id = Math.max(1, toSafeInt(params && params.id, 1));
  ensureRoundPack(info.roundData);
  info.roundData.pack[type] = info.roundData.pack[type].filter((row) => toSafeInt(row && row.id, 0) !== id);

  const rewards = grantRewards(player, [{ id: 170, count: 1 }]);
  await playerService.savePlayer(session.userId, player);
  return { tag: 6114, msgUid, data: { result: 0, rewardInfo: buildRewardInfo(rewards) } };
}

async function handleTeamFightTopRank(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6115, msgUid, data: { result: -1, rankList: [] } };

  const info = ensureTeamFightInfo(player);
  info.topRankList = buildTopRankList(player, info);
  const self = info.topRankList.find((row) => row.dbid === String(player.playerId || ''));
  if (self) info.rank = self.rank;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6115,
    msgUid,
    data: {
      result: 0,
      rankList: info.topRankList,
    },
  };
}

async function handleTeamFightRankReward(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6116, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };

  const info = ensureTeamFightInfo(player);
  const scoreLevel = Math.max(1, toSafeInt(params && params.scoreLevel, 1));
  if (!info.rankReward.includes(scoreLevel)) info.rankReward.push(scoreLevel);
  info.rankReward.sort((a, b) => a - b);
  const rewards = grantRewards(player, [{ id: 1, count: 20 * scoreLevel }, { id: 2, count: 200 * scoreLevel }]);

  await playerService.savePlayer(session.userId, player);
  return { tag: 6116, msgUid, data: { result: 0, rewardInfo: buildRewardInfo(rewards) } };
}

async function handleTeamFightLogs(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6117, msgUid, data: { result: -1, records: [] } };

  const info = ensureTeamFightInfo(player);
  await playerService.savePlayer(session.userId, player);
  return { tag: 6117, msgUid, data: { result: 0, records: ensureArray(info.logRecords) } };
}

async function handleTeamFightRankDetail(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6118, msgUid, data: { result: -1 } };

  const info = ensureTeamFightInfo(player);
  const playerId = params && params.playerId != null ? String(params.playerId) : String(player.playerId || '');
  const rankList = info.topRankList && info.topRankList.length > 0 ? info.topRankList : buildTopRankList(player, info);
  const found = rankList.find((row) => String(row.dbid) === playerId);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6118,
    msgUid,
    data: {
      result: 0,
      playerId,
      rank: found ? found.rank : info.rank,
      score: found ? found.score : info.score,
      name: found ? found.name : player.name || '',
      avatar: found ? found.avatar : Math.max(0, toSafeInt(player.avatar, 0)),
      deck: normalizeDeck(info.deckMap['1'] || []),
    },
  };
}

module.exports = {
  ensureTeamFightInfo,
  handleTeamFightDeckIndex,
  handleTeamFightStartRound,
  handleTeamFightStartBattle,
  handleTeamFightRoundEnd,
  handleTeamFightEarlyEnd,
  handleTeamFightBattleSeed,
  handleTeamFightBuyItem,
  handleTeamFightRefreshShop,
  handleTeamFightLockChange,
  handleTeamFightBuyShopExp,
  handleTeamFightSellItem,
  handleTeamFightTopRank,
  handleTeamFightRankReward,
  handleTeamFightLogs,
  handleTeamFightRankDetail,
};

