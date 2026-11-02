const playerService = require('../services/PlayerService');
const { addRewardToPlayer } = require('./raid');

const ROOM_STATUS = {
  PREPARE: 0,
  SELECT: 1,
  SHOWSELECT: 2,
  RACING: 3,
  SHOWRESULT: 4,
  SETTLE: 5,
};

const PLAYER_STATUS = {
  NOT_PREPARED: 0,
  PREPARED: 1,
  SELECTED: 2,
};

const STAGE_TYPE = {
  STAGE_OFF: 0,
  STAGE_ON: 1,
  STAGE_RACE_START: 2,
  STAGE_RACE_END: 3,
};

const ROOM_CREATE_TYPE = {
  NORMAL: 0,
  MATCH: 1,
  QUALIFYING: 2,
};

let runtimeRoomSeed = 200000;
const runtimeRooms = new Map();

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueInts(values = []) {
  const out = [];
  const seen = new Set();
  (Array.isArray(values) ? values : []).forEach((value) => {
    const id = toSafeInt(value, 0);
    if (id <= 0 || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

function toDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return Number(`${y}${m}${day}`);
}

function buildRewardInfo(rows = []) {
  return {
    items: (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        id: Math.max(0, toSafeInt(row && row.id, 0)),
        count: Math.max(0, toSafeInt(row && row.count, 0)),
      }))
      .filter((row) => row.id > 0 && row.count > 0),
    equips: [],
    heros: [],
  };
}

function grantRewards(player, rows = []) {
  const merged = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    addRewardToPlayer(player, id, count);
    merged.set(id, (merged.get(id) || 0) + count);
  });
  return buildRewardInfo(
    Array.from(merged.entries()).map(([id, count]) => ({ id, count }))
  );
}

function buildDefaultMatchInfo(now = Date.now()) {
  return {
    matchId: 1,
    stage: STAGE_TYPE.STAGE_ON,
    endTime: now + 5 * 24 * 60 * 60 * 1000,
    pass: 0,
    passRecord: 0,
    keepScore: 0,
    multi: 1,
    grade: 1,
    score: 0,
    maxGrade: 1,
    rewardGrade: 0,
    records: [],
  };
}

function normalizeMatchInfo(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const fallback = buildDefaultMatchInfo();
  const out = {
    matchId: Math.max(1, toSafeInt(src.matchId, fallback.matchId)),
    stage: Math.max(STAGE_TYPE.STAGE_OFF, Math.min(STAGE_TYPE.STAGE_RACE_END, toSafeInt(src.stage, fallback.stage))),
    endTime: Math.max(Date.now() + 60 * 1000, toSafeInt(src.endTime, fallback.endTime)),
    pass: Math.max(0, Math.min(1, toSafeInt(src.pass, fallback.pass))),
    passRecord: Math.max(0, toSafeInt(src.passRecord, fallback.passRecord)),
    keepScore: Math.max(0, toSafeInt(src.keepScore, fallback.keepScore)),
    multi: Math.max(1, toSafeInt(src.multi, fallback.multi)),
    grade: Math.max(1, toSafeInt(src.grade, fallback.grade)),
    score: Math.max(0, toSafeInt(src.score, fallback.score)),
    maxGrade: Math.max(1, toSafeInt(src.maxGrade, fallback.maxGrade)),
    rewardGrade: Math.max(0, toSafeInt(src.rewardGrade, fallback.rewardGrade)),
    records: Array.isArray(src.records) ? src.records : [],
  };

  if (out.rewardGrade > out.grade) out.rewardGrade = out.grade;
  if (out.maxGrade < out.grade) out.maxGrade = out.grade;
  return out;
}

function normalizeHorseRaceInfo(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const info = {
    matchInfo: normalizeMatchInfo(src.matchInfo),
    roomId: Math.max(0, toSafeInt(src.roomId, 0)),
    roomInfo: src.roomInfo && typeof src.roomInfo === 'object' ? src.roomInfo : null,
    roomStatus: src.roomStatus && typeof src.roomStatus === 'object' ? src.roomStatus : null,
    kickBlackList: src.kickBlackList && typeof src.kickBlackList === 'object' ? src.kickBlackList : {},
    globalRoomBanTime: Math.max(0, toSafeInt(src.globalRoomBanTime, 0)),
    doubleCount: Math.max(0, toSafeInt(src.doubleCount, 0)),
    resultRank: Math.max(0, toSafeInt(src.resultRank, 0)),
    playersRankInfo: src.playersRankInfo && typeof src.playersRankInfo === 'object'
      ? src.playersRankInfo
      : { rankList: [], selfInfo: null, updateTime: 0 },
  };

  return info;
}

function ensureHorseRaceInfo(player) {
  player.other_attr_info = player.other_attr_info && typeof player.other_attr_info === 'object' && !Array.isArray(player.other_attr_info)
    ? player.other_attr_info
    : {};
  const holder = player.other_attr_info;
  holder.horseRaceInfo = normalizeHorseRaceInfo(holder.horseRaceInfo);
  return holder.horseRaceInfo;
}

function buildHorseRacePayload(info) {
  const payload = clonePlain(info.matchInfo);
  if (info.roomInfo && typeof info.roomInfo === 'object') {
    payload.roomInfo = clonePlain(info.roomInfo);
  }
  return payload;
}

function buildRoomPlayerData(player, matchInfo, opts = {}) {
  const dbid = player.playerId || '';
  return {
    id: dbid,
    playerId: dbid,
    playerid: dbid,
    dbid,
    name: player.name || 'Player',
    avatar: Math.max(0, toSafeInt(player.avatar, 11305)),
    avatarFrame: Math.max(-1, toSafeInt(player.avatarFrame, -1)),
    avatarUrl: player.avatarUrl || '',
    grade: Math.max(1, toSafeInt(matchInfo.grade, 1)),
    score: Math.max(0, toSafeInt(matchInfo.score, 0)),
    status: Math.max(PLAYER_STATUS.NOT_PREPARED, Math.min(PLAYER_STATUS.SELECTED, toSafeInt(opts.status, PLAYER_STATUS.NOT_PREPARED))),
    isHost: !!opts.isHost,
    isRobot: false,
    token: '',
  };
}

function buildRobotRoomPlayerData(index, matchInfo, opts = {}) {
  const safeIndex = Math.max(1, toSafeInt(index, 1));
  return {
    id: `horse_race_robot_${safeIndex}`,
    playerId: `horse_race_robot_${safeIndex}`,
    playerid: `horse_race_robot_${safeIndex}`,
    dbid: `horse_race_robot_${safeIndex}`,
    name: `灵舟道友${safeIndex}`,
    avatar: 11300 + (safeIndex % 8),
    avatarFrame: -1,
    avatarUrl: '',
    grade: Math.max(1, toSafeInt(matchInfo && matchInfo.grade, 1)),
    score: Math.max(0, toSafeInt(matchInfo && matchInfo.score, 0)),
    status: Math.max(PLAYER_STATUS.NOT_PREPARED, Math.min(PLAYER_STATUS.SELECTED, toSafeInt(opts.status, PLAYER_STATUS.PREPARED))),
    isHost: false,
    isRobot: true,
    token: '',
  };
}

function buildRoomInfoForClient(room) {
  return {
    room: Math.max(1, toSafeInt(room.room, 1)),
    type: Math.max(ROOM_CREATE_TYPE.NORMAL, Math.min(ROOM_CREATE_TYPE.QUALIFYING, toSafeInt(room.type, ROOM_CREATE_TYPE.NORMAL))),
    mode: Math.max(0, toSafeInt(room.mode, 0)),
    multi: Math.max(1, toSafeInt(room.multi, 1)),
    status: Math.max(ROOM_STATUS.PREPARE, Math.min(ROOM_STATUS.SETTLE, toSafeInt(room.status, ROOM_STATUS.PREPARE))),
    createTime: Math.max(0, toSafeInt(room.createTime, Date.now())),
    playerMap: clonePlain(room.playerMap || {}),
    spectators: Array.isArray(room.spectators) ? clonePlain(room.spectators) : [],
  };
}

function allocRoomId() {
  runtimeRoomSeed += 1;
  return runtimeRoomSeed;
}

function getActorId(session) {
  const player = session && session.player ? session.player : {};
  return player.playerId || session.userId || '';
}

function findRoomPlayerIndex(room, actorId) {
  if (!room || !room.playerMap || !actorId) return -1;
  for (const key of Object.keys(room.playerMap)) {
    const idx = toSafeInt(key, -1);
    if (idx < 0) continue;
    if (room.playerMap[idx] && room.playerMap[idx].dbid === actorId) return idx;
  }
  return -1;
}

function getFirstEmptyRoomIndex(room) {
  for (let idx = 0; idx < 4; idx++) {
    if (!room.playerMap[idx]) return idx;
  }
  return -1;
}

function buildRandomHandCards(count = 6) {
  const hand = [];
  const used = new Set();
  let uidSeed = Date.now() % 1000000;
  for (let i = 0; i < Math.max(1, count); i++) {
    uidSeed += 1;
    const value = (Math.floor(Math.random() * 13) + 1);
    if (used.has(uidSeed)) continue;
    used.add(uidSeed);
    hand.push({ uid: uidSeed, value, effect: 0 });
  }
  return hand;
}

function buildRoomResult(room) {
  const rows = [];
  Object.keys(room.playerMap || {}).forEach((key) => {
    const index = toSafeInt(key, -1);
    if (index < 0) return;
    const player = room.playerMap[index];
    if (!player) return;
    rows.push({
      index,
      dbid: player.dbid,
      horseType: toSafeInt((room.horses || {})[index], ((index % 3) + 1)),
      time: 38000 + Math.floor(Math.random() * 24000),
      rank: 0,
    });
  });

  rows.sort((a, b) => a.time - b.time);
  rows.forEach((row, idx) => {
    row.rank = idx + 1;
  });
  return rows;
}

function buildSettleResultForActor(room, actorId, info) {
  const resultRows = Array.isArray(room.result) ? room.result : [];
  const selfRow = resultRows.find((row) => row.dbid === actorId);
  const rank = selfRow ? Math.max(1, toSafeInt(selfRow.rank, 1)) : resultRows.length + 1;
  const addScore = Math.max(20, 60 - rank * 10);
  const keep = Math.max(0, Math.floor(addScore / 2));

  const oldGrade = Math.max(1, toSafeInt(info.matchInfo.grade, 1));
  const nextScore = Math.max(0, toSafeInt(info.matchInfo.score, 0) + addScore);
  const nextGrade = Math.max(oldGrade, oldGrade + (nextScore >= oldGrade * 100 ? 1 : 0));

  info.matchInfo.grade = nextGrade;
  info.matchInfo.score = nextScore;
  info.matchInfo.keepScore = Math.max(0, toSafeInt(info.matchInfo.keepScore, 0) + keep);
  info.matchInfo.maxGrade = Math.max(toSafeInt(info.matchInfo.maxGrade, 1), nextGrade);
  info.resultRank = rank;
  info.matchInfo.records.push({
    grade: nextGrade,
    score: nextScore,
    keep,
    rank,
    time: Date.now(),
  });

  return {
    grade: nextGrade,
    score: nextScore,
    addScore,
    rank,
    record: {
      keep,
      rank,
      time: Date.now(),
      horseType: selfRow ? selfRow.horseType : 1,
    },
  };
}

function removeActorFromRoom(room, actorId) {
  const index = findRoomPlayerIndex(room, actorId);
  if (index < 0) return -1;
  delete room.playerMap[index];
  if (room.horses) delete room.horses[index];
  if (room.selfInfoByActor) delete room.selfInfoByActor[actorId];

  if (room.hostActorId === actorId) {
    room.hostActorId = '';
    const restIndexes = Object.keys(room.playerMap || {})
      .map((k) => toSafeInt(k, -1))
      .filter((k) => k >= 0)
      .sort((a, b) => a - b);
    if (restIndexes.length > 0) {
      const nextHostIdx = restIndexes[0];
      const nextHost = room.playerMap[nextHostIdx];
      if (nextHost) {
        room.hostActorId = nextHost.dbid;
      }
    }
  }

  Object.keys(room.playerMap || {}).forEach((key) => {
    const idx = toSafeInt(key, -1);
    if (idx < 0) return;
    const row = room.playerMap[idx];
    if (!row) return;
    row.isHost = row.dbid === room.hostActorId;
  });

  return index;
}

function hasHumanRoomPlayer(room) {
  return Object.keys((room && room.playerMap) || {}).some((key) => {
    const row = room.playerMap[key];
    return !!row && !row.isRobot;
  });
}

function buildRoomLeavePush(roomId, index, isKick = 0) {
  return {
    tag: 7202,
    msgUid: 0,
    data: {
      room: Math.max(0, toSafeInt(roomId, 0)),
      index: Math.max(0, toSafeInt(index, 0)),
      isKick: isKick ? 1 : 0,
    },
  };
}

function buildSpectatorLeavePush(roomId, playerId, isKick = 0) {
  return {
    tag: 7212,
    msgUid: 0,
    data: {
      room: Math.max(0, toSafeInt(roomId, 0)),
      playerId: String(playerId || ''),
      isKick: isKick ? 1 : 0,
    },
  };
}

function buildRoomReleasePush(roomId) {
  return {
    tag: 7209,
    msgUid: 0,
    data: { room: Math.max(0, toSafeInt(roomId, 0)) },
  };
}

function syncInfoRoomData(info, room, actorId) {
  if (!room) {
    info.roomId = 0;
    info.roomInfo = null;
    info.roomStatus = null;
    return;
  }

  info.roomId = Math.max(1, toSafeInt(room.room, 1));
  info.roomInfo = buildRoomInfoForClient(room);

  if (!room.selfInfoByActor) room.selfInfoByActor = {};
  if (!room.selfInfoByActor[actorId]) {
    room.selfInfoByActor[actorId] = {
      horses: [1, 2, 3],
      handCards: buildRandomHandCards(6),
    };
  }

  info.roomStatus = {
    room: room.room,
    status: room.status,
    time: Math.max(0, toSafeInt(room.statusTime, Date.now())),
    round: Math.max(1, toSafeInt(room.round, 1)),
    selfInfo: clonePlain(room.selfInfoByActor[actorId]),
    horses: clonePlain(room.horses || {}),
    result: clonePlain(room.result || []),
  };
}

function canReceiveVipReward(matchInfo) {
  const record = Math.max(0, toSafeInt(matchInfo.passRecord, 0));
  if (record <= 0) return true;
  const nowKey = toDayKey();
  const recordKey = toDayKey(record);
  return nowKey !== recordKey;
}

async function savePlayer(session) {
  if (!session || !session.userId || !session.player) return;
  await playerService.savePlayer(session.userId, session.player);
}

async function handleHorseRaceCreateRoom(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7200, msgUid, data: { result: -1 } };

  const info = ensureHorseRaceInfo(player);
  const actorId = getActorId(session);
  const createType = Math.max(ROOM_CREATE_TYPE.NORMAL, Math.min(ROOM_CREATE_TYPE.QUALIFYING, toSafeInt(params && params.type, ROOM_CREATE_TYPE.NORMAL)));
  const multi = Math.max(1, toSafeInt(params && params.multi, Math.max(1, toSafeInt(info.matchInfo.multi, 1))));
  info.matchInfo.multi = multi;

  if (info.roomId > 0 && runtimeRooms.has(info.roomId)) {
    const oldRoom = runtimeRooms.get(info.roomId);
    removeActorFromRoom(oldRoom, actorId);
    if (Object.keys(oldRoom.playerMap || {}).length === 0) {
      runtimeRooms.delete(oldRoom.room);
    }
  }

  const roomId = allocRoomId();
  const room = {
    room: roomId,
    type: createType,
    multi,
    status: ROOM_STATUS.PREPARE,
    mode: Math.max(0, toSafeInt(params && params.mode, 0)),
    round: 1,
    createTime: Date.now(),
    statusTime: Date.now(),
    hostActorId: actorId,
    playerMap: {
      0: buildRoomPlayerData(player, info.matchInfo, {
        status: PLAYER_STATUS.NOT_PREPARED,
        isHost: true,
      }),
    },
    horses: {},
    result: [],
    spectators: [],
    selfInfoByActor: {},
  };
  if (createType === ROOM_CREATE_TYPE.QUALIFYING) {
    for (let idx = 1; idx < 4; idx++) {
      room.playerMap[idx] = buildRobotRoomPlayerData(idx, info.matchInfo, {
        status: PLAYER_STATUS.PREPARED,
      });
    }
  }
  room.selfInfoByActor[actorId] = {
    horses: [1, 2, 3],
    handCards: buildRandomHandCards(6),
  };
  runtimeRooms.set(roomId, room);

  syncInfoRoomData(info, room, actorId);
  info.matchInfo.roomInfo = buildRoomInfoForClient(room);

  await savePlayer(session);
  return {
    tag: 7200,
    msgUid,
    data: {
      result: 0,
      roomInfo: buildRoomInfoForClient(room),
    },
  };
}

async function handleHorseRaceEnterRoom(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7201, msgUid, data: { result: -1 } };

  const info = ensureHorseRaceInfo(player);
  const actorId = getActorId(session);
  const roomId = Math.max(1, toSafeInt(params && params.room, 0));
  const now = Date.now();

  if (info.globalRoomBanTime > now) {
    return { tag: 7201, msgUid, data: { result: 1 } };
  }

  const banUntil = Math.max(0, toSafeInt(info.kickBlackList[String(roomId)], 0));
  if (banUntil > now) {
    return { tag: 7201, msgUid, data: { result: 3 } };
  }

  const room = runtimeRooms.get(roomId);
  if (!room) {
    return { tag: 7201, msgUid, data: { result: 1 } };
  }

  let index = findRoomPlayerIndex(room, actorId);
  if (index < 0) {
    index = getFirstEmptyRoomIndex(room);
    if (index < 0) return { tag: 7201, msgUid, data: { result: 2 } };
    room.playerMap[index] = buildRoomPlayerData(player, info.matchInfo, {
      status: PLAYER_STATUS.NOT_PREPARED,
      isHost: false,
    });
  }

  syncInfoRoomData(info, room, actorId);
  info.matchInfo.roomInfo = buildRoomInfoForClient(room);
  await savePlayer(session);

  return {
    tag: 7201,
    msgUid,
    data: {
      result: 0,
      dbid: actorId,
      roomInfo: buildRoomInfoForClient(room),
    },
  };
}

async function handleHorseRaceLeaveRoom(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7202, msgUid, data: { result: -1 } };

  const info = ensureHorseRaceInfo(player);
  const actorId = getActorId(session);
  const roomId = Math.max(0, toSafeInt(info.roomId, 0));
  const room = roomId > 0 ? runtimeRooms.get(roomId) : null;
  const pushPackets = [];

  if (room) {
    const index = findRoomPlayerIndex(room, actorId);
    if (index >= 0) {
      removeActorFromRoom(room, actorId);
      pushPackets.push(buildRoomLeavePush(room.room, index, 0));
    } else {
      const spectatorIndex = Array.isArray(room.spectators)
        ? room.spectators.findIndex((row) => row && row.dbid === actorId)
        : -1;
      if (spectatorIndex >= 0) {
        room.spectators.splice(spectatorIndex, 1);
        pushPackets.push(buildSpectatorLeavePush(room.room, actorId, 0));
      }
    }
    // Robots do not keep a room alive after its last real participant leaves.
    if (!hasHumanRoomPlayer(room) && (!Array.isArray(room.spectators) || room.spectators.length === 0)) {
      pushPackets.push(buildRoomReleasePush(room.room));
      runtimeRooms.delete(room.room);
    }
  }

  syncInfoRoomData(info, null, actorId);
  delete info.matchInfo.roomInfo;
  await savePlayer(session);

  const response = { tag: 7202, msgUid, data: { result: 0 } };
  return pushPackets.length > 0 ? [...pushPackets, response] : response;
}

async function handleHorseRacePrepare(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7203, msgUid, data: { result: -1 } };

  const info = ensureHorseRaceInfo(player);
  const actorId = getActorId(session);
  const room = runtimeRooms.get(Math.max(0, toSafeInt(info.roomId, 0)));
  if (!room) return { tag: 7203, msgUid, data: { result: -1 } };

  const index = findRoomPlayerIndex(room, actorId);
  if (index < 0 || !room.playerMap[index]) return { tag: 7203, msgUid, data: { result: -1 } };

  const prepare = Math.max(PLAYER_STATUS.NOT_PREPARED, Math.min(PLAYER_STATUS.SELECTED, toSafeInt(params && params.prepare, PLAYER_STATUS.NOT_PREPARED)));
  room.playerMap[index].status = prepare;
  room.statusTime = Date.now();

  if (room.playerMap[index].isHost && prepare === PLAYER_STATUS.PREPARED) {
    const rows = Object.keys(room.playerMap || {}).map((key) => room.playerMap[key]).filter(Boolean);
    const allReady = rows.length > 1 && rows.every((row) => row.isHost || row.status === PLAYER_STATUS.PREPARED);
    if (allReady) {
      room.status = ROOM_STATUS.SELECT;
      room.round = Math.max(1, toSafeInt(room.round, 1));
      room.horses = {};
      room.result = [];
      room.statusTime = Date.now();
    }
  }

  syncInfoRoomData(info, room, actorId);
  await savePlayer(session);

  return {
    tag: 7203,
    msgUid,
    data: {
      result: 0,
      room: room.room,
      index,
      status: room.playerMap[index].status,
      isHost: room.playerMap[index].isHost ? 1 : 0,
    },
  };
}

async function handleHorseRaceSelect(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7204, msgUid, data: { result: -1 } };

  const info = ensureHorseRaceInfo(player);
  const actorId = getActorId(session);
  const room = runtimeRooms.get(Math.max(0, toSafeInt(info.roomId, 0)));
  if (!room) return { tag: 7204, msgUid, data: { result: -1 } };

  const index = findRoomPlayerIndex(room, actorId);
  if (index < 0 || !room.playerMap[index]) return { tag: 7204, msgUid, data: { result: -1 } };

  const type = Math.max(1, Math.min(3, toSafeInt(params && params.type, 1)));
  room.horses[index] = type;
  room.playerMap[index].status = PLAYER_STATUS.SELECTED;
  room.statusTime = Date.now();

  const rows = Object.keys(room.playerMap || {}).map((key) => room.playerMap[key]).filter(Boolean);
  const allSelected = rows.length > 0 && rows.every((row) => row.status === PLAYER_STATUS.SELECTED);
  if (allSelected) {
    room.status = ROOM_STATUS.SHOWSELECT;
  }

  syncInfoRoomData(info, room, actorId);
  await savePlayer(session);

  return {
    tag: 7204,
    msgUid,
    data: {
      result: 0,
      type,
      room: room.room,
      horses: clonePlain(room.horses),
    },
  };
}

async function handleHorseRaceKick(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7205, msgUid, data: { result: -1 } };

  const info = ensureHorseRaceInfo(player);
  const actorId = getActorId(session);
  const room = runtimeRooms.get(Math.max(0, toSafeInt(info.roomId, 0)));
  if (!room) return { tag: 7205, msgUid, data: { result: -1 } };

  const selfIndex = findRoomPlayerIndex(room, actorId);
  if (selfIndex < 0 || !room.playerMap[selfIndex] || !room.playerMap[selfIndex].isHost) {
    return { tag: 7205, msgUid, data: { result: -1 } };
  }

  const requestedPlayerId = params && params.playerId != null ? String(params.playerId) : '';
  const requestedIndex = toSafeInt(params && params.index, -1);
  const targetIndex = requestedPlayerId
    ? findRoomPlayerIndex(room, requestedPlayerId)
    : requestedIndex;
  const pushPackets = [];
  if (targetIndex >= 0 && room.playerMap[targetIndex]) {
    const target = room.playerMap[targetIndex];
    delete room.playerMap[targetIndex];
    delete room.horses[targetIndex];
    room.statusTime = Date.now();
    if (target && target.dbid) {
      // In single-node playtest this provides a short re-enter cooldown.
      info.kickBlackList[String(room.room)] = Date.now() + 30 * 1000;
    }
    pushPackets.push(buildRoomLeavePush(room.room, targetIndex, 1));
  } else if (requestedPlayerId && Array.isArray(room.spectators)) {
    const spectatorIndex = room.spectators.findIndex((row) => row && row.dbid === requestedPlayerId);
    if (spectatorIndex >= 0) {
      room.spectators.splice(spectatorIndex, 1);
      pushPackets.push(buildSpectatorLeavePush(room.room, requestedPlayerId, 1));
    }
  }

  syncInfoRoomData(info, room, actorId);
  await savePlayer(session);
  const response = { tag: 7205, msgUid, data: { result: 0 } };
  return pushPackets.length > 0 ? [...pushPackets, response] : response;
}

async function handleHorseRacePlayCard(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7206, msgUid, data: { result: -1 } };

  const info = ensureHorseRaceInfo(player);
  const actorId = getActorId(session);
  const room = runtimeRooms.get(Math.max(0, toSafeInt(info.roomId, 0)));
  if (!room) return { tag: 7206, msgUid, data: { result: -1 } };

  if (!room.selfInfoByActor) room.selfInfoByActor = {};
  if (!room.selfInfoByActor[actorId]) {
    room.selfInfoByActor[actorId] = {
      horses: [1, 2, 3],
      handCards: buildRandomHandCards(6),
    };
  }

  const uids = uniqueInts(Array.isArray(params && params.uids) ? params.uids : []);
  const hand = Array.isArray(room.selfInfoByActor[actorId].handCards)
    ? room.selfInfoByActor[actorId].handCards
    : [];
  room.selfInfoByActor[actorId].handCards = hand.filter((card) => !uids.includes(toSafeInt(card && card.uid, 0)));

  room.status = ROOM_STATUS.SHOWRESULT;
  room.statusTime = Date.now();
  room.result = buildRoomResult(room);
  room.playerStatus = {
    lastPlayUids: uids,
    leftCards: room.selfInfoByActor[actorId].handCards.length,
  };

  syncInfoRoomData(info, room, actorId);
  await savePlayer(session);
  return { tag: 7206, msgUid, data: { result: 0 } };
}

async function handleHorseRaceDouble(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7207, msgUid, data: { result: -1, count: 0 } };

  const info = ensureHorseRaceInfo(player);
  const count = Math.max(0, toSafeInt(params && params.count, 0));
  info.doubleCount = count;
  await savePlayer(session);
  return { tag: 7207, msgUid, data: { result: 0, count } };
}

async function handleHorseRaceProtect(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7208, msgUid, data: { result: -1, count: 0, addScore: 0 } };

  const info = ensureHorseRaceInfo(player);
  const count = Math.max(0, toSafeInt(params && params.count, 0));
  const addScore = count * 20;
  info.matchInfo.score = Math.max(0, toSafeInt(info.matchInfo.score, 0) + addScore);
  if (info.matchInfo.score > info.matchInfo.grade * 100) {
    info.matchInfo.grade += 1;
    info.matchInfo.maxGrade = Math.max(info.matchInfo.maxGrade, info.matchInfo.grade);
  }

  await savePlayer(session);
  return { tag: 7208, msgUid, data: { result: 0, count, addScore } };
}

async function handleHorseRaceGetVIPDailyReward(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7210, msgUid, data: { result: -1, passRecord: 0, rewardInfo: buildRewardInfo([]) } };

  const info = ensureHorseRaceInfo(player);
  let rewardInfo = buildRewardInfo([]);
  if (info.matchInfo.pass === 1 && canReceiveVipReward(info.matchInfo)) {
    info.matchInfo.passRecord = Date.now();
    rewardInfo = grantRewards(player, [{ id: 1, count: 20 }, { id: 2, count: 1000 }]);
  }

  await savePlayer(session);
  return {
    tag: 7210,
    msgUid,
    data: {
      result: 0,
      passRecord: Math.max(0, toSafeInt(info.matchInfo.passRecord, 0)),
      rewardInfo,
    },
  };
}

async function handleHorseRaceGetGradeReward(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7211, msgUid, data: { result: -1, rewardGrade: 0, rewardInfo: buildRewardInfo([]) } };

  const info = ensureHorseRaceInfo(player);
  const curGrade = Math.max(1, toSafeInt(info.matchInfo.grade, 1));
  const rewardedGrade = Math.max(0, toSafeInt(info.matchInfo.rewardGrade, 0));
  const delta = Math.max(0, curGrade - rewardedGrade);
  const rewardInfo = delta > 0
    ? grantRewards(player, [{ id: 1, count: delta * 10 }, { id: 2, count: delta * 500 }])
    : buildRewardInfo([]);
  info.matchInfo.rewardGrade = curGrade;

  await savePlayer(session);
  return {
    tag: 7211,
    msgUid,
    data: {
      result: 0,
      rewardGrade: info.matchInfo.rewardGrade,
      rewardInfo,
    },
  };
}

async function handleHorseRaceGetPlayersRankInfo(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7212, msgUid, data: { result: -1, rankList: [], selfInfo: null, updateTime: 0 } };

  const info = ensureHorseRaceInfo(player);
  const actorId = getActorId(session);

  const rankList = [
    {
      id: 'bot_race_1',
      rank: 1,
      dbid: 'bot_race_1',
      name: 'RacerA',
      grade: Math.max(1, toSafeInt(info.matchInfo.grade, 1) + 2),
      score: Math.max(0, toSafeInt(info.matchInfo.score, 0) + 180),
    },
    {
      id: 'bot_race_2',
      rank: 2,
      dbid: 'bot_race_2',
      name: 'RacerB',
      grade: Math.max(1, toSafeInt(info.matchInfo.grade, 1) + 1),
      score: Math.max(0, toSafeInt(info.matchInfo.score, 0) + 90),
    },
    {
      id: actorId,
      rank: 3,
      dbid: actorId,
      name: player.name || 'Player',
      grade: Math.max(1, toSafeInt(info.matchInfo.grade, 1)),
      score: Math.max(0, toSafeInt(info.matchInfo.score, 0)),
    },
  ];

  const selfInfo = rankList.find((row) => row.dbid === actorId) || null;
  info.playersRankInfo = {
    rankList,
    selfInfo,
    updateTime: Date.now(),
  };

  await savePlayer(session);
  return {
    tag: 7212,
    msgUid,
    data: {
      result: 0,
      rankList: clonePlain(rankList),
      selfInfo: clonePlain(selfInfo),
      updateTime: info.playersRankInfo.updateTime,
    },
  };
}

async function handleHorseRaceShare(_params, _session, msgUid) {
  return { tag: 7213, msgUid, data: { result: 0 } };
}

async function handleHorseRaceEmoji(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7214, msgUid, data: { result: -1 } };

  const info = ensureHorseRaceInfo(player);
  const actorId = getActorId(session);
  const room = runtimeRooms.get(Math.max(0, toSafeInt(info.roomId, 0)));
  const index = room ? findRoomPlayerIndex(room, actorId) : -1;
  const emoji = Math.max(0, toSafeInt(params && params.emoji, 0));

  return {
    tag: 7214,
    msgUid,
    data: {
      result: 0,
      index: Math.max(0, index),
      emoji,
    },
  };
}

async function handleHorseRaceRoomStatus(_params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 7215,
      msgUid,
      data: {
        status: ROOM_STATUS.SETTLE,
        time: 0,
        round: 0,
        selfInfo: { horses: [1, 2, 3], handCards: [] },
        horses: {},
        result: [],
        playerStatus: {},
      },
    };
  }

  const info = ensureHorseRaceInfo(player);
  const actorId = getActorId(session);
  const room = runtimeRooms.get(Math.max(0, toSafeInt(info.roomId, 0)));

  if (!room) {
    return {
      tag: 7215,
      msgUid,
      data: {
        status: ROOM_STATUS.SETTLE,
        time: Date.now(),
        round: Math.max(1, toSafeInt(info.roomStatus && info.roomStatus.round, 1)),
        selfInfo: { horses: [1, 2, 3], handCards: [] },
        horses: {},
        result: [],
        playerStatus: {},
      },
    };
  }

  if (!room.selfInfoByActor) room.selfInfoByActor = {};
  if (!room.selfInfoByActor[actorId]) {
    room.selfInfoByActor[actorId] = {
      horses: [1, 2, 3],
      handCards: buildRandomHandCards(6),
    };
  }

  if (room.status === ROOM_STATUS.SHOWSELECT && Date.now() - Math.max(0, toSafeInt(room.statusTime, 0)) > 300) {
    room.status = ROOM_STATUS.RACING;
    room.statusTime = Date.now();
  }

  if (room.status === ROOM_STATUS.SHOWRESULT) {
    const settleResult = buildSettleResultForActor(room, actorId, info);
    room.settleResultByActor = room.settleResultByActor || {};
    room.settleResultByActor[actorId] = settleResult;
    room.status = ROOM_STATUS.SETTLE;
    room.statusTime = Date.now();
  }

  syncInfoRoomData(info, room, actorId);
  const playerStatus = {};
  Object.keys(room.playerMap || {}).forEach((key) => {
    const idx = toSafeInt(key, -1);
    if (idx < 0) return;
    const row = room.playerMap[idx];
    if (!row) return;
    playerStatus[idx] = {
      index: idx,
      status: Math.max(PLAYER_STATUS.NOT_PREPARED, Math.min(PLAYER_STATUS.SELECTED, toSafeInt(row.status, PLAYER_STATUS.NOT_PREPARED))),
      horse: Math.max(1, toSafeInt((room.horses || {})[idx], (idx % 3) + 1)),
      speed: 0,
      distance: 0,
    };
  });

  await savePlayer(session);
  return {
    tag: 7215,
    msgUid,
    data: {
      status: room.status,
      time: Math.max(0, toSafeInt(room.statusTime, Date.now())),
      round: Math.max(1, toSafeInt(room.round, 1)),
      selfInfo: clonePlain(room.selfInfoByActor[actorId]),
      horses: clonePlain(room.horses || {}),
      result: clonePlain(room.result || []),
      playerStatus,
    },
  };
}

async function handleHorseRaceGetIMID(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7216, msgUid, data: { result: -1, imid: '' } };
  const actorId = getActorId(session);
  return {
    tag: 7216,
    msgUid,
    data: {
      result: 0,
      imid: `mock-im-${actorId || 'guest'}`,
    },
  };
}

async function handleHorseRaceSwitchMode(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7217, msgUid, data: { result: -1, mode: 0 } };

  const info = ensureHorseRaceInfo(player);
  const actorId = getActorId(session);
  const room = runtimeRooms.get(Math.max(0, toSafeInt(info.roomId, 0)));
  if (!room) return { tag: 7217, msgUid, data: { result: -1, mode: 0 } };

  const index = findRoomPlayerIndex(room, actorId);
  if (index < 0 || !room.playerMap[index] || !room.playerMap[index].isHost) {
    return { tag: 7217, msgUid, data: { result: -1, mode: Math.max(0, toSafeInt(room.mode, 0)) } };
  }

  room.mode = Math.max(0, toSafeInt(params && params.mode, 0));
  syncInfoRoomData(info, room, actorId);
  await savePlayer(session);
  return { tag: 7217, msgUid, data: { result: 0, mode: room.mode } };
}

async function handleHorseRaceSwitchSeat(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7220, msgUid, data: { result: -1, index: -1, roomPlayer: null } };

  const info = ensureHorseRaceInfo(player);
  const actorId = getActorId(session);
  const room = runtimeRooms.get(Math.max(0, toSafeInt(info.roomId, 0)));
  if (!room) return { tag: 7220, msgUid, data: { result: -1, index: -1, roomPlayer: null } };

  const oldIndex = findRoomPlayerIndex(room, actorId);
  let roomPlayer = oldIndex >= 0 ? room.playerMap[oldIndex] : buildRoomPlayerData(player, info.matchInfo, { isHost: false });
  const pushPackets = [];
  const oldSpectatorIndex = Array.isArray(room.spectators)
    ? room.spectators.findIndex((row) => row && row.dbid === actorId)
    : -1;
  if (oldIndex >= 0) delete room.playerMap[oldIndex];
  room.spectators = (Array.isArray(room.spectators) ? room.spectators : []).filter((row) => row && row.dbid !== actorId);
  if (oldSpectatorIndex >= 0 && oldIndex < 0) {
    pushPackets.push(buildSpectatorLeavePush(room.room, actorId, 0));
  }

  const seat = Math.max(-1, toSafeInt(params && params.seat, -1));
  let index = seat;
  if (seat >= 0) {
    index = Math.max(0, Math.min(3, seat));
    if (room.playerMap[index]) {
      room.spectators.push(room.playerMap[index]);
    }
    roomPlayer = { ...roomPlayer, status: PLAYER_STATUS.NOT_PREPARED, isHost: 0 };
    room.playerMap[index] = roomPlayer;
  } else {
    index = -1;
    room.spectators.push(roomPlayer);
  }

  room.statusTime = Date.now();
  syncInfoRoomData(info, room, actorId);
  await savePlayer(session);
  const response = { tag: 7220, msgUid, data: { result: 0, room: room.room, index, roomPlayer: clonePlain(roomPlayer) } };
  return pushPackets.length > 0 ? [...pushPackets, response] : response;
}

async function handleHorseRaceBulletChat(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7221, msgUid, data: { result: -1 } };
  const info = ensureHorseRaceInfo(player);
  info.lastBulletChat = {
    index: Math.max(0, toSafeInt(params && params.index, 0)),
    id: Math.max(0, toSafeInt(params && params.id, 0)),
    time: Date.now(),
  };
  await savePlayer(session);
  return { tag: 7221, msgUid, data: { result: 0, ...info.lastBulletChat } };
}

async function handleHorseRaceSpectateSwitch(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7222, msgUid, data: { result: -1, index: 0 } };
  const info = ensureHorseRaceInfo(player);
  info.watchingIndex = Math.max(0, toSafeInt(params && params.index, 0));
  await savePlayer(session);
  return { tag: 7222, msgUid, data: { result: 0, index: info.watchingIndex } };
}

function __resetHorseRaceRuntime() {
  runtimeRoomSeed = 200000;
  runtimeRooms.clear();
}

module.exports = {
  ROOM_STATUS,
  PLAYER_STATUS,
  STAGE_TYPE,
  ROOM_CREATE_TYPE,
  ensureHorseRaceInfo,
  buildHorseRacePayload,
  handleHorseRaceCreateRoom,
  handleHorseRaceEnterRoom,
  handleHorseRaceLeaveRoom,
  handleHorseRacePrepare,
  handleHorseRaceSelect,
  handleHorseRaceKick,
  handleHorseRacePlayCard,
  handleHorseRaceDouble,
  handleHorseRaceProtect,
  handleHorseRaceGetVIPDailyReward,
  handleHorseRaceGetGradeReward,
  handleHorseRaceGetPlayersRankInfo,
  handleHorseRaceShare,
  handleHorseRaceEmoji,
  handleHorseRaceRoomStatus,
  handleHorseRaceGetIMID,
  handleHorseRaceSwitchMode,
  handleHorseRaceSwitchSeat,
  handleHorseRaceBulletChat,
  handleHorseRaceSpectateSwitch,
  buildRoomLeavePush,
  buildSpectatorLeavePush,
  buildRoomReleasePush,
  __resetHorseRaceRuntime,
};
