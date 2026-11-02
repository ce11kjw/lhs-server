const configService = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const {
  addFarmHarvestCount,
  addFarmPlantCount,
  addFarmRobberFightCount,
  addFarmStealCount,
} = require('../services/MainTaskProgressService');
const { addRewardToPlayer } = require('./raid');
const { applyPrimaryBattlePetParts } = require('../services/RoleAppearanceService');

const COOK_SLOT_MAX = 2;
const FARM_PLAYER_SKILL_ID = 1002;
const FARM_PLAYER_BEHAVIOR_ID = 10020;

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function getNowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeFarmLogTime(value, fallback = getNowSeconds()) {
  const raw = toSafeInt(value, fallback);
  if (raw <= 0) return Math.max(0, fallback);
  // Client log panel expects second timestamps; convert legacy ms values on read.
  if (raw >= 1000000000000) return Math.floor(raw / 1000);
  return raw;
}

function clonePlain(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

function getPlantBaseConfig() {
  return configService.get('PlantBaseConfig') || {};
}

function getPlantConfig() {
  return configService.get('PlantConfig') || {};
}

function getPlantLevelConfig() {
  return configService.get('PlantLevelConfig') || {};
}

function getPlantBuildConfig() {
  return configService.get('PlantBuildConfig') || {};
}

function getPlantMagicConfig() {
  return configService.get('PlantMagicConfig') || {};
}

function getPlantTiredConfig() {
  return configService.get('PlantTiredConfig') || {};
}

function getPlantThiefConfig() {
  return configService.get('PlantThiefConfig') || {};
}

function getDefaultRatSkinId() {
  const thiefCfg = getPlantThiefConfig();
  if (thiefCfg[0] || thiefCfg['0']) return 0;
  const ids = Object.keys(thiefCfg)
    .map((id) => toSafeInt(id, 0))
    .filter((id) => id >= 0)
    .sort((a, b) => a - b);
  return ids.length > 0 ? ids[0] : 0;
}

function normalizeRatSkinId(value) {
  const id = Math.max(0, toSafeInt(value, 0));
  const thiefCfg = getPlantThiefConfig();
  if (thiefCfg[id] || thiefCfg[String(id)]) return id;
  return getDefaultRatSkinId();
}

function pickWeightedSeedReward(seedId) {
  const seedRewards = getPlantBaseConfig().seedRewards || {};
  const rows = Array.isArray(seedRewards[seedId] || seedRewards[String(seedId)])
    ? (seedRewards[seedId] || seedRewards[String(seedId)])
    : [];
  const candidates = rows
    .map((row) => ({
      id: Math.max(0, toSafeInt(row && row.id, 0)),
      weight: Math.max(0, toSafeInt(row && row.weight, 0)),
    }))
    .filter((row) => row.id > 0 && row.weight > 0);
  if (candidates.length <= 0) return 0;

  const totalWeight = candidates.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight <= 0) return candidates[0].id;

  let roll = Math.random() * totalWeight;
  for (const row of candidates) {
    roll -= row.weight;
    if (roll < 0) return row.id;
  }
  return candidates[candidates.length - 1].id;
}

function pickStableSeedReward(seedId) {
  const seedRewards = getPlantBaseConfig().seedRewards || {};
  const rows = Array.isArray(seedRewards[seedId] || seedRewards[String(seedId)])
    ? (seedRewards[seedId] || seedRewards[String(seedId)])
    : [];
  const candidates = rows
    .map((row) => ({
      id: Math.max(0, toSafeInt(row && row.id, 0)),
      weight: Math.max(0, toSafeInt(row && row.weight, 0)),
    }))
    .filter((row) => row.id > 0 && row.weight > 0)
    .sort((a, b) => (b.weight - a.weight) || (a.id - b.id));
  return candidates.length > 0 ? candidates[0].id : 0;
}

function resolvePlantRewardId(seedId) {
  const safeSeedId = Math.max(0, toSafeInt(seedId, 0));
  if (safeSeedId <= 0) return 0;
  if (getPlantConfig()[safeSeedId] || getPlantMagicConfig()[safeSeedId]) {
    return safeSeedId;
  }
  return pickWeightedSeedReward(safeSeedId);
}

function getPlantGrowConfigBySeed(seedId) {
  const rewardId = resolvePlantRewardId(seedId);
  if (rewardId <= 0) return null;
  const row = getPlantConfig()[rewardId] || getPlantMagicConfig()[rewardId] || null;
  if (!row) return null;
  return { rewardId, row };
}

function normalizeStoredPlantRewardId(rewardId) {
  const safeRewardId = Math.max(0, toSafeInt(rewardId, 0));
  if (safeRewardId <= 0) return 0;
  if (getPlantConfig()[safeRewardId] || getPlantMagicConfig()[safeRewardId]) {
    return safeRewardId;
  }
  return pickStableSeedReward(safeRewardId);
}

function createEmptyBlock(index) {
  return {
    index,
    rewardId: 0,
    finishTime: 0,
    matureFinishTime: 0,
    oldFinishTime: 0,
    curCount: 0,
    robber: null,
    robCount: 0,
    ratSkin: 0,
    oldRewardId: 0,
  };
}

function normalizeBlock(raw, index) {
  const block = raw && typeof raw === 'object' ? raw : {};
  const rewardId = normalizeStoredPlantRewardId(block.rewardId);
  const oldRewardId = normalizeStoredPlantRewardId(block.oldRewardId);
  return {
    index: toSafeInt(block.index, index),
    rewardId,
    finishTime: toSafeInt(block.finishTime, 0),
    matureFinishTime: Math.max(0, toSafeInt(block.matureFinishTime, 0)),
    oldFinishTime: toSafeInt(block.oldFinishTime, 0),
    curCount: toSafeInt(block.curCount, 0),
    robber: block.robber || null,
    robCount: Math.max(0, toSafeInt(block.robCount, 0)),
    ratSkin: normalizeRatSkinId(block.ratSkin),
    oldRewardId,
  };
}

function normalizeCookInfo(cookInfo) {
  const info = cookInfo && typeof cookInfo === 'object' ? cookInfo : {};
  const slots = {};
  for (let i = 0; i < COOK_SLOT_MAX; i += 1) {
    const raw = info[i] || info[String(i)] || {};
    slots[i] = {
      index: i,
      records: raw && typeof raw.records === 'object' && !Array.isArray(raw.records) ? raw.records : {},
      finishTime: Math.max(0, toSafeInt(raw.finishTime, 0)),
      reward: Math.max(0, toSafeInt(raw.reward, 0)),
      time: Math.max(0, toSafeInt(raw.time, 0)),
    };
  }
  return slots;
}

function syncCookSummary(farm) {
  const slots = farm && farm.cookInfo && typeof farm.cookInfo === 'object' ? farm.cookInfo : {};
  const active = Array.from({ length: COOK_SLOT_MAX }, (_row, index) => slots[index] || slots[String(index)])
    .find((slot) => slot && (toSafeInt(slot.finishTime, 0) > 0 || toSafeInt(slot.reward, 0) > 0));
  farm.cookFinishTime = Math.max(0, toSafeInt(active && active.finishTime, 0));
  farm.cookTime = Math.max(0, toSafeInt(active && active.time, 0));
  farm.cookReward = Math.max(0, toSafeInt(active && active.reward, 0));
}

function normalizeFarmLogEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const type = Math.max(1, toSafeInt(entry.type, 1));
  const rewards = Array.isArray(entry.rewards) ? entry.rewards : [];
  const firstReward = rewards.find((row) => row && toSafeInt(row.id, 0) > 0) || null;
  const rewardId = Math.max(0, toSafeInt(entry.rewardId, toSafeInt(firstReward && firstReward.id, 0)));
  const count = Math.max(0, toSafeInt(entry.count, toSafeInt(firstReward && firstReward.count, 0)));
  const blockId = Math.max(0, toSafeInt(entry.blockId, toSafeInt(entry.index, 0)));
  const time = normalizeFarmLogTime(entry.time);

  if (type === 1) {
    if (rewardId <= 0) return null;
    return { type: 1, blockId, rewardId, count, time };
  }

  const rawPlayer = entry.playerinfo && typeof entry.playerinfo === 'object' ? entry.playerinfo : {};
  const playerinfo = {
    dbid: String(rawPlayer.dbid || ''),
    name: String(rawPlayer.name || '道友'),
    level: Math.max(1, toSafeInt(rawPlayer.level, 1)),
    avatar: Math.max(0, toSafeInt(rawPlayer.avatar, 0)),
    avatarUrl: String(rawPlayer.avatarUrl || rawPlayer.avatarurl || ''),
  };
  if (rewardId <= 0) return null;
  return { type: type === 3 ? 3 : 2, blockId, rewardId, count, time, playerinfo };
}

function normalizeFarmLogList(logs) {
  return (Array.isArray(logs) ? logs : [])
    .map(normalizeFarmLogEntry)
    .filter(Boolean);
}

function buildFarmBattlePlayerInfo(player = {}, fallback = {}) {
  const source = player && typeof player === 'object' ? player : {};
  const roleInfo = source.roleInfo && typeof source.roleInfo === 'object' ? source.roleInfo : {};
  const fallbackInfo = fallback && typeof fallback === 'object' ? fallback : {};
  const level = Math.max(1, toSafeInt(source.level, toSafeInt(fallbackInfo.level, toSafeInt(fallbackInfo.lv, 1))));
  return {
    dbid: String(source.playerId || source.userId || fallbackInfo.dbid || ''),
    name: String(source.name || fallbackInfo.name || '道友'),
    avatar: Math.max(0, toSafeInt(roleInfo.avatar, toSafeInt(source.avatar, toSafeInt(fallbackInfo.avatar, 0)))),
    avatarUrl: String(source.avatarUrl || fallbackInfo.avatarUrl || fallbackInfo.avatarurl || ''),
    lv: level,
    level,
    power: Math.max(0, toSafeInt(source.power, toSafeInt(source.powerScore, toSafeInt(fallbackInfo.power, level * 100)))),
  };
}

function normalizeFarmBattlePlayerInfo(row = {}) {
  return buildFarmBattlePlayerInfo({}, row);
}

function normalizeFarmFightLogEntry(entry, selfPlayer = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const time = normalizeFarmLogTime(entry.time);
  const rawPlayerInfos = Array.isArray(entry.playerInfos) ? entry.playerInfos : [];
  const selfInfo = rawPlayerInfos[0]
    ? normalizeFarmBattlePlayerInfo(rawPlayerInfos[0])
    : buildFarmBattlePlayerInfo(selfPlayer);
  const otherInfo = rawPlayerInfos[1]
    ? normalizeFarmBattlePlayerInfo(rawPlayerInfos[1])
    : normalizeFarmBattlePlayerInfo(entry.playerinfo || { dbid: 'robber', name: '道友' });

  return {
    ...entry,
    type: Math.max(1, toSafeInt(entry.type, 1)),
    index: Math.max(0, toSafeInt(entry.index, 0)),
    count: Math.max(0, toSafeInt(entry.count, 0)),
    finishtime: Math.max(0, toSafeInt(entry.finishtime, 0)),
    time,
    isWin: entry.isWin == null ? true : !!entry.isWin,
    playerinfo: otherInfo,
    playerInfos: [selfInfo, otherInfo],
  };
}

function normalizeFarmFightLogList(logs, selfPlayer = {}) {
  return (Array.isArray(logs) ? logs : [])
    .map((row) => normalizeFarmFightLogEntry(row, selfPlayer))
    .filter(Boolean);
}

function getLocalDayKey(ts = Date.now()) {
  const date = new Date(ts);
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

function getMagicFieldIndexes() {
  const conds = Array.isArray(getPlantBaseConfig().magicFieldCond) ? getPlantBaseConfig().magicFieldCond : [];
  return conds.map((_, idx) => 100 + idx);
}

function isFarmBlockUnlocked(farm, index) {
  const safeIndex = toSafeInt(index, -1);
  if (safeIndex < 0) return false;
  const level = Math.max(1, toSafeInt(farm && farm.lv, 1));
  const baseCfg = getPlantBaseConfig();
  if (safeIndex >= 100) {
    const conds = Array.isArray(baseCfg.magicFieldCond) ? baseCfg.magicFieldCond : [];
    const needLv = Math.max(1, toSafeInt(conds[safeIndex - 100], Number.MAX_SAFE_INTEGER));
    return level >= needLv;
  }
  const conds = Array.isArray(baseCfg.fieldCondition) ? baseCfg.fieldCondition : [];
  const needLv = Math.max(1, toSafeInt(conds[safeIndex], Number.MAX_SAFE_INTEGER));
  return level >= needLv;
}

function normalizeRewardRows(rows = []) {
  const map = new Map();
  const list = Array.isArray(rows) ? rows : [];
  list.forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    map.set(id, (map.get(id) || 0) + count);
  });
  const items = [];
  map.forEach((count, id) => {
    items.push({ id, count });
  });
  items.sort((a, b) => a.id - b.id);
  return items;
}

function calcCookBaoziRewardCount() {
  const candidates = [
    { count: 5, weight: 40 },
    { count: 10, weight: 25 },
    { count: 15, weight: 15 },
    { count: 20, weight: 15 },
    { count: 25, weight: 5 },
  ];
  const totalWeight = candidates.reduce((sum, row) => sum + row.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const row of candidates) {
    roll -= row.weight;
    if (roll < 0) return row.count;
  }
  return 5;
}

function getCookDurationSecondsByDailyCount(dayCount = 0) {
  const nextCount = Math.max(1, toSafeInt(dayCount, 0));
  const secondsList = [
    30,
    60,
    90,
    120,
    150,
    180,
    300,
    600,
    900,
    1200,
    1800,
  ];
  if (nextCount <= secondsList.length) {
    return secondsList[nextCount - 1];
  }
  return 3600;
}

function mergeRewardRows(baseRows = [], appendRows = []) {
  return normalizeRewardRows([...(Array.isArray(baseRows) ? baseRows : []), ...(Array.isArray(appendRows) ? appendRows : [])]);
}

function buildRewardInfo(items = []) {
  return {
    items: normalizeRewardRows(items),
    equips: [],
  };
}

function normalizeSyncRows(rows = []) {
  const map = new Map();
  const list = Array.isArray(rows) ? rows : [];
  list.forEach((row) => {
    const id = toSafeInt(row && row.id, 0);
    const count = toSafeInt(row && row.count, 0);
    if (!id || !count) return;
    map.set(id, (map.get(id) || 0) + count);
  });

  return Array.from(map.entries())
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => a.id - b.id);
}

function getPlayerItemCount(player, itemId) {
  const id = toSafeInt(itemId, 0);
  if (!player || typeof player !== 'object' || id === 0) return 0;

  player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
  player.items = player.items || {};

  if (id === 1) return toSafeInt(player.currencies.diamond, 0);
  if (id === 2) return toSafeInt(player.currencies.silver, 0);
  if (id === 6) return toSafeInt(player.currencies.gold, 0);
  return toSafeInt(player.items[id], 0);
}

function snapshotItemCounts(player, itemIds = []) {
  const snapshot = {};
  const ids = Array.from(new Set(
    (Array.isArray(itemIds) ? itemIds : [itemIds])
      .map((id) => toSafeInt(id, 0))
      .filter((id) => id !== 0)
  ));

  ids.forEach((id) => {
    snapshot[id] = getPlayerItemCount(player, id);
  });
  return snapshot;
}

function buildItemDeltaPayload(player, beforeSnapshot = {}) {
  const ids = Object.keys(beforeSnapshot)
    .map((id) => toSafeInt(id, 0))
    .filter((id) => id !== 0)
    .sort((a, b) => a - b);
  const deltaRows = [];
  const changed = [];

  ids.forEach((id) => {
    const before = toSafeInt(beforeSnapshot[id], 0);
    const after = getPlayerItemCount(player, id);
    const delta = after - before;
    if (delta !== 0) deltaRows.push({ id, count: delta });
    changed.push({ id, count: after });
  });

  if (deltaRows.length <= 0) return null;
  return {
    result: 0,
    items: normalizeSyncRows(deltaRows),
    changed,
  };
}

function withItemDeltaSync(player, beforeSnapshot, response) {
  const payload = buildItemDeltaPayload(player, beforeSnapshot);
  if (!payload) return response;
  return [
    { tag: 1202, msgUid: 0, data: payload },
    response,
  ];
}

function buildTaskSyncPackets(player) {
  const taskInfo = normalizeTaskInfoSafe(
    player && player.taskInfo ? player.taskInfo : {},
    player && player.roleInfo ? player.roleInfo : {}
  );
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

function withFarmSync(player, beforeSnapshot, response, options = {}) {
  const packets = [];
  const payload = buildItemDeltaPayload(player, beforeSnapshot);
  if (payload) {
    packets.push({ tag: 1202, msgUid: 0, data: payload });
  }
  if (options && options.levelChanged) {
    packets.push(buildFarmLevelPacket(player));
  }
  if (options && options.taskChanged) {
    packets.push(...buildTaskSyncPackets(player));
  }
  packets.push(response);
  if (packets.length <= 1) return response;
  return packets;
}

function buildPlantBlockUpdatePacket(ownerId, block) {
  return {
    tag: 2401,
    msgUid: 0,
    data: {
      result: 0,
      ownerId,
      blockinfo: clonePlain(block),
    },
  };
}

function hasEnoughItemOrCurrency(player, itemId, count) {
  const id = toSafeInt(itemId, 0);
  const need = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || need <= 0) return true;

  player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
  player.items = player.items || {};

  if (id === 1) return toSafeInt(player.currencies.diamond, 0) >= need;
  if (id === 2) return toSafeInt(player.currencies.silver, 0) >= need;
  if (id === 6) return toSafeInt(player.currencies.gold, 0) >= need;
  return toSafeInt(player.items[id], 0) >= need;
}

function consumeItemOrCurrency(player, itemId, count, allowOverdraft = false) {
  const id = toSafeInt(itemId, 0);
  const cost = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || cost <= 0) return true;

  player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
  player.items = player.items || {};

  if (!allowOverdraft && !hasEnoughItemOrCurrency(player, id, cost)) return false;

  if (id === 1) {
    player.currencies.diamond = Math.max(0, toSafeInt(player.currencies.diamond, 0) - cost);
    return true;
  }
  if (id === 2) {
    player.currencies.silver = Math.max(0, toSafeInt(player.currencies.silver, 0) - cost);
    return true;
  }
  if (id === 6) {
    player.currencies.gold = Math.max(0, toSafeInt(player.currencies.gold, 0) - cost);
    return true;
  }

  const current = toSafeInt(player.items[id], 0);
  const next = Math.max(0, current - cost);
  if (next > 0) player.items[id] = next;
  else delete player.items[id];
  return true;
}

function normalizeTaskInfoSafe(taskInfo = {}, roleInfo = {}) {
  try {
    // eslint-disable-next-line global-require
    const mod = require('./playerPayload');
    if (mod && typeof mod.normalizeTaskInfo === 'function') {
      return mod.normalizeTaskInfo(taskInfo, roleInfo);
    }
  } catch (_err) {}
  return taskInfo;
}

function incrementFarmSideTaskProgress(player = {}, activeId, delta = 0) {
  const add = Math.max(0, toSafeInt(delta, 0));
  const targetActiveId = Math.max(0, toSafeInt(activeId, 0));
  if (!player || typeof player !== 'object' || targetActiveId <= 0 || add <= 0) return false;

  player.taskInfo = normalizeTaskInfoSafe(player.taskInfo || {}, player.roleInfo || {});
  const tasks = player.taskInfo && player.taskInfo.tasks && typeof player.taskInfo.tasks === 'object'
    ? player.taskInfo.tasks
    : {};
  const taskCfgMap = configService.get('TaskConfig') || {};
  let changed = false;

  Object.keys(taskCfgMap).forEach((taskKey) => {
    const taskCfg = taskCfgMap[taskKey];
    if (!taskCfg || typeof taskCfg !== 'object') return;

    const taskId = toSafeInt(taskCfg.id != null ? taskCfg.id : taskKey, 0);
    if (taskId <= 0 || tasks[String(taskId)] || tasks[taskId]) return;
    if (toSafeInt(taskCfg.type, 0) === 1) return;
    if (toSafeInt(taskCfg.activeId, 0) !== targetActiveId) return;

    tasks[String(taskId)] = {
      id: taskId,
      type: toSafeInt(taskCfg.type, 0),
      status: 10,
      progress: 0,
      target: Math.max(0, toSafeInt(taskCfg.taskValue1, 0)),
    };
    changed = true;
  });

  Object.keys(tasks).forEach((taskKey) => {
    const state = tasks[taskKey];
    if (!state || typeof state !== 'object' || Array.isArray(state)) return;
    if (toSafeInt(state.type, 0) === 1) return;

    const taskId = toSafeInt(state.id != null ? state.id : taskKey, 0);
    if (taskId <= 0) return;

    const taskCfg = taskCfgMap[taskId] || taskCfgMap[String(taskId)] || null;
    if (!taskCfg || toSafeInt(taskCfg.activeId, 0) !== targetActiveId) return;

    const prevStatus = toSafeInt(state.status, 10);
    if (prevStatus >= 30) return;

    const target = Math.max(0, toSafeInt(taskCfg.taskValue1, toSafeInt(state.target, 0)));
    const prevProgress = Math.max(0, toSafeInt(state.progress, 0));
    const nextProgress = target > 0
      ? Math.min(target, prevProgress + add)
      : prevProgress + add;
    const nextStatus = prevStatus >= 20
      ? prevStatus
      : (target > 0 && nextProgress >= target ? 20 : 10);

    if (nextProgress === prevProgress && nextStatus === prevStatus && toSafeInt(state.target, 0) === target) {
      return;
    }

    tasks[taskKey] = {
      ...state,
      id: taskId,
      type: toSafeInt(state.type, toSafeInt(taskCfg.type, 0)),
      progress: nextProgress,
      target,
      status: nextStatus,
    };
    changed = true;
  });

  if (changed) {
    player.taskInfo = normalizeTaskInfoSafe({
      ...player.taskInfo,
      tasks,
    }, player.roleInfo || {});
  }

  return changed;
}

function upsertRobInfo(roblist, robInfo) {
  if (!Array.isArray(roblist)) return [];
  const dbid = robInfo && robInfo.playerinfo && robInfo.playerinfo.dbid;
  const index = toSafeInt(robInfo && robInfo.index, -1);
  if (!dbid || index < 0) return roblist;

  const next = roblist.slice();
  const at = next.findIndex(
    (item) => item
      && item.playerinfo
      && item.playerinfo.dbid === dbid
      && toSafeInt(item.index, -1) === index
  );

  if (toSafeInt(robInfo.count, 0) <= 0) {
    if (at >= 0) next.splice(at, 1);
    return next;
  }
  if (at >= 0) next[at] = robInfo;
  else next.push(robInfo);
  return next;
}

function pushWithLimit(list, row, maxCount) {
  if (!Array.isArray(list)) return list;
  list.push(row);
  if (list.length > maxCount) {
    list.splice(0, list.length - maxCount);
  }
  return list;
}

function getPlantTiredRule(currentTired = 0) {
  const rows = Object.values(getPlantTiredConfig())
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    .sort((a, b) => toSafeInt(b.tired, 0) - toSafeInt(a.tired, 0));

  for (const row of rows) {
    if (currentTired >= Math.max(0, toSafeInt(row.tired, 0))) {
      return row;
    }
  }
  return rows[rows.length - 1] || { tired: 0, addTired: 1, timeValue: 1 };
}

function getPlantTiredMax() {
  return Object.values(getPlantTiredConfig()).reduce(
    (max, row) => Math.max(max, Math.max(0, toSafeInt(row && row.tired, 0))),
    0,
  );
}

function getMouseTired(player) {
  return Math.max(0, getPlayerItemCount(player, -1));
}

function setMouseTired(player, value) {
  const next = Math.max(0, toSafeInt(value, 0));
  player.items = player.items || {};
  if (next > 0) player.items[-1] = next;
  else delete player.items[-1];
  return next;
}

function addMouseTired(player, mouseCount = 1) {
  const count = Math.max(0, toSafeInt(mouseCount, 0));
  if (count <= 0) return 0;

  const current = getMouseTired(player);
  const rule = getPlantTiredRule(current);
  const addPerMouse = Math.max(1, toSafeInt(rule.addTired, 1));
  const maxTired = getPlantTiredMax();
  const next = maxTired > 0
    ? Math.min(maxTired, current + addPerMouse * count)
    : current + addPerMouse * count;
  setMouseTired(player, next);
  return next - current;
}

function reduceMouseTired(player, value = 0) {
  const reduce = Math.max(0, toSafeInt(value, 0));
  if (reduce <= 0) return 0;

  const current = getMouseTired(player);
  const next = Math.max(0, current - reduce);
  setMouseTired(player, next);
  return current - next;
}

function getFreeMouseCount(player = {}) {
  const farm = ensureFarmInfo(player);
  const total = Math.max(0, getPlayerItemCount(player, 104));
  const used = (Array.isArray(farm.roblist) ? farm.roblist : []).reduce((sum, row) => sum + Math.max(0, toSafeInt(row && row.count, 0)), 0);
  return Math.max(0, total - used);
}

function addDriveAwayUsed(player, delta = 1) {
  const add = Math.max(0, toSafeInt(delta, 0));
  if (add <= 0) return 0;

  const farm = ensureFarmInfo(player);
  farm.driveAwayDayKey = getLocalDayKey(Date.now());
  const current = getPlayerItemCount(player, -2);
  const next = current + add;
  player.items = player.items || {};
  player.items[-2] = next;
  return next - current;
}

function ensureFarmInfo(player = {}) {
  const baseCfg = getPlantBaseConfig();
  const fieldMax = Math.max(1, toSafeInt(baseCfg.fieldMax, 6));

  if (!player.farmInfo || typeof player.farmInfo !== 'object' || Array.isArray(player.farmInfo)) {
    player.farmInfo = {};
  }

  const farm = player.farmInfo;
  farm.blockInfo = Array.isArray(farm.blockInfo) ? farm.blockInfo : [];
  const blockByIndex = new Map();
  farm.blockInfo.forEach((raw, idx) => {
    const normalized = normalizeBlock(raw, idx);
    blockByIndex.set(normalized.index, normalized);
  });
  const blockInfo = [];
  for (let i = 0; i < fieldMax; i += 1) {
    blockInfo.push(blockByIndex.get(i) || createEmptyBlock(i));
  }
  for (const [index, block] of blockByIndex.entries()) {
    if (index >= 100) blockInfo.push(block);
  }

  farm.blockInfo = blockInfo;
  farm.lv = Math.max(1, toSafeInt(farm.lv, 1));
  farm.exp = Math.max(0, toSafeInt(farm.exp, toSafeInt(player.items && player.items[35], 0)));
  farm.buildLv = farm.buildLv && typeof farm.buildLv === 'object' ? farm.buildLv : {};
  farm.buildUpgrade = farm.buildUpgrade && typeof farm.buildUpgrade === 'object' ? farm.buildUpgrade : {};
  farm.roblist = Array.isArray(farm.roblist) ? farm.roblist : [];
  farm.loglist = normalizeFarmLogList(farm.loglist);
  farm.fightLoglist = normalizeFarmFightLogList(farm.fightLoglist, player);

  if (!farm.neighbors || typeof farm.neighbors !== 'object' || Array.isArray(farm.neighbors)) {
    farm.neighbors = {};
  }
  farm.neighbors.neighbors = Array.isArray(farm.neighbors.neighbors) ? farm.neighbors.neighbors : [];
  farm.neighbors.refreshtime = toSafeInt(farm.neighbors.refreshtime, 0);

  if (!farm.enemys || typeof farm.enemys !== 'object' || Array.isArray(farm.enemys)) {
    farm.enemys = {};
  }
  farm.enemys.ememylist = cleanupEnemyEntries(Array.isArray(farm.enemys.ememylist) ? farm.enemys.ememylist : [], Date.now());

  const buildCfg = getPlantBuildConfig();
  Object.keys(buildCfg).forEach((buildId) => {
    const key = String(buildId);
    farm.buildLv[key] = Math.max(1, toSafeInt(farm.buildLv[key], 1));
    farm.buildUpgrade[key] = Math.max(0, toSafeInt(farm.buildUpgrade[key], 0));
  });

  farm.cookInfo = normalizeCookInfo(farm.cookInfo);
  farm.cookDayKey = Math.max(0, toSafeInt(farm.cookDayKey, 0));
  farm.cookDayCount = Math.max(0, toSafeInt(farm.cookDayCount, 0));
  const todayKey = getLocalDayKey(Date.now());
  if (farm.cookDayKey !== todayKey) {
    farm.cookDayKey = todayKey;
    farm.cookDayCount = 0;
  }
  farm.ratSkin = normalizeRatSkinId(farm.ratSkin);
  farm.offlineReward = !!farm.offlineReward;
  farm.cookFinishTime = toSafeInt(farm.cookFinishTime, 0);
  farm.cookTime = toSafeInt(farm.cookTime, 0);
  farm.cookReward = toSafeInt(farm.cookReward, 0);
  farm.cacheOffline = normalizeRewardRows(farm.cacheOffline);
  farm.cacheRecover = normalizeRewardRows(farm.cacheRecover);
  farm.autoStealRecord = Array.isArray(farm.autoStealRecord) ? farm.autoStealRecord : [];
  farm.tiredDayKey = Math.max(0, toSafeInt(farm.tiredDayKey, 0));
  if (farm.tiredDayKey !== todayKey) {
    farm.tiredDayKey = todayKey;
    setMouseTired(player, 0);
  }
  farm.driveAwayDayKey = Math.max(0, toSafeInt(farm.driveAwayDayKey, 0));
  if (farm.driveAwayDayKey !== todayKey) {
    farm.driveAwayDayKey = todayKey;
    if (player.items && typeof player.items === 'object') delete player.items[-2];
  }

  const now = Date.now();
  getMagicFieldIndexes().forEach((index) => {
    if (!isFarmBlockUnlocked(farm, index)) return;
    const block = findFarmBlock(farm, index, true);
    if (!block || block.rewardId > 0 || block.robber) return;
    applyPlantOnBlock(farm, index, 100, now);
  });

  return farm;
}

function buildFarmInfoData(player = {}) {
  const farm = ensureFarmInfo(player);
  const blockInfo = farm.blockInfo
    .filter((block) => {
      if (!block || typeof block !== 'object') return false;
      const index = toSafeInt(block.index, -1);
      if (index >= 100) return true;
      return toSafeInt(block.rewardId, 0) > 0
        || !!block.robber
        || toSafeInt(block.robCount, 0) > 0
        || toSafeInt(block.finishTime, 0) > 0
        || toSafeInt(block.oldRewardId, 0) > 0
        || toSafeInt(block.oldFinishTime, 0) > 0;
    })
    .map((block) => clonePlain(block));

  const buildLv = {};
  Object.keys(farm.buildLv || {}).forEach((key) => {
    const level = Math.max(1, toSafeInt(farm.buildLv[key], 1));
    if (level > 1) buildLv[key] = level;
  });

  const buildUpgrade = {};
  Object.keys(farm.buildUpgrade || {}).forEach((key) => {
    const finishTime = Math.max(0, toSafeInt(farm.buildUpgrade[key], 0));
    if (finishTime > 0) buildUpgrade[key] = finishTime;
  });

  const neighborCd = Math.max(0, toSafeInt(getPlantBaseConfig().stealGardenListCd, 0));
  const neighborRefreshTime = Math.max(
    0,
    toSafeInt(farm.neighbors && farm.neighbors.refreshtime, 0) || (neighborCd > 0 ? Date.now() + neighborCd * 1000 : 0)
  );

  return {
    blockInfo,
    lv: farm.lv,
    exp: farm.exp,
    buildLv,
    buildUpgrade,
    roblist: clonePlain(farm.roblist),
    loglist: clonePlain(farm.loglist),
    fightLoglist: clonePlain(farm.fightLoglist),
    neighbors: {
      neighbors: Array.isArray(farm.neighbors && farm.neighbors.neighbors)
        ? clonePlain(farm.neighbors.neighbors)
        : [],
      refreshtime: neighborRefreshTime,
    },
    enemys: clonePlain(farm.enemys),
    cookInfo: clonePlain(farm.cookInfo),
    ratSkin: farm.ratSkin,
    offlineReward: farm.offlineReward,
    cookFinishTime: farm.cookFinishTime,
    cookTime: farm.cookTime,
    cookReward: farm.cookReward,
    cacheOffline: clonePlain(farm.cacheOffline),
    cacheRecover: clonePlain(farm.cacheRecover),
  };
}

function setFarmExp(player, exp) {
  const farm = ensureFarmInfo(player);
  const safeExp = Math.max(0, toSafeInt(exp, 0));
  farm.exp = safeExp;
  if (!player.items || typeof player.items !== 'object' || Array.isArray(player.items)) {
    player.items = {};
  }
  if (safeExp > 0) player.items[35] = safeExp;
  else delete player.items[35];
}

function addFarmExpAndLevel(player, addExp) {
  const levelCfg = getPlantLevelConfig();
  const farm = ensureFarmInfo(player);
  const startLevel = farm.lv;
  let exp = farm.exp + Math.max(0, toSafeInt(addExp, 0));
  let level = startLevel;

  while (levelCfg[level] && exp >= toSafeInt(levelCfg[level].exp, 0) && toSafeInt(levelCfg[level].exp, 0) > 0) {
    exp -= toSafeInt(levelCfg[level].exp, 0);
    level += 1;
  }

  farm.lv = Math.max(1, level);
  setFarmExp(player, exp);
  const levelUpCount = Math.max(0, farm.lv - startLevel);
  if (levelUpCount > 0) {
    addRewardToPlayer(player, 33, levelUpCount);
  }
  return { level: farm.lv, exp: farm.exp, levelUpCount };
}

function buildFarmLevelPacket(player = {}, msgUid = 0) {
  const farm = ensureFarmInfo(player);
  return {
    tag: 2402,
    msgUid,
    data: {
      result: 0,
      level: farm.lv,
      exp: farm.exp,
    },
  };
}

function getFarmBuildTotalAttrVal(player, attrId) {
  const farm = ensureFarmInfo(player);
  const buildCfg = getPlantBuildConfig();
  return Object.keys(buildCfg).reduce((sum, buildId) => {
    const level = Math.max(1, toSafeInt(farm.buildLv[buildId], 1));
    const row = buildCfg[buildId] && (buildCfg[buildId][level] || buildCfg[buildId][String(level)]);
    return sum + Math.max(0, toSafeInt(row && row.attrs && row.attrs[attrId], 0));
  }, 0);
}

function calcHarvestRewardItems(block, options = {}) {
  const harvestBonusRate = Math.max(0, toSafeInt(options.harvestBonusRate, 0));
  const plantCfg = getPlantConfig();
  const cfg = plantCfg[toSafeInt(block.rewardId, 0)];
  if (cfg) {
    let currentCount = Math.max(1, toSafeInt(block.curCount, toSafeInt(cfg.count, 1)));
    if (harvestBonusRate > 0 && toSafeInt(block.index, -1) < 100) {
      currentCount = Math.max(1, Math.floor(currentCount * (1 + harvestBonusRate / 10000)));
    }
    const rewards = Array.isArray(cfg.rewards) && cfg.rewards.length > 0
      ? cfg.rewards
      : [{ id: toSafeInt(block.rewardId, 0), count: 1 }];

    return rewards
      .map((item) => ({
        id: toSafeInt(item.id, 0),
        count: Math.max(1, toSafeInt(item.count, 1)) * currentCount,
      }))
      .filter((item) => item.id > 0 && item.count > 0);
  }

  const magicCfg = getPlantMagicConfig()[toSafeInt(block.rewardId, 0)] || null;
  if (!magicCfg || !magicCfg.reward) return [];
  return normalizeRewardRows([{ id: toSafeInt(magicCfg.reward.id, 0), count: Math.max(1, toSafeInt(magicCfg.reward.count, 1)) }]);
}

function clearBlockForHarvest(block) {
  block.oldFinishTime = toSafeInt(block.finishTime, 0);
  block.oldRewardId = toSafeInt(block.rewardId, 0);
  block.matureFinishTime = 0;
  block.finishTime = 0;
  block.rewardId = 0;
  block.curCount = 0;
  block.robber = null;
  block.robCount = 0;
}

function findFarmBlock(farm, index, createIfMissing = false) {
  let block = farm.blockInfo.find((item) => toSafeInt(item.index, -1) === index);
  if (!block && createIfMissing) {
    block = createEmptyBlock(index);
    farm.blockInfo.push(block);
  }
  return block;
}

function applyPlantOnBlock(farm, index, seedId, now) {
  if (!isFarmBlockUnlocked(farm, index)) return null;
  const block = findFarmBlock(farm, index, index >= 100);
  if (!block) return null;

  const growInfo = getPlantGrowConfigBySeed(seedId);
  if (!growInfo) return null;
  const { rewardId, row: plantCfg } = growInfo;

  const growTime = Math.max(1, toSafeInt(plantCfg.growTime, 1));
  block.oldFinishTime = toSafeInt(block.finishTime, 0);
  block.oldRewardId = toSafeInt(block.rewardId, 0);
  block.rewardId = rewardId;
  block.curCount = Math.max(1, toSafeInt(plantCfg.count, 1));
  block.finishTime = now + growTime * 1000;
  block.robber = null;
  block.robCount = 0;
  block.ratSkin = 0;
  return block;
}

function settleBuildUpgrades(farm, buildIndex = null, now = Date.now()) {
  const buildCfg = getPlantBuildConfig();
  const ids = buildIndex == null
    ? Object.keys(buildCfg)
    : [String(toSafeInt(buildIndex, 0))];
  let changed = false;

  ids.forEach((id) => {
    const finishTime = Math.max(0, toSafeInt(farm.buildUpgrade[id], 0));
    if (finishTime <= 0 || finishTime > now) return;

    const currentLevel = Math.max(1, toSafeInt(farm.buildLv[id], 1));
    const nextCfg = buildCfg[id] && buildCfg[id][currentLevel + 1];
    if (nextCfg) {
      farm.buildLv[id] = currentLevel + 1;
    }
    farm.buildUpgrade[id] = 0;
    changed = true;
  });

  return changed;
}

function appendCacheRewards(farm, rows = [], target = 'recover') {
  if (target === 'offline') {
    farm.cacheOffline = mergeRewardRows(farm.cacheOffline, rows);
    return;
  }
  farm.cacheRecover = mergeRewardRows(farm.cacheRecover, rows);
}

function resetBlockAfterHarvest(farm, block, now = Date.now()) {
  if (toSafeInt(block && block.index, -1) >= 100) {
    applyPlantOnBlock(farm, toSafeInt(block.index, -1), 100, now);
    return;
  }
  clearBlockForHarvest(block);
}

function beginBlockSteal(block, robberDbid, count, finishTime, ratSkin) {
  if (!block || !robberDbid) return;
  if (block.matureFinishTime <= 0) {
    block.matureFinishTime = Math.max(0, toSafeInt(block.finishTime, 0));
  }
  block.finishTime = Math.max(0, toSafeInt(finishTime, 0));
  block.robber = { dbid: String(robberDbid) };
  block.robCount = Math.max(0, toSafeInt(count, 0));
  block.ratSkin = normalizeRatSkinId(ratSkin);
}

function cancelBlockSteal(block) {
  if (!block) return;
  block.finishTime = Math.max(0, toSafeInt(block.matureFinishTime, Date.now()));
  block.matureFinishTime = 0;
  block.robber = null;
  block.robCount = 0;
  block.ratSkin = 0;
}

function getBlockRobberDbid(block) {
  const robber = block && block.robber && typeof block.robber === 'object' ? block.robber : null;
  if (!robber) return '';
  return String(
    robber.dbid
    || robber.playerId
    || robber.id
    || (robber.playerinfo && robber.playerinfo.dbid)
    || (robber.playerInfo && robber.playerInfo.dbid)
    || ''
  ).trim();
}

function calcStealRewardItems(block) {
  const index = toSafeInt(block && block.index, -1);
  if (index >= 100) {
    const magicCfg = getPlantMagicConfig()[toSafeInt(block && block.rewardId, 0)] || null;
    if (!magicCfg || !magicCfg.reward) return [];
    return normalizeRewardRows([{ id: toSafeInt(magicCfg.reward.id, 0), count: Math.max(1, toSafeInt(magicCfg.reward.count, 1)) }]);
  }

  const cfg = getPlantConfig()[toSafeInt(block && block.rewardId, 0)] || null;
  if (!cfg) return [];
  const baseCount = Math.max(1, toSafeInt(cfg.count, 1));
  const stealCount = Math.max(1, Math.floor(baseCount * Math.max(0, toSafeInt(getPlantBaseConfig().stealCountRate, 1000)) / 10000));
  const currentCount = Math.max(1, toSafeInt(block && block.curCount, baseCount));
  const maxSteal = Math.max(0, currentCount - 1);
  if (maxSteal <= 0) return [];
  const realCount = Math.max(1, Math.min(stealCount, maxSteal));
  return [{ id: Math.max(0, toSafeInt(block && block.rewardId, 0)), count: realCount }];
}

function calcRobFinishTime(block, count, currentTired = 0, now = Date.now()) {
  const safeCount = Math.max(1, toSafeInt(count, 1));
  const rewardId = toSafeInt(block && block.rewardId, 0);
  const index = toSafeInt(block && block.index, -1);
  const cfg = index >= 100
    ? (
      getPlantMagicConfig()[rewardId]
      || getPlantMagicConfig()[Math.max(0, rewardId % 100)]
      || null
    )
    : (getPlantConfig()[rewardId] || null);
  const baseStealTime = Math.max(
    1,
    toSafeInt(cfg && cfg.stealTime, toSafeInt(getPlantBaseConfig().stealCd, 120)),
  );
  const timeValue = Math.max(1, Number(getPlantTiredRule(Math.max(0, toSafeInt(currentTired, 0))).timeValue) || 1);
  const stealSeconds = Math.max(1, Math.floor(baseStealTime * timeValue / safeCount));
  return now + stealSeconds * 1000;
}

function buildFarmFightShowInfo(player = {}, fallback = {}) {
  const roleInfo = player && typeof player.roleInfo === 'object' && !Array.isArray(player.roleInfo)
    ? player.roleInfo
    : {};
  const legalKungfuIds = new Set([1, 4, 5, 6, 8]);
  const rawKungfuId = toSafeInt(roleInfo.kungfuId, toSafeInt(fallback.kungfuId, 4));
  const kungfuId = legalKungfuIds.has(rawKungfuId) ? rawKungfuId : 4;
  const dbid = String(player.playerId || player.userId || fallback.dbid || 'farm_fighter');
  const level = Math.max(1, toSafeInt(player.level, toSafeInt(fallback.level, 1)));

  return {
    dbid,
    serverId: Math.max(1, toSafeInt(player.serverId, toSafeInt(process.env.SERVER_ID, 1))),
    serverName: String(player.serverName || process.env.SERVER_NAME || ''),
    kungfuId,
    subJob: Math.max(0, toSafeInt(roleInfo.subJob, toSafeInt(fallback.subJob, 0))),
    level,
    name: String(player.name || fallback.name || '道友'),
    power: Math.max(0, toSafeInt(player.power, toSafeInt(player.powerScore, toSafeInt(fallback.power, level * 100)))),
    stage: Math.max(1, toSafeInt(roleInfo.stage, toSafeInt(roleInfo.stageId, 1))),
    petId: 0,
    petSoulId: -1,
    artifactId: 0,
    fate: 0,
    foreverCard: 0,
    equipMap: {},
    fashionMap: {},
    playerInfo: {
      dbid,
      level,
      avatar: Math.max(0, toSafeInt(roleInfo.avatar, toSafeInt(player.avatar, toSafeInt(fallback.avatar, 0)))),
      avatarUrl: String(player.avatarUrl || fallback.avatarUrl || fallback.avatarurl || ''),
      avatarFrame: Math.max(0, toSafeInt(roleInfo.avatarFrame, toSafeInt(player.avatarFrame, 0))),
      title: Math.max(0, toSafeInt(roleInfo.title, toSafeInt(player.title, 0))),
    },
  };
}

function buildFarmFightVars(hpValue = 100) {
  const hp = Math.max(1, toSafeInt(hpValue, 100));
  return {
    1: hp,
    2: 0,
    3: 0,
    '-1': hp,
  };
}

function buildBasicFightResult(player, targetDbid) {
  const selfDbid = String((player && (player.playerId || player.userId)) || 'self');
  const enemyDbid = String(targetDbid || 'enemy');
  const selfShowInfo = buildFarmFightShowInfo(player, { dbid: selfDbid, name: 'self' });
  const enemyShowInfo = buildFarmFightShowInfo({}, { dbid: enemyDbid, name: 'robber', kungfuId: 4, level: Math.max(1, toSafeInt(player && player.level, 1)) });
  const selfHp = 100;
  const enemyHp = 100;
  const damageAction = {
    typ: 3,
    i: 0,
    c: 1,
    t: -1,
    as: [0],
    vs: { 1: -100 },
    es: [[{ typ: 6, i: 0, c: 1, t: -1 }]],
  };
  const events = [
    { typ: 0, i: 0, c: 0, t: 0, es: [] },
    {
      typ: 0,
      i: 1,
      c: 0,
      t: 0,
      es: [[{
        typ: 1,
        i: FARM_PLAYER_SKILL_ID,
        c: 1,
        t: 0,
        as: [0],
        es: [[{
          typ: 2,
          i: FARM_PLAYER_BEHAVIOR_ID,
          c: 1,
          t: 0,
          es: [[damageAction]],
        }]],
      }]],
    },
  ];
  const selfEntity = applyPrimaryBattlePetParts({
    id: selfShowInfo.kungfuId,
    dbid: selfDbid,
    name: (player && player.name) || 'self',
    type: 1,
    side: 1,
    camp: 1,
    pos: 1,
    posIndex: 1,
    hp: selfHp,
    maxhp: selfHp,
    maxHp: selfHp,
    vars: buildFarmFightVars(selfHp),
    showInfo: selfShowInfo,
    parts: {},
    partValues: {},
  }, player);
  return {
    type: 100,
    win: 1,
    mustChangeTurn: 0,
    notChangeTurn: 1,
    atkAttr: {},
    defAttr: {},
    events,
    entitys: [
      selfEntity,
      {
        id: enemyShowInfo.kungfuId,
        dbid: enemyDbid,
        name: 'robber',
        type: 1,
        side: 2,
        camp: 2,
        pos: -1,
        posIndex: -1,
        hp: 0,
        maxhp: enemyHp,
        maxHp: enemyHp,
        vars: buildFarmFightVars(enemyHp),
        showInfo: enemyShowInfo,
        parts: {},
        partValues: {},
      },
    ],
    guildBossAllDamage: 0,
    bloodlineOffset: 0,
  };
}

async function savePlayer(session, player) {
  if (!session || !session.userId || !player) return;
  const saved = await playerService.savePlayer(session.userId, player);
  if (
    saved
    && typeof saved === 'object'
    && (saved.playerId || saved.userId || saved.farmInfo)
  ) {
    session.player = saved;
  }
}

async function loadPlayerByDbid(dbid) {
  const playerId = String(dbid || '').trim();
  if (!playerId) return null;
  return playerService.findByPlayerId(playerId);
}

async function saveExternalPlayer(player) {
  if (!player || !player.userId) return null;
  return playerService.savePlayer(player.userId, player);
}

function buildFarmPlayerInfo(player = {}) {
  const roleInfo = player && typeof player.roleInfo === 'object' ? player.roleInfo : {};
  return {
    dbid: String(player.playerId || player.userId || ''),
    name: String(player.name || ''),
    avatar: Math.max(0, toSafeInt(roleInfo.avatar, toSafeInt(player.avatar, 11305))),
    avatarUrl: player.avatarUrl ? String(player.avatarUrl) : '',
    avatarFrame: Math.max(-1, toSafeInt(roleInfo.avatarFrame, toSafeInt(player.avatarFrame, -1))),
  };
}

function cleanupEnemyEntries(enemyList = [], now = Date.now()) {
  return (Array.isArray(enemyList) ? enemyList : []).filter((row) => (
    row
    && row.playerinfo
    && row.playerinfo.dbid
    && Math.max(0, toSafeInt(row.expiretime, 0)) > now
  ));
}

function upsertEnemyEntry(enemyList = [], entry = {}) {
  const next = cleanupEnemyEntries(enemyList, Date.now());
  const dbid = String(entry && entry.playerinfo && entry.playerinfo.dbid || '').trim();
  if (!dbid) return next;
  const foundIndex = next.findIndex((row) => String(row && row.playerinfo && row.playerinfo.dbid || '') === dbid);
  if (foundIndex >= 0) next[foundIndex] = { ...next[foundIndex], ...entry, playerinfo: { ...next[foundIndex].playerinfo, ...entry.playerinfo } };
  else next.push(entry);
  return next;
}

function hasStealableBlocks(player = {}) {
  const farm = ensureFarmInfo(player);
  const now = Date.now();
  return farm.blockInfo.some((block) => {
    if (!block || toSafeInt(block.rewardId, 0) <= 0 || toSafeInt(block.curCount, 0) <= 0) return false;
    if (toSafeInt(block.finishTime, 0) <= 0 || toSafeInt(block.finishTime, 0) > now) return false;
    if (block.robber) return false;
    if (toSafeInt(block.index, -1) < 100 && calcStealRewardItems(block).length <= 0) return false;
    return true;
  });
}

async function buildFarmNeighborList(player = {}, count = 3) {
  const selfDbid = String(player.playerId || player.userId || '');
  const rows = await playerService.listPlayersBasic({ playerId: { $ne: selfDbid } }, Math.max(10, count * 8));
  const candidates = (Array.isArray(rows) ? rows : []).filter((row) => row && String(row.playerId || '') !== selfDbid && hasStealableBlocks(row));
  candidates.sort(() => Math.random() - 0.5);
  return candidates.slice(0, count).map((row) => ({
    playerinfo: buildFarmPlayerInfo(row),
    timeList: [],
  }));
}

function getSelfDbid(session) {
  const player = session && session.player;
  return (player && (player.playerId || player.userId)) || (session && session.userId) || '';
}

async function handlePlantInfo(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2400, msgUid, data: { result: -1 } };
  const farm = ensureFarmInfo(player);

  const index = toSafeInt(params && params.index, -1);
  const seed = toSafeInt(params && params.seed, 0);
  if (index >= 0 && seed > 0) {
    const block = findFarmBlock(farm, index, index >= 100);
    const growInfo = getPlantGrowConfigBySeed(seed);
    if (!block || !growInfo) {
      return { tag: 2400, msgUid, data: { result: -1, ...buildFarmInfoData(player) } };
    }
    const now = Date.now();
    if (block.rewardId > 0 && block.curCount > 0 && block.finishTime > now) {
      return { tag: 2400, msgUid, data: { result: 9, ...buildFarmInfoData(player) } };
    }
    if (!hasEnoughItemOrCurrency(player, seed, 1)) {
      return { tag: 2400, msgUid, data: { result: 1, ...buildFarmInfoData(player) } };
    }

    const plantedPreview = applyPlantOnBlock(farm, index, seed, now);
    if (!plantedPreview) {
      return { tag: 2400, msgUid, data: { result: -1, ...buildFarmInfoData(player) } };
    }
    const beforeSnapshot = snapshotItemCounts(player, [seed]);
    consumeItemOrCurrency(player, seed, 1, false);
    const plantedBlock = plantedPreview;
    if (!plantedBlock) {
      return { tag: 2400, msgUid, data: { result: -1, ...buildFarmInfoData(player) } };
    }

    const maxLogCount = Math.max(1, toSafeInt(getPlantBaseConfig().logCount, 20));
    pushWithLimit(
      farm.loglist,
      { type: 1, blockId: index, rewardId: Math.max(0, toSafeInt(plantedBlock.rewardId, 0)), count: 0, time: getNowSeconds() },
      maxLogCount
    );
    const mainTaskChanged = addFarmPlantCount(player, 1);
    const sideTaskChanged = incrementFarmSideTaskProgress(player, 18, 1);
    const taskChanged = !!(mainTaskChanged || sideTaskChanged);
    await savePlayer(session, player);

    const packets = [];
    const itemDelta = buildItemDeltaPayload(player, beforeSnapshot);
    if (itemDelta) packets.push({ tag: 1202, msgUid: 0, data: itemDelta });
    packets.push({
      tag: 2401,
      msgUid: 0,
      data: {
        result: 0,
        ownerId: getSelfDbid(session),
        blockinfo: clonePlain(plantedBlock),
      },
    });
    packets.push({
      tag: 2400,
      msgUid,
      data: {
        result: 0,
        ...buildFarmInfoData(player),
      },
    });
    if (taskChanged) {
      packets.push(...buildTaskSyncPackets(player));
    }
    return packets;
  }

  return {
    tag: 2400,
    msgUid,
    data: {
      result: 0,
      ...buildFarmInfoData(player),
    },
  };
}

async function handlePlantHarvest(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2401, msgUid, data: { result: -1 } };
  const farm = ensureFarmInfo(player);

  const index = toSafeInt(params && params.index, -1);
  const block = findFarmBlock(farm, index, false);
  const ownerId = getSelfDbid(session);
  if (!block) {
    return { tag: 2401, msgUid, data: { result: -1, ownerId, blockinfo: createEmptyBlock(index) } };
  }

  const now = Date.now();
  if (block.rewardId <= 0 || block.curCount <= 0 || block.finishTime <= 0 || block.finishTime > now) {
    return {
      tag: 2401,
      msgUid,
      data: { result: 1, ownerId, blockinfo: clonePlain(block), rewardInfo: { items: [], equips: [] } },
    };
  }

  const beforeLevel = farm.lv;
  const rewardItems = calcHarvestRewardItems(block, {
    harvestBonusRate: getFarmBuildTotalAttrVal(player, 3),
  });
  const beforeSnapshot = snapshotItemCounts(player, [
    ...rewardItems.map((item) => item.id),
    35,
  ]);
  rewardItems.forEach((item) => addRewardToPlayer(player, item.id, item.count));

  const cfg = getPlantConfig()[toSafeInt(block.rewardId, 0)];
  const expAdd = cfg && cfg.rewardExp ? toSafeInt(cfg.rewardExp.count, 0) : 0;
  const levelState = addFarmExpAndLevel(player, expAdd);

  resetBlockAfterHarvest(farm, block, now);

  const maxLogCount = Math.max(1, toSafeInt(getPlantBaseConfig().logCount, 20));
  pushWithLimit(
    farm.loglist,
    {
      type: 1,
      blockId: index,
      rewardId: Math.max(0, toSafeInt(block.oldRewardId, toSafeInt(rewardItems[0] && rewardItems[0].id, 0))),
      count: rewardItems.reduce((sum, item) => sum + Math.max(0, toSafeInt(item && item.count, 0)), 0),
      rewards: rewardItems,
      time: getNowSeconds(),
    },
    maxLogCount
  );
  const mainTaskChanged = addFarmHarvestCount(player, 1);
  const sideTaskChanged = incrementFarmSideTaskProgress(player, 20, 1);
  const taskChanged = !!(mainTaskChanged || sideTaskChanged);
  await savePlayer(session, player);

  const response = {
    tag: 2401,
    msgUid,
    data: {
      result: 0,
      ownerId,
      blockinfo: clonePlain(block),
      rewards: clonePlain(rewardItems),
      rewardInfo: buildRewardInfo(rewardItems),
      level: levelState.level,
      exp: levelState.exp,
    },
  };
  const packets = withFarmSync(player, beforeSnapshot, response, { taskChanged, levelChanged: farm.lv !== beforeLevel });
  const blockPacket = buildPlantBlockUpdatePacket(ownerId, block);
  return Array.isArray(packets) ? [blockPacket, ...packets] : [blockPacket, packets];
}

async function handlePlantLevelOrRob(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2402, msgUid, data: { result: -1 } };
  const farm = ensureFarmInfo(player);
  const now = Date.now();
  const selfDbid = getSelfDbid(session);

  const targetDbid = String((params && params.dbid) || '').trim();
  const index = toSafeInt(params && params.index, 0);
  const count = Math.max(0, toSafeInt(params && params.count, 0));
  const beforeSnapshot = snapshotItemCounts(player, [-1, 104]);
  const previousRob = Array.isArray(farm.roblist)
    ? farm.roblist.find((item) => item && item.playerinfo && item.playerinfo.dbid === targetDbid && toSafeInt(item.index, -1) === index)
    : null;
  const previousCount = Math.max(0, toSafeInt(previousRob && previousRob.count, 0));
  const mouseTired = getMouseTired(player);
  const targetPlayer = targetDbid ? await loadPlayerByDbid(targetDbid) : null;
  if (!targetPlayer) {
    return { tag: 2402, msgUid, data: { result: 1, level: farm.lv, exp: farm.exp, robInfo: null } };
  }
  const targetFarm = ensureFarmInfo(targetPlayer);
  const targetBlock = findFarmBlock(targetFarm, index, false);
  if (!targetBlock || !isFarmBlockUnlocked(targetFarm, index)) {
    return { tag: 2402, msgUid, data: { result: 1, level: farm.lv, exp: farm.exp, robInfo: null } };
  }

  if (count > 0) {
    const blockCfg = toSafeInt(targetBlock.index, -1) >= 100
      ? (getPlantMagicConfig()[toSafeInt(targetBlock.rewardId, 0)] || null)
      : (getPlantConfig()[toSafeInt(targetBlock.rewardId, 0)] || null);
    const mouseMax = Math.max(1, toSafeInt(blockCfg && blockCfg.mouseMax, 1));
    let freeMouseCount = getFreeMouseCount(player) + previousCount;
    if (count > mouseMax) {
      return { tag: 2402, msgUid, data: { result: 1, level: farm.lv, exp: farm.exp, robInfo: null } };
    }
    if (count > freeMouseCount) {
      player.items = player.items || {};
      player.items[104] = Math.max(0, toSafeInt(player.items[104], 0)) + (count - freeMouseCount);
      freeMouseCount = count;
    }
    if (targetBlock.rewardId <= 0 || targetBlock.curCount <= 0) {
      return { tag: 2402, msgUid, data: { result: 1, level: farm.lv, exp: farm.exp, robInfo: null } };
    }
    if (targetBlock.finishTime <= 0 || targetBlock.finishTime > now) {
      return { tag: 2402, msgUid, data: { result: 1, level: farm.lv, exp: farm.exp, robInfo: null } };
    }
    if (targetBlock.robber && String(targetBlock.robber.dbid || '') !== selfDbid) {
      return { tag: 2402, msgUid, data: { result: 1, level: farm.lv, exp: farm.exp, robInfo: null } };
    }
    if (index < 100) {
      const protectTime = Math.max(0, toSafeInt(getPlantBaseConfig().protectTime, 0));
      if (!previousRob && protectTime > 0 && now < targetBlock.finishTime + protectTime * 1000) {
        return { tag: 2402, msgUid, data: { result: 9, level: farm.lv, exp: farm.exp, robInfo: null } };
      }
    }
  }

  const robInfo = {
    playerinfo: buildFarmPlayerInfo(targetPlayer),
    index,
    rewardId: Math.max(0, toSafeInt(targetBlock.rewardId, 0)),
    count,
    finishtime: count > 0 ? calcRobFinishTime(targetBlock, count, mouseTired, now) : 0,
    ratSkin: normalizeRatSkinId(farm.ratSkin),
  };

  farm.roblist = upsertRobInfo(farm.roblist, robInfo);
  if (count > 0) {
    beginBlockSteal(targetBlock, selfDbid, count, robInfo.finishtime, robInfo.ratSkin);
  } else {
    cancelBlockSteal(targetBlock);
  }

  const maxFightLogCount = Math.max(1, toSafeInt(getPlantBaseConfig().fightLogCount, 10));
  pushWithLimit(
    farm.fightLoglist,
    normalizeFarmFightLogEntry({
      type: 1,
      index,
      count,
      playerinfo: { dbid: targetDbid || selfDbid, name: targetPlayer.name || '道友', level: targetPlayer.level || 1, avatar: targetPlayer.avatar || 0, avatarUrl: targetPlayer.avatarUrl || '' },
      finishtime: robInfo.finishtime,
      time: getNowSeconds(),
      isWin: true,
    }, player),
    maxFightLogCount
  );
  let taskChanged = false;
  if (count > 0 && previousCount <= 0) {
    const mainTaskChanged = addFarmStealCount(player, 1);
    const sideTaskChanged = incrementFarmSideTaskProgress(player, 21, 1);
    taskChanged = !!(mainTaskChanged || sideTaskChanged);
  }
  if (count > previousCount) {
    addMouseTired(player, count - previousCount);
  }
  if (count > 0) {
    const expireMs = Math.max(1, toSafeInt(getPlantBaseConfig().enemyListTime, 3)) * 24 * 60 * 60 * 1000;
    targetFarm.enemys.ememylist = upsertEnemyEntry(targetFarm.enemys.ememylist, {
      playerinfo: buildFarmPlayerInfo(player),
      expiretime: now + expireMs,
      timeList: [],
    });
  }
  await saveExternalPlayer(targetPlayer);
  await savePlayer(session, player);

  const packets = withFarmSync(player, beforeSnapshot, {
    tag: 2402,
    msgUid,
    data: {
      result: 0,
      level: farm.lv,
      exp: farm.exp,
      robInfo,
    },
  }, { taskChanged });
  const blockPacket = {
    tag: 2401,
    msgUid: 0,
    data: {
      result: 0,
      ownerId: targetDbid,
      blockinfo: clonePlain(targetBlock),
    },
  };
  return Array.isArray(packets) ? [blockPacket, ...packets] : [blockPacket, packets];
}

async function handlePlantAddLog(_params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2403, msgUid, data: { result: -1 } };
  const farm = ensureFarmInfo(player);
  const now = Date.now();
  const refreshSec = Math.max(1, toSafeInt(getPlantBaseConfig().stealGardenListCd, 60));
  const refreshCount = Math.max(1, toSafeInt(getPlantBaseConfig().stealGardenListCount, 3));
  farm.neighbors.neighbors = await buildFarmNeighborList(player, refreshCount);
  farm.neighbors.refreshtime = now + refreshSec * 1000;
  await savePlayer(session, player);

  return {
    tag: 2403,
    msgUid,
    data: {
      result: 0,
      neighbors: clonePlain(farm.neighbors.neighbors),
      refreshtime: farm.neighbors.refreshtime,
    },
  };
}

async function handlePlantEnemyUpdate(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2404, msgUid, data: { result: -1 } };
  const targetDbid = String((params && params.dbid) || getSelfDbid(session)).trim();
  const isSelf = !targetDbid || targetDbid === getSelfDbid(session);
  const targetPlayer = isSelf ? player : await loadPlayerByDbid(targetDbid);
  if (!targetPlayer) return { tag: 2404, msgUid, data: { result: -1 } };
  const farm = ensureFarmInfo(targetPlayer);
  if (!isSelf) await saveExternalPlayer(targetPlayer);

  return {
    tag: 2404,
    msgUid,
    data: {
      result: 0,
      dbid: targetDbid || getSelfDbid(session),
      lv: farm.lv,
      buildLv: clonePlain(farm.buildLv),
      blockInfo: clonePlain(farm.blockInfo),
      enemy: { playerinfo: { dbid: targetDbid || getSelfDbid(session) } },
    },
  };
}

async function handlePlantFightLogCheck(_params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2405, msgUid, data: { result: -1 } };
  const farm = ensureFarmInfo(player);
  const selfDbid = getSelfDbid(session);
  const now = Date.now();
  const robList = Array.isArray(farm.roblist) ? farm.roblist.slice() : [];
  const settlePackets = [];
  const rewardIds = new Set();
  const beforeSnapshot = snapshotItemCounts(player, [-1]);
  let robListChanged = false;

  for (const robInfo of robList) {
    if (!robInfo || Math.max(0, toSafeInt(robInfo.finishtime, 0)) <= 0 || toSafeInt(robInfo.finishtime, 0) > now) continue;
    const targetDbid = String(robInfo.playerinfo && robInfo.playerinfo.dbid || '').trim();
    const targetPlayer = await loadPlayerByDbid(targetDbid);
    let rewards = [];
    let targetBlock = null;

    if (targetPlayer) {
      const targetFarm = ensureFarmInfo(targetPlayer);
      targetBlock = findFarmBlock(targetFarm, toSafeInt(robInfo.index, -1), false);
      if (targetBlock && targetBlock.robber && String(targetBlock.robber.dbid || '') === selfDbid && targetBlock.finishTime <= now) {
        rewards = calcStealRewardItems(targetBlock);
        rewards.forEach((row) => {
          beforeSnapshot[row.id] = getPlayerItemCount(player, row.id);
          rewardIds.add(row.id);
          addRewardToPlayer(player, row.id, row.count);
        });
        if (toSafeInt(targetBlock.index, -1) >= 100) {
          resetBlockAfterHarvest(targetFarm, targetBlock, now);
        } else {
          const stolen = rewards.reduce((sum, row) => sum + Math.max(0, toSafeInt(row && row.count, 0)), 0);
          targetBlock.curCount = Math.max(1, Math.max(0, toSafeInt(targetBlock.curCount, 1)) - stolen);
          cancelBlockSteal(targetBlock);
        }
        await saveExternalPlayer(targetPlayer);
        settlePackets.push({
          tag: 2401,
          msgUid: 0,
          data: {
            result: 0,
            ownerId: targetDbid,
            blockinfo: clonePlain(targetBlock),
          },
        });
      }
    }

    farm.roblist = upsertRobInfo(farm.roblist, {
      playerinfo: { dbid: targetDbid },
      index: toSafeInt(robInfo.index, -1),
      count: 0,
      finishtime: 0,
    });
    robListChanged = true;
    settlePackets.push({
      tag: 2406,
      msgUid: 0,
      data: {
        result: 0,
        ownerId: targetDbid,
        rewards: clonePlain(rewards),
      },
    });
  }

  const logs = Array.isArray(farm.fightLoglist) ? farm.fightLoglist : [];
  const cursor = Math.max(0, toSafeInt(session && session._farmFightCursor, 0));

  const data = { result: 0 };
  if (cursor < logs.length) {
    data.loginfo = clonePlain(logs[cursor]);
    if (session) session._farmFightCursor = cursor + 1;
  }
  if (robListChanged) {
    await savePlayer(session, player);
    const packets = [];
    const payload = buildItemDeltaPayload(player, beforeSnapshot);
    if (payload) packets.push({ tag: 1202, msgUid: 0, data: payload });
    packets.push(...settlePackets);
    packets.push({ tag: 2405, msgUid, data });
    return packets;
  }
  return { tag: 2405, msgUid, data };
}

async function handlePlantSpeedUp(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2406, msgUid, data: { result: -1 } };

  const farm = ensureFarmInfo(player);
  const targetDbid = String((params && params.dbid) || getSelfDbid(session)).trim();
  const selfDbid = getSelfDbid(session);
  if (!targetDbid || targetDbid !== selfDbid) {
    return { tag: 2406, msgUid, data: { result: 1 } };
  }

  const index = toSafeInt(params && params.index, -1);
  const itemId = toSafeInt(params && params.itemId, 0);
  const count = Math.max(1, toSafeInt(params && params.count, 1));
  const block = findFarmBlock(farm, index, false);
  if (!block) {
    return { tag: 2406, msgUid, data: { result: -1 } };
  }

  const now = Date.now();
  if (block.finishTime <= now || block.rewardId <= 0) {
    return { tag: 2406, msgUid, data: { result: 0 } };
  }

  const speedMap = getPlantBaseConfig().plantFoodId || {};
  const speedSec = Math.max(1, toSafeInt(speedMap[itemId], 300));
  if (!hasEnoughItemOrCurrency(player, itemId, count)) {
    return { tag: 2406, msgUid, data: { result: 1 } };
  }
  const beforeSnapshot = snapshotItemCounts(player, [itemId]);
  consumeItemOrCurrency(player, itemId, count, false);
  block.finishTime = Math.max(now, block.finishTime - speedSec * count * 1000);

  await savePlayer(session, player);
  const packets = [];
  const itemDelta = buildItemDeltaPayload(player, beforeSnapshot);
  if (itemDelta) packets.push({ tag: 1202, msgUid: 0, data: itemDelta });
  packets.push({
    tag: 2401,
    msgUid: 0,
    data: {
      result: 0,
      ownerId: selfDbid,
      blockinfo: clonePlain(block),
    },
  });
  packets.push({
    tag: 2406,
    msgUid,
    data: {
      result: 0,
    },
  });
  return packets;
}

async function handlePlantHarvestAll(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2407, msgUid, data: { result: -1, indexs: [] } };

  const farm = ensureFarmInfo(player);
  const useCache = !!(params && params.cache);
  const now = Date.now();

  const beforeLevel = farm.lv;
  const indexs = [];
  const blockPackets = [];
  let allRewards = [];
  let totalExp = 0;
  const harvestBonusRate = getFarmBuildTotalAttrVal(player, 3);

  farm.blockInfo.forEach((block) => {
    if (!block || block.rewardId <= 0 || block.curCount <= 0) return;
    if (block.finishTime <= 0 || block.finishTime > now) return;

    indexs.push(toSafeInt(block.index, -1));
    const rewards = calcHarvestRewardItems(block, { harvestBonusRate });
    allRewards = mergeRewardRows(allRewards, rewards);

    const cfg = getPlantConfig()[toSafeInt(block.rewardId, 0)] || null;
    if (cfg && cfg.rewardExp) totalExp += Math.max(0, toSafeInt(cfg.rewardExp.count, 0));

    resetBlockAfterHarvest(farm, block, now);
    blockPackets.push(buildPlantBlockUpdatePacket(getSelfDbid(session), block));
  });

  const beforeSnapshot = snapshotItemCounts(player, [
    ...allRewards.map((row) => row.id),
    35,
  ]);
  if (totalExp > 0) addFarmExpAndLevel(player, totalExp);

  if (allRewards.length > 0) {
    if (useCache) {
      appendCacheRewards(farm, allRewards, 'recover');
      farm.offlineReward = true;
    } else {
      allRewards.forEach((row) => addRewardToPlayer(player, row.id, row.count));
    }
  }

  let taskChanged = false;
  if (indexs.length > 0 || allRewards.length > 0 || totalExp > 0) {
    const maxLogCount = Math.max(1, toSafeInt(getPlantBaseConfig().logCount, 20));
    pushWithLimit(
      farm.loglist,
      { type: 2, indexs: clonePlain(indexs), rewards: clonePlain(allRewards), time: getNowSeconds(), cache: useCache ? 1 : 0 },
      maxLogCount
    );
    if (indexs.length > 0) {
      const mainTaskChanged = addFarmHarvestCount(player, indexs.length);
      const sideTaskChanged = incrementFarmSideTaskProgress(player, 20, indexs.length);
      taskChanged = !!(mainTaskChanged || sideTaskChanged);
    }
    await savePlayer(session, player);
  }

  const response = {
    tag: 2407,
    msgUid,
    data: {
      result: 0,
      indexs,
      rewards: useCache ? [] : clonePlain(allRewards),
      rewardInfo: useCache ? buildRewardInfo([]) : buildRewardInfo(allRewards),
      buildLv: clonePlain(farm.buildLv),
      buildUpgrade: clonePlain(farm.buildUpgrade),
    },
  };
  const packets = withFarmSync(player, beforeSnapshot, response, { taskChanged, levelChanged: farm.lv !== beforeLevel });
  return Array.isArray(packets) ? [...blockPackets, ...packets] : [...blockPackets, packets];
}

async function handlePlantDetailAuto(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2408, msgUid, data: { result: -1 } };
  const targetDbid = String((params && params.dbid) || getSelfDbid(session)).trim();
  const isSelf = !targetDbid || targetDbid === getSelfDbid(session);
  const targetPlayer = isSelf ? player : await loadPlayerByDbid(targetDbid);
  if (!targetPlayer) return { tag: 2408, msgUid, data: { result: -1 } };
  const farm = ensureFarmInfo(targetPlayer);
  if (!isSelf) await saveExternalPlayer(targetPlayer);
  return {
    tag: 2408,
    msgUid,
    data: {
      result: 0,
      dbid: targetDbid || getSelfDbid(session),
      lv: farm.lv,
      buildLv: clonePlain(farm.buildLv),
      blockInfo: clonePlain(farm.blockInfo),
      rewards: clonePlain(farm.cacheRecover),
    },
  };
}

async function handleBuildUpgrade(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2410, msgUid, data: { result: -1 } };

  const farm = ensureFarmInfo(player);
  const buildCfg = getPlantBuildConfig();
  const index = String(toSafeInt(params && params.index, 0));
  const level = Math.max(1, toSafeInt(farm.buildLv[index], 1));
  const nextCfg = buildCfg[index] && buildCfg[index][level + 1];
  if (!nextCfg) {
    return { tag: 2410, msgUid, data: { result: 1, time: 0 } };
  }

  const buildLevels = Object.keys(buildCfg).map((key) => Math.max(1, toSafeInt(farm.buildLv[key], 1)));
  const minBuildLv = buildLevels.length > 0 ? Math.min(...buildLevels) : 1;
  const buildLevelCondition = Math.max(0, toSafeInt(getPlantBaseConfig().buildLevelCondition, 0));
  if (buildLevelCondition > 0 && level - minBuildLv >= buildLevelCondition) {
    return { tag: 2410, msgUid, data: { result: 1, time: 0 } };
  }

  const now = Date.now();
  const currentFinish = Math.max(0, toSafeInt(farm.buildUpgrade[index], 0));
  if (currentFinish > now) {
    return { tag: 2410, msgUid, data: { result: 1, time: currentFinish } };
  }

  const curCfg = buildCfg[index] && buildCfg[index][level];
  const consumes = Array.isArray(curCfg && curCfg.consumes) ? curCfg.consumes : [];
  const beforeSnapshot = snapshotItemCounts(player, consumes.map((cost) => toSafeInt(cost && cost.id, 0)));
  for (const cost of consumes) {
    const costId = toSafeInt(cost && cost.id, 0);
    const costCount = Math.max(0, toSafeInt(cost && cost.count, 0));
    if (!hasEnoughItemOrCurrency(player, costId, costCount)) {
      return { tag: 2410, msgUid, data: { result: 1, time: 0 } };
    }
  }
  consumes.forEach((cost) => {
    consumeItemOrCurrency(player, toSafeInt(cost.id, 0), Math.max(0, toSafeInt(cost.count, 0)), false);
  });

  const finishTime = now + Math.max(1, toSafeInt(nextCfg.levelUpTime, 30)) * 1000;
  farm.buildUpgrade[index] = finishTime;

  await savePlayer(session, player);
  return withFarmSync(player, beforeSnapshot, { tag: 2410, msgUid, data: { result: 0, time: finishTime } });
}

async function handleBuildCheck(_params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2411, msgUid, data: { result: -1, buildLv: {}, buildUpgrade: {} } };

  const farm = ensureFarmInfo(player);
  const changed = settleBuildUpgrades(farm, null, Date.now());
  if (changed) await savePlayer(session, player);

  return {
    tag: 2411,
    msgUid,
    data: {
      result: 0,
      buildLv: clonePlain(farm.buildLv),
      buildUpgrade: clonePlain(farm.buildUpgrade),
    },
  };
}

async function handleFightRobber(params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return {
      tag: 2412,
      msgUid,
      data: {
        result: -1,
        fightResult: buildBasicFightResult(null, ''),
      },
    };
  }

  const farm = ensureFarmInfo(player);
  const index = toSafeInt(params && params.index, -1);
  const targetDbid = String((params && params.dbid) || '').trim();
  const block = findFarmBlock(farm, index, false);
  const robberMatched = !!(
    block
    && block.robber
    && (!targetDbid || String(block.robber.dbid || '') === targetDbid)
  );

  const maxFightLogCount = Math.max(1, toSafeInt(getPlantBaseConfig().fightLogCount, 10));
  pushWithLimit(
    farm.fightLoglist,
    normalizeFarmFightLogEntry({
      type: 2,
      index,
      count: 0,
      playerinfo: { dbid: targetDbid || getSelfDbid(session) },
      finishtime: 0,
      time: getNowSeconds(),
      isWin: true,
    }, player),
    maxFightLogCount
  );
  if (robberMatched) {
    cancelBlockSteal(block);
  }
  let taskChanged = false;
  if (robberMatched) {
    const mainTaskChanged = addFarmRobberFightCount(player, 1);
    const sideTaskChanged = incrementFarmSideTaskProgress(player, 23, 1);
    taskChanged = !!(mainTaskChanged || sideTaskChanged);
  }

  await savePlayer(session, player);
  return withFarmSync(player, {}, {
    tag: 2412,
    msgUid,
    data: {
      result: 0,
      fightResult: buildBasicFightResult(player, targetDbid),
    },
  }, { taskChanged });
}

async function handleBuildSpeedup(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2413, msgUid, data: { result: -1, buildLv: {}, buildUpgrade: {} } };

  const farm = ensureFarmInfo(player);
  const index = String(toSafeInt(params && params.index, 0));
  const ad = Math.max(0, toSafeInt(params && params.ad, 0));
  const count = Math.max(0, toSafeInt(params && params.count, 0));
  const now = Date.now();

  let finishTime = Math.max(0, toSafeInt(farm.buildUpgrade[index], 0));
  if (finishTime <= now) {
    return {
      tag: 2413,
      msgUid,
      data: {
        result: 1,
        buildLv: clonePlain(farm.buildLv),
        buildUpgrade: clonePlain(farm.buildUpgrade),
      },
    };
  }

  if (ad > 0) {
    finishTime = now;
  } else if (count > 0) {
    if (!hasEnoughItemOrCurrency(player, 6, count)) {
      return {
        tag: 2413,
        msgUid,
        data: {
          result: 1,
          buildLv: clonePlain(farm.buildLv),
          buildUpgrade: clonePlain(farm.buildUpgrade),
        },
      };
    }
  }

  const beforeSnapshot = count > 0 ? snapshotItemCounts(player, [6]) : {};
  if (count > 0) {
    consumeItemOrCurrency(player, 6, count, false);
    finishTime = Math.max(now, finishTime - count * 60 * 1000);
  }

  farm.buildUpgrade[index] = finishTime;
  settleBuildUpgrades(farm, index, now);

  await savePlayer(session, player);
  return withFarmSync(player, beforeSnapshot, {
    tag: 2413,
    msgUid,
    data: {
      result: 0,
      buildLv: clonePlain(farm.buildLv),
      buildUpgrade: clonePlain(farm.buildUpgrade),
    },
  });
}

async function handleBuildAssist(_params, _session, msgUid) {
  return {
    tag: 2414,
    msgUid,
    data: {
      result: 0,
    },
  };
}

async function handleFightAssist(_params, _session, msgUid) {
  return {
    tag: 2415,
    msgUid,
    data: {
      result: 0,
    },
  };
}

async function handleCook(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2416, msgUid, data: { result: -1, cookFinishTime: 0, cookReward: 0, cookTime: 0 } };

  const farm = ensureFarmInfo(player);
  const index = Math.max(0, Math.min(COOK_SLOT_MAX - 1, toSafeInt(params && params.index, 0)));
  const slot = farm.cookInfo[index] || { index, finishTime: 0, reward: 0, time: 0 };
  const now = Date.now();

  if (slot.finishTime > now || slot.reward > 0) {
    return {
      tag: 2416,
      msgUid,
      data: {
        result: 0,
        cookFinishTime: slot.finishTime,
        cookReward: slot.reward,
        cookTime: slot.time,
      },
    };
  }

  const nextCookCount = Math.max(1, toSafeInt(farm.cookDayCount, 0) + 1);
  const timeSec = getCookDurationSecondsByDailyCount(nextCookCount);
  const rewardCount = calcCookBaoziRewardCount();

  slot.index = index;
  slot.time = timeSec;
  slot.reward = rewardCount;
  slot.finishTime = now + timeSec * 1000;
  farm.cookInfo[index] = slot;
  farm.cookDayKey = getLocalDayKey(now);
  farm.cookDayCount = nextCookCount;
  syncCookSummary(farm);

  await savePlayer(session, player);
  return {
    tag: 2416,
    msgUid,
    data: {
      result: 0,
      cookFinishTime: slot.finishTime,
      cookReward: slot.reward,
      cookTime: slot.time,
    },
  };
}

async function handleCookReward(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2417, msgUid, data: { result: -1, rewards: [] } };

  const farm = ensureFarmInfo(player);
  const index = Math.max(0, Math.min(COOK_SLOT_MAX - 1, toSafeInt(params && params.index, 0)));
  const useCache = !!(params && params.cache);
  const slot = farm.cookInfo[index] || { index, finishTime: 0, reward: 0, time: 0 };
  const now = Date.now();
  if (slot.reward <= 0 || slot.finishTime <= 0 || slot.finishTime > now) {
    return {
      tag: 2417,
      msgUid,
      data: {
        result: 1,
        rewards: [],
      },
    };
  }
  const beforeSnapshot = snapshotItemCounts(player, [4]);

  const rewards = normalizeRewardRows([{ id: 4, count: slot.reward }]);
  if (useCache) {
    appendCacheRewards(farm, rewards, 'recover');
    farm.offlineReward = true;
  } else {
    rewards.forEach((row) => addRewardToPlayer(player, row.id, row.count));
  }

  slot.finishTime = 0;
  slot.reward = 0;
  slot.time = 0;
  farm.cookInfo[index] = slot;
  syncCookSummary(farm);

  await savePlayer(session, player);
  return withFarmSync(player, beforeSnapshot, {
    tag: 2417,
    msgUid,
    data: {
      result: 0,
      rewards: useCache ? [] : rewards,
    },
  });
}

async function handleNeighborInfo(_params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2418, msgUid, data: { result: -1, neighbors: { neighbors: [], refreshtime: 0 }, enemys: { ememylist: [] } } };

  const farm = ensureFarmInfo(player);
  const now = Date.now();
  if (!Array.isArray(farm.neighbors.neighbors) || farm.neighbors.neighbors.length <= 0 || Math.max(0, toSafeInt(farm.neighbors.refreshtime, 0)) <= 0) {
    const refreshCount = Math.max(1, toSafeInt(getPlantBaseConfig().stealGardenListCount, 3));
    const refreshSec = Math.max(1, toSafeInt(getPlantBaseConfig().stealGardenListCd, 60));
    farm.neighbors.neighbors = await buildFarmNeighborList(player, refreshCount);
    farm.neighbors.refreshtime = now + refreshSec * 1000;
    await savePlayer(session, player);
  }
  return {
    tag: 2418,
    msgUid,
    data: {
      result: 0,
      neighbors: clonePlain(farm.neighbors),
      enemys: clonePlain(farm.enemys),
    },
  };
}

async function handleUseCheese(_params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2419, msgUid, data: { result: -1 } };

  const reduce = Math.max(1, toSafeInt(getPlantBaseConfig().reduceTired, 40));
  const current = getMouseTired(player);
  if (!hasEnoughItemOrCurrency(player, 102, 1) || current < reduce) {
    return { tag: 2419, msgUid, data: { result: 1 } };
  }
  const beforeSnapshot = snapshotItemCounts(player, [102, -1]);
  consumeItemOrCurrency(player, 102, 1, false);
  reduceMouseTired(player, reduce);

  await savePlayer(session, player);
  return withFarmSync(player, beforeSnapshot, {
    tag: 2419,
    msgUid,
    data: {
      result: 0,
    },
  });
}

async function handlePlantMonth(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2420, msgUid, data: { result: -1 } };

  const farm = ensureFarmInfo(player);
  const index = toSafeInt(params && params.index, -1);
  const seed = toSafeInt(params && params.seed, 0);
  const now = Date.now();
  const block = applyPlantOnBlock(farm, index, seed, now);
  if (!block) {
    return { tag: 2420, msgUid, data: { result: -1 } };
  }

  const mainTaskChanged = addFarmPlantCount(player, 1);
  const sideTaskChanged = incrementFarmSideTaskProgress(player, 18, 1);
  const taskChanged = !!(mainTaskChanged || sideTaskChanged);
  await savePlayer(session, player);
  return withFarmSync(player, {}, {
    tag: 2420,
    msgUid,
    data: {
      result: 0,
      ownerId: getSelfDbid(session),
      blockinfo: clonePlain(block),
    },
  }, { taskChanged });
}

async function handleGetCacheReward(_params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2421, msgUid, data: { result: -1, rewards: buildRewardInfo([]) } };

  const farm = ensureFarmInfo(player);
  const rewards = normalizeRewardRows(farm.cacheRecover);
  if (rewards.length <= 0) {
    return { tag: 2421, msgUid, data: { result: 1, rewards: buildRewardInfo([]) } };
  }
  const beforeSnapshot = snapshotItemCounts(player, rewards.map((row) => row.id));
  rewards.forEach((row) => addRewardToPlayer(player, row.id, row.count));
  farm.cacheRecover = [];
  farm.offlineReward = farm.cacheOffline.length > 0;

  await savePlayer(session, player);
  return withFarmSync(player, beforeSnapshot, {
    tag: 2421,
    msgUid,
    data: {
      result: 0,
      rewards: buildRewardInfo(rewards),
    },
  });
}

async function handleDriveAway(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2422, msgUid, data: { result: -1 } };

  const farm = ensureFarmInfo(player);
  const index = toSafeInt(params && params.index, -1);
  const targetDbid = String((params && (params.dbid || params.playerId || params.targetId)) || '').trim();

  let block = findFarmBlock(farm, index, false);
  if (!block && targetDbid) {
    block = farm.blockInfo.find((row) => getBlockRobberDbid(row) === targetDbid) || null;
  }
  const beforeSnapshot = snapshotItemCounts(player, [-2]);
  let used = false;
  const robberDbid = getBlockRobberDbid(block);
  if (block && block.robber && (!targetDbid || !robberDbid || robberDbid === targetDbid)) {
    cancelBlockSteal(block);
    used = true;
  }

  if (used) addDriveAwayUsed(player, 1);

  await savePlayer(session, player);
  const packets = [];
  const payload = buildItemDeltaPayload(player, beforeSnapshot);
  if (payload) {
    packets.push({ tag: 1202, msgUid: 0, data: payload });
  }
  if (block) {
    packets.push({
      tag: 2401,
      msgUid: 0,
        data: {
          result: 0,
          ownerId: getSelfDbid(session),
          blockinfo: clonePlain(block),
          blockInfo: clonePlain(block),
        },
      });
  }
  packets.push({
    tag: 2422,
    msgUid,
    data: {
      result: 0,
    },
  });
  return packets;
}

async function handleRatSkinChange(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2423, msgUid, data: { result: -1, id: 0 } };

  const farm = ensureFarmInfo(player);
  const id = normalizeRatSkinId(params && params.id);
  farm.ratSkin = id;

  await savePlayer(session, player);
  return {
    tag: 2423,
    msgUid,
    data: {
      result: 0,
      id,
    },
  };
}

async function handleOfflineReward(_params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2424, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };

  const farm = ensureFarmInfo(player);
  const rewards = mergeRewardRows(farm.cacheOffline, farm.cacheRecover);
  if (rewards.length <= 0) {
    return { tag: 2424, msgUid, data: { result: 1, rewardInfo: buildRewardInfo([]) } };
  }
  const beforeSnapshot = snapshotItemCounts(player, rewards.map((row) => row.id));
  rewards.forEach((row) => addRewardToPlayer(player, row.id, row.count));
  farm.cacheOffline = [];
  farm.cacheRecover = [];
  farm.offlineReward = false;

  await savePlayer(session, player);
  return withFarmSync(player, beforeSnapshot, {
    tag: 2424,
    msgUid,
    data: {
      result: 0,
      rewardInfo: buildRewardInfo(rewards),
    },
  });
}

async function handleAutoStealRecord(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2425, msgUid, data: { result: -1 } };

  const farm = ensureFarmInfo(player);
  const record = Array.isArray(params && params.record)
    ? params.record.map((id) => toSafeInt(id, 0)).filter((id) => id > 0)
    : [];
  farm.autoStealRecord = record;

  await savePlayer(session, player);
  return {
    tag: 2425,
    msgUid,
    data: {
      result: 0,
    },
  };
}

module.exports = {
  ensureFarmInfo,
  buildFarmInfoData,
  handlePlantInfo,
  handlePlantHarvest,
  handlePlantLevelOrRob,
  handlePlantAddLog,
  handlePlantEnemyUpdate,
  handlePlantFightLogCheck,
  handlePlantSpeedUp,
  handlePlantHarvestAll,
  handlePlantDetailAuto,
  handleBuildUpgrade,
  handleBuildCheck,
  handleFightRobber,
  handleBuildSpeedup,
  handleBuildAssist,
  handleFightAssist,
  handleCook,
  handleCookReward,
  handleNeighborInfo,
  handleUseCheese,
  handlePlantMonth,
  handleGetCacheReward,
  handleDriveAway,
  handleRatSkinChange,
  handleOfflineReward,
  handleAutoStealRecord,
};
