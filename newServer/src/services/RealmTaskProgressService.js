const config = require('./ConfigService');
const { getHistoricalSpiritUpgradeCount } = require('./SpiritProgressService');
const { markTaskDirty } = require('./TaskDirtyService');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function buildTaskText(taskCfg = {}) {
  return [
    taskCfg.name,
    taskCfg.title,
    taskCfg.desc,
    taskCfg.taskDesc,
    taskCfg.content,
    taskCfg.remark,
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ');
}

function isSpiritUpgradeTask(taskId, taskCfg = {}) {
  if (toSafeInt(taskCfg.activeId, 0) === 17) return true;
  const text = buildTaskText(taskCfg);
  if (!text) return false;
  return /(法相|spirit|faxiang)/i.test(text) && /(升级|进阶|upgrade)/i.test(text);
}

function ensureObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function getCurrentStage(player = {}) {
  const roleInfo = ensureObject(player.roleInfo);
  const stage = toSafeInt(roleInfo.stage, toSafeInt(roleInfo.stageId, 1));
  return Math.max(1, stage || 1);
}

function getSpiritUpgradeCount(player = {}) {
  player.other_attr_info = ensureObject(player.other_attr_info);
  const extra = player.other_attr_info;
  extra.mainTaskProgress = ensureObject(extra.mainTaskProgress);
  const counter = extra.mainTaskProgress;
  const derived = Math.max(0, getHistoricalSpiritUpgradeCount(player));
  counter.spiritUpgradeCount = derived > 0
    ? derived
    : Math.max(0, toSafeInt(counter.spiritUpgradeCount, 0));
  return counter.spiritUpgradeCount;
}

function ensureRealmCounter(player = {}) {
  player.other_attr_info = ensureObject(player.other_attr_info);
  const extra = player.other_attr_info;
  if (!extra.realmTaskProgress || typeof extra.realmTaskProgress !== 'object' || Array.isArray(extra.realmTaskProgress)) {
    extra.realmTaskProgress = {};
  }
  const bagelConsume = toSafeInt(extra.realmTaskProgress.bagelConsume, 0);
  extra.realmTaskProgress.bagelConsume = Math.max(0, bagelConsume);
  return extra.realmTaskProgress;
}

function getRaidProgress(player = {}) {
  const raidInfo = ensureObject(player.raidInfo);
  return Math.max(0, toSafeInt(raidInfo.level, 0));
}

function getLevelProgress(player = {}) {
  return Math.max(0, toSafeInt(player.level, 0));
}

function getBagelConsumeProgress(player = {}) {
  const counter = ensureRealmCounter(player);
  return Math.max(0, toSafeInt(counter.bagelConsume, 0));
}

function calcTaskProgress(taskId, taskCfg = {}, player = {}) {
  // Use activeId from task config (same convention as MainTaskProgressService)
  // so calculation stays correct regardless of task ID numbering.
  const activeId = toSafeInt(taskCfg.activeId, 0);

  if (activeId === 17 || isSpiritUpgradeTask(taskId, taskCfg)) {
    return getSpiritUpgradeCount(player);
  }

  switch (activeId) {
    // activeId 6 = player role level
    case 6:
      return getLevelProgress(player);
    // activeId 7 = current mainline level
    case 7:
      return getRaidProgress(player);
    // activeId 13 = realm-specific baozi consumption counter
    case 13:
      return getBagelConsumeProgress(player);
    default: {
      // Fallback: derive type from task ID hundreds-digit for backwards-compat.
      // 400xx = mainline progress, 401xx = baozi, 402xx = level.
      const id = toSafeInt(taskId, 0);
      const group = Math.floor(id / 100) % 10;
      if (group === 0) return getRaidProgress(player);
      if (group === 1) return getBagelConsumeProgress(player);
      if (group === 2) return getLevelProgress(player);
      return 0;
    }
  }
}

function normalizeTaskInfoSafe(taskInfo = {}, roleInfo = {}) {
  try {
    const mod = require('../handlers/playerPayload');
    if (mod && typeof mod.normalizeTaskInfo === 'function') {
      return mod.normalizeTaskInfo(taskInfo, roleInfo);
    }
  } catch (_err) {
    // ignore and use fallback
  }
  return taskInfo;
}

function refreshRealmStageTasks(player = {}) {
  if (!player || typeof player !== 'object') return false;

  const stageCfgMap = config.get('RoleStageConfig') || {};
  const taskCfgMap = config.get('TaskConfig') || {};
  const stageId = getCurrentStage(player);
  const stageCfg = stageCfgMap[stageId] || stageCfgMap[String(stageId)];
  const taskGroup = Array.isArray(stageCfg && stageCfg.taskGroup) ? stageCfg.taskGroup : [];
  if (taskGroup.length <= 0) return false;

  player.taskInfo = normalizeTaskInfoSafe(player.taskInfo || {}, player.roleInfo || {});
  let changed = false;
  const changedTaskIds = [];

  taskGroup.forEach((taskIdRaw) => {
    const taskId = Math.max(0, toSafeInt(taskIdRaw, 0));
    if (taskId <= 0) return;
    const key = String(taskId);
    const taskCfg = taskCfgMap[key] || taskCfgMap[taskId] || {};
    const target = Math.max(0, toSafeInt(taskCfg.taskValue1, 0));
    const old = ensureObject(player.taskInfo.tasks && player.taskInfo.tasks[key]);
    const rawProgress = Math.max(0, calcTaskProgress(taskId, taskCfg, player));
    const progress = Math.max(rawProgress, Math.max(0, toSafeInt(old.progress, 0)));
    const oldStatus = toSafeInt(old.status, 10);
    const status = oldStatus === 30 ? 30 : (target > 0 && progress >= target ? 20 : 10);

    if (
      toSafeInt(old.progress, -1) !== progress
      || toSafeInt(old.target, -1) !== target
      || toSafeInt(old.status, -1) !== status
      || toSafeInt(old.type, -1) !== toSafeInt(taskCfg.type, 4)
    ) {
      player.taskInfo.tasks[key] = {
        id: taskId,
        type: toSafeInt(taskCfg.type, 4),
        status,
        progress,
        target,
      };
      changedTaskIds.push(taskId);
      changed = true;
    }
  });

  if (changed) {
    player.taskInfo = normalizeTaskInfoSafe(player.taskInfo, player.roleInfo || {});
    markTaskDirty(player, changedTaskIds);
  }
  return changed;
}

function addBagelConsume(player = {}, delta = 0) {
  const add = Math.max(0, toSafeInt(delta, 0));
  if (add <= 0) return refreshRealmStageTasks(player);
  const counter = ensureRealmCounter(player);
  counter.bagelConsume = Math.max(0, toSafeInt(counter.bagelConsume, 0)) + add;
  return refreshRealmStageTasks(player);
}

function resetBagelConsume(player = {}) {
  const counter = ensureRealmCounter(player);
  if (toSafeInt(counter.bagelConsume, 0) <= 0) return false;
  counter.bagelConsume = 0;
  markTaskDirty(player);
  return true;
}

module.exports = {
  refreshRealmStageTasks,
  addBagelConsume,
  resetBagelConsume,
};
