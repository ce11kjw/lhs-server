/**
 * Build normalized player payload for tag:500.
 */

const configService = require('../services/ConfigService');
const battle = require('../services/BattleService');
const { ensureEquipInfo } = require('../services/EquipService');
const { ensureFormationInfo } = require('../services/FormationService');
const { ensureRoleAppearance, getPlayerFashionMap } = require('../services/RoleAppearanceService');
const { ensureArtifactInfo } = require('./artifact');
const { ensureAlchemyInfo } = require('./alchemy');
const {
  ensureSpiritInfo,
  ensureLegacySpiritInfo,
  syncSpiritInfoFromCurrentPreset,
  syncModernSpiritProgressFromAttrs,
} = require('./spirit');
const { buildClientBoxInfo } = require('../utils/boxTiming');
const { nowNs, recordTaskNormalizeNs } = require('../services/TaskPerfService');

const DEFAULT_TASK_STATUS = 10;
const DEFAULT_FISH_ID = 5011;
const DEFAULT_FISH_ORDER_IDS = [80001, 80015, 80046];
const DEFAULT_MAIN_FISH_SCENE_IDS = new Set([1, 2, 3, 4, 5, 6, 7]);
const DEFAULT_FISH_ORDER_CONFIG = {
  80001: { id: 80001, type: 43, fishType: 2, count: 5, star: 1 },
  80015: { id: 80015, type: 41, fishType: 1, count: 1, star: 1 },
  80046: { id: 80046, type: 42, fishType: 5011, count: 2, star: 3 },
};
const DEFAULT_FISH_CONFIG = {
  [DEFAULT_FISH_ID]: { id: DEFAULT_FISH_ID, type: 1, quality: 2, exp: 10, minAttrs: [[1, 1000, 1]] },
};
const FISH_BASKET_TYPE_MIN = 1;
const FISH_BASKET_TYPE_MAX = 10;
const ACTIVITY_TASK_MARK = 1 << 30;

function getGameDayKey(ts = Date.now()) {
  const date = new Date(ts + 8 * 60 * 60 * 1000);
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeIdList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((id) => Math.max(0, toFiniteNumber(id, 0)))
    .filter((id, index, arr) => id > 0 && arr.indexOf(id) === index)
    .sort((a, b) => a - b);
}

function getUnlockedSystemSet(player = {}) {
  const info = ensurePlainObject(player && player.systemUnlockInfo);
  return new Set(normalizeIdList(info.unlockedSystem));
}

function isSideTaskSystemOpen(taskCfg = {}, player = {}) {
  const guideValue = Math.max(0, toFiniteNumber(taskCfg.guideValue, 0));
  const guideValueATest = Math.max(0, toFiniteNumber(taskCfg.guideValueATest, 0));
  if (guideValue <= 0 && guideValueATest <= 0) return true;

  const unlocked = getUnlockedSystemSet(player);
  return (guideValue > 0 && unlocked.has(guideValue))
    || (guideValueATest > 0 && unlocked.has(guideValueATest));
}

function ensureMountInfoSafe(player = {}) {
  try {
    const mount = require('./mount');
    if (mount && typeof mount.ensureMountInfo === 'function') {
      return mount.ensureMountInfo(player);
    }
  } catch (_err) {}
  return ensurePlainObject(player.swordInfo);
}

function normalizeMountSkillList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => ({
      id: Math.max(0, toFiniteNumber(row && row.id, 0)),
      quality: Math.max(0, toFiniteNumber(row && row.quality, 0)),
      level: Math.max(1, toFiniteNumber(row && row.level, 1)),
    }))
    .filter((row) => row.id > 0);
}

function normalizeMountEntry(row = {}) {
  const normalized = row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : {};
  const skills = Array.isArray(normalized.skills) ? normalized.skills : normalized.passiveSkills;
  const normalizedSkills = normalizeMountSkillList(skills);
  return {
    ...normalized,
    uid: Math.max(0, toFiniteNumber(normalized.uid, 0)),
    id: Math.max(0, toFiniteNumber(normalized.id, 0)),
    level: Math.max(1, toFiniteNumber(normalized.level, 1)),
    star: Math.max(0, toFiniteNumber(normalized.star, 0)),
    lock: !!normalized.lock,
    attrs: ensurePlainObject(normalized.attrs),
    skills: normalizedSkills,
    passiveSkills: normalizedSkills,
  };
}

function normalizeMountInfoPayload(player = {}) {
  const mountInfo = ensurePlainObject(ensureMountInfoSafe(player));
  const normalizedData = Array.isArray(mountInfo.data)
    ? mountInfo.data.map((row) => normalizeMountEntry(row)).filter((row) => row.uid > 0 && row.id > 0)
    : [];
  const normalizedOptionalSwords = Array.isArray(mountInfo.optionalSwords)
    ? mountInfo.optionalSwords
      .map((row) => normalizeMountEntry(row))
      .filter((row) => row.uid > 0 && row.id > 0)
    : [];

  let equippedUid = toFiniteNumber(mountInfo.equippedUid, 0);
  if (equippedUid > 0 && !normalizedData.some((row) => row.uid === equippedUid)) {
    equippedUid = 0;
  }

  return {
    maxlayer: Math.max(0, toFiniteNumber(mountInfo.maxlayer, 0)),
    curlayer: Math.max(0, toFiniteNumber(mountInfo.curlayer, 0)),
    slotlist: Array.isArray(mountInfo.slotlist) ? mountInfo.slotlist : [],
    skills: Array.isArray(mountInfo.skills) ? mountInfo.skills : [],
    skillCount: Math.max(0, toFiniteNumber(mountInfo.skillCount, 0)),
    autoSelect: Math.max(0, toFiniteNumber(mountInfo.autoSelect, 0)),
    autoPriority: Array.isArray(mountInfo.autoPriority) ? mountInfo.autoPriority : [],
    score: Math.max(0, toFiniteNumber(mountInfo.score, 0)),
    challengelist: Array.isArray(mountInfo.challengelist) ? mountInfo.challengelist : [],
    refreshtime: Math.max(0, toFiniteNumber(mountInfo.refreshtime, 0)),
    loglist: Array.isArray(mountInfo.loglist) ? mountInfo.loglist : [],
    rankInfo: ensurePlainObject(mountInfo.rankInfo),
    unlockedSwords: normalizeIdList(mountInfo.unlockedSwords),
    gridCount: Math.max(1, toFiniteNumber(mountInfo.gridCount, 6)),
    equippedUid,
    data: normalizedData,
    optionalSwords: normalizedOptionalSwords,
    wishId: Math.max(0, toFiniteNumber(mountInfo.wishId, 0)),
    wishCounter: Math.max(0, toFiniteNumber(mountInfo.wishCounter, 0)),
    bestCounter: Math.max(0, toFiniteNumber(mountInfo.bestCounter, 0)),
    adFreeCounter: Math.max(0, toFiniteNumber(mountInfo.adFreeCounter, 0)),
    summonedIds: Array.isArray(mountInfo.summonedIds)
      ? mountInfo.summonedIds.map((id) => Math.max(0, toFiniteNumber(id, 0))).filter((id) => id > 0)
      : [],
    skinId: Math.max(0, toFiniteNumber(mountInfo.skinId, 0)),
    swordBond: Array.isArray(mountInfo.swordBond) ? mountInfo.swordBond : [],
  };
}

function ensurePlainObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function ensureHomelandInfoSafe(player = {}) {
  try {
    // Lazy require avoids coupling the login payload builder to homeland handlers
    // during test bootstrap and partial module initialization.
    // eslint-disable-next-line global-require
    const homeland = require('./homeland');
    if (homeland && typeof homeland.ensureHomelandInfo === 'function') {
      return homeland.ensureHomelandInfo(player);
    }
  } catch (_err) {}
  return ensurePlainObject(player.homelandInfo);
}

function buildClientHomelandInfo(player = {}) {
  const info = ensureHomelandInfoSafe(player);
  const collectMap = ensurePlainObject(info.collectMap);
  const collects = Object.keys(collectMap)
    .map((key) => ensurePlainObject(collectMap[key]))
    .filter((row) => toSafeInt(row.id, 0) > 0)
    .map((row) => ({
      id: Math.max(1, toSafeInt(row.id, 1)),
      count: Math.max(0, toSafeInt(row.count, 0)),
      upgradeTime: Math.max(0, toSafeInt(row.upgradeTime, 0)),
      state: Math.max(0, toSafeInt(row.state, 0)),
      collectTime: Math.max(0, toSafeInt(row.collectTime, 0)),
    }))
    .sort((a, b) => a.id - b.id);

  return {
    ...info,
    lv: Math.max(1, toSafeInt(info.lv, 1)),
    areaLv: Math.max(1, toSafeInt(info.areaLv, 1)),
    mapId: Math.max(1, toSafeInt(info.mapId, 1)),
    layout: ensurePlainObject(info.layout),
    buildingLv: ensurePlainObject(info.buildingLv),
    collectMap,
    collects,
    fetters: normalizeIdList(info.fetters),
    likeCount: Math.max(0, toSafeInt(info.likeCount, 0)),
    dailyLike: Array.isArray(info.dailyLike) ? info.dailyLike.map((row) => String(row)).filter(Boolean) : [],
    likeRecord: {
      records: Array.isArray(info.likeRecord && info.likeRecord.records)
        ? info.likeRecord.records.filter((row) => row && typeof row === 'object')
        : [],
    },
    msgRecord: {
      leaveMsg: info.msgRecord && info.msgRecord.leaveMsg != null ? String(info.msgRecord.leaveMsg) : '',
      records: Array.isArray(info.msgRecord && info.msgRecord.records)
        ? info.msgRecord.records.filter((row) => row && typeof row === 'object')
        : [],
    },
    visitorMap: ensurePlainObject(info.visitorMap),
    exchangeRecords: Array.isArray(info.exchangeRecords)
      ? info.exchangeRecords.filter((row) => row && typeof row === 'object')
      : (Array.isArray(info.exchangeHistory) ? info.exchangeHistory.filter((row) => row && typeof row === 'object') : []),
    exchangeHistory: Array.isArray(info.exchangeHistory)
      ? info.exchangeHistory.filter((row) => row && typeof row === 'object')
      : [],
  };
}

function toSafeInt(value, fallback = 0) {
  return Math.floor(toFiniteNumber(value, fallback));
}

function getFishConfigMap() {
  const raw = ensurePlainObject(configService.get('FishConfig'));
  return Object.keys(raw).length > 0 ? raw : DEFAULT_FISH_CONFIG;
}

function getFishConfigById(fishId) {
  const id = Math.max(0, toSafeInt(fishId, 0));
  const cfgMap = getFishConfigMap();
  return ensurePlainObject(cfgMap[id] || cfgMap[String(id)]);
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
  if (!Array.isArray(skills)) return [];
  return skills
    .map((row) => Math.max(0, toSafeInt(row && typeof row === 'object' ? row.id : row, 0)))
    .filter((id, index, arr) => id > 0 && arr.indexOf(id) === index);
}

function normalizeExistingFishAttrs(attrs) {
  if (!Array.isArray(attrs)) return [];
  return attrs
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

function buildFallbackFishAttrs(fishId, multi) {
  const cfg = getFishConfigById(fishId);
  const source = Array.isArray(cfg.minAttrs) && cfg.minAttrs.length > 0
    ? cfg.minAttrs
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

function normalizeFishAttrs(attrs, fishId, multi) {
  const normalized = normalizeExistingFishAttrs(attrs);
  return normalized.length > 0 ? normalized : buildFallbackFishAttrs(fishId, multi);
}

function normalizeFishEntity(row, fallbackUid = 0) {
  const item = ensurePlainObject(row);
  let id = Math.max(0, toSafeInt(item.id, DEFAULT_FISH_ID));
  if (!isClientFishId(id)) id = DEFAULT_FISH_ID;
  const cfg = getFishConfigById(id);
  const multi = Math.max(1, toSafeInt(item.multi != null ? item.multi : item.value, 10000));
  return {
    uid: Math.max(1, toSafeInt(item.uid, fallbackUid || 1)),
    id,
    type: normalizeFishBasketType(item.type, toSafeInt(cfg.type, 1)),
    quality: Math.max(1, toSafeInt(item.quality, toSafeInt(cfg.quality, 1))),
    multi,
    attrs: normalizeFishAttrs(item.attrs, id, multi),
    skills: normalizeFishSkills(item.skills),
    lock: item.lock ? 1 : 0,
    dead: item.dead ? 1 : 0,
  };
}

function normalizeFishEntityList(rows, fishInfo) {
  let nextUid = Math.max(1, toSafeInt(fishInfo.fishUidSeq, 1000));
  const used = new Set();
  const list = Array.isArray(rows) ? rows : [];
  const normalized = [];
  list.forEach((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !isClientFishId(row.id)) return;
    const entity = normalizeFishEntity(row, nextUid);
    nextUid = Math.max(nextUid + 1, entity.uid + 1);
    if (used.has(entity.uid)) {
      entity.uid = nextUid;
      nextUid += 1;
    }
    used.add(entity.uid);
    normalized.push(entity);
  });
  fishInfo.fishUidSeq = Math.max(nextUid, toSafeInt(fishInfo.fishUidSeq, 1000));
  return normalized;
}

function normalizeFishSlots(slots, fishInfo) {
  const normalized = {};
  const source = ensurePlainObject(slots);
  let nextUid = Math.max(1, toSafeInt(fishInfo.fishUidSeq, 1000));
  Object.keys(source).forEach((typeKey) => {
    const row = ensurePlainObject(source[typeKey]);
    const type = normalizeFishBasketType(row.type, toSafeInt(typeKey, 1));
    const id = Math.max(0, toSafeInt(row.id, 0));
    if (!isClientFishId(id)) return;
    const entity = normalizeFishEntity({ ...row, type }, toSafeInt(row.uid, nextUid));
    nextUid = Math.max(nextUid + 1, entity.uid + 1);
    normalized[String(type)] = entity;
  });
  fishInfo.fishUidSeq = Math.max(nextUid, toSafeInt(fishInfo.fishUidSeq, 1000));
  return normalized;
}

function normalizeFishSoulSlots(slots) {
  const normalized = {};
  const source = ensurePlainObject(slots);
  Object.keys(source).forEach((typeKey) => {
    normalized[typeKey] = Array.isArray(source[typeKey]) ? source[typeKey] : [];
  });
  return normalized;
}

function getFishOrderConfigMap() {
  const raw = ensurePlainObject(configService.get('FishOrderConfig'));
  return Object.keys(raw).length > 0 ? raw : DEFAULT_FISH_ORDER_CONFIG;
}

function getFishOrderConfigById(orderId, fallbackIndex = 0) {
  const safeOrderId = Math.max(1, toFiniteNumber(orderId, 0));
  const fallbackId = DEFAULT_FISH_ORDER_IDS[Math.max(0, fallbackIndex) % DEFAULT_FISH_ORDER_IDS.length];
  const cfgMap = getFishOrderConfigMap();
  const cfg = ensurePlainObject(
    cfgMap[safeOrderId]
      || cfgMap[String(safeOrderId)]
      || cfgMap[fallbackId]
      || cfgMap[String(fallbackId)]
      || DEFAULT_FISH_ORDER_CONFIG[fallbackId]
  );

  return {
    id: Math.max(1, toFiniteNumber(cfg.id, fallbackId)),
    count: Math.max(1, toFiniteNumber(cfg.count, 1)),
  };
}

function normalizeFishSceneId(sceneId, fallback = 1) {
  const id = Math.max(0, toFiniteNumber(sceneId, 0));
  if (DEFAULT_MAIN_FISH_SCENE_IDS.has(id)) return id;
  const fallbackId = Math.max(1, toFiniteNumber(fallback, 1));
  return DEFAULT_MAIN_FISH_SCENE_IDS.has(fallbackId) ? fallbackId : 1;
}

function normalizeConfigBackedId(configName, id, fallback) {
  const cfgMap = ensurePlainObject(configService.get(configName));
  const safeId = Math.max(0, toSafeInt(id, 0));
  if (safeId > 0 && (cfgMap[safeId] || cfgMap[String(safeId)])) return safeId;
  const fallbackId = Math.max(0, toSafeInt(fallback, 0));
  if (fallbackId > 0 && (cfgMap[fallbackId] || cfgMap[String(fallbackId)])) return fallbackId;
  const first = Object.keys(cfgMap).map((key) => toSafeInt(key, 0)).filter((key) => key > 0).sort((a, b) => a - b)[0];
  return first || fallbackId || safeId;
}

function normalizeFishOrders(orders) {
  const normalized = Array.isArray(orders) ? orders.slice(0, 3) : [];
  while (normalized.length < 3) {
    const index = normalized.length;
    normalized.push({ id: DEFAULT_FISH_ORDER_IDS[index], progress: 0, received: false });
  }

  return normalized.map((row, index) => {
    const fallbackId = DEFAULT_FISH_ORDER_IDS[index % DEFAULT_FISH_ORDER_IDS.length];
    const item = ensurePlainObject(row);
    const cfg = getFishOrderConfigById(item.id || fallbackId, index);
    return {
      id: cfg.id,
      progress: Math.max(0, Math.min(toFiniteNumber(item.progress, 0), cfg.count)),
      received: !!item.received,
    };
  });
}

function clonePlayerSnapshot(player = {}) {
  if (!player || typeof player !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(player));
  } catch (_err) {
    return { ...player };
  }
}

function ensureRaidInfo(player = {}) {
  player.raidInfo = ensurePlainObject(player.raidInfo);
  const raidInfo = player.raidInfo;
  const chapterCfgMap = configService.get('ChapterConfig') || {};

  const claimedChapters = Array.isArray(raidInfo.claimedChapters)
    ? raidInfo.claimedChapters
        .map((id) => Math.max(0, toFiniteNumber(id, 0)))
        .filter((id) => id > 0)
    : [];
  raidInfo.claimedChapters = claimedChapters;

  const existingChapterInfo = ensurePlainObject(raidInfo.chapterInfo);
  const currentLevel = Math.max(1, toFiniteNumber(
    raidInfo.level,
    toFiniteNumber(existingChapterInfo.id, 1),
  ));
  let resolvedChapter = Math.max(1, toFiniteNumber(raidInfo.chapter, 1));

  Object.keys(chapterCfgMap).some((chapterKey) => {
    const row = chapterCfgMap[chapterKey];
    const levelList = Array.isArray(row && row.levelList) ? row.levelList : [];
    if (!levelList.includes(currentLevel)) return false;
    resolvedChapter = Math.max(1, toFiniteNumber(chapterKey, resolvedChapter));
    return true;
  });

  raidInfo.chapter = resolvedChapter;
  raidInfo.level = currentLevel;
  if (raidInfo.hangUpChapter == null) raidInfo.hangUpChapter = resolvedChapter;
  raidInfo.hangUpChapter = Math.max(1, toFiniteNumber(raidInfo.hangUpChapter, resolvedChapter));

  const chapterInfo = existingChapterInfo;
  // Online uses chapterInfo.id as the current global mainline level id.
  chapterInfo.id = currentLevel;
  chapterInfo.rewardChapter = Math.max(
    0,
    toFiniteNumber(
      chapterInfo.rewardChapter,
      claimedChapters.length > 0 ? Math.max(...claimedChapters) : 0,
    ),
  );

  raidInfo.chapterInfo = chapterInfo;
  raidInfo.rewardChapter = chapterInfo.rewardChapter;
  if (raidInfo.hangUpTime == null) raidInfo.hangUpTime = 0;

  return raidInfo;
}

function ensureRoleGenderSelection(roleInfo = {}) {
  const roleGenderCfg = configService.get('RoleGenderConfig') || {};

  let kungfuId = Math.max(0, toFiniteNumber(roleInfo.kungfuId, 4));
  let kungfuGenderCfg = roleGenderCfg[String(kungfuId)];

  if (!kungfuGenderCfg || typeof kungfuGenderCfg !== 'object' || Array.isArray(kungfuGenderCfg)) {
    kungfuId = 4;
    kungfuGenderCfg = roleGenderCfg[String(kungfuId)];
  }

  if (!kungfuGenderCfg || typeof kungfuGenderCfg !== 'object' || Array.isArray(kungfuGenderCfg)) {
    const fallbackKungfuKey = Object.keys(roleGenderCfg).find((key) => {
      const row = roleGenderCfg[key];
      return row && typeof row === 'object' && !Array.isArray(row);
    });
    kungfuId = Math.max(0, toFiniteNumber(fallbackKungfuKey, 4));
    kungfuGenderCfg = fallbackKungfuKey ? roleGenderCfg[fallbackKungfuKey] : {};
  }

  const availableSubJobs = Object.keys(kungfuGenderCfg || {})
    .map((key) => toFiniteNumber(key, -1))
    .filter((subJob) => subJob >= 0)
    .sort((a, b) => a - b);

  let subJob = Math.max(0, toFiniteNumber(roleInfo.subJob, 0));
  if (!availableSubJobs.includes(subJob)) {
    subJob = availableSubJobs.includes(0)
      ? 0
      : (availableSubJobs.length > 0 ? availableSubJobs[0] : 0);
  }

  roleInfo.kungfuId = kungfuId;
  roleInfo.subJob = subJob;
}

function normalizeTaskInfo(taskInfoInput = {}, roleInfoInput = {}, playerInput = {}) {
  const perfStartNs = nowNs();
  const rawTaskInfo = (
    taskInfoInput
    && typeof taskInfoInput === 'object'
    && !Array.isArray(taskInfoInput)
  ) ? taskInfoInput : {};

  const taskInfo = { ...rawTaskInfo };
  if (!taskInfo.tasks || typeof taskInfo.tasks !== 'object' || Array.isArray(taskInfo.tasks)) {
    taskInfo.tasks = {};
  }
  if (!taskInfo.tasksMap || typeof taskInfo.tasksMap !== 'object' || Array.isArray(taskInfo.tasksMap)) {
    taskInfo.tasksMap = {};
  }
  Object.keys(taskInfo.tasksMap).forEach((typeKey) => {
    const list = taskInfo.tasksMap[typeKey];
    if (!Array.isArray(list)) {
      delete taskInfo.tasksMap[typeKey];
      return;
    }
    taskInfo.tasksMap[typeKey] = list.filter((item) => item && typeof item === 'object');
  });

  const taskCfg = configService.get('TaskConfig') || {};
  const activityTaskConfigMaps = [
    configService.get('Activity43TaskConfig') || {},
    configService.get('Activity44TaskConfig') || {},
  ];
  const activeActivityIds = new Set(
    (Array.isArray(ensurePlainObject(playerInput.activityInfo).datas)
      ? ensurePlainObject(playerInput.activityInfo).datas
      : [])
      .map((row) => toFiniteNumber(row && row.id, 0))
      .filter((id) => id > 0)
  );
  const stageCfgMap = configService.get('RoleStageConfig') || {};
  const boxTierCfgMap = configService.get('BoxTierConfig') || {};
  const byId = new Map();

  function getPayloadTaskProgress(cfg = {}) {
    const activeId = toFiniteNumber(cfg.activeId, 0);
    const player = ensurePlainObject(playerInput);
    const boxInfo = ensurePlainObject(player.boxInfo);
    const raidInfo = ensurePlainObject(player.raidInfo);
    const roleInfo = ensurePlainObject(player.roleInfo);
    const otherAttr = ensurePlainObject(player.other_attr_info);
    const counter = ensurePlainObject(otherAttr.mainTaskProgress);
    if (activeId === 6) return Math.max(1, toFiniteNumber(player.level, 1));
    if (activeId === 9) return Math.max(1, toFiniteNumber(boxInfo.level, 1));
    if (activeId === 39) {
      const demonBossInfo = ensurePlainObject(raidInfo.demonBossInfo);
      return Math.max(
        0,
        toFiniteNumber(counter.dungeonBossMaxMapId, 0),
        toFiniteNumber(demonBossInfo.stage, 0),
        toFiniteNumber(raidInfo.bossStage, 0),
        toFiniteNumber(roleInfo.stage, toFiniteNumber(roleInfo.stageId, 1)) - 1,
      );
    }
    return null;
  }

  function mergeTask(taskId, source = {}) {
    const cfg = taskCfg[taskId] || taskCfg[String(taskId)] || {};
    const prev = byId.get(taskId) || {};
    const taskType = toFiniteNumber(
      source.type != null ? source.type : (prev.type != null ? prev.type : cfg.type),
      1
    );
    const status = toFiniteNumber(
      source.status != null ? source.status : (prev.status != null ? prev.status : DEFAULT_TASK_STATUS),
      DEFAULT_TASK_STATUS
    );
    const target = toFiniteNumber(
      source.target != null ? source.target : (prev.target != null ? prev.target : cfg.taskValue1),
      0
    );
    let progress = toFiniteNumber(
      source.progress != null ? source.progress : prev.progress,
      0
    );
    if (status >= 20 && target > 0 && progress < target) {
      progress = target;
    }

    byId.set(taskId, {
      id: taskId,
      type: taskType,
      status,
      progress,
      target,
      ...(source.progressBase != null ? { progressBase: Math.max(0, toFiniteNumber(source.progressBase, 0)) } : {}),
    });
  }

  Object.keys(taskInfo.tasksMap).forEach((typeKey) => {
    const list = taskInfo.tasksMap[typeKey];
    if (!Array.isArray(list)) return;
    list.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const taskId = toFiniteNumber(item.id != null ? item.id : item.taskId, 0);
      if (taskId <= 0) return;
      mergeTask(taskId, item);
    });
  });

  Object.keys(taskInfo.tasks).forEach((taskIdKey) => {
    const taskId = toFiniteNumber(taskIdKey, 0);
    if (taskId <= 0) return;
    const state = taskInfo.tasks[taskIdKey];
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      mergeTask(taskId, state);
    } else {
      mergeTask(taskId, { status: state });
    }
  });

  // Type=9 tasks are event/system side tasks. The official client receives
  // them only after the corresponding system is unlocked; otherwise they
  // take priority over the main task and immediately start a guide for a
  // locked view (task 90002 is the "灵舟争渡战斗1次" example).
  for (const [taskId, task] of byId.entries()) {
    if (toFiniteNumber(task && task.type, 0) !== 9) continue;
    const cfg = taskCfg[taskId] || taskCfg[String(taskId)] || {};
    if (!isSideTaskSystemOpen(cfg, playerInput)) byId.delete(taskId);
  }

  // The current H5 reads all daily tasks from type=2. Older player snapshots
  // did not contain them, so the panel rendered an empty list. Rebuild the
  // daily set once per GMT+8 day and preserve a baseline for progress counters.
  const gameDayKey = getGameDayKey();
  const previousDailyTaskDayKey = Math.max(0, toFiniteNumber(taskInfo.dailyTaskDayKey, 0));
  if (previousDailyTaskDayKey !== gameDayKey) {
    for (const [taskId, task] of byId.entries()) {
      const cfg = taskCfg[taskId] || taskCfg[String(taskId)] || {};
      if (toFiniteNumber(cfg.updateCycle, 0) === 1 || toFiniteNumber(task && task.type, 0) === 2) {
        byId.delete(taskId);
      }
    }
    taskInfo.dailyRewardRecords = [];
    taskInfo.dailyTaskDayKey = gameDayKey;
  }

  Object.keys(taskCfg).forEach((taskIdKey) => {
    const cfg = taskCfg[taskIdKey] || {};
    const taskId = toFiniteNumber(cfg.id != null ? cfg.id : taskIdKey, 0);
    if (taskId <= 0 || toFiniteNumber(cfg.type, 0) !== 2 || byId.has(taskId)) return;
    mergeTask(taskId, {
      id: taskId,
      type: 2,
      status: DEFAULT_TASK_STATUS,
      progress: 0,
      target: Math.max(0, toFiniteNumber(cfg.taskValue1, 0)),
    });
  });

  // Type=9 is the H5 side-task family. Do not synthesize every configured
  // root for a fresh role: the client treats any active type=9 task as a
  // higher-priority subtask and immediately starts its guide. Roots are
  // created by feature handlers; normalization only repairs a missing next
  // task after an already-persisted/claimed predecessor.
  const sideTaskCfg = new Map();
  const sideTaskNextIds = new Set();
  Object.keys(taskCfg).forEach((taskIdKey) => {
    const cfg = taskCfg[taskIdKey] || {};
    const taskId = toFiniteNumber(cfg.id != null ? cfg.id : taskIdKey, 0);
    if (taskId <= 0 || toFiniteNumber(cfg.type, 0) !== 9) return;
    sideTaskCfg.set(taskId, cfg);
    const nextId = Math.max(0, toFiniteNumber(cfg.nextId, 0));
    if (nextId > 0) sideTaskNextIds.add(nextId);
  });
  const sideTaskRootIds = Array.from(sideTaskCfg.keys())
    .filter((taskId) => !sideTaskNextIds.has(taskId))
    .sort((a, b) => a - b);
  sideTaskRootIds.forEach((rootTaskId) => {
    const rootCfg = sideTaskCfg.get(rootTaskId) || {};
    if (!isSideTaskSystemOpen(rootCfg, playerInput)) return;
    const visited = new Set();
    let taskId = rootTaskId;
    while (taskId > 0 && sideTaskCfg.has(taskId) && !visited.has(taskId)) {
      visited.add(taskId);
      const cfg = sideTaskCfg.get(taskId) || {};
      if (!isSideTaskSystemOpen(cfg, playerInput)) break;
      const state = byId.get(taskId);
      if (!state) {
        // A missing root is normal for a fresh role. Only continue a chain
        // when a predecessor already exists in the persisted task state.
        break;
      }
      if (toFiniteNumber(state.status, DEFAULT_TASK_STATUS) < 30) break;
      taskId = Math.max(0, toFiniteNumber(cfg.nextId, 0));
    }
  });

  // Keep the configured root task instead of assuming a version-specific id.
  const hasMainTask = Array.from(byId.values()).some((task) => task.type === 1);
  if (!hasMainTask) {
    const mainTaskIds = Object.keys(taskCfg)
      .map((taskIdKey) => toFiniteNumber(taskIdKey, 0))
      .filter((taskId) => taskId > 0 && toFiniteNumber(taskCfg[taskId] && taskCfg[taskId].type, 0) === 1)
      .sort((a, b) => a - b);
    const nextIds = new Set(mainTaskIds
      .map((taskId) => toFiniteNumber(taskCfg[taskId] && taskCfg[taskId].nextId, 0))
      .filter((taskId) => taskId > 0));
    const firstMainTaskId = mainTaskIds.find((taskId) => !nextIds.has(taskId)) || mainTaskIds[0] || 0;
    if (firstMainTaskId > 0) {
      mergeTask(firstMainTaskId, {
        id: firstMainTaskId,
        type: 1,
        status: DEFAULT_TASK_STATUS,
        progress: 0,
      });
    }
  }

  activityTaskConfigMaps.forEach((activityTaskCfgMap) => {
    Object.keys(activityTaskCfgMap).forEach((activityIdKey) => {
      const activityId = toFiniteNumber(activityIdKey, 0);
      const taskRows = activityTaskCfgMap[activityIdKey] || activityTaskCfgMap[activityId] || {};
      if (!activeActivityIds.has(activityId)) return;
      if (activityId <= 0 || !taskRows || typeof taskRows !== 'object' || Array.isArray(taskRows)) return;
      Object.keys(taskRows).forEach((rowKey) => {
        const row = taskRows[rowKey] || {};
        const taskId = toFiniteNumber(row.taskId != null ? row.taskId : rowKey, 0);
        const cfg = taskCfg[taskId] || taskCfg[String(taskId)] || {};
        if (taskId <= 0 || !cfg.id) return;
        const current = byId.get(taskId) || {};
        mergeTask(taskId, {
          id: taskId,
          type: activityId | ACTIVITY_TASK_MARK,
          status: toFiniteNumber(current.status, DEFAULT_TASK_STATUS),
          progress: Math.max(0, toFiniteNumber(current.progress, 0)),
          target: Math.max(0, toFiniteNumber(cfg.taskValue1, 0)),
        });
      });
    });
  });

  // Realm panel reads current stage's taskGroup directly.
  const roleStage = toFiniteNumber(
    roleInfoInput.stage != null ? roleInfoInput.stage : roleInfoInput.stageId,
    1
  );
  const roleStageCfg = stageCfgMap[roleStage] || stageCfgMap[String(roleStage)];
  if (roleStageCfg && Array.isArray(roleStageCfg.taskGroup)) {
    roleStageCfg.taskGroup.forEach((taskIdRaw) => {
      const taskId = toFiniteNumber(taskIdRaw, 0);
      if (taskId > 0 && !byId.has(taskId)) {
        mergeTask(taskId, { id: taskId, status: DEFAULT_TASK_STATUS, progress: 0 });
      }
    });
  }

  // Drop-stage panel reads BoxTierConfig.task ids directly and expects each one in TaskModel.
  Object.keys(boxTierCfgMap).forEach((tierKey) => {
    const tierCfg = boxTierCfgMap[tierKey] || boxTierCfgMap[String(tierKey)] || {};
    const taskIds = Array.isArray(tierCfg.task) ? tierCfg.task : [];
    taskIds.forEach((taskIdRaw) => {
      const taskId = toFiniteNumber(taskIdRaw, 0);
      const cfg = taskCfg[taskId] || taskCfg[String(taskId)] || {};
      if (taskId <= 0 || !cfg.id) return;
      const target = Math.max(0, toFiniteNumber(cfg.taskValue1, 0));
      const current = byId.get(taskId) || {};
      const progressValue = getPayloadTaskProgress(cfg);
      const progress = Math.max(
        0,
        toFiniteNumber(current.progress, 0),
        progressValue == null ? 0 : toFiniteNumber(progressValue, 0),
      );
      const currentStatus = toFiniteNumber(current.status, DEFAULT_TASK_STATUS);
      const status = currentStatus >= 30
        ? currentStatus
        : (target > 0 && progress >= target ? 20 : DEFAULT_TASK_STATUS);
      mergeTask(taskId, {
        id: taskId,
        type: toFiniteNumber(cfg.type, 7),
        status,
        progress,
        target,
      });
    });
  });

  const rebuiltTasks = {};
  const rebuiltTasksMap = {};
  for (const task of byId.values()) {
    const typeKey = String(task.type);
    if (!rebuiltTasksMap[typeKey]) rebuiltTasksMap[typeKey] = [];
    rebuiltTasksMap[typeKey].push(task);
    rebuiltTasks[String(task.id)] = {
      id: task.id,
      type: task.type,
      status: task.status,
      progress: task.progress,
      target: task.target,
      ...(task.progressBase != null ? { progressBase: task.progressBase } : {}),
    };
  }

  Object.keys(rebuiltTasksMap).forEach((typeKey) => {
    rebuiltTasksMap[typeKey] = rebuiltTasksMap[typeKey]
      .filter((task) => task && typeof task === 'object' && toFiniteNumber(task.id, 0) > 0)
      .sort((a, b) => a.id - b.id);
  });

  taskInfo.tasks = rebuiltTasks;
  taskInfo.tasksMap = rebuiltTasksMap;
  if (!Array.isArray(taskInfo.dailyRewardRecords)) {
    taskInfo.dailyRewardRecords = [];
  }
  taskInfo.dailyTaskDayKey = Math.max(0, toFiniteNumber(taskInfo.dailyTaskDayKey, gameDayKey));

  recordTaskNormalizeNs(nowNs() - perfStartNs);
  return taskInfo;
}

function compactTaskInfoForClient(taskInfoInput = {}, roleInfoInput = {}, playerInput = {}) {
  const threshold = Math.max(
    0,
    toFiniteNumber(process.env.CLIENT_TASK_PAYLOAD_COMPACT_THRESHOLD, 160) || 160
  );
  const sourceTaskInfo = ensurePlainObject(taskInfoInput);
  const tasks = ensurePlainObject(sourceTaskInfo.tasks);
  const taskIds = Object.keys(tasks);
  if (threshold <= 0 || taskIds.length <= threshold) {
    return sourceTaskInfo;
  }

  const stageCfgMap = configService.get('RoleStageConfig') || {};
  const boxTierCfgMap = configService.get('BoxTierConfig') || {};
  const activityTaskConfigMaps = [
    configService.get('Activity43TaskConfig') || {},
    configService.get('Activity44TaskConfig') || {},
  ];
  const activeActivityIds = new Set(
    (Array.isArray(ensurePlainObject(playerInput.activityInfo).datas)
      ? ensurePlainObject(playerInput.activityInfo).datas
      : [])
      .map((row) => toFiniteNumber(row && row.id, 0))
      .filter((id) => id > 0)
  );
  const retainedCompletedTaskIds = new Set();

  taskIds.forEach((taskIdKey) => {
    const task = ensurePlainObject(tasks[taskIdKey]);
    const taskId = Math.max(0, toFiniteNumber(task.id != null ? task.id : taskIdKey, 0));
    const type = Math.max(0, toFiniteNumber(task.type, 0));
    if (taskId > 0 && (type === 2 || type === 9)) retainedCompletedTaskIds.add(taskId);
  });

  const roleStage = toFiniteNumber(
    roleInfoInput.stage != null ? roleInfoInput.stage : roleInfoInput.stageId,
    1
  );
  const roleStageCfg = stageCfgMap[roleStage] || stageCfgMap[String(roleStage)];
  if (roleStageCfg && Array.isArray(roleStageCfg.taskGroup)) {
    roleStageCfg.taskGroup.forEach((taskIdRaw) => {
      const taskId = Math.max(0, toFiniteNumber(taskIdRaw, 0));
      if (taskId > 0) retainedCompletedTaskIds.add(taskId);
    });
  }

  Object.keys(boxTierCfgMap).forEach((tierKey) => {
    const tierCfg = boxTierCfgMap[tierKey] || boxTierCfgMap[String(tierKey)] || {};
    const taskList = Array.isArray(tierCfg.task) ? tierCfg.task : [];
    taskList.forEach((taskIdRaw) => {
      const taskId = Math.max(0, toFiniteNumber(taskIdRaw, 0));
      if (taskId > 0) retainedCompletedTaskIds.add(taskId);
    });
  });

  activityTaskConfigMaps.forEach((activityTaskCfgMap) => {
    Object.keys(activityTaskCfgMap).forEach((activityIdKey) => {
      const activityId = toFiniteNumber(activityIdKey, 0);
      if (!activeActivityIds.has(activityId)) return;
      const taskRows = activityTaskCfgMap[activityIdKey] || activityTaskCfgMap[activityId] || {};
      if (!taskRows || typeof taskRows !== 'object' || Array.isArray(taskRows)) return;
      Object.keys(taskRows).forEach((rowKey) => {
        const row = taskRows[rowKey] || {};
        const taskId = Math.max(0, toFiniteNumber(row.taskId != null ? row.taskId : rowKey, 0));
        if (taskId > 0) retainedCompletedTaskIds.add(taskId);
      });
    });
  });

  const compactedTasks = {};
  const compactedTasksMap = {};
  taskIds.forEach((taskIdKey) => {
    const task = ensurePlainObject(tasks[taskIdKey]);
    const taskId = Math.max(0, toFiniteNumber(task.id != null ? task.id : taskIdKey, 0));
    if (taskId <= 0) return;
    const status = Math.max(0, toFiniteNumber(task.status, DEFAULT_TASK_STATUS));
    if (status >= 30 && !retainedCompletedTaskIds.has(taskId)) return;

    const type = String(Math.max(0, toFiniteNumber(task.type, 0)));
    const nextTask = { ...task, id: taskId };
    compactedTasks[String(taskId)] = nextTask;
    if (!compactedTasksMap[type]) compactedTasksMap[type] = [];
    compactedTasksMap[type].push(nextTask);
  });

  Object.keys(compactedTasksMap).forEach((typeKey) => {
    compactedTasksMap[typeKey].sort((a, b) => a.id - b.id);
  });

  return {
    ...sourceTaskInfo,
    tasks: compactedTasks,
    tasksMap: compactedTasksMap,
  };
}

function normalizeKungfuInfoRow(row, fallbackKungfuId = 0) {
  const source = ensurePlainObject(row);
  const kungfuId = Math.max(0, toSafeInt(
    source.kungfuId != null ? source.kungfuId : source.id,
    fallbackKungfuId
  ));
  const kungfuCfgMap = ensurePlainObject(configService.get('RoleKungFuConfig'));
  const kungfuCfg = ensurePlainObject(kungfuCfgMap[kungfuId] || kungfuCfgMap[String(kungfuId)]);
  const skillLevelSource = Array.isArray(source.skillLevel) ? source.skillLevel : [];
  const sequenceSource = Array.isArray(source.sequence) ? source.sequence : [];
  const configuredSkillCount = 1 + (Array.isArray(kungfuCfg.skillId) ? kungfuCfg.skillId.length : 0);
  const size = Math.max(5, configuredSkillCount, skillLevelSource.length, sequenceSource.length);
  const skillLevel = [];
  for (let i = 0; i < size; i += 1) {
    skillLevel.push(Math.max(0, toSafeInt(skillLevelSource[i], 1)));
  }
  const sequence = [];
  sequenceSource.forEach((value) => {
    const index = toSafeInt(value, -1);
    if (index >= 0 && index < size && !sequence.includes(index)) sequence.push(index);
  });
  for (let index = 0; index < size; index += 1) {
    if (!sequence.includes(index)) sequence.push(index);
  }
  return {
    ...source,
    id: kungfuId,
    kungfuId,
    skillLevel,
    sequence,
  };
}

function normalizeRoleKungfuInfos(roleInfo = {}, preserveUnselectedRole = false) {
  const fallbackKungfuId = preserveUnselectedRole
    ? 0
    : Math.max(0, toSafeInt(roleInfo.kungfuId, 4));
  const source = Array.isArray(roleInfo.kungfuInfos) ? roleInfo.kungfuInfos : [];
  const seen = new Set();
  const normalized = [];

  source.forEach((row) => {
    const normalizedRow = normalizeKungfuInfoRow(row, fallbackKungfuId);
    if (seen.has(normalizedRow.kungfuId)) return;
    seen.add(normalizedRow.kungfuId);
    normalized.push(normalizedRow);
  });

  if (!seen.has(fallbackKungfuId)) {
    normalized.push(normalizeKungfuInfoRow({}, fallbackKungfuId));
  }

  roleInfo.kungfuInfos = normalized.sort((a, b) => toSafeInt(a.kungfuId, 0) - toSafeInt(b.kungfuId, 0));
}

function buildPlayer500Data(player = {}, options = {}) {
  player = clonePlayerSnapshot(player);
  const preserveUnselectedRole = options.forceUnselectedRole === true
    || (options.preserveUnselectedRole === true && toSafeInt(player.roleInfo && player.roleInfo.kungfuId, 0) <= 0);
  if (!preserveUnselectedRole) {
    ensureRoleAppearance(player);
  }
  ensureEquipInfo(player);
  const formationInfo = ensureFormationInfo(player);
  const raidInfo = ensureRaidInfo(player);
  const roleInfo = { ...(player.roleInfo || {}) };
  if (!roleInfo.realmInfo) {
    roleInfo.realmInfo = { taskGroup: [], realmLevel: 0, realmExp: 0, realmStage: 0 };
  }
  if (!roleInfo.showInfo) {
    roleInfo.showInfo = { title: -1, avatarFrame: -1, chatBubble: -1, nameColor: -1 };
  } else {
    // Ensure all 4 required fields exist even if showInfo is partially populated.
    // The client reads these as indexed fields; undefined causes TypeError crashes.
    if (roleInfo.showInfo.title == null) roleInfo.showInfo.title = -1;
    if (roleInfo.showInfo.avatarFrame == null) roleInfo.showInfo.avatarFrame = -1;
    if (roleInfo.showInfo.chatBubble == null) roleInfo.showInfo.chatBubble = -1;
    if (roleInfo.showInfo.nameColor == null) roleInfo.showInfo.nameColor = -1;
  }
  if (!roleInfo.kungfuSkills) roleInfo.kungfuSkills = [];
  if (!roleInfo.stageRewards) roleInfo.stageRewards = [];
  if (roleInfo.stage == null) roleInfo.stage = roleInfo.stageId || 1;
  if (roleInfo.stageFailedTime == null) roleInfo.stageFailedTime = 0;
  if (roleInfo.rewardedStage == null) roleInfo.rewardedStage = 0;
  if (preserveUnselectedRole) {
    roleInfo.kungfuId = 0;
    roleInfo.subJob = 0;
  } else {
    ensureRoleGenderSelection(roleInfo);
  }
  normalizeRoleKungfuInfos(roleInfo, preserveUnselectedRole);

  const fashionInfo = {
    curFashion: {}, fashions: {}, suits: {}, suitColors: {}, starUp: {},
    sets: [], setId: 0, setNames: {},
    emojiGroups: [], emojis: [], emoji: [],
    equipped: {}, dress: {},
    fashion: {}, fashionData: [],
    activateFashion: [],
    ...(player.fashionInfo || {}),
  };
  if (!fashionInfo.curFashion || typeof fashionInfo.curFashion !== 'object' || Array.isArray(fashionInfo.curFashion)) {
    fashionInfo.curFashion = {};
  }
  if (!fashionInfo.fashions || typeof fashionInfo.fashions !== 'object' || Array.isArray(fashionInfo.fashions)) {
    fashionInfo.fashions = {};
  }
  if (!fashionInfo.suits || typeof fashionInfo.suits !== 'object' || Array.isArray(fashionInfo.suits)) {
    fashionInfo.suits = {};
  }
  if (!fashionInfo.suitColors || typeof fashionInfo.suitColors !== 'object' || Array.isArray(fashionInfo.suitColors)) {
    fashionInfo.suitColors = {};
  }
  if (!fashionInfo.starUp || typeof fashionInfo.starUp !== 'object' || Array.isArray(fashionInfo.starUp)) {
    fashionInfo.starUp = {};
  }
  if (!Array.isArray(fashionInfo.sets)) fashionInfo.sets = [];
  if (!fashionInfo.setNames || typeof fashionInfo.setNames !== 'object' || Array.isArray(fashionInfo.setNames)) {
    fashionInfo.setNames = {};
  }
  if (!Array.isArray(fashionInfo.emojiGroups)) fashionInfo.emojiGroups = [];
  if (!Array.isArray(fashionInfo.emojis)) fashionInfo.emojis = [];
  if (!Array.isArray(fashionInfo.emoji)) fashionInfo.emoji = [];
  if (!fashionInfo.equipped || typeof fashionInfo.equipped !== 'object' || Array.isArray(fashionInfo.equipped)) {
    fashionInfo.equipped = {};
  }
  if (!fashionInfo.dress || typeof fashionInfo.dress !== 'object' || Array.isArray(fashionInfo.dress)) {
    fashionInfo.dress = {};
  }
  if (!fashionInfo.fashion || typeof fashionInfo.fashion !== 'object' || Array.isArray(fashionInfo.fashion)) {
    fashionInfo.fashion = {};
  }
  if (!fashionInfo.fashionMap || typeof fashionInfo.fashionMap !== 'object' || Array.isArray(fashionInfo.fashionMap)) {
    fashionInfo.fashionMap = {};
  }
  if (!Array.isArray(fashionInfo.fashionData)) fashionInfo.fashionData = [];
  if (!Array.isArray(fashionInfo.activateFashion)) fashionInfo.activateFashion = [];
  if (fashionInfo.setId == null) {
    fashionInfo.setId = Number(fashionInfo.curSetId || 0);
  }
  fashionInfo.fashionMap = getPlayerFashionMap({ roleInfo, fashionInfo });

  const rechargeInfo = {
    vipLevel: 0, totalRecharge: 0, totalrecharge: 0,
    monthCards: {}, monthCardRecords: {},
    firstRecharge: 0, dailyRecharge: 0, weekRecharge: 0,
    totalDiamond: 0, privilegeItem: {},
    records: [], area: '',
    ...(player.rechargeInfo || {}),
  };
  rechargeInfo.monthCards = ensurePlainObject(rechargeInfo.monthCards);
  rechargeInfo.monthCardRecords = ensurePlainObject(rechargeInfo.monthCardRecords);
  rechargeInfo.privilegeItem = ensurePlainObject(rechargeInfo.privilegeItem);
  if (!Array.isArray(rechargeInfo.records)) rechargeInfo.records = [];
  {
    const totalRecharge = Math.max(
      0,
      toSafeInt(rechargeInfo.totalRecharge, 0),
      toSafeInt(rechargeInfo.totalrecharge, 0)
    );
    rechargeInfo.totalRecharge = totalRecharge;
    rechargeInfo.totalrecharge = totalRecharge;
  }

  const adInfo = ensurePlainObject(ensurePlainObject(player.other_attr_info).adInfo);
  const fallbackAdRecords = ensurePlainObject(adInfo.records);
  const fallbackAdTimeRecords = ensurePlainObject(adInfo.timeRecords);

  rechargeInfo.adRecords = ensurePlainObject(rechargeInfo.adRecords);
  rechargeInfo.adTimeRecords = ensurePlainObject(rechargeInfo.adTimeRecords);
  if (Object.keys(rechargeInfo.adRecords).length === 0 && Object.keys(fallbackAdRecords).length > 0) {
    rechargeInfo.adRecords = { ...fallbackAdRecords };
  }
  if (Object.keys(rechargeInfo.adTimeRecords).length === 0 && Object.keys(fallbackAdTimeRecords).length > 0) {
    rechargeInfo.adTimeRecords = { ...fallbackAdTimeRecords };
  }

  const shopInfo = {
    buyRecords: {},
    refreshRecords: {},
    pack: [],
    chainPack: [],
    ...(player.shopInfo || {}),
  };
  if (!Array.isArray(shopInfo.pack)) shopInfo.pack = [];
  if (!Array.isArray(shopInfo.chainPack)) shopInfo.chainPack = [];
  {
    const condConfig = ensurePlainObject(configService.get('ShopGiftCondConfig'));
    const giftConfig = ensurePlainObject(configService.get('ShopGiftConfig'));
    shopInfo.chainPack = shopInfo.chainPack.filter((row) => {
      const id = Math.max(0, toSafeInt(row && row.id, 0));
      return id > 0
        && !!(condConfig[id] || condConfig[String(id)])
        && !!(giftConfig[id] || giftConfig[String(id)]);
    });
  }

  const fishBaseConfig = ensurePlainObject(configService.get('FishBaseConfig'));
  const initFishBaitId = normalizeConfigBackedId('FishBaitConfig', fishBaseConfig.initFishBaitId, 5501) || 5501;
  const initFishRodId = normalizeConfigBackedId('FishRodConfig', fishBaseConfig.initFishRodId, 5901) || 5901;
  const initFishRaftId = normalizeConfigBackedId('FishRaftConfig', fishBaseConfig.initFishRaftId, 6201) || 6201;
  const fishInfo = {
    level: 1,
    exp: 0,
    scene: 0,
    food: initFishBaitId,
    orders: [],
    pics: {},
    extraPrice: {},
    fishResult: { time: 0, fishInfos: [], escapes: [], items: [], fashion: [] },
    catchResult: { time: 0, infos: [], escapes: [], items: [], sailItems: {} },
    foodBag: [],
    fishTypeQualityPic: {},
    fishSoulSlots: {},
    fishSoulPic: {},
    slots: {},
    fetters: [],
    shipLogs: {},
    rodId: initFishRodId,
    rodRank: 1,
    rodLevel: 0,
    rodExp: 0,
    rodAttrs: [],
    rodTempAttrs: [],
    raftRank: 1,
    raftLevel: 0,
    raftExp: 0,
    raftId: initFishRaftId,
    fishUidSeq: 1000,
    ...(player.fishInfo || {}),
  };
  fishInfo.level = Math.max(1, toFiniteNumber(fishInfo.level, 1));
  fishInfo.exp = Math.max(0, toFiniteNumber(fishInfo.exp, 0));
  fishInfo.scene = normalizeFishSceneId(fishInfo.scene, 1);
  fishInfo.food = normalizeConfigBackedId('FishBaitConfig', fishInfo.food, initFishBaitId) || initFishBaitId;
  fishInfo.fishUidSeq = Math.max(1, toFiniteNumber(fishInfo.fishUidSeq, 1000));
  if (!fishInfo.fishResult || typeof fishInfo.fishResult !== 'object') fishInfo.fishResult = { fishInfos: [] };
  if (!Array.isArray(fishInfo.fishResult.fishInfos)) fishInfo.fishResult.fishInfos = [];
  fishInfo.fishResult.fishInfos = normalizeFishEntityList(fishInfo.fishResult.fishInfos, fishInfo);
  if (!Array.isArray(fishInfo.fishResult.escapes)) fishInfo.fishResult.escapes = [];
  if (!Array.isArray(fishInfo.fishResult.items)) fishInfo.fishResult.items = [];
  if (!Array.isArray(fishInfo.fishResult.fashion)) fishInfo.fishResult.fashion = [];
  fishInfo.fishResult.time = Math.max(0, toFiniteNumber(fishInfo.fishResult.time, 0));
  if (!fishInfo.catchResult || typeof fishInfo.catchResult !== 'object') fishInfo.catchResult = { time: 0, infos: [], escapes: [], items: [], sailItems: {} };
  if (!Array.isArray(fishInfo.catchResult.infos)) fishInfo.catchResult.infos = [];
  if (!Array.isArray(fishInfo.catchResult.escapes)) fishInfo.catchResult.escapes = [];
  if (!Array.isArray(fishInfo.catchResult.items)) fishInfo.catchResult.items = [];
  if (!fishInfo.catchResult.sailItems || typeof fishInfo.catchResult.sailItems !== 'object') fishInfo.catchResult.sailItems = {};
  fishInfo.catchResult.time = Math.max(0, toFiniteNumber(fishInfo.catchResult.time, 0));
  if (!fishInfo.pics || typeof fishInfo.pics !== 'object') fishInfo.pics = {};
  if (!fishInfo.extraPrice || typeof fishInfo.extraPrice !== 'object') fishInfo.extraPrice = {};
  fishInfo.foodBag = Array.isArray(fishInfo.foodBag)
    ? fishInfo.foodBag.map((id) => normalizeConfigBackedId('FishBaitConfig', id, initFishBaitId)).filter((id, index, arr) => id > 0 && arr.indexOf(id) === index)
    : [];
  if (!fishInfo.fishTypeQualityPic || typeof fishInfo.fishTypeQualityPic !== 'object') fishInfo.fishTypeQualityPic = {};
  fishInfo.fishSoulSlots = normalizeFishSoulSlots(fishInfo.fishSoulSlots);
  if (!fishInfo.fishSoulPic || typeof fishInfo.fishSoulPic !== 'object') fishInfo.fishSoulPic = {};
  fishInfo.slots = normalizeFishSlots(fishInfo.slots, fishInfo);
  if (!Array.isArray(fishInfo.fetters)) fishInfo.fetters = [];
  fishInfo.orders = normalizeFishOrders(fishInfo.orders);
  if (!fishInfo.shipLogs || typeof fishInfo.shipLogs !== 'object' || Array.isArray(fishInfo.shipLogs)) fishInfo.shipLogs = {};
  fishInfo.rodId = normalizeConfigBackedId('FishRodConfig', fishInfo.rodId, initFishRodId) || initFishRodId;
  if (!Array.isArray(fishInfo.rodAttrs)) fishInfo.rodAttrs = [];
  if (!Array.isArray(fishInfo.rodTempAttrs)) fishInfo.rodTempAttrs = [];
  fishInfo.rodExp = Math.max(0, toFiniteNumber(fishInfo.rodExp, 0));
  fishInfo.raftExp = Math.max(0, toFiniteNumber(fishInfo.raftExp, 0));
  {
    const rodRank = Number(fishInfo.rodRank);
    const rodLevel = Number(fishInfo.rodLevel);
    const raftRank = Number(fishInfo.raftRank);
    const raftLevel = Number(fishInfo.raftLevel);
    fishInfo.rodRank = Number.isFinite(rodRank) && rodRank > 0 ? Math.floor(rodRank) : 1;
    fishInfo.rodLevel = Number.isFinite(rodLevel) && rodLevel >= 0 ? Math.floor(rodLevel) : 0;
    fishInfo.raftRank = Number.isFinite(raftRank) && raftRank > 0 ? Math.floor(raftRank) : 1;
    fishInfo.raftLevel = Number.isFinite(raftLevel) && raftLevel >= 0 ? Math.floor(raftLevel) : 0;
  }
  fishInfo.raftId = normalizeConfigBackedId('FishRaftConfig', fishInfo.raftId, initFishRaftId) || initFishRaftId;

  const normalizedArtifactInfo = ensureArtifactInfo(player);
  const artifactInfo = {
    artifacts: Array.isArray(normalizedArtifactInfo.artifacts) ? normalizedArtifactInfo.artifacts : [],
    artifactMap: (normalizedArtifactInfo.artifactMap && typeof normalizedArtifactInfo.artifactMap === 'object')
      ? normalizedArtifactInfo.artifactMap
      : {},
    equipMap: (normalizedArtifactInfo.equipMap && typeof normalizedArtifactInfo.equipMap === 'object')
      ? normalizedArtifactInfo.equipMap
      : {},
    unlockSlots: Array.isArray(normalizedArtifactInfo.unlockSlots) ? normalizedArtifactInfo.unlockSlots : [],
    orbInfo: {
      maxLevel: 0,
      orbData: [],
      slotData: [],
      summonLevel: 1,
      maxSlotLevel: 0,
      ...(normalizedArtifactInfo.orbInfo || {}),
    },
  };
  if (!Array.isArray(artifactInfo.orbInfo.orbData)) artifactInfo.orbInfo.orbData = [];
  if (!Array.isArray(artifactInfo.orbInfo.slotData)) artifactInfo.orbInfo.slotData = [];
  if (!artifactInfo.orbInfo.orbDataMap || typeof artifactInfo.orbInfo.orbDataMap !== 'object') {
    artifactInfo.orbInfo.orbDataMap = {};
  }
  if (artifactInfo.orbInfo.maxLevel == null) artifactInfo.orbInfo.maxLevel = 0;
  if (artifactInfo.orbInfo.maxSlotLevel == null) artifactInfo.orbInfo.maxSlotLevel = 0;
  if (artifactInfo.orbInfo.summonLevel == null) artifactInfo.orbInfo.summonLevel = 1;

  const systemUnlockInfo = {
    unlockedSystem: [],
    rewardedSystem: [],
    settings: {},
    guideStep: 0,
    ...(player.systemUnlockInfo || {}),
  };
  systemUnlockInfo.unlockedSystem = normalizeIdList(systemUnlockInfo.unlockedSystem);
  systemUnlockInfo.rewardedSystem = normalizeIdList(systemUnlockInfo.rewardedSystem);
  if (!systemUnlockInfo.settings || typeof systemUnlockInfo.settings !== 'object') {
    systemUnlockInfo.settings = {};
  }
  if (systemUnlockInfo.guideStep == null) systemUnlockInfo.guideStep = 0;
  // pendingNewFeatures: unlocked systems not yet acknowledged by the client.
  // Client should show "新功能开启" popup ONLY for these, then call tag 10002
  // with { seenNewFeature: id } to mark each one as seen.
  const seenNewFeatures = normalizeIdList(systemUnlockInfo.settings.seenNewFeatures);
  systemUnlockInfo.settings.seenNewFeatures = seenNewFeatures;
  systemUnlockInfo.pendingNewFeatures = systemUnlockInfo.unlockedSystem
    .filter((id) => !seenNewFeatures.includes(id));

  const normalizedTaskInfo = normalizeTaskInfo(player.taskInfo || {}, roleInfo, player);
  const taskInfo = compactTaskInfoForClient(normalizedTaskInfo, roleInfo, player);
  const swordInfo = normalizeMountInfoPayload(player);

  const petInfo = {
    pets: [],
    field: 8,
    unlockAtlas: [],
    rewardedAtlas: [],
    wishMap: {},
    skillWashLevel: 1,
    skillWashExp: 0,
    ...(player.petInfo || {}),
  };
  if (!Array.isArray(petInfo.pets)) petInfo.pets = [];
  if (!Array.isArray(petInfo.unlockAtlas)) petInfo.unlockAtlas = [];
  if (!Array.isArray(petInfo.rewardedAtlas)) petInfo.rewardedAtlas = [];
  if (!petInfo.wishMap || typeof petInfo.wishMap !== 'object' || Array.isArray(petInfo.wishMap)) petInfo.wishMap = {};
  if (petInfo.field == null) petInfo.field = 8;
  if (petInfo.skillWashLevel == null || Number(petInfo.skillWashLevel) <= 0) petInfo.skillWashLevel = 1;
  if (petInfo.skillWashExp == null) petInfo.skillWashExp = 0;
  petInfo.pets = petInfo.pets.map((pet) => {
    const normalized = pet && typeof pet === 'object' ? { ...pet } : {};
    normalized.uid = Number(normalized.uid || 0);
    normalized.id = Number(normalized.id || 0);
    normalized.level = Math.max(1, Number(normalized.level || 1));
    normalized.slot = Number.isFinite(Number(normalized.slot)) ? Number(normalized.slot) : -1;
    normalized.locked = Number(normalized.locked || normalized.lock || 0) > 0 ? 1 : 0;
    normalized.lock = normalized.locked;
    if (!Array.isArray(normalized.passiveSkills)) normalized.passiveSkills = [];
    if (!Array.isArray(normalized.lockSkills)) normalized.lockSkills = [];
    normalized.passiveSkills = normalized.passiveSkills.map((v) => Number(v || 0)).filter((v) => v > 0);
    normalized.lockSkills = normalized.lockSkills
      .map((v) => Number(v || -1))
      .filter((v, idx, arr) => v >= 0 && v < normalized.passiveSkills.length && arr.indexOf(v) === idx);
    return normalized;
  });

  const presetSpiritInfo = syncSpiritInfoFromCurrentPreset(player) || ensureSpiritInfo(player);
  const spiritProgressMode = String(presetSpiritInfo.progressMode || '');
  const shouldKeepLegacySpiritProgress = spiritProgressMode === 'legacy3001'
    || (spiritProgressMode !== 'modern3600' && toSafeInt(presetSpiritInfo.exp, 0) > 0);
  const normalizedSpiritInfo = shouldKeepLegacySpiritProgress
    ? ensureLegacySpiritInfo(player)
    : syncModernSpiritProgressFromAttrs(presetSpiritInfo);
  const spiritInfo = {
    id: toFiniteNumber(normalizedSpiritInfo.id, -1),
    equippedId: Math.max(0, toFiniteNumber(normalizedSpiritInfo.equippedId, toFiniteNumber(normalizedSpiritInfo.id, -1))),
    owns: normalizeIdList(normalizedSpiritInfo.owns),
    rank: Math.max(1, toFiniteNumber(normalizedSpiritInfo.rank, 1)),
    grade: Math.max(1, toFiniteNumber(normalizedSpiritInfo.grade, toFiniteNumber(normalizedSpiritInfo.rank, 1))),
    level: Math.max(1, toFiniteNumber(normalizedSpiritInfo.level, 1)),
    exp: Math.max(0, toFiniteNumber(normalizedSpiritInfo.exp, 0)),
    enchant: Array.isArray(normalizedSpiritInfo.enchant)
      ? normalizedSpiritInfo.enchant.slice(0, 5).map((v) => Math.max(0, toFiniteNumber(v, 0)))
      : [0, 0, 0, 0, 0],
    attrs: (
      normalizedSpiritInfo.attrs
      && typeof normalizedSpiritInfo.attrs === 'object'
      && !Array.isArray(normalizedSpiritInfo.attrs)
    ) ? normalizedSpiritInfo.attrs : {},
  };
  while (spiritInfo.enchant.length < 5) spiritInfo.enchant.push(0);
  const playerAttrs = battle.calcPlayerPower(player);
  const playerPower = Math.max(0, toFiniteNumber(battle.calcPowerScore(playerAttrs), 0));
  const otherAttrInfo = (
    player.other_attr_info
    && typeof player.other_attr_info === 'object'
    && !Array.isArray(player.other_attr_info)
  ) ? { ...player.other_attr_info } : {};
  if (!otherAttrInfo.record || typeof otherAttrInfo.record !== 'object' || Array.isArray(otherAttrInfo.record)) {
    otherAttrInfo.record = {};
  }
  const itemUseRecords = (
    player.itemUseRecords
    && typeof player.itemUseRecords === 'object'
    && !Array.isArray(player.itemUseRecords)
  ) ? player.itemUseRecords : {};
  const assetsUseConfig = configService.get('AssetsUseConfig') || {};
  Object.keys(itemUseRecords).forEach((key) => {
    const id = Math.max(0, toSafeInt(key, 0));
    const row = assetsUseConfig[id] || assetsUseConfig[String(id)];
    if (id <= 0 || !row || typeof row !== 'object') return;
    const hasPermanentAttrs = toSafeInt(row.type, 0) === 103
      || (row.attrs && typeof row.attrs === 'object' && !Array.isArray(row.attrs));
    if (!hasPermanentAttrs) return;
    otherAttrInfo.record[String(id)] = Math.max(
      0,
      toSafeInt(otherAttrInfo.record[String(id)], 0),
      toSafeInt(itemUseRecords[key], 0)
    );
  });

  return {
    createTime: Math.max(
      0,
      Number(player.createTime)
      || (player.createdAt ? new Date(player.createdAt).getTime() : 0)
      || 0
    ),
    avatar: player.avatar || 0,
    avatarFrame: player.avatarFrame == null ? -1 : player.avatarFrame,
    title: player.title == null ? -1 : player.title,
    name: player.name || '',
    serverId: Math.max(1, toFiniteNumber(player.serverId, toFiniteNumber(process.env.SERVER_ID || process.env.DEFAULT_SERVER_ID, 1001))),
    serverName: String(player.serverName || process.env.SERVER_NAME || ''),
    level: player.level || 1,
    power: playerPower,
    powerScore: playerPower,
    changeName: player.changeName || 0,
    commentGift: player.commentGift || 0,
    fbGiftRecord: player.fbGiftRecord || {},
    fbShareCount: player.fbShareCount || 0,
    birth: player.birth || 0,
    changeBirth: player.changeBirth || 0,
    boxInfo: buildClientBoxInfo(player.boxInfo || {}),
    equipInfo: player.equipInfo || {},
    taskInfo,
    raidInfo,
    roleInfo,
    formationInfo,
    shopInfo,
    rechargeInfo,
    guildInfo: player.guildInfo || {},
    swordInfo,
    alchemyInfo: ensureAlchemyInfo(player),
    petInfo,
    fashionInfo,
    systemUnlockInfo,
    other_attr_info: otherAttrInfo,
    artifactInfo,
    spiritInfo,
    fishInfo,
    homelandInfo: buildClientHomelandInfo(player),
    activityInfo: player.activityInfo || {},
    blockList: Array.isArray(player.blockList) ? player.blockList : [],
    currencies: player.currencies || {},
  };
}

module.exports = { buildPlayer500Data, normalizeTaskInfo, ensureRaidInfo };
