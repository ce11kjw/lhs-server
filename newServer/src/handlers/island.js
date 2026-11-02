/**
 * Island camp handlers.
 * tag: 6302~6333
 */

const playerService = require('../services/PlayerService');
const configService = require('../services/ConfigService');
const runtimeBus = require('../services/RuntimeBus');
const { addRewardToPlayer } = require('./raid');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensurePlainObject(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...fallback };
  }
  return value;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRewards(rows = []) {
  const map = new Map();
  ensureArray(rows).forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    map.set(id, (map.get(id) || 0) + count);
  });
  const rewards = [];
  map.forEach((count, id) => rewards.push({ id, count }));
  rewards.sort((a, b) => a.id - b.id);
  return rewards;
}

function grantRewardItems(player, rows = []) {
  const rewards = normalizeRewards(rows);
  rewards.forEach((row) => addRewardToPlayer(player, row.id, row.count));
  return rewards;
}

function getConfigTable(name) {
  const table = configService.get(name);
  return table && typeof table === 'object' && !Array.isArray(table) ? table : {};
}

function getPlayerItemCount(player, itemId) {
  if (!player || typeof player !== 'object') return 0;
  const id = toSafeInt(itemId, 0);
  const currencies = ensurePlainObject(player.currencies);
  if (id === 1) return Math.max(0, toSafeInt(currencies.diamond, 0));
  if (id === 2) return Math.max(0, toSafeInt(currencies.silver, 0));
  if (id === 6) return Math.max(0, toSafeInt(currencies.gold, 0));
  const items = ensurePlainObject(player.items);
  return Math.max(0, toSafeInt(items[id], 0));
}

function snapshotRewardCounts(player, rewards = []) {
  const snapshot = {};
  normalizeRewards(rewards).forEach((row) => {
    snapshot[row.id] = getPlayerItemCount(player, row.id);
  });
  return snapshot;
}

function withRewardSync(player, beforeSnapshot, response) {
  const changed = [];
  const items = [];
  Object.keys(ensurePlainObject(beforeSnapshot)).forEach((key) => {
    const id = toSafeInt(key, 0);
    if (id <= 0) return;
    const before = Math.max(0, toSafeInt(beforeSnapshot[key], 0));
    const after = getPlayerItemCount(player, id);
    if (after !== before) items.push({ id, count: after - before });
    changed.push({ id, count: after });
  });
  if (items.length <= 0) return response;
  return [
    { tag: 1202, msgUid: 0, data: { result: 0, items: normalizeRewards(items), changed } },
    response,
  ];
}

function buildRpcFailure(tag, msgUid) {
  return { tag, msgUid, data: null };
}

function getIslandTaskRewards(info, player) {
  const table = getConfigTable('IslandTaskRewardConfig');
  const rows = Object.values(table)
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    .map((row) => ({
      score: Math.max(0, toSafeInt(row.score, 0)),
      rewards: normalizeRewards(row.reward),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => a.score - b.score);
  if (rows.length <= 0) return null;

  const currentScore = getPlayerItemCount(player, -28);
  const received = new Set(ensureArray(info.creditRewardRecords).map((score) => Math.max(0, toSafeInt(score, 0))));
  const claimable = rows.filter((row) => row.score <= currentScore && !received.has(row.score));
  if (claimable.length <= 0 || claimable.some((row) => row.rewards.length <= 0)) return [];

  return {
    scores: claimable.map((row) => row.score),
    rewards: normalizeRewards(claimable.flatMap((row) => row.rewards)),
  };
}

function getIslandCampLevelRewards(info) {
  const table = getConfigTable('IslandSupplyShipConfig');
  if (Object.keys(table).length <= 0) return null;

  const level = Math.max(1, toSafeInt(info.campInfo.lv, 1));
  const rewardCount = Math.max(0, toSafeInt(info.campInfo.rewardCount, 0));
  const startLevel = level - rewardCount;
  if (rewardCount <= 0 || startLevel < 0) return [];

  const rewards = [];
  for (let currentLevel = startLevel; currentLevel < level; currentLevel += 1) {
    const row = table[currentLevel] || table[String(currentLevel)];
    const rowRewards = normalizeRewards(row && row.rewards ? [row.rewards] : []);
    if (rowRewards.length <= 0) return null;
    rewards.push(...rowRewards);
  }
  return normalizeRewards(rewards);
}

function buildIslandSummary(player, idx = 0, overrides = {}) {
  const row = ensurePlainObject(overrides);
  return {
    dbid: row.dbid == null ? String((player && player.playerId) || `island_${idx}`) : String(row.dbid),
    name: row.name || (player && player.name) || `群岛玩家${idx + 1}`,
    level: Math.max(1, toSafeInt(row.level, toSafeInt(player && player.level, 1))),
    avatar: Math.max(0, toSafeInt(row.avatar, toSafeInt(player && player.avatar, 11300))),
    avatarFrame: Math.max(-1, toSafeInt(row.avatarFrame, toSafeInt(player && player.avatarFrame, -1))),
    title: Math.max(0, toSafeInt(row.title, toSafeInt(player && player.title, 0))),
    camp: Math.max(1, toSafeInt(row.camp, 1)),
    serverId: Math.max(1, toSafeInt(row.serverId, 1)),
    power: Math.max(100, toSafeInt(row.power, 1000 + Math.max(1, toSafeInt(player && player.level, 1)) * 100)),
    credit: Math.max(0, toSafeInt(row.credit, 0)),
  };
}

function ensureBuildingDetail(info, id) {
  info.buildingInfoMap = ensurePlainObject(info.buildingInfoMap);
  const key = String(Math.max(1, toSafeInt(id, 1001)));
  const row = ensurePlainObject(info.buildingInfoMap[key], {
    id: Math.max(1, toSafeInt(id, 1001)),
    hp: 10000,
    maxHp: 10000,
    state: 1,
    owner: String(info.selfDbid || ''),
    level: 1,
    upgradeTime: 0,
    battleEndTime: 0,
  });
  row.id = Math.max(1, toSafeInt(row.id, Math.max(1, toSafeInt(id, 1001))));
  row.hp = Math.max(0, toSafeInt(row.hp, 10000));
  row.maxHp = Math.max(row.hp, toSafeInt(row.maxHp, row.hp));
  row.state = Math.max(0, toSafeInt(row.state, 1));
  row.level = Math.max(1, toSafeInt(row.level, 1));
  row.owner = row.owner == null ? '' : String(row.owner);
  row.upgradeTime = Math.max(0, toSafeInt(row.upgradeTime, 0));
  row.battleEndTime = Math.max(0, toSafeInt(row.battleEndTime, 0));
  info.buildingInfoMap[key] = row;
  return row;
}

function ensureIslandInfo(player) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (!player || typeof player !== 'object') {
    return {
      stage: 2,
      camp: 1,
      matchId: 1,
      selfDbid: '',
      troops: 100,
      poolValue: 100,
      resumeStartTime: nowSec,
      remainMines: 0,
      homeId: 1001,
      buildingInfoMap: {},
      campInfo: {
        lv: 1,
        exp: 0,
        rewardCount: 0,
        rebornBuild: 1001,
        record: [],
        mines: {},
        targets: [0, 0, 0],
      },
      creditRewardRecords: [],
      chatList: [],
      followInfo: {
        status: 0,
        teamDataCache: null,
        approvalList: [],
        applyListCache: [],
      },
      commandFollowerTimeLimit: {},
      moveHistory: [],
    };
  }

  player.islandInfo = ensurePlainObject(player.islandInfo);
  const info = player.islandInfo;
  info.stage = Math.max(1, toSafeInt(info.stage, 2));
  info.camp = Math.max(1, Math.min(4, toSafeInt(info.camp, 1)));
  info.matchId = Math.max(1, toSafeInt(info.matchId, 1));
  info.cooperationCount = Math.max(0, toSafeInt(info.cooperationCount, 3));
  info.selfDbid = String((player && player.playerId) || info.selfDbid || '');
  info.troops = Math.max(0, toSafeInt(info.troops, 100));
  info.poolValue = Math.max(0, toSafeInt(info.poolValue, 100));
  info.resumeStartTime = Math.max(0, toSafeInt(info.resumeStartTime, nowSec));
  info.remainMines = Math.max(0, toSafeInt(info.remainMines, 0));
  info.homeId = Math.max(1, toSafeInt(info.homeId, 1001));
  info.buildingInfoMap = ensurePlainObject(info.buildingInfoMap);

  info.campInfo = ensurePlainObject(info.campInfo, {
    lv: 1,
    exp: 0,
    rewardCount: 0,
    rebornBuild: info.homeId,
    record: [],
    mines: {},
    targets: [0, 0, 0],
  });
  info.campInfo.lv = Math.max(1, toSafeInt(info.campInfo.lv, 1));
  info.campInfo.exp = Math.max(0, toSafeInt(info.campInfo.exp, 0));
  info.campInfo.rewardCount = Math.max(0, toSafeInt(info.campInfo.rewardCount, 0));
  info.campInfo.rebornBuild = Math.max(1, toSafeInt(info.campInfo.rebornBuild, info.homeId));
  info.campInfo.record = ensureArray(info.campInfo.record);
  info.campInfo.mines = ensurePlainObject(info.campInfo.mines);
  info.campInfo.targets = ensureArray(info.campInfo.targets).slice(0, 3);
  while (info.campInfo.targets.length < 3) info.campInfo.targets.push(0);

  info.creditRewardRecords = ensureArray(info.creditRewardRecords)
    .map((row) => Math.max(0, toSafeInt(row, 0)))
    .filter((row) => row > 0);
  info.chatList = ensureArray(info.chatList);

  info.followInfo = ensurePlainObject(info.followInfo, {
    status: 0,
    teamDataCache: null,
    approvalList: [],
    applyListCache: [],
  });
  info.followInfo.status = Math.max(0, toSafeInt(info.followInfo.status, 0));
  info.followInfo.followerInfoList = ensureArray(info.followInfo.followerInfoList);
  info.followInfo.teamDataCache = info.followInfo.teamDataCache == null
    ? null
    : ensurePlainObject(info.followInfo.teamDataCache);
  info.followInfo.approvalList = ensureArray(info.followInfo.approvalList);
  info.followInfo.applyListCache = ensureArray(info.followInfo.applyListCache);
  info.commandFollowerTimeLimit = ensurePlainObject(info.commandFollowerTimeLimit);
  info.moveHistory = ensureArray(info.moveHistory);

  ensureBuildingDetail(info, info.homeId);
  return info;
}

function buildCampInfoPayload(info) {
  return {
    lv: info.campInfo.lv,
    exp: info.campInfo.exp,
    rewardCount: info.campInfo.rewardCount,
    rebornBuild: info.campInfo.rebornBuild,
    record: ensureArray(info.campInfo.record),
    mines: ensurePlainObject(info.campInfo.mines),
    targets: ensureArray(info.campInfo.targets),
  };
}

function buildCampRankList(player, info) {
  const selfCamp = Math.max(1, toSafeInt(info.camp, 1));
  const rows = [];
  for (let i = 1; i <= 4; i++) {
    rows.push({
      camp: i,
      score: Math.max(100, toSafeInt(info.campInfo.exp, 0) + (5 - i) * 120),
      memberCount: 20 + i,
      leader: i === selfCamp ? String(player.playerId || '') : `island_leader_${i}`,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  rows.forEach((row, idx) => {
    row.rank = idx + 1;
  });
  return rows;
}

function buildIslandPlayerRankList(player, info) {
  const self = buildIslandSummary(player, 0, {
    camp: info.camp,
    credit: info.campInfo.exp,
    power: 1000 + Math.max(1, toSafeInt(player && player.level, 1)) * 100,
  });
  const rows = [self];
  for (let i = 1; i <= 9; i++) {
    rows.push(buildIslandSummary(player, i, {
      dbid: `island_rank_${i}`,
      name: `群岛侠客${i}`,
      camp: ((i + info.camp) % 4) + 1,
      credit: Math.max(0, info.campInfo.exp + 200 - i * 12),
      power: 1200 + i * 80,
      level: Math.max(1, toSafeInt(player.level, 1) + (i % 5) - 2),
    }));
  }
  rows.sort((a, b) => b.credit - a.credit);
  rows.forEach((row, idx) => {
    row.rank = idx + 1;
  });
  return rows;
}

function buildIslandRecord(info, type, extra = {}) {
  const row = {
    time: Math.floor(Date.now() / 1000),
    type: Math.max(0, toSafeInt(type, 0)),
    desc: extra.desc || '',
    rewards: normalizeRewards(extra.rewards),
  };
  info.campInfo.record.push(row);
  if (info.campInfo.record.length > 60) {
    info.campInfo.record = info.campInfo.record.slice(info.campInfo.record.length - 60);
  }
  return row;
}

async function handleIslandMove(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6302, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const path = ensureArray(params && params.path);
  if (path.length > 0) {
    info.moveHistory.push(path[path.length - 1]);
    if (info.moveHistory.length > 30) info.moveHistory = info.moveHistory.slice(info.moveHistory.length - 30);
  }
  const movePlayer = buildIslandMovePlayer(player, info, path);
  info.moveInfo = movePlayer.moveInfo;
  await playerService.savePlayer(session.userId, player);
  broadcastIslandExceptSelf(session, 6301, { movePlayer });
  return {
    tag: 6302,
    msgUid,
    data: {
      result: 0,
      path,
      troops: info.troops,
    },
  };
}

async function handleIslandSpeedUp(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6303, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const nowSec = Math.floor(Date.now() / 1000);
  info.resumeStartTime = nowSec;
  info.poolValue += Math.max(1, toSafeInt(params && params.count, 10));
  const detail = ensureBuildingDetail(info, params && params.id ? params.id : info.homeId);
  detail.upgradeTime = nowSec + 300;
  info.cooperationCount = Math.max(0, info.cooperationCount - 1);

  await playerService.savePlayer(session.userId, player);
  broadcastIslandExceptSelf(session, 638, { detailInfo: detail });
  return [
    { tag: 638, msgUid: 0, data: { detailInfo: detail } },
    { tag: 639, msgUid: 0, data: { count: info.cooperationCount } },
    {
      tag: 6303,
      msgUid,
      data: {
        result: 0,
        buildingInfo: detail,
      },
    },
  ];
}

async function handleIslandBuildDetail(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6304, msgUid, data: { result: -1, detailInfo: {} } };

  const info = ensureIslandInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, info.homeId));
  const detailInfo = ensureBuildingDetail(info, id);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6304,
    msgUid,
    data: {
      result: 0,
      detailInfo,
    },
  };
}

async function handleIslandPlayerRank(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6305, msgUid, data: { result: -1, playerInfos: [] } };

  const info = ensureIslandInfo(player);
  const playerInfos = buildIslandPlayerRankList(player, info);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6305,
    msgUid,
    data: {
      result: 0,
      playerInfos,
      rankInfos: playerInfos,
    },
  };
}

async function handleIslandCampRank(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6306, msgUid, data: { result: -1, campInfos: [] } };

  const info = ensureIslandInfo(player);
  const campInfos = buildCampRankList(player, info);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6306,
    msgUid,
    data: {
      result: 0,
      campInfos,
    },
  };
}

async function handleIslandCampInfo(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6307, msgUid, data: { result: -1, info: {} } };

  const info = ensureIslandInfo(player);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6307,
    msgUid,
    data: {
      result: 0,
      info: buildCampInfoPayload(info),
    },
  };
}

async function handleIslandUseWood(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6308, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const item = Math.max(0, toSafeInt(params && params.item, 0));
  const gain = Math.max(10, item * 5 || 10);
  info.poolValue += gain;
  const record = buildIslandRecord(info, 1, { desc: `使用木材道具${item}` });

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6308,
    msgUid,
    data: {
      result: 0,
      record,
    },
  };
}

async function handleIslandCollectMine(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6309, msgUid, data: { result: -1, rewards: [] } };

  const info = ensureIslandInfo(player);
  const mineConfig = getConfigTable('IslandMineConfig');
  const hasMineConfig = Object.values(mineConfig).some((row) => (
    row && typeof row === 'object' && Math.max(0, toSafeInt(row.produce, 0)) > 0
  ));
  if (!hasMineConfig) {
    return buildRpcFailure(6309, msgUid);
  }

  const totalMine = Object.values(ensurePlainObject(info.campInfo.mines)).reduce((sum, row) => sum + Math.max(0, toSafeInt(row, 0)), 0);
  if (totalMine <= 0) {
    return buildRpcFailure(6309, msgUid);
  }
  const configuredRewards = [{ id: 186, count: totalMine }];
  const beforeSnapshot = snapshotRewardCounts(player, configuredRewards);
  const rewards = grantRewardItems(player, configuredRewards);

  Object.keys(info.campInfo.mines).forEach((key) => {
    info.campInfo.mines[key] = 0;
  });
  buildIslandRecord(info, 2, { desc: '采集矿脉', rewards });

  await playerService.savePlayer(session.userId, player);
  return withRewardSync(player, beforeSnapshot, {
    tag: 6309,
    msgUid,
    data: {
      result: 0,
      rewards,
    },
  });
}

async function handleIslandChooseTarget(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6310, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const index = Math.max(0, Math.min(2, toSafeInt(params && params.index, 0)));
  const target = params && params.target != null ? String(params.target) : '';
  info.campInfo.targets[index] = target;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6310,
    msgUid,
    data: {
      result: 0,
      targets: ensureArray(info.campInfo.targets),
    },
  };
}

async function handleIslandCampExp(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6311, msgUid, data: { result: -1, exp: 0, lv: 1 } };

  const info = ensureIslandInfo(player);
  info.campInfo.exp += 120;
  const nextLv = Math.floor(info.campInfo.exp / 500) + 1;
  if (nextLv > info.campInfo.lv) {
    info.campInfo.rewardCount += nextLv - info.campInfo.lv;
    info.campInfo.lv = nextLv;
  }

  await playerService.savePlayer(session.userId, player);
  const campRanks = buildCampRankList(player, info);
  const rank = Math.max(1, campRanks.findIndex((row) => row.camp === info.camp) + 1);
  return [
    { tag: 6313, msgUid: 0, data: { rank } },
    {
      tag: 6311,
      msgUid,
      data: {
        result: 0,
        exp: info.campInfo.exp,
        lv: info.campInfo.lv,
      },
    },
  ];
}

async function handleIslandCreditReward(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6312, msgUid, data: { result: -1, records: [], rewards: [] } };

  const info = ensureIslandInfo(player);
  const rewardData = getIslandTaskRewards(info, player);
  if (rewardData == null) {
    return buildRpcFailure(6312, msgUid);
  }
  if (!rewardData.rewards || rewardData.rewards.length <= 0) {
    return buildRpcFailure(6312, msgUid);
  }

  info.creditRewardRecords.push(...rewardData.scores);
  info.creditRewardRecords = Array.from(new Set(info.creditRewardRecords.map((score) => Math.max(0, toSafeInt(score, 0)))));
  info.creditRewardRecords.sort((a, b) => a - b);
  const beforeSnapshot = snapshotRewardCounts(player, rewardData.rewards);
  const rewards = grantRewardItems(player, rewardData.rewards);

  await playerService.savePlayer(session.userId, player);
  return withRewardSync(player, beforeSnapshot, {
    tag: 6312,
    msgUid,
    data: {
      result: 0,
      records: ensureArray(info.creditRewardRecords),
      rewards,
    },
  });
}

async function handleIslandUseSupplyBox(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6314, msgUid, data: { result: -1, resumeStartTime: 0, poolValue: 0 } };

  const info = ensureIslandInfo(player);
  const count = Math.max(1, toSafeInt(params && params.count, 1));
  info.poolValue += count * 20;
  info.resumeStartTime = Math.floor(Date.now() / 1000);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6314,
    msgUid,
    data: {
      result: 0,
      resumeStartTime: info.resumeStartTime,
      poolValue: info.poolValue,
    },
  };
}

async function handleIslandChat(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6315, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const content = params && params.content != null ? String(params.content) : '';
  const islandBuildId = Math.max(0, toSafeInt(params && params.islandBuildId, 0));
  const cross = !!(params && params.cross);
  const row = {
    reportId: '',
    content,
    time: Date.now(),
    summary: buildIslandSummary(player, 0, { camp: info.camp }),
    islandBuildId,
    cross,
  };
  info.chatList.push(row);
  if (info.chatList.length > 50) info.chatList = info.chatList.slice(info.chatList.length - 50);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6315,
    msgUid,
    data: {
      result: 0,
      info: row,
      cross,
    },
  };
}

async function handleIslandAtk(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6318, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const targetId = params && params.targetId != null ? String(params.targetId) : '';
  const monsterId = Math.max(0, toSafeInt(params && params.monsterId, 0));
  const shipId = Math.max(1, toSafeInt(params && params.shipId, monsterId || info.homeId));
  const isAuto = Math.max(0, toSafeInt(params && params.isAuto, 0));

  const home = ensureBuildingDetail(info, info.homeId);
  home.battleEndTime = Math.floor(Date.now() / 1000) + 60;
  buildIslandRecord(info, 3, { desc: `进攻目标 ${targetId || monsterId}${isAuto ? ' 自动' : ''}` });

  await playerService.savePlayer(session.userId, player);
  if (targetId && typeof playerService.findByDbidOrPlayerId === 'function') {
    const target = await playerService.findByDbidOrPlayerId(targetId);
    const wsServer = runtimeBus.getWsServer();
    if (target && target.userId && wsServer && typeof wsServer.pushToUser === 'function') {
      wsServer.pushToUser(String(target.userId), 6307, { shipId });
    }
  }
  return {
    tag: 6318,
    msgUid,
    data: {
      result: 0,
      targetId,
      monsterId,
      shipId,
      battleEndTime: home.battleEndTime,
    },
  };
}

async function handleIslandCampLvReward(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6321, msgUid, data: { result: -1, rewards: [] } };

  const info = ensureIslandInfo(player);
  const configuredRewards = getIslandCampLevelRewards(info);
  if (configuredRewards == null) {
    return buildRpcFailure(6321, msgUid);
  }
  if (configuredRewards.length <= 0) {
    return buildRpcFailure(6321, msgUid);
  }

  const beforeSnapshot = snapshotRewardCounts(player, configuredRewards);
  const rewards = grantRewardItems(player, configuredRewards);
  info.campInfo.rewardCount = 0;

  await playerService.savePlayer(session.userId, player);
  return withRewardSync(player, beforeSnapshot, {
    tag: 6321,
    msgUid,
    data: {
      result: 0,
      rewards,
    },
  });
}

async function handleIslandChooseRebornBuild(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6322, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, info.homeId));
  info.campInfo.rebornBuild = id;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6322,
    msgUid,
    data: {
      result: 0,
      id,
    },
  };
}

async function handleIslandUpdateFollowTeamCache(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6323, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const cache = {
    captain: buildIslandSummary(player, 0, { camp: info.camp }),
    followers: ensureArray(info.followInfo.teamDataCache && info.followInfo.teamDataCache.followers),
  };
  info.followInfo.teamDataCache = cache;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6323,
    msgUid,
    data: cache,
  };
}

async function handleIslandReadFollowApproval(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6324, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const playerIds = ensureArray(params && params.playerIds).map((row) => String(row));
  info.followInfo.approvalList = ensureArray(info.followInfo.approvalList).map((row) => {
    const item = ensurePlainObject(row);
    const dbid = String(item.player && item.player.dbid ? item.player.dbid : '');
    if (playerIds.includes(dbid)) {
      item.isRead = 1;
    }
    return item;
  });

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6324,
    msgUid,
    data: { result: 0 },
  };
}

async function handleIslandUpdateApplyList(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6325, msgUid, data: { result: -1, list: [] } };

  const info = ensureIslandInfo(player);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6325,
    msgUid,
    data: {
      result: 0,
      list: ensureArray(info.followInfo.applyListCache),
    },
  };
}

async function handleIslandApplyFollow(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6326, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const targetId = params && params.targetId != null ? String(params.targetId) : '';
  if (targetId && !info.followInfo.applyListCache.find((row) => String(row.playerId || '') === targetId)) {
    info.followInfo.applyListCache.push({ playerId: targetId, time: Date.now() });
  }

  await playerService.savePlayer(session.userId, player);
  if (targetId && typeof playerService.findByDbidOrPlayerId === 'function') {
    const target = await playerService.findByDbidOrPlayerId(targetId);
    const wsServer = runtimeBus.getWsServer();
    if (target && target.userId && wsServer && typeof wsServer.pushToUser === 'function') {
      wsServer.pushToUser(String(target.userId), 6311, {
        newApproval: {
          player: buildIslandSummary(player, 0, { camp: info.camp }),
          isRead: 0,
          time: Date.now(),
        },
      });
    }
  }
  return {
    tag: 6326,
    msgUid,
    data: { result: 0 },
  };
}

async function handleIslandAgreeFollow(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6327, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const targetId = params && params.targetId != null ? String(params.targetId) : '';
  info.followInfo.status = 2;
  info.followInfo.approvalList = ensureArray(info.followInfo.approvalList).filter((row) => {
    const item = ensurePlainObject(row);
    const dbid = String(item.player && item.player.dbid ? item.player.dbid : '');
    return dbid !== targetId;
  });

  await playerService.savePlayer(session.userId, player);
  return [
    {
      tag: 6310,
      msgUid: 0,
      data: { status: info.followInfo.status, followerInfoList: info.followInfo.followerInfoList },
    },
    { tag: 6327, msgUid, data: { result: 1 } },
  ];
}

async function handleIslandEndFollow(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6328, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  info.followInfo.status = 0;
  info.followInfo.teamDataCache = null;

  await playerService.savePlayer(session.userId, player);
  return [
    { tag: 6310, msgUid: 0, data: { status: 0, followerInfoList: [] } },
    { tag: 6328, msgUid, data: { result: 0 } },
  ];
}

async function handleIslandKickFollower(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6329, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const targetId = params && params.targetId != null ? String(params.targetId) : '';
  if (info.followInfo.teamDataCache && Array.isArray(info.followInfo.teamDataCache.followers)) {
    info.followInfo.teamDataCache.followers = info.followInfo.teamDataCache.followers.filter(
      (row) => String(row && row.playerId ? row.playerId : '') !== targetId,
    );
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6329,
    msgUid,
    data: { result: 0 },
  };
}

async function handleIslandCommandFollowerMove(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6331, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const targetId = params && params.targetId != null ? String(params.targetId) : '';
  info.commandFollowerTimeLimit[targetId] = Date.now() + 30 * 1000;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6331,
    msgUid,
    data: { result: 0 },
  };
}

async function handleIslandForceReturn(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6332, msgUid, data: { result: -1, homeId: 1001 } };

  const info = ensureIslandInfo(player);
  info.troops = 0;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6332,
    msgUid,
    data: {
      result: 0,
      homeId: info.homeId,
    },
  };
}

async function handleIslandRemainMines(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6333, msgUid, data: { result: -1, count: 0 } };

  const info = ensureIslandInfo(player);
  const count = Math.max(0, toSafeInt(info.remainMines, 0));
  if (count <= 0) {
    return { tag: 6333, msgUid, data: { result: 1, count: 0 } };
  }

  const configuredRewards = [{ id: 186, count }];
  const beforeSnapshot = snapshotRewardCounts(player, configuredRewards);
  grantRewardItems(player, configuredRewards);
  info.remainMines = 0;
  await playerService.savePlayer(session.userId, player);

  return withRewardSync(player, beforeSnapshot, {
    tag: 6333,
    msgUid,
    data: {
      result: 0,
      count,
    },
  });
}

function buildIslandMovePlayer(player, info, path = []) {
  const nodes = ensureArray(path);
  const last = ensurePlainObject(nodes[nodes.length - 1]);
  return {
    ...buildIslandSummary(player, 0, { camp: info.camp }),
    moveInfo: {
      x: toSafeInt(last.x, toSafeInt(info.moveInfo && info.moveInfo.x, 0)),
      y: toSafeInt(last.y, toSafeInt(info.moveInfo && info.moveInfo.y, 0)),
      speed: Math.max(1, toSafeInt(last.speed, toSafeInt(info.moveInfo && info.moveInfo.speed, 320))),
      path: nodes,
      state: nodes.length > 0 ? 1 : 0,
    },
    troops: Math.max(0, toSafeInt(info.troops, 0)),
  };
}

function broadcastIslandExceptSelf(session, tag, data) {
  const wsServer = runtimeBus.getWsServer();
  if (!wsServer || typeof wsServer.broadcastExceptUser !== 'function') return;
  wsServer.broadcastExceptUser(session.userId, tag, data);
}

module.exports = {
  ensureIslandInfo,
  handleIslandMove,
  handleIslandSpeedUp,
  handleIslandBuildDetail,
  handleIslandPlayerRank,
  handleIslandCampRank,
  handleIslandCampInfo,
  handleIslandUseWood,
  handleIslandCollectMine,
  handleIslandChooseTarget,
  handleIslandCampExp,
  handleIslandCreditReward,
  handleIslandUseSupplyBox,
  handleIslandChat,
  handleIslandAtk,
  handleIslandCampLvReward,
  handleIslandChooseRebornBuild,
  handleIslandUpdateFollowTeamCache,
  handleIslandReadFollowApproval,
  handleIslandUpdateApplyList,
  handleIslandApplyFollow,
  handleIslandAgreeFollow,
  handleIslandEndFollow,
  handleIslandKickFollower,
  handleIslandCommandFollowerMove,
  handleIslandForceReturn,
  handleIslandRemainMines,
};
