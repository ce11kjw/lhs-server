/**
 * Fate talent system handlers
 * tag: 3800 switch plan, 3802 choose skill, 3803 reset plan
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const { refreshMainTaskProgress } = require('../services/MainTaskProgressService');

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

function getFateSkillCfgMap() {
  return config.get('FateSkillConfig') || {};
}

function ensureFateInfo(player) {
  player.fateInfo = player.fateInfo && typeof player.fateInfo === 'object' && !Array.isArray(player.fateInfo)
    ? player.fateInfo
    : {};

  const info = player.fateInfo;
  if (!info.planInfoMap || typeof info.planInfoMap !== 'object' || Array.isArray(info.planInfoMap)) {
    info.planInfoMap = {};
  }
  if (toSafeInt(info.id, 0) <= 0) info.id = 1;

  const skillCfg = getFateSkillCfgMap();
  Object.keys(info.planInfoMap).forEach((planId) => {
    const plan = info.planInfoMap[planId] && typeof info.planInfoMap[planId] === 'object'
      ? info.planInfoMap[planId]
      : {};
    if (!Array.isArray(plan.skills)) plan.skills = [];
    plan.skills = plan.skills
      .map((skillId) => toSafeInt(skillId, 0))
      .filter((skillId, idx, arr) => skillId > 0 && skillCfg[skillId] && arr.indexOf(skillId) === idx);
    info.planInfoMap[planId] = plan;
  });

  if (!info.planInfoMap[info.id]) info.planInfoMap[info.id] = { skills: [] };
  return info;
}

function getTalentPointByPlayerLevel(playerLevel) {
  const levelCfg = config.get('FateLevelConfig') || {};
  let count = 0;
  Object.keys(levelCfg).forEach((key) => {
    const row = levelCfg[key];
    if (!row) return;
    if (toSafeInt(row.playerLevel, 0) <= playerLevel) {
      count = Math.max(count, toSafeInt(row.count, 0));
    }
  });
  return Math.max(0, count);
}

function getUsedPoint(planInfo) {
  const skillCfg = getFateSkillCfgMap();
  const skills = Array.isArray(planInfo && planInfo.skills) ? planInfo.skills : [];
  return skills.reduce((sum, skillId) => sum + Math.max(0, toSafeInt(skillCfg[skillId] && skillCfg[skillId].fatePointCost, 0)), 0);
}

function hasSkillRequirements(planInfo, skillCfgRow) {
  const required = Array.isArray(skillCfgRow && skillCfgRow.pre) ? skillCfgRow.pre : [];
  if (required.length === 0) return true;
  const learned = new Set(Array.isArray(planInfo && planInfo.skills) ? planInfo.skills : []);
  return required.every((skillId) => learned.has(toSafeInt(skillId, 0)));
}

function ensurePlan(info, planId) {
  const key = String(Math.max(1, toSafeInt(planId, 1)));
  if (!info.planInfoMap[key]) info.planInfoMap[key] = { skills: [] };
  const plan = info.planInfoMap[key];
  if (!Array.isArray(plan.skills)) plan.skills = [];
  return plan;
}

function buildTaskUpdatePacketsSafe(player, msgUid = 0) {
  try {
    // eslint-disable-next-line global-require
    const task = require('./task');
    if (task && typeof task.buildActiveTaskUpdatePackets === 'function') {
      return task.buildActiveTaskUpdatePackets(player, msgUid);
    }
  } catch (_err) {}
  return [];
}

// switch talent plan (tag:3800)
async function handleFateSwitchPlan(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3800, msgUid, data: null };

  const planId = toSafeInt(params && params.id, 0);
  if (planId <= 0) return { tag: 3800, msgUid, data: null };

  const info = ensureFateInfo(player);
  info.id = planId;
  const planInfo = ensurePlan(info, planId);
  const planInfoMap = info.planInfoMap;

  const taskChanged = !!refreshMainTaskProgress(player);
  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 3800,
    msgUid,
    data: {
      result: 0,
      id: info.id,
      nowPlanId: info.id,
      planInfo,
      planInfoMap,
    },
  };
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

// choose talent skill (tag:3802)
async function handleFateChooseSkill(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3802, msgUid, data: null };

  const planId = toSafeInt(params && params.id, 0);
  const skillId = toSafeInt(params && params.skillId, 0);
  if (planId <= 0 || skillId <= 0) return { tag: 3802, msgUid, data: null };

  const info = ensureFateInfo(player);
  const planInfo = ensurePlan(info, planId);
  const skillCfg = getFateSkillCfgMap();
  const skillRow = skillCfg[skillId];
  if (!skillRow) return { tag: 3802, msgUid, data: null };
  if (planInfo.skills.includes(skillId)) return { tag: 3802, msgUid, data: null };
  if (!hasSkillRequirements(planInfo, skillRow)) return { tag: 3802, msgUid, data: null };

  const playerLevel = Math.max(1, toSafeInt(player.level, 1));
  const totalPoint = getTalentPointByPlayerLevel(playerLevel);
  const usedPoint = getUsedPoint(planInfo);
  const costPoint = Math.max(0, toSafeInt(skillRow.fatePointCost, 0));
  if (usedPoint + costPoint > totalPoint) return { tag: 3802, msgUid, data: null };

  const costList = Array.isArray(skillRow.cost) ? skillRow.cost : [];
  for (const cost of costList) {
    if (!hasEnoughItemOrCurrency(player, cost.id, cost.count)) {
      return { tag: 3802, msgUid, data: null };
    }
  }
    costList.forEach((cost) => consumeItemOrCurrency(player, cost.id, cost.count));

  planInfo.skills.push(skillId);
  const taskChanged = !!refreshMainTaskProgress(player);
  await playerService.savePlayer(session.userId, player);
  const response = { tag: 3802, msgUid, data: { result: 0, skillId } };
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

// reset talent plan (tag:3803)
async function handleFateResetPlan(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3803, msgUid, data: null };

  const planId = toSafeInt(params && params.id, 0);
  if (planId <= 0) return { tag: 3803, msgUid, data: null };

  const info = ensureFateInfo(player);
  const planInfo = ensurePlan(info, planId);

  const resetCost = (config.get('FateBaseConfig') || {}).resetCost || {};
  const costId = toSafeInt(resetCost.id, 0);
  const costCount = Math.max(0, toSafeInt(resetCost.count, 0));
  if (costId > 0 && costCount > 0 && !hasEnoughItemOrCurrency(player, costId, costCount)) {
    return { tag: 3803, msgUid, data: null };
  }
  if (costId > 0 && costCount > 0) {
    consumeItemOrCurrency(player, costId, costCount);
  }

  planInfo.skills = [];
  const taskChanged = !!refreshMainTaskProgress(player);
  await playerService.savePlayer(session.userId, player);
  const response = { tag: 3803, msgUid, data: { result: 0 } };
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

module.exports = {
  ensureFateInfo,
  handleFateSwitchPlan,
  handleFateChooseSkill,
  handleFateResetPlan,
};
