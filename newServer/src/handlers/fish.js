/**
 * Fishing handlers.
 * tag: 4000/4002/4004~4013/4015/4016/4020~4022/4050~4052
 */

const playerService = require('../services/PlayerService');
const configService = require('../services/ConfigService');
const {
  addFishCount,
  addFishOrderCompleteCount,
  addFishRodUpgradeCount,
} = require('../services/MainTaskProgressService');
const { addRewardToPlayer } = require('./raid');

const FISH_DEAL_TYPE = {
  PUT_IN: 0,
  SUBMIT: 1,
  SHELL: 2,
  LEGACY_SUBMIT: 3,
};

const DEFAULT_FISH_ID = 5011;
const DEFAULT_FISH_BAIT_ID = 5501;
const DEFAULT_FISH_ROD_ID = 5901;
const FISH_BAIT_SYNC_ITEM_ID = 65;
const FISH_COIN_ITEM_ID = 68;
const FISH_CRYSTAL_ITEM_ID = 69;
const DEFAULT_FISH_ORDER_IDS = [80001, 80015, 80046];
const DEFAULT_FISH_ORDER_CONFIG = {
  80001: { id: 80001, type: 43, fishType: 2, count: 5, star: 1, rewards: [{ id: FISH_CRYSTAL_ITEM_ID, count: 2 }] },
  80015: { id: 80015, type: 41, fishType: 1, count: 1, star: 1, rewards: [{ id: FISH_CRYSTAL_ITEM_ID, count: 2 }] },
  80046: { id: 80046, type: 42, fishType: DEFAULT_FISH_ID, count: 2, star: 3, rewards: [{ id: FISH_CRYSTAL_ITEM_ID, count: 6 }] },
};
const DEFAULT_FISH_CONFIG = {
  [DEFAULT_FISH_ID]: { id: DEFAULT_FISH_ID, type: 1, quality: 2, exp: 10, minAttrs: [[1, 1000, 1]] },
};
const DEFAULT_FISH_SCENE_CONFIG = {
  1: { id: 1, isActivity: 0 },
  2: { id: 2, isActivity: 0 },
  3: { id: 3, isActivity: 0 },
  4: { id: 4, isActivity: 0 },
  5: { id: 5, isActivity: 0 },
  6: { id: 6, isActivity: 0 },
  7: { id: 7, isActivity: 0 },
  101: { id: 101, isActivity: 1 },
  201: { id: 201, isActivity: 1 },
  301: { id: 301, isActivity: 1 },
  401: { id: 401, isActivity: 1 },
  501: { id: 501, isActivity: 1 },
};
const FISH_BASKET_TYPE_MIN = 1;
const FISH_BASKET_TYPE_MAX = 10;
const TRUCK_FISH_TYPES = new Set([101, 102, 103, 105, 106, 107, 108, 109]);

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function isClientFishId(id) {
  const safeId = Math.max(0, toSafeInt(id, 0));
  return safeId >= 5000 && safeId < 5900;
}

function isFishBasketType(type) {
  const safeType = Math.max(0, toSafeInt(type, 0));
  return safeType >= FISH_BASKET_TYPE_MIN && safeType <= FISH_BASKET_TYPE_MAX;
}

function normalizeFishBasketType(type, fallback = 1) {
  const safeType = Math.max(0, toSafeInt(type, 0));
  if (isFishBasketType(safeType)) return safeType;
  const fallbackType = Math.max(0, toSafeInt(fallback, 1));
  return isFishBasketType(fallbackType) ? fallbackType : 1;
}

function normalizeFishSkills(skills) {
  return ensureArray(skills)
    .map((row) => Math.max(0, toSafeInt(row && typeof row === 'object' ? row.id : row, 0)))
    .filter((id, index, arr) => id > 0 && arr.indexOf(id) === index);
}

function normalizeExistingFishAttrs(attrs) {
  return ensureArray(attrs)
    .map((row) => {
      const source = Array.isArray(row)
        ? { type: row[0], value: row[1], level: row[2] }
        : ensurePlainObject(row);
      const type = Math.max(1, toSafeInt(source.type != null ? source.type : source.id, 0));
      const value = Math.max(0, toSafeInt(source.value != null ? source.value : source.val, 0));
      const level = Math.max(1, toSafeInt(source.level, 1));
      if (type <= 0 || value <= 0) return null;
      return { type, level, value };
    })
    .filter(Boolean);
}

function ensurePlainObject(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...fallback };
  }
  return value;
}

function getRoleAppearanceHelpers() {
  try {
    return require('../services/RoleAppearanceService');
  } catch (_err) {
    return {
      ensureRoleAppearance: () => null,
      getPlayerFashionMap: (player = {}) => ensurePlainObject(player.fashionMap),
      getPrimaryBattlePetId: (player = {}) => Math.max(0, toSafeInt(player.petId, 0)),
    };
  }
}

function buildFishMapPlayer(player = {}, info = {}, pos = 1) {
  const {
    ensureRoleAppearance,
    getPlayerFashionMap,
    getPrimaryBattlePetId,
  } = getRoleAppearanceHelpers();
  ensureRoleAppearance(player);
  const roleInfo = ensurePlainObject(player.roleInfo);
  const equipInfo = ensurePlainObject(player.equipInfo);
  const equipSetMap = ensurePlainObject(equipInfo.equipSetMap);
  const equipMap = ensurePlainObject(equipSetMap[String(Math.max(0, toSafeInt(equipInfo.curIndex, 0)))]);
  return {
    dbid: String(player.playerId || player.userId || player._id || ''),
    serverId: Math.max(0, toSafeInt(player.serverId, toSafeInt(process.env.SERVER_ID, 1))),
    serverName: String(player.serverName || process.env.SERVER_NAME || ''),
    kungfuId: Math.max(1, toSafeInt(roleInfo.kungfuId, 4)),
    subJob: Math.max(0, toSafeInt(roleInfo.subJob, 0)),
    level: Math.max(1, toSafeInt(player.level, 1)),
    name: String(player.name || ''),
    power: Math.max(0, toSafeInt(player.power, 0)),
    stage: Math.max(1, toSafeInt(roleInfo.stage, toSafeInt(roleInfo.stageId, 1))),
    petId: getPrimaryBattlePetId(player),
    petSoulId: Math.max(-1, toSafeInt(player.petSoulId, -1)),
    artifactId: Math.max(0, toSafeInt(player.artifactId, 0)),
    fate: Math.max(0, toSafeInt(player.fate, 0)),
    foreverCard: Math.max(0, toSafeInt(player.foreverCard, 0)),
    equipMap,
    fashionMap: getPlayerFashionMap(player),
    avatar: Math.max(0, toSafeInt(player.avatar, toSafeInt(roleInfo.avatar, 0))),
    avatarUrl: String(player.avatarUrl || roleInfo.avatarUrl || ''),
    avatarFrame: Math.max(0, toSafeInt(player.avatarFrame, toSafeInt(roleInfo.avatarFrame, 0))),
    title: Math.max(0, toSafeInt(player.title, toSafeInt(roleInfo.title, 0))),
    pos: Math.max(1, toSafeInt(pos, 1)),
    rodId: normalizeFishRodId(info.rodId),
    raftId: normalizeFishRaftId(info.raftId),
    food: normalizeFishBaitId(info.food),
  };
}

function buildFishRodUpdatePacket(info = {}, switchRod = 0) {
  return {
    tag: 4010,
    msgUid: 0,
    data: {
      exp: Math.max(0, toSafeInt(info.rodExp, 0)),
      level: Math.max(0, toSafeInt(info.rodLevel, 0)),
      rank: Math.max(1, toSafeInt(info.rodRank, 1)),
      rodId: normalizeFishRodId(info.rodId),
      switchRod: switchRod ? 1 : 0,
    },
  };
}

function buildFishMapOtherEnterPacket(player = {}, info = {}, mapId, pos = 1) {
  return {
    tag: 4051,
    msgUid: 0,
    data: {
      mapId: normalizeFishSceneId(mapId, info.scene || 1),
      mapPlayer: buildFishMapPlayer(player, info, pos),
    },
  };
}

function buildFishPlayerEmojiPacket(playerId, index) {
  return {
    tag: 4053,
    msgUid: 0,
    data: {
      id: String(playerId == null ? '' : playerId),
      index: Math.max(0, toSafeInt(index, 0)),
    },
  };
}

function buildFishOtherRaftSwitchPacket(playerId, raftId) {
  return {
    tag: 4063,
    msgUid: 0,
    data: {
      id: String(playerId == null ? '' : playerId),
      raftId: normalizeFishRaftId(raftId),
    },
  };
}

function broadcastFishRoomPacket(session = {}, packet) {
  if (!packet || typeof session._broadcastExceptUser !== 'function') return;
  session._broadcastExceptUser(packet.tag, packet.data);
}

function pickOne(rows = []) {
  if (!Array.isArray(rows) || rows.length <= 0) return null;
  return rows[Math.floor(Math.random() * rows.length)];
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

function buildRewardInfo(items = []) {
  return {
    items: normalizeRewards(items),
    equips: [],
    extra: [],
  };
}

function grantRewards(player, rows = []) {
  const rewards = normalizeRewards(rows);
  rewards.forEach((row) => addRewardToPlayer(player, row.id, row.count));
  return rewards;
}

function getItemCount(player = {}, itemId) {
  const id = Math.max(0, toSafeInt(itemId, 0));
  if (id <= 0) return 0;
  const items = ensurePlainObject(player.items);
  return Math.max(0, toSafeInt(items[id] != null ? items[id] : items[String(id)], 0));
}

function consumeItem(player = {}, itemId, count) {
  const id = Math.max(0, toSafeInt(itemId, 0));
  const safeCount = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || safeCount <= 0 || getItemCount(player, id) < safeCount) return false;
  player.items = ensurePlainObject(player.items);
  player.items[id] = Math.max(0, getItemCount(player, id) - safeCount);
  return true;
}

function buildItemSync(player = {}, deltas = []) {
  const deltaMap = new Map();
  ensureArray(deltas).forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = toSafeInt(row && row.count, 0);
    if (id <= 0 || count === 0) return;
    deltaMap.set(id, (deltaMap.get(id) || 0) + count);
  });
  const items = Array.from(deltaMap.entries())
    .map(([id, count]) => ({ id, count }))
    .filter((row) => row.count !== 0)
    .sort((a, b) => a.id - b.id);
  const changed = items.map((row) => ({ id: row.id, count: getItemCount(player, row.id) }));
  return { items, changed };
}

function normalizeCost(row) {
  const source = Array.isArray(row) ? { id: row[0], count: row[1] } : ensurePlainObject(row);
  const id = Math.max(0, toSafeInt(source.id, 0));
  const count = Math.max(0, toSafeInt(source.count, 0));
  return id > 0 && count > 0 ? { id, count } : null;
}

function buildTaskUpdatePacketsSafe(player, msgUid = 0) {
  try {
    const task = require('./task');
    if (task && typeof task.buildActiveTaskUpdatePackets === 'function') {
      return task.buildActiveTaskUpdatePackets(player, msgUid);
    }
  } catch (_err) {}
  return [];
}

function getFishConfigMap() {
  const raw = ensurePlainObject(configService.get('FishConfig'));
  if (Object.keys(raw).length > 0) return raw;
  return DEFAULT_FISH_CONFIG;
}

function getFishOrderConfigMap() {
  const raw = ensurePlainObject(configService.get('FishOrderConfig'));
  if (Object.keys(raw).length > 0) return raw;
  return DEFAULT_FISH_ORDER_CONFIG;
}

function getFishOrderConfigById(orderId, fallbackIndex = 0) {
  const safeOrderId = Math.max(1, toSafeInt(orderId, 0));
  const cfgMap = getFishOrderConfigMap();
  const fallbackId = DEFAULT_FISH_ORDER_IDS[Math.max(0, fallbackIndex) % DEFAULT_FISH_ORDER_IDS.length];
  const cfg = ensurePlainObject(
    cfgMap[safeOrderId]
      || cfgMap[String(safeOrderId)]
      || cfgMap[fallbackId]
      || cfgMap[String(fallbackId)]
      || DEFAULT_FISH_ORDER_CONFIG[fallbackId],
  );
  return {
    id: Math.max(1, toSafeInt(cfg.id, fallbackId)),
    type: Math.max(41, toSafeInt(cfg.type, 41)),
    fishType: Math.max(1, toSafeInt(cfg.fishType, 1)),
    count: Math.max(1, toSafeInt(cfg.count, 1)),
    star: Math.max(1, toSafeInt(cfg.star, 1)),
    rewards: normalizeRewards(ensureArray(cfg.rewards)),
  };
}

function getFishRodGradeConfig(rank) {
  const map = ensurePlainObject(configService.get('FishRodGradeConfig'));
  const safeRank = Math.max(1, toSafeInt(rank, 1));
  return ensurePlainObject(map[safeRank] || map[String(safeRank)] || {
    id: safeRank,
    level: safeRank * 10,
    exp: 100,
    levelUpCost: { id: FISH_COIN_ITEM_ID, count: 1 },
    gradeUpCost: { id: FISH_CRYSTAL_ITEM_ID, count: 10 * safeRank },
  });
}

function getFishRaftGradeConfig(rank) {
  const map = ensurePlainObject(configService.get('FishRaftGradeConfig'));
  const safeRank = Math.max(1, toSafeInt(rank, 1));
  return ensurePlainObject(map[safeRank] || map[String(safeRank)] || {
    id: safeRank,
    level: safeRank * 10,
    exp: 100,
    levelUpCost: { id: FISH_COIN_ITEM_ID, count: 1 },
    gradeUpCost: { id: FISH_CRYSTAL_ITEM_ID, count: 15 * safeRank },
  });
}

function getFishRodUpgradeCost(info = {}) {
  const rank = Math.max(1, toSafeInt(info.rodRank, 1));
  const level = Math.max(0, toSafeInt(info.rodLevel, 0));
  const row = getFishRodGradeConfig(rank);
  const maxLevel = Math.max(1, toSafeInt(row.level, rank * 10));
  const cost = level >= maxLevel
    ? normalizeCost(row.gradeUpCost) || { id: FISH_CRYSTAL_ITEM_ID, count: 10 * rank }
    : normalizeCost(row.levelUpCost) || { id: FISH_COIN_ITEM_ID, count: 1 };
  return { cost, isGradeUp: level >= maxLevel, row, maxLevel };
}

function getFishRaftUpgradeCost(info = {}) {
  const rank = Math.max(1, toSafeInt(info.raftRank, 1));
  const level = Math.max(0, toSafeInt(info.raftLevel, 0));
  const row = getFishRaftGradeConfig(rank);
  const maxLevel = Math.max(1, toSafeInt(row.level, rank * 10));
  const cost = level >= maxLevel
    ? normalizeCost(row.gradeUpCost) || { id: FISH_CRYSTAL_ITEM_ID, count: 15 * rank }
    : normalizeCost(row.levelUpCost) || { id: FISH_COIN_ITEM_ID, count: 1 };
  return { cost, isGradeUp: level >= maxLevel, row, maxLevel };
}

function getFishSceneConfigMap() {
  const raw = ensurePlainObject(configService.get('FishSceneConfig'));
  if (Object.keys(raw).length > 0) return raw;
  return DEFAULT_FISH_SCENE_CONFIG;
}

function isValidFishSceneId(sceneId) {
  const id = Math.max(0, toSafeInt(sceneId, 0));
  if (id <= 0) return false;
  const cfgMap = getFishSceneConfigMap();
  return !!(cfgMap[id] || cfgMap[String(id)]);
}

function getFishSceneConfig(sceneId) {
  const id = Math.max(0, toSafeInt(sceneId, 0));
  const cfgMap = getFishSceneConfigMap();
  return ensurePlainObject(cfgMap[id] || cfgMap[String(id)]);
}

function normalizeFishSceneId(sceneId, fallback = 1) {
  const id = Math.max(0, toSafeInt(sceneId, 0));
  if (isValidFishSceneId(id)) return id;
  const safeFallback = Math.max(1, toSafeInt(fallback, 1));
  return isValidFishSceneId(safeFallback) ? safeFallback : 1;
}

function normalizeMainFishSceneId(sceneId, fallback = 1) {
  const id = normalizeFishSceneId(sceneId, fallback);
  const cfg = getFishSceneConfig(id);
  if (!cfg.isActivity) return id;
  const safeFallback = normalizeFishSceneId(fallback, 1);
  return getFishSceneConfig(safeFallback).isActivity ? 1 : safeFallback;
}

function normalizeFishEnterSceneId(sceneId, fallback = 1) {
  const id = normalizeFishSceneId(sceneId, fallback);
  const cfg = getFishSceneConfig(id);
  return cfg.isActivity ? 1 : id;
}

function getFishBaseValue(key, fallback) {
  const cfg = ensurePlainObject(configService.get('FishBaseConfig'));
  return Math.max(0, toSafeInt(cfg[key], fallback));
}

function getInitialFishBaitId() {
  return getFishBaseValue('initFishBaitId', DEFAULT_FISH_BAIT_ID) || DEFAULT_FISH_BAIT_ID;
}

function getValidFishConfigId(configName, requestedId, fallbackId) {
  const cfgMap = ensurePlainObject(configService.get(configName));
  const id = Math.max(0, toSafeInt(requestedId, 0));
  if (id > 0 && (cfgMap[id] || cfgMap[String(id)])) return id;
  const fallback = Math.max(0, toSafeInt(fallbackId, 0));
  if (fallback > 0 && (cfgMap[fallback] || cfgMap[String(fallback)])) return fallback;
  const first = Object.keys(cfgMap).map((key) => toSafeInt(key, 0)).filter((key) => key > 0).sort((a, b) => a - b)[0];
  return first || fallback || id;
}

function normalizeFishBaitId(id) {
  return getValidFishConfigId('FishBaitConfig', id, DEFAULT_FISH_BAIT_ID) || DEFAULT_FISH_BAIT_ID;
}

function getInitialFishRodId() {
  return getValidFishConfigId('FishRodConfig', getFishBaseValue('initFishRodId', DEFAULT_FISH_ROD_ID), DEFAULT_FISH_ROD_ID) || DEFAULT_FISH_ROD_ID;
}

function getInitialFishRaftId() {
  return getValidFishConfigId('FishRaftConfig', getFishBaseValue('initFishRaftId', 0), 0);
}

function normalizeFishRodId(id) {
  return getValidFishConfigId('FishRodConfig', id, getInitialFishRodId()) || getInitialFishRodId();
}

function normalizeFishRaftId(id) {
  return getValidFishConfigId('FishRaftConfig', id, getInitialFishRaftId()) || getInitialFishRaftId();
}

function getFishTypeById(fishId, fallback = 1) {
  const cfg = getFishConfigMap()[fishId] || getFishConfigMap()[String(fishId)];
  return Math.max(1, toSafeInt(cfg && cfg.type, fallback));
}

function getFishQualityById(fishId, fallback = 1) {
  const cfg = getFishConfigMap()[fishId] || getFishConfigMap()[String(fishId)];
  return Math.max(1, toSafeInt(cfg && cfg.quality, fallback));
}

function pickFishIdByType(type = 1) {
  const wantedType = normalizeFishBasketType(type, 1);
  const cfgMap = getFishConfigMap();
  const rows = Object.values(cfgMap);
  const matched = rows.filter((row) => (
    toSafeInt(row && row.type, 0) === wantedType
    && isClientFishId(row && row.id)
  ));
  const picked = pickOne(matched);
  if (picked && toSafeInt(picked.id, 0) > 0) {
    return toSafeInt(picked.id, DEFAULT_FISH_ID);
  }
  const fallback = rows.find((row) => isClientFishId(row && row.id) && isFishBasketType(row && row.type));
  return Math.max(1, toSafeInt(fallback && fallback.id, DEFAULT_FISH_ID));
}

function pickFishingFishId() {
  const cfgMap = getFishConfigMap();
  const rows = Object.values(cfgMap).filter((row) => isClientFishId(row && row.id) && isFishBasketType(row && row.type));
  const picked = pickOne(rows);
  return Math.max(1, toSafeInt(picked && picked.id, DEFAULT_FISH_ID));
}

function buildFishAttrs(fishCfg, multi) {
  const source = ensureArray(fishCfg && fishCfg.minAttrs).length > 0
    ? ensureArray(fishCfg && fishCfg.minAttrs)
    : DEFAULT_FISH_CONFIG[DEFAULT_FISH_ID].minAttrs;
  return source
    .map((row) => {
      if (!Array.isArray(row) || row.length < 2) return null;
      const type = Math.max(1, toSafeInt(row[0], 0));
      const baseValue = Math.max(1, toSafeInt(row[1], 1));
      const level = Math.max(1, toSafeInt(row[2], 1));
      return {
        type,
        level,
        value: Math.max(1, Math.floor(baseValue * Math.max(1, toSafeInt(multi, 10000)) / 10000)),
      };
    })
    .filter(Boolean);
}

function getFishExpById(fishId) {
  const cfgMap = getFishConfigMap();
  const cfg = ensurePlainObject(cfgMap[fishId] || cfgMap[String(fishId)]);
  return Math.max(1, toSafeInt(cfg.exp, 10));
}

function applyFishingExp(info, expGain) {
  info.level = Math.max(1, toSafeInt(info.level, 1));
  info.exp = Math.max(0, toSafeInt(info.exp, 0)) + Math.max(0, toSafeInt(expGain, 0));
  const levelConfig = ensurePlainObject(configService.get('FishLevelConfig'));
  let guard = 0;
  while (guard < 1000) {
    guard += 1;
    const cfg = levelConfig[info.level] || levelConfig[String(info.level)];
    const needExp = Math.max(0, toSafeInt(cfg && cfg.exp, 0));
    if (needExp <= 0 || info.exp < needExp) break;
    info.exp -= needExp;
    info.level += 1;
  }
}

function consumeFishBait(player, info, count) {
  const safeCount = Math.max(1, toSafeInt(count, 1));
  player.items = ensurePlainObject(player.items);
  const foodId = Math.max(0, toSafeInt(info && info.food, 0));
  const costId = foodId > 0 && getItemCount(player, foodId) >= safeCount
    ? foodId
    : FISH_BAIT_SYNC_ITEM_ID;
  if (!consumeItem(player, costId, safeCount)) return null;
  return { id: costId, count: -safeCount };
}

function buildFishingResult(info, count) {
  const fishInfos = [];
  let expGain = 0;
  const safeCount = Math.max(1, Math.min(10, toSafeInt(count, 1)));

  for (let i = 0; i < safeCount; i += 1) {
    const fishId = pickFishingFishId();
    const fish = buildFishEntity(info, fishId);
    fishInfos.push(fish);
    expGain += getFishExpById(fishId);
  }

  applyFishingExp(info, expGain);
  const result = {
    time: Date.now(),
    fishInfos,
    escapes: [],
    items: [],
    fashion: [],
  };
  info.fishResult = result;
  return result;
}

function ensureOrder(info, index) {
  const safeIndex = Math.max(0, toSafeInt(index, 0));
  const fallbackId = DEFAULT_FISH_ORDER_IDS[safeIndex % DEFAULT_FISH_ORDER_IDS.length];
  while (info.orders.length <= safeIndex) {
    info.orders.push({ id: fallbackId, progress: 0, received: false });
  }
  const row = ensurePlainObject(info.orders[safeIndex], {
    id: fallbackId,
    progress: 0,
    received: false,
  });
  const cfg = getFishOrderConfigById(row.id, safeIndex);
  row.id = cfg.id;
  row.progress = Math.max(0, Math.min(toSafeInt(row.progress, 0), cfg.count));
  row.received = !!row.received;
  info.orders[safeIndex] = row;
  return row;
}

function isTruckFishType(type) {
  return TRUCK_FISH_TYPES.has(Math.max(0, toSafeInt(type, 0)));
}

function doesFishMatchOrder(fish, cfg) {
  if (!fish || !cfg || isTruckFishType(fish.type)) return false;
  const fishType = Math.max(1, toSafeInt(fish.type, getFishTypeById(fish.id, 1)));
  const fishId = Math.max(1, toSafeInt(fish.id, 0));
  const fishQuality = Math.max(1, toSafeInt(fish.quality, getFishQualityById(fishId, 1)));
  const target = Math.max(1, toSafeInt(cfg.fishType, 1));

  if (cfg.type === 41) return fishType === target;
  if (cfg.type === 42) return fishId === target;
  if (cfg.type === 43) return fishQuality === target;
  return false;
}

function applyFishToDailyOrders(info, fish) {
  const updated = [];
  ensureArray(info.orders).forEach((_row, index) => {
    const order = ensureOrder(info, index);
    const cfg = getFishOrderConfigById(order.id, index);
    if (order.received || order.progress >= cfg.count || !doesFishMatchOrder(fish, cfg)) return;
    order.progress = Math.min(cfg.count, order.progress + 1);
    updated.push(index);
  });
  return updated;
}

function ensureShipLog(info, id) {
  info.shipLogs = ensurePlainObject(info.shipLogs);
  const key = String(Math.max(1, toSafeInt(id, 1)));
  const row = ensurePlainObject(info.shipLogs[key], {
    id: Math.max(1, toSafeInt(id, 1)),
    exp: 0,
    record: [],
    time: 0,
  });
  row.id = Math.max(1, toSafeInt(row.id, Math.max(1, toSafeInt(id, 1))));
  row.exp = Math.max(0, toSafeInt(row.exp, 0));
  row.record = ensureArray(row.record).map((v) => Math.max(0, toSafeInt(v, 0)));
  row.time = Math.max(0, toSafeInt(row.time, 0));
  info.shipLogs[key] = row;
  return row;
}

function ensureSlot(info, type) {
  const safeType = normalizeFishBasketType(type, 1);
  const key = String(safeType);
  const row = ensurePlainObject(info.slots[key], {
    id: 0,
    uid: 0,
    type: safeType,
    quality: 1,
    lock: 0,
    dead: 0,
  });
  row.id = Math.max(0, toSafeInt(row.id, 0));
  row.uid = Math.max(0, toSafeInt(row.uid, 0));
  row.type = normalizeFishBasketType(row.type, safeType);
  row.quality = Math.max(1, toSafeInt(row.quality, 1));
  row.lock = row.lock ? 1 : 0;
  row.dead = row.dead ? 1 : 0;
  info.slots[key] = row;
  return row;
}

function buildFishEntity(info, fishId, overrides = {}) {
  info.fishUidSeq = Math.max(1, toSafeInt(info.fishUidSeq, 1000));
  const overrideUid = Math.max(0, toSafeInt(overrides.uid, 0));
  const uid = overrideUid > 0 ? overrideUid : info.fishUidSeq++;
  if (info.fishUidSeq <= uid) info.fishUidSeq = uid + 1;
  const cfgMap = getFishConfigMap();
  let id = Math.max(1, toSafeInt(fishId, pickFishIdByType(1)));
  let cfg = ensurePlainObject(cfgMap[id] || cfgMap[String(id)]);
  if (!cfg.id && !isClientFishId(id) && Object.keys(cfgMap).length > 0) {
    id = pickFishIdByType(normalizeFishBasketType(overrides.type, 1));
    cfg = ensurePlainObject(cfgMap[id] || cfgMap[String(id)]);
  }
  const type = normalizeFishBasketType(overrides.type, getFishTypeById(id, 1));
  const multi = Math.max(1, toSafeInt(overrides.multi, 10000 + Math.floor(Math.random() * 2000)));
  const normalizedAttrs = normalizeExistingFishAttrs(overrides.attrs);
  const attrs = normalizedAttrs.length > 0 ? normalizedAttrs : buildFishAttrs(cfg, multi);
  return {
    uid,
    id,
    type,
    quality: Math.max(1, toSafeInt(overrides.quality, getFishQualityById(id, 1))),
    multi,
    attrs,
    skills: normalizeFishSkills(overrides.skills),
    tempSkills: ensurePlainObject(overrides.tempSkills),
    lock: overrides.lock ? 1 : 0,
    dead: overrides.dead ? 1 : 0,
  };
}

function normalizeFishSlots(info) {
  info.slots = ensurePlainObject(info.slots);
  const normalized = {};
  Object.keys(info.slots).forEach((typeKey) => {
    const row = ensurePlainObject(info.slots[typeKey]);
    const id = Math.max(0, toSafeInt(row.id, 0));
    if (!isClientFishId(id)) return;
    const type = normalizeFishBasketType(row.type, toSafeInt(typeKey, 1));
    normalized[String(type)] = buildFishEntity(info, id, { ...row, type });
  });
  info.slots = normalized;
}

function ensureFishInfo(player) {
  if (!player || typeof player !== 'object') {
    return {
      scene: 0,
      level: 1,
      exp: 0,
      food: getInitialFishBaitId(),
      foodBag: [],
      fishResult: { time: 0, fishInfos: [], escapes: [], items: [], fashion: [] },
      catchResult: { time: 0, infos: [], escapes: [], items: [], sailItems: {} },
      slots: {},
      orders: [],
      pics: {},
      extraPrice: {},
      fishTypeQualityPic: {},
      fetters: [],
      shipLogs: {},
      fishSoulSlots: {},
      fishSoulPic: {},
      rodId: getInitialFishRodId(),
      rodLevel: 0,
      rodRank: 1,
      rodExp: 0,
      rodAttrs: [],
      rodTempAttrs: [],
      raftId: getInitialFishRaftId(),
      raftLevel: 0,
      raftRank: 1,
      raftExp: 0,
      fishUidSeq: 1000,
    };
  }

  player.fishInfo = ensurePlainObject(player.fishInfo);
  const info = player.fishInfo;
  info.scene = normalizeFishSceneId(info.scene, 1);
  info.level = Math.max(1, toSafeInt(info.level, 1));
  info.exp = Math.max(0, toSafeInt(info.exp, 0));
  info.food = normalizeFishBaitId(info.food);
  info.foodBag = ensureArray(info.foodBag)
    .map((v) => normalizeFishBaitId(v))
    .filter((v, index, arr) => v > 0 && arr.indexOf(v) === index);
  info.fishResult = ensurePlainObject(info.fishResult, { time: 0, fishInfos: [], escapes: [], items: [], fashion: [] });
  info.fishResult.time = Math.max(0, toSafeInt(info.fishResult.time, 0));
  info.fishResult.escapes = ensureArray(info.fishResult.escapes);
  info.fishResult.items = ensureArray(info.fishResult.items);
  info.fishResult.fashion = ensureArray(info.fishResult.fashion);
  info.fishResult.fishInfos = ensureArray(info.fishResult.fishInfos)
    .map((row) => ensurePlainObject(row))
    .filter((row) => toSafeInt(row.uid, 0) > 0 && toSafeInt(row.id, 0) > 0)
    .map((row) => buildFishEntity(info, row.id, row));
  info.catchResult = ensurePlainObject(info.catchResult, { time: 0, infos: [], escapes: [], items: [], sailItems: {} });
  info.catchResult.time = Math.max(0, toSafeInt(info.catchResult.time, 0));
  info.catchResult.infos = ensureArray(info.catchResult.infos);
  info.catchResult.escapes = ensureArray(info.catchResult.escapes);
  info.catchResult.items = ensureArray(info.catchResult.items);
  info.catchResult.sailItems = ensurePlainObject(info.catchResult.sailItems);
  normalizeFishSlots(info);
  info.orders = ensureArray(info.orders);
  info.pics = ensurePlainObject(info.pics);
  info.extraPrice = ensurePlainObject(info.extraPrice);
  info.fishTypeQualityPic = ensurePlainObject(info.fishTypeQualityPic);
  info.fishSoulSlots = ensurePlainObject(info.fishSoulSlots);
  info.fishSoulPic = ensurePlainObject(info.fishSoulPic);
  info.fetters = ensureArray(info.fetters).map((v) => Math.max(0, toSafeInt(v, 0))).filter((v) => v > 0);
  info.shipLogs = ensurePlainObject(info.shipLogs);
  info.rodId = normalizeFishRodId(info.rodId);
  info.rodLevel = Math.max(0, toSafeInt(info.rodLevel, 0));
  info.rodRank = Math.max(1, toSafeInt(info.rodRank, 1));
  info.rodExp = Math.max(0, toSafeInt(info.rodExp, 0));
  info.rodAttrs = ensureArray(info.rodAttrs);
  info.rodTempAttrs = ensureArray(info.rodTempAttrs);
  info.raftId = normalizeFishRaftId(info.raftId);
  info.raftLevel = Math.max(0, toSafeInt(info.raftLevel, 0));
  info.raftRank = Math.max(1, toSafeInt(info.raftRank, 1));
  info.raftExp = Math.max(0, toSafeInt(info.raftExp, 0));
  info.fishUidSeq = Math.max(1, toSafeInt(info.fishUidSeq, 1000));

  if (info.orders.length < 3) {
    for (let i = info.orders.length; i < 3; i++) {
      info.orders.push({ id: DEFAULT_FISH_ORDER_IDS[i % DEFAULT_FISH_ORDER_IDS.length], progress: 0, received: false });
    }
  }
  info.orders = info.orders.map((row, index) => {
    const fallbackId = DEFAULT_FISH_ORDER_IDS[index % DEFAULT_FISH_ORDER_IDS.length];
    const item = ensurePlainObject(row, { id: fallbackId, progress: 0, received: false });
    const cfg = getFishOrderConfigById(item.id, index);
    return {
      id: cfg.id,
      progress: Math.max(0, Math.min(toSafeInt(item.progress, 0), cfg.count)),
      received: !!item.received,
    };
  });

  return info;
}

function findFishIndexByUid(info, uid) {
  const safeUid = Math.max(1, toSafeInt(uid, 0));
  return info.fishResult.fishInfos.findIndex((row) => toSafeInt(row && row.uid, 0) === safeUid);
}

async function handleFishCatch(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 4000,
      msgUid,
      data: {
        result: -1,
        bigger: 0,
        level: 1,
        exp: 0,
        fishResult: { time: 0, fishInfos: [], escapes: [], items: [], fashion: [] },
        food: getInitialFishBaitId(),
      },
    };
  }

  const info = ensureFishInfo(player);
  const count = Math.max(1, Math.min(10, toSafeInt(params && params.count, 1)));
  const baitDelta = consumeFishBait(player, info, count);
  if (!baitDelta) {
    return {
      tag: 4000,
      msgUid,
      data: {
        result: -1,
        bigger: 0,
        level: info.level,
        exp: info.exp,
        fishResult: info.fishResult,
        food: info.food || getInitialFishBaitId(),
      },
    };
  }
  const fishResult = buildFishingResult(info, count);
  const taskChanged = !!addFishCount(player, count);

  await playerService.savePlayer(session.userId, player);

  const response = {
    tag: 4000,
    msgUid,
    data: {
      result: 0,
      bigger: fishResult.fishInfos.length > 0 ? 1 : 0,
      level: info.level,
      exp: info.exp,
      fishResult,
      food: info.food || getInitialFishBaitId(),
    },
  };

  return [
    { tag: 1202, data: buildItemSync(player, [baitDelta]) },
    ...(taskChanged ? buildTaskUpdatePacketsSafe(player) : []),
    response,
  ];
}

function applyRodUpgradeProgress(info = {}, upgradeMeta = {}) {
  const row = ensurePlainObject(upgradeMeta.row);
  const isGradeUp = !!upgradeMeta.isGradeUp;
  if (isGradeUp) {
    info.rodRank = Math.max(1, toSafeInt(info.rodRank, 1)) + 1;
    info.rodExp = 0;
    return;
  }

  const needExp = Math.max(1, toSafeInt(row.exp, 100));
  info.rodExp = Math.max(0, toSafeInt(info.rodExp, 0)) + 1;
  while (info.rodExp >= needExp && info.rodLevel < Math.max(1, toSafeInt(row.level, info.rodLevel + 1))) {
    info.rodExp -= needExp;
    info.rodLevel += 1;
  }
}

function applyRaftUpgradeProgress(info = {}, upgradeMeta = {}) {
  const row = ensurePlainObject(upgradeMeta.row);
  const isGradeUp = !!upgradeMeta.isGradeUp;
  if (isGradeUp) {
    info.raftRank = Math.max(1, toSafeInt(info.raftRank, 1)) + 1;
    info.raftExp = 0;
    return;
  }

  const needExp = Math.max(1, toSafeInt(row.exp, 100));
  info.raftExp = Math.max(0, toSafeInt(info.raftExp, 0)) + 1;
  while (info.raftExp >= needExp && info.raftLevel < Math.max(1, toSafeInt(row.level, info.raftLevel + 1))) {
    info.raftExp -= needExp;
    info.raftLevel += 1;
  }
}

function runGearUpgrade(player, info, options) {
  const getCost = options.getCost;
  const applyProgress = options.applyProgress;
  const getLevel = options.getLevel;
  const getRank = options.getRank;
  const upgradeAll = !!options.upgradeAll;
  const startLevel = getLevel(info);
  const startRank = getRank(info);
  const deltas = [];
  let times = 0;

  while (times < 10000) {
    const meta = getCost(info);
    const cost = meta && meta.cost ? meta.cost : null;
    if (!cost || !consumeItem(player, cost.id, cost.count)) break;
    deltas.push({ id: cost.id, count: -cost.count });
    applyProgress(info, meta);
    times += 1;
    if (!upgradeAll) break;
    if (getLevel(info) > startLevel || getRank(info) > startRank) break;
  }

  return { times, deltas };
}

async function handleFishChangeScene(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4002, msgUid, data: { result: -1, id: 0 } };

  const info = ensureFishInfo(player);
  info.scene = normalizeMainFishSceneId(params && params.id, info.scene || 1);
  await playerService.savePlayer(session.userId, player);
  return { tag: 4002, msgUid, data: { result: 0, id: info.scene } };
}

async function handleFishActiveIllue(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4004, msgUid, data: { result: -1, rewards: [] } };

  const info = ensureFishInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, 1));
  if (!info.fetters.includes(id)) info.fetters.push(id);
  const rewards = grantRewards(player, [{ id: 1, count: 5 }, { id: 2, count: 50 }]);
  await playerService.savePlayer(session.userId, player);
  return { tag: 4004, msgUid, data: { result: 0, rewards } };
}

async function handleFishShipLogUpgrade(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4005, msgUid, data: { result: -1, id: 0, exp: 0, time: 0 } };

  const info = ensureFishInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, 1));
  const count = Math.max(1, toSafeInt(params && params.count, 1));
  const row = ensureShipLog(info, id);
  row.exp += count;
  row.time = Date.now();

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4005,
    msgUid,
    data: {
      result: 0,
      id: row.id,
      exp: row.exp,
      time: row.time,
    },
  };
}

async function handleFishShipLogReward(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4006, msgUid, data: { result: -1, id: 0, record: [], rewardInfo: buildRewardInfo([]) } };

  const info = ensureFishInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, 1));
  const row = ensureShipLog(info, id);
  const stage = Math.max(1, Math.floor(row.exp / 10));
  if (!row.record.includes(stage)) row.record.push(stage);
  row.record.sort((a, b) => a - b);
  const rewards = grantRewards(player, [{ id: 128, count: Math.max(1, stage) }]);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4006,
    msgUid,
    data: {
      result: 0,
      id: row.id,
      record: ensureArray(row.record),
      rewardInfo: buildRewardInfo(rewards),
    },
  };
}

async function handleFishBaitBagUpdate(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4007, msgUid, data: { result: -1, curFood: 0 } };

  const info = ensureFishInfo(player);
  const nextFoodBag = ensureArray(params && params.foodBag)
    .map((v) => normalizeFishBaitId(v))
    .filter((v, index, arr) => v > 0 && arr.indexOf(v) === index);
  if (nextFoodBag.length > 0) {
    info.foodBag = nextFoodBag;
  }

  const requestedFood = Math.max(0, toSafeInt(
    params && (params.food != null ? params.food : (params.curFood != null ? params.curFood : params.id)),
    0,
  ));
  const nextFood = normalizeFishBaitId(requestedFood > 0 ? requestedFood : (nextFoodBag[0] || info.food || getInitialFishBaitId()));
  info.food = nextFood;
  if (nextFood > 0 && !info.foodBag.includes(nextFood)) {
    info.foodBag.unshift(nextFood);
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4007,
    msgUid,
    data: {
      result: 0,
      curFood: info.food,
      food: info.food,
      foodBag: ensureArray(info.foodBag),
    },
  };
}

async function handleFishDealMulti(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 4008,
      msgUid,
      data: { result: -1, orders: [], fails: [], fishInfos: [], rewards: [], extraPrice: {} },
    };
  }

  const info = ensureFishInfo(player);
  const dealMap = ensurePlainObject(params && params.dealMap);
  const orders = [];
  const fails = [];
  const fishInfos = [];
  const rewardRows = [];

  Object.keys(dealMap).forEach((typeKey) => {
    const dealType = Math.max(0, toSafeInt(typeKey, 0));
    const uidList = ensureArray(dealMap[typeKey]).map((v) => Math.max(0, toSafeInt(v, 0))).filter((v) => v > 0);
    uidList.forEach((uid) => {
      const fishIdx = findFishIndexByUid(info, uid);
      if (fishIdx < 0) {
        fails.push(uid);
        return;
      }
      const fish = ensurePlainObject(info.fishResult.fishInfos[fishIdx]);
      info.fishResult.fishInfos.splice(fishIdx, 1);

      if (dealType === FISH_DEAL_TYPE.PUT_IN) {
        const type = normalizeFishBasketType(fish.type, getFishTypeById(fish.id, 1));
        const slot = ensureSlot(info, type);
        slot.id = Math.max(1, toSafeInt(fish.id, slot.id));
        slot.uid = Math.max(1, toSafeInt(fish.uid, slot.uid));
        slot.quality = Math.max(1, toSafeInt(fish.quality, slot.quality));
        slot.dead = 0;

        const spawned = buildFishEntity(info, pickFishIdByType(type), { type });
        info.fishResult.fishInfos.push(spawned);
        fishInfos.push(spawned);
      } else if (dealType === FISH_DEAL_TYPE.SHELL) {
        rewardRows.push({ id: FISH_COIN_ITEM_ID, count: Math.max(1, toSafeInt(fish.quality, 1)) });
      } else if (dealType === FISH_DEAL_TYPE.SUBMIT || dealType === FISH_DEAL_TYPE.LEGACY_SUBMIT) {
        const updatedOrders = applyFishToDailyOrders(info, fish);
        if (updatedOrders.length > 0) {
          orders.push(...updatedOrders);
          rewardRows.push({ id: FISH_COIN_ITEM_ID, count: Math.max(1, toSafeInt(fish.quality, 1)) });
        } else {
          info.fishResult.fishInfos.splice(fishIdx, 0, fish);
          fails.push(uid);
        }
      } else {
        info.fishResult.fishInfos.splice(fishIdx, 0, fish);
        fails.push(uid);
      }
    });
  });

  const rewards = grantRewards(player, rewardRows);
  const rewardSync = rewards.length > 0 ? { tag: 1202, msgUid: 0, data: buildItemSync(player, rewards) } : null;
  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 4008,
    msgUid,
    data: {
      result: 0,
      orders: orders.slice().sort((a, b) => a - b),
      fails: Array.from(new Set(fails)).sort((a, b) => a - b),
      fishInfos,
      rewards,
      extraPrice: ensurePlainObject(info.extraPrice),
    },
  };
  return rewardSync ? [rewardSync, response] : response;
}

async function handleFishLock(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4009, msgUid, data: { result: -1 } };

  const info = ensureFishInfo(player);
  const type = Math.max(1, toSafeInt(params && params.type, 1));
  const lock = params && params.lock ? 1 : 0;
  const slot = ensureSlot(info, type);
  slot.lock = lock;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4009,
    msgUid,
    data: {
      result: 0,
      type,
      lock,
    },
  };
}

async function handleFishRodUpgrade(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4010, msgUid, data: { result: -1, exp: 0, level: 0, rank: 1 } };

  const info = ensureFishInfo(player);
  const upgrade = runGearUpgrade(player, info, {
    upgradeAll: params && params.upgradeAll,
    getCost: getFishRodUpgradeCost,
    applyProgress: applyRodUpgradeProgress,
    getLevel: (row) => Math.max(0, toSafeInt(row.rodLevel, 0)),
    getRank: (row) => Math.max(1, toSafeInt(row.rodRank, 1)),
  });
  if (upgrade.times <= 0) {
    return {
      tag: 4010,
      msgUid,
      data: { result: -1, exp: info.rodExp, level: info.rodLevel, rank: info.rodRank },
    };
  }

  const taskChanged = upgrade.times > 0 ? !!addFishRodUpgradeCount(player, 1) : false;
  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 4010,
    msgUid,
    data: {
      result: 0,
      exp: info.rodExp,
      level: info.rodLevel,
      rank: info.rodRank,
    },
  };
  return [
    { tag: 1202, msgUid: 0, data: buildItemSync(player, upgrade.deltas) },
    buildFishRodUpdatePacket(info, 0),
    ...(taskChanged ? buildTaskUpdatePacketsSafe(player) : []),
    response,
  ];
}

async function handleFishRodSwitch(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4011, msgUid, data: { result: -1, id: 0 } };

  const info = ensureFishInfo(player);
  info.rodId = normalizeFishRodId(params && params.id != null ? params.id : info.rodId);
  await playerService.savePlayer(session.userId, player);
  return { tag: 4011, msgUid, data: { result: 0, id: info.rodId } };
}

async function handleFishRodRefine(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4012, msgUid, data: { result: -1, rodTempAttrs: [] } };

  const info = ensureFishInfo(player);
  const levelBase = Math.max(1, info.rodLevel + info.rodRank);
  info.rodTempAttrs = [
    { id: 12, value: levelBase * 5 + Math.floor(Math.random() * 6) },
    { id: 15, value: levelBase * 3 + Math.floor(Math.random() * 5) },
  ];

  await playerService.savePlayer(session.userId, player);
  return { tag: 4012, msgUid, data: { result: 0, rodTempAttrs: ensureArray(info.rodTempAttrs) } };
}

async function handleFishRodSwitchAttr(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4013, msgUid, data: { result: -1 } };

  const info = ensureFishInfo(player);
  if (info.rodTempAttrs.length > 0) {
    info.rodAttrs = ensureArray(info.rodTempAttrs);
    info.rodTempAttrs = [];
  }
  await playerService.savePlayer(session.userId, player);
  return { tag: 4013, msgUid, data: { result: 0 } };
}

async function handleFishRaftUpgrade(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4015, msgUid, data: { result: -1, exp: 0, level: 0, rank: 0 } };

  const info = ensureFishInfo(player);
  const upgrade = runGearUpgrade(player, info, {
    upgradeAll: params && params.upgradeAll,
    getCost: getFishRaftUpgradeCost,
    applyProgress: applyRaftUpgradeProgress,
    getLevel: (row) => Math.max(0, toSafeInt(row.raftLevel, 0)),
    getRank: (row) => Math.max(1, toSafeInt(row.raftRank, 1)),
  });
  if (upgrade.times <= 0) {
    return { tag: 4015, msgUid, data: { result: -1, exp: info.raftExp, level: info.raftLevel, rank: info.raftRank } };
  }

  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 4015,
    msgUid,
    data: {
      result: 0,
      exp: info.raftExp,
      level: info.raftLevel,
      rank: info.raftRank,
    },
  };
  return [
    { tag: 1202, msgUid: 0, data: buildItemSync(player, upgrade.deltas) },
    response,
  ];
}

async function handleFishRaftSwitch(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4016, msgUid, data: { result: -1, id: 0 } };

  const info = ensureFishInfo(player);
  info.raftId = normalizeFishRaftId(params && params.id != null ? params.id : info.raftId);
  await playerService.savePlayer(session.userId, player);
  if (Math.max(0, toSafeInt(session._fishRoomMapId, 0)) > 0) {
    broadcastFishRoomPacket(session, buildFishOtherRaftSwitchPacket(
      player.playerId || player.userId || session.userId,
      info.raftId,
    ));
  }
  return { tag: 4016, msgUid, data: { result: 0, id: info.raftId } };
}

async function handleFishRefreshOrders(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4020, msgUid, data: { result: -1, id: 0 } };

  const info = ensureFishInfo(player);
  const index = Math.max(0, toSafeInt(params && params.index, 0));
  const order = ensureOrder(info, index);
  const nextId = DEFAULT_FISH_ORDER_IDS[index % DEFAULT_FISH_ORDER_IDS.length];
  order.id = getFishOrderConfigById(nextId, index).id;
  order.progress = 0;
  order.received = false;

  await playerService.savePlayer(session.userId, player);
  return { tag: 4020, msgUid, data: { result: 0, id: order.id } };
}

async function handleFishGetOrderReward(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4021, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };

  const info = ensureFishInfo(player);
  const index = Math.max(0, toSafeInt(params && params.index, 0));
  const order = ensureOrder(info, index);
  const cfg = getFishOrderConfigById(order.id, index);
  if (order.received || order.progress < cfg.count) {
    return { tag: 4021, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };
  }
  order.received = true;

  const orderRewards = cfg.rewards.length > 0
    ? cfg.rewards
    : [{ id: FISH_CRYSTAL_ITEM_ID, count: Math.max(1, cfg.star * 2) }];
  const rewards = grantRewards(player, orderRewards);
  const taskChanged = !!addFishOrderCompleteCount(player, 1);
  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 4021,
    msgUid,
    data: {
      result: 0,
      rewardInfo: buildRewardInfo(rewards),
    },
  };
  const rewardSync = rewards.length > 0 ? { tag: 1202, msgUid: 0, data: buildItemSync(player, rewards) } : null;
  return [
    ...(rewardSync ? [rewardSync] : []),
    ...(taskChanged ? buildTaskUpdatePacketsSafe(player) : []),
    response,
  ];
}

async function handleFishPriceReward(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4022, msgUid, data: { result: -1, rewards: [] } };

  const info = ensureFishInfo(player);
  const rewards = [];
  Object.keys(info.extraPrice).forEach((idKey) => {
    const id = Math.max(0, toSafeInt(idKey, 0));
    const count = Math.max(0, toSafeInt(info.extraPrice[idKey], 0));
    if (id > 0 && count > 0) rewards.push({ id, count });
  });
  if (rewards.length <= 0) rewards.push({ id: 68, count: 1 });
  const rows = grantRewards(player, rewards);
  info.extraPrice = {};

  await playerService.savePlayer(session.userId, player);
  return { tag: 4022, msgUid, data: { result: 0, rewards: rows } };
}

async function handleFishEnterMap(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4050, msgUid, data: { result: -1, id: 0 } };

  const info = ensureFishInfo(player);
  const requestedMapId = params && params.id != null ? params.id : info.scene;
  const mapId = params && params.id != null
    ? normalizeFishSceneId(requestedMapId, 1)
    : normalizeFishEnterSceneId(requestedMapId, 1);
  info.scene = mapId;
  session._fishRoomMapId = mapId;
  await playerService.savePlayer(session.userId, player);
  broadcastFishRoomPacket(session, buildFishMapOtherEnterPacket(player, info, mapId, 1));

  return [
    {
      tag: 4050,
      data: {
        mapId,
        time: Math.floor(Date.now() / 1000),
        pos: 1,
        food: info.food,
        raftId: info.raftId,
        rodId: info.rodId,
        players: [],
      },
    },
    { tag: 4050, msgUid, data: {} },
  ];
}

async function handleFishLeaveMap(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4051, msgUid, data: { result: -1 } };

  const info = ensureFishInfo(player);
  const mapId = Math.max(0, toSafeInt(session._fishRoomMapId, info.scene));
  const id = String(player.playerId || player.userId || session.userId || '');
  info.scene = 1;
  session._fishRoomMapId = 0;
  await playerService.savePlayer(session.userId, player);
  if (mapId > 0) {
    broadcastFishRoomPacket(session, {
      tag: 4052,
      msgUid: 0,
      data: { mapId, id },
    });
  }
  return { tag: 4051, msgUid, data: { result: 0 } };
}

async function handleFishMapEmoji(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4052, msgUid, data: { result: -1 } };

  const info = ensureFishInfo(player);
  const mapId = Math.max(0, toSafeInt(params && params.mapId, info.scene));
  const id = params && params.id != null ? String(params.id) : String(player.playerId || '');
  const index = Math.max(0, toSafeInt(params && params.index, 0));

  await playerService.savePlayer(session.userId, player);
  const emojiPush = buildFishPlayerEmojiPacket(id, index);
  broadcastFishRoomPacket(session, emojiPush);
  return [
    emojiPush,
    {
      tag: 4052,
      msgUid,
      data: {
        result: 0,
        mapId,
        id,
        index,
      },
    },
  ];
}

module.exports = {
  ensureFishInfo,
  buildFishMapPlayer,
  buildFishRodUpdatePacket,
  buildFishMapOtherEnterPacket,
  buildFishPlayerEmojiPacket,
  buildFishOtherRaftSwitchPacket,
  handleFishCatch,
  handleFishChangeScene,
  handleFishActiveIllue,
  handleFishShipLogUpgrade,
  handleFishShipLogReward,
  handleFishBaitBagUpdate,
  handleFishDealMulti,
  handleFishLock,
  handleFishRodUpgrade,
  handleFishRodSwitch,
  handleFishRodRefine,
  handleFishRodSwitchAttr,
  handleFishRaftUpgrade,
  handleFishRaftSwitch,
  handleFishRefreshOrders,
  handleFishGetOrderReward,
  handleFishPriceReward,
  handleFishEnterMap,
  handleFishLeaveMap,
  handleFishMapEmoji,
};
