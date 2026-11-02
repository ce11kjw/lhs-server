/**
 * Cross rival handlers.
 * tag: 6550~6583
 */

const playerService = require('../services/PlayerService');
const battle = require('../services/BattleService');
const config = require('../services/ConfigService');
const { addRewardToPlayer } = require('./raid');
const { buildPlayer500Data } = require('./playerPayload');
const { getPrimaryBattlePetId, applyPrimaryBattlePetParts } = require('../services/RoleAppearanceService');
const { buildClientItemList } = require('../services/CurrencySync');
const { addCrossRivalChallengeCount } = require('../services/MainTaskProgressService');

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

function normalizeRewardRows(rows = []) {
  const map = new Map();
  ensureArray(rows).forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    map.set(id, (map.get(id) || 0) + count);
  });
  const items = [];
  map.forEach((count, id) => items.push({ id, count }));
  items.sort((a, b) => a.id - b.id);
  return items;
}

function buildRewardInfo(rows = []) {
  return {
    items: normalizeRewardRows(rows),
    equips: [],
    heros: [],
  };
}

function clonePlain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getConfigTable(name) {
  const table = config.get(name);
  return table && typeof table === 'object' ? table : {};
}

function getCurrencyKeyById(itemId) {
  switch (toSafeInt(itemId, 0)) {
    case 1: return 'diamond';
    case 2: return 'silver';
    case 6: return 'gold';
    default: return null;
  }
}

function getResourceCount(player, itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return 0;
  const currencyKey = getCurrencyKeyById(id);
  if (currencyKey) {
    return Math.max(0, toSafeInt(player && player.currencies && player.currencies[currencyKey], 0));
  }
  return Math.max(0, toSafeInt(player && player.items && player.items[id], 0));
}

function consumeResource(player, itemId, count) {
  const id = toSafeInt(itemId, 0);
  const need = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || need <= 0) return true;
  if (getResourceCount(player, id) < need) return false;

  const currencyKey = getCurrencyKeyById(id);
  if (currencyKey) {
    player.currencies = ensurePlainObject(player.currencies, { gold: 0, diamond: 0, silver: 0 });
    player.currencies[currencyKey] = Math.max(0, toSafeInt(player.currencies[currencyKey], 0) - need);
  } else {
    player.items = ensurePlainObject(player.items);
    const left = Math.max(0, toSafeInt(player.items[id], 0) - need);
    if (left > 0) player.items[id] = left;
    else delete player.items[id];
  }
  return true;
}

function buildItemSyncPacket(player, touchedIds = []) {
  const ids = Array.from(new Set(ensureArray(touchedIds)
    .map((id) => toSafeInt(id, 0))
    .filter((id) => id > 0)));
  if (ids.length === 0) return null;
  return {
    tag: 1202,
    msgUid: 0,
    data: {
      result: 0,
      items: buildClientItemList(player),
      changed: ids.map((id) => ({ id, count: getResourceCount(player, id) })),
    },
  };
}

function getCrossRivalBaseConfig() {
  return getConfigTable('CrossRivalBaseConfig');
}

function getSceneItemConfig(sceneType) {
  const table = getConfigTable('CrossRivalSceneItemConfig');
  const type = Math.max(1, toSafeInt(sceneType, 1));
  return ensurePlainObject(table[type] || table[String(type)]);
}

function resolveCrossRivalOpenState(nowMs, currentMatchId = 0, currentEndTime = 0) {
  const table = getConfigTable('CrossRivalOpenConfig');
  const rows = Object.values(table).filter((row) => row && typeof row === 'object');
  let selected = table[currentMatchId] || table[String(currentMatchId)] || null;
  if (!selected) {
    selected = rows.find((row) => (
      toSafeInt(row.startTime, 0) <= nowMs && nowMs < toSafeInt(row.endTime, 0)
    )) || rows
      .filter((row) => toSafeInt(row.startTime, 0) <= nowMs)
      .sort((a, b) => toSafeInt(b.startTime, 0) - toSafeInt(a.startTime, 0))[0]
      || rows.sort((a, b) => toSafeInt(a.startTime, 0) - toSafeInt(b.startTime, 0))[0]
      || null;
  }
  const matchId = Math.max(0, toSafeInt(selected && selected.id, currentMatchId));
  const configuredEnd = Math.max(0, toSafeInt(selected && selected.endTime, 0));
  const persistedEnd = Math.max(0, toSafeInt(currentEndTime, 0));
  return {
    matchId,
    endTime: Math.max(configuredEnd, persistedEnd, nowMs + 24 * 60 * 60 * 1000),
  };
}

function normalizeTimestampMs(value, fallback = 0) {
  const timestamp = Math.max(0, toSafeInt(value, fallback));
  if (timestamp > 1000000000 && timestamp < 1000000000000) return timestamp * 1000;
  return timestamp;
}

function buildTaskSyncPackets(player = {}) {
  try {
    // eslint-disable-next-line global-require
    const task = require('./task');
    const activePackets = task && typeof task.buildActiveTaskUpdatePackets === 'function'
      ? task.buildActiveTaskUpdatePackets(player, 0)
      : [];
    return activePackets;
  } catch (_err) {
    return [];
  }
}

function buildFightVars(hpValue = 0) {
  const hp = Math.max(0, toSafeInt(hpValue, 0));
  return { 1: hp, 2: 0, 3: 0, '-1': hp };
}

function buildCrossRivalFightResult(player = {}, raidType = 61, targetId = '') {
  const playerAttrs = battle.calcPlayerPower(player);
  const playerHpMax = Math.max(1, toSafeInt(playerAttrs[1], 1000));
  const playerAtk = Math.max(1, toSafeInt(playerAttrs[2], 200));
  const enemyHpMax = Math.max(3000, playerAtk * 5);
  const enemyAtk = Math.max(1, Math.floor(playerAtk * 0.28));
  let curEnemyHp = enemyHpMax;
  let curPlayerHp = playerHpMax;
  const perHit = Math.max(1, Math.floor(enemyHpMax / 4));
  const events = [{ typ: 0, i: 0, c: 0, t: 0, es: [] }];
  for (let roundIndex = 1; roundIndex <= 4; roundIndex += 1) {
    const isFinal = roundIndex === 4;
    const round = { typ: 0, i: roundIndex, c: 0, t: 0, es: [] };
    const playerDamage = isFinal ? curEnemyHp : Math.max(1, Math.min(curEnemyHp - 1, perHit));
    curEnemyHp = Math.max(0, curEnemyHp - playerDamage);
    round.es.push([{
      typ: 1,
      i: 1002,
      c: 1,
      t: 0,
      as: [0],
      es: [[{ typ: 2, i: 10020, c: 1, t: 0, es: [[{
        typ: 3,
        i: 0,
        c: 1,
        t: -1,
        as: [0],
        vs: { 1: -playerDamage },
        es: curEnemyHp <= 0 ? [[{ typ: 6, i: 0, c: 1, t: -1 }]] : undefined,
      }]] }]],
    }]);
    if (!isFinal) {
      curPlayerHp = Math.max(1, curPlayerHp - enemyAtk);
      round.es.push([{
        typ: 1,
        i: 9009,
        c: -1,
        t: 0,
        as: [0],
        es: [[{ typ: 2, i: 90090, c: -1, t: 0, es: [[{
          typ: 3,
          i: 0,
          c: -1,
          t: 1,
          as: [0],
          vs: { 1: -enemyAtk },
        }]] }]],
      }]);
    }
    events.push(round);
  }
  const selfEntity = applyPrimaryBattlePetParts({
    id: Math.max(1, toSafeInt(player && player.roleInfo && player.roleInfo.kungfuId, 4)),
    dbid: String(player.playerId || player.userId || 'cross_rival_self'),
    name: String(player.name || 'Player'),
    type: 1,
    side: 1,
    camp: 1,
    pos: 1,
    posIndex: 1,
    hp: playerHpMax,
    maxhp: playerHpMax,
    maxHp: playerHpMax,
    vars: buildFightVars(playerHpMax),
    showInfo: buildCrossRivalShowInfo(player),
    parts: {},
    partValues: {},
  }, player);
  return {
    type: Math.max(61, toSafeInt(raidType, 61)),
    win: 1,
    mustChangeTurn: 0,
    notChangeTurn: 1,
    atkAttr: playerAttrs || {},
    defAttr: { 1: enemyHpMax, 2: enemyAtk, 3: 0, 4: 1 },
    damage: { 1: enemyHpMax, '-1': Math.max(0, playerHpMax - curPlayerHp) },
    isBackFight: false,
    events,
    entitys: [
      selfEntity,
      {
        id: 11301,
        dbid: String(targetId || `cross_rival_${raidType}`),
        name: raidType === 63 ? '魔灵法阵' : (raidType === 61 ? '魔灵守卫' : '魔灵入侵者'),
        type: 2,
        side: 2,
        camp: 2,
        pos: -1,
        posIndex: -1,
        hp: enemyHpMax,
        maxhp: enemyHpMax,
        maxHp: enemyHpMax,
        vars: buildFightVars(enemyHpMax),
        showInfo: buildCrossRivalShowInfo(player, {
          dbid: String(targetId || `cross_rival_${raidType}`),
          name: raidType === 63 ? '魔灵法阵' : (raidType === 61 ? '魔灵守卫' : '魔灵入侵者'),
          level: Math.max(1, toSafeInt(player.level, 1)),
          power: Math.max(100, Math.floor(enemyHpMax / 3)),
          petId: 0,
          avatar: 11302,
        }),
        parts: {},
        partValues: {},
      },
    ],
    guildBossAllDamage: 0,
    bloodlineOffset: 0,
  };
}

function grantRewardInfo(player, rows = []) {
  const rewardInfo = buildRewardInfo(rows);
  rewardInfo.items.forEach((row) => addRewardToPlayer(player, row.id, row.count));
  return rewardInfo;
}

function buildCrossRivalShowInfo(player, overrides = {}) {
  const row = ensurePlainObject(overrides);
  return {
    dbid: row.dbid == null ? String((player && player.playerId) || '') : String(row.dbid),
    serverId: Math.max(1, toSafeInt(row.serverId, 1)),
    serverName: row.serverName || '',
    kungfuId: Math.max(1, toSafeInt(row.kungfuId, toSafeInt(player && player.kungfuId, 4))),
    subJob: Math.max(0, toSafeInt(row.subJob, 0)),
    level: Math.max(1, toSafeInt(row.level, toSafeInt(player && player.level, 1))),
    name: row.name || (player && player.name) || 'cross_rival',
    power: Math.max(100, toSafeInt(row.power, toSafeInt(player && player.power, 1000))),
    stage: Math.max(1, toSafeInt(row.stage, toSafeInt(player && player.stage, 1))),
    petId: Math.max(0, toSafeInt(row.petId, getPrimaryBattlePetId(player))),
    petSoulId: toSafeInt(row.petSoulId, -1),
    artifactId: Math.max(0, toSafeInt(row.artifactId, 0)),
    fate: Math.max(0, toSafeInt(row.fate, 0)),
    foreverCard: Math.max(0, toSafeInt(row.foreverCard, 0)),
    equipMap: ensurePlainObject(row.equipMap),
    fashionMap: ensurePlainObject(row.fashionMap),
    avatar: Math.max(0, toSafeInt(row.avatar, toSafeInt(player && player.avatar, 11300))),
    avatarUrl: row.avatarUrl || '',
    avatarFrame: Math.max(-1, toSafeInt(row.avatarFrame, toSafeInt(player && player.avatarFrame, -1))),
    title: Math.max(0, toSafeInt(row.title, toSafeInt(player && player.title, 0))),
  };
}

function buildCrossRivalMapPlayer(player, id, x, y, camp = 1, isSelf = false) {
  const showInfo = isSelf
    ? buildCrossRivalShowInfo(player)
    : buildCrossRivalShowInfo(player, {
      dbid: id,
      name: `������${String(id).slice(-4)}`,
      level: Math.max(1, toSafeInt(player.level, 1) + ((toSafeInt(id, 0) % 5) - 2)),
      power: 1000 + (toSafeInt(id, 0) % 10) * 120,
      petId: 0,
      avatar: 11300 + (toSafeInt(id, 0) % 6),
    });

  return {
    id: String(id),
    x: Math.max(0, toSafeInt(x, 1000)),
    y: Math.max(0, toSafeInt(y, 1000)),
    speedUp: 0,
    bloodPer: 10000,
    pkValue: 0,
    camp,
    avatar: showInfo.avatar,
    name: showInfo.name,
    level: showInfo.level,
    power: showInfo.power,
    serverId: showInfo.serverId,
    sinLv: 0,
    targetId: '',
    explode: 0,
    protectTime: 0,
    notHide: true,
    showInfo,
  };
}

function buildDefaultCrossRivalCampInfoMap() {
  const scene = getSceneItemConfig(3);
  const initialCoreCount = Math.max(0, toSafeInt(scene.initialNum, 0));
  return {
    1: { camp: 1, score: 0, flag: 1, core: initialCoreCount, coreRate: 10000, flagReborn: 0, players: 0, buffLevel: 0, rank: 1 },
    2: { camp: 2, score: 0, flag: 1, core: initialCoreCount, coreRate: 10000, flagReborn: 0, players: 0, buffLevel: 0, rank: 2 },
    3: { camp: 3, score: 0, flag: 1, core: initialCoreCount, coreRate: 10000, flagReborn: 0, players: 0, buffLevel: 0, rank: 3 },
    4: { camp: 4, score: 0, flag: 1, core: initialCoreCount, coreRate: 10000, flagReborn: 0, players: 0, buffLevel: 0, rank: 4 },
  };
}

function normalizeCrossRivalCampInfoMap(map) {
  const raw = ensurePlainObject(map);
  const normalized = {};
  Object.keys(raw).forEach((key) => {
    const row = ensurePlainObject(raw[key]);
    const camp = Math.max(1, Math.min(4, toSafeInt(row.camp, toSafeInt(key, 0))));
    if (camp <= 0) return;
    normalized[String(key)] = {
      camp,
      score: Math.max(0, toSafeInt(row.score, 0)),
      flag: Math.max(0, toSafeInt(row.flag, 1)),
      core: Math.max(0, toSafeInt(row.core, 0)),
      coreRate: Math.max(0, toSafeInt(row.coreRate, 10000)),
      flagReborn: Math.max(0, toSafeInt(row.flagReborn, 0)),
      players: Math.max(0, toSafeInt(row.players, 0)),
      buffLevel: Math.max(0, toSafeInt(row.buffLevel, 0)),
      rank: Math.max(0, toSafeInt(row.rank, 0)),
    };
  });
  if (Object.keys(normalized).length > 0) return normalized;
  return buildDefaultCrossRivalCampInfoMap();
}

function ensureCrossRivalInfo(player) {
  const nowMs = Date.now();
  const holder = player && typeof player === 'object' ? player : {};
  holder.crossRivalInfo = ensurePlainObject(holder.crossRivalInfo);
  const info = holder.crossRivalInfo;
  const base = getCrossRivalBaseConfig();
  const openState = resolveCrossRivalOpenState(nowMs, info.matchId, info.endTime);
  const initialCoreBlood = Math.max(1, toSafeInt(base.initialCoreBlood, 50000));
  const initialFlagBlood = Math.max(1, toSafeInt(base.initialFlagBlood, 200000));

  info.matchId = openState.matchId;
  info.endTime = openState.endTime;
  info.stage = Math.max(1, toSafeInt(info.stage, 2));
  info.camp = Math.max(1, Math.min(4, toSafeInt(info.camp, 1)));
  info.lineCount = Math.max(1, toSafeInt(info.lineCount, 1));
  info.mapId = Math.max(-1, toSafeInt(info.mapId, -1));
  info.line = Math.max(-1, toSafeInt(info.line, -1));
  info.stayTime = normalizeTimestampMs(info.stayTime, 0);
  info.invasionCd = normalizeTimestampMs(info.invasionCd, 0);
  info.transmitCd = normalizeTimestampMs(info.transmitCd, 0);
  info.score = Math.max(0, toSafeInt(info.score, toSafeInt(info.coreScore, 0)));
  info.defKill = Math.max(0, toSafeInt(info.defKill, 0));
  info.taskRecord = ensureArray(info.taskRecord)
    .map((row) => Math.max(0, toSafeInt(row, 0)))
    .filter((row) => row > 0);
  info.taskProgress = ensurePlainObject(info.taskProgress);
  Object.keys(info.taskProgress).forEach((key) => {
    info.taskProgress[key] = Math.max(0, toSafeInt(info.taskProgress[key], 0));
  });
  info.taskProgress[2] = Math.max(info.score, toSafeInt(info.taskProgress[2], 0));
  info.campInfoMap = normalizeCrossRivalCampInfoMap(info.campInfoMap);
  info.mapLinePlayerCount = ensurePlainObject(info.mapLinePlayerCount);
  info.boxMap = ensurePlainObject(info.boxMap);
  info.itemCd = ensurePlainObject(info.itemCd || info.itemCD);
  Object.keys(info.itemCd).forEach((key) => {
    info.itemCd[key] = normalizeTimestampMs(info.itemCd[key], 0);
  });
  info.effects = ensurePlainObject(info.effects || info.itemEffects);
  Object.keys(info.effects).forEach((key) => {
    const value = Math.max(0, toSafeInt(info.effects[key], 0));
    info.effects[key] = value > 1000000000 ? normalizeTimestampMs(value, 0) : value;
  });
  delete info.itemCD;
  delete info.itemEffects;
  info.coreInfo = ensureArray(info.coreInfo);
  if (info.coreInfo.length === 0) {
    info.coreInfo = [
      { id: 1, hp: initialCoreBlood, score: 0, rebornTime: 0, defenders: [] },
      { id: 2, hp: initialCoreBlood, score: 0, rebornTime: 0, defenders: [] },
      { id: 3, hp: initialCoreBlood, score: 0, rebornTime: 0, defenders: [] },
    ];
  }
  info.coreInfo = info.coreInfo.map((value, index) => {
    const row = ensurePlainObject(value);
    return {
      ...row,
      id: Math.max(1, toSafeInt(row.id, index + 1)),
      hp: Math.max(0, toSafeInt(row.hp, initialCoreBlood)),
      score: Math.max(0, toSafeInt(row.score, 0)),
      rebornTime: normalizeTimestampMs(row.rebornTime, 0),
      defenders: ensureArray(row.defenders),
    };
  });
  info.flagInfo = ensurePlainObject(info.flagInfo, { id: 1, hp: initialFlagBlood, rebornTime: 0, count: 0 });
  info.flagInfo.id = 1;
  info.flagInfo.hp = Math.max(0, toSafeInt(info.flagInfo.hp, initialFlagBlood));
  info.flagInfo.rebornTime = normalizeTimestampMs(info.flagInfo.rebornTime, 0);
  info.flagInfo.count = Math.max(0, toSafeInt(info.flagInfo.count, 0));
  info.chatList = ensureArray(info.chatList);
  info.rebornTime = normalizeTimestampMs(info.rebornTime, 0);
  info.coreScore = Math.max(0, toSafeInt(info.coreScore, info.score));
  info.assistScore = Math.max(0, toSafeInt(info.assistScore, 0));
  info.sinLv = Math.max(0, toSafeInt(info.sinLv, 0));
  info.essenceState = ensurePlainObject(info.essenceState, { attacking: false, endTime: 0 });
  info.essenceState.attacking = !!info.essenceState.attacking;
  info.essenceState.endTime = normalizeTimestampMs(info.essenceState.endTime, 0);

  return info;
}

function buildCrossRivalInitPayload(info) {
  return {
    matchId: Math.max(0, toSafeInt(info.matchId, 0)),
    stage: Math.max(0, toSafeInt(info.stage, 0)),
    camp: Math.max(-1, toSafeInt(info.camp, -1)),
    mapId: Math.max(-1, toSafeInt(info.mapId, -1)),
    line: Math.max(-1, toSafeInt(info.line, -1)),
    lineCount: Math.max(1, toSafeInt(info.lineCount, 1)),
    endTime: Math.max(0, toSafeInt(info.endTime, 0)),
    stayTime: Math.max(0, toSafeInt(info.stayTime, 0)),
    invasionCd: Math.max(0, toSafeInt(info.invasionCd, 0)),
    score: Math.max(0, toSafeInt(info.score, 0)),
    defKill: Math.max(0, toSafeInt(info.defKill, 0)),
    campInfoMap: clonePlain(info.campInfoMap) || {},
    taskRecord: ensureArray(info.taskRecord).slice(),
    taskProgress: clonePlain(info.taskProgress) || {},
    itemCd: clonePlain(info.itemCd) || {},
    effects: clonePlain(info.effects) || {},
    chats: ensureArray(info.chatList).map((row) => clonePlain(row)),
  };
}

function ensureCrossRivalCollect(info, collectId) {
  const id = Math.max(1, toSafeInt(collectId, 101));
  const key = String(id);
  info.boxMap[key] = ensurePlainObject(info.boxMap[key], {
    id,
    playerId: '',
    name: '',
    status: 0,
    time: 0,
    collectTime: 0,
    isHide: false,
  });
  const row = info.boxMap[key];
  row.id = id;
  row.playerId = row.playerId == null ? '' : String(row.playerId);
  row.name = row.name || '';
  row.status = Math.max(0, toSafeInt(row.status, 0));
  row.time = normalizeTimestampMs(row.time, 0);
  row.collectTime = Math.max(0, toSafeInt(row.collectTime, 0));
  row.isHide = !!row.isHide;
  return row;
}

function buildCrossRivalMapInfo(player, info, params = {}) {
  const campId = Math.max(1, toSafeInt(params && params.campId, info.mapId > 0 ? info.mapId : info.camp));
  const line = Math.max(0, toSafeInt(params && params.line, info.line >= 0 ? info.line : 0));

  const enemy = [
    { x: 1280, y: 1320 },
    { x: 1420, y: 1180 },
  ];
  const friend = [
    { x: 1060, y: 1200 },
    { x: 980, y: 1400 },
  ];
  const wander = [
    { x: 1160, y: 1280 },
  ];

  return {
    result: 0,
    campId,
    line,
    coreInfo: clonePlain(ensureArray(info.coreInfo)),
    flagInfo: clonePlain(ensurePlainObject(info.flagInfo)),
    enemy,
    friend,
    wander,
  };
}

function resolveCrossRivalTaskClaims(info, type = 0) {
  const taskType = Math.max(1, toSafeInt(type, 1));
  const taskTable = getConfigTable('CrossRivalTaskConfig');
  const group = ensurePlainObject(taskTable[taskType] || taskTable[String(taskType)]);
  const claimed = new Set(ensureArray(info.taskRecord).map((id) => toSafeInt(id, 0)));
  const taskIds = [];
  const rewards = [];

  Object.values(group)
    .filter((row) => row && typeof row === 'object')
    .sort((a, b) => toSafeInt(a.id, 0) - toSafeInt(b.id, 0))
    .forEach((row) => {
      const id = Math.max(0, toSafeInt(row.id, 0));
      const activeId = Math.max(0, toSafeInt(row.activeId, 0));
      const required = Math.max(0, toSafeInt(row.taskValue1, 0));
      const progress = Math.max(0, toSafeInt(info.taskProgress[activeId], 0));
      if (id <= 0 || claimed.has(id) || progress < required) return;
      taskIds.push(id);
      rewards.push(...ensureArray(row.reward));
    });

  return { taskIds, rewards: normalizeRewardRows(rewards) };
}

async function handleCrossRivalMapGetInfo(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6550, msgUid, data: { result: -1 } };

  const info = ensureCrossRivalInfo(player);
  const data = buildCrossRivalMapInfo(player, info, params);
  info.mapId = data.campId;
  info.line = data.line;

  await playerService.savePlayer(session.userId, player);
  return { tag: 6550, msgUid, data };
}

async function handleCrossRivalMapEnter(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6551, msgUid, data: { result: -1 } };

  const info = ensureCrossRivalInfo(player);
  const nowMs = Date.now();
  const base = getCrossRivalBaseConfig();
  const campId = Math.max(1, toSafeInt(params && params.campId, info.mapId));
  const line = Math.max(0, toSafeInt(params && params.line, info.line));
  const x = Math.max(0, toSafeInt(params && params.x, 1024));
  const y = Math.max(0, toSafeInt(params && params.y, 1024));
  const reEnter = Math.max(0, toSafeInt(params && params.reEnter, 0));
  const rivalCost = ensurePlainObject(base.rivalCosts);
  const shouldConsumeRivalCost = info.stage === 2 && campId !== info.camp && reEnter === 0;
  if (shouldConsumeRivalCost && !consumeResource(player, rivalCost.id, rivalCost.count)) {
    return { tag: 6551, msgUid, data: null };
  }

  info.mapId = campId;
  info.line = line;
  info.transmitCd = nowMs + Math.max(0, toSafeInt(base.transmitCd, 10)) * 1000;
  info.stayTime = nowMs + Math.max(1, toSafeInt(base.baseStayTime, 600)) * 1000;

  const selfInfo = buildCrossRivalMapPlayer(player, player.playerId, x, y, info.camp, true);
  const players = [
    buildCrossRivalMapPlayer(player, 'cr_1001', x + 80, y + 40, info.camp, false),
    buildCrossRivalMapPlayer(player, 'cr_2001', x - 60, y + 30, ((info.camp + 1) % 4) + 1, false),
  ];

  const response = {
    tag: 6551,
    msgUid,
    data: {
      result: 0,
      mapId: campId,
      campId,
      line,
      selfInfo,
      players,
      visiblePlayers: [],
      collects: Object.values(info.boxMap).map((row) => clonePlain(row)),
      coreInfo: clonePlain(info.coreInfo),
      coreAtkInfo: [],
      wanderInfo: [],
      flagInfo: clonePlain(info.flagInfo),
      flagAtkInfo: [],
      campBuffLv: Math.max(0, toSafeInt(info.campInfoMap[campId] && info.campInfoMap[campId].buffLevel, 0)),
      score: 0,
      totalKill: 0,
      mutiKill: 0,
      avgPower: Math.max(1, toSafeInt(player.power, 0)),
      reborntime: info.rebornTime,
      stayTime: info.stayTime,
      invasionCd: info.invasionCd,
      transmitCd: info.transmitCd,
    },
  };
  await playerService.savePlayer(session.userId, player);
  if (shouldConsumeRivalCost) {
    const sync = buildItemSyncPacket(player, [rivalCost.id]);
    return sync ? [sync, response] : response;
  }
  return response;
}

async function handleCrossRivalMapLeave(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6551, msgUid: 0, data: { id: '' } };

  const info = ensureCrossRivalInfo(player);
  const id = String(player.playerId || '');
  info.mapId = -1;
  info.line = -1;
  info.stayTime = 0;
  await playerService.savePlayer(session.userId, player);
  return { tag: 6551, msgUid: 0, data: { id } };
}

async function handleCrossRivalMove(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6553, msgUid, data: { result: -1 } };

  const id = String(player.playerId || '');
  const nodes = ensureArray(params && params.nodes);
  const pos = ensurePlainObject(params && params.pos);
  const dest = ensurePlainObject(params && params.dest);
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 6552,
    msgUid: 0,
    data: {
      result: 0,
      id,
      pos,
      dest,
      nodes,
    },
  };
}

async function handleCrossRivalFly(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6554, msgUid, data: { result: -1 } };

  const nowMs = Date.now();
  const base = getCrossRivalBaseConfig();
  const info = ensureCrossRivalInfo(player);
  info.transmitCd = nowMs + Math.max(0, toSafeInt(base.transmitCd, 10)) * 1000;
  const x = Math.max(0, toSafeInt(params && params.x, 0));
  const y = Math.max(0, toSafeInt(params && params.y, 0));
  const nodes = ensureArray(params && params.nodes);

  await playerService.savePlayer(session.userId, player);
  return [
    { tag: 6554, msgUid, data: { result: 0, time: info.transmitCd } },
    {
      tag: 6553,
      msgUid: 0,
      data: { id: String(player.playerId || ''), x, y, nodes },
    },
  ];
}

async function handleCrossRivalMapPlayerCount(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6555, msgUid, data: { result: -1 } };

  const info = ensureCrossRivalInfo(player);
  const camp = Math.max(1, toSafeInt(params && params.camp, info.mapId));
  const count = {};
  const coreScore = {};
  for (let line = 0; line < info.lineCount; line += 1) {
    count[line] = info.mapId === camp && info.line === line ? 1 : 0;
    coreScore[line] = Math.max(0, toSafeInt(info.coreScore, 0));
  }
  info.mapLinePlayerCount[camp] = { count, coreScore };

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6555,
    msgUid,
    data: {
      result: 0,
      camp,
      count,
      coreScore,
    },
  };
}

async function handleCrossRivalBoxOpen(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6556, msgUid, data: { result: -1 } };

  const info = ensureCrossRivalInfo(player);
  const collect = ensureCrossRivalCollect(info, params && params.collectId);
  const sceneType = Math.max(1, Math.floor(collect.id / 100));
  const collectDuration = Math.max(0, toSafeInt(getSceneItemConfig(sceneType).attTime, 0)) * 1000;
  collect.status = 1;
  collect.collectTime = collectDuration;
  collect.time = Date.now() + collectDuration;
  collect.playerId = String(player.playerId || '');
  collect.name = player.name || '';

  await playerService.savePlayer(session.userId, player);
  return { tag: 6556, msgUid, data: { result: 0, collect } };
}

async function handleCrossRivalRobBox(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6557, msgUid, data: { result: -1 } };

  const info = ensureCrossRivalInfo(player);
  const collect = ensureCrossRivalCollect(info, params && params.collectId);
  const sceneType = Math.max(1, Math.floor(collect.id / 100));
  const collectDuration = Math.max(0, toSafeInt(getSceneItemConfig(sceneType).attTime, 0)) * 1000;
  collect.status = 2;
  collect.collectTime = collectDuration;
  collect.time = Date.now() + collectDuration;
  collect.playerId = String(player.playerId || '');
  collect.name = player.name || '';

  const collectScore = Math.max(0, toSafeInt(getSceneItemConfig(sceneType).income, 0));
  info.score += collectScore;
  info.taskProgress[2] = Math.max(0, toSafeInt(info.taskProgress[2], 0)) + collectScore;
  const camp = info.campInfoMap[info.camp];
  if (camp) camp.score = Math.max(0, toSafeInt(camp.score, 0)) + collectScore;
  await playerService.savePlayer(session.userId, player);
  const response = { tag: 6557, msgUid, data: { result: 0, collect } };
  const bloodPush = {
    tag: 6557,
    msgUid: 0,
    data: {
      id: collect.id,
      type: collect.status,
      bloodper: 0,
    },
  };
  const collectPush = {
    tag: 6559,
    msgUid: 0,
    data: {
      score: collectScore,
      type: sceneType,
    },
  };
  return [response, bloodPush, collectPush];
}

async function handleCrossRivalBoxCancel(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6558, msgUid, data: { result: -1 } };

  const info = ensureCrossRivalInfo(player);
  const collect = ensureCrossRivalCollect(info, params && params.collectId);
  collect.status = 0;
  collect.time = Date.now();

  await playerService.savePlayer(session.userId, player);
  return { tag: 6558, msgUid, data: { result: 0, collect } };
}

async function handleCrossRivalEnter(_params, session, msgUid) {
  const player = session.player;
  if (!player) return null;

  const info = ensureCrossRivalInfo(player);
  await playerService.savePlayer(session.userId, player);
  return { tag: 6500, msgUid: 0, data: buildCrossRivalInitPayload(info) };
}

async function handleCrossRivalLeave(_params, session, msgUid) {
  const player = session.player;
  if (!player) return null;

  const info = ensureCrossRivalInfo(player);
  const camps = Object.values(info.campInfoMap)
    .map((row) => clonePlain(row))
    .sort((left, right) => toSafeInt(right.score, 0) - toSafeInt(left.score, 0));
  camps.forEach((row, index) => { row.rank = index + 1; });
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6502,
    msgUid: 0,
    data: {
      camps,
      score: Math.max(0, toSafeInt(info.score, 0)),
      sort: camps.map((row) => Math.max(1, toSafeInt(row.camp, 1))),
    },
  };
}

async function handleCrossRivalChat(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6562, msgUid, data: { result: -1 } };

  const info = ensureCrossRivalInfo(player);
  const row = {
    reportId: '',
    content: params && params.content != null ? String(params.content) : '',
    reply: params && params.reply ? {
      time: Math.max(0, toSafeInt(params.reply.time, 0)),
      playerId: String(params.reply.playerId || ''),
    } : null,
    time: Date.now(),
    summary: {
      dbid: String(player.playerId || ''),
      name: player.name || '',
      avatar: Math.max(0, toSafeInt(player.avatar, 11300)),
      avatarFrame: Math.max(-1, toSafeInt(player.avatarFrame, -1)),
      level: Math.max(1, toSafeInt(player.level, 1)),
      title: Math.max(0, toSafeInt(player.title, 0)),
      camp: info.camp,
      serverId: 1,
    },
  };
  info.chatList.push(row);
  if (info.chatList.length > 100) info.chatList = info.chatList.slice(info.chatList.length - 100);

  await playerService.savePlayer(session.userId, player);
  return [
    { tag: 6562, msgUid, data: { result: 0 } },
    { tag: 6501, msgUid: 0, data: { info: row } },
  ];
}

function buildCrossRivalPlayerRankRows(player, info) {
  const rows = [
    {
      dbid: String(player.playerId || ''),
      name: player.name || '',
      level: Math.max(1, toSafeInt(player.level, 1)),
      camp: info.camp,
      score: Math.max(0, toSafeInt(info.score, 0)),
      power: Math.max(100, toSafeInt(player.power, 1000)),
      serverId: 1,
      avatar: Math.max(0, toSafeInt(player.avatar, 11300)),
      avatarUrl: player.avatarUrl || '',
      avatarFrame: Math.max(-1, toSafeInt(player.avatarFrame, -1)),
      title: Math.max(0, toSafeInt(player.title, 0)),
      kungfuId: Math.max(1, toSafeInt(player.kungfuId, toSafeInt(player.roleInfo && player.roleInfo.kungfuId, 4))),
    },
  ];
  for (let i = 1; i <= 19; i++) {
    rows.push({
      dbid: `cr_rank_${i}`,
      name: `�������${i}`,
      level: Math.max(1, toSafeInt(player.level, 1) + ((i % 5) - 2)),
      camp: ((info.camp + i) % 4) + 1,
      score: 1200 - i * 20,
      power: 1200 + i * 80,
      serverId: 1,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  rows.forEach((row, idx) => { row.rank = idx + 1; });
  return rows;
}

async function handleCrossRivalPlayerRankInfo(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6563, msgUid, data: { result: -1, list: [] } };

  const info = ensureCrossRivalInfo(player);
  const rankList = buildCrossRivalPlayerRankRows(player, info);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6563,
    msgUid,
    data: {
      result: 0,
      list: rankList,
    },
  };
}

async function handleCrossRivalCampRankInfo(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6564, msgUid, data: { result: -1, list: [] } };

  const info = ensureCrossRivalInfo(player);
  const campRank = Object.values(info.campInfoMap).map((row) => ({
    camp: Math.max(1, toSafeInt(row.camp, 1)),
    score: Math.max(0, toSafeInt(row.score, 0)),
    flag: Math.max(0, toSafeInt(row.flag, 0)),
    core: Math.max(0, toSafeInt(row.core, 0)),
    rank: Math.max(0, toSafeInt(row.rank, 0)),
  }));
  campRank.sort((a, b) => b.score - a.score);
  campRank.forEach((row, idx) => { row.rank = idx + 1; });
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 6564,
    msgUid,
    data: {
      result: 0,
      list: campRank,
    },
  };
}

async function handleCrossRivalPlayerDefRankInfo(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6565, msgUid, data: { result: -1, list: [] } };

  const info = ensureCrossRivalInfo(player);
  const rankList = buildCrossRivalPlayerRankRows(player, info).map((row) => ({
    ...row,
    defend: Math.max(0, row.score - 900),
  }));
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6565,
    msgUid,
    data: {
      result: 0,
      list: rankList,
    },
  };
}

async function handleCrossRivalTaskReward(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6566, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]), taskIds: [] } };

  const info = ensureCrossRivalInfo(player);
  const type = Math.max(1, toSafeInt(params && params.type, 1));
  const claims = resolveCrossRivalTaskClaims(info, type);
  info.taskRecord = Array.from(new Set([
    ...info.taskRecord,
    ...claims.taskIds,
  ])).sort((a, b) => a - b);
  const rewardInfo = grantRewardInfo(player, claims.rewards);

  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 6566,
    msgUid,
    data: {
      result: 0,
      taskIds: claims.taskIds,
      rewardInfo,
    },
  };
  const sync = buildItemSyncPacket(player, claims.rewards.map((row) => row.id));
  return sync ? [sync, response] : response;
}

async function handleCrossRivalCampInfo(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6567, msgUid, data: { result: -1, campInfoMap: {} } };

  const info = ensureCrossRivalInfo(player);
  info.campInfoMap = normalizeCrossRivalCampInfoMap(info.campInfoMap);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6567,
    msgUid,
    data: {
      result: 0,
      campInfoMap: info.campInfoMap,
    },
  };
}

function buildCrossRivalDetailPayload(player, id) {
  const base = buildPlayer500Data({
    ...player,
    playerId: String(id),
    name: String(player.name || 'cross').startsWith('���') ? player.name : `������${String(id).slice(-4)}`,
  });
  return {
    ...base,
    id: String(id),
    playerId: String(id),
    dbid: String(id),
    serverId: 1,
  };
}

async function handleCrossRivalDefenderDetail(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6568, msgUid, data: {} };

  const id = params && params.id != null ? params.id : player.playerId;
  await playerService.savePlayer(session.userId, player);
  return { tag: 6568, msgUid, data: buildCrossRivalDetailPayload(player, id) };
}

async function handleCrossRivalWandersDetail(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6569, msgUid, data: {} };

  const id = params && params.id != null ? params.id : player.playerId;
  await playerService.savePlayer(session.userId, player);
  return { tag: 6569, msgUid, data: buildCrossRivalDetailPayload(player, id) };
}

function resolveCrossRivalFightSceneType(raidType) {
  switch (Math.max(0, toSafeInt(raidType, 0))) {
    case 61: return 5;
    case 62: return 4;
    case 63: return 3;
    default: return 0;
  }
}

function resolveCrossRivalFightScore(raidType, attacker) {
  if (!attacker) return 0;
  const sceneType = resolveCrossRivalFightSceneType(raidType);
  const scene = getSceneItemConfig(sceneType);
  return Math.max(0, toSafeInt(scene.income, 0));
}

async function handleCrossRivalStartFight(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6570, msgUid, data: { result: -1 } };

  const info = ensureCrossRivalInfo(player);
  info.rebornTime = 0;
  const raidType = Math.max(61, toSafeInt(params && params.raidType, 61));
  const targetId = params && params.targetId != null ? String(params.targetId) : '';
  const fightResult = buildCrossRivalFightResult(player, raidType, targetId);
  session.lastCrossRivalFight = {
    raidType,
    targetId,
    attacker: info.mapId === info.camp ? 0 : 1,
    enemyName: fightResult.entitys && fightResult.entitys[1] ? String(fightResult.entitys[1].name || '') : '魔灵入侵者',
  };
  const taskChanged = !!addCrossRivalChallengeCount(player, 1);

  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 6570,
    msgUid,
    data: {
      result: 0,
      raidType,
      targetId,
    },
  };
  const push = {
    tag: 6570,
    msgUid: 0,
    data: { fightInfo: { fightResult } },
  };
  const packets = taskChanged ? buildTaskSyncPackets(player) : [];
  packets.push(response, push);
  return packets;
}

async function handleCrossRivalFinishFight(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6571, msgUid, data: { result: -1 } };

  const info = ensureCrossRivalInfo(player);
  const lastFight = session.lastCrossRivalFight || {};
  const attacker = Math.max(0, Math.min(1, toSafeInt(lastFight.attacker, 0)));
  const raidType = Math.max(61, toSafeInt(lastFight.raidType, 61));
  const scoreInc = resolveCrossRivalFightScore(raidType, attacker === 1);
  const base = getCrossRivalBaseConfig();
  const rewardItems = [];
  const rewardInfo = buildRewardInfo(rewardItems);
  if (attacker === 1 && scoreInc > 0) {
    info.score += scoreInc;
    info.coreScore = info.score;
    info.taskProgress[2] = Math.max(0, toSafeInt(info.taskProgress[2], 0)) + scoreInc;
    const camp = info.campInfoMap[info.camp];
    if (camp) camp.score = Math.max(0, toSafeInt(camp.score, 0)) + scoreInc;
  }
  const pushPackets = [];
  if (attacker === 1 && raidType === 62) {
    const damage = Math.max(1, toSafeInt(base.flagDefenderReduce, toSafeInt(base.coreDefenderReduce, 1500)));
    info.flagInfo.hp = Math.max(0, toSafeInt(info.flagInfo.hp, 0) - damage);
    const camp = info.campInfoMap[info.camp];
    if (camp && info.flagInfo.hp <= 0) {
      camp.flag = Math.max(0, toSafeInt(camp.flag, 0) - 1);
      info.flagInfo.hp = Math.max(0, toSafeInt(base.initialFlagBlood, 200000));
    }
    pushPackets.push({
      tag: 6577,
      msgUid: 0,
      data: {
        camp: info.camp,
        flag: Math.max(0, toSafeInt(camp && camp.flag, 0)),
      },
    });
    pushPackets.push({
      tag: 6578,
      msgUid: 0,
      data: { damage, isCrit: 0 },
    });
  }
  if (attacker === 1 && raidType === 63 && scoreInc > 0) {
    pushPackets.push({
      tag: 6575,
      msgUid: 0,
      data: { addScore: scoreInc, assist: 1 },
    });
  }
  info.taskProgress[3] = Math.max(0, toSafeInt(info.taskProgress[3], 0)) + 1;
  session.lastCrossRivalFight = null;
  const taskPackets = buildTaskSyncPackets(player);

  await playerService.savePlayer(session.userId, player);
  const packets = [];
  packets.push({
    tag: 6571,
    msgUid: 0,
    data: {
      result: 0,
      assistScore: info.assistScore,
      raidType,
      enemyName: String(lastFight.enemyName || '魔灵入侵者'),
      isWin: 1,
      attacker,
      scoreInc,
      rewards: rewardItems,
      rewardInfo,
      sinLv: Math.max(0, toSafeInt(info.sinLv, 0)),
    },
  });
  packets.push(...taskPackets);
  packets.push({
    tag: 6561,
    msgUid: 0,
    data: {
      id: String(player.playerId || ''),
      sinLv: Math.max(0, toSafeInt(info.sinLv, 0)),
    },
  });
  packets.push(...pushPackets);
  return packets;
}

async function handleCrossRivalMapRevive(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6572, msgUid, data: { result: -1 } };

  const info = ensureCrossRivalInfo(player);
  const base = getCrossRivalBaseConfig();
  const type = Math.max(0, toSafeInt(params && params.type, 0));
  const cost = ensurePlainObject(type === 0 ? base.reviveTransmitCost : base.reviveCost);
  if (!consumeResource(player, cost.id, cost.count)) {
    return { tag: 6572, msgUid, data: { result: 1 } };
  }
  const nowMs = Date.now();
  const invincibleRows = ensureArray(base.invincibleTime);
  const protectTime = nowMs + Math.max(0, toSafeInt(invincibleRows[0], 0)) * 1000;
  info.rebornTime = 0;

  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 6572,
    msgUid,
    data: {
      result: 0,
      type,
      x: Math.max(0, toSafeInt(params && params.x, 0)),
      y: Math.max(0, toSafeInt(params && params.y, 0)),
      rebornTime: 0,
    },
  };
  const push = {
    tag: 6562,
    msgUid: 0,
    data: {
      id: String(player.playerId || ''),
      bloodPer: 10000,
      speedUp: 0,
      status: 0,
      targetId: '',
      sinLv: Math.max(0, toSafeInt(info.sinLv, 0)),
      explode: 0,
      protectTime,
    },
  };
  const sync = buildItemSyncPacket(player, [cost.id]);
  return sync ? [sync, response, push] : [response, push];
}

async function handleCrossRivalUseItem(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6573, msgUid, data: { result: -1, effects: {} } };

  const info = ensureCrossRivalInfo(player);
  const itemId = Math.max(0, toSafeInt(params && params.itemId, 0));
  const prop = getConfigTable('CrossRivalPropConfig')[itemId]
    || getConfigTable('CrossRivalPropConfig')[String(itemId)];
  if (!prop) return { tag: 6573, msgUid, data: { result: 1, effects: {}, itemCD: 0 } };
  const nowMs = Date.now();
  const itemCD = Math.max(0, toSafeInt(info.itemCd[itemId], 0));
  if (itemCD > nowMs) return { tag: 6573, msgUid, data: { result: 1, effects: {}, itemCD } };
  if (!consumeResource(player, itemId, 1)) {
    return { tag: 6573, msgUid, data: { result: 1, effects: {}, itemCD: 0 } };
  }
  const cooldownMs = Math.max(0, toSafeInt(prop.useCd, 0)) * 1000;
  const nextItemCD = nowMs + cooldownMs;
  info.itemCd[itemId] = nextItemCD;
  const effectConfig = getConfigTable('CrossRivalEffectConfig');
  const effects = {};
  ensureArray(prop.effect).forEach((effectId) => {
    const effect = ensurePlainObject(effectConfig[effectId] || effectConfig[String(effectId)]);
    const effectValue = ensureArray(effect.effect);
    const duration = Math.max(0, toSafeInt(effect.duration, 0));
    let value;
    if (duration > 0) value = nowMs + duration * 1000;
    else if (toSafeInt(effectId, 0) === 7) value = Math.max(1, toSafeInt(info.effects[effectId], 0) + 1);
    else value = Math.max(0, toSafeInt(effectValue[1], 0));
    info.effects[effectId] = value;
    effects[effectId] = value;
  });

  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 6573,
    msgUid,
    data: {
      result: 0,
      itemCD: nextItemCD,
      effects,
    },
  };
  const sync = buildItemSyncPacket(player, [itemId]);
  return sync ? [sync, response] : response;
}

async function handleCrossRivalPlayerDetail(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6575, msgUid, data: {} };

  const id = params && params.id != null ? params.id : player.playerId;
  await playerService.savePlayer(session.userId, player);
  return { tag: 6575, msgUid, data: buildCrossRivalDetailPayload(player, id) };
}

async function handleCrossRivalCoreAttack(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6580, msgUid, data: { result: -1 } };

  const info = ensureCrossRivalInfo(player);
  const coreId = Math.max(1, toSafeInt(params && params.core, 1));
  const nowMs = Date.now();
  const scene = getSceneItemConfig(3);
  const base = getCrossRivalBaseConfig();
  const atkTime = Math.max(0, toSafeInt(scene.attTime, 10)) * 1000;
  const time = nowMs + atkTime;
  const damage = Math.max(1, toSafeInt(base.coreDefenderReduce, 1500));
  const addScore = Math.max(0, toSafeInt(scene.income, 0));

  info.coreScore += addScore;
  info.score += addScore;
  info.taskProgress[2] = Math.max(0, toSafeInt(info.taskProgress[2], 0)) + addScore;
  info.coreInfo = ensureArray(info.coreInfo).map((row) => {
    const node = ensurePlainObject(row);
    if (toSafeInt(node.id, 0) === coreId) {
      node.hp = Math.max(0, toSafeInt(node.hp, toSafeInt(base.initialCoreBlood, 50000)) - damage);
      node.rebornTime = 0;
      node.score = Math.max(0, toSafeInt(node.score, 0) + addScore);
    }
    return node;
  });

  await playerService.savePlayer(session.userId, player);
  return [
    { tag: 6580, msgUid, data: { result: 0, core: coreId, time, atkTime } },
    {
      tag: 6563,
      msgUid: 0,
      data: { buffLv: Math.max(0, toSafeInt(info.campInfoMap[info.camp] && info.campInfoMap[info.camp].buffLevel, 0)) },
    },
    { tag: 6576, msgUid: 0, data: { damage, addScore, isCrit: 0 } },
    {
      tag: 6560,
      msgUid: 0,
      data: {
        collects: [],
        cores: clonePlain(info.coreInfo),
        coreOperates: [],
        defenders: [],
        wanders: [],
        addWanders: [],
        flagUpdate: clonePlain(info.flagInfo),
        flagOperates: [],
      },
    },
  ];
}

async function handleCrossRivalCoreCancel(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6581, msgUid, data: { result: -1 } };

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6581,
    msgUid,
    data: {
      result: 0,
      core: Math.max(1, toSafeInt(params && params.core, 1)),
    },
  };
}

async function handleCrossRivalEssenceOpen(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6582, msgUid, data: { result: -1 } };

  const info = ensureCrossRivalInfo(player);
  const nowMs = Date.now();
  const scene = getSceneItemConfig(4);
  const atkTime = Math.max(0, toSafeInt(scene.attTime, 10)) * 1000;
  info.essenceState.attacking = true;
  info.essenceState.endTime = nowMs + atkTime;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6582,
    msgUid,
    data: {
      result: 0,
      time: info.essenceState.endTime,
      atkTime,
    },
  };
}

async function handleCrossRivalEssenceCancel(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6583, msgUid, data: { result: -1 } };

  const info = ensureCrossRivalInfo(player);
  info.essenceState.attacking = false;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6583,
    msgUid,
    data: {
      result: 0,
    },
  };
}

module.exports = {
  ensureCrossRivalInfo,
  handleCrossRivalMapGetInfo,
  handleCrossRivalMapEnter,
  handleCrossRivalMapLeave,
  handleCrossRivalMove,
  handleCrossRivalFly,
  handleCrossRivalMapPlayerCount,
  handleCrossRivalBoxOpen,
  handleCrossRivalRobBox,
  handleCrossRivalBoxCancel,
  handleCrossRivalEnter,
  handleCrossRivalLeave,
  handleCrossRivalChat,
  handleCrossRivalPlayerRankInfo,
  handleCrossRivalCampRankInfo,
  handleCrossRivalPlayerDefRankInfo,
  handleCrossRivalTaskReward,
  handleCrossRivalCampInfo,
  handleCrossRivalDefenderDetail,
  handleCrossRivalWandersDetail,
  handleCrossRivalStartFight,
  handleCrossRivalFinishFight,
  handleCrossRivalMapRevive,
  handleCrossRivalUseItem,
  handleCrossRivalPlayerDetail,
  handleCrossRivalCoreAttack,
  handleCrossRivalCoreCancel,
  handleCrossRivalEssenceOpen,
  handleCrossRivalEssenceCancel,
};
