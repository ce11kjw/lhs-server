const config = require('./ConfigService');

const DEFAULT_FORMATION_BASE_CONFIG = {
  formationInitialId: 21001,
  formationEnchantType: [101, 102, 103, 104, 105],
  formationGlobalAttrsAdd: {},
  formationBasicAttribute: {},
};

const DEFAULT_FORMATION_CONFIG = {
  21001: { id: 21001, showType: 1, shopItemId: 0, spAttrs: {}, spAttrGrades: {} },
  21101: { id: 21101, showType: 1, shopItemId: 121101, spAttrs: {}, spAttrGrades: {} },
};

const DEFAULT_FORMATION_GRADE_CONFIG = Object.fromEntries(
  Array.from({ length: 10 }, (_v, index) => {
    const grade = index + 1;
    return [String(grade), {
      grade,
      level: 10,
      exp: grade === 1 ? 3 : 10,
      levelUpCost: { id: 7, count: 1 },
      gradeUpCost: { id: 8, count: 10 },
      levelUpAttrs: {},
    }];
  })
);

const DEFAULT_FORMATION_ENCHANT_CONFIG = {
  1: {
    level: 1,
    probability: 10000,
    attributeParam: 100,
    upgradeCost: [
      { id: 89, count: 10 },
      { id: 2, count: 500 },
    ],
  },
};

const DEFAULT_ASSETS_CONFIG = {
  7: { id: 7, param: 1 },
};

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function withFallback(raw, fallback) {
  return isPlainObject(raw) && Object.keys(raw).length > 0 ? raw : fallback;
}

function getFormationBaseConfig() {
  return {
    ...DEFAULT_FORMATION_BASE_CONFIG,
    ...(isPlainObject(config.get('FormationBaseConfig')) ? config.get('FormationBaseConfig') : {}),
  };
}

function getFormationConfig() {
  return withFallback(config.get('FormationConfig'), DEFAULT_FORMATION_CONFIG);
}

function getFormationGradeConfig() {
  return withFallback(config.get('FormationGradeConfig'), DEFAULT_FORMATION_GRADE_CONFIG);
}

function getFormationEnchantConfig() {
  return withFallback(config.get('FormationEnchantConfig'), DEFAULT_FORMATION_ENCHANT_CONFIG);
}

function getAssetsConfig() {
  return withFallback(config.get('AssetsConfig'), DEFAULT_ASSETS_CONFIG);
}

function getFormationInitialId() {
  const formationCfg = getFormationConfig();
  const configuredId = Math.max(1, toSafeInt(getFormationBaseConfig().formationInitialId, 21001));
  if (formationCfg[configuredId] || formationCfg[String(configuredId)]) {
    return configuredId;
  }
  const firstValidId = Object.keys(formationCfg)
    .map((key) => Math.max(0, toSafeInt(key, 0)))
    .find((id) => id > 0 && (formationCfg[id] || formationCfg[String(id)]));
  return firstValidId || 21001;
}

function getFormationEnchantSlotCount() {
  const types = getFormationBaseConfig().formationEnchantType;
  return Array.isArray(types) && types.length > 0 ? types.length : 5;
}

function getFormationGradeRow(grade) {
  const gradeCfg = getFormationGradeConfig();
  return gradeCfg[grade] || gradeCfg[String(grade)] || null;
}

function getFormationLevelUpExpValue(formationInfo = {}) {
  const row = getFormationGradeRow(formationInfo.grade);
  const costId = toSafeInt(row && row.levelUpCost && row.levelUpCost.id, 0);
  const assetsCfg = getAssetsConfig();
  const asset = assetsCfg[costId] || assetsCfg[String(costId)] || {};
  return Math.max(1, toSafeInt(asset.param, 1));
}

function normalizeOwnsList(rawOwns, legacyFormations, fallbackIds = []) {
  const owns = [];
  const pushId = (id) => {
    const safeId = toSafeInt(id, 0);
    if (safeId <= 0) return;
    if (!owns.includes(safeId)) owns.push(safeId);
  };

  if (Array.isArray(rawOwns)) rawOwns.forEach(pushId);
  if (Array.isArray(legacyFormations)) {
    legacyFormations.forEach((row) => {
      if (row && typeof row === 'object') pushId(row.id || row.formationId);
      else pushId(row);
    });
  }
  fallbackIds.forEach(pushId);
  return owns;
}

function normalizeFormationInfo(rawInfo = {}) {
  const formationCfg = getFormationConfig();
  const gradeCfg = getFormationGradeConfig();
  const enchantCfg = getFormationEnchantConfig();
  const initialId = getFormationInitialId();
  const maxGrade = Math.max(
    1,
    ...Object.keys(gradeCfg).map((key) => Math.max(1, toSafeInt(key, 1)))
  );
  const info = rawInfo && typeof rawInfo === 'object' && !Array.isArray(rawInfo)
    ? { ...rawInfo }
    : {};

  let equippedId = Math.max(
    1,
    toSafeInt(info.equippedId, toSafeInt(info.curFormation, toSafeInt(info.id, initialId)))
  );
  const isValidFormationId = (id) => !!(
    formationCfg[toSafeInt(id, 0)] || formationCfg[String(toSafeInt(id, 0))]
  );
  const owns = normalizeOwnsList(info.owns, info.formations, [
    info.curFormation,
    info.id,
    equippedId,
    initialId,
  ]).filter(isValidFormationId);
  if (!isValidFormationId(equippedId)) {
    equippedId = initialId;
  }
  if (!owns.includes(equippedId)) owns.unshift(equippedId);

  let grade = Math.max(1, Math.min(maxGrade, toSafeInt(info.grade, 1)));
  let currentGradeRow = getFormationGradeRow(grade) || getFormationGradeRow(1) || { level: 1, exp: 0 };
  if (!currentGradeRow) {
    grade = 1;
    currentGradeRow = { level: 1, exp: 0 };
  }

  let level = Math.max(1, toSafeInt(info.level, 1));
  const maxLevel = Math.max(1, toSafeInt(currentGradeRow.level, 1));
  const maxExp = Math.max(0, toSafeInt(currentGradeRow.exp, 0));
  if (level > maxLevel) level = maxLevel;

  let exp = Math.max(0, toSafeInt(info.exp, 0));
  if (level >= maxLevel) {
    exp = Math.min(maxExp, exp);
  } else if (maxExp > 0) {
    exp = Math.min(maxExp - 1, exp);
  } else {
    exp = 0;
  }

  const enchantSlotCount = getFormationEnchantSlotCount();
  let enchant = Array.isArray(info.enchant) ? info.enchant.slice(0, enchantSlotCount) : [];
  if (enchant.length <= 0) {
    const legacyEnchantLevel = Math.max(0, toSafeInt(info.enchantLevel, 0));
    const legacyEnchantIndex = Math.min(
      enchantSlotCount - 1,
      Math.max(0, toSafeInt(info.enchantId, 0))
    );
    if (legacyEnchantLevel > 0 && enchantSlotCount > 0) {
      enchant[legacyEnchantIndex] = legacyEnchantLevel;
    }
  }
  enchant = Array.from({ length: enchantSlotCount }, (_row, index) => {
    const levelValue = Math.max(0, toSafeInt(enchant[index], 0));
    if (levelValue <= 0) return 0;
    return enchantCfg[levelValue] || enchantCfg[String(levelValue)] ? levelValue : 0;
  });

  return {
    ...info,
    id: equippedId,
    curFormation: equippedId,
    equippedId,
    owns,
    grade,
    level,
    exp,
    enchant,
  };
}

function ensureFormationInfo(player = {}) {
  if (!player || typeof player !== 'object') {
    return normalizeFormationInfo();
  }
  player.formationInfo = normalizeFormationInfo(player.formationInfo);
  ensureFormationOwnedState(player, player.formationInfo);
  return player.formationInfo;
}

function ensureFormationOwnedState(player = {}, formationInfo = null) {
  if (!player || typeof player !== 'object') return formationInfo || normalizeFormationInfo();
  const info = formationInfo || normalizeFormationInfo(player.formationInfo);
  player.items = isPlainObject(player.items) ? player.items : {};
  player.shopInfo = isPlainObject(player.shopInfo) ? player.shopInfo : {};
  player.shopInfo.buyRecords = isPlainObject(player.shopInfo.buyRecords) ? player.shopInfo.buyRecords : {};

  const formationCfg = getFormationConfig();
  const ownedSet = new Set(normalizeOwnsList(info.owns, info.formations, [
    info.curFormation,
    info.id,
    info.equippedId,
    getFormationInitialId(),
  ]));

  Object.keys(formationCfg).forEach((key) => {
    const formationId = Math.max(0, toSafeInt(key, 0));
    if (formationId <= 0) return;
    const row = formationCfg[key] || {};
    const shopItemId = Math.max(0, toSafeInt(row.shopItemId, 0));
    if (toSafeInt(player.items[formationId], 0) > 0) ownedSet.add(formationId);
    if (shopItemId > 0 && toSafeInt(player.shopInfo.buyRecords[shopItemId], 0) > 0) {
      ownedSet.add(formationId);
    }
  });

  info.owns = Array.from(ownedSet)
    .filter((id) => id > 0 && (formationCfg[id] || formationCfg[String(id)]))
    .sort((a, b) => a - b);
  player.formationInfo = info;
  return info;
}

function isFormationOwned(player = {}, formationId = 0, formationInfo = null) {
  const safeId = Math.max(0, toSafeInt(formationId, 0));
  if (safeId <= 0 || !player || typeof player !== 'object') return false;

  const formationCfg = getFormationConfig();
  const row = formationCfg[safeId] || formationCfg[String(safeId)] || null;
  if (!row) return false;

  const info = ensureFormationOwnedState(player, formationInfo || ensureFormationInfo(player));
  if (Array.isArray(info.owns) && info.owns.includes(safeId)) return true;

  const itemCount = toSafeInt(player.items && player.items[safeId], 0);
  if (itemCount > 0) return true;

  const shopItemId = Math.max(0, toSafeInt(row && row.shopItemId, 0));
  return shopItemId > 0 && toSafeInt(player.shopInfo && player.shopInfo.buyRecords && player.shopInfo.buyRecords[shopItemId], 0) > 0;
}

module.exports = {
  ensureFormationInfo,
  ensureFormationOwnedState,
  getFormationEnchantConfig,
  getFormationEnchantSlotCount,
  getFormationConfig,
  getFormationGradeRow,
  getFormationInitialId,
  getFormationLevelUpExpValue,
  isFormationOwned,
  normalizeFormationInfo,
};
