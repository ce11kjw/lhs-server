/**
 * Spirit system handlers
 * tag: 3600 upgrade/grade-advance, 3601 switch
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const logger = require('../logger');
const { buildClientItemList } = require('../services/CurrencySync');
const { buildActiveTaskUpdatePackets } = require('./task');
const { refreshMainTaskProgress, addArtifactUpgradeCount } = require('../services/MainTaskProgressService');
const { refreshRealmStageTasks } = require('../services/RealmTaskProgressService');
const { ensureEquipInfo } = require('../services/EquipService');

// ─── Fallback configs (used when binary tables are absent) ──────────────────
// 10 grades, each requiring 10 level-ups before grade advancement.
// levelConsume  : 100 silver (id=2) per level-up step
// gradeConsume  : 10 speed tokens (id=6) for the 进阶 grade advance
// addLevelAttrs : cumulative per-level attr increments (6 dimensions)
// addAttrs      : threshold to unlock grade advance (= 10 × addLevelAttrs)
const DEFAULT_SPIRIT_CONFIG = {
  24001: { id: 24001, type: 1, name: '八卦' },
};

const _makeGradeCfg = (grade) => {
  const base = 1 + (grade - 1) * 0.2;
  return {
    grade,
    levelConsume:  { id: 60, count: 10 },                         // 法相升级材料
    gradeConsume:  { id: 61, count: 1 },                          // 法相进阶材料
    addLevelAttrs: {
      101: Math.floor(10 * base),   // 暴击率
      102: Math.floor(200 * base),  // 暴击伤害
      103: Math.floor(5 * base),    // 连击
      104: Math.floor(8 * base),    // 闪避
      105: Math.floor(6 * base),    // 吸血
      106: Math.floor(4 * base),    // 反击
    },
    addAttrs: {
      101: Math.floor(100 * base),
      102: Math.floor(2000 * base),
      103: Math.floor(50 * base),
      104: Math.floor(80 * base),
      105: Math.floor(60 * base),
      106: Math.floor(40 * base),
    },
  };
};

// Grades 1-9 allow advancement 1→2→…→10; at rank 10 maxRank check blocks further advance.
const DEFAULT_SPIRIT_GRADE_CONFIG = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [String(i + 1), _makeGradeCfg(i + 1)])
);
// ─────────────────────────────────────────────────────────────────────────────

const LEGACY_SPIRIT_FRAGMENT_ITEM_ID = 7;
const LEGACY_SPIRIT_EXP_PER_LEVEL = 3;
const LEGACY_SPIRIT_PROGRESS_MODE = 'legacy3001';
const MODERN_SPIRIT_EXP_PER_LEVEL = 1;
const MODERN_SPIRIT_PROGRESS_MODE = 'modern3600';

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

function isSpiritGradeFailOpenEnabled() {
  return parseBool(
    process.env.SPIRIT_GRADE_FAIL_OPEN,
    false,
  );
}

function isSpiritLevelFailOpenEnabled() {
  return parseBool(
    process.env.SPIRIT_LEVEL_FAIL_OPEN,
    false,
  );
}

function isSpiritClientMaterialFailOpenEnabled() {
  return parseBool(
    process.env.SPIRIT_CLIENT_MATERIAL_FAIL_OPEN,
    false,
  );
}

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function getCurrencyKeyById(itemId) {
  switch (toSafeInt(itemId, 0)) {
    case 1: return 'diamond';
    case 2: return 'silver';
    case 6: return 'gold';
    default: return null;
  }
}

function hasEnoughItemOrCurrency(player, itemId, count) {
  const id = toSafeInt(itemId, 0);
  const need = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || need <= 0) return true;

  const currKey = getCurrencyKeyById(id);
  if (currKey) {
    player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
    return toSafeInt(player.currencies[currKey], 0) >= need;
  }

  player.items = player.items || {};
  return toSafeInt(player.items[id], 0) >= need;
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

function getItemOrCurrencyCount(player, itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return 0;

  const currKey = getCurrencyKeyById(id);
  if (currKey) {
    return Math.max(0, toSafeInt(player && player.currencies && player.currencies[currKey], 0));
  }
  return Math.max(0, toSafeInt(player && player.items && player.items[id], 0));
}

function buildSpiritCostSync(player, beforeCostMap = {}, afterCostMap = {}) {
  const changed = [];
  const itemIds = new Set([
    ...Object.keys(beforeCostMap || {}).map((key) => toSafeInt(key, 0)),
    ...Object.keys(afterCostMap || {}).map((key) => toSafeInt(key, 0)),
  ]);

  itemIds.forEach((itemId) => {
    if (itemId <= 0) return;
    const before = Math.max(0, toSafeInt(beforeCostMap[itemId], 0));
    const after = Math.max(0, toSafeInt(afterCostMap[itemId], 0));
    if (before === after) return;
    changed.push({ id: itemId, count: after });
  });

  if (changed.length === 0) return null;
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

function normalizeAttrs(attrs) {
  const result = {};
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return result;
  Object.keys(attrs).forEach((key) => {
    const attrId = toSafeInt(key, 0);
    const value = toSafeInt(attrs[key], 0);
    if (attrId > 0 && value > 0) result[attrId] = value;
  });
  return result;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function addAttrs(target, delta) {
  const d = normalizeAttrs(delta);
  Object.keys(d).forEach((key) => {
    target[key] = toSafeInt(target[key], 0) + toSafeInt(d[key], 0);
  });
}

function meetsAttrsTarget(attrs, target) {
  const targetMap = normalizeAttrs(target);
  const keys = Object.keys(targetMap);
  if (keys.length === 0) return false;
  return keys.every((key) => toSafeInt(attrs[key], 0) >= toSafeInt(targetMap[key], 0));
}

function clampAttrsToTarget(attrs, target) {
  const targetMap = normalizeAttrs(target);
  Object.keys(targetMap).forEach((key) => {
    const cap = toSafeInt(targetMap[key], 0);
    const now = toSafeInt(attrs[key], 0);
    attrs[key] = Math.min(now, cap);
  });
}

function getSpiritConfigMap() {
  const cfg = config.get('SpiritConfig');
  return (cfg && Object.keys(cfg).length > 0) ? cfg : DEFAULT_SPIRIT_CONFIG;
}

function hasLoadedSpiritConfig() {
  const cfg = config.get('SpiritConfig');
  return !!(cfg && Object.keys(cfg).length > 0);
}

function getSpiritGradeConfigMap() {
  const cfg = config.get('SpiritGradeConfig');
  return (cfg && Object.keys(cfg).length > 0) ? cfg : DEFAULT_SPIRIT_GRADE_CONFIG;
}

function getSpiritBaseConfig() {
  return config.get('SpiritBaseConfig') || {};
}

function getSpiritGradeRow(rank) {
  const gradeCfgMap = getSpiritGradeConfigMap();
  const safeRank = Math.max(1, toSafeInt(rank, 1));
  return gradeCfgMap[safeRank] || gradeCfgMap[String(safeRank)] || {};
}

function getStepsByAttrs(attrs, addLevelAttrs, fallbackMax = Infinity) {
  const targetMap = normalizeAttrs(attrs);
  const levelAttrMap = normalizeAttrs(addLevelAttrs);
  let steps = 0;

  Object.keys(targetMap).forEach((attrId) => {
    const targetValue = Math.max(0, toSafeInt(targetMap[attrId], 0));
    const levelValue = Math.max(0, toSafeInt(levelAttrMap[attrId], 0));
    if (targetValue <= 0 || levelValue <= 0) return;
    steps = Math.max(steps, Math.ceil(targetValue / levelValue));
  });

  if (!Number.isFinite(fallbackMax)) return steps;
  return Math.min(Math.max(0, steps), Math.max(0, toSafeInt(fallbackMax, 0)));
}

function getSpiritRankThresholdSteps(rank) {
  const row = getSpiritGradeRow(rank);
  return getStepsByAttrs(row.addAttrs, row.addLevelAttrs);
}

function getSpiritCurrentRankSteps(rank, attrs = {}) {
  const row = getSpiritGradeRow(rank);
  const maxSteps = getSpiritRankThresholdSteps(rank);
  return getStepsByAttrs(attrs, row.addLevelAttrs, maxSteps);
}

function getLegacySpiritCurrentSteps(spiritInfo = {}) {
  const level = Math.max(1, toSafeInt(spiritInfo.level, 1));
  const exp = Math.max(0, Math.min(LEGACY_SPIRIT_EXP_PER_LEVEL - 1, toSafeInt(spiritInfo.exp, 0)));
  return ((level - 1) * LEGACY_SPIRIT_EXP_PER_LEVEL) + exp;
}

function getLegacySpiritMaxSteps(grade) {
  const rankThreshold = Math.max(1, toSafeInt(getSpiritRankThresholdSteps(grade), 1));
  return rankThreshold * LEGACY_SPIRIT_EXP_PER_LEVEL;
}

function setLegacySpiritCurrentSteps(spiritInfo = {}, steps = 0) {
  const safeSteps = Math.max(0, toSafeInt(steps, 0));
  spiritInfo.level = Math.max(1, Math.floor(safeSteps / LEGACY_SPIRIT_EXP_PER_LEVEL) + 1);
  spiritInfo.exp = safeSteps % LEGACY_SPIRIT_EXP_PER_LEVEL;
  spiritInfo.progressMode = LEGACY_SPIRIT_PROGRESS_MODE;
  return spiritInfo;
}

function setModernSpiritCurrentSteps(spiritInfo = {}, steps = 0) {
  const safeSteps = Math.max(0, toSafeInt(steps, 0));
  spiritInfo.level = safeSteps + 1;
  spiritInfo.exp = 0;
  spiritInfo.progressMode = MODERN_SPIRIT_PROGRESS_MODE;
  return spiritInfo;
}

function buildModernSpiritAttrsBySteps(rank, steps = 0) {
  const row = getSpiritGradeRow(rank);
  const perLevelAttrs = normalizeAttrs(row.addLevelAttrs);
  const targetAttrs = normalizeAttrs(row.addAttrs);
  const safeSteps = Math.max(0, toSafeInt(steps, 0));
  const attrs = {};

  Object.keys(perLevelAttrs).forEach((attrId) => {
    const perStep = Math.max(0, toSafeInt(perLevelAttrs[attrId], 0));
    if (perStep <= 0) return;
    const rawValue = perStep * safeSteps;
    const cap = Math.max(0, toSafeInt(targetAttrs[attrId], 0));
    attrs[attrId] = cap > 0 ? Math.min(rawValue, cap) : rawValue;
  });

  return attrs;
}

function materializeModernSpiritAttrs(spiritInfo = {}, steps = 0) {
  const rank = Math.max(1, toSafeInt(spiritInfo.rank, 1));
  spiritInfo.attrs = buildModernSpiritAttrsBySteps(rank, steps);
  setModernSpiritCurrentSteps(spiritInfo, steps);
  return spiritInfo;
}

function syncLegacySpiritCombatState(spiritInfo = {}) {
  const grade = Math.max(1, toSafeInt(spiritInfo.grade, toSafeInt(spiritInfo.rank, 1)));
  const gradeRow = getSpiritGradeRow(grade);
  const perLevelAttrs = normalizeAttrs(gradeRow.addLevelAttrs);
  const currentSteps = Math.min(
    getLegacySpiritCurrentSteps(spiritInfo),
    Math.max(0, getSpiritRankThresholdSteps(grade)),
  );
  const attrs = {};

  Object.keys(perLevelAttrs).forEach((attrId) => {
    attrs[attrId] = Math.max(0, toSafeInt(perLevelAttrs[attrId], 0)) * currentSteps;
  });

  spiritInfo.rank = grade;
  spiritInfo.attrs = attrs;
  return spiritInfo;
}

function syncModernSpiritProgressFromAttrs(spiritInfo = {}) {
  const rank = Math.max(1, toSafeInt(spiritInfo.rank, 1));
  const existingGrade = Math.max(1, toSafeInt(spiritInfo.grade, rank));
  const existingSteps = existingGrade === rank
    ? Math.max(0, toSafeInt(spiritInfo.level, 1) - 1)
    : 0;
  const currentAttrSteps = getSpiritCurrentRankSteps(rank, spiritInfo.attrs);
  const steps = Math.min(
    Math.max(currentAttrSteps, existingSteps),
    Math.max(0, getSpiritRankThresholdSteps(rank)),
  );
  spiritInfo.grade = rank;
  if (existingSteps > currentAttrSteps) {
    materializeModernSpiritAttrs(spiritInfo, steps);
  } else {
    setModernSpiritCurrentSteps(spiritInfo, steps);
  }
  return spiritInfo;
}

function getMaxSpiritRank() {
  const gradeCfg = getSpiritGradeConfigMap();
  const ranks = Object.keys(gradeCfg)
    .map((k) => toSafeInt(k, 0))
    .filter((rank) => rank > 0);
  // maxRank is the highest configured grade; player is blocked when rank >= maxRank
  return ranks.length > 0 ? Math.max(...ranks) : 10;
}

function getFallbackSpiritId() {
  const baseCfg = getSpiritBaseConfig();
  const initialId = toSafeInt(baseCfg.initialSpiritId, 0);
  const spiritCfg = getSpiritConfigMap();
  if (initialId > 0 && spiritCfg[initialId]) return initialId;
  const ids = Object.keys(spiritCfg)
    .map((k) => toSafeInt(k, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
  // Always return a usable id; default to 1 when config is empty/fallback
  return ids.length > 0 ? ids[0] : 1;
}

function ensureSpiritOwnedState(player, spiritInfo = null) {
  if (!player || typeof player !== 'object') return null;
  const info = spiritInfo || ensureSpiritInfo(player);
  player.items = player.items && typeof player.items === 'object' && !Array.isArray(player.items)
    ? player.items
    : {};

  const spiritCfg = getSpiritConfigMap();
  const ownedSet = new Set(
    ensureArray(info.owns)
      .map((id) => Math.max(0, toSafeInt(id, 0)))
      .filter((id) => id > 0)
  );

  const fallbackId = getFallbackSpiritId();
  if (fallbackId > 0 && spiritCfg[fallbackId]) ownedSet.add(fallbackId);
  const currentId = Math.max(0, toSafeInt(info.id, 0));
  if (currentId > 0) ownedSet.add(currentId);

  const setInfoMap = player.equipInfo
    && player.equipInfo.setInfoMap
    && typeof player.equipInfo.setInfoMap === 'object'
    && !Array.isArray(player.equipInfo.setInfoMap)
    ? player.equipInfo.setInfoMap
    : {};
  Object.keys(setInfoMap).forEach((key) => {
    const presetSpiritId = Math.max(0, toSafeInt(setInfoMap[key] && setInfoMap[key].spirit, 0));
    if (presetSpiritId > 0) ownedSet.add(presetSpiritId);
  });

  const buyRecords = player.shopInfo
    && player.shopInfo.buyRecords
    && typeof player.shopInfo.buyRecords === 'object'
    && !Array.isArray(player.shopInfo.buyRecords)
    ? player.shopInfo.buyRecords
    : {};
  Object.keys(spiritCfg).forEach((key) => {
    const spiritId = Math.max(0, toSafeInt(key, 0));
    if (spiritId <= 0) return;
    const shopItemId = Math.max(0, toSafeInt(spiritCfg[key] && spiritCfg[key].shopItemId, 0));
    if (shopItemId > 0 && toSafeInt(buyRecords[shopItemId], 0) > 0) {
      ownedSet.add(spiritId);
    }
  });

  Object.keys(spiritCfg).forEach((key) => {
    const spiritId = Math.max(0, toSafeInt(key, 0));
    if (spiritId <= 0) return;
    if (toSafeInt(player.items[spiritId], 0) > 0) {
      ownedSet.add(spiritId);
    }
  });

  const owns = Array.from(ownedSet).sort((a, b) => a - b);
  info.owns = owns;
  info.equippedId = currentId > 0 ? currentId : Math.max(1, toSafeInt(info.equippedId, fallbackId));

  Object.keys(spiritCfg).forEach((key) => {
    const spiritId = Math.max(0, toSafeInt(key, 0));
    if (spiritId <= 0) return;
    if (ownedSet.has(spiritId)) {
      player.items[spiritId] = Math.max(1, toSafeInt(player.items[spiritId], 1));
    }
  });

  return info;
}

function ensureSpiritClientUpgradeMaterials(player, spiritInfo = {}) {
  if (!isSpiritClientMaterialFailOpenEnabled()) return;
  if (!player || typeof player !== 'object') return;
  player.items = player.items && typeof player.items === 'object' && !Array.isArray(player.items)
    ? player.items
    : {};

  const row = getSpiritGradeRow(Math.max(1, toSafeInt(spiritInfo.rank, 1)));
  [row.levelConsume, row.gradeConsume].forEach((cost) => {
    const itemId = toSafeInt(cost && cost.id, 0);
    const count = Math.max(0, toSafeInt(cost && cost.count, 0));
    if (itemId <= 0 || count <= 0 || getCurrencyKeyById(itemId)) return;
    if (toSafeInt(player.items[itemId], 0) < count) player.items[itemId] = count;
  });
}

function ensureSpiritInfo(player) {
  player.spiritInfo = player.spiritInfo && typeof player.spiritInfo === 'object' && !Array.isArray(player.spiritInfo)
    ? player.spiritInfo
    : {};

  const info = player.spiritInfo;
  const spiritCfg = getSpiritConfigMap();
  const maxRank = getMaxSpiritRank();

  info.rank = Math.max(1, Math.min(maxRank, toSafeInt(info.rank, 1)));
  info.attrs = normalizeAttrs(info.attrs);

  const currentId = toSafeInt(info.id, -1);
  const existingOwns = new Set(
    ensureArray(info.owns)
      .map((id) => Math.max(0, toSafeInt(id, 0)))
      .filter((id) => id > 0),
  );
  const currentItemCount = Math.max(0, toSafeInt(player && player.items && player.items[currentId], 0));
  if (currentId > 0 && (spiritCfg[currentId] || existingOwns.has(currentId) || currentItemCount > 0)) {
    info.id = currentId;
  } else {
    // Default to the initial/fallback spirit without requiring item ownership.
    // The spirit is available to all players by default.
    const fallbackId = getFallbackSpiritId();
    info.id = fallbackId > 0 ? fallbackId : -1;
  }

  ensureSpiritOwnedState(player, info);
  ensureSpiritClientUpgradeMaterials(player, info);
  return info;
}

function ensureLegacySpiritInfo(player) {
  const info = ensureSpiritInfo(player);
  const maxRank = getMaxSpiritRank();
  const fallbackId = getFallbackSpiritId();

  info.equippedId = Math.max(1, toSafeInt(info.equippedId, toSafeInt(info.id, fallbackId)));
  info.grade = Math.max(1, Math.min(maxRank, toSafeInt(info.grade, toSafeInt(info.rank, 1))));

  const currentRank = Math.max(1, toSafeInt(info.rank, info.grade));
  const currentGrade = Math.max(1, toSafeInt(info.grade, currentRank));
  const modernSteps = Math.min(
    getSpiritCurrentRankSteps(currentRank, info.attrs),
    Math.max(0, getSpiritRankThresholdSteps(currentGrade)),
  );
  const legacySteps = Math.min(
    getLegacySpiritCurrentSteps(info),
    Math.max(0, getLegacySpiritMaxSteps(currentGrade)),
  );

  setLegacySpiritCurrentSteps(info, Math.max(modernSteps, legacySteps));

  const owns = ensureArray(info.owns)
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .filter((id, index, list) => id > 0 && list.indexOf(id) === index);
  if (!owns.includes(info.equippedId)) owns.unshift(info.equippedId);
  info.owns = owns.length > 0 ? owns : [info.equippedId];
  ensureSpiritOwnedState(player, info);

  const enchant = ensureArray(info.enchant)
    .slice(0, 5)
    .map((value) => Math.max(0, toSafeInt(value, 0)));
  while (enchant.length < 5) enchant.push(0);
  info.enchant = enchant;

  syncLegacySpiritCombatState(info);
  return info;
}

function getLegacySpiritFragmentCount(player) {
  player.items = player.items && typeof player.items === 'object' && !Array.isArray(player.items)
    ? player.items
    : {};
  return Math.max(0, toSafeInt(player.items[LEGACY_SPIRIT_FRAGMENT_ITEM_ID], 0));
}

function consumeLegacySpiritFragment(player) {
  const current = getLegacySpiritFragmentCount(player);
  if (current <= 0) return false;
  player.items[LEGACY_SPIRIT_FRAGMENT_ITEM_ID] = Math.max(0, current - 1);
  return true;
}

function applyLegacySpiritUpgrade(player, spiritInfo) {
  const grade = Math.max(1, toSafeInt(spiritInfo.grade, toSafeInt(spiritInfo.rank, 1)));
  const maxSteps = Math.max(1, toSafeInt(getLegacySpiritMaxSteps(grade), 1));
  const currentSteps = Math.max(0, toSafeInt(getLegacySpiritCurrentSteps(spiritInfo), 0));

  if (currentSteps >= maxSteps) {
    return { updated: false, blocked: 'grade' };
  }
  if (!consumeLegacySpiritFragment(player)) {
    return { updated: false, blocked: 'material' };
  }

  setLegacySpiritCurrentSteps(spiritInfo, Math.min(maxSteps, currentSteps + 1));
  syncLegacySpiritCombatState(spiritInfo);
  return { updated: true, blocked: null };
}

function buildLegacySpiritUpgradeResponseData(spiritInfo, blockedReason, upgradeCount) {
  return {
    result: upgradeCount > 0 ? 0 : (blockedReason === 'material' ? 1 : 2),
    level: Math.max(1, toSafeInt(spiritInfo.level, 1)),
    exp: Math.max(0, toSafeInt(spiritInfo.exp, 0)),
    grade: Math.max(1, toSafeInt(spiritInfo.grade, toSafeInt(spiritInfo.rank, 1))),
    rank: Math.max(1, toSafeInt(spiritInfo.rank, 1)),
    attrs: normalizeAttrs(spiritInfo.attrs),
    expPerLevel: LEGACY_SPIRIT_EXP_PER_LEVEL,
    upgradeCount: Math.max(0, toSafeInt(upgradeCount, 0)),
  };
}

function shouldHandleLegacySpiritUpgradeCompat(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  if (toSafeInt(params.__formation, 0) > 0 || String(params.kind || '').toLowerCase() === 'formation') {
    return false;
  }

  const keys = Object.keys(params).filter((key) => params[key] !== undefined);
  return keys.length > 0 && keys.every((key) => key === 'count');
}

/**
 * Apply one upgrade/grade-advance step.
 * @param {boolean} gradeUpMode - when true, attempt direct grade advancement
 *   (pays gradeConsume only, skips attr accumulation).
 *   Used when the client clicks the dedicated 进阶 button.
 */
function applySingleUpgrade(player, spiritInfo, gradeUpMode = false) {
  const gradeCfgMap = getSpiritGradeConfigMap();
  const rank = Math.max(1, toSafeInt(spiritInfo.rank, 1));
  const maxRank = getMaxSpiritRank();
  if (rank >= maxRank) return { updated: false, blocked: 'max' };

  const gradeCfg = gradeCfgMap[rank] || gradeCfgMap[String(rank)];
  if (!gradeCfg) return { updated: false, blocked: 'max' };

  if (gradeUpMode) {
    // ── Direct grade advancement (进阶 button) ──────────────────────────────
    // Pay gradeConsume directly; no attr accumulation check.
    const gradeConsume = gradeCfg.gradeConsume || {};
    const gradeCostId = toSafeInt(gradeConsume.id, 0);
    const gradeCostCount = Math.max(0, toSafeInt(gradeConsume.count, 0));
    if (gradeCostId > 0 && gradeCostCount > 0 && !hasEnoughItemOrCurrency(player, gradeCostId, gradeCostCount)) {
      if (!isSpiritGradeFailOpenEnabled()) {
        return { updated: false, blocked: 'grade_cost' };
      }
      logger.info(`[Spirit] grade fail-open user=${player.userId || ''} rank=${rank} need=${gradeCostId}:${gradeCostCount}`);
    }
    if (gradeCostId > 0 && gradeCostCount > 0 && hasEnoughItemOrCurrency(player, gradeCostId, gradeCostCount)) {
      consumeItemOrCurrency(player, gradeCostId, gradeCostCount);
    }
    spiritInfo.rank = Math.min(maxRank, rank + 1);
    spiritInfo.attrs = {};
    return { updated: true, blocked: null };
  }

  // ── Regular level-up within current grade ──────────────────────────────────
  const levelConsume = gradeCfg.levelConsume || {};
  const levelCostId = toSafeInt(levelConsume.id, 0);
  const levelCostCount = Math.max(0, toSafeInt(levelConsume.count, 0));
  if (levelCostId > 0 && levelCostCount > 0 && !hasEnoughItemOrCurrency(player, levelCostId, levelCostCount)) {
    if (!isSpiritLevelFailOpenEnabled()) {
      return { updated: false, blocked: 'material' };
    }
    logger.info(`[Spirit] level fail-open user=${player.userId || ''} rank=${rank} need=${levelCostId}:${levelCostCount}`);
  }
  if (levelCostId > 0 && levelCostCount > 0 && hasEnoughItemOrCurrency(player, levelCostId, levelCostCount)) {
    consumeItemOrCurrency(player, levelCostId, levelCostCount);
  }

  addAttrs(spiritInfo.attrs, gradeCfg.addLevelAttrs || {});

  // Auto-advance grade when attr threshold is reached (during bulk upgrade)
  if (meetsAttrsTarget(spiritInfo.attrs, gradeCfg.addAttrs || {})) {
    const gradeConsume = gradeCfg.gradeConsume || {};
    const gradeCostId = toSafeInt(gradeConsume.id, 0);
    const gradeCostCount = Math.max(0, toSafeInt(gradeConsume.count, 0));
    if (gradeCostId > 0 && gradeCostCount > 0 && !hasEnoughItemOrCurrency(player, gradeCostId, gradeCostCount)) {
      if (!isSpiritGradeFailOpenEnabled()) {
        clampAttrsToTarget(spiritInfo.attrs, gradeCfg.addAttrs || {});
        return { updated: true, blocked: 'grade' };
      }
      logger.info(`[Spirit] auto grade fail-open user=${player.userId || ''} rank=${rank} need=${gradeCostId}:${gradeCostCount}`);
    }
    if (gradeCostId > 0 && gradeCostCount > 0 && hasEnoughItemOrCurrency(player, gradeCostId, gradeCostCount)) {
      consumeItemOrCurrency(player, gradeCostId, gradeCostCount);
    }
    spiritInfo.rank = Math.min(maxRank, rank + 1);
    spiritInfo.attrs = {};
  }

  return { updated: true, blocked: null };
}

function shouldForceGradeUpFromState(spiritInfo = {}) {
  const rank = Math.max(1, toSafeInt(spiritInfo.rank, 1));
  const maxRank = getMaxSpiritRank();
  if (rank >= maxRank) return false;
  const gradeCfg = getSpiritGradeRow(rank);
  return meetsAttrsTarget(spiritInfo.attrs, gradeCfg.addAttrs || {});
}

// upgrade / grade-advance (tag:3600)
async function handleSpiritUpgrade(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 3600, msgUid, data: { result: -1, attrs: {}, rank: 1 } };
  }

  // Keep runtime upgrade behavior aligned with tag 500 normalization so
  // saved level/grade progress does not fall behind stale attrs state.
  const spiritInfo = syncModernSpiritProgressFromAttrs(
    syncSpiritInfoFromCurrentPreset(player) || ensureSpiritInfo(player)
  );
  const beforeRank = Math.max(1, toSafeInt(spiritInfo.rank, 1));
  const beforeLevel = Math.max(1, toSafeInt(spiritInfo.level, 1));
  const beforeAttrs = normalizeAttrs(spiritInfo.attrs);

  // gradeUp: true → client clicked the dedicated 进阶 button (direct grade advance)
  // upgradeAll: true → client clicked the 一键升级 button (bulk level-ups)
  const requestedGradeUp = !!(params && (params.gradeUp === true || toSafeInt(params.gradeUp, 0) > 0));
  const upgradeAll = !!(params && (params.upgradeAll === true || toSafeInt(params.upgradeAll, 0) > 0));
  const gradeUpMode = requestedGradeUp || (!upgradeAll && shouldForceGradeUpFromState(spiritInfo));
  let updated = false;
  let upgradeCount = 0;
  let blockedReason = null;
  const trackedCostIds = [60, 61, 2, 6];
  const beforeCostMap = Object.fromEntries(
    trackedCostIds.map((itemId) => [itemId, getItemOrCurrencyCount(player, itemId)])
  );

  if (upgradeAll && !gradeUpMode) {
    for (let i = 0; i < 200; i++) {
      const step = applySingleUpgrade(player, spiritInfo, false);
      if (!step.updated) { blockedReason = step.blocked; break; }
      updated = true;
      upgradeCount += 1;
      if (step.blocked) { blockedReason = step.blocked; break; }
    }
  } else {
    const step = applySingleUpgrade(player, spiritInfo, gradeUpMode);
    updated = step.updated;
    if (step.updated) upgradeCount += 1;
    blockedReason = step.blocked;
  }

  // Build a meaningful result code so the client can show the right message:
  // 0 = success, 1 = no update (already max / not enough attrs), 2 = not enough material,
  // 3 = grade advance locked (attrs not yet at threshold), 4 = max rank reached
  let resultCode = 0;
  if (!updated) {
    if (blockedReason === 'max') resultCode = 4;
    else if (blockedReason === 'material' || blockedReason === 'grade_cost') resultCode = 2;
    else if (blockedReason === 'grade') resultCode = 3;
    else resultCode = 1;
  }

  logger.info(
    `[Spirit3600] user=${session && session.userId ? session.userId : 'unknown'} `
    + `msgUid=${msgUid} params=${JSON.stringify(params || {})} `
    + `beforeRank=${beforeRank} beforeLevel=${beforeLevel} beforeAttrs=${JSON.stringify(beforeAttrs)} `
    + `item60=${getItemOrCurrencyCount(player, 60)} item61=${getItemOrCurrencyCount(player, 61)} `
    + `updated=${updated} blocked=${blockedReason || 'none'} resultCode=${resultCode}`
  );

  if (updated) {
    syncModernSpiritProgressFromAttrs(spiritInfo);
    const afterRank = Math.max(1, toSafeInt(spiritInfo.rank, 1));
    if (!gradeUpMode && afterRank === beforeRank) {
      const maxSteps = Math.max(0, getSpiritRankThresholdSteps(afterRank));
      const minSteps = Math.min(maxSteps, Math.max(0, beforeLevel - 1) + Math.max(0, upgradeCount));
      const currentSteps = Math.max(0, toSafeInt(spiritInfo.level, 1) - 1);
      if (minSteps > currentSteps) materializeModernSpiritAttrs(spiritInfo, minSteps);
    }
    logger.info(
      `[Spirit3600] user=${session && session.userId ? session.userId : 'unknown'} `
      + `afterRank=${Math.max(1, toSafeInt(spiritInfo.rank, 1))} `
      + `afterLevel=${Math.max(1, toSafeInt(spiritInfo.level, 1))} `
      + `afterAttrs=${JSON.stringify(normalizeAttrs(spiritInfo.attrs))} `
      + `afterItem60=${getItemOrCurrencyCount(player, 60)} afterItem61=${getItemOrCurrencyCount(player, 61)}`
    );
    const compatArtifactTaskChanged = !!addArtifactUpgradeCount(player, upgradeCount);
    const mainTaskChanged = refreshMainTaskProgress(player);
    const realmTaskChanged = refreshRealmStageTasks(player);
    await playerService.savePlayer(session.userId, player);
    const afterCostMap = Object.fromEntries(
      trackedCostIds.map((itemId) => [itemId, getItemOrCurrencyCount(player, itemId)])
    );
    const costSyncPacket = buildSpiritCostSync(player, beforeCostMap, afterCostMap);

    const spiritResp = {
      tag: 3600,
      msgUid,
      data: buildSpiritUpgradeResponseData(spiritInfo, resultCode, upgradeCount, gradeUpMode),
    };
    const taskPackets = buildActiveTaskUpdatePackets(player);

    // Always push task state after a successful upgrade so the task bar stays in sync.
    if (costSyncPacket || compatArtifactTaskChanged || mainTaskChanged || realmTaskChanged || upgradeCount > 0) {
      return [
        ...(costSyncPacket ? [costSyncPacket] : []),
        ...taskPackets,
        spiritResp,
      ];
    }
  }

  return {
    tag: 3600,
    msgUid,
    data: buildSpiritUpgradeResponseData(spiritInfo, resultCode, upgradeCount, gradeUpMode),
  };
}

async function handleLegacySpiritUpgradeCompat(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 3001, msgUid, data: { result: -1 } };
  }

  const spiritInfo = ensureLegacySpiritInfo(player);
  const requestCount = Math.max(1, toSafeInt(params && params.count, 1));
  const beforeFragment = getLegacySpiritFragmentCount(player);

  let updatedCount = 0;
  let blockedReason = null;
  for (let index = 0; index < requestCount; index += 1) {
    const step = applyLegacySpiritUpgrade(player, spiritInfo);
    if (!step.updated) {
      blockedReason = step.blocked;
      break;
    }
    updatedCount += 1;
  }

  let mainTaskChanged = false;
  let realmTaskChanged = false;
  if (updatedCount > 0) {
    mainTaskChanged = refreshMainTaskProgress(player);
    realmTaskChanged = refreshRealmStageTasks(player);
    await playerService.savePlayer(session.userId, player);
  }

  const responses = [];
  const afterFragment = getLegacySpiritFragmentCount(player);
  if (afterFragment !== beforeFragment) {
    responses.push({
      tag: 1202,
      msgUid: 0,
      data: {
        result: 0,
        items: buildClientItemList(player),
        changed: [{ id: LEGACY_SPIRIT_FRAGMENT_ITEM_ID, count: afterFragment }],
      },
    });
  }

  responses.push({
    tag: 3001,
    msgUid,
    data: buildLegacySpiritUpgradeResponseData(spiritInfo, blockedReason, updatedCount),
  });

  if (updatedCount > 0 || mainTaskChanged || realmTaskChanged) {
    responses.splice(responses.length - 1, 0, ...buildActiveTaskUpdatePackets(player));
  }

  return responses.length === 1 ? responses[0] : responses;
}

function syncCurrentPresetSpirit(player, spiritId) {
  if (!player || typeof player !== 'object') return;
  ensureEquipInfo(player);
  player.equipInfo.setInfoMap = player.equipInfo.setInfoMap && typeof player.equipInfo.setInfoMap === 'object'
    && !Array.isArray(player.equipInfo.setInfoMap)
    ? player.equipInfo.setInfoMap
    : {};

  const curIndex = String(Math.max(0, toSafeInt(player.equipInfo.curIndex, 0)));
  const currentSetInfo = player.equipInfo.setInfoMap[curIndex]
    && typeof player.equipInfo.setInfoMap[curIndex] === 'object'
    && !Array.isArray(player.equipInfo.setInfoMap[curIndex])
    ? player.equipInfo.setInfoMap[curIndex]
    : {};

  player.equipInfo.setInfoMap[curIndex] = {
    ...currentSetInfo,
    spirit: Math.max(0, toSafeInt(spiritId, 0)),
  };
}

function syncSpiritInfoFromCurrentPreset(player) {
  if (!player || typeof player !== 'object') return null;
  const spiritInfo = ensureSpiritInfo(player);
  ensureEquipInfo(player);
  const curIndex = String(Math.max(0, toSafeInt(player.equipInfo && player.equipInfo.curIndex, 0)));
  const presetSpiritId = Math.max(
    0,
    toSafeInt(
      player.equipInfo
      && player.equipInfo.setInfoMap
      && player.equipInfo.setInfoMap[curIndex]
      && player.equipInfo.setInfoMap[curIndex].spirit,
      0,
    ),
  );

  if (presetSpiritId > 0) {
    spiritInfo.id = presetSpiritId;
    spiritInfo.equippedId = presetSpiritId;
    ensureSpiritOwnedState(player, spiritInfo);
    return spiritInfo;
  }

  syncCurrentPresetSpirit(player, spiritInfo.id);
  return spiritInfo;
}

function buildSpiritSwitchResponseData(spiritInfo = {}, extra = {}) {
  return {
    result: 0,
    id: toSafeInt(spiritInfo.id, -1),
    equippedId: toSafeInt(spiritInfo.equippedId, toSafeInt(spiritInfo.id, -1)),
    owns: ensureArray(spiritInfo.owns)
      .map((id) => Math.max(0, toSafeInt(id, 0)))
      .filter((id) => id > 0),
    rank: Math.max(1, toSafeInt(spiritInfo.rank, 1)),
    attrs: normalizeAttrs(spiritInfo.attrs),
    ...extra,
  };
}

function buildSpiritUpgradeResponseData(spiritInfo = {}, resultCode = 0, upgradeCount = 0, gradeUpMode = false) {
  return {
    result: resultCode,
    id: toSafeInt(spiritInfo.id, -1),
    equippedId: toSafeInt(spiritInfo.equippedId, toSafeInt(spiritInfo.id, -1)),
    owns: ensureArray(spiritInfo.owns)
      .map((id) => Math.max(0, toSafeInt(id, 0)))
      .filter((id) => id > 0),
    rank: Math.max(1, toSafeInt(spiritInfo.rank, 1)),
    grade: Math.max(1, toSafeInt(spiritInfo.grade, toSafeInt(spiritInfo.rank, 1))),
    level: Math.max(1, toSafeInt(spiritInfo.level, 1)),
    exp: Math.max(0, toSafeInt(spiritInfo.exp, 0)),
    enchant: ensureArray(spiritInfo.enchant)
      .slice(0, 5)
      .map((value) => Math.max(0, toSafeInt(value, 0))),
    attrs: normalizeAttrs(spiritInfo.attrs),
    expPerLevel: MODERN_SPIRIT_EXP_PER_LEVEL,
    upgradeCount: Math.max(0, toSafeInt(upgradeCount, 0)),
    gradeUp: gradeUpMode ? 1 : 0,
  };
}

// switch (tag:3601)
async function handleSpiritSwitch(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 3601, msgUid, data: { result: -1, id: -1 } };
  }

  const spiritInfo = ensureSpiritInfo(player);
  ensureSpiritOwnedState(player, spiritInfo);
  const spiritCfg = getSpiritConfigMap();
  const hasFullSpiritConfig = hasLoadedSpiritConfig();
  const requestId = toSafeInt(
    params && (params.id ?? params.spiritId ?? params.equippedId ?? params.curId),
    -1,
  );
  const currentId = toSafeInt(spiritInfo.id, -1);
  const ownedIds = ensureArray(spiritInfo.owns)
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .filter((id, index, list) => id > 0 && list.indexOf(id) === index);
  const ownedSet = new Set(ownedIds);
  let result = 0;
  let failReason = '';

  if (requestId <= 0) {
    spiritInfo.id = -1;
    spiritInfo.equippedId = -1;
    syncCurrentPresetSpirit(player, -1);
  } else if (!spiritCfg[requestId] && !ownedSet.has(requestId) && toSafeInt(player.items && player.items[requestId], 0) <= 0) {
    result = 1;
    failReason = hasFullSpiritConfig ? 'missing_config_entry' : 'spirit_config_not_loaded';
  } else if (!ownedSet.has(requestId) && toSafeInt(player.items && player.items[requestId], 0) <= 0) {
    result = 1;
    failReason = 'not_owned';
  } else {
    if (!spiritCfg[requestId]) {
      failReason = hasFullSpiritConfig ? 'switch_without_server_config' : 'switch_without_loaded_config';
    }
    spiritInfo.id = requestId;
    spiritInfo.equippedId = requestId;
    if (!ownedSet.has(requestId)) {
      spiritInfo.owns = ensureArray(spiritInfo.owns);
      spiritInfo.owns.push(requestId);
    }
    ensureSpiritOwnedState(player, spiritInfo);
    syncCurrentPresetSpirit(player, requestId);
  }

  const curIndex = String(Math.max(0, toSafeInt(player && player.equipInfo && player.equipInfo.curIndex, 0)));
  const presetSpirit = toSafeInt(
    player && player.equipInfo && player.equipInfo.setInfoMap
      && player.equipInfo.setInfoMap[curIndex] && player.equipInfo.setInfoMap[curIndex].spirit,
    -1,
  );
  logger.info(
    `[Spirit3601] user=${session && session.userId ? session.userId : 'unknown'} `
    + `msgUid=${msgUid} requestId=${requestId} currentId=${currentId} `
    + `owns=${JSON.stringify(ownedIds)} itemCount=${toSafeInt(player.items && player.items[requestId], 0)} `
    + `result=${result} failReason=${failReason || 'none'} switchedId=${toSafeInt(spiritInfo.id, -1)} presetSpirit=${presetSpirit}`
  );

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 3601,
    msgUid,
    data: buildSpiritSwitchResponseData(spiritInfo, {
      result,
      failReason,
    }),
  };
}

module.exports = {
  ensureSpiritInfo,
  ensureLegacySpiritInfo,
  syncModernSpiritProgressFromAttrs,
  syncCurrentPresetSpirit,
  syncSpiritInfoFromCurrentPreset,
  handleLegacySpiritUpgradeCompat,
  handleSpiritUpgrade,
  handleSpiritSwitch,
  shouldHandleLegacySpiritUpgradeCompat,
};
