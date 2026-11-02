/**
 * 升级/技能/阵法/宝箱/境界系统
 * tag: 3001 阵法升级, 3100 职业切换, 3101 技能升级,
 *      600 境界突破, 502 宝箱升级, 7000 系统解锁
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const serverConfigService = require('../services/ServerConfigService');
const logger = require('../logger');

const SERVER_RUN_DAY_CACHE_TTL_MS = 60000;
const SYSTEM_UNLOCK_REFRESH_TTL_MS = 3000;
let serverRunDayCache = { value: 1, expiresAt: 0 };

function normalizeTaskInfoSafe(taskInfo = {}, roleInfo = {}, player = {}) {
  try {
    // eslint-disable-next-line global-require
    const mod = require('./playerPayload');
    if (mod && typeof mod.normalizeTaskInfo === 'function') {
      return mod.normalizeTaskInfo(taskInfo, roleInfo, player);
    }
  } catch (_err) {}
  return taskInfo;
}

function normalizeIdList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)
    .map((id) => Math.floor(id))
    .filter((id, index, arr) => arr.indexOf(id) === index)
    .sort((a, b) => a - b);
}

function getForcedSystemUnlockIds() {
  return normalizeIdList(String(process.env.FORCE_UNLOCK_SYSTEM_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
}

function getDisabledSystemIds() {
  return normalizeIdList(String(process.env.DISABLED_SYSTEM_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
}

function scheduleSessionSave(session, reason = 'system-unlock') {
  if (!session || !session.userId || !session.player) return;
  if (session._systemUnlockSaveScheduled) return;
  session._systemUnlockSaveScheduled = true;
  Promise.resolve().then(async () => {
    try {
      await playerService.savePlayer(session.userId, session.player);
    } catch (err) {
      logger.warn(`[Upgrade] async save failed ${reason} user=${session.userId}: ${err.message}`);
    } finally {
      session._systemUnlockSaveScheduled = false;
    }
  });
}
const { addRewardToPlayer } = require('./raid');
const chat = require('./chat');
const { buildRewardItemSync } = require('../services/RewardSync');
const { refreshMainTaskProgress, addSpiritUpgradeCount } = require('../services/MainTaskProgressService');
const { refreshRealmStageTasks, resetBagelConsume: resetRealmBagelConsume } = require('../services/RealmTaskProgressService');
const {
  ensureFormationInfo,
  ensureFormationOwnedState,
  getFormationEnchantConfig,
  getFormationGradeRow,
  getFormationInitialId,
  getFormationLevelUpExpValue,
  isFormationOwned,
} = require('../services/FormationService');
const { buildDefaultFashionMap, getRoleGenderRow } = require('../services/RoleAppearanceService');
const { ensureFateInfo } = require('./fate');

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

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function getSystemConditions(systemId, row = null) {
  if (toSafeInt(systemId, 0) <= 0) return [];
  return Array.isArray(row && row.conditions) ? row.conditions : [];
}

function isShareRequest(params = {}) {
  return params && Object.prototype.hasOwnProperty.call(params, 'shareType');
}

function normalizeFishShareEntity(raw = {}) {
  return {
    uid: Math.max(1, toSafeInt(raw.uid, 1)),
    id: Math.max(1, toSafeInt(raw.id, 5011)),
    type: Math.max(1, toSafeInt(raw.type, 1)),
    quality: Math.max(1, toSafeInt(raw.quality, 1)),
    multi: Math.max(1, toSafeInt(raw.multi, 10000)),
    attrs: ensureArray(raw.attrs),
    skills: ensureArray(raw.skills),
    lock: raw.lock ? 1 : 0,
    dead: raw.dead ? 1 : 0,
  };
}

function getShareFishEntity(player = {}, params = {}) {
  const uidList = ensureArray(params.params || params.ids || params.uidList);
  const targetUid = Math.max(1, toSafeInt(uidList[0], toSafeInt(params.uid, 0)));
  if (targetUid <= 0) return null;
  const info = player && player.fishInfo && typeof player.fishInfo === 'object' ? player.fishInfo : {};
  const slots = info.slots && typeof info.slots === 'object' ? Object.values(info.slots) : [];
  const fishResult = info.fishResult && typeof info.fishResult === 'object' ? info.fishResult : {};
  const fishInfos = ensureArray(fishResult.fishInfos);
  const source = [...slots, ...fishInfos].find((row) => toSafeInt(row && row.uid, 0) === targetUid);
  return source ? normalizeFishShareEntity(source) : null;
}

function getShareShipLogId(params = {}) {
  const idList = ensureArray(params.params || params.ids || params.idList);
  return Math.max(1, toSafeInt(idList[0], toSafeInt(params.id, 0)));
}

function getShareBloodlineEntity(player = {}, params = {}) {
  try {
    // eslint-disable-next-line global-require
    const bloodline = require('./bloodline');
    const info = bloodline.ensureBloodlineInfo(player);
    const idList = ensureArray(params.params || params.ids || params.uidList);
    const requested = Math.max(0, toSafeInt(idList[0], toSafeInt(params.uid != null ? params.uid : params.id, 0)));
    let row = (info.dataList || []).find((entry) => {
      return toSafeInt(entry && entry.uid, 0) === requested || toSafeInt(entry && entry.id, 0) === requested;
    });
    if (!row && requested > 0) return null;
    row = row || (info.dataList || []).find((entry) => toSafeInt(entry && entry.uid, 0) === toSafeInt(info.wearUid, 0)) || (info.dataList || [])[0];
    if (!row) return null;
    const cfg = (config.get('BloodlineConfig') || {})[toSafeInt(row.id, 0)] || {};
    return {
      uid: Math.max(1, toSafeInt(row.uid, 1)),
      id: Math.max(1, toSafeInt(row.id, 1)),
      quality: Math.max(3, toSafeInt(cfg.quality, 3)),
      tier: Math.max(0, toSafeInt(row.tier, 0)),
      score: Math.max(0, toSafeInt(row.score, 0)),
      refineList: ensureArray(row.refineList),
    };
  } catch (_err) {
    return null;
  }
}

function handleShareData(params = {}, session = {}, msgUid) {
  const player = session && session.player ? session.player : null;
  const shareType = toSafeInt(params.shareType, 0);
  const channel = toSafeInt(params.channel, 0);
  if (!player) return { tag: 600, msgUid, data: { result: -1, shareType, channel } };

  if (shareType === 5 && channel >= 0) {
    const fishEntity = getShareFishEntity(player, params);
    if (!fishEntity) {
      return { tag: 600, msgUid, data: { result: -1, shareType, channel } };
    }
    const entry = chat.buildChatEntry({ channel, msgType: 5 }, player, {
      msgType: 5,
      sys: false,
      chatFrame: 0,
      content: JSON.stringify(fishEntity),
    });
    chat.pushChatEntry(channel, entry);
    return { tag: 600, msgUid, data: { result: 0, shareType, channel } };
  }

  if (shareType === 12 && channel >= 0) {
    const shipLogId = getShareShipLogId(params);
    const entry = chat.buildChatEntry({ channel, msgType: 12 }, player, {
      msgType: 12,
      sys: false,
      chatFrame: 0,
      content: JSON.stringify({ id: shipLogId }),
    });
    chat.pushChatEntry(channel, entry);
    return { tag: 600, msgUid, data: { result: 0, shareType, channel } };
  }

  if (channel >= 0) {
    const shareEntity = getShareBloodlineEntity(player, params);
    const content = JSON.stringify(shareEntity || {
      shareType,
      params: params.params || params.ids || [],
    });
    const entry = chat.buildChatEntry({ channel, msgType: shareType }, player, {
      msgType: shareType,
      sys: false,
      chatFrame: 0,
      content,
    });
    chat.pushChatEntry(channel, entry);
  }

  return { tag: 600, msgUid, data: { result: 0, shareType, channel } };
}

function ensureRoleInfo(player) {
  player.roleInfo = player.roleInfo || {};
  const roleInfo = player.roleInfo;
  if (!Array.isArray(roleInfo.kungfuSkills)) roleInfo.kungfuSkills = [];
  if (!Array.isArray(roleInfo.kungfuInfos)) roleInfo.kungfuInfos = [];
  if (!roleInfo.kungfuId) roleInfo.kungfuId = 4;
  if (roleInfo.stage == null) roleInfo.stage = roleInfo.stageId || 1;
  if (roleInfo.stageId == null) roleInfo.stageId = roleInfo.stage;
  if (roleInfo.stageFailedTime == null) roleInfo.stageFailedTime = 0;
  if (roleInfo.rewardedStage == null) roleInfo.rewardedStage = 0;
  return roleInfo;
}

function ensureFashionInfo(player) {
  player.fashionInfo = player.fashionInfo && typeof player.fashionInfo === 'object' && !Array.isArray(player.fashionInfo)
    ? player.fashionInfo
    : {};
  const info = player.fashionInfo;
  if (!info.curFashion || typeof info.curFashion !== 'object' || Array.isArray(info.curFashion)) info.curFashion = {};
  if (!info.fashion || typeof info.fashion !== 'object' || Array.isArray(info.fashion)) info.fashion = {};
  if (!info.fashionMap || typeof info.fashionMap !== 'object' || Array.isArray(info.fashionMap)) info.fashionMap = {};
  if (!info.fashions || typeof info.fashions !== 'object' || Array.isArray(info.fashions)) info.fashions = {};
  if (!Array.isArray(info.activateFashion)) info.activateFashion = [];
  return info;
}

function normalizeKungfuInfoRow(info = {}, id) {
  const kungfuId = toSafeInt(info.kungfuId != null ? info.kungfuId : info.id, id);
  const kungfuCfg = (config.get('RoleKungFuConfig') || {})[kungfuId] || {};
  const sourceLevels = Array.isArray(info.skillLevel) ? info.skillLevel : [];
  const sourceSequence = Array.isArray(info.sequence) ? info.sequence : [];
  const size = Math.max(
    5,
    1 + (Array.isArray(kungfuCfg.skillId) ? kungfuCfg.skillId.length : 0),
    sourceLevels.length,
    sourceSequence.length
  );
  info.skillLevel = Array.from({ length: size }, (_row, index) => (
    Math.max(0, toSafeInt(sourceLevels[index], 1))
  ));
  info.sequence = [];
  sourceSequence.forEach((value) => {
    const index = toSafeInt(value, -1);
    if (index >= 0 && index < size && !info.sequence.includes(index)) info.sequence.push(index);
  });
  for (let index = 0; index < size; index += 1) {
    if (!info.sequence.includes(index)) info.sequence.push(index);
  }
  info.id = kungfuId;
  info.kungfuId = kungfuId;
  return info;
}

function ensureKungfuInfo(roleInfo, kungfuId) {
  if (!Array.isArray(roleInfo.kungfuInfos)) roleInfo.kungfuInfos = [];
  const id = toSafeInt(kungfuId, 4);
  let info = roleInfo.kungfuInfos.find((row) => toSafeInt(row && (row.kungfuId != null ? row.kungfuId : row.id), 0) === id);
  if (!info) {
    info = { id, kungfuId: id, sequence: [0, 0, 0, 0, 0], skillLevel: [1, 1, 1, 1, 1] };
    roleInfo.kungfuInfos.push(info);
  }
  normalizeKungfuInfoRow(info, id);
  return info;
}

function resolveKungfuSkillId(kungfuId, index) {
  const cfgMap = config.get('RoleKungFuConfig') || {};
  const row = cfgMap[kungfuId] || cfgMap[String(kungfuId)] || null;
  if (!row) return 0;
  const safeIndex = Math.max(0, toSafeInt(index, 0));
  if (safeIndex === 0) return Math.max(0, toSafeInt(row.atkId, 0));
  const skillIds = Array.isArray(row.skillId) ? row.skillId : [];
  return Math.max(0, toSafeInt(skillIds[safeIndex - 1], 0));
}

function buildKungfuSwitchFollowupPackets(player, id, subJob) {
  const roleInfo = ensureRoleInfo(player);
  const fashionInfo = ensureFashionInfo(player);
  const roleRow = getRoleGenderRow(roleInfo);
  const defaultFashionMap = buildDefaultFashionMap(roleInfo);
  const unlockedFashionIds = [];

  Object.keys(defaultFashionMap).forEach((typeKey) => {
    const fashionId = toSafeInt(defaultFashionMap[typeKey], 0);
    if (fashionId <= 0) return;
    unlockedFashionIds.push(fashionId);
    fashionInfo.fashions[String(fashionId)] = 1;
    if (!fashionInfo.activateFashion.includes(fashionId)) {
      fashionInfo.activateFashion.push(fashionId);
    }
  });

  const rewardAvatar = Array.isArray(roleRow.row && roleRow.row.rewards)
    ? toSafeInt(roleRow.row.rewards[0] && roleRow.row.rewards[0].id, 0)
    : 0;
  if (rewardAvatar > 0) {
    player.avatar = rewardAvatar;
    roleInfo.avatar = rewardAvatar;
    fashionInfo.curFashion['102'] = rewardAvatar;
    fashionInfo.fashion['102'] = rewardAvatar;
    fashionInfo.fashionMap['102'] = rewardAvatar;
    fashionInfo.fashions[String(rewardAvatar)] = 1;
    if (!fashionInfo.activateFashion.includes(rewardAvatar)) {
      fashionInfo.activateFashion.push(rewardAvatar);
    }
  }

  fashionInfo.activateFashion = Array.from(new Set(fashionInfo.activateFashion
    .map((fashionId) => toSafeInt(fashionId, 0))
    .filter((fashionId) => fashionId > 0)));

  const fateInfo = ensureFateInfo(player);
  const activationPackets = unlockedFashionIds.map((fashionId) => ({
    tag: 1800,
    data: {
      data: [],
      fashion: [fashionId],
    },
  }));
  const fashionState = {
    2: -1,
    5: -1,
    17: -1,
  };
  Object.keys(defaultFashionMap).forEach((typeKey) => {
    fashionState[typeKey] = Number(typeKey) === 102 ? toSafeInt(defaultFashionMap[typeKey], -1) : -1;
  });
  if (rewardAvatar > 0) fashionState[102] = rewardAvatar;

  return [
    ...activationPackets,
    {
      tag: 3800,
      data: {
        id: fateInfo.id,
        nowPlanId: fateInfo.id,
        planInfoMap: fateInfo.planInfoMap,
        planInfo: fateInfo.planInfoMap[String(fateInfo.id)] || { skills: [] },
      },
    },
    {
      tag: 1801,
      data: {
        suit: -1,
        equipSkin: {},
        fashion: fashionState,
        set: 0,
      },
    },
    {
      tag: 3100,
      msgUid: 0,
      data: { kungfoInfos: roleInfo.kungfuInfos },
    },
    {
      tag: 3100,
      data: { id, subJob },
    },
  ];
}

function hasEnoughCost(player, cost = {}) {
  const itemId = toSafeInt(cost.id, 0);
  const count = toSafeInt(cost.count, 0);
  if (itemId <= 0 || count <= 0) return true;
  const currKey = getCurrencyKeyById(itemId);
  if (currKey) {
    player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
    return toSafeInt(player.currencies[currKey], 0) >= count;
  }
  player.items = player.items || {};
  return toSafeInt(player.items[itemId], 0) >= count;
}

function consumeCost(player, cost = {}) {
  const itemId = toSafeInt(cost.id, 0);
  const count = toSafeInt(cost.count, 0);
  if (itemId <= 0 || count <= 0) return;
  const currKey = getCurrencyKeyById(itemId);
  if (currKey) {
    player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
    player.currencies[currKey] = Math.max(0, toSafeInt(player.currencies[currKey], 0) - count);
    return;
  }
  player.items = player.items || {};
  player.items[itemId] = Math.max(0, toSafeInt(player.items[itemId], 0) - count);
}

function buildCostSyncPacket(cost = {}) {
  const itemId = toSafeInt(cost.id, 0);
  const count = Math.max(0, toSafeInt(cost.count, 0));
  if (itemId <= 0 || count <= 0) return null;
  return {
    tag: 1202,
    msgUid: 0,
    data: {
      items: [{ id: itemId, count: -count }],
    },
  };
}

function addRewards(player, rewards = []) {
  const rewardInfo = { items: [], equips: [], heros: [] };
  if (!Array.isArray(rewards)) return rewardInfo;
  rewards.forEach((reward) => {
    const id = toSafeInt(reward && reward.id, 0);
    const count = toSafeInt(reward && reward.count, 0);
    if (id <= 0 || count <= 0) return;
    addRewardToPlayer(player, id, count);
    rewardInfo.items.push({ id, count });
  });
  return rewardInfo;
}

function buildTaskUpdatePacketsSafe(player, msgUid = 0, options = {}) {
  try {
    // eslint-disable-next-line global-require
    const task = require('./task');
    if (task && typeof task.buildActiveTaskUpdatePackets === 'function') {
      return task.buildActiveTaskUpdatePackets(player, msgUid, options);
    }
  } catch (_err) {}
  return [];
}

function buildRealmBreakthroughTaskPackets(player, msgUid = 0) {
  return buildTaskUpdatePacketsSafe(player, msgUid, {
    includeTaskTypes: [1, 4, 7, 1073746825],
  });
}

function getStageBreakthroughState(player, roleInfo, stageCfgMap) {
  const currentStage = Math.max(1, toSafeInt(roleInfo.stage, toSafeInt(roleInfo.stageId, 1)));
  const currentCfg = stageCfgMap[currentStage] || stageCfgMap[String(currentStage)] || null;
  const levelCfgMap = config.get('RoleLevelConfig') || {};
  const playerLevel = Math.max(1, toSafeInt(player.level, 1));
  const levelCfg = levelCfgMap[playerLevel] || levelCfgMap[String(playerLevel)] || {};
  const requiredExp = Math.max(0, toSafeInt(levelCfg.exp, 0));

  refreshRealmStageTasks(player);
  player.taskInfo = normalizeTaskInfoSafe(player.taskInfo || {}, roleInfo, player);
  const tasks = player.taskInfo && player.taskInfo.tasks && typeof player.taskInfo.tasks === 'object'
    ? player.taskInfo.tasks
    : {};
  const taskIds = Array.isArray(currentCfg && currentCfg.taskGroup) ? currentCfg.taskGroup : [];
  const tasksComplete = taskIds.length === 3 && taskIds.every((taskIdRaw) => {
    const taskId = Math.max(0, toSafeInt(taskIdRaw, 0));
    const state = tasks[String(taskId)] || tasks[taskId] || {};
    return toSafeInt(state.status, 10) >= 20;
  });

  return {
    currentStage,
    currentCfg,
    requiredExp,
    tasksComplete,
    levelComplete: !!currentCfg && playerLevel >= Math.max(1, toSafeInt(currentCfg.levelMax, 1)),
    expComplete: requiredExp <= 0 || Math.max(0, toSafeInt(player.exp, 0)) >= requiredExp,
  };
}

function getBreakthroughItemRate(costItems = []) {
  const assetsCfg = config.get('AssetsConfig') || {};
  return costItems.reduce((total, cost) => {
    const itemId = Math.max(0, toSafeInt(cost && cost.id, 0));
    const count = Math.max(0, toSafeInt(cost && cost.count, 0));
    const itemCfg = assetsCfg[itemId] || assetsCfg[String(itemId)] || {};
    return total + Math.max(0, toSafeInt(itemCfg.param, 0)) * count;
  }, 0);
}

function refreshUpgradeRelatedTasks(player) {
  refreshMainTaskProgress(player);
  refreshRealmStageTasks(player);
  player.taskInfo = normalizeTaskInfoSafe(player.taskInfo || {}, player.roleInfo || {}, player);
}

function compareConditionProgress(currentValue, targetValue, cond) {
  switch (toSafeInt(cond, 0)) {
    case 0: return currentValue === targetValue;
    case 1: return currentValue < targetValue;
    case 2: return currentValue <= targetValue;
    case 3: return currentValue > targetValue;
    case 4: return currentValue >= targetValue;
    default: return false;
  }
}

function getCurrentMainTaskId(player = {}) {
  const taskInfo = normalizeTaskInfoSafe(player.taskInfo || {}, player.roleInfo || {}, player);
  const mainTasks = Array.isArray(taskInfo.tasksMap && taskInfo.tasksMap['1'])
    ? taskInfo.tasksMap['1'].slice()
    : [];
  mainTasks.sort((a, b) => toSafeInt(a && a.id, 0) - toSafeInt(b && b.id, 0));
  const activeTask = mainTasks.find((task) => {
    const status = toSafeInt(task && task.status, 0);
    return status === 10 || status === 20;
  });
  return Math.max(0, toSafeInt(activeTask && activeTask.id, 0));
}

function getMaxGemLevel(player = {}) {
  const otherAttr = (player.other_attr_info && typeof player.other_attr_info === 'object') ? player.other_attr_info : {};
  const gemInfo = (otherAttr.gemInfo && typeof otherAttr.gemInfo === 'object') ? otherAttr.gemInfo : {};
  const gems = Array.isArray(gemInfo.gems) ? gemInfo.gems : [];
  const levelCfg = config.get('GemLevelConfig') || {};
  return gems.reduce((maxLevel, gem) => {
    const gemId = toSafeInt(gem && gem.id, 0);
    const row = levelCfg[gemId] || levelCfg[String(gemId)] || {};
    return Math.max(maxLevel, Math.max(1, toSafeInt(row.level, 1)));
  }, 0);
}

function getArtifactMaxLevel(player = {}) {
  const info = (player.artifactInfo && typeof player.artifactInfo === 'object') ? player.artifactInfo : {};
  const list = Array.isArray(info.artifacts) ? info.artifacts : [];
  return list.reduce((maxLevel, row) => Math.max(maxLevel, Math.max(0, toSafeInt(row && row.attr && row.attr.level, 0))), 0);
}

function getFishingLevel(player = {}) {
  const info = (player.fishInfo && typeof player.fishInfo === 'object') ? player.fishInfo : {};
  return Math.max(0, toSafeInt(info.level, 0));
}

function getHomelandLevel(player = {}) {
  const info = (player.homelandInfo && typeof player.homelandInfo === 'object') ? player.homelandInfo : {};
  return Math.max(0, toSafeInt(info.level, 0));
}

function getGuildLevel(player = {}) {
  const info = (player.guildInfo && typeof player.guildInfo === 'object') ? player.guildInfo : {};
  return Math.max(0, toSafeInt(info.level, 0));
}

function getEffectivePlayerCreateTime(player = {}) {
  const createTime = Math.max(0, toSafeInt(player && player.createTime, 0));
  if (createTime > 0) return createTime;
  const createdAt = player && player.createdAt ? new Date(player.createdAt).getTime() : 0;
  if (Number.isFinite(createdAt) && createdAt > 0) return createdAt;
  const updatedAt = player && player.updatedAt ? new Date(player.updatedAt).getTime() : 0;
  if (Number.isFinite(updatedAt) && updatedAt > 0) return updatedAt;
  return Date.now();
}

function getPlayerCreateDay(player = {}) {
  const diff = Math.max(0, Date.now() - getEffectivePlayerCreateTime(player));
  return Math.max(1, Math.ceil(diff / 86400000));
}

function getRechargeBuyCount(player = {}, goodsId = 0) {
  const rechargeInfo = (player.rechargeInfo && typeof player.rechargeInfo === 'object') ? player.rechargeInfo : {};
  const records = Array.isArray(rechargeInfo.records) ? rechargeInfo.records : [];
  const safeGoodsId = Math.max(0, toSafeInt(goodsId, 0));
  if (safeGoodsId <= 0) return 0;
  const row = records.find((item) => Math.max(0, toSafeInt(item && item.id, 0)) === safeGoodsId);
  return Math.max(0, toSafeInt(row && row.count, 0));
}

async function getServerRunDay() {
  const now = Date.now();
  if (serverRunDayCache.expiresAt > now) return serverRunDayCache.value;
  const serverId = Math.max(1, toSafeInt(process.env.SERVER_ID, 1001));
  const cfg = await serverConfigService.findServerConfig(serverId).catch(() => null);
  const openTime = Math.max(0, toSafeInt(cfg && cfg.openTime, 0));
  const value = openTime <= 0 ? 1 : Math.max(1, Math.ceil((now - openTime) / 86400000));
  serverRunDayCache = { value, expiresAt: now + SERVER_RUN_DAY_CACHE_TTL_MS };
  return value;
}

async function refreshSystemUnlockInfoCached(player = {}, session = null) {
  const now = Date.now();
  if (session && session._systemUnlockRefreshedAt && now - session._systemUnlockRefreshedAt < SYSTEM_UNLOCK_REFRESH_TTL_MS) {
    return false;
  }
  const changed = await refreshSystemUnlockInfo(player);
  if (session) session._systemUnlockRefreshedAt = now;
  return changed;
}

async function isSystemConditionMet(player = {}, condition = {}, unlockedSet = new Set(), depth = 0, context = {}) {
  const type = toSafeInt(condition && condition.type, 0);
  const value = toSafeInt(condition && condition.value, 0);
  const cond = toSafeInt(condition && condition.cond, 0);
  if (depth > 10) return false;

  switch (type) {
    case 1:
      return compareConditionProgress(Math.max(1, toSafeInt(player.raidInfo && player.raidInfo.chapter, 1)), value, cond);
    case 2:
      return compareConditionProgress(getCurrentMainTaskId(player), value, cond);
    case 3:
      return compareConditionProgress(Math.max(1, toSafeInt(player.level, 1)), value, cond);
    case 4:
      return compareConditionProgress(Math.max(1, toSafeInt(player.boxInfo && player.boxInfo.level, 1)), value, cond);
    case 5:
      return compareConditionProgress(Math.max(1, toSafeInt(context.serverRunDay, 1)), value, cond);
    case 6:
      return compareConditionProgress(getPlayerCreateDay(player), value, cond);
    case 7: {
      if (unlockedSet.has(value)) return true;
      const systemCfg = config.get('SystemConfig') || {};
      const row = systemCfg[value] || systemCfg[String(value)] || null;
      const conditions = getSystemConditions(value, row);
      if (!row || conditions.length <= 0) return false;
      for (const item of conditions) {
        if (!await isSystemConditionMet(player, item, unlockedSet, depth + 1, context)) return false;
      }
      return true;
    }
    case 8:
      return compareConditionProgress(getGuildLevel(player), value, cond);
    case 9:
      return compareConditionProgress(Math.max(1, toSafeInt(player.roleInfo && (player.roleInfo.stageId != null ? player.roleInfo.stageId : player.roleInfo.stage), 1)), value, cond);
    case 11:
      return compareConditionProgress(Math.max(0, toSafeInt(player.rechargeInfo && player.rechargeInfo.totalRecharge, 0)), value, cond);
    case 12:
      return compareConditionProgress(getMaxGemLevel(player), value, cond);
    case 13:
      return compareConditionProgress(getFishingLevel(player), value, cond);
    case 14:
      return compareConditionProgress(getArtifactMaxLevel(player), value, cond);
    case 15:
      return compareConditionProgress(getHomelandLevel(player), value, cond);
    case 10:
      return getRechargeBuyCount(player, value) > 0;
    default:
      return false;
  }
}

async function refreshSystemUnlockInfo(player = {}) {
  if (!player || typeof player !== 'object') return false;
  player.systemUnlockInfo = player.systemUnlockInfo || {};
  const info = player.systemUnlockInfo;
  const unlockedSet = new Set(normalizeIdList(info.unlockedSystem));
  const systemCfg = config.get('SystemConfig') || {};
  const context = { serverRunDay: await getServerRunDay() };
  const disabledSet = new Set(getDisabledSystemIds());
  let changed = false;

  disabledSet.forEach((systemId) => {
    if (!unlockedSet.delete(systemId)) return;
    changed = true;
  });

  getForcedSystemUnlockIds().forEach((systemId) => {
    if (disabledSet.has(systemId)
      || !(systemCfg[systemId] || systemCfg[String(systemId)])
      || unlockedSet.has(systemId)) return;
    unlockedSet.add(systemId);
    changed = true;
  });

  let passChanged = true;
  while (passChanged) {
    passChanged = false;
    for (const key of Object.keys(systemCfg)) {
      const systemId = Math.max(0, toSafeInt(key, 0));
      const row = systemCfg[key];
      const conditions = getSystemConditions(systemId, row);
      if (systemId <= 0 || !row || conditions.length <= 0) continue;
      if (disabledSet.has(systemId)) continue;
      if (unlockedSet.has(systemId)) continue;
      let passed = true;
      for (const condition of conditions) {
        if (!await isSystemConditionMet(player, condition, unlockedSet, 0, context)) {
          passed = false;
          break;
        }
      }
      if (passed) {
        unlockedSet.add(systemId);
        passChanged = true;
        changed = true;
      }
    }
  }

  if (changed) {
    info.unlockedSystem = Array.from(unlockedSet).sort((a, b) => a - b);
  }
  return changed;
}

function markNewFeaturesSeen(player = {}, featureIds = []) {
  if (!player || typeof player !== 'object') return false;
  const ids = normalizeIdList(featureIds);
  if (ids.length <= 0) return false;
  player.systemUnlockInfo = player.systemUnlockInfo || {};
  player.systemUnlockInfo.settings = player.systemUnlockInfo.settings || {};
  const settings = player.systemUnlockInfo.settings;
  const seenSet = new Set(normalizeIdList(settings.seenNewFeatures));
  const beforeSize = seenSet.size;
  ids.forEach((id) => seenSet.add(id));
  if (seenSet.size === beforeSize) return false;
  settings.seenNewFeatures = Array.from(seenSet).sort((a, b) => a - b);
  return true;
}

function hasEnoughCosts(player, costs = []) {
  return Array.isArray(costs) ? costs.every((cost) => hasEnoughCost(player, cost)) : true;
}

function consumeCosts(player, costs = []) {
  if (!Array.isArray(costs)) return;
  costs.forEach((cost) => consumeCost(player, cost));
}

function buildFormationResponseData(formationInfo = {}, extra = {}) {
  return {
    id: toSafeInt(formationInfo.equippedId, getFormationInitialId()),
    grade: toSafeInt(formationInfo.grade, 1),
    level: toSafeInt(formationInfo.level, 1),
    exp: toSafeInt(formationInfo.exp, 0),
    enchant: Array.isArray(formationInfo.enchant) ? formationInfo.enchant.slice() : [],
    ...extra,
  };
}

// 阵法升级 (tag:3001)
async function handleFormationEquip(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3000, msgUid, data: { result: -1, id: getFormationInitialId() } };

  const formationInfo = ensureFormationInfo(player);
  const targetId = Math.max(1, toSafeInt(params && params.id, formationInfo.equippedId));
  ensureFormationOwnedState(player, formationInfo);
  if (isFormationOwned(player, targetId, formationInfo)) {
    if (!formationInfo.owns.includes(targetId)) {
      formationInfo.owns.push(targetId);
      formationInfo.owns = Array.from(new Set(formationInfo.owns)).sort((a, b) => a - b);
    }
    formationInfo.equippedId = targetId;
    formationInfo.id = targetId;
    formationInfo.curFormation = targetId;
    await playerService.savePlayer(session.userId, player);
    return { tag: 3000, msgUid, data: { result: 0, id: targetId, owns: formationInfo.owns.slice() } };
  }

  return { tag: 3000, msgUid, data: { result: -1, id: formationInfo.equippedId, owns: formationInfo.owns.slice() } };
}

async function handleFormationUpgrade(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3001, msgUid, data: { result: -1 } };

  const formationInfo = ensureFormationInfo(player);
  const currentRow = getFormationGradeRow(formationInfo.grade);
  if (!currentRow || !currentRow.levelUpCost) {
    return {
      tag: 3001,
      msgUid,
      data: buildFormationResponseData(formationInfo, { result: -1, msg: 'formation_config_missing' }),
    };
  }

  const requestCount = Math.max(1, toSafeInt(params && params.count, 1));
  const unitCost = {
    id: toSafeInt(currentRow.levelUpCost.id, 0),
    count: Math.max(1, toSafeInt(currentRow.levelUpCost.count, 1)),
  };
  const cost = {
    id: unitCost.id,
    count: unitCost.count * requestCount,
  };
  const maxLevel = Math.max(1, toSafeInt(currentRow.level, 1));
  const maxExp = Math.max(0, toSafeInt(currentRow.exp, 0));
  const isMaxed = formationInfo.level >= maxLevel && formationInfo.exp >= maxExp;
  if (isMaxed) {
    return {
      tag: 3001,
      msgUid,
      data: buildFormationResponseData(formationInfo, { result: -1, msg: 'formation_level_max' }),
    };
  }
  if (!hasEnoughCost(player, cost)) {
    return {
      tag: 3001,
      msgUid,
      data: buildFormationResponseData(formationInfo, { result: -1, msg: 'not enough items' }),
    };
  }

  consumeCost(player, cost);
  const totalExp = requestCount * getFormationLevelUpExpValue(formationInfo);
  let remainExp = totalExp;
  while (remainExp > 0) {
    if (formationInfo.level >= maxLevel && formationInfo.exp >= maxExp) break;
    if (formationInfo.level >= maxLevel) {
      const add = Math.min(maxExp - formationInfo.exp, remainExp);
      formationInfo.exp += add;
      remainExp -= add;
      continue;
    }

    const needExp = Math.max(1, maxExp - formationInfo.exp);
    if (remainExp >= needExp) {
      remainExp -= needExp;
      formationInfo.level += 1;
      formationInfo.exp = formationInfo.level >= maxLevel ? maxExp : 0;
      continue;
    }

    formationInfo.exp += remainExp;
    remainExp = 0;
  }

  addSpiritUpgradeCount(player, requestCount);
  refreshMainTaskProgress(player);
  refreshRealmStageTasks(player);
  await playerService.savePlayer(session.userId, player);

  const resp = {
    tag: 3001,
    msgUid,
    data: buildFormationResponseData(formationInfo, {
      result: 0,
      gainExp: totalExp - remainExp,
      cost,
    }),
  };
  return [
    buildCostSyncPacket(cost),
    ...buildTaskUpdatePacketsSafe(player),
    resp,
  ].filter(Boolean);
}

// 阵法升阶 (tag:3002)
async function handleFormationUpgradeGrade(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3002, msgUid, data: { result: -1 } };

  const formationInfo = ensureFormationInfo(player);
  const currentRow = getFormationGradeRow(formationInfo.grade);
  const nextRow = getFormationGradeRow(formationInfo.grade + 1);
  if (!currentRow || !currentRow.gradeUpCost || !nextRow) {
    return {
      tag: 3002,
      msgUid,
      data: buildFormationResponseData(formationInfo, { result: -1, msg: 'formation_grade_max' }),
    };
  }

  const maxLevel = Math.max(1, toSafeInt(currentRow.level, 1));
  const maxExp = Math.max(0, toSafeInt(currentRow.exp, 0));
  if (formationInfo.level < maxLevel || formationInfo.exp < maxExp) {
    return {
      tag: 3002,
      msgUid,
      data: buildFormationResponseData(formationInfo, { result: -1, msg: 'formation_grade_locked' }),
    };
  }

  const cost = {
    id: toSafeInt(currentRow.gradeUpCost.id, 0),
    count: Math.max(1, toSafeInt(currentRow.gradeUpCost.count, 1)),
  };
  if (!hasEnoughCost(player, cost)) {
    return {
      tag: 3002,
      msgUid,
      data: buildFormationResponseData(formationInfo, { result: -1, msg: 'not enough items' }),
    };
  }

  consumeCost(player, cost);
  formationInfo.grade += 1;
  formationInfo.level = 1;
  formationInfo.exp = 0;

  refreshMainTaskProgress(player);
  refreshRealmStageTasks(player);
  await playerService.savePlayer(session.userId, player);

  return [
    buildCostSyncPacket(cost),
    ...buildTaskUpdatePacketsSafe(player),
    {
    tag: 3002,
    msgUid,
    data: buildFormationResponseData(formationInfo, { result: 0, cost }),
    },
  ].filter(Boolean);
}

// 阵法附灵 (tag:3003)
async function handleFormationEnchant(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3003, msgUid, data: { result: -1 } };

  const formationInfo = ensureFormationInfo(player);
  const enchant = Array.isArray(formationInfo.enchant) ? formationInfo.enchant : [];
  const index = Math.max(0, toSafeInt(params && params.index, 0));
  if (index >= enchant.length) {
    return { tag: 3003, msgUid, data: { result: -1, enchant: enchant.slice(), msg: 'invalid_index' } };
  }

  const currentLevel = Math.max(0, toSafeInt(enchant[index], 0));
  const nextRow = getFormationEnchantConfig()[currentLevel + 1]
    || getFormationEnchantConfig()[String(currentLevel + 1)];
  if (!nextRow) {
    return { tag: 3003, msgUid, data: { result: -1, enchant: enchant.slice(), msg: 'formation_enchant_max' } };
  }

  const upgradeCosts = Array.isArray(nextRow.upgradeCost) ? nextRow.upgradeCost : [];
  if (!hasEnoughCosts(player, upgradeCosts)) {
    return { tag: 3003, msgUid, data: { result: -1, enchant: enchant.slice(), msg: 'not enough items' } };
  }

  consumeCosts(player, upgradeCosts);
  const probability = Math.max(0, Math.min(10000, toSafeInt(nextRow.probability, 0)));
  const success = Math.random() * 10000 < probability;
  if (success) {
    enchant[index] = currentLevel + 1;
    formationInfo.enchant = enchant.slice();
  }

  refreshMainTaskProgress(player);
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 3003,
    msgUid,
    data: {
      result: success ? 0 : -1,
      enchant: enchant.slice(),
      index,
    },
  };
}

// 职业切换 (tag:3100)
async function handleKungfuSwitch(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3100, msgUid, data: { result: -1 } };

  const wasUnselected = toSafeInt(player && player.roleInfo && player.roleInfo.kungfuId, 0) <= 0;
  const requestedId = params.id || 4;
  const requestedSubJob = params.subJob || 0;
  const normalizedRole = getRoleGenderRow({ kungfuId: requestedId, subJob: requestedSubJob });
  const id = normalizedRole.kungfuId;
  const subJob = normalizedRole.subJob;

  const roleInfo = ensureRoleInfo(player);
  roleInfo.kungfuId = id;
  roleInfo.subJob = subJob;
  ensureKungfuInfo(roleInfo, id);

  await playerService.savePlayer(session.userId, player);
  if (wasUnselected) {
    const packets = buildKungfuSwitchFollowupPackets(player, id, subJob);
    packets[packets.length - 1].msgUid = msgUid;
    return packets;
  }
  return [
    { tag: 3100, msgUid: 0, data: { kungfoInfos: roleInfo.kungfuInfos } },
    { tag: 3100, msgUid, data: { id, subJob } },
  ];
}

// 技能升级 (tag:3101)
async function handleSkillUpgrade(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3101, msgUid, data: { result: -1 } };

  const roleInfo = ensureRoleInfo(player);
  const activeKungfuId = toSafeInt(roleInfo.kungfuId, 4);
  const kungfuInfo = ensureKungfuInfo(roleInfo, activeKungfuId);
  const index = Math.max(0, toSafeInt(params && params.index, 0));
  const skillId = resolveKungfuSkillId(activeKungfuId, index);

  const levels = Array.isArray(kungfuInfo.skillLevel) ? kungfuInfo.skillLevel.slice() : [];
  if (skillId <= 0 || index >= levels.length) {
    return {
      tag: 3101,
      msgUid,
      data: { result: -1, index, level: Math.max(0, toSafeInt(levels[index], 0)), skillId: 0 },
    };
  }
  while (levels.length <= index) levels.push(0);
  const curLevel = toSafeInt(levels[index], 0);
  const cost = (curLevel + 1) * 200;

  player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
  if ((player.currencies.silver || 0) < cost) {
    return {
      tag: 3101,
      msgUid,
      data: { result: -1, msg: 'not enough silver', index, skillId, level: curLevel },
    };
  }

  player.currencies.silver -= cost;
  levels[index] = curLevel + 1;
  kungfuInfo.skillLevel = levels;

  const existing = roleInfo.kungfuSkills.find((s) => toSafeInt(s && s.id, 0) === skillId);
  if (existing) existing.level = curLevel + 1;
  else roleInfo.kungfuSkills.push({ id: skillId, level: curLevel + 1 });

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 3101, msgUid,
    data: {
      result: 0,
      index,
      skillId,
      level: curLevel + 1,
      cost,
      currencies: player.currencies,
    },
  };
}

// 功法技能顺序调整 (tag:3102)
async function handleKungfuSkillSequenceChange(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3102, msgUid, data: { result: -1, seq: [] } };

  const roleInfo = ensureRoleInfo(player);
  const kungfuInfo = ensureKungfuInfo(roleInfo, roleInfo.kungfuId);
  const skillIndex = toSafeInt(params && params.skillIndex, -1);
  const sequenceIndex = toSafeInt(params && params.sequenceIndex, -1);
  const nextSeq = Array.isArray(kungfuInfo.sequence) ? kungfuInfo.sequence.slice() : [];

  if (skillIndex >= 0 && sequenceIndex >= 0) {
    const currentPos = nextSeq.indexOf(skillIndex);
    if (currentPos >= 0) nextSeq.splice(currentPos, 1);
    const insertPos = Math.min(Math.max(sequenceIndex, 0), nextSeq.length);
    nextSeq.splice(insertPos, 0, skillIndex);
  }

  kungfuInfo.sequence = nextSeq;
  await playerService.savePlayer(session.userId, player);
  return [
    { tag: 3100, msgUid: 0, data: { kungfoInfos: roleInfo.kungfuInfos } },
    { tag: 3102, msgUid, data: { result: 0, seq: kungfuInfo.sequence } },
  ];
}

// 境界突破（客户端主链路）(tag:3103)
async function handleStageUpgrade(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3103, msgUid, data: { result: -1 } };

  const roleInfo = ensureRoleInfo(player);
  const stageCfg = config.get('RoleStageConfig') || {};
  const state = getStageBreakthroughState(player, roleInfo, stageCfg);
  const requestStage = toSafeInt(params && params.stage, state.currentStage + 1);
  const targetCfg = stageCfg[requestStage] || stageCfg[String(requestStage)];
  if (!state.currentCfg || requestStage !== state.currentStage + 1 || !targetCfg) {
    return {
      tag: 3103,
      msgUid,
      data: {
        result: -1,
        stage: roleInfo.stage,
        stageFailedTime: roleInfo.stageFailedTime,
        rewardInfo: { items: [], equips: [], heros: [] },
      },
    };
  }

  if (!state.tasksComplete || !state.levelComplete || !state.expComplete) {
    logger.warn(
      `[Upgrade3103] condition rejected user=${session.userId || 'unknown'} `
      + `stage=${state.currentStage} tasks=${state.tasksComplete ? 1 : 0} `
      + `level=${Math.max(1, toSafeInt(player.level, 1))}/${Math.max(1, toSafeInt(state.currentCfg.levelMax, 1))} `
      + `exp=${Math.max(0, toSafeInt(player.exp, 0))}/${state.requiredExp}`
    );
    return {
      tag: 3103,
      msgUid,
      data: {
        result: -1,
        stage: roleInfo.stage,
        stageFailedTime: roleInfo.stageFailedTime,
        rewardInfo: { items: [], equips: [], heros: [] },
      },
    };
  }

  const costItems = Array.isArray(params && params.items) ? params.items : [];
  for (const cost of costItems) {
    if (!hasEnoughCost(player, cost)) {
      return {
        tag: 3103,
        msgUid,
        data: {
          result: -1,
          stage: roleInfo.stage,
          stageFailedTime: roleInfo.stageFailedTime,
          rewardInfo: { items: [], equips: [], heros: [] },
        },
      };
    }
  }
  costItems.forEach((cost) => consumeCost(player, cost));

  const successRateValue = Math.max(0, Math.min(
    10000,
    toSafeInt(state.currentCfg.successRate, 0)
      + toSafeInt(roleInfo.stageFailedTime, 0) * Math.max(0, toSafeInt(state.currentCfg.addSuccessRate, 0))
      + getBreakthroughItemRate(costItems)
  ));
  const successRate = successRateValue / 10000;
  const success = Math.random() < successRate;
  const rewardInfo = success ? addRewards(player, targetCfg.rewards || []) : { items: [], equips: [], heros: [] };

  if (success) {
    roleInfo.stage = requestStage;
    roleInfo.stageId = requestStage;
    roleInfo.stageFailedTime = 0;
    resetRealmBagelConsume(player);
  } else {
    roleInfo.stageFailedTime = toSafeInt(roleInfo.stageFailedTime, 0) + 1;
  }

  refreshUpgradeRelatedTasks(player);
  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 3103,
    msgUid,
    data: {
      result: success ? 0 : -1,
      stage: roleInfo.stage,
      stageFailedTime: roleInfo.stageFailedTime,
      rewardInfo,
    },
  };
  const costUpdates = costItems.map(buildCostSyncPacket).filter(Boolean);
  const taskUpdates = buildRealmBreakthroughTaskPackets(player, 0);
  const packets = [...costUpdates, ...taskUpdates, response];
  return packets.length > 1 ? packets : response;
}

// 重置功法技能 (tag:3104)
async function handleResetKungfuSkill(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3104, msgUid, data: { result: -1, level: [] } };

  const roleInfo = ensureRoleInfo(player);
  const kungfuId = toSafeInt(params && params.id, roleInfo.kungfuId);
  const kungfuInfo = ensureKungfuInfo(roleInfo, kungfuId);
  const level = (Array.isArray(kungfuInfo.skillLevel) ? kungfuInfo.skillLevel : []).map(() => 0);
  kungfuInfo.skillLevel = level;

  if (kungfuId === toSafeInt(roleInfo.kungfuId, 4)) {
    roleInfo.kungfuSkills = [];
  }

  await playerService.savePlayer(session.userId, player);
  return { tag: 3104, msgUid, data: { result: 0, id: kungfuId, level } };
}

// 领取境界奖励 (tag:3105)
async function handleClaimStageReward(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3105, msgUid, data: { result: -1, rewardedStage: 0, rewards: [] } };

  const roleInfo = ensureRoleInfo(player);
  const currentRewarded = toSafeInt(roleInfo.rewardedStage, 0);
  const claimStage = currentRewarded + 1;
  if (claimStage > toSafeInt(roleInfo.stage, 1)) {
    return { tag: 3105, msgUid, data: { result: -1, rewardedStage: currentRewarded, rewards: [] } };
  }

  const stageCfg = config.get('RoleStageConfig') || {};
  const cfg = stageCfg[claimStage];
  const rewards = Array.isArray(cfg && cfg.rewards) ? cfg.rewards : [];
  addRewards(player, rewards);
  roleInfo.rewardedStage = claimStage;

  const rewardSync = rewards.length > 0 ? buildRewardItemSync(player, rewards) : null;
  await playerService.savePlayer(session.userId, player);
  if (rewardSync) {
    return [
      { tag: 1202, msgUid: 0, data: rewardSync },
      { tag: 3105, msgUid, data: { result: 0, rewardedStage: roleInfo.rewardedStage, rewards } },
    ];
  }
  return { tag: 3105, msgUid, data: { result: 0, rewardedStage: roleInfo.rewardedStage, rewards } };
}

// 境界突破 (tag:600)
async function handleStageBreak(params = {}, session, msgUid) {
  if (isShareRequest(params)) {
    return handleShareData(params, session, msgUid);
  }
  const player = session.player;
  if (!player) return { tag: 600, msgUid, data: { result: -1 } };

  player.roleInfo = player.roleInfo || { kungfuSkills: [], stageId: 1 };
  const stageCfg = config.get('RoleStageConfig');
  const curStage = player.roleInfo.stageId || 1;
  const nextStage = curStage + 1;
  const nextCfg = stageCfg ? stageCfg[nextStage] : null;

  if (!nextCfg) return { tag: 600, msgUid, data: { result: -1, msg: 'max stage reached' } };

  const successRate = nextCfg.successRate / 10000;
  const success = Math.random() < successRate;

  if (success) {
    player.roleInfo.stageId = nextStage;
    player.roleInfo.stage = nextStage;
    resetRealmBagelConsume(player);
    if (nextCfg.rewards && nextCfg.rewards.length > 0) {
      nextCfg.rewards.forEach((r) => addRewardToPlayer(player, r.id, r.count));
    }
    refreshUpgradeRelatedTasks(player);
    const rewardSync = nextCfg.rewards && nextCfg.rewards.length > 0
      ? buildRewardItemSync(player, nextCfg.rewards)
      : null;
    await playerService.savePlayer(session.userId, player);
    const taskUpdates = buildRealmBreakthroughTaskPackets(player, 0);
    const response = {
      tag: 600, msgUid,
      data: {
        result: 0, success: true, stageId: nextStage, stageName: nextCfg.name,
        levelMax: nextCfg.levelMax, attrBonus: nextCfg.attr, rewards: nextCfg.rewards || [],
      },
    };

    if (rewardSync) {
      return [
        { tag: 1202, msgUid: 0, data: rewardSync },
        ...taskUpdates,
        response,
      ];
    }

    return taskUpdates.length > 0 ? [...taskUpdates, response] : response;
  }

  refreshUpgradeRelatedTasks(player);
  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 600, msgUid,
    data: { result: 0, success: false, stageId: curStage, msg: 'breakthrough failed' },
  };
  const taskUpdates = buildRealmBreakthroughTaskPackets(player, 0);
  return taskUpdates.length > 0 ? [...taskUpdates, response] : response;
}

// 宝箱升级 (tag:502)
async function handleBoxUpgrade(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 502, msgUid, data: { result: -1 } };

  player.boxInfo = player.boxInfo || { level: 1, exp: 0, tier: 1, summon: 0 };
  const boxCfg = config.get('BoxConfig');
  const curBox = boxCfg ? boxCfg[player.boxInfo.level] : null;
  const cost = curBox && curBox.levelUpCost ? curBox.levelUpCost[0] : 100;

  player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
  if ((player.currencies.gold || 0) < cost) {
    return { tag: 502, msgUid, data: { result: -1, msg: 'not enough gold' } };
  }

  player.currencies.gold -= cost;
  player.boxInfo.level++;
  refreshMainTaskProgress(player);
  await playerService.savePlayer(session.userId, player);

  const response = {
    tag: 502, msgUid,
    data: { result: 0, level: player.boxInfo.level, tier: player.boxInfo.tier, cost, currencies: player.currencies },
  };
  const taskUpdates = buildTaskUpdatePacketsSafe(player);
  return taskUpdates.length > 0 ? [...taskUpdates, response] : response;
}

// 系统解锁 (tag:7000)
async function handleSystemUnlock(_params, session, msgUid) {
  const player = session.player;
  await refreshSystemUnlockInfoCached(player, session);
  const info = (player && player.systemUnlockInfo) || {};
  const unlockedSystem = normalizeIdList(Array.isArray(info.unlockedSystem)
    ? info.unlockedSystem
    : (Array.isArray(info.unlocked) ? info.unlocked : []));
  const rewardedSystem = normalizeIdList(info.rewardedSystem);
  const settings = (info.settings && typeof info.settings === 'object') ? info.settings : {};
  const guideStep = Number(info.guideStep || 0);
  const seenNewFeatures = normalizeIdList(settings.seenNewFeatures);
  settings.seenNewFeatures = seenNewFeatures;
  // pendingNewFeatures: only features that have NOT yet been shown to the client.
  // The client should show popups ONLY for these IDs, then call tag 10002
  // with { seenNewFeature: id } to acknowledge each one.
  const pendingNewFeatures = unlockedSystem.filter((id) => !seenNewFeatures.includes(id));
  const dedupPendingNewFeatures = pendingNewFeatures.filter((id, idx, arr) => arr.indexOf(id) === idx);
  if (session && session.player && session.userId && dedupPendingNewFeatures.length > 0) {
    markNewFeaturesSeen(session.player, dedupPendingNewFeatures);
    await playerService.savePlayer(session.userId, session.player);
  }
  return {
    tag: 7000, msgUid,
    data: {
      unlockedSystem,
      rewardedSystem,
      settings,
      guideStep,
      seenNewFeatures,
      pendingNewFeatures: dedupPendingNewFeatures,
    },
  };
}

// Query unlock state by id (tag:10001)
async function handleSendSystemUnlock(params, session, msgUid) {
  const player = (session && session.player) || {};
  // tag=10001 is queried repeatedly during login and scene transitions.
  // Reuse the short session cache just like tag=7000 instead of rescanning
  // the complete SystemConfig on every request.
  const changed = await refreshSystemUnlockInfoCached(player, session);
  const info = player.systemUnlockInfo || {};
  const unlockedSystem = normalizeIdList(Array.isArray(info.unlockedSystem)
    ? info.unlockedSystem
    : (Array.isArray(info.unlocked) ? info.unlocked : []));
  const rewardedSystem = normalizeIdList(info.rewardedSystem);
  const settings = (info.settings && typeof info.settings === 'object') ? info.settings : {};
  const guideStep = Number(info.guideStep || 0);

  const seenNewFeatures = normalizeIdList(settings.seenNewFeatures);
  settings.seenNewFeatures = seenNewFeatures;
  const pendingNewFeatures = unlockedSystem.filter((id) => !seenNewFeatures.includes(id));
  const dedupPendingNewFeatures = pendingNewFeatures.filter((id, idx, arr) => arr.indexOf(id) === idx);

  const id = Number(params && params.id) || 0;
  const unlocked = id > 0 && unlockedSystem.includes(id) ? 1 : 0;
  const shouldAnnounce = unlocked === 1 && !seenNewFeatures.includes(id);

  if (session && session.player && session.userId && shouldAnnounce) {
    markNewFeaturesSeen(session.player, [id]);
    scheduleSessionSave(session, '10001');
  } else if (changed && session && session.player && session.userId) {
    scheduleSessionSave(session, '10001-refresh');
  }

  return {
    tag: 10001,
    msgUid,
    data: {
      result: shouldAnnounce ? 0 : -1,
      id,
      unlocked,
      unlockedSystem,
      rewardedSystem,
      settings,
      guideStep,
      seenNewFeatures,
      pendingNewFeatures,
    },
  };
}

// Persist simple client settings (tag:10002)
async function handleSetSetting(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 10002, msgUid, data: { result: -1 } };

  player.systemUnlockInfo = player.systemUnlockInfo || {};
  player.systemUnlockInfo.settings = player.systemUnlockInfo.settings || {};
  const settings = player.systemUnlockInfo.settings;

  // Special handling: seenNewFeature = <id> appends to seenNewFeatures array
  // The client should call this after showing a "新功能开启" animation to mark it as seen.
  if (params && params.seenNewFeature != null) {
    settings.seenNewFeatures = normalizeIdList(settings.seenNewFeatures);
    const featureId = Number(params.seenNewFeature);
    if (Number.isFinite(featureId) && featureId > 0 && !settings.seenNewFeatures.includes(featureId)) {
      settings.seenNewFeatures.push(featureId);
      settings.seenNewFeatures = normalizeIdList(settings.seenNewFeatures);
    }
  }

  const key = params && (params.id || params.key || params.type);
  const value = params && (params.value !== undefined ? params.value : params.param);
  if (key !== undefined && key !== null && key !== 'seenNewFeature') {
    settings[String(key)] = value;
  } else if (params && typeof params === 'object') {
    Object.keys(params).forEach((k) => {
      if (k === 'id' || k === 'key' || k === 'type' || k === 'value' || k === 'param' || k === 'seenNewFeature') return;
      settings[k] = params[k];
    });
  }

  scheduleSessionSave(session, '10002');
  return {
    tag: 10002,
    msgUid,
    data: { result: 0, settings },
  };
}

module.exports = {
  ensureRoleInfo,
  refreshSystemUnlockInfo,
  markNewFeaturesSeen,
  handleFormationEquip,
  handleFormationUpgrade, handleFormationUpgradeGrade, handleFormationEnchant,
  handleKungfuSwitch, handleSkillUpgrade, handleKungfuSkillSequenceChange,
  handleStageUpgrade, handleResetKungfuSkill, handleClaimStageReward,
  handleStageBreak, handleBoxUpgrade, handleSystemUnlock,
  handleSendSystemUnlock, handleSetSetting,
  // Contract probes used by scripts/test-core-gameplay-contract.js.
  normalizeKungfuInfoRow, ensureKungfuInfo, resolveKungfuSkillId,
};
