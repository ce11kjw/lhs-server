/**
 * Dungeon (secret realm) handlers
 * tag: 4800 floor rank, 4801 floor unlock, 4805 reward recover, 4820 boss rank, 4821 open boss reward
 */

const playerService = require('../services/PlayerService');
const config = require('../services/ConfigService');
const { addRewardToPlayer } = require('./raid');
const {
  addDungeonBossChallengeCount,
  updateDungeonBossMaxMapId,
} = require('../services/MainTaskProgressService');

function normalizeTaskInfoSafe(taskInfo = {}, roleInfo = {}, player = {}) {
  try {
    // eslint-disable-next-line global-require
    const mod = require('./playerPayload');
    if (mod && typeof mod.normalizeTaskInfo === 'function') {
      return mod.normalizeTaskInfo(taskInfo, roleInfo, player);
    }
  } catch (_err) {}
  return taskInfo;
}

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensurePlainObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return fallback;
}

function buildRewardInfo(items = []) {
  return {
    items: Array.isArray(items) ? items : [],
    equips: [],
    pets: [],
    alchemyData: [],
    petSoulDatas: [],
    bloodline: [],
  };
}

function clonePlain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function buildDungeonFightVars(hpValue = 100) {
  const hp = Math.max(1, toSafeInt(hpValue, 100));
  return { 1: hp, 2: 0, 3: 0, '-1': hp };
}

function buildDungeonShowInfo(player = {}, fallback = {}) {
  const roleInfo = ensurePlainObject(player.roleInfo);
  const kungfuId = Math.max(1, toSafeInt(roleInfo.kungfuId, toSafeInt(fallback.kungfuId, 4)));
  const dbid = String(player.playerId || player.userId || fallback.dbid || 'dungeon_target');
  const name = String(player.name || fallback.name || 'Dungeon Target');
  return {
    dbid,
    name,
    kungfuId,
    level: Math.max(1, toSafeInt(player.level, toSafeInt(fallback.level, 1))),
    power: Math.max(1, toSafeInt(player.power, toSafeInt(fallback.power, 100))),
    playerInfo: {
      dbid,
      name,
      level: Math.max(1, toSafeInt(player.level, toSafeInt(fallback.level, 1))),
      kungfuId,
      avatar: Math.max(0, toSafeInt(player.avatar, toSafeInt(fallback.avatar, 0))),
      avatarFrame: Math.max(0, toSafeInt(player.avatarFrame, 0)),
    },
  };
}

function buildDungeonFightResult(player = {}, fightType = 11, targetId = '') {
  const selfShowInfo = buildDungeonShowInfo(player, { dbid: 'self', name: 'Player' });
  const enemyShowInfo = buildDungeonShowInfo({}, {
    dbid: targetId || '1',
    name: fightType === 13 ? 'Dungeon Boss' : 'Dungeon Enemy',
    kungfuId: 4,
    level: Math.max(1, toSafeInt(player.level, 1)),
  });
  const selfHp = 100;
  const enemyHp = 100;
  return {
    type: Math.max(11, toSafeInt(fightType, 11)),
    win: 1,
    mustChangeTurn: 0,
    notChangeTurn: 1,
    atkAttr: {},
    defAttr: {},
    bloodlineOffset: 0,
    events: [
      { typ: 0, i: 0, c: 0, t: 0, es: [] },
      {
        typ: 0,
        i: 1,
        c: 0,
        t: 0,
        es: [[{
          typ: 1,
          i: 1002,
          c: 1,
          t: 0,
          as: [0],
          es: [[{
            typ: 2,
            i: 10020,
            c: 1,
            t: 0,
            es: [[{
              typ: 3,
              i: 0,
              c: 1,
              t: -1,
              as: [0],
              vs: { 1: -enemyHp },
              es: [[{ typ: 6, i: 0, c: 1, t: -1 }]],
            }]],
          }]],
        }]],
      },
    ],
    entitys: [
      {
        id: selfShowInfo.kungfuId,
        dbid: selfShowInfo.dbid,
        name: selfShowInfo.name,
        type: 1,
        side: 1,
        camp: 1,
        pos: 1,
        posIndex: 1,
        hp: selfHp,
        maxhp: selfHp,
        maxHp: selfHp,
        vars: buildDungeonFightVars(selfHp),
        showInfo: selfShowInfo,
        parts: {},
        partValues: {},
      },
      {
        id: enemyShowInfo.kungfuId,
        dbid: enemyShowInfo.dbid,
        name: enemyShowInfo.name,
        type: fightType === 13 ? 2 : 1,
        side: 2,
        camp: 2,
        pos: -1,
        posIndex: -1,
        hp: 0,
        maxhp: enemyHp,
        maxHp: enemyHp,
        vars: buildDungeonFightVars(enemyHp),
        showInfo: enemyShowInfo,
        parts: {},
        partValues: {},
      },
    ],
  };
}

function buildTaskSyncPackets(player = {}) {
  const taskInfo = normalizeTaskInfoSafe(player.taskInfo || {}, player.roleInfo || {}, player);
  const tasksMap = taskInfo && typeof taskInfo.tasksMap === 'object' && !Array.isArray(taskInfo.tasksMap)
    ? taskInfo.tasksMap
    : {};
  const packets = [];

  Object.keys(tasksMap).forEach((typeKey) => {
    const list = Array.isArray(tasksMap[typeKey]) ? tasksMap[typeKey] : [];
    list.forEach((task) => {
      const status = toSafeInt(task && task.status, 0);
      if (status !== 10 && status !== 20) return;
      const taskId = Math.max(0, toSafeInt(task && task.id, 0));
      if (taskId <= 0) return;
      packets.push({
        tag: 1000,
        msgUid: 0,
        data: {
          task: clonePlain(task),
          index: String(taskId),
        },
      });
    });
  });

  return packets;
}

function addRewardInfoToPlayer(player, rewardInfo) {
  const rows = Array.isArray(rewardInfo && rewardInfo.items) ? rewardInfo.items : [];
  rows.forEach((row) => {
    const id = toSafeInt(row && row.id, 0);
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    addRewardToPlayer(player, id, count);
  });
}

function normalizeDungeonTask(task, index) {
  const out = ensurePlainObject(task);
  out.index = Math.max(0, toSafeInt(out.index, index));
  out.id = Math.max(1, toSafeInt(out.id, out.index + 1));
  out.status = Math.max(0, toSafeInt(out.status, 10));
  out.progress = Math.max(0, toSafeInt(out.progress, 0));
  out.target = Math.max(1, toSafeInt(out.target, 1));
  if (!Array.isArray(out.rewards)) {
    out.rewards = [{ id: 2, count: 200 + out.index * 100 }];
  }
  return out;
}

function ensureDungeonTasks(info) {
  if (!Array.isArray(info.tasks)) info.tasks = [];
  if (info.tasks.length === 0) {
    info.tasks = [
      normalizeDungeonTask({ id: 101, status: 10, progress: 0, target: 1 }, 0),
      normalizeDungeonTask({ id: 102, status: 10, progress: 0, target: 1 }, 1),
    ];
    return info.tasks;
  }

  info.tasks = info.tasks.map((task, idx) => normalizeDungeonTask(task, idx));
  return info.tasks;
}

function makeDungeonBoxKey(mapId, boxId) {
  return `${Math.max(0, toSafeInt(mapId, 0))}:${Math.max(0, toSafeInt(boxId, 0))}`;
}

function ensureDungeonBoxStore(info) {
  info.dungeonBoxes = ensurePlainObject(info.dungeonBoxes);
  return info.dungeonBoxes;
}

function ensureDungeonBox(info, mapId, boxId) {
  const store = ensureDungeonBoxStore(info);
  const safeMapId = Math.max(0, toSafeInt(mapId, 0));
  const safeBoxId = Math.max(0, toSafeInt(boxId, 0));
  const key = makeDungeonBoxKey(safeMapId, safeBoxId);
  if (!store[key]) {
    store[key] = {
      id: safeBoxId,
      mapId: safeMapId,
      quality: 1,
      playerId: '',
      time: 0,
      status: 0,
    };
  }

  const box = store[key];
  box.id = safeBoxId;
  box.mapId = safeMapId;
  box.quality = Math.max(1, toSafeInt(box.quality, 1));
  box.playerId = box.playerId ? String(box.playerId) : '';
  box.time = Math.max(0, toSafeInt(box.time, 0));
  box.status = Math.max(0, toSafeInt(box.status, 0));
  return box;
}

function ensureDungeonRaidInfo(player) {
  player.raidInfo = ensurePlainObject(player.raidInfo);
  const info = player.raidInfo;
  const roleInfo = ensurePlainObject(player.roleInfo);
  const demonBossCfg = config.get('DemonBossConfig') || {};
  const demonBossStageIds = Object.keys(demonBossCfg)
    .map((key) => Math.max(0, toSafeInt(key, 0)))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
  const minBossStage = demonBossStageIds.length > 0 ? demonBossStageIds[0] : 3;
  const currentRoleStage = Math.max(1, toSafeInt(roleInfo.stage, toSafeInt(roleInfo.stageId, 1)));
  const visibleBossStage = currentRoleStage >= minBossStage
    ? Math.max(minBossStage, currentRoleStage - 1)
    : minBossStage;

  const chapter = Math.max(1, toSafeInt(info.chapter, 1));
  const level = Math.max(1, toSafeInt(info.level, 1));

  info.chapter = chapter;
  info.level = level;
  info.hangUpChapter = Math.max(1, toSafeInt(info.hangUpChapter, chapter));
  info.hangUpTime = Math.max(0, toSafeInt(info.hangUpTime, 0));
  info.claimedChapters = Array.isArray(info.claimedChapters) ? info.claimedChapters : [];

  info.chapterInfo = ensurePlainObject(info.chapterInfo, {
    id: chapter,
    rewardChapter: 0,
  });
  info.chapterInfo.id = Math.max(1, toSafeInt(info.chapterInfo.id, chapter));
  info.chapterInfo.rewardChapter = Math.max(0, toSafeInt(info.chapterInfo.rewardChapter, 0));

  info.demonBossInfo = ensurePlainObject(info.demonBossInfo, {
    stage: visibleBossStage,
    cleanOutTime: 0,
  });
  info.demonBossInfo.stage = Math.max(minBossStage, toSafeInt(info.demonBossInfo.stage, visibleBossStage));
  info.demonBossInfo.stage = visibleBossStage;
  info.demonBossInfo.cleanOutTime = Math.max(0, toSafeInt(info.demonBossInfo.cleanOutTime, 0));

  info.bossBoxes = ensurePlainObject(info.bossBoxes);
  info.bossMap = ensurePlainObject(info.bossMap);
  info.dailyFightReward = ensurePlainObject(info.dailyFightReward);
  info.dailyRecords = ensurePlainObject(info.dailyRecords);
  info.dailyRecovers = ensurePlainObject(info.dailyRecovers);
  info.slotRecords = ensurePlainObject(info.slotRecords);
  info.tasks = Array.isArray(info.tasks) ? info.tasks : [];
  ensureDungeonTasks(info);

  info.slotCount = Math.max(0, toSafeInt(info.slotCount, 0));
  info.swordCount = Math.max(0, toSafeInt(info.swordCount, 0));
  info.pkValue = Math.max(0, toSafeInt(info.pkValue, 0));
  info.jailFreeTime = Math.max(0, toSafeInt(info.jailFreeTime, 0));
  info.nextPkValueReduceTime = Math.max(0, toSafeInt(info.nextPkValueReduceTime, 0));

  return info;
}

function buildRankIdentity(player = {}) {
  const roleInfo = ensurePlainObject(player.roleInfo);
  return {
    dbid: player.playerId || '',
    level: Math.max(1, toSafeInt(player.level, 1)),
    avatar: toSafeInt(player.avatar, 0),
    avatarUrl: player.avatarUrl || '',
    avatarFrame: toSafeInt(player.avatarFrame, 0),
    title: toSafeInt(player.title, 0),
    name: player.name || '',
    kungfuId: toSafeInt(roleInfo.kungfuId, 0),
    power: Math.max(0, toSafeInt(player.power, Math.max(1, toSafeInt(player.level, 1)) * 100)),
  };
}

function buildNpcRow(prefix, floor, index, scoreKey, scoreValue) {
  const n = Math.max(0, toSafeInt(index, 0));
  return {
    dbid: `${prefix}_${floor}_${n}`,
    level: 10 + floor + n * 3,
    avatar: 11305 + n,
    avatarUrl: '',
    avatarFrame: 0,
    title: 0,
    name: `${prefix.toUpperCase()}_${floor}_${n}`,
    kungfuId: (n % 5) + 1,
    power: 500 + floor * 50 + n * 80,
    [scoreKey]: Math.max(1, toSafeInt(scoreValue, 1)),
  };
}

function buildRecoverReward(index) {
  const safeIndex = Math.max(1, toSafeInt(index, 1));
  return buildRewardInfo([
    { id: 2, count: safeIndex * 200 },
    { id: 4, count: safeIndex * 30 },
  ]);
}

function buildBossReward(boxId) {
  const id = Math.max(1, toSafeInt(boxId, 1));
  return buildRewardInfo([
    { id: 2, count: id * 300 },
    { id: 3, count: id * 2 },
  ]);
}

function getDungeonFloorConfig(floor) {
  return ensurePlainObject(config.get('DungeonFloorConfig') && config.get('DungeonFloorConfig')[String(floor)]);
}

function getDungeonMonsterConfig(floor, id) {
  const floors = ensurePlainObject(config.get('DungeonMonsterTypeConfig'));
  return ensurePlainObject(floors[String(floor)] && floors[String(floor)][String(id)]);
}

function ensureDungeonBossState(info, floor) {
  const safeFloor = Math.max(1, toSafeInt(floor, 1));
  const floorCfg = getDungeonFloorConfig(safeFloor);
  const refresh = ensurePlainObject(floorCfg.bossRefresh);
  const day = String(new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCDay() || 7);
  const candidates = Array.isArray(refresh[day]) ? refresh[day] : [];
  const bossMap = ensurePlainObject(info.bossMap);
  const existingId = Math.max(0, toSafeInt(bossMap[String(safeFloor)], 0));
  const bossId = existingId > 0 ? existingId : Math.max(0, toSafeInt(candidates[0], 0));
  if (bossId <= 0 || Object.keys(floorCfg).length === 0) return null;

  info.dungeonBosses = ensurePlainObject(info.dungeonBosses);
  const key = String(safeFloor);
  const monsterCfg = getDungeonMonsterConfig(safeFloor, bossId);
  const state = ensurePlainObject(info.dungeonBosses[key], {
    id: bossId,
    hp: 10000,
    maxHp: 10000,
  });
  state.id = bossId;
  state.maxHp = Math.max(1, toSafeInt(state.maxHp, 10000));
  state.hp = Math.max(0, Math.min(state.maxHp, toSafeInt(state.hp, state.maxHp)));
  state.position = Array.isArray(monsterCfg.position) ? clonePlain(monsterCfg.position[0] || {}) : {};
  info.dungeonBosses[key] = state;
  bossMap[key] = state.hp > 0 ? bossId : 0;
  info.bossMap = bossMap;
  return state;
}

function buildDungeonPetSoulBoss(info, floor) {
  const floors = ensurePlainObject(config.get('DungeonMonsterTypeConfig'));
  const rows = ensurePlainObject(floors[String(floor)]);
  const entry = Object.values(rows).find((row) => toSafeInt(row && row.type, 0) === 3 && toSafeInt(row && row.id, 0) > 0);
  if (!entry) return null;
  const stateMap = ensurePlainObject(info.petSoulBosses);
  const current = ensurePlainObject(stateMap[String(floor)], {
    id: toSafeInt(entry.id, 0),
    lastId: 0,
    noticeTime: 0,
    refreshTime: Date.now() + 86400000,
    recordTime: 0,
  });
  current.id = Math.max(1, toSafeInt(current.id, toSafeInt(entry.id, 1)));
  current.lastId = Math.max(0, toSafeInt(current.lastId, 0));
  current.noticeTime = Math.max(0, toSafeInt(current.noticeTime, 0));
  current.refreshTime = Math.max(0, toSafeInt(current.refreshTime, Date.now() + 86400000));
  current.recordTime = Math.max(0, toSafeInt(current.recordTime, 0));
  stateMap[String(floor)] = current;
  info.petSoulBosses = stateMap;
  return current;
}

function buildSafeFloorInfo(info = {}, floor = 1) {
  const bossState = ensureDungeonBossState(info, floor);
  const petSoulBoss = buildDungeonPetSoulBoss(info, floor);
  return {
    monsters: [],
    catches: [],
    boxes: [],
    robots: [],
    bossInfo: bossState && bossState.hp > 0 ? {
      id: bossState.id,
      hp: bossState.hp,
      x: toSafeInt(bossState.position && bossState.position.x, 0),
      y: toSafeInt(bossState.position && bossState.position.y, 0),
    } : null,
    petSoulBoss,
    bossDamage: Math.max(0, toSafeInt(info.bossDamage, 0)),
    bossRank: Math.max(0, toSafeInt(info.bossRank, 0)),
  };
}

function buildDungeonFloorUpdate(floorInfo = {}) {
  const safeInfo = ensurePlainObject(floorInfo);
  return {
    monsters: Array.isArray(safeInfo.monsters) ? clonePlain(safeInfo.monsters) : [],
    catches: Array.isArray(safeInfo.catches) ? clonePlain(safeInfo.catches) : [],
    boxes: Array.isArray(safeInfo.boxes) ? clonePlain(safeInfo.boxes) : [],
    robots: Array.isArray(safeInfo.robots) ? clonePlain(safeInfo.robots) : [],
  };
}

async function handleDungeonFloorInfo(params, session, msgUid) {
  const player = session && session.player;
  const requestedFloor = Math.max(1, toSafeInt(params && (params.floor || params.mapId || params.id), 1));
  if (!player) {
    return {
      tag: 4804,
      msgUid,
      data: {
        result: -1,
        floor: requestedFloor,
        floorInfo: buildSafeFloorInfo({}, requestedFloor),
      },
    };
  }

  const info = ensureDungeonRaidInfo(player);
  const floor = Math.max(1, toSafeInt(requestedFloor, toSafeInt(info.chapterInfo && info.chapterInfo.id, 1)));
  info.currentFloor = floor;

  const floorInfo = buildSafeFloorInfo(info, floor);
  await playerService.savePlayer(session.userId, player);
  const packets = [{
    tag: 4804,
    msgUid,
    data: {
      result: 0,
      floor,
      floorInfo,
      raidInfo: info,
    },
  }, {
    tag: 4810,
    msgUid: 0,
    data: buildDungeonFloorUpdate(floorInfo),
  }];
  if (info.bossMap && typeof info.bossMap === 'object') {
    packets.push({ tag: 4822, msgUid: 0, data: { bossMap: clonePlain(info.bossMap) } });
  }
  if (floorInfo.petSoulBoss) {
    packets.push({ tag: 4882, msgUid: 0, data: clonePlain(floorInfo.petSoulBoss) });
  }
  return packets;
}

async function handleFloorRankInfo(params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return {
      tag: 4800,
      msgUid,
      data: { result: -1, floor: 1, rank: 0, record: 0, ranklist: [], toplist: [] },
    };
  }

  const info = ensureDungeonRaidInfo(player);
  const floor = Math.max(1, toSafeInt(params && params.floor, toSafeInt(info.chapterInfo.id, 1)));
  const selfScore = floor * 1000 + Math.max(1, toSafeInt(player.level, 1)) * 80 + toSafeInt(info.swordCount, 0) * 20;

  const selfRow = {
    ...buildRankIdentity(player),
    score: selfScore,
  };
  const ranklist = [
    selfRow,
    buildNpcRow('floor_rank', floor, 1, 'score', selfScore + 120),
    buildNpcRow('floor_rank', floor, 2, 'score', Math.max(1, selfScore - 60)),
  ].sort((a, b) => toSafeInt(b.score, 0) - toSafeInt(a.score, 0));

  const rank = Math.max(1, ranklist.findIndex((row) => row.dbid === selfRow.dbid) + 1);
  return {
    tag: 4800,
    msgUid,
    data: {
      result: 0,
      floor,
      rank,
      record: selfScore,
      ranklist,
      toplist: ranklist.slice(0, 3),
    },
  };
}

async function handleFloorUnlockInfo(_params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 4801, msgUid, data: { result: -1, unlockFloor: 1, raidInfo: {} } };
  }

  const info = ensureDungeonRaidInfo(player);
  const unlockFloor = Math.max(1, toSafeInt(info.chapterInfo.id, 1));
  return {
    tag: 4801,
    msgUid,
    data: {
      result: 0,
      unlockFloor,
      raidInfo: info,
    },
  };
}

async function handleRewardRecover(params, session, msgUid) {
  const player = session && session.player;
  const index = Math.max(1, toSafeInt(params && params.index, 1));
  if (!player) {
    return {
      tag: 4805,
      msgUid,
      data: { result: -1, index, count: 0, rewardInfo: buildRewardInfo() },
    };
  }

  const info = ensureDungeonRaidInfo(player);
  const remainKey = String(-index);
  const remainBefore = Math.max(0, toSafeInt(info.dailyRecovers[remainKey], 1));
  const remainAfter = Math.max(0, remainBefore - 1);
  info.dailyRecovers[remainKey] = remainAfter;
  info.dailyRecovers[String(index)] = 0;

  const rewardInfo = remainBefore > 0 ? buildRecoverReward(index) : buildRewardInfo();
  addRewardInfoToPlayer(player, rewardInfo);
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 4805,
    msgUid,
    data: {
      result: 0,
      index,
      count: remainAfter,
      rewardInfo,
    },
  };
}

async function handleBossRankInfo(params, session, msgUid) {
  const player = session && session.player;
  const floor = Math.max(1, toSafeInt(params && params.floor, 1));
  if (!player) {
    return {
      tag: 4820,
      msgUid,
      data: { result: -1, floor, bossRank: 0, bossDamage: 0, ranklist: [] },
    };
  }

  const info = ensureDungeonRaidInfo(player);
  const selfDamage = floor * 700 + Math.max(1, toSafeInt(player.level, 1)) * 100 + toSafeInt(info.swordCount, 0) * 30;
  const selfRow = {
    ...buildRankIdentity(player),
    damage: selfDamage,
  };
  const ranklist = [
    selfRow,
    buildNpcRow('boss_rank', floor, 1, 'damage', selfDamage + 180),
    buildNpcRow('boss_rank', floor, 2, 'damage', Math.max(1, selfDamage - 100)),
  ].sort((a, b) => toSafeInt(b.damage, 0) - toSafeInt(a.damage, 0));
  const bossRank = Math.max(1, ranklist.findIndex((row) => row.dbid === selfRow.dbid) + 1);

  return {
    tag: 4820,
    msgUid,
    data: {
      result: 0,
      floor,
      bossRank,
      bossDamage: selfDamage,
      ranklist,
    },
  };
}

async function handleOpenBossReward(params, session, msgUid) {
  const player = session && session.player;
  const boxId = Math.max(1, toSafeInt(params && params.id, 1));
  if (!player) {
    return {
      tag: 4821,
      msgUid,
      data: { result: -1, id: boxId, rewardInfo: buildRewardInfo() },
    };
  }

  const info = ensureDungeonRaidInfo(player);
  const boxKey = String(boxId);
  const current = Math.max(0, toSafeInt(info.bossBoxes[boxKey], 1));
  info.bossBoxes[boxKey] = Math.max(0, current - 1);

  const rewardInfo = buildBossReward(boxId);
  addRewardInfoToPlayer(player, rewardInfo);
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 4821,
    msgUid,
    data: {
      result: 0,
      id: boxId,
      rewardInfo,
      bossBoxes: info.bossBoxes,
    },
  };
}

async function handleDungeonStartFight(params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 4830, msgUid, data: { result: -1 } };
  }

  const info = ensureDungeonRaidInfo(player);
  const type = Math.max(0, toSafeInt(params && params.type, 0));
  const mapId = Math.max(0, toSafeInt(params && params.mapId, 0));
  const targetId = params && params.targetId != null ? String(params.targetId) : '';
  const startTime = Date.now();

  info.lastFight = {
    type,
    mapId,
    targetId,
    startTime,
  };

  const taskChanged = !!addDungeonBossChallengeCount(player, 1);

  const response = {
    tag: 4830,
    msgUid,
    data: {
      result: 0,
      type,
      mapId,
      targetId,
      startTime,
    },
  };
  const fightResult = buildDungeonFightResult(player, type, targetId);
  const fightPush = {
    tag: 4830,
    msgUid: 0,
    data: {
      type,
      pos: Math.max(0, toSafeInt(params && params.pos, 0)),
      fightInfo: {
        fightResult,
        bloodlineOffset: 0,
        attacker: String(player.playerId || session.userId || ''),
        attackerInfo: fightResult.entitys[0].showInfo.playerInfo,
        defender: String(targetId || '1'),
        defenderInfo: fightResult.entitys[1].showInfo.playerInfo,
      },
    },
  };
  return [
    ...(taskChanged ? buildTaskSyncPackets(player) : []),
    response,
    fightPush,
  ];
}

async function handleDungeonFinishFight(params, session, msgUid) {
  const player = session && session.player;
  const mapId = Math.max(0, toSafeInt(params && params.mapId, 0));
  if (!player) {
    return {
      tag: 4831,
      msgUid,
      data: {
        result: -1,
        mapId,
        raidType: Math.max(0, toSafeInt(params && params.raidType, 0)),
        isWin: 0,
        fightRewards: [],
        doubleRewards: [],
        fightDailyReward: {},
        jailFreeTime: 0,
        normalResult: { taskIndex: -1 },
        bossResult: { damage: 0 },
        pvpResult: { pkValue: 0, enemySinId: 0, sinInc: 0, otherBaseInfo: null, wantedRewards: [] },
        duelResult: { otherBaseInfo: null },
        robotResult: { robotId: 0, level: 1, pkValue: 0, sinInc: 0, wantedRewards: [] },
        attacker: 0,
      },
    };
  }

  const info = ensureDungeonRaidInfo(player);
  const raidType = Math.max(0, toSafeInt(
    params && params.raidType,
    toSafeInt(info.lastFight && info.lastFight.type, 0),
  ));
  const isWin = params && params.isWin != null ? (toSafeInt(params.isWin, 0) ? 1 : 0) : 1;
  const bossState = raidType === 13 ? ensureDungeonBossState(info, mapId) : null;
  const bossDamage = raidType === 13
    ? Math.max(1, toSafeInt(params && params.damage, isWin ? 10000 : 2500))
    : 0;
  if (bossState && isWin) {
    bossState.hp = Math.max(0, bossState.hp - bossDamage);
    info.bossDamage = Math.max(0, toSafeInt(info.bossDamage, 0)) + bossDamage;
    info.bossRank = 1;
    info.bossMap[String(mapId)] = bossState.hp > 0 ? bossState.id : 0;
  }
  const rewardInfo = buildRewardInfo([
    { id: 2, count: Math.max(100, mapId * 100) },
    { id: 4, count: Math.max(20, mapId * 20) },
  ]);
  addRewardInfoToPlayer(player, rewardInfo);
  info.dailyRecords['1'] = Math.max(0, toSafeInt(info.dailyRecords['1'], 0)) + 1;
  const taskChanged = !!updateDungeonBossMaxMapId(player, mapId);

  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 4831,
    msgUid,
    data: {
      result: 0,
      mapId,
      raidType,
      isWin,
      fightRewards: clonePlain(rewardInfo.items),
      doubleRewards: [],
      fightDailyReward: clonePlain(info.dailyFightReward),
      jailFreeTime: info.jailFreeTime,
      normalResult: { taskIndex: -1 },
       bossResult: { damage: bossDamage },
      pvpResult: {
        pkValue: info.pkValue,
        enemySinId: 0,
        sinInc: 0,
        otherBaseInfo: null,
        wantedRewards: [],
      },
      duelResult: { otherBaseInfo: null },
      robotResult: {
        robotId: 0,
        level: Math.max(1, toSafeInt(player.level, 1)),
        pkValue: info.pkValue,
        sinInc: 0,
        wantedRewards: [],
      },
      attacker: Math.max(0, toSafeInt(params && params.attacker, 1)),
      rewardInfo,
      dailyRecords: info.dailyRecords,
    },
  };
  const packets = [];
  if (bossState && isWin) {
    if (bossState.hp > 0) {
      packets.push({
        tag: 4824,
        msgUid: 0,
        data: {
          floor: mapId,
          bossInfo: {
            id: bossState.id,
            hp: bossState.hp,
            x: toSafeInt(bossState.position && bossState.position.x, 0),
            y: toSafeInt(bossState.position && bossState.position.y, 0),
          },
          bossDamage: info.bossDamage,
          bossRank: info.bossRank,
        },
      });
    } else {
      packets.push(
        { tag: 4823, msgUid: 0, data: { floor: mapId, ClearLeaderBoss: 1 } },
        { tag: 4822, msgUid: 0, data: { bossMap: clonePlain(info.bossMap) } },
      );
    }
  }
  if (!taskChanged) return [response, ...packets];
  return [...buildTaskSyncPackets(player), response, ...packets];
}

async function handleDungeonReborn(_params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 4832, msgUid, data: { result: -1 } };
  }

  const info = ensureDungeonRaidInfo(player);
  info.jailFreeTime = 0;
  const rebornTime = Date.now();
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4832,
    msgUid,
    data: {
      result: 0,
      rebornTime,
    },
  };
}

async function handleDungeonStartHealing(params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 4833, msgUid, data: { result: -1, startTime: 0 } };
  }

  const info = ensureDungeonRaidInfo(player);
  const x = toSafeInt(params && params.x, 0);
  const y = toSafeInt(params && params.y, 0);
  const startTime = Date.now() + 1000;
  info.healing = { active: 1, x, y, startTime };
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 4833,
    msgUid,
    data: {
      result: 0,
      startTime,
    },
  };
}

async function handleDungeonStopHealing(_params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 4834, msgUid, data: { result: -1 } };
  }

  const info = ensureDungeonRaidInfo(player);
  info.healing = { active: 0, x: 0, y: 0, startTime: 0 };
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4834,
    msgUid,
    data: { result: 0 },
  };
}

async function handleDungeonWantedList(_params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 4835, msgUid, data: { result: -1, wantedList: [], executedList: [] } };
  }

  const info = ensureDungeonRaidInfo(player);
  const self = buildRankIdentity(player);
  const wantedList = [
    {
      dbid: self.dbid,
      serverId: Math.max(1, toSafeInt(process.env.SERVER_ID, 1)),
      serverName: '',
      name: self.name,
      power: self.power,
      pkValue: Math.max(0, toSafeInt(info.pkValue, 0)),
      kungfuId: self.kungfuId,
    },
    {
      dbid: `wanted_npc_${toSafeInt(info.chapterInfo.id, 1)}_1`,
      serverId: Math.max(1, toSafeInt(process.env.SERVER_ID, 1)),
      serverName: 'npc',
      name: `WANTED_NPC_${toSafeInt(info.chapterInfo.id, 1)}`,
      power: 800 + toSafeInt(info.chapterInfo.id, 1) * 50,
      pkValue: 0,
      kungfuId: 1,
    },
  ];

  const executedList = Array.isArray(info.wantedExecutedList)
    ? info.wantedExecutedList
    : [
      {
        dbid: '',
        killer: '',
        monsterId: 1,
        time: Date.now(),
      },
    ];

  return {
    tag: 4835,
    msgUid,
    data: {
      result: 0,
      wantedList,
      executedList,
    },
  };
}

async function handleDungeonDuel(params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 4838, msgUid, data: { result: -1 } };
  }

  const info = ensureDungeonRaidInfo(player);
  info.lastDuel = {
    launch: toSafeInt(params && params.launch, 0) > 0 ? 1 : 0,
    mapId: Math.max(0, toSafeInt(params && params.mapId, 0)),
    targetId: params && params.targetId != null ? String(params.targetId) : '',
    time: Date.now(),
  };

  return {
    tag: 4838,
    msgUid,
    data: {
      result: 0,
      ...info.lastDuel,
    },
  };
}

async function handleDungeonAcceptDuel(params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 4839, msgUid, data: { result: -1 } };
  }

  const info = ensureDungeonRaidInfo(player);
  info.lastDuelAccept = {
    accept: toSafeInt(params && params.accept, 0) > 0 ? 1 : 0,
    mapId: Math.max(0, toSafeInt(params && params.mapId, 0)),
    refuseAllDuel: toSafeInt(params && params.refuseAllDuel, 0) > 0 ? 1 : 0,
    time: Date.now(),
  };

  return {
    tag: 4839,
    msgUid,
    data: {
      result: 0,
      ...info.lastDuelAccept,
    },
  };
}

async function handleDungeonTaskRefresh(params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 4850, msgUid, data: { result: -1 } };
  }

  const info = ensureDungeonRaidInfo(player);
  const index = Math.max(0, toSafeInt(params && params.index, 0));
  const nextId = Math.max(1, toSafeInt(params && params.id, 100 + index + 1));
  const task = normalizeDungeonTask(
    {
      id: nextId,
      index,
      status: 10,
      progress: 0,
      target: 1,
      rewards: [{ id: 2, count: 300 + index * 100 }],
    },
    index
  );
  info.tasks[index] = task;
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 4850,
    msgUid,
    data: {
      result: 0,
      index,
      task,
      tasks: info.tasks,
    },
  };
}

async function handleDungeonTaskReceive(params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 4851, msgUid, data: { result: -1 } };
  }

  const info = ensureDungeonRaidInfo(player);
  const index = Math.max(0, toSafeInt(params && params.index, 0));
  const taskId = Math.max(1, toSafeInt(params && params.id, 0));

  if (!info.tasks[index]) {
    info.tasks[index] = normalizeDungeonTask({ id: taskId || index + 1, index }, index);
  }
  const task = normalizeDungeonTask(info.tasks[index], index);
  if (taskId > 0) task.id = taskId;
  task.status = 20;
  task.progress = task.target;
  info.tasks[index] = task;

  const rewardRows = Array.isArray(task.rewards) ? task.rewards : [];
  const rewardInfo = buildRewardInfo(rewardRows.map((row) => ({
    id: Math.max(1, toSafeInt(row && row.id, 0)),
    count: Math.max(1, toSafeInt(row && row.count, 1)),
  })));
  addRewardInfoToPlayer(player, rewardInfo);
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 4851,
    msgUid,
    data: {
      result: 0,
      index,
      task,
      rewardInfo,
      tasks: info.tasks,
    },
  };
}

async function handleDungeonStarDraw(params, session, msgUid) {
  const player = session && session.player;
  const index = Math.max(0, toSafeInt(params && params.index, 0));
  if (!player) {
    return { tag: 4860, msgUid, data: { result: -1, index, value: 0, rewardInfo: buildRewardInfo() } };
  }

  const info = ensureDungeonRaidInfo(player);
  const value = Math.max(1, toSafeInt((Math.random() * 3) + 1, 1));
  info.slotRecords[String(index)] = value;

  if (index === 99) {
    info.slotCount = Math.max(0, toSafeInt(info.slotCount, 0)) + 1;
    info.slotRecords = {};
  }

  const rewardInfo = buildRewardInfo([
    { id: 2, count: 100 + value * 50 },
  ]);
  addRewardInfoToPlayer(player, rewardInfo);
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 4860,
    msgUid,
    data: {
      result: 0,
      index,
      value,
      rewardInfo,
    },
  };
}

async function handleDungeonOpenBox(params, session, msgUid) {
  const player = session && session.player;
  const mapId = Math.max(0, toSafeInt(params && params.mapId, 0));
  const boxId = Math.max(1, toSafeInt(params && params.boxId, 1));
  if (!player) {
    return { tag: 4870, msgUid, data: { result: -1 } };
  }

  const info = ensureDungeonRaidInfo(player);
  const box = ensureDungeonBox(info, mapId, boxId);
  box.quality = Math.max(1, Math.min(3, toSafeInt((Math.random() * 3) + 1, 1)));
  box.playerId = player.playerId || '';
  box.time = Date.now() + 5000;
  box.status = 1;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4870,
    msgUid,
    data: {
      result: 0,
      box: {
        id: box.id,
        quality: box.quality,
        playerId: box.playerId,
        time: box.time,
        status: box.status,
      },
    },
  };
}

async function handleDungeonRobBox(params, session, msgUid) {
  const player = session && session.player;
  const mapId = Math.max(0, toSafeInt(params && params.mapId, 0));
  const boxId = Math.max(1, toSafeInt(params && params.boxId, 1));
  if (!player) {
    return { tag: 4871, msgUid, data: { result: -1 } };
  }

  const info = ensureDungeonRaidInfo(player);
  const box = ensureDungeonBox(info, mapId, boxId);
  const rewardInfo = buildRewardInfo([
    { id: 2, count: 400 + box.quality * 100 },
    { id: 3, count: box.quality },
  ]);
  addRewardInfoToPlayer(player, rewardInfo);
  info.dailyRecords['2'] = Math.max(0, toSafeInt(info.dailyRecords['2'], 0)) + 1;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4871,
    msgUid,
    data: {
      result: 0,
      rewardInfo,
    },
  };
}

async function handleDungeonCancelBox(params, session, msgUid) {
  const player = session && session.player;
  const mapId = Math.max(0, toSafeInt(params && params.mapId, 0));
  const boxId = Math.max(1, toSafeInt(params && params.boxId, 1));
  if (!player) {
    return { tag: 4872, msgUid, data: { result: -1 } };
  }

  const info = ensureDungeonRaidInfo(player);
  const box = ensureDungeonBox(info, mapId, boxId);
  box.playerId = '';
  box.time = 0;
  box.status = 0;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4872,
    msgUid,
    data: {
      result: 0,
      box: {
        id: box.id,
        quality: box.quality,
        playerId: box.playerId,
        time: box.time,
        status: box.status,
      },
    },
  };
}

async function handleDungeonTransferFloor(params, session, msgUid) {
  const player = session && session.player;
  const mapId = Math.max(1, toSafeInt(params && params.mapId, 1));
  if (!player) {
    return { tag: 4890, msgUid, data: { result: -1, mapId } };
  }

  const info = ensureDungeonRaidInfo(player);
  info.chapterInfo.id = mapId;
  info.chapter = mapId;
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4890,
    msgUid,
    data: {
      result: 0,
      mapId,
    },
  };
}

async function handleDungeonUseItem(params, session, msgUid) {
  const player = session && session.player;
  const itemId = Math.max(1, toSafeInt(params && params.id, 1));
  const count = Math.max(1, toSafeInt(params && params.count, 1));
  if (!player) {
    return { tag: 4900, msgUid, data: { result: -1, pkValue: 0, nextPKValueReduceTime: 0 } };
  }

  const info = ensureDungeonRaidInfo(player);
  player.items = ensurePlainObject(player.items);
  const hasEnough = Math.max(0, toSafeInt(player.items[itemId], 0)) >= count;
  if (hasEnough) {
    player.items[itemId] = Math.max(0, toSafeInt(player.items[itemId], 0) - count);
  }

  const reduceValue = count * 10;
  info.pkValue = Math.max(0, toSafeInt(info.pkValue, 0) - reduceValue);
  info.nextPkValueReduceTime = Date.now() + 60000;
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 4900,
    msgUid,
    data: {
      result: hasEnough ? 0 : 1,
      pkValue: info.pkValue,
      nextPKValueReduceTime: info.nextPkValueReduceTime,
    },
  };
}

async function handleDungeonEnterCatch(params, session, msgUid) {
  const player = session && session.player;
  const uid = Math.max(0, toSafeInt(params && params.uid, 0));
  const mapId = Math.max(1, toSafeInt(params && params.mapId, 1));
  if (!player) {
    return { tag: 4910, msgUid, data: { result: -1 } };
  }

  const info = ensureDungeonRaidInfo(player);
  info.catchInfo = {
    uid,
    mapId,
    active: 1,
    loyalty: Math.max(0, toSafeInt(info.catchInfo && info.catchInfo.loyalty, 0)),
  };
  await playerService.savePlayer(session.userId, player);
  const monsterId = Math.floor(uid / 100);
  const index = uid % 100;
  const monsterConfig = getDungeonMonsterConfig(2, monsterId);
  const petSoulId = Math.max(0, toSafeInt(monsterConfig.petSoulID, 0));
  const petSoulConfig = ensurePlainObject(config.get('PetSoulConfig') && config.get('PetSoulConfig')[String(petSoulId)]);
  const qualityConfig = ensurePlainObject(config.get('PetSoulQualityConfig') && config.get('PetSoulQualityConfig')[String(petSoulConfig.quality)]);
  const baseConfig = ensurePlainObject(config.get('DungeonBaseConfig'));
  return [{
    tag: 4910,
    msgUid,
    data: { result: 0, uid, mapId },
  }, {
    tag: 4880,
    msgUid: 0,
    data: {
      uid,
      monsterId,
      index,
      mapId,
      maxCatchCount: Math.max(1, toSafeInt(baseConfig.onceLimitCatchTime, 1)),
      petSoulID: petSoulId,
      maxLoyalty: Math.max(0, toSafeInt(qualityConfig.point, 0)),
    },
  }];
}

async function handleDungeonStartCatch(params, session, msgUid) {
  const player = session && session.player;
  const mapId = Math.max(1, toSafeInt(params && params.mapId, 1));
  const catchCount = Math.max(1, toSafeInt(params && params.catchCount, 1));
  const itemId = Math.max(1, toSafeInt(params && params.itemId, 1));
  if (!player) {
    return { tag: 4911, msgUid, data: { result: -1, loyalty: 0 } };
  }

  const info = ensureDungeonRaidInfo(player);
  info.catchInfo = ensurePlainObject(info.catchInfo);
  const current = Math.max(0, toSafeInt(info.catchInfo.loyalty, 0));
  const add = catchCount * 5;
  info.catchInfo.loyalty = current + add;
  info.catchInfo.mapId = mapId;
  info.catchInfo.itemId = itemId;
  info.catchInfo.active = 1;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4911,
    msgUid,
    data: {
      result: 0,
      mapId,
      itemId,
      catchCount,
      loyalty: info.catchInfo.loyalty,
    },
  };
}

async function handleDungeonLeaveCatch(params, session, msgUid) {
  const player = session && session.player;
  const uid = Math.max(0, toSafeInt(params && params.uid, 0));
  const mapId = Math.max(1, toSafeInt(params && params.mapId, 1));
  if (!player) {
    return { tag: 4912, msgUid, data: { result: -1 } };
  }

  const info = ensureDungeonRaidInfo(player);
  info.catchInfo = ensurePlainObject(info.catchInfo);
  info.catchInfo.active = 0;
  await playerService.savePlayer(session.userId, player);
  return [{
    tag: 4912,
    msgUid,
    data: { result: 0, uid, mapId },
  }, {
    tag: 4881,
    msgUid: 0,
    data: { catchResult: 0 },
  }];
}

module.exports = {
  ensureDungeonRaidInfo,
  handleDungeonFloorInfo,
  handleFloorRankInfo,
  handleFloorUnlockInfo,
  handleRewardRecover,
  handleBossRankInfo,
  handleOpenBossReward,
  handleDungeonStartFight,
  handleDungeonFinishFight,
  handleDungeonReborn,
  handleDungeonStartHealing,
  handleDungeonStopHealing,
  handleDungeonWantedList,
  handleDungeonDuel,
  handleDungeonAcceptDuel,
  handleDungeonTaskRefresh,
  handleDungeonTaskReceive,
  handleDungeonStarDraw,
  handleDungeonOpenBox,
  handleDungeonRobBox,
  handleDungeonCancelBox,
  handleDungeonTransferFloor,
  handleDungeonUseItem,
  handleDungeonEnterCatch,
  handleDungeonStartCatch,
  handleDungeonLeaveCatch,
};
