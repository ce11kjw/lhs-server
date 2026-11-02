/**
 * 神器系统（Artifact）
 * tag: 3501 锻造, 3502 穿戴, 3504 锁定, 3505 淬炼, 3506 淬炼刷新
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const { addArtifactUpgradeCount } = require('../services/MainTaskProgressService');
const { addRewardToPlayer } = require('./raid');
const { buildClientItemList } = require('../services/CurrencySync');

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
  if (currKey) return Math.max(0, toSafeInt(player && player.currencies && player.currencies[currKey], 0));
  return Math.max(0, toSafeInt(player && player.items && player.items[id], 0));
}

function buildItemSyncPacket(player, beforeCounts = {}, touchedIds = []) {
  const ids = Array.from(new Set([
    ...Object.keys(beforeCounts).map((key) => toSafeInt(key, 0)),
    ...(Array.isArray(touchedIds) ? touchedIds : []).map((id) => toSafeInt(id, 0)),
  ])).filter((id) => id > 0);
  const changed = ids
    .map((id) => ({ id, count: getItemOrCurrencyCount(player, id), before: Math.max(0, toSafeInt(beforeCounts[id], 0)) }))
    .filter((row) => row.count !== row.before)
    .map((row) => ({ id: row.id, count: row.count }));

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

function randomPickWeighted(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const valid = entries.filter((row) => row && row.weight > 0);
  if (valid.length === 0) return entries[0] || null;
  const total = valid.reduce((sum, row) => sum + row.weight, 0);
  let roll = Math.random() * total;
  for (const row of valid) {
    roll -= row.weight;
    if (roll <= 0) return row;
  }
  return valid[valid.length - 1];
}

function getArtifactCfgMap() {
  return config.get('ArtifactConfig') || {};
}

function getArtifactCfg(artifactId) {
  return getArtifactCfgMap()[toSafeInt(artifactId, 0)] || null;
}

function getArtifactTypeById(artifactId) {
  const row = getArtifactCfg(artifactId);
  return Math.max(1, toSafeInt(row && row.type, 1));
}

function getArtifactQualityById(artifactId) {
  const row = getArtifactCfg(artifactId);
  return Math.max(4, toSafeInt(row && row.quality, 4));
}

function getNestedConfig(map, keys = []) {
  let cur = map || {};
  for (const key of keys) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[key] != null ? cur[key] : cur[String(key)];
  }
  return cur || null;
}

function normalizeRewardRows(rows) {
  const result = [];
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id > 0 && count > 0) result.push({ id, count });
  });
  return result;
}

function getArtifactConsumeQualityMap(quality) {
  const consumeCfg = config.get('ArtifactConsumeConfig') || {};
  return consumeCfg[quality] || consumeCfg[String(quality)] || {};
}

function getArtifactConsumeLevelList(quality) {
  return Object.keys(getArtifactConsumeQualityMap(quality))
    .map((key) => toSafeInt(key, 0))
    .filter((level) => level > 0)
    .sort((a, b) => a - b);
}

function getArtifactConsumeLevelCfg(quality, level) {
  const qualityMap = getArtifactConsumeQualityMap(quality);
  const safeLevel = Math.max(1, toSafeInt(level, 1));
  return qualityMap[safeLevel] || qualityMap[String(safeLevel)] || null;
}

function clampArtifactLevelByQuality(quality, level) {
  const levels = getArtifactConsumeLevelList(quality);
  const safeLevel = Math.max(1, toSafeInt(level, 1));
  if (levels.length <= 0) return safeLevel;
  return Math.min(levels[levels.length - 1], Math.max(levels[0], safeLevel));
}

function normalizeArtifactId(rawId, rawType = 1) {
  const id = toSafeInt(rawId, 0);
  if (getArtifactCfg(id)) return id;
  return pickInitArtifactId(Math.max(1, toSafeInt(rawType, 1)));
}

function listArtifactIdsByType(type, maxQuality = 7) {
  const artifactCfg = getArtifactCfgMap();
  return Object.keys(artifactCfg)
    .map((k) => toSafeInt(k, 0))
    .filter((id) => {
      const row = artifactCfg[id];
      if (!row) return false;
      return toSafeInt(row.type, 0) === toSafeInt(type, 0)
        && toSafeInt(row.quality, 0) <= maxQuality;
    })
    .sort((a, b) => toSafeInt(artifactCfg[a].quality, 0) - toSafeInt(artifactCfg[b].quality, 0) || a - b);
}

function pickInitArtifactId(type) {
  const ids = listArtifactIdsByType(type, Math.max(4, toSafeInt((config.get('ArtifactBaseConfig') || {}).initLvMaxQuality, 6)));
  if (ids.length > 0) return ids[0];
  return type === 2 ? 23501 : 23101;
}

function buildDefaultAttr(artifactId, level = 1) {
  const cfg = getArtifactCfg(artifactId) || {};
  const initAttrs = Array.isArray(cfg.initAttrs) ? cfg.initAttrs : [];
  const weighted = initAttrs
    .map((row) => ({ id: toSafeInt(row && row.id, 54), weight: Math.max(0, toSafeInt(row && row.weight, 0)) }))
    .filter((row) => row.id > 0 && row.weight > 0);
  const picked = randomPickWeighted(weighted);
  const attrType = picked ? picked.id : 54;
  const quality = getArtifactQualityById(artifactId);
  const baseVal = Math.max(100, quality * 100);
  return {
    type: attrType,
    level: clampArtifactLevelByQuality(quality, level),
    value: baseVal,
  };
}

function normalizeArtifact(raw, info) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const hintedType = Math.max(1, toSafeInt(row.type, getArtifactTypeById(row.id)));
  const id = normalizeArtifactId(row.id, hintedType);
  const uid = toSafeInt(row.uid, 0) > 0 ? toSafeInt(row.uid, 0) : toSafeInt(info.nextUid, 300001);
  if (uid >= toSafeInt(info.nextUid, 300001)) info.nextUid = uid + 1;

  const attrInput = row.attr && typeof row.attr === 'object' ? row.attr : {};
  const quality = getArtifactQualityById(id);
  const defaultAttr = buildDefaultAttr(id, 1);
  const attr = {
    type: toSafeInt(attrInput.type, 0) > 0 ? toSafeInt(attrInput.type, 54) : defaultAttr.type,
    level: clampArtifactLevelByQuality(quality, toSafeInt(attrInput.level, 1)),
    value: Math.max(1, toSafeInt(attrInput.value, defaultAttr.value)),
  };

  return {
    ...row,
    uid,
    id,
    count: Math.max(0, toSafeInt(row.count, 0)),
    lock: toSafeInt(row.lock, 0) > 0 ? 1 : 0,
    attr,
    extraAttrs: Array.isArray(row.extraAttrs) ? row.extraAttrs : [],
    skillGroup: Math.max(0, toSafeInt(row.skillGroup, 0)),
    skillLv: Math.max(1, toSafeInt(row.skillLv, 1)),
    forgeTime: Math.max(0, toSafeInt(row.forgeTime, 0)),
    forgeName: row.forgeName || '',
    quenchLv: Math.max(0, toSafeInt(row.quenchLv, 0)),
    eSkillGroup: Math.max(0, toSafeInt(row.eSkillGroup, 0)),
    element: Math.max(1, toSafeInt(row.element, 1)),
    refreshCache: (row.refreshCache && typeof row.refreshCache === 'object') ? row.refreshCache : null,
  };
}

function rebuildArtifactMap(artifacts = []) {
  const map = {};
  artifacts.forEach((artifact) => {
    const type = getArtifactTypeById(artifact.id);
    if (!map[type]) map[type] = [];
    map[type].push(artifact);
  });
  return map;
}

function ensureArtifactInfo(player) {
  player.artifactInfo = player.artifactInfo && typeof player.artifactInfo === 'object' && !Array.isArray(player.artifactInfo)
    ? player.artifactInfo
    : {};
  const info = player.artifactInfo;

  if (!Array.isArray(info.artifacts)) {
    // Old saves may only have artifactMap
    const legacyMap = info.artifactMap && typeof info.artifactMap === 'object' ? info.artifactMap : {};
    const rebuilt = [];
    Object.keys(legacyMap).forEach((typeKey) => {
      const list = Array.isArray(legacyMap[typeKey]) ? legacyMap[typeKey] : [];
      list.forEach((row) => rebuilt.push(row));
    });
    info.artifacts = rebuilt;
  }
  if (!info.equipMap || typeof info.equipMap !== 'object' || Array.isArray(info.equipMap)) info.equipMap = {};
  if (!Array.isArray(info.unlockSlots)) info.unlockSlots = [];
  if (!info.orbInfo || typeof info.orbInfo !== 'object' || Array.isArray(info.orbInfo)) info.orbInfo = {};
  if (!Array.isArray(info.orbInfo.orbData)) info.orbInfo.orbData = [];
  if (!Array.isArray(info.orbInfo.slotData)) info.orbInfo.slotData = [];
  if (!info.orbInfo.orbDataMap || typeof info.orbInfo.orbDataMap !== 'object') info.orbInfo.orbDataMap = {};
  if (info.orbInfo.maxLevel == null) info.orbInfo.maxLevel = 0;
  if (info.orbInfo.maxSlotLevel == null) info.orbInfo.maxSlotLevel = 0;
  if (info.orbInfo.summonLevel == null) info.orbInfo.summonLevel = 1;

  const maxUid = info.artifacts.reduce((m, row) => Math.max(m, toSafeInt(row && row.uid, 0)), 300000);
  if (!Number.isFinite(Number(info.nextUid)) || toSafeInt(info.nextUid, 0) <= maxUid) {
    info.nextUid = maxUid + 1;
  }

  info.artifacts = info.artifacts.map((artifact) => normalizeArtifact(artifact, info));

  info.artifactMap = rebuildArtifactMap(info.artifacts);
  [1, 2].forEach((type) => {
    const equippedUid = toSafeInt(info.equipMap[type], 0);
    const exists = info.artifacts.some((row) => toSafeInt(row && row.uid, 0) === equippedUid);
    if (!exists) {
      delete info.equipMap[type];
    }
  });

  ensureOrbStructures(info);

  return info;
}

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

function isArtifactUpgradeFailOpenEnabled() {
  return parseBool(
    process.env.ARTIFACT_UPGRADE_FAIL_OPEN,
    String(process.env.NODE_ENV || '').toLowerCase() !== 'production'
  );
}

function getOrbConfigMap() {
  return config.get('OrbConfig') || {};
}

function listOrbIds() {
  return Object.keys(getOrbConfigMap())
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
}

function pickRandomOrbId() {
  const ids = listOrbIds();
  if (ids.length <= 0) return 9101;
  const idx = Math.max(0, Math.min(ids.length - 1, Math.floor(Math.random() * ids.length)));
  return ids[idx];
}

function normalizeOrbDataRow(raw, fallbackId = 0) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const id = Math.max(0, toSafeInt(row.id, fallbackId));
  return {
    id,
    level: Math.max(1, toSafeInt(row.level, 1)),
    star: Math.max(0, toSafeInt(row.star, 0)),
    subCount: Math.max(0, toSafeInt(row.subCount, 0)),
  };
}

function normalizeOrbSlotRow(raw, slot) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const index = Math.max(0, toSafeInt(row.index != null ? row.index : row.slot, slot));
  return {
    index,
    slot: index,
    orbId: Math.max(0, toSafeInt(row.orbId, 0)),
    level: Math.max(1, toSafeInt(row.level, 1)),
  };
}

function ensureOrbStructures(info) {
  info.orbInfo = info.orbInfo && typeof info.orbInfo === 'object' && !Array.isArray(info.orbInfo) ? info.orbInfo : {};
  const orbInfo = info.orbInfo;
  orbInfo.orbDataMap = orbInfo.orbDataMap && typeof orbInfo.orbDataMap === 'object' && !Array.isArray(orbInfo.orbDataMap)
    ? orbInfo.orbDataMap
    : {};
  orbInfo.slotData = Array.isArray(orbInfo.slotData) ? orbInfo.slotData : [];

  const orbCount = Math.max(1, toSafeInt((config.get('OrbBaseConfig') || {}).orbCount, 12));
  const slotCount = Math.max(6, Math.min(12, orbCount));
  if (orbInfo.slotData.length <= 0) {
    orbInfo.slotData = Array.from({ length: slotCount }).map((_, idx) => ({
      index: idx,
      slot: idx,
      orbId: 0,
      level: 1,
    }));
  } else {
    orbInfo.slotData = orbInfo.slotData.map((row, idx) => normalizeOrbSlotRow(row, idx));
  }

  const normalizedMap = {};
  Object.keys(orbInfo.orbDataMap).forEach((key) => {
    const id = Math.max(0, toSafeInt(key, 0));
    if (id <= 0) return;
    normalizedMap[id] = normalizeOrbDataRow(orbInfo.orbDataMap[key], id);
  });
  orbInfo.orbDataMap = normalizedMap;
  orbInfo.orbData = Object.keys(normalizedMap)
    .map((key) => normalizedMap[key])
    .sort((a, b) => a.id - b.id);
  orbInfo.maxLevel = Math.max(0, toSafeInt(orbInfo.maxLevel, 0));
  orbInfo.maxSlotLevel = Math.max(0, toSafeInt(orbInfo.maxSlotLevel, 0));
  orbInfo.summonLevel = Math.max(1, toSafeInt(orbInfo.summonLevel, 1));
}

function syncOrbDataFromMap(info) {
  ensureOrbStructures(info);
  const orbInfo = info.orbInfo;
  orbInfo.orbData = Object.keys(orbInfo.orbDataMap)
    .map((key) => normalizeOrbDataRow(orbInfo.orbDataMap[key], key))
    .sort((a, b) => a.id - b.id);
  orbInfo.maxLevel = Math.max(
    toSafeInt(orbInfo.maxLevel, 0),
    ...orbInfo.orbData.map((row) => toSafeInt(row.level, 1))
  );
  orbInfo.maxSlotLevel = Math.max(
    toSafeInt(orbInfo.maxSlotLevel, 0),
    ...orbInfo.slotData.map((row) => toSafeInt(row.level, 1))
  );
}

function upsertOrbData(info, orbId) {
  ensureOrbStructures(info);
  const id = Math.max(0, toSafeInt(orbId, 0));
  if (id <= 0) return normalizeOrbDataRow({ id: 0 }, 0);
  const key = String(id);
  if (!info.orbInfo.orbDataMap[key]) {
    info.orbInfo.orbDataMap[key] = normalizeOrbDataRow({ id, level: 1, star: 0, subCount: 0 }, id);
  }
  info.orbInfo.orbDataMap[key] = normalizeOrbDataRow(info.orbInfo.orbDataMap[key], id);
  return info.orbInfo.orbDataMap[key];
}

function buildOrbRewards(items = []) {
  const map = new Map();
  (Array.isArray(items) ? items : []).forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    map.set(id, (map.get(id) || 0) + count);
  });
  const list = [];
  map.forEach((count, id) => list.push({ id, count }));
  list.sort((a, b) => a.id - b.id);
  return { items: list, equips: [], heros: [] };
}

function findArtifactByUid(info, uid) {
  const targetUid = toSafeInt(uid, 0);
  return info.artifacts.find((row) => toSafeInt(row && row.uid, 0) === targetUid) || null;
}

function syncAfterArtifactChange(info) {
  info.artifactMap = rebuildArtifactMap(info.artifacts);
}

function getArtifactCurrentMaxLevel(artifact) {
  const baseCfg = config.get('ArtifactBaseConfig') || {};
  const forgeLevel = Math.max(1, toSafeInt(baseCfg.forgeLevel, 20));
  const quality = getArtifactQualityById(artifact && artifact.id);
  const consumeLevels = getArtifactConsumeLevelList(quality);
  const consumeMaxLevel = consumeLevels.length > 0 ? consumeLevels[consumeLevels.length - 1] : forgeLevel;
  if (!artifact || toSafeInt(artifact.skillGroup, 0) <= 0) return Math.min(forgeLevel, consumeMaxLevel);
  const qCfg = (config.get('ArtifactQuenchConfig') || {})[Math.max(0, toSafeInt(artifact.quenchLv, 0))];
  if (!qCfg) return Math.min(forgeLevel, consumeMaxLevel);
  return Math.min(Math.max(forgeLevel, toSafeInt(qCfg.levelmax, forgeLevel)), consumeMaxLevel);
}

function isArtifactForgeQualityAllowed(quality) {
  const baseCfg = config.get('ArtifactBaseConfig') || {};
  return quality >= Math.max(6, toSafeInt(baseCfg.forgeQuality || baseCfg.quenchQuality, 6));
}

function getArtifactFitSkillConfig(artifact) {
  const quality = getArtifactQualityById(artifact && artifact.id);
  const type = getArtifactTypeById(artifact && artifact.id);
  return getNestedConfig(config.get('ArtifactForgeSkillConfig') || {}, [artifact && artifact.attr && artifact.attr.type, quality, type]) || {};
}

function getArtifactFitSkillGroupId(artifact) {
  return Math.max(0, toSafeInt(getArtifactFitSkillConfig(artifact).skillGroupId, 0));
}

function getArtifactSkillGroups(type) {
  const baseCfg = config.get('ArtifactBaseConfig') || {};
  const key = toSafeInt(type, 1) === 2 ? 'eSkillGourps' : 'skillGourps';
  return (Array.isArray(baseCfg[key]) ? baseCfg[key] : [])
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .filter((id) => id > 0);
}

function pickArtifactSkillGroup(artifact, fitRate) {
  const fitSkillGroup = getArtifactFitSkillGroupId(artifact);
  if (fitSkillGroup > 0 && Math.random() * 100 < fitRate) return fitSkillGroup;
  const groups = getArtifactSkillGroups(getArtifactTypeById(artifact && artifact.id));
  const candidates = groups.filter((id) => id !== fitSkillGroup);
  if (candidates.length > 0) return candidates[Math.floor(Math.random() * candidates.length)];
  return fitSkillGroup || Math.max(0, toSafeInt(artifact && artifact.skillGroup, 0));
}

function getForgeConsumeRow(quality, count) {
  const baseCfg = config.get('ArtifactBaseConfig') || {};
  const forgeConsumeMap = baseCfg.forgeConsume || {};
  const qualityConsumes = forgeConsumeMap[quality] || forgeConsumeMap[String(quality)] || null;
  if (Array.isArray(qualityConsumes)) {
    return qualityConsumes[Math.max(0, Math.min(toSafeInt(count, 0), qualityConsumes.length - 1))] || null;
  }
  if (qualityConsumes && typeof qualityConsumes === 'object') {
    return qualityConsumes[count] || qualityConsumes[String(count)] || null;
  }
  return null;
}

function updateForgeSkillLevel(artifact, forgeCfg, quality) {
  const baseCfg = config.get('ArtifactBaseConfig') || {};
  const skillLvLimit = (baseCfg.skillLvLimit && baseCfg.skillLvLimit[quality]) || [1, 10];
  const minSkillLv = Math.max(1, toSafeInt(skillLvLimit[0], 1));
  const maxSkillLv = Math.max(minSkillLv, toSafeInt(skillLvLimit[1], 10));
  const current = Math.max(minSkillLv, Math.min(maxSkillLv, toSafeInt(artifact.skillLv, minSkillLv)));
  const upRate = Math.max(0, Math.min(100, toSafeInt(forgeCfg.upRate, 0)));
  const downRate = Math.max(0, Math.min(100 - upRate, toSafeInt(forgeCfg.downRate, 0)));
  const roll = Math.random() * 100;
  if (roll < upRate) return Math.min(maxSkillLv, current + 1);
  if (roll < upRate + downRate && current !== 4 && current !== 7) return Math.max(minSkillLv, current - 1);
  return current;
}

function maybeUnlockArtifactExtraAttr(artifact, level) {
  const baseCfg = config.get('ArtifactBaseConfig') || {};
  const conds = Array.isArray(baseCfg.eAttrLevelCond) ? baseCfg.eAttrLevelCond.map((v) => toSafeInt(v, 0)) : [];
  if (!conds.includes(toSafeInt(level, 0))) return;
  artifact.extraAttrs = Array.isArray(artifact.extraAttrs) ? artifact.extraAttrs : [];
  if (artifact.extraAttrs.some((row) => toSafeInt(row && row.level, 0) === toSafeInt(level, 0))) return;
  const fitCfg = getArtifactFitSkillConfig(artifact);
  const attrIds = Array.isArray(fitCfg.attr) ? fitCfg.attr : [];
  const attrCfg = config.get('ArtifactForgeAttrsConfig') || {};
  let attrType = 54;
  for (const id of attrIds) {
    const row = attrCfg[id] || attrCfg[String(id)] || null;
    if (row && toSafeInt(row.attrId, 0) > 0) {
      attrType = toSafeInt(row.attrId, 54);
      break;
    }
  }
  const quality = getArtifactQualityById(artifact.id);
  artifact.extraAttrs.push({ type: attrType, value: Math.max(10, quality * level), level });
}

function parseDecomposeUidList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  return Object.keys(raw).flatMap((key) => (Array.isArray(raw[key]) ? raw[key] : []));
}

function appendArtifactDecomposeRewards(rewardRows, artifact) {
  const quality = getArtifactQualityById(artifact && artifact.id);
  const level = Math.max(1, toSafeInt(artifact && artifact.attr && artifact.attr.level, 1));
  const consumeCfg = getArtifactConsumeLevelCfg(quality, level) || {};
  const beforeCount = rewardRows.length;
  rewardRows.push(...normalizeRewardRows(consumeCfg.returns));
  if (rewardRows.length === beforeCount) {
    rewardRows.push({ id: 52, count: Math.max(1, quality - 2) });
    rewardRows.push({ id: 2, count: Math.max(20, quality * 20) });
  }

  if (quality >= 7) {
    const forgeCfg = (config.get('ArtifactForgeConfig') || {})[
      Math.max(1, toSafeInt(artifact && artifact.skillGroup, 0) > 0 ? artifact.skillLv : 1)
    ] || {};
    const fitSkillGroup = getArtifactFitSkillGroupId(artifact);
    const isFit = fitSkillGroup > 0 && fitSkillGroup === toSafeInt(artifact && artifact.skillGroup, 0);
    rewardRows.push(...normalizeRewardRows(isFit ? forgeCfg.fitReturns : forgeCfg.unfitReturns));
  }

  const quenchCfg = (config.get('ArtifactQuenchConfig') || {})[Math.max(0, toSafeInt(artifact && artifact.quenchLv, 0))];
  if (quenchCfg) rewardRows.push(...normalizeRewardRows(quenchCfg.returns));
}

// 升级 (tag:3500)
async function handleArtifactUpgrade(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3500, msgUid, data: { result: -1, artifact: null } };

  const info = ensureArtifactInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const artifact = findArtifactByUid(info, uid);
  if (!artifact) return { tag: 3500, msgUid, data: { result: -1, artifact: null } };

  const useItem = toSafeInt(params && params.useItem, 0);
  const quality = getArtifactQualityById(artifact.id);
  const currentLevel = Math.max(1, toSafeInt(artifact.attr && artifact.attr.level, 1));
  const maxLevel = getArtifactCurrentMaxLevel(artifact);
  if (currentLevel >= maxLevel) {
    return { tag: 3500, msgUid, data: { result: 1, artifact } };
  }

  const consumeCfg = getArtifactConsumeLevelCfg(quality, currentLevel) || {};
  const consumes = Array.isArray(useItem > 0 ? consumeCfg.totalConsumes : consumeCfg.consumes)
    ? (useItem > 0 ? consumeCfg.totalConsumes : consumeCfg.consumes)
    : [];
  const touchedIds = consumes.map((cost) => toSafeInt(cost && cost.id, 0)).filter((id) => id > 0);
  const beforeCounts = Object.fromEntries(touchedIds.map((id) => [id, getItemOrCurrencyCount(player, id)]));
  let enough = true;
  for (const cost of consumes) {
    if (!hasEnoughItemOrCurrency(player, cost.id, cost.count)) {
      enough = false;
      break;
    }
  }
  if (!enough && !isArtifactUpgradeFailOpenEnabled()) return { tag: 3500, msgUid, data: { result: 1, artifact } };
  if (enough) consumes.forEach((cost) => consumeItemOrCurrency(player, cost.id, cost.count));

  const rate = Math.max(0, Math.min(100, toSafeInt(consumeCfg.rate, 100)));
  const success = isArtifactUpgradeFailOpenEnabled() || useItem > 0 || Math.random() * 100 < rate;
  let taskChanged = false;
  if (success) {
    artifact.attr.level = Math.min(maxLevel, currentLevel + 1);
    artifact.attr.value = Math.max(1, toSafeInt(artifact.attr.value, 0) + Math.max(10, quality * 10));
    maybeUnlockArtifactExtraAttr(artifact, artifact.attr.level);
    info.orbInfo.maxLevel = Math.max(toSafeInt(info.orbInfo.maxLevel, 0), toSafeInt(artifact.attr.level, 1));
    taskChanged = !!addArtifactUpgradeCount(player, Math.max(0, toSafeInt(artifact.attr.level, 1) - currentLevel));
  }

  await playerService.savePlayer(session.userId, player);
  const response = { tag: 3500, msgUid, data: { result: success ? 0 : 1, artifact } };
  const syncPacket = buildItemSyncPacket(player, beforeCounts, touchedIds);
  if (syncPacket || taskChanged) {
    return [
      ...(syncPacket ? [syncPacket] : []),
      ...(taskChanged ? buildTaskUpdatePacketsSafe(player) : []),
      response,
    ];
  }
  return response;
}

// 锻造 (tag:3501)
async function handleArtifactForge(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3501, msgUid, data: { result: -1, artifact: null } };

  const info = ensureArtifactInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const artifact = findArtifactByUid(info, uid);
  if (!artifact) return { tag: 3501, msgUid, data: { result: -1, artifact: null } };

  const baseCfg = config.get('ArtifactBaseConfig') || {};
  const forgeMax = Math.max(1, toSafeInt(baseCfg.forgeCountMax, 7));
  const quality = getArtifactQualityById(artifact.id);
  const currentCount = Math.max(0, toSafeInt(artifact.count, 0));
  const now = Date.now();
  if (!isArtifactForgeQualityAllowed(quality)
    || Math.max(1, toSafeInt(artifact.attr && artifact.attr.level, 1)) < Math.max(1, toSafeInt(baseCfg.forgeLevel, 20))
    || currentCount >= forgeMax
    || (toSafeInt(artifact.forgeTime, 0) > 0 && toSafeInt(artifact.forgeTime, 0) <= now)
    || getArtifactFitSkillGroupId(artifact) <= 0) {
    return { tag: 3501, msgUid, data: { result: -1, artifact } };
  }
  const nextCount = Math.min(forgeMax, currentCount + 1);
  const forgeCfg = (config.get('ArtifactForgeConfig') || {})[nextCount] || (config.get('ArtifactForgeConfig') || {})[String(nextCount)] || {};

  const consumeRow = getForgeConsumeRow(quality, currentCount);
  if (consumeRow && !hasEnoughItemOrCurrency(player, consumeRow.id, consumeRow.count)) {
    return { tag: 3501, msgUid, data: { result: -1, artifact } };
  }
  if (consumeRow) consumeItemOrCurrency(player, consumeRow.id, consumeRow.count);

  artifact.count = nextCount;
  if (toSafeInt(artifact.forgeTime, 0) <= 0) {
    artifact.forgeTime = now + Math.max(1, toSafeInt(baseCfg.forgeTimeHours, 24)) * 60 * 60 * 1000;
  }

  const fitRate = Math.max(0, Math.min(100, toSafeInt(forgeCfg.fitRate, 0)));
  artifact.skillLv = updateForgeSkillLevel(artifact, forgeCfg, quality);
  artifact.skillGroup = pickArtifactSkillGroup(artifact, fitRate);
  const fitSkillCfg = getArtifactFitSkillConfig(artifact);
  artifact.eSkillGroup = Math.max(0, toSafeInt(fitSkillCfg.eSkillGroup || artifact.eSkillGroup, artifact.eSkillGroup || 0));

  syncAfterArtifactChange(info);
  await playerService.savePlayer(session.userId, player);
  return { tag: 3501, msgUid, data: { result: 0, artifact } };
}

// 穿戴 (tag:3502)
async function handleArtifactEquip(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3502, msgUid, data: { result: -1, equipMap: {} } };

  const info = ensureArtifactInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const artifact = findArtifactByUid(info, uid);
  if (!artifact) return { tag: 3502, msgUid, data: { result: -1, equipMap: info.equipMap } };

  const type = getArtifactTypeById(artifact.id);
  info.equipMap[type] = artifact.uid;

  await playerService.savePlayer(session.userId, player);
  return { tag: 3502, msgUid, data: { result: 0, equipMap: info.equipMap } };
}

async function handleArtifactDecompose(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 3503,
      msgUid,
      data: {
        result: -1,
        uids: {},
        rewardInfo: { items: [], equips: [], extra: [] },
      },
    };
  }

  const info = ensureArtifactInfo(player);
  const uidList = parseDecomposeUidList(params && params.uids);
  const removeSet = new Set(uidList.map((v) => toSafeInt(v, 0)).filter((v) => v > 0));
  const removedByType = {};
  const rewardRows = [];

  info.artifacts = info.artifacts.filter((row) => {
    const uid = toSafeInt(row && row.uid, 0);
    if (!removeSet.has(uid)) return true;
    const lock = toSafeInt(row && row.lock, 0) > 0;
    if (lock) return true;

    const artifactId = toSafeInt(row && row.id, 0);
    const type = getArtifactTypeById(artifactId);
    if (!removedByType[type]) removedByType[type] = [];
    removedByType[type].push(uid);

    appendArtifactDecomposeRewards(rewardRows, row);
    return false;
  });

  info.artifactMap = rebuildArtifactMap(info.artifacts);
  [1, 2].forEach((type) => {
    const equippedUid = toSafeInt(info.equipMap[type], 0);
    const exists = info.artifacts.some((row) => toSafeInt(row && row.uid, 0) === equippedUid);
    if (!exists) {
      const list = info.artifactMap[type] || [];
      info.equipMap[type] = list.length > 0 ? toSafeInt(list[0].uid, 0) : 0;
    }
  });

  const rewardMap = new Map();
  rewardRows.forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    rewardMap.set(id, (rewardMap.get(id) || 0) + count);
  });
  const rewardInfo = { items: [], equips: [], extra: [] };
  rewardMap.forEach((count, id) => {
    addRewardToPlayer(player, id, count);
    rewardInfo.items.push({ id, count });
  });
  rewardInfo.items.sort((a, b) => a.id - b.id);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 3503,
    msgUid,
    data: {
      result: 0,
      uids: removedByType,
      rewardInfo,
    },
  };
}

// 锁定 (tag:3504)
async function handleArtifactLock(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3504, msgUid, data: { result: -1, artifact: null } };

  const info = ensureArtifactInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const artifact = findArtifactByUid(info, uid);
  if (!artifact) return { tag: 3504, msgUid, data: { result: -1, artifact: null } };

  artifact.lock = toSafeInt(params && params.lock, 0) > 0 ? 1 : 0;

  await playerService.savePlayer(session.userId, player);
  return { tag: 3504, msgUid, data: { result: 0, artifact } };
}

// 淬炼 (tag:3505)
async function handleArtifactQuench(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3505, msgUid, data: { result: -1, artifact: null } };

  const info = ensureArtifactInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const artifact = findArtifactByUid(info, uid);
  if (!artifact) return { tag: 3505, msgUid, data: { result: -1, artifact: null } };

  const nextQuenchCfg = (config.get('ArtifactQuenchConfig') || {})[Math.max(0, toSafeInt(artifact.quenchLv, 0)) + 1];
  if (!nextQuenchCfg) {
    return { tag: 3505, msgUid, data: { result: -1, artifact } };
  }

  const consumes = Array.isArray(nextQuenchCfg.consumes) ? nextQuenchCfg.consumes : [];
  for (const cost of consumes) {
    if (hasEnoughItemOrCurrency(player, cost.id, cost.count)) {
      consumeItemOrCurrency(player, cost.id, cost.count);
    }
  }

  const element = Math.max(1, toSafeInt(params && params.element, artifact.element || 1));
  artifact.element = element;
  artifact.quenchLv = Math.max(0, toSafeInt(artifact.quenchLv, 0) + 1);
  artifact.refreshCache = null;

  await playerService.savePlayer(session.userId, player);
  return { tag: 3505, msgUid, data: { result: 0, artifact } };
}

// 淬炼刷新 (tag:3506)
async function handleArtifactQuenchRefresh(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3506, msgUid, data: { result: -1, refreshCache: null } };

  const info = ensureArtifactInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const artifact = findArtifactByUid(info, uid);
  if (!artifact) return { tag: 3506, msgUid, data: { result: -1, refreshCache: null } };

  const baseCfg = config.get('ArtifactBaseConfig') || {};
  const resetConsume = Array.isArray(baseCfg.resetConsume) ? baseCfg.resetConsume : [];
  let ok = true;
  for (const cost of resetConsume) {
    if (!hasEnoughItemOrCurrency(player, cost.id, cost.count)) {
      ok = false;
      break;
    }
  }
  if (!ok) return { tag: 3506, msgUid, data: { result: -1, refreshCache: artifact.refreshCache || null } };
  resetConsume.forEach((cost) => consumeItemOrCurrency(player, cost.id, cost.count));

  const nextElement = Math.max(1, toSafeInt(params && params.element, 1));
  artifact.refreshCache = {
    element: nextElement,
    quenchLv: Math.max(0, toSafeInt(artifact.quenchLv, 0)),
    ts: Date.now(),
  };

  await playerService.savePlayer(session.userId, player);
  return { tag: 3506, msgUid, data: { result: 0, refreshCache: artifact.refreshCache } };
}

// 淬炼刷新确认 (tag:3507)
async function handleArtifactQuenchRefreshConfirm(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3507, msgUid, data: { result: -1, artifact: null } };

  const info = ensureArtifactInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const artifact = findArtifactByUid(info, uid);
  if (!artifact) return { tag: 3507, msgUid, data: { result: -1, artifact: null } };

  const cache = artifact.refreshCache && typeof artifact.refreshCache === 'object'
    ? artifact.refreshCache
    : null;
  if (cache) {
    if (cache.element != null) artifact.element = Math.max(1, toSafeInt(cache.element, artifact.element || 1));
    if (cache.quenchLv != null) artifact.quenchLv = Math.max(0, toSafeInt(cache.quenchLv, artifact.quenchLv || 0));
    artifact.refreshCache = null;
  }

  await playerService.savePlayer(session.userId, player);
  return { tag: 3507, msgUid, data: { result: 0, artifact } };
}

// 绑定灵珠到槽位 (tag:6400)
async function handleArtifactOrbSet(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6400, msgUid, data: { result: -1, slot: 0, id: 0 } };

  const info = ensureArtifactInfo(player);
  ensureOrbStructures(info);
  const slot = Math.max(0, toSafeInt(params && params.slot, 0));
  const id = Math.max(0, toSafeInt(params && params.id, 0));

  while (info.orbInfo.slotData.length <= slot) {
    info.orbInfo.slotData.push(normalizeOrbSlotRow({}, info.orbInfo.slotData.length));
  }
  const slotRow = normalizeOrbSlotRow(info.orbInfo.slotData[slot], slot);
  slotRow.orbId = id;
  if (id > 0) {
    const orb = upsertOrbData(info, id);
    slotRow.level = Math.max(1, toSafeInt(orb.level, 1));
  }
  info.orbInfo.slotData[slot] = slotRow;
  syncOrbDataFromMap(info);

  await playerService.savePlayer(session.userId, player);
  return { tag: 6400, msgUid, data: { result: 0, slot, id } };
}

// 交换灵珠槽位 (tag:6406)
async function handleArtifactOrbChange(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 6406, msgUid, data: { result: -1, slot: 0, id: 0, newSlot: 0, newId: 0 } };
  }

  const info = ensureArtifactInfo(player);
  ensureOrbStructures(info);
  const slot = Math.max(0, toSafeInt(params && params.slot, 0));
  const newSlot = Math.max(0, toSafeInt(params && params.newSlot, 0));

  while (info.orbInfo.slotData.length <= Math.max(slot, newSlot)) {
    info.orbInfo.slotData.push(normalizeOrbSlotRow({}, info.orbInfo.slotData.length));
  }

  const source = normalizeOrbSlotRow(info.orbInfo.slotData[slot], slot);
  const target = normalizeOrbSlotRow(info.orbInfo.slotData[newSlot], newSlot);
  const sourceOrb = source.orbId;
  source.orbId = target.orbId;
  target.orbId = sourceOrb;
  info.orbInfo.slotData[slot] = source;
  info.orbInfo.slotData[newSlot] = target;
  syncOrbDataFromMap(info);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6406,
    msgUid,
    data: {
      result: 0,
      slot,
      id: source.orbId,
      newSlot,
      newId: target.orbId,
    },
  };
}

// 灵珠升级 (tag:6401)
async function handleArtifactOrbLevelUp(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6401, msgUid, data: { result: -1, level: 0 } };

  const info = ensureArtifactInfo(player);
  ensureOrbStructures(info);
  const slot = Math.max(0, toSafeInt(params && params.slot, 0));
  const level = Math.max(1, toSafeInt(params && params.level, 1));

  while (info.orbInfo.slotData.length <= slot) {
    info.orbInfo.slotData.push(normalizeOrbSlotRow({}, info.orbInfo.slotData.length));
  }
  const row = normalizeOrbSlotRow(info.orbInfo.slotData[slot], slot);
  row.level = level;
  info.orbInfo.slotData[slot] = row;
  if (row.orbId > 0) {
    const orb = upsertOrbData(info, row.orbId);
    orb.level = Math.max(1, level);
  }
  syncOrbDataFromMap(info);

  await playerService.savePlayer(session.userId, player);
  return { tag: 6401, msgUid, data: { result: 0, level } };
}

// 灵珠升星 (tag:6402)
async function handleArtifactOrbStarUp(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6402, msgUid, data: { result: -1, data: null } };

  const info = ensureArtifactInfo(player);
  ensureOrbStructures(info);
  const id = Math.max(0, toSafeInt(params && params.id, 0));
  const star = Math.max(0, toSafeInt(params && params.star, 0));
  const orb = upsertOrbData(info, id);
  orb.star = star;
  syncOrbDataFromMap(info);

  await playerService.savePlayer(session.userId, player);
  return { tag: 6402, msgUid, data: { result: 0, data: orb } };
}

// 图鉴/发现灵珠 (tag:6404)
async function handleArtifactOrbAtlas(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6404, msgUid, data: { result: -1, data: null } };

  const info = ensureArtifactInfo(player);
  ensureOrbStructures(info);
  const id = Math.max(0, toSafeInt(params && params.id, 0));
  const orb = upsertOrbData(info, id);
  syncOrbDataFromMap(info);

  await playerService.savePlayer(session.userId, player);
  return { tag: 6404, msgUid, data: { result: 0, data: orb } };
}

// 灵珠召唤 (tag:6403)
async function handleArtifactOrbSummon(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6403, msgUid, data: { result: -1, level: 0, results: [] } };

  const info = ensureArtifactInfo(player);
  ensureOrbStructures(info);
  const count = Math.max(1, Math.min(10, toSafeInt(params && params.count, 1)));
  const results = [];

  for (let i = 0; i < count; i += 1) {
    const orbId = pickRandomOrbId();
    const orb = upsertOrbData(info, orbId);
    orb.subCount = Math.max(0, toSafeInt(orb.subCount, 0)) + 1;
    results.push({ id: orbId, count: 1 });
  }

  info.orbInfo.summonLevel = Math.max(1, toSafeInt(info.orbInfo.summonLevel, 1) + count);
  syncOrbDataFromMap(info);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6403,
    msgUid,
    data: {
      result: 0,
      level: info.orbInfo.summonLevel,
      results,
    },
  };
}

// 灵珠分解 (tag:6405)
async function handleArtifactOrbDecompose(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6405, msgUid, data: { result: -1, ids: [], rewards: buildOrbRewards([]) } };

  const info = ensureArtifactInfo(player);
  ensureOrbStructures(info);
  const ids = Array.from(
    new Set(
      (Array.isArray(params && params.ids) ? params.ids : [])
        .map((id) => Math.max(0, toSafeInt(id, 0)))
        .filter((id) => id > 0)
    )
  );

  const rewards = [];
  const changedIds = [];
  ids.forEach((id) => {
    const key = String(id);
    const row = info.orbInfo.orbDataMap[key];
    if (!row) return;
    const subCount = Math.max(0, toSafeInt(row.subCount, 0));
    if (subCount > 0) {
      rewards.push({ id: 205, count: subCount * 2 });
    }
    row.subCount = 0;
    changedIds.push(id);
  });

  const rewardInfo = buildOrbRewards(rewards);
  rewardInfo.items.forEach((reward) => addRewardToPlayer(player, reward.id, reward.count));
  syncOrbDataFromMap(info);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6405,
    msgUid,
    data: {
      result: 0,
      ids: changedIds,
      rewards: rewardInfo,
    },
  };
}

module.exports = {
  ensureArtifactInfo,
  handleArtifactUpgrade,
  handleArtifactForge,
  handleArtifactEquip,
  handleArtifactDecompose,
  handleArtifactLock,
  handleArtifactQuench,
  handleArtifactQuenchRefresh,
  handleArtifactQuenchRefreshConfirm,
  handleArtifactOrbSet,
  handleArtifactOrbLevelUp,
  handleArtifactOrbStarUp,
  handleArtifactOrbSummon,
  handleArtifactOrbAtlas,
  handleArtifactOrbDecompose,
  handleArtifactOrbChange,
};
