const config = require('./ConfigService');
const LEGACY_SPIRIT_EXP_PER_LEVEL = 3;
const MODERN_SPIRIT_PROGRESS_MODE = 'modern3600';

const _makeGradeCfg = (grade) => {
  const base = 1 + (grade - 1) * 0.2;
  return {
    grade,
    levelConsume: { id: 2, count: Math.floor(100 * base) },
    gradeConsume: { id: 6, count: 10 },
    addLevelAttrs: {
      101: Math.floor(10 * base),
      102: Math.floor(200 * base),
      103: Math.floor(5 * base),
      104: Math.floor(8 * base),
      105: Math.floor(6 * base),
      106: Math.floor(4 * base),
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

const DEFAULT_SPIRIT_GRADE_CONFIG = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [String(i + 1), _makeGradeCfg(i + 1)])
);

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeAttrs(attrs = {}) {
  const source = ensureObject(attrs);
  const result = {};
  Object.keys(source).forEach((key) => {
    const attrId = toSafeInt(key, 0);
    const attrValue = Math.max(0, toSafeInt(source[key], 0));
    if (attrId > 0 && attrValue > 0) {
      result[String(attrId)] = attrValue;
    }
  });
  return result;
}

function getSpiritGradeConfigMap() {
  const cfg = config.get('SpiritGradeConfig') || {};
  return Object.keys(cfg).length > 0 ? cfg : DEFAULT_SPIRIT_GRADE_CONFIG;
}

function getSpiritGradeRow(rank) {
  const cfgMap = getSpiritGradeConfigMap();
  const safeRank = Math.max(1, toSafeInt(rank, 1));
  return ensureObject(cfgMap[safeRank] || cfgMap[String(safeRank)]);
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

function getHistoricalSpiritUpgradeCount(player = {}) {
  const spiritInfo = ensureObject(player.spiritInfo);
  const rank = Math.max(1, toSafeInt(spiritInfo.rank, 1));
  let total = 0;

  for (let currentRank = 1; currentRank < rank; currentRank += 1) {
    total += getSpiritRankThresholdSteps(currentRank);
  }

  total += getSpiritCurrentRankSteps(rank, spiritInfo.attrs);

  if (String(spiritInfo.progressMode || '') === MODERN_SPIRIT_PROGRESS_MODE) {
    return Math.max(0, total);
  }

  const legacyGrade = Math.max(1, toSafeInt(spiritInfo.grade, rank));
  let legacyTotal = 0;
  for (let currentGrade = 1; currentGrade < legacyGrade; currentGrade += 1) {
    legacyTotal += getSpiritRankThresholdSteps(currentGrade);
  }
  legacyTotal += Math.min(
    getLegacySpiritCurrentSteps(spiritInfo),
    Math.max(0, getSpiritRankThresholdSteps(legacyGrade)),
  );

  return Math.max(0, total, legacyTotal);
}

module.exports = {
  getHistoricalSpiritUpgradeCount,
};
