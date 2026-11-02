const config = require('./ConfigService');
const { ensureEquipInfo } = require('./EquipService');
const { getHistoricalSpiritUpgradeCount } = require('./SpiritProgressService');
const { markTaskDirty } = require('./TaskDirtyService');

const ACCUMULATED_ACTIVE_IDS = new Set([
  1, 3, 4, 14, 16, 17, 18, 20, 21, 22, 23, 24, 25, 26, 27, 32, 34, 44, 45, 47, 50, 51, 53,
]);

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function buildTaskText(taskCfg = {}) {
  const languageCfg = config.get('LanguageConfig') || {};
  const textRow = languageCfg[toSafeInt(taskCfg.textId, 0)] || languageCfg[String(toSafeInt(taskCfg.textId, 0))] || {};
  return [
    taskCfg.name,
    taskCfg.title,
    taskCfg.desc,
    taskCfg.taskDesc,
    taskCfg.content,
    taskCfg.remark,
    textRow.cn,
    textRow.tw,
    textRow.en,
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ');
}

function isSpiritUpgradeTask(taskId, taskCfg = {}) {
  if (toSafeInt(taskCfg.activeId, 0) === 17) return true;
  if (toSafeInt(taskId, 0) === 10031) return true;

  const text = buildTaskText(taskCfg);
  if (!text) return false;
  return /(法相|spirit|faxiang)/i.test(text) && /(升级|进阶|upgrade)/i.test(text);
}

function isCrossRivalChallengeTask(taskCfg = {}) {
  if (toSafeInt(taskCfg.id, 0) === 10065) return true;
  if (toSafeInt(taskCfg.triggerValue, 0) === 1011) return true;
  if (toSafeInt(taskCfg.triggerValueATest, 0) === 11011) return true;

  const text = buildTaskText(taskCfg);
  return !!text && /(魔灵入侵|cross.?rival)/i.test(text) && /(挑战|参与|fight|battle)/i.test(text);
}

function getAccumulatedTaskCounterValue(taskId, taskCfg = {}, counter = {}) {
  const activeId = toSafeInt(taskCfg.activeId, 0);
  if (activeId === 1) return counter.bagelConsume;
  if (activeId === 3) return counter.equipSaleCount;
  if (activeId === 4) return counter.equipSaleSilver;
  if (activeId === 14) return counter.mainlineChallengeCount;
  if (activeId === 16) return counter.arenaChallengeCount;
  if (activeId === 17 || isSpiritUpgradeTask(taskId, taskCfg)) return counter.spiritUpgradeCount;
  if (activeId === 18) return counter.farmPlantCount;
  if (activeId === 20) return counter.farmHarvestCount;
  if (activeId === 21) return counter.farmStealCount;
  if (activeId === 22) return counter.alchemyGenerateCount;
  if (activeId === 23 && isCrossRivalChallengeTask(taskCfg)) return counter.crossRivalChallengeCount;
  if (activeId === 24) return counter.mountRideCount;
  if (activeId === 25) return counter.mountSummonCount;
  if (activeId === 26) return counter.mountUpgradeCount;
  if (activeId === 27) return counter.guildJoinCount;
  if (activeId === 28) return counter.dungeonBossChallengeCount;
  if (activeId === 39) return counter.dungeonBossMaxMapId;
  if (activeId === 32) return counter.petComposeCount;
  if (activeId === 34) return counter.petWashCount;
  if (activeId === 44) return counter.fishCount;
  if (activeId === 45) return counter.fishRodUpgradeCount;
  if (activeId === 47) return counter.fishOrderCompleteCount;
  if (activeId === 50) return counter.gemObtainCount;
  if (activeId === 51) return counter.gemComposeCount;
  if (activeId === 53) return counter.artifactUpgradeCount;
  return null;
}

function isAccumulatedTask(taskId, taskCfg = {}) {
  return ACCUMULATED_ACTIVE_IDS.has(toSafeInt(taskCfg.activeId, 0)) || isSpiritUpgradeTask(taskId, taskCfg);
}

function isResetOnActivationTask(taskCfg = {}) {
  if (toSafeInt(taskCfg.updateCycle, 0) === 1) return true;
  const activeId = toSafeInt(taskCfg.activeId, 0);
  return activeId === 1 || activeId === 3 || activeId === 4 || activeId === 16;
}

function ensurePlainObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTaskInfoSafe(taskInfo = {}, roleInfo = {}, player = {}) {
  try {
    // Lazy require avoids a hard cycle at module load time.
    // playerPayload already owns canonical task normalization.
    // eslint-disable-next-line global-require
    const mod = require('../handlers/playerPayload');
    if (mod && typeof mod.normalizeTaskInfo === 'function') {
      return mod.normalizeTaskInfo(taskInfo, roleInfo, player);
    }
  } catch (_err) {}
  return taskInfo;
}

function ensureMainTaskProgressCounter(player = {}) {
  player.other_attr_info = ensurePlainObject(player.other_attr_info);
  player.other_attr_info.mainTaskProgress = ensurePlainObject(player.other_attr_info.mainTaskProgress);

  const counter = player.other_attr_info.mainTaskProgress;
  const derivedSpiritUpgradeCount = Math.max(0, toSafeInt(getHistoricalSpiritUpgradeCount(player), 0));
  counter.bagelConsume = Math.max(0, toSafeInt(counter.bagelConsume, 0));
  counter.equipSaleCount = Math.max(0, toSafeInt(counter.equipSaleCount, 0));
  counter.equipSaleSilver = Math.max(0, toSafeInt(counter.equipSaleSilver, 0));
  counter.mainlineChallengeCount = Math.max(0, toSafeInt(counter.mainlineChallengeCount, 0));
  counter.arenaChallengeCount = Math.max(0, toSafeInt(counter.arenaChallengeCount, 0));
  counter.spiritUpgradeCount = derivedSpiritUpgradeCount > 0
    ? derivedSpiritUpgradeCount
    : Math.max(0, toSafeInt(counter.spiritUpgradeCount, 0));
  counter.farmPlantCount = Math.max(0, toSafeInt(counter.farmPlantCount, 0));
  counter.farmHarvestCount = Math.max(0, toSafeInt(counter.farmHarvestCount, 0));
  counter.farmStealCount = Math.max(0, toSafeInt(counter.farmStealCount, 0));
  counter.alchemyGenerateCount = Math.max(0, toSafeInt(counter.alchemyGenerateCount, 0));
  counter.farmRobberFightCount = Math.max(0, toSafeInt(counter.farmRobberFightCount, 0));
  counter.crossRivalChallengeCount = Math.max(0, toSafeInt(counter.crossRivalChallengeCount, 0));
  counter.mountRideCount = Math.max(0, toSafeInt(counter.mountRideCount, 0));
  counter.mountSummonCount = Math.max(0, toSafeInt(counter.mountSummonCount, 0));
  counter.mountUpgradeCount = Math.max(0, toSafeInt(counter.mountUpgradeCount, 0));
  counter.guildJoinCount = Math.max(0, toSafeInt(counter.guildJoinCount, 0));
  counter.dungeonBossChallengeCount = Math.max(0, toSafeInt(counter.dungeonBossChallengeCount, 0));
  counter.dungeonBossMaxMapId = Math.max(0, toSafeInt(counter.dungeonBossMaxMapId, 0));
  counter.templeChallengeCount = Math.max(0, toSafeInt(counter.templeChallengeCount, 0));
  counter.petComposeCount = Math.max(0, toSafeInt(counter.petComposeCount, 0));
  counter.petWashCount = Math.max(0, toSafeInt(counter.petWashCount, 0));
  counter.fishCount = Math.max(0, toSafeInt(counter.fishCount, 0));
  counter.fishRodUpgradeCount = Math.max(0, toSafeInt(counter.fishRodUpgradeCount, 0));
  counter.fishOrderCompleteCount = Math.max(0, toSafeInt(counter.fishOrderCompleteCount, 0));
  counter.gemObtainCount = Math.max(0, toSafeInt(counter.gemObtainCount, 0));
  counter.gemComposeCount = Math.max(0, toSafeInt(counter.gemComposeCount, 0));
  counter.artifactUpgradeCount = Math.max(0, toSafeInt(counter.artifactUpgradeCount, 0));
  return counter;
}

function getCurrentStage(player = {}) {
  const roleInfo = ensurePlainObject(player.roleInfo);
  return Math.max(
    1,
    toSafeInt(roleInfo.stage, toSafeInt(roleInfo.stageId, 1)),
    toSafeInt(roleInfo.stageId, toSafeInt(roleInfo.stage, 1)),
  );
}

function getCurrentMainlineLevel(player = {}) {
  const raidInfo = ensurePlainObject(player.raidInfo);
  return Math.max(1, toSafeInt(raidInfo.level, 1));
}

function getCurrentClearedMainlineLevel(player = {}) {
  const raidInfo = ensurePlainObject(player.raidInfo);
  const currentLevel = Math.max(1, toSafeInt(raidInfo.level, 1));
  return Math.max(0, currentLevel - 1);
}

function getCurrentDropLevel(player = {}) {
  const boxInfo = ensurePlainObject(player.boxInfo);
  return Math.max(1, toSafeInt(boxInfo.level, 1));
}

function getDungeonBossProgress(player = {}, counter = ensureMainTaskProgressCounter(player)) {
  const raidInfo = ensurePlainObject(player.raidInfo);
  const demonBossInfo = ensurePlainObject(raidInfo.demonBossInfo);
  const roleInfo = ensurePlainObject(player.roleInfo);
  return Math.max(
    0,
    toSafeInt(counter.dungeonBossMaxMapId, 0),
    toSafeInt(demonBossInfo.stage, 0),
    toSafeInt(raidInfo.bossStage, 0),
    toSafeInt(roleInfo.stage, toSafeInt(roleInfo.stageId, 1)) - 1,
  );
}

function getEquippedItems(player = {}) {
  if (!player || typeof player !== 'object') return [];

  ensureEquipInfo(player);
  const equipInfo = ensurePlainObject(player.equipInfo);
  const equipSetMap = ensurePlainObject(equipInfo.equipSetMap);
  const presetKey = String(Math.max(0, toSafeInt(equipInfo.curIndex, 0)));
  const plan = ensurePlainObject(equipSetMap[presetKey]);

  return Object.keys(plan).map((slotKey) => {
    const equip = plan[slotKey];
    return equip
      && typeof equip === 'object'
      && !Array.isArray(equip)
      && toSafeInt(equip.uid, 0) > 0
      && toSafeInt(equip.id, 0) > 0
      ? equip
      : null;
  }).filter((equip) => (
    equip
      && typeof equip === 'object'
      && !Array.isArray(equip)
      && toSafeInt(equip.uid, 0) > 0
      && toSafeInt(equip.id, 0) > 0
  ));
}

function getEquippedItemCount(player = {}) {
  return getEquippedItems(player).length;
}

function getEquippedItemCountByMinQuality(player = {}, minQuality = 1) {
  const qualityFloor = Math.max(1, toSafeInt(minQuality, 1));
  return getEquippedItems(player).filter((equip) => (
    Math.max(1, toSafeInt(equip.quailty, 1)) >= qualityFloor
  )).length;
}

function getFarmLogCount(player = {}, type = 0) {
  const farm = ensurePlainObject(player.farmInfo);
  const loglist = ensureArray(farm.loglist);
  return loglist.filter((row) => toSafeInt(row && row.type, 0) === toSafeInt(type, 0)).length;
}

function getCurrentPlantedFieldCount(player = {}) {
  const farm = ensurePlainObject(player.farmInfo);
  const blockInfo = ensureArray(farm.blockInfo);
  return blockInfo.filter((row) => (
    toSafeInt(row && row.index, -1) >= 0
      && toSafeInt(row && row.rewardId, 0) > 0
      && toSafeInt(row && row.curCount, 0) > 0
  )).length;
}

function getAlchemyGenerateCount(player = {}, counter = ensureMainTaskProgressCounter(player)) {
  const info = ensurePlainObject(player.alchemyInfo);
  return Math.max(counter.alchemyGenerateCount, Math.max(0, toSafeInt(info.dayCount, 0)));
}

function getMountList(player = {}) {
  const info = ensurePlainObject(player.mountInfo);
  return ensureArray(info.data).filter((row) => (
    row
    && typeof row === 'object'
    && !Array.isArray(row)
    && toSafeInt(row.uid, 0) > 0
    && toSafeInt(row.id, 0) > 0
  ));
}

function getMountRideCount(player = {}, counter = ensureMainTaskProgressCounter(player)) {
  const info = ensurePlainObject(player.mountInfo);
  const current = toSafeInt(info.equippedUid, 0) > 0 ? 1 : 0;
  return Math.max(counter.mountRideCount, current);
}

function getMountSummonCount(player = {}, counter = ensureMainTaskProgressCounter(player)) {
  return Math.max(counter.mountSummonCount, getMountList(player).length);
}

function getMountUpgradeCount(player = {}, counter = ensureMainTaskProgressCounter(player)) {
  const current = getMountList(player).reduce(
    (sum, row) => sum + Math.max(0, toSafeInt(row && row.level, 1) - 1),
    0,
  );
  return Math.max(counter.mountUpgradeCount, current);
}

function getGuildJoinCount(player = {}, counter = ensureMainTaskProgressCounter(player)) {
  const guildInfo = ensurePlainObject(player.guildInfo);
  const current = toSafeInt(guildInfo.guildId, 0) > 0 ? 1 : 0;
  return Math.max(counter.guildJoinCount, current);
}

function getPetSlotCount(player = {}) {
  const info = ensurePlainObject(player.petInfo);
  const pets = ensureArray(info.pets);
  const slotSet = new Set();
  pets.forEach((row) => {
    const slot = toSafeInt(row && row.slot, -1);
    if (slot <= -1 && slot >= -3) slotSet.add(slot);
  });
  return slotSet.size;
}

function getCurrentFateSkillCount(player = {}) {
  const fateInfo = ensurePlainObject(player.fateInfo);
  const planInfoMap = ensurePlainObject(fateInfo.planInfoMap);
  const activePlanKey = String(Math.max(1, toSafeInt(fateInfo.id, 1)));
  if (planInfoMap[activePlanKey]) {
    return ensureArray(planInfoMap[activePlanKey].skills)
      .map((skillId) => toSafeInt(skillId, 0))
      .filter((skillId, idx, arr) => skillId > 0 && arr.indexOf(skillId) === idx)
      .length;
  }

  let maxCount = 0;
  Object.keys(planInfoMap).forEach((key) => {
    const count = ensureArray(planInfoMap[key] && planInfoMap[key].skills)
      .map((skillId) => toSafeInt(skillId, 0))
      .filter((skillId, idx, arr) => skillId > 0 && arr.indexOf(skillId) === idx)
      .length;
    maxCount = Math.max(maxCount, count);
  });
  return maxCount;
}

function getGemLevelById(gemId) {
  const row = (config.get('GemLevelConfig') || {})[toSafeInt(gemId, 0)];
  return Math.max(1, toSafeInt(row && row.level, 1));
}

function getGemInfo(player = {}) {
  const otherAttr = ensurePlainObject(player.other_attr_info);
  return ensurePlainObject(otherAttr.gemInfo);
}

function getCurrentGemCount(player = {}) {
  const gemInfo = getGemInfo(player);
  return ensureArray(gemInfo.gems).filter((row) => (
    row
    && typeof row === 'object'
    && !Array.isArray(row)
    && toSafeInt(row.uid, 0) > 0
    && toSafeInt(row.id, 0) > 0
  )).length;
}

function getCurrentGemPlacedCount(player = {}, minLevel = 1) {
  const gemInfo = getGemInfo(player);
  const plan = ensurePlainObject(gemInfo.plan);
  const levelFloor = Math.max(1, toSafeInt(minLevel, 1));
  const gemLevelMap = new Map();

  ensureArray(gemInfo.gems).forEach((row) => {
    const uid = toSafeInt(row && row.uid, 0);
    if (uid <= 0) return;
    gemLevelMap.set(uid, getGemLevelById(row && row.id));
  });

  return ensureArray(plan.positions).reduce((count, row) => {
    const uid = toSafeInt(row && row.uid, 0);
    if (uid <= 0) return count;
    return gemLevelMap.get(uid) >= levelFloor ? count + 1 : count;
  }, 0);
}

function getTempleChallengeCount(player = {}) {
  const otherAttr = ensurePlainObject(player.other_attr_info);
  const templeInfo = ensurePlainObject(otherAttr.templeInfo);
  const rankByGame = ensurePlainObject(templeInfo.rankByGame);
  const fromTemple = Object.keys(rankByGame).reduce((sum, key) => (
    sum + Math.max(0, toSafeInt(rankByGame[key] && rankByGame[key].playCount, 0))
  ), 0);
  const counter = ensureMainTaskProgressCounter(player);
  return Math.max(fromTemple, Math.max(0, toSafeInt(counter.templeChallengeCount, 0)));
}

function getFishRodUpgradeCount(player = {}, counter = ensureMainTaskProgressCounter(player)) {
  const info = ensurePlainObject(player.fishInfo);
  const current = Math.max(0, toSafeInt(info.rodLevel, 0));
  return Math.max(counter.fishRodUpgradeCount, current);
}

function getFishOrderCompleteCount(player = {}, counter = ensureMainTaskProgressCounter(player)) {
  const info = ensurePlainObject(player.fishInfo);
  const current = ensureArray(info.orders).filter((row) => !!(row && row.received)).length;
  return Math.max(counter.fishOrderCompleteCount, current);
}

function getArtifactUpgradeCount(player = {}, counter = ensureMainTaskProgressCounter(player)) {
  const info = ensurePlainObject(player.artifactInfo);
  const current = ensureArray(info.artifacts).reduce((sum, row) => (
    sum + Math.max(0, toSafeInt(row && row.attr && row.attr.level, 1) - 1)
  ), 0);
  return Math.max(counter.artifactUpgradeCount, current);
}

function calcMainTaskProgress(taskCfg = {}, player = {}, counter = ensureMainTaskProgressCounter(player)) {
  if (isSpiritUpgradeTask(taskCfg.id, taskCfg)) {
    return counter.spiritUpgradeCount;
  }

  const activeId = toSafeInt(taskCfg.activeId, 0);
  switch (activeId) {
    case 1:
      return counter.bagelConsume;
    case 2:
      return getEquippedItemCount(player);
    case 3:
      return counter.equipSaleCount;
    case 4:
      return counter.equipSaleSilver;
    case 5:
      return getEquippedItemCountByMinQuality(player, taskCfg.taskValue2);
    case 6:
      return Math.max(1, toSafeInt(player.level, 1));
    case 7:
      return getCurrentMainlineLevel(player);
    case 9:
      return getCurrentDropLevel(player);
    case 14:
      return counter.mainlineChallengeCount;
    case 15:
      return getCurrentStage(player);
    case 16:
      return counter.arenaChallengeCount;
    case 17:
      return counter.spiritUpgradeCount;
    case 18:
      return Math.max(counter.farmPlantCount, getFarmLogCount(player, 1), getCurrentPlantedFieldCount(player));
    case 20:
      return Math.max(counter.farmHarvestCount, getFarmLogCount(player, 2));
    case 21:
      return counter.farmStealCount;
    case 22:
      return getAlchemyGenerateCount(player, counter);
    case 23:
      return isCrossRivalChallengeTask(taskCfg) ? counter.crossRivalChallengeCount : counter.farmRobberFightCount;
    case 24:
      return getMountRideCount(player, counter);
    case 25:
      return getMountSummonCount(player, counter);
    case 26:
      return getMountUpgradeCount(player, counter);
    case 27:
      return getGuildJoinCount(player, counter);
    case 28:
      return counter.dungeonBossChallengeCount;
    case 39:
      return getDungeonBossProgress(player, counter);
    case 32:
      return counter.petComposeCount;
    case 33:
      return getPetSlotCount(player);
    case 34:
      return counter.petWashCount;
    case 44:
      return counter.fishCount;
    case 45:
      return getFishRodUpgradeCount(player, counter);
    case 47:
      return getFishOrderCompleteCount(player, counter);
    case 48:
      return getCurrentFateSkillCount(player);
    case 49:
      return getCurrentGemPlacedCount(player, taskCfg.taskValue2);
    case 50:
      return Math.max(counter.gemObtainCount, getCurrentGemCount(player));
    case 51:
      return counter.gemComposeCount;
    case 52:
      return getTempleChallengeCount(player);
    case 53:
      return getArtifactUpgradeCount(player, counter);
    default:
      return null;
  }
}

function getTaskProgressBaseline(taskState = {}, taskCfg = {}, progressValue = 0) {
  if (!isResetOnActivationTask(taskCfg)) return 0;
  const existing = taskState && taskState.progressBase;
  if (existing != null) return Math.max(0, toSafeInt(existing, 0));
  return Math.max(0, toSafeInt(progressValue, 0));
}

function getMainTaskCurrentProgress(taskCfg = {}, player = {}) {
  return calcMainTaskProgress(taskCfg, player, ensureMainTaskProgressCounter(player));
}

function getMainTaskIds(taskCfgMap = {}) {
  return Object.keys(taskCfgMap)
    .map((key) => toSafeInt(key, 0))
    .filter((taskId) => taskId > 0 && toSafeInt(taskCfgMap[taskId] && taskCfgMap[taskId].type, 0) === 1)
    .sort((a, b) => a - b);
}

function getMainTaskNextIdSet(taskCfgMap = {}) {
  const nextIdSet = new Set();
  getMainTaskIds(taskCfgMap).forEach((taskId) => {
    const cfg = taskCfgMap[taskId] || taskCfgMap[String(taskId)] || {};
    const nextId = toSafeInt(cfg.nextId, 0);
    if (nextId > 0) nextIdSet.add(nextId);
  });
  return nextIdSet;
}

function getFirstMainTaskId(taskCfgMap = {}) {
  const mainTaskIds = getMainTaskIds(taskCfgMap);
  if (mainTaskIds.length <= 0) return 0;

  const nextIdSet = getMainTaskNextIdSet(taskCfgMap);
  return mainTaskIds.find((taskId) => !nextIdSet.has(taskId)) || mainTaskIds[0];
}

function canonicalizeMainTaskChain(taskInfo = {}, taskCfgMap = {}) {
  const tasks = ensurePlainObject(taskInfo.tasks);
  const nextIdSet = getMainTaskNextIdSet(taskCfgMap);
  if (nextIdSet.size <= 0) return false;

  const firstTaskId = getFirstMainTaskId(taskCfgMap);
  if (firstTaskId <= 0) return false;

  const activeIds = Object.keys(tasks)
    .map((taskIdKey) => toSafeInt(taskIdKey, 0))
    .filter((taskId) => {
      const state = ensurePlainObject(tasks[String(taskId)] || tasks[taskId]);
      const status = toSafeInt(state.status, 0);
      return taskId > 0 && toSafeInt(state.type, 0) === 1 && (status === 10 || status === 20);
    })
    .sort((a, b) => a - b);
  const claimedIds = Object.keys(tasks)
    .map((taskIdKey) => toSafeInt(taskIdKey, 0))
    .filter((taskId) => {
      const state = ensurePlainObject(tasks[String(taskId)] || tasks[taskId]);
      return taskId > 0 && toSafeInt(state.type, 0) === 1 && toSafeInt(state.status, 0) >= 30;
    })
    .sort((a, b) => a - b);

  let currentTaskId = firstTaskId;
  if (claimedIds.length > 0) {
    const lastClaimedTaskId = claimedIds[claimedIds.length - 1];
    const lastClaimedCfg = taskCfgMap[lastClaimedTaskId] || taskCfgMap[String(lastClaimedTaskId)] || null;
    const nextClaimTaskId = Math.max(firstTaskId, toSafeInt(lastClaimedCfg && lastClaimedCfg.nextId, firstTaskId));
    const matchedActiveTaskId = activeIds.find((taskId) => taskId >= nextClaimTaskId);
    currentTaskId = matchedActiveTaskId || nextClaimTaskId;
  } else {
    // An active task without any claimed predecessor is not evidence of
    // progression. This occurs in stale/partial snapshots and must not make a
    // fresh role jump into a later guide chain.
    currentTaskId = firstTaskId;
  }

  const keepIds = new Set(claimedIds);
  let changed = false;

  while (currentTaskId > 0) {
    const state = ensurePlainObject(tasks[String(currentTaskId)] || tasks[currentTaskId]);
    const status = toSafeInt(state.status, 0);
    keepIds.add(currentTaskId);
    if (status < 30) break;

    const cfg = taskCfgMap[currentTaskId] || taskCfgMap[String(currentTaskId)] || null;
    const nextTaskId = Math.max(0, toSafeInt(cfg && cfg.nextId, 0));
    if (nextTaskId <= 0) break;
    currentTaskId = nextTaskId;
  }

  Object.keys(tasks).forEach((taskIdKey) => {
    const taskId = toSafeInt(taskIdKey, 0);
    const state = ensurePlainObject(tasks[taskIdKey]);
    if (taskId <= 0 || toSafeInt(state.type, 0) !== 1) return;
    if (keepIds.has(taskId)) return;
    delete tasks[taskIdKey];
    changed = true;
  });

  if (!tasks[String(currentTaskId)]) {
    const cfg = taskCfgMap[currentTaskId] || taskCfgMap[String(currentTaskId)] || null;
    if (cfg) {
      tasks[String(currentTaskId)] = {
        id: currentTaskId,
        type: 1,
        status: 10,
        progress: 0,
        target: Math.max(0, toSafeInt(cfg.taskValue1, 0)),
      };
      changed = true;
    }
  }

  if (changed) {
    taskInfo.tasks = tasks;
    taskInfo.tasksMap = ensurePlainObject(taskInfo.tasksMap);
    Object.keys(taskInfo.tasksMap).forEach((typeKey) => {
      if (toSafeInt(typeKey, 0) === 1) {
        delete taskInfo.tasksMap[typeKey];
      }
    });
  }

  return changed;
}

function refreshMainTaskProgress(player = {}) {
  if (!player || typeof player !== 'object') return false;

  const rawTaskInfo = ensurePlainObject(player.taskInfo);
  const rawTasks = ensurePlainObject(rawTaskInfo.tasks);
  const rawTasksMap = ensurePlainObject(rawTaskInfo.tasksMap);
  const needsStructurePersistence = Object.keys(rawTasks).length === 0
    || !Array.isArray(rawTasksMap['1']);
  player.taskInfo = normalizeTaskInfoSafe(player.taskInfo || {}, player.roleInfo || {}, player);
  const tasks = ensurePlainObject(player.taskInfo && player.taskInfo.tasks);
  const taskCfgMap = config.get('TaskConfig') || {};
  const counter = ensureMainTaskProgressCounter(player);
  const changedTaskIds = new Set();
  const canonicalChanged = canonicalizeMainTaskChain(player.taskInfo, taskCfgMap);
  let changed = canonicalChanged || needsStructurePersistence;
  if (canonicalChanged) {
    Object.keys(tasks).forEach((taskIdKey) => {
      const state = ensurePlainObject(tasks[taskIdKey]);
      if (toSafeInt(state.type, 0) === 1 && toSafeInt(state.status, 0) < 30) {
        changedTaskIds.add(toSafeInt(state.id != null ? state.id : taskIdKey, 0));
      }
    });
  }

  Object.keys(tasks).forEach((taskIdKey) => {
    const state = ensurePlainObject(tasks[taskIdKey]);
    const taskId = toSafeInt(state.id != null ? state.id : taskIdKey, 0);
    const taskType = toSafeInt(state.type, 0);
    if (taskId <= 0 || ![1, 2, 9].includes(taskType)) return;

    const taskCfg = taskCfgMap[taskId] || taskCfgMap[String(taskId)] || null;
    if (!taskCfg) return;

    const progressValue = calcMainTaskProgress(taskCfg, player, counter);
    if (progressValue == null) return;
    const target = Math.max(0, toSafeInt(taskCfg.taskValue1, toSafeInt(state.target, 0)));
    const isDailyTask = taskType === 2;
    const progressBase = isDailyTask
      ? (state.progressBase == null
        ? Math.max(0, toSafeInt(progressValue, 0))
        : Math.max(0, toSafeInt(state.progressBase, 0)))
      : getTaskProgressBaseline(state, taskCfg, progressValue);
    const rawProgress = Math.max(0, toSafeInt(progressValue, 0) - progressBase);
    const stableProgress = (isDailyTask || (isAccumulatedTask(taskId, taskCfg) && !isResetOnActivationTask(taskCfg)))
      ? Math.max(rawProgress, Math.max(0, toSafeInt(state.progress, 0)))
      : rawProgress;
    const progress = target > 0
      ? Math.min(target, stableProgress)
      : stableProgress;

    const prevStatus = toSafeInt(state.status, 10);
    const nextStatus = prevStatus >= 30
      ? prevStatus
      : (target > 0 && progress >= target ? 20 : 10);
    const shouldStoreProgressBase = isDailyTask || isResetOnActivationTask(taskCfg);

    if (
      toSafeInt(state.progress, 0) !== progress
      || toSafeInt(state.target, 0) !== target
      || prevStatus !== nextStatus
      || (shouldStoreProgressBase && state.progressBase == null)
    ) {
      tasks[taskIdKey] = {
        ...state,
        id: taskId,
        type: taskType,
        ...(shouldStoreProgressBase ? { progressBase } : {}),
        progress,
        target,
        status: nextStatus,
      };
      changedTaskIds.add(taskId);
      changed = true;
    }
  });

  if (changed) {
    player.taskInfo.tasks = tasks;
    player.taskInfo = normalizeTaskInfoSafe(player.taskInfo, player.roleInfo || {}, player);
    markTaskDirty(player, Array.from(changedTaskIds));
  }

  return changed;
}

function addBagelConsume(player = {}, delta = 0) {
  const add = Math.max(0, toSafeInt(delta, 0));
  if (add <= 0) return false;
  return addCounter(player, 'bagelConsume', add);
}

function addEquipSaleCount(player = {}, delta = 0) {
  const add = Math.max(0, toSafeInt(delta, 0));
  if (add <= 0) return false;
  return addCounter(player, 'equipSaleCount', add);
}

function addEquipSaleSilver(player = {}, delta = 0) {
  const add = Math.max(0, toSafeInt(delta, 0));
  if (add <= 0) return false;
  return addCounter(player, 'equipSaleSilver', add);
}

// Equip sale updates both counters in one operation. The regular counter
// helpers refresh task state immediately, so calling both independently made
// tag=2201 normalize the complete task model multiple times per request.
function addEquipSaleProgress(player = {}, equipCount = 0, silver = 0) {
  const countDelta = Math.max(0, toSafeInt(equipCount, 0));
  const silverDelta = Math.max(0, toSafeInt(silver, 0));
  if (countDelta <= 0 && silverDelta <= 0) return false;

  const counter = ensureMainTaskProgressCounter(player);
  primeResetTaskProgressBases(player, counter);
  counter.equipSaleCount = Math.max(0, toSafeInt(counter.equipSaleCount, 0)) + countDelta;
  counter.equipSaleSilver = Math.max(0, toSafeInt(counter.equipSaleSilver, 0)) + silverDelta;
  return refreshMainTaskProgress(player);
}

function addMainlineChallengeCount(player = {}, delta = 0) {
  const add = Math.max(0, toSafeInt(delta, 0));
  if (add <= 0) return false;
  return addCounter(player, 'mainlineChallengeCount', add);
}

function primeResetTaskProgressBases(player = {}, counter = {}) {
  player.taskInfo = normalizeTaskInfoSafe(player.taskInfo || {}, player.roleInfo || {}, player);
  const tasks = ensurePlainObject(player.taskInfo && player.taskInfo.tasks);
  const taskCfgMap = config.get('TaskConfig') || {};
  Object.keys(tasks).forEach((taskIdKey) => {
    const state = ensurePlainObject(tasks[taskIdKey]);
    if (state.progressBase != null) return;
    const taskId = toSafeInt(state.id != null ? state.id : taskIdKey, 0);
    const taskCfg = taskCfgMap[taskId] || taskCfgMap[String(taskId)] || null;
    if (!taskCfg || !isResetOnActivationTask(taskCfg)) return;
    state.progressBase = Math.max(0, toSafeInt(calcMainTaskProgress(taskCfg, player, counter), 0));
  });
}

function addCounter(player = {}, field, delta = 0) {
  const add = Math.max(0, toSafeInt(delta, 0));
  if (!field || add <= 0) return false;
  const counter = ensureMainTaskProgressCounter(player);
  // Daily tasks use the same lifetime counters as main tasks, with a per-day
  // progressBase. Capture every missing baseline before incrementing.
  primeResetTaskProgressBases(player, counter);
  counter[field] = Math.max(0, toSafeInt(counter[field], 0)) + add;
  return refreshMainTaskProgress(player);
}

function addArenaChallengeCount(player = {}, delta = 0) {
  return addCounter(player, 'arenaChallengeCount', delta);
}

function addSpiritUpgradeCount(player = {}, delta = 0) {
  return addCounter(player, 'spiritUpgradeCount', delta);
}

function addFarmPlantCount(player = {}, delta = 0) {
  return addCounter(player, 'farmPlantCount', delta);
}

function addFarmHarvestCount(player = {}, delta = 0) {
  return addCounter(player, 'farmHarvestCount', delta);
}

function addFarmStealCount(player = {}, delta = 0) {
  return addCounter(player, 'farmStealCount', delta);
}

function addAlchemyGenerateCount(player = {}, delta = 0) {
  return addCounter(player, 'alchemyGenerateCount', delta);
}

function addFarmRobberFightCount(player = {}, delta = 0) {
  return addCounter(player, 'farmRobberFightCount', delta);
}

function addCrossRivalChallengeCount(player = {}, delta = 0) {
  return addCounter(player, 'crossRivalChallengeCount', delta);
}

function addMountRideCount(player = {}, delta = 0) {
  return addCounter(player, 'mountRideCount', delta);
}

function addMountSummonCount(player = {}, delta = 0) {
  return addCounter(player, 'mountSummonCount', delta);
}

function addMountUpgradeCount(player = {}, delta = 0) {
  return addCounter(player, 'mountUpgradeCount', delta);
}

function addGuildJoinCount(player = {}, delta = 0) {
  return addCounter(player, 'guildJoinCount', delta);
}

function addDungeonBossChallengeCount(player = {}, delta = 0) {
  return addCounter(player, 'dungeonBossChallengeCount', delta);
}

function addTempleChallengeCount(player = {}, delta = 0) {
  return addCounter(player, 'templeChallengeCount', delta);
}

function updateDungeonBossMaxMapId(player = {}, mapId = 0) {
  const safeMapId = Math.max(0, toSafeInt(mapId, 0));
  if (safeMapId <= 0) return false;
  const counter = ensureMainTaskProgressCounter(player);
  if (safeMapId <= Math.max(0, toSafeInt(counter.dungeonBossMaxMapId, 0))) {
    return false;
  }
  counter.dungeonBossMaxMapId = safeMapId;
  return refreshMainTaskProgress(player);
}

function addPetComposeCount(player = {}, delta = 0) {
  return addCounter(player, 'petComposeCount', delta);
}

function addPetWashCount(player = {}, delta = 0) {
  return addCounter(player, 'petWashCount', delta);
}

function addFishCount(player = {}, delta = 0) {
  return addCounter(player, 'fishCount', delta);
}

function addFishRodUpgradeCount(player = {}, delta = 0) {
  return addCounter(player, 'fishRodUpgradeCount', delta);
}

function addFishOrderCompleteCount(player = {}, delta = 0) {
  return addCounter(player, 'fishOrderCompleteCount', delta);
}

function addGemObtainCount(player = {}, delta = 0) {
  return addCounter(player, 'gemObtainCount', delta);
}

function addGemComposeCount(player = {}, delta = 0) {
  return addCounter(player, 'gemComposeCount', delta);
}

function addArtifactUpgradeCount(player = {}, delta = 0) {
  return addCounter(player, 'artifactUpgradeCount', delta);
}

module.exports = {
  refreshMainTaskProgress,
  getMainTaskCurrentProgress,
  addBagelConsume,
  addEquipSaleCount,
  addEquipSaleSilver,
  addEquipSaleProgress,
  addMainlineChallengeCount,
  addArenaChallengeCount,
  addSpiritUpgradeCount,
  addFarmPlantCount,
  addFarmHarvestCount,
  addFarmStealCount,
  addAlchemyGenerateCount,
  addFarmRobberFightCount,
  addCrossRivalChallengeCount,
  addMountRideCount,
  addMountSummonCount,
  addMountUpgradeCount,
  addGuildJoinCount,
  addDungeonBossChallengeCount,
  addTempleChallengeCount,
  updateDungeonBossMaxMapId,
  addPetComposeCount,
  addPetWashCount,
  addFishCount,
  addFishRodUpgradeCount,
  addFishOrderCompleteCount,
  addGemObtainCount,
  addGemComposeCount,
  addArtifactUpgradeCount,
};
