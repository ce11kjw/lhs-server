/**
 * Elf handlers.
 * tag: 6000~6007
 */

const configService = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const { buildClientItemList } = require('../services/CurrencySync');
const { addRewardToPlayer } = require('./raid');

const MAX_ELF_LEVEL = 30;

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

function uniqueInts(values = []) {
  const seen = new Set();
  const out = [];
  ensureArray(values).forEach((value) => {
    const n = Math.max(0, toSafeInt(value, 0));
    if (n <= 0 || seen.has(n)) return;
    seen.add(n);
    out.push(n);
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

function weightedPick(rows = [], getWeight = (row) => row.weight || 0) {
  const normalized = rows
    .map((row) => ({ row, weight: Math.max(0, toSafeInt(getWeight(row), 0)) }))
    .filter((entry) => entry.weight > 0);
  if (normalized.length === 0) return null;

  const total = normalized.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < normalized.length; i += 1) {
    roll -= normalized[i].weight;
    if (roll <= 0) return normalized[i].row;
  }
  return normalized[normalized.length - 1].row;
}

function getCurrencyKeyById(itemId) {
  switch (toSafeInt(itemId, 0)) {
    case 1: return 'diamond';
    case 2: return 'silver';
    case 6: return 'gold';
    default: return null;
  }
}

function getItemOrCurrencyCount(player, itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return 0;

  const currKey = getCurrencyKeyById(id);
  if (currKey) {
    return Math.max(0, toSafeInt(player && player.currencies && player.currencies[currKey], 0));
  }

  return Math.max(0, toSafeInt(player && player.items && player.items[id], 0));
}

function hasEnoughItemOrCurrency(player, itemId, count) {
  return getItemOrCurrencyCount(player, itemId) >= Math.max(0, toSafeInt(count, 0));
}

function consumeItemOrCurrency(player, itemId, count) {
  if (!hasEnoughItemOrCurrency(player, itemId, count)) return false;

  const id = toSafeInt(itemId, 0);
  const need = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || need <= 0) return true;

  const currKey = getCurrencyKeyById(id);
  if (currKey) {
    player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
    player.currencies[currKey] = Math.max(0, toSafeInt(player.currencies[currKey], 0) - need);
    return true;
  }

  player.items = player.items || {};
  player.items[id] = Math.max(0, toSafeInt(player.items[id], 0) - need);
  return true;
}

function buildItemSyncPacket(player, trackedIds = [], beforeCountMap = {}) {
  const changed = [];
  uniqueInts(trackedIds).forEach((itemId) => {
    const before = Math.max(0, toSafeInt(beforeCountMap[itemId], 0));
    const after = Math.max(0, getItemOrCurrencyCount(player, itemId));
    if (before === after) return;
    changed.push({ id: itemId, count: after });
  });

  if (changed.length <= 0) return null;
  return {
    tag: 1202,
    msgUid: 0,
    data: {
      result: 0,
      items: buildClientItemList(player),
      changed,
    },
  };
}

function rememberTrackedItem(beforeCountMap, trackedIds, player, itemId) {
  const id = Math.max(0, toSafeInt(itemId, 0));
  if (id <= 0) return;
  trackedIds.add(id);
  if (beforeCountMap[id] == null) {
    beforeCountMap[id] = getItemOrCurrencyCount(player, id);
  }
}

function getElfConfigMap() {
  return ensureObject(configService.get('ElfConfig'));
}

function getAssetsMap() {
  return ensureObject(configService.get('AssetsConfig'));
}

function getElfCallConfigMap() {
  return ensureObject(configService.get('ElfCallConfig'));
}

function getElfBaseConfig() {
  return ensureObject(configService.get('ElfBaseConfig'));
}

function getElfStarUpConfigMap() {
  return ensureObject(configService.get('ElfStarUpConfig'));
}

function getElfWeaponConfigMap() {
  return ensureObject(configService.get('ElfWeaponConfig'));
}

function getElfFightPlanMap() {
  return ensureObject(getElfBaseConfig().fightPlan);
}

function normalizeFightPlanId(value) {
  const planMap = getElfFightPlanMap();
  const ids = Object.keys(planMap)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0 && Array.isArray(planMap[id] || planMap[String(id)]))
    .sort((a, b) => a - b);
  const requested = Math.max(1, toSafeInt(value, 1));
  if (ids.length <= 0 || ids.includes(requested)) return requested;
  return ids[0] || 1;
}

function pickDefaultElfIds() {
  const cfgMap = getElfConfigMap();
  const rows = Object.values(cfgMap).filter((row) => toSafeInt(row && row.id, 0) > 0);
  const callShow = rows
    .filter((row) => toSafeInt(row && row.isCallShow, 0) > 0)
    .map((row) => toSafeInt(row.id, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
  if (callShow.length > 0) return uniqueInts(callShow);
  const all = rows
    .map((row) => toSafeInt(row.id, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
  if (all.length > 0) return uniqueInts(all);
  return [154101];
}

function normalizeElfId(value) {
  const id = Math.max(1, toSafeInt(value, 0));
  const cfgMap = getElfConfigMap();
  if (Object.keys(cfgMap).length <= 0) return id || 154101;
  if (cfgMap[id] || cfgMap[String(id)]) return id;
  return pickDefaultElfIds()[0];
}

function getElfQuality(elfId) {
  const cfg = getElfConfigMap()[elfId] || getElfConfigMap()[String(elfId)] || {};
  return Math.max(1, toSafeInt(cfg.quality, 1));
}

function getElfPieceItemId(elfId) {
  const cfg = getElfConfigMap()[elfId] || getElfConfigMap()[String(elfId)];
  return Math.max(0, toSafeInt(cfg && cfg.piece && cfg.piece.id, 0));
}

function getElfPieceFullCount(elfId) {
  const cfg = getElfConfigMap()[elfId] || getElfConfigMap()[String(elfId)] || {};
  return Math.max(1, toSafeInt(cfg && cfg.piece && cfg.piece.count, 40));
}

function getGeneralPieceItemId(quality) {
  const generalPiece = ensureObject(getElfBaseConfig().generalPiece);
  return Math.max(0, toSafeInt(generalPiece[quality] || generalPiece[String(quality)], 0));
}

function getDuplicateElfPieceRewardCount(elfId) {
  return Math.max(5, Math.floor(getElfPieceFullCount(elfId) / 8));
}

function getElfMaxStar(elfId) {
  const cfgMap = getElfStarUpConfigMap();
  const map = ensureObject(cfgMap[elfId] || cfgMap[String(elfId)]);
  const stars = Object.keys(map)
    .map((k) => toSafeInt(map[k] && map[k].star, -1))
    .filter((n) => n >= 1);
  if (stars.length <= 0) return 75;
  return Math.max(...stars);
}

function getElfMaxLevel(elfId) {
  return Math.min(MAX_ELF_LEVEL, getElfMaxStar(elfId));
}

function normalizeSkillLevel(rawSkillLevel, elfId) {
  const out = {};
  const source = rawSkillLevel && typeof rawSkillLevel === 'object' && !Array.isArray(rawSkillLevel)
    ? rawSkillLevel
    : {};
  const cfg = getElfConfigMap()[elfId] || getElfConfigMap()[String(elfId)] || {};
  const groups = {
    ...ensureObject(cfg.skills),
    ...ensureObject(cfg.awakeSkill),
  };

  Object.keys(groups).forEach((group) => {
    const levels = Array.isArray(groups[group]) ? groups[group] : [];
    const max = Math.max(0, levels.length - 1);
    out[String(group)] = Math.max(0, Math.min(max, toSafeInt(source[group], 0)));
  });

  Object.keys(source).forEach((group) => {
    if (out[group] != null) return;
    out[String(group)] = Math.max(0, toSafeInt(source[group], 0));
  });

  return out;
}

function normalizeWeapon(rawWeapon, elfId) {
  const weapon = ensureObject(rawWeapon);
  const out = {};
  const weaponCfg = ensureObject(getElfWeaponConfigMap()[elfId] || getElfWeaponConfigMap()[String(elfId)]);
  Object.keys(weapon).forEach((key) => {
    const slot = Math.max(1, toSafeInt(key, 0));
    const row = weaponCfg[slot] || weaponCfg[String(slot)] || {};
    const maxLevel = Math.max(0, toSafeInt(row.attrLevel, 0));
    const level = Math.max(0, Math.min(maxLevel || Number.MAX_SAFE_INTEGER, toSafeInt(weapon[key], 0)));
    out[String(slot)] = level;
  });
  return out;
}

function getAwakeNodeInsertList(elfId) {
  const weaponCfg = ensureObject(getElfWeaponConfigMap()[elfId] || getElfWeaponConfigMap()[String(elfId)]);
  return Object.keys(weaponCfg)
    .map((key) => ({ insert: Math.max(1, toSafeInt(key, 0)), row: weaponCfg[key] || weaponCfg[String(key)] || {} }))
    .filter((entry) => entry.insert > 0 && toSafeInt(entry.row.type, 0) === 2)
    .sort((a, b) => a.insert - b.insert);
}

function normalizeAwakeNodes(rawAwakeNodes, elfId, weapon = {}) {
  const source = rawAwakeNodes && typeof rawAwakeNodes === 'object' && !Array.isArray(rawAwakeNodes)
    ? rawAwakeNodes
    : {};
  const out = {};
  getAwakeNodeInsertList(elfId).forEach((entry) => {
    const key = String(entry.insert);
    const maxLevel = Math.max(1, toSafeInt(entry.row.attrLevel, 1));
    const sourceLevel = source[key] != null ? source[key] : weapon[key];
    out[key] = Math.max(0, Math.min(maxLevel, toSafeInt(sourceLevel, 0)));
  });
  return out;
}

function buildAwakeNodesFromWeapon(elfId, weapon = {}) {
  return normalizeAwakeNodes(null, elfId, weapon);
}

function normalizeElfData(row) {
  const data = ensureObject(row);
  const id = normalizeElfId(data.id);
  const maxStar = getElfMaxStar(id);
  const maxLevel = getElfMaxLevel(id);
  const star = Math.max(1, Math.min(maxStar, toSafeInt(data.star, 1)));
  const level = Math.max(1, Math.min(maxLevel, toSafeInt(data.level, Math.min(star, maxLevel))));
  const weapon = normalizeWeapon(data.weapon, id);
  return {
    id,
    level,
    exp: Math.max(0, toSafeInt(data.exp, 0)),
    star: Math.max(level, Math.min(maxStar, star)),
    awake: Math.max(0, Math.min(1, toSafeInt(data.awake, 0))),
    weapon,
    awakeNodes: normalizeAwakeNodes(data.awakeNodes, id, weapon),
    skillLevel: normalizeSkillLevel(data.skillLevel, id),
    curInsert: Math.max(0, toSafeInt(data.curInsert, 0)),
  };
}

function buildRewardInfo(items = [], elves = []) {
  return {
    items: ensureArray(items),
    equips: [],
    swords: [],
    pets: [],
    artifacts: [],
    gems: [],
    valhalla: [],
    bloodline: [],
    fashion: [],
    sailor: [],
    extra: [],
    elves: ensureArray(elves).map((row) => normalizeElfData(row)),
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

function findElfData(info, id) {
  const elfId = Math.max(1, toSafeInt(id, 0));
  return info.elfData.find((row) => Math.max(1, toSafeInt(row && row.id, 0)) === elfId) || null;
}

function upsertElfData(info, data) {
  const row = normalizeElfData(data);
  const idx = info.elfData.findIndex((v) => Math.max(1, toSafeInt(v && v.id, 0)) === row.id);
  if (idx >= 0) info.elfData[idx] = row;
  else info.elfData.push(row);
  return row;
}

function createDefaultElfData(id = pickDefaultElfIds()[0]) {
  return normalizeElfData({
    id,
    star: 1,
    awake: 0,
    weapon: {},
    curInsert: 0,
  });
}

function getCallCount() {
  return Math.max(1, toSafeInt(getElfBaseConfig().callCount, 40));
}

function syncAdjustCount(info) {
  const max = getCallCount();
  info.summonPityCount = Math.max(0, Math.min(max - 1, toSafeInt(info.summonPityCount, 0)));
  info.adjustCount = Math.max(1, Math.min(max, info.summonPityCount + 1));
}

function resetDailyFreeIfNeeded(info, now = Date.now()) {
  const dayKey = toDayKey(now);
  if (toSafeInt(info.dailyFreeDayKey, 0) === dayKey) return false;
  info.dailyFreeDayKey = dayKey;
  info.dailyFree = 0;
  return true;
}

function ensureElfInfo(player) {
  player.other_attr_info = ensureObject(player.other_attr_info);
  const root = player.other_attr_info;
  root.elfInfo = ensureObject(root.elfInfo);
  const info = root.elfInfo;

  info.fightPlan = normalizeFightPlanId(info.fightPlan);
  info.setMap = ensureObject(info.setMap);
  info.elfData = ensureArray(info.elfData).map((row) => normalizeElfData(row));
  info.atlas = uniqueInts(info.atlas);
  info.callLevel = Math.max(1, toSafeInt(info.callLevel, 1));
  info.callExp = Math.max(0, toSafeInt(info.callExp, 0));
  info.dailyFree = Math.max(0, Math.min(1, toSafeInt(info.dailyFree, 0)));
  info.dailyFreeDayKey = Math.max(0, toSafeInt(info.dailyFreeDayKey, 0));
  info.summonTotalCount = Math.max(0, toSafeInt(info.summonTotalCount, 0));
  info.summonPityCount = info.summonPityCount == null
    ? Math.max(0, toSafeInt(info.adjustCount, 1) - 1)
    : Math.max(0, toSafeInt(info.summonPityCount, 0));

  if (info.elfData.length <= 0) {
    info.elfData.push(createDefaultElfData());
  }

  info.elfData = info.elfData.filter((row, idx, arr) => {
    const id = Math.max(1, toSafeInt(row && row.id, 0));
    return arr.findIndex((v) => Math.max(1, toSafeInt(v && v.id, 0)) === id) === idx;
  });

  const availableIds = new Set(info.elfData.map((row) => Math.max(1, toSafeInt(row && row.id, 1))));
  const nextSetMap = {};
  const usedIds = new Set();
  Object.keys(info.setMap).forEach((slotKey) => {
    const slot = Math.max(1, toSafeInt(slotKey, 0));
    const id = normalizeElfId(info.setMap[slotKey]);
    if (slot <= 0 || id <= 0 || !availableIds.has(id) || usedIds.has(id)) return;
    nextSetMap[String(slot)] = id;
    usedIds.add(id);
  });
  info.setMap = nextSetMap;

  syncAdjustCount(info);
  resetDailyFreeIfNeeded(info);
  return info;
}

function getSummonLevelConfig(level) {
  const cfgMap = getElfCallConfigMap();
  return cfgMap[level] || cfgMap[String(level)] || {};
}

function getMaxSummonLevel() {
  const cfgMap = getElfCallConfigMap();
  const levels = Object.keys(cfgMap)
    .map((key) => toSafeInt(key, 0))
    .filter((level) => level > 0)
    .sort((a, b) => a - b);
  return levels.length > 0 ? levels[levels.length - 1] : 1;
}

function getSummonLevelUpExp(level) {
  return Math.max(0, toSafeInt(getSummonLevelConfig(level).exp, 0));
}

function addSummonProgress(info, summonCount) {
  const maxLevel = getMaxSummonLevel();
  let pendingExp = Math.max(0, toSafeInt(summonCount, 0)) * 100;

  while (pendingExp > 0 && info.callLevel < maxLevel) {
    const need = getSummonLevelUpExp(info.callLevel);
    if (need <= 0) break;
    const missing = Math.max(0, need - Math.max(0, toSafeInt(info.callExp, 0)));
    if (pendingExp < missing) {
      info.callExp += pendingExp;
      pendingExp = 0;
      break;
    }
    pendingExp -= missing;
    info.callLevel += 1;
    info.callExp = 0;
  }

  if (info.callLevel >= maxLevel) {
    info.callLevel = maxLevel;
    info.callExp = 0;
  }
}

function getSummonQualityWeightRows(level, isBody) {
  const cfg = getSummonLevelConfig(level);
  const source = ensureObject(isBody ? cfg.callRateShow1 : cfg.callRateShow2);
  const rows = Object.keys(source)
    .map((qualityKey) => ({
      quality: Math.max(1, toSafeInt(qualityKey, 0)),
      weight: Math.max(0, toSafeInt(source[qualityKey], 0)),
    }))
    .filter((row) => row.quality > 0 && row.weight > 0);

  if (rows.length > 0) return rows;

  return ensureArray(cfg.elfRate)
    .map((row) => ({
      quality: Math.max(1, toSafeInt(row && row.id, 0)),
      weight: Math.max(0, toSafeInt(row && row.weight, 0)),
    }))
    .filter((row) => row.quality > 0 && row.weight > 0);
}

function getSummonPoolByQuality(quality) {
  const cfgMap = getElfConfigMap();
  const pool = [];
  Object.keys(cfgMap).forEach((key) => {
    const row = cfgMap[key];
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    if (id <= 0) return;
    if (Math.max(0, toSafeInt(row && row.isCallShow, 0)) <= 0) return;
    if (quality > 0 && Math.max(0, toSafeInt(row && row.quality, 0)) !== quality) return;
    pool.push(id);
  });
  if (pool.length > 0) return pool.sort((a, b) => a - b);
  return pickDefaultElfIds();
}

function pickQuality(rows = [], fallback = 4) {
  const picked = weightedPick(rows, (row) => row.weight);
  return Math.max(1, toSafeInt(picked && picked.quality, fallback));
}

function pickSummonTargetElf(level, forceBody) {
  const bodyRows = getSummonQualityWeightRows(level, true);
  const pieceRows = getSummonQualityWeightRows(level, false);
  const bodyTotal = bodyRows.reduce((sum, row) => sum + row.weight, 0);
  const pieceTotal = pieceRows.reduce((sum, row) => sum + row.weight, 0);

  let isBody = !!forceBody;
  if (!forceBody) {
    const total = bodyTotal + pieceTotal;
    isBody = total <= 0 ? true : Math.random() * total < bodyTotal;
  }

  const quality = pickQuality(isBody ? bodyRows : pieceRows, 4);
  const pool = getSummonPoolByQuality(quality);
  const elfId = pool[Math.max(0, Math.min(pool.length - 1, Math.floor(Math.random() * pool.length)))] || pickDefaultElfIds()[0];
  return { elfId, isBody };
}

function normalizeCurrentInsert(row) {
  const weaponCfg = ensureObject(getElfWeaponConfigMap()[row.id] || getElfWeaponConfigMap()[String(row.id)]);
  if (Object.keys(weaponCfg).length <= 0 || Math.max(0, toSafeInt(row.awake, 0)) <= 0) {
    row.curInsert = 0;
    return row;
  }

  let nextInsert = 1;
  Object.keys(weaponCfg).forEach((key) => {
    const insert = Math.max(1, toSafeInt(key, 0));
    const cfg = weaponCfg[key] || weaponCfg[String(key)] || {};
    const attrLevel = Math.max(0, toSafeInt(cfg.attrLevel, 0));
    const currentLevel = Math.max(0, toSafeInt(row.weapon && row.weapon[String(insert)], 0));
    if (insert > nextInsert) return;
    if (currentLevel >= attrLevel && (weaponCfg[String(insert + 1)] || weaponCfg[insert + 1])) {
      nextInsert = insert + 1;
    }
  });
  row.curInsert = Math.max(1, nextInsert);
  row.awakeNodes = buildAwakeNodesFromWeapon(row.id, row.weapon || {});
  return row;
}

function getStarCostRow(elfId, currentStar) {
  const map = ensureObject(getElfStarUpConfigMap()[elfId] || getElfStarUpConfigMap()[String(elfId)]);
  return map[currentStar] || map[String(currentStar)] || null;
}

function getWeaponInsertRow(elfId, insert) {
  const map = ensureObject(getElfWeaponConfigMap()[elfId] || getElfWeaponConfigMap()[String(elfId)]);
  return map[insert] || map[String(insert)] || null;
}

function buildConsumePlan(player, costs, pieceItemId, universalPieceId) {
  const plan = [];
  for (const cost of ensureArray(costs)) {
    const costId = Math.max(0, toSafeInt(cost && cost.id, 0));
    const costCount = Math.max(0, toSafeInt(cost && cost.count, 0));
    if (costId <= 0 || costCount <= 0) continue;

    if (pieceItemId > 0 && costId === pieceItemId && universalPieceId > 0) {
      const directHave = getItemOrCurrencyCount(player, pieceItemId);
      const universalHave = getItemOrCurrencyCount(player, universalPieceId);
      if (directHave + universalHave < costCount) return null;
      const directUse = Math.min(directHave, costCount);
      const universalUse = Math.max(0, costCount - directUse);
      if (directUse > 0) plan.push({ id: pieceItemId, count: directUse });
      if (universalUse > 0) plan.push({ id: universalPieceId, count: universalUse });
      continue;
    }

    if (!hasEnoughItemOrCurrency(player, costId, costCount)) return null;
    plan.push({ id: costId, count: costCount });
  }
  return plan;
}

function buildAwakeNodeConsumeCosts(row, entry) {
  const costs = ensureArray(entry && entry.row && entry.row.consumes).map((cost) => ({
    id: Math.max(0, toSafeInt(cost && cost.id, 0)),
    count: Math.max(0, toSafeInt(cost && cost.count, 0)),
  })).filter((cost) => cost.id > 0 && cost.count > 0);
  if (toSafeInt(entry && entry.row && entry.row.type, 0) !== 2) return costs;

  const attrCostRow = getWeaponInsertRow(row.id, 1);
  const crystalCost = ensureArray(attrCostRow && attrCostRow.consumes)
    .map((cost) => ({ id: Math.max(0, toSafeInt(cost && cost.id, 0)), count: Math.max(0, toSafeInt(cost && cost.count, 0)) }))
    .find((cost) => cost.id > 0 && cost.id !== 2 && cost.count > 0);
  if (crystalCost && !costs.some((cost) => cost.id === crystalCost.id)) {
    costs.unshift(crystalCost);
  }
  return costs;
}

function applyConsumePlan(player, plan) {
  for (const row of ensureArray(plan)) {
    if (!consumeItemOrCurrency(player, row.id, row.count)) return false;
  }
  return true;
}

function upgradeRandomSkillGroup(row) {
  const cfg = getElfConfigMap()[row.id] || getElfConfigMap()[String(row.id)] || {};
  const awakeCond = Math.max(1, toSafeInt(getElfBaseConfig().awakeCond, 30));
  const groups = [];

  Object.keys(ensureObject(cfg.skills)).forEach((group) => {
    const levels = ensureArray(cfg.skills[group]);
    const current = Math.max(0, toSafeInt(row.skillLevel && row.skillLevel[group], 0));
    if (levels.length > 0 && current < levels.length - 1) {
      groups.push(String(group));
    }
  });

  if (Math.max(1, toSafeInt(row.star, 1)) >= awakeCond) {
    Object.keys(ensureObject(cfg.awakeSkill)).forEach((group) => {
      const levels = ensureArray(cfg.awakeSkill[group]);
      const current = Math.max(0, toSafeInt(row.skillLevel && row.skillLevel[group], 0));
      if (levels.length > 0 && current < levels.length - 1) {
        groups.push(String(group));
      }
    });
  }

  if (groups.length <= 0) return false;
  const targetGroup = groups[Math.max(0, Math.min(groups.length - 1, Math.floor(Math.random() * groups.length)))];
  row.skillLevel = ensureObject(row.skillLevel);
  row.skillLevel[targetGroup] = Math.max(0, toSafeInt(row.skillLevel[targetGroup], 0)) + 1;
  row.skillLevel = normalizeSkillLevel(row.skillLevel, row.id);
  return true;
}

function applyStarUpgrade(row) {
  const skillLevelCond = Math.max(1, toSafeInt(getElfBaseConfig().skillLevelCond, 5));
  const maxLevel = getElfMaxLevel(row.id);
  const maxStar = getElfMaxStar(row.id);
  const currentStar = Math.max(1, toSafeInt(row.star, 1));
  if (currentStar >= maxStar) return false;

  row.star = Math.min(maxStar, currentStar + 1);
  row.level = Math.max(1, Math.min(maxLevel, row.star));
  if (row.star % skillLevelCond === 0) {
    upgradeRandomSkillGroup(row);
  }
  return true;
}

function applyLevelUpgrade(row) {
  return applyStarUpgrade(row);
}

function getLevelCostRow(elfId, currentLevel) {
  return getStarCostRow(elfId, currentLevel);
}

function getNextAwakeNodeInsert(row, requestedInsert) {
  const nodes = getAwakeNodeInsertList(row.id);
  if (nodes.length <= 0) return null;

  if (requestedInsert > 0) {
    const target = nodes.find((entry) => entry.insert === requestedInsert);
    if (!target) return null;
    const targetIndex = nodes.findIndex((entry) => entry.insert === requestedInsert);
    for (let index = 0; index < targetIndex; index += 1) {
      const prev = nodes[index];
      const prevLevel = Math.max(0, toSafeInt(row.weapon && row.weapon[String(prev.insert)], 0));
      const prevMax = Math.max(1, toSafeInt(prev.row.attrLevel, 1));
      if (prevLevel < prevMax) return null;
    }
    return target;
  }

  for (let index = 0; index < nodes.length; index += 1) {
    const entry = nodes[index];
    const current = Math.max(0, toSafeInt(row.weapon && row.weapon[String(entry.insert)], 0));
    const maxLevel = Math.max(1, toSafeInt(entry.row.attrLevel, 1));
    if (current >= maxLevel) continue;
    return entry;
  }
  return null;
}

function applyElfEquipChange(info, elfId, slotIndex) {
  const slot = toSafeInt(slotIndex, 0);
  const id = Math.max(0, toSafeInt(elfId, 0));
  if (slot <= 0) return false;

  Object.keys(info.setMap).forEach((slotKey) => {
    if (Math.max(0, toSafeInt(info.setMap[slotKey], 0)) === id || Math.max(0, toSafeInt(slotKey, 0)) === slot) {
      delete info.setMap[slotKey];
    }
  });

  if (id > 0) {
    info.setMap[String(slot)] = id;
  }
  return true;
}

function normalizeSummonResultRows(result = []) {
  const assetsMap = getAssetsMap();
  return ensureArray(result).map((row) => {
    const id = Math.max(1, toSafeInt(row && row.id, 0));
    const count = Math.max(1, toSafeInt(row && row.count, 1));
    const asset = assetsMap[id] || assetsMap[String(id)];
    if (!asset) return { id, count };
    return {
      id,
      count,
      quality: Math.max(1, toSafeInt(asset.quality, 1)),
      type: Math.max(1, toSafeInt(asset.type, 1)),
    };
  });
}

async function handleElfChangePlan(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6001, msgUid, data: { result: -1, fightPlan: 1 } };

  const info = ensureElfInfo(player);
  info.fightPlan = normalizeFightPlanId(params && params.fightPlan != null ? params.fightPlan : info.fightPlan);
  await playerService.savePlayer(session.userId, player);
  return { tag: 6001, msgUid, data: { result: 0, fightPlan: info.fightPlan } };
}

async function handleElfInfo(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6000, msgUid, data: ensureElfInfo({}) };

  const info = ensureElfInfo(player);
  const requestedId = toSafeInt(params && params.id, 0);
  const requestedIndex = toSafeInt(params && params.index, 0);
  let result = 0;

  if (params && Object.prototype.hasOwnProperty.call(params, 'index')) {
    if (requestedId > 0 && !findElfData(info, requestedId)) {
      result = -1;
    } else {
      applyElfEquipChange(info, requestedId, requestedIndex);
    }
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6000,
    msgUid,
    data: {
      ...info,
      result,
    },
  };
}

async function handleElfStarUp(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6002, msgUid, data: { result: -1, elfData: [] } };

  const info = ensureElfInfo(player);
  const beforeCountMap = {};
  const trackedIds = new Set();
  const updated = [];
  const requestId = toSafeInt(params && params.id, 0);
  const targetRows = requestId < 0
    ? info.elfData.slice()
    : [findElfData(info, requestId)].filter(Boolean);

  targetRows.forEach((row) => {
    const currentRow = findElfData(info, row.id);
    if (!currentRow) return;
    const costRow = getStarCostRow(currentRow.id, currentRow.star);
    const nextCfg = getStarCostRow(currentRow.id, currentRow.star + 1);
    if (!costRow || !nextCfg || ensureArray(costRow.consumes).length <= 0) return;

    const pieceItemId = getElfPieceItemId(currentRow.id);
    const universalPieceId = getGeneralPieceItemId(getElfQuality(currentRow.id));
    const plan = buildConsumePlan(player, costRow.consumes, pieceItemId, universalPieceId);
    if (!plan || plan.length <= 0) return;

    plan.forEach((cost) => rememberTrackedItem(beforeCountMap, trackedIds, player, cost.id));
    if (!applyConsumePlan(player, plan)) return;
    if (!applyStarUpgrade(currentRow)) return;
    updated.push(upsertElfData(info, currentRow));
  });

  if (updated.length <= 0) {
    return { tag: 6002, msgUid, data: { result: 1, elfData: [] } };
  }

  await playerService.savePlayer(session.userId, player);
  const syncPacket = buildItemSyncPacket(player, Array.from(trackedIds), beforeCountMap);
  const response = {
    tag: 6002,
    msgUid,
    data: {
      result: 0,
      elfData: updated,
    },
  };
  return syncPacket ? [syncPacket, response] : response;
}

async function handleElfAwake(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6003, msgUid, data: { result: -1, elfData: null } };

  const info = ensureElfInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, pickDefaultElfIds()[0]));
  const row = findElfData(info, id);
  if (!row) return { tag: 6003, msgUid, data: { result: 1, elfData: null } };

  const awakeCond = Math.max(1, toSafeInt(getElfBaseConfig().awakeCond, 30));
  if (row.awake > 0) {
    return { tag: 6003, msgUid, data: { result: 0, elfData: upsertElfData(info, row) } };
  }
  if (Math.max(toSafeInt(row.star, 1), toSafeInt(row.level, 1)) < awakeCond) {
    return { tag: 6003, msgUid, data: { result: 1, elfData: row } };
  }

  row.awake = 1;
  if (!row.weapon || typeof row.weapon !== 'object' || Array.isArray(row.weapon)) row.weapon = {};
  if (toSafeInt(row.curInsert, 0) <= 0) row.curInsert = 1;
  const next = upsertElfData(info, normalizeCurrentInsert(row));

  await playerService.savePlayer(session.userId, player);
  return { tag: 6003, msgUid, data: { result: 0, elfData: next } };
}

async function handleElfLevelUp(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6008, msgUid, data: { result: -1, elfData: [] } };

  const info = ensureElfInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, pickDefaultElfIds()[0]));
  const count = Math.max(1, toSafeInt(params && params.count, 1));
  const row = findElfData(info, id);
  if (!row) return { tag: 6008, msgUid, data: { result: 1, elfData: [] } };

  const beforeCountMap = {};
  const trackedIds = new Set();
  let updatedCount = 0;

  for (let index = 0; index < count; index += 1) {
    const costRow = getLevelCostRow(row.id, row.level);
    if (!costRow || ensureArray(costRow.consumes).length <= 0) break;
    const pieceItemId = getElfPieceItemId(row.id);
    const universalPieceId = getGeneralPieceItemId(getElfQuality(row.id));
    const plan = buildConsumePlan(player, costRow.consumes, pieceItemId, universalPieceId);
    if (!plan || plan.length <= 0) break;

    plan.forEach((cost) => rememberTrackedItem(beforeCountMap, trackedIds, player, cost.id));
    if (!applyConsumePlan(player, plan)) break;
    if (!applyLevelUpgrade(row)) break;
    updatedCount += 1;
  }

  if (updatedCount <= 0) {
    return { tag: 6008, msgUid, data: { result: 1, elfData: [] } };
  }

  const next = upsertElfData(info, row);
  await playerService.savePlayer(session.userId, player);
  const syncPacket = buildItemSyncPacket(player, Array.from(trackedIds), beforeCountMap);
  const response = {
    tag: 6008,
    msgUid,
    data: {
      result: 0,
      upgradeCount: updatedCount,
      elfData: [next],
    },
  };
  return syncPacket ? [syncPacket, response] : response;
}

async function handleElfWeaponUp(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6004, msgUid, data: { result: -1, elfData: null } };

  const info = ensureElfInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, pickDefaultElfIds()[0]));
  const row = findElfData(info, id);
  if (!row) return { tag: 6004, msgUid, data: { result: 1, elfData: null } };
  if (toSafeInt(row.awake, 0) <= 0) return { tag: 6004, msgUid, data: { result: 1, elfData: row } };

  normalizeCurrentInsert(row);
  const slot = Math.max(1, toSafeInt(row.curInsert, 1));
  const insertCfg = getWeaponInsertRow(row.id, slot);
  if (!insertCfg) return { tag: 6004, msgUid, data: { result: 1, elfData: row } };

  const maxLevel = Math.max(0, toSafeInt(insertCfg.attrLevel, 0));
  const beforeCountMap = {};
  const trackedIds = new Set();
  const pieceItemId = getElfPieceItemId(row.id);
  const universalPieceId = getGeneralPieceItemId(getElfQuality(row.id));
  let upgraded = 0;

  while (Math.max(0, toSafeInt(row.weapon[String(slot)], 0)) < maxLevel) {
    const plan = buildConsumePlan(player, insertCfg.consumes, pieceItemId, universalPieceId);
    if (!plan || plan.length <= 0) break;
    plan.forEach((cost) => rememberTrackedItem(beforeCountMap, trackedIds, player, cost.id));
    if (!applyConsumePlan(player, plan)) break;
    row.weapon[String(slot)] = Math.max(0, toSafeInt(row.weapon[String(slot)], 0) + 1);
    upgraded += 1;
    if (!(params && params.auto)) break;
  }

  if (upgraded <= 0) {
    return { tag: 6004, msgUid, data: { result: 1, elfData: row } };
  }

  const next = upsertElfData(info, normalizeCurrentInsert(row));
  await playerService.savePlayer(session.userId, player);
  const syncPacket = buildItemSyncPacket(player, Array.from(trackedIds), beforeCountMap);
  const response = { tag: 6004, msgUid, data: { result: 0, elfData: next } };
  return syncPacket ? [syncPacket, response] : response;
}

async function handleElfAwakeNodeUp(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6009, msgUid, data: { result: -1, elfData: null } };

  const info = ensureElfInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, pickDefaultElfIds()[0]));
  const row = findElfData(info, id);
  if (!row) return { tag: 6009, msgUid, data: { result: 1, elfData: null } };
  if (toSafeInt(row.awake, 0) <= 0) return { tag: 6009, msgUid, data: { result: 1, elfData: row } };

  const requestedInsert = Math.max(0, toSafeInt(params && (params.insert != null ? params.insert : params.node), 0));
  const entry = getNextAwakeNodeInsert(row, requestedInsert);
  if (!entry) return { tag: 6009, msgUid, data: { result: 1, elfData: row } };

  const currentLevel = Math.max(0, toSafeInt(row.weapon && row.weapon[String(entry.insert)], 0));
  const maxLevel = Math.max(1, toSafeInt(entry.row.attrLevel, 1));
  if (currentLevel >= maxLevel) return { tag: 6009, msgUid, data: { result: 1, elfData: row } };

  const beforeCountMap = {};
  const trackedIds = new Set();
  const pieceItemId = getElfPieceItemId(row.id);
  const universalPieceId = getGeneralPieceItemId(getElfQuality(row.id));
  const plan = buildConsumePlan(player, buildAwakeNodeConsumeCosts(row, entry), pieceItemId, universalPieceId);
  if (!plan || plan.length <= 0) return { tag: 6009, msgUid, data: { result: 1, elfData: row } };

  plan.forEach((cost) => rememberTrackedItem(beforeCountMap, trackedIds, player, cost.id));
  if (!applyConsumePlan(player, plan)) return { tag: 6009, msgUid, data: { result: 1, elfData: row } };

  row.weapon[String(entry.insert)] = currentLevel + 1;
  const next = upsertElfData(info, normalizeCurrentInsert(row));
  await playerService.savePlayer(session.userId, player);
  const syncPacket = buildItemSyncPacket(player, Array.from(trackedIds), beforeCountMap);
  const response = {
    tag: 6009,
    msgUid,
    data: {
      result: 0,
      insert: entry.insert,
      elfData: next,
    },
  };
  return syncPacket ? [syncPacket, response] : response;
}

async function handleElfDecompose(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6005, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };

  const info = ensureElfInfo(player);
  const ids = uniqueInts(params && params.elfIds);
  const removedRows = [];
  info.elfData = info.elfData.filter((row) => {
    const id = Math.max(1, toSafeInt(row && row.id, 0));
    if (!ids.includes(id)) return true;
    if (info.elfData.length - removedRows.length <= 1) return true;
    removedRows.push(row);
    return false;
  });

  Object.keys(info.setMap).forEach((slotKey) => {
    const slotElfId = Math.max(1, toSafeInt(info.setMap[slotKey], 0));
    if (removedRows.some((row) => row.id === slotElfId)) delete info.setMap[slotKey];
  });

  const rewardRows = [];
  removedRows.forEach((row) => {
    const crystalCount = 5 + Math.floor(Math.max(0, row.star - 1) / 5) + (row.awake > 0 ? 5 : 0);
    const silverCount = 200 * Math.max(1, row.star);
    rewardRows.push({ id: 186, count: crystalCount });
    rewardRows.push({ id: 2, count: silverCount });
  });

  const beforeCountMap = {};
  const trackedIds = new Set();
  rewardRows.forEach((reward) => rememberTrackedItem(beforeCountMap, trackedIds, player, reward.id));
  const rewards = grantRewards(player, rewardRows);

  await playerService.savePlayer(session.userId, player);
  const syncPacket = buildItemSyncPacket(player, Array.from(trackedIds), beforeCountMap);
  const response = {
    tag: 6005,
    msgUid,
    data: {
      result: 0,
      rewardInfo: buildRewardInfo(rewards),
    },
  };
  return syncPacket ? [syncPacket, response] : response;
}

async function handleElfHandbookReward(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6006, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };

  const info = ensureElfInfo(player);
  const unlockedIds = info.elfData
    .map((row) => Math.max(1, toSafeInt(row && row.id, 0)))
    .filter((id) => !info.atlas.includes(id));

  const rewardRows = [];
  unlockedIds.forEach((elfId) => {
    const cfg = getElfConfigMap()[elfId] || getElfConfigMap()[String(elfId)] || {};
    const reward = ensureObject(cfg.atlasReward);
    const rewardId = Math.max(0, toSafeInt(reward.id, 0));
    const rewardCount = Math.max(0, toSafeInt(reward.count, 0));
    if (rewardId > 0 && rewardCount > 0) rewardRows.push({ id: rewardId, count: rewardCount });
  });

  const beforeCountMap = {};
  const trackedIds = new Set();
  rewardRows.forEach((reward) => rememberTrackedItem(beforeCountMap, trackedIds, player, reward.id));
  const rewards = grantRewards(player, rewardRows);
  info.atlas = uniqueInts([...info.atlas, ...unlockedIds]);

  await playerService.savePlayer(session.userId, player);
  const syncPacket = buildItemSyncPacket(player, Array.from(trackedIds), beforeCountMap);
  const response = {
    tag: 6006,
    msgUid,
    data: {
      result: 0,
      rewarded: unlockedIds,
      rewardInfo: buildRewardInfo(rewards),
    },
  };
  return syncPacket ? [syncPacket, response] : response;
}

async function handleElfSummon(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 6007,
      msgUid,
      data: {
        result: [],
        rewardInfo: buildRewardInfo([], []),
        callLevel: 1,
        callExp: 0,
        dailyFree: 0,
        adjustCount: 1,
      },
    };
  }

  const info = ensureElfInfo(player);
  resetDailyFreeIfNeeded(info);

  const summonMany = toSafeInt(params && params.type, 0) > 0;
  const drawCount = summonMany ? Math.max(1, toSafeInt(getElfBaseConfig().callMany && getElfBaseConfig().callMany.count, 10)) : 1;
  const cost = summonMany ? ensureObject(getElfBaseConfig().callMany) : ensureObject(getElfBaseConfig().callOne);
  const costId = Math.max(0, toSafeInt(cost.id, 0));
  const costCount = Math.max(0, toSafeInt(cost.count, 0));
  const beforeCountMap = {};
  const trackedIds = new Set();

  if (!summonMany && toSafeInt(info.dailyFree, 0) === 0) {
    info.dailyFree = 1;
  } else if (costId > 0 && costCount > 0) {
    rememberTrackedItem(beforeCountMap, trackedIds, player, costId);
    if (!consumeItemOrCurrency(player, costId, costCount)) {
      return {
        tag: 6007,
        msgUid,
        data: {
          result: [],
          rewardInfo: buildRewardInfo([], []),
          callLevel: info.callLevel,
          callExp: info.callExp,
          dailyFree: info.dailyFree,
          adjustCount: info.adjustCount,
        },
      };
    }
  }

  const resultRows = [];
  const rewardElves = [];
  const rewardRows = [];
  const pityThreshold = getCallCount();

  for (let index = 0; index < drawCount; index += 1) {
    const forceBody = info.summonPityCount + 1 >= pityThreshold;
    const { elfId, isBody } = pickSummonTargetElf(info.callLevel, forceBody);
    const pieceId = getElfPieceItemId(elfId);

    if (isBody) {
      const existing = findElfData(info, elfId);
      resultRows.push({ id: elfId, count: 1 });
      if (!existing) {
        rewardElves.push(upsertElfData(info, createDefaultElfData(elfId)));
      } else if (pieceId > 0) {
        const duplicateCount = getDuplicateElfPieceRewardCount(elfId);
        rememberTrackedItem(beforeCountMap, trackedIds, player, pieceId);
        rewardRows.push({ id: pieceId, count: duplicateCount });
      }
      info.summonPityCount = 0;
    } else if (pieceId > 0) {
      rememberTrackedItem(beforeCountMap, trackedIds, player, pieceId);
      rewardRows.push({ id: pieceId, count: 1 });
      resultRows.push({ id: pieceId, count: 1 });
      info.summonPityCount += 1;
    } else {
      resultRows.push({ id: elfId, count: 1 });
      info.summonPityCount = 0;
    }

    info.summonTotalCount += 1;
  }

  syncAdjustCount(info);
  addSummonProgress(info, drawCount);
  const rewards = grantRewards(player, rewardRows);

  await playerService.savePlayer(session.userId, player);
  const syncPacket = buildItemSyncPacket(player, Array.from(trackedIds), beforeCountMap);
  const response = {
    tag: 6007,
    msgUid,
    data: {
      result: normalizeSummonResultRows(resultRows),
      rewardInfo: buildRewardInfo(rewards, rewardElves),
      callLevel: info.callLevel,
      callExp: info.callExp,
      dailyFree: info.dailyFree,
      adjustCount: info.adjustCount,
    },
  };
  return syncPacket ? [syncPacket, response] : response;
}

module.exports = {
  ensureElfInfo,
  handleElfInfo,
  handleElfChangePlan,
  handleElfStarUp,
  handleElfAwake,
  handleElfLevelUp,
  handleElfWeaponUp,
  handleElfAwakeNodeUp,
  handleElfDecompose,
  handleElfHandbookReward,
  handleElfSummon,
};
