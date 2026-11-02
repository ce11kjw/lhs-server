/**
 * Island extra handlers.
 * tag: 6300/6301/6313/6316/6317/6319/6320/6330
 */

const playerService = require('../services/PlayerService');
const configService = require('../services/ConfigService');
const { ensureIslandInfo } = require('./island');

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

function buildMovePlayersPayload(player, info) {
  const selfId = String(player && player.playerId ? player.playerId : '');
  const selfMove = {
    dbid: selfId,
    camp: Math.max(1, toSafeInt(info.camp, 1)),
    moveInfo: {
      x: 0,
      y: 0,
      speed: 320,
      path: [],
      state: 1,
    },
  };
  const npcMove = {
    dbid: 'island_npc_1',
    camp: ((Math.max(1, toSafeInt(info.camp, 1)) + 1) % 4) + 1,
    moveInfo: {
      x: 2,
      y: 1,
      speed: 300,
      path: [],
      state: 1,
    },
  };
  return {
    [selfId]: selfMove,
    [npcMove.dbid]: npcMove,
  };
}

function buildBuildingsPayload(info) {
  const map = ensureObject(info.buildingInfoMap);
  const out = {};
  Object.keys(map).forEach((key) => {
    const row = ensureObject(map[key]);
    const id = Math.max(1, toSafeInt(row.id, toSafeInt(key, 1001)));
    out[String(id)] = {
      id,
      hp: Math.max(0, toSafeInt(row.hp, 10000)),
      maxHp: Math.max(1, toSafeInt(row.maxHp, 10000)),
      state: Math.max(0, toSafeInt(row.state, 1)),
      owner: row.owner == null ? '' : String(row.owner),
      level: Math.max(1, toSafeInt(row.level, 1)),
      battleEndTime: Math.max(0, toSafeInt(row.battleEndTime, 0)),
    };
  });
  if (Object.keys(out).length <= 0) {
    const homeId = Math.max(1, toSafeInt(info.homeId, 1001));
    out[String(homeId)] = {
      id: homeId,
      hp: 10000,
      maxHp: 10000,
      state: 1,
      owner: String(info.selfDbid || ''),
      level: 1,
      battleEndTime: 0,
    };
  }
  return out;
}

function buildIslandInitPayload(info) {
  const matchId = Math.max(1, toSafeInt(info.matchId, 1));
  const openConfig = configService.get('IslandOpenConfig') || {};
  const matchConfig = ensureObject(openConfig[matchId] || openConfig[String(matchId)]);
  const maxTroops = Math.max(1, toSafeInt(info.maxTroops, Math.max(100, toSafeInt(info.troops, 100))));
  const followInfo = ensureObject(info.followInfo);
  return {
    campServerNames: ensureObject(info.campServerNames),
    creditRewardsRecord: ensureArray(info.creditRewardRecords),
    cooperationCount: Math.max(0, toSafeInt(info.cooperationCount, 0)),
    camp: Math.max(1, toSafeInt(info.camp, 1)),
    maxTroops,
    building: Math.max(1, toSafeInt(info.homeId, 1001)),
    moveInfo: info.moveInfo && typeof info.moveInfo === 'object' ? info.moveInfo : null,
    restore: Math.max(0, toSafeInt(info.restore, 0)),
    troops: Math.max(0, toSafeInt(info.troops, 0)),
    resumeStartTime: Math.max(0, toSafeInt(info.resumeStartTime, 0)),
    barracksTroops: Math.max(0, toSafeInt(info.poolValue, 0)),
    startPower: Math.max(0, toSafeInt(info.startPower, maxTroops)),
    round: Math.max(1, toSafeInt(info.round, 1)),
    floor: Math.max(1, toSafeInt(info.floor, 1)),
    result: { winCamp: Math.max(0, toSafeInt(info.winCamp, 0)) },
    matchId,
    remainMines: Math.max(0, toSafeInt(info.remainMines, 0)),
    roomMaxTroops: Math.max(maxTroops, toSafeInt(info.roomMaxTroops, maxTroops)),
    followInfo: {
      status: Math.max(0, toSafeInt(followInfo.status, 0)),
      followerInfoList: ensureArray(followInfo.followerInfoList),
      approvalList: ensureArray(followInfo.approvalList),
      applyListCache: ensureArray(followInfo.applyListCache),
      teamDataCache: followInfo.teamDataCache == null ? null : ensureObject(followInfo.teamDataCache),
      commandFollowerInfo: followInfo.commandFollowerInfo == null ? null : ensureObject(followInfo.commandFollowerInfo),
      commandFollowerTimeLimit: ensureObject(info.commandFollowerTimeLimit),
    },
    stage: Math.max(0, toSafeInt(info.stage, 0)),
    endTime: Math.max(0, toSafeInt(info.endTime, toSafeInt(matchConfig.endTime, 0))),
  };
}

async function handleIslandEnterScene(_params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 6300, msgUid, data: { result: -1, movePlayers: {}, buildings: {}, building: {} } };
  }

  const info = ensureIslandInfo(player);
  const movePlayers = buildMovePlayersPayload(player, info);
  const buildings = buildBuildingsPayload(info);
  const homeId = String(Math.max(1, toSafeInt(info.homeId, 1001)));
  const building = buildings[homeId] || {};

  await playerService.savePlayer(session.userId, player);
  return [
    {
      tag: 6300,
      msgUid: 0,
      data: buildIslandInitPayload(info),
    },
    {
      tag: 6300,
      msgUid,
      data: {
        result: 0,
        movePlayers,
        buildings,
        building,
      },
    },
  ];
}

async function handleIslandLeaveScene(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6301, msgUid, data: { result: -1 } };

  await playerService.savePlayer(session.userId, player);
  return { tag: 6301, msgUid, data: { result: 0 } };
}

async function handleIslandReplenishTroops(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 6313, msgUid, data: { result: -1, resumeStartTime: 0, poolValue: 0, realCount: 0 } };
  }

  const info = ensureIslandInfo(player);
  const requestCount = Math.max(1, toSafeInt(params && params.count, 1));
  const available = Math.max(0, toSafeInt(info.poolValue, 0));
  const realCount = Math.max(0, Math.min(requestCount, available > 0 ? available : requestCount));
  info.troops = Math.max(0, toSafeInt(info.troops, 0) + realCount);
  info.poolValue = Math.max(0, available - realCount);
  info.resumeStartTime = Math.floor(Date.now() / 1000);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6313,
    msgUid,
    data: {
      result: 0,
      resumeStartTime: info.resumeStartTime,
      poolValue: info.poolValue,
      realCount,
    },
  };
}

async function handleIslandPlayerReport(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6316, msgUid, data: { result: -1, reports: [] } };

  const info = ensureIslandInfo(player);
  const reports = ensureArray(info.moveHistory).slice(-20).map((row, idx) => ({
    id: idx + 1,
    time: Math.floor(Date.now() / 1000) - (20 - idx) * 60,
    desc: `玩家移动到坐标(${toSafeInt(row && row.x, 0)},${toSafeInt(row && row.y, 0)})`,
  }));

  await playerService.savePlayer(session.userId, player);
  return { tag: 6316, msgUid, data: { result: 0, reports } };
}

async function handleIslandBuildingReport(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6317, msgUid, data: { result: -1, reports: [] } };

  const info = ensureIslandInfo(player);
  const records = ensureArray(info.campInfo && info.campInfo.record);
  const reports = records.slice(-20).map((row, idx) => ({
    id: idx + 1,
    time: Math.max(0, toSafeInt(row && row.time, 0)),
    type: Math.max(0, toSafeInt(row && row.type, 0)),
    desc: row && row.desc ? String(row.desc) : '建筑状态更新',
  }));

  await playerService.savePlayer(session.userId, player);
  return { tag: 6317, msgUid, data: { result: 0, reports } };
}

async function handleIslandBarracksTroops(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6319, msgUid, data: { result: -1, resumeStartTime: 0, poolValue: 0 } };

  const info = ensureIslandInfo(player);
  const nowSec = Math.floor(Date.now() / 1000);
  const elapsed = Math.max(0, nowSec - Math.max(0, toSafeInt(info.resumeStartTime, nowSec)));
  if (elapsed > 0) {
    info.poolValue = Math.max(0, toSafeInt(info.poolValue, 0) + Math.min(50, Math.floor(elapsed / 10)));
    info.resumeStartTime = nowSec;
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6319,
    msgUid,
    data: {
      result: 0,
      resumeStartTime: info.resumeStartTime,
      poolValue: info.poolValue,
    },
  };
}

async function handleIslandTrackBuilding(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6320, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, info.homeId));
  info.trackBuildingId = id;

  await playerService.savePlayer(session.userId, player);
  return { tag: 6320, msgUid, data: { result: 0 } };
}

async function handleIslandCommandFollower(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6330, msgUid, data: { result: -1 } };

  const info = ensureIslandInfo(player);
  const playerId = params && params.playerId != null ? String(params.playerId) : '';
  const buildId = Math.max(1, toSafeInt(params && params.buildId, info.homeId));
  if (playerId) {
    info.commandFollowerTimeLimit = ensureObject(info.commandFollowerTimeLimit);
    info.commandFollowerTimeLimit[playerId] = Date.now() + 30 * 1000;
  }
  info.lastCommandBuildId = buildId;

  await playerService.savePlayer(session.userId, player);
  return { tag: 6330, msgUid, data: { result: 0 } };
}

module.exports = {
  handleIslandEnterScene,
  handleIslandLeaveScene,
  handleIslandReplenishTroops,
  handleIslandPlayerReport,
  handleIslandBuildingReport,
  handleIslandBarracksTroops,
  handleIslandTrackBuilding,
  handleIslandCommandFollower,
};

