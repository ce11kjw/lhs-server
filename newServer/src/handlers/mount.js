/**
 * 坐骑（剑灵）系统
 * tag: 3200 装备, 3201 刷新可召唤列表, 3202 设置心愿,
 *      3203 召唤, 3204 升级, 3205 吞噬
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const {
  addMountRideCount,
  addMountSummonCount,
  addMountUpgradeCount,
} = require('../services/MainTaskProgressService');
const { addRewardToPlayer } = require('./raid');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function buildMountAttrs(swordId, quality, level = 1, star = 1, _uid = 0) {
  // 坐骑"自身"属性 = 等级属性(SwordLevelConfig) + 星级属性(SwordStarLevelConfig)
  // 词条属性与羁绊属性由 BattleService.addMountAttrs 单独累加，此处不重复计算。
  const q = Math.max(2, toSafeInt(quality, getSwordQualityById(swordId)));
  const lv = Math.max(1, toSafeInt(level, 1));
  const st = Math.max(0, toSafeInt(star, 0));

  const sumAttrs = (target, attrs) => {
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return target;
    Object.keys(attrs).forEach((key) => {
      const attrId = toSafeInt(key, 0);
      const value = toSafeInt(attrs[key], 0);
      if (attrId <= 0 || value === 0) return;
      target[attrId] = (target[attrId] || 0) + value;
    });
    return target;
  };

  const pickRow = (table, quality2, level2) => {
    if (!table) return null;
    const qMap = table[quality2] || table[String(quality2)] || null;
    if (!qMap) return null;
    return qMap[level2] || qMap[String(level2)] || null;
  };

  const out = {};
  const levelCfg = config.get('SwordLevelConfig') || {};
  const starCfg = config.get('SwordStarLevelConfig') || {};

  const levelRow = pickRow(levelCfg, q, lv);
  if (levelRow) sumAttrs(out, levelRow.attrs);

  const starRow = pickRow(starCfg, q, st);
  if (starRow) sumAttrs(out, starRow.attrs);

  // 兜底：配置缺失时保持客户端可用的最小属性，避免出现空 attrs
  if (Object.keys(out).length === 0) {
    const fallbackQ = Math.max(2, toSafeInt(quality, 2));
    const base = 400 + (fallbackQ - 2) * 200;
    out[51] = base;
    out[52] = base;
    out[53] = base;
  }
  return out;
}

function getMountSkillConds(swordId) {
  const swordCfg = config.get('SwordConfig') || {};
  const row = swordCfg[toSafeInt(swordId, 0)] || swordCfg[String(toSafeInt(swordId, 0))] || null;
  const conds = row && Array.isArray(row.skillConds) ? row.skillConds : null;
  if (!conds || conds.length === 0) return [];
  return conds.map((v) => toSafeInt(v, 0)).filter((v) => v > 0);
}

function getMountSkillMaxLevel(quality) {
  const table = config.get('SwordPassiveSkillConfig') || {};
  const anyAttr = table[101] || table[String(101)] || {};
  const qMap = anyAttr[toSafeInt(quality, 0)] || anyAttr[String(toSafeInt(quality, 0))] || anyAttr[3] || {};
  const levels = Object.keys(qMap).map((k) => toSafeInt(k, 0)).filter((v) => v > 0);
  return levels.length > 0 ? Math.max(...levels) : 10;
}

// 星级 -> 词条等级：星级每突破一个 skillConds 阈值，所有已生效词条 +1 级。
function computeMountSkillLevel(star, conds) {
  const s = Math.max(0, toSafeInt(star, 0));
  let level = 0;
  for (let i = 0; i < conds.length; i += 1) {
    if (s >= toSafeInt(conds[i], 0)) level += 1;
  }
  return level; // 0 表示还没解锁任何词条等级
}

// 把 mount.skills 的等级同步到当前星级应有的水平。返回升级后的词条数量。
function syncMountSkillLevels(mount) {
  if (!mount || typeof mount !== 'object') return 0;
  const conds = getMountSkillConds(mount.id);
  if (conds.length === 0) return 0;
  const maxLevel = getMountSkillMaxLevel(mount.quality);
  const targetLevel = Math.min(maxLevel, computeMountSkillLevel(mount.star, conds));
  if (targetLevel <= 0) return 0;
  const skills = Array.isArray(mount.skills) ? mount.skills : [];
  let changed = 0;
  skills.forEach((skill) => {
    if (!skill || typeof skill !== 'object') return;
    const current = Math.max(1, toSafeInt(skill.level, 1));
    if (current === targetLevel) return;
    skill.level = targetLevel;
    changed += 1;
  });
  return changed;
}

function isMountUpgradeFailOpenEnabled() {
  return parseBool(
    process.env.MOUNT_UPGRADE_FAIL_OPEN,
    String(process.env.NODE_ENV || '').toLowerCase() !== 'production',
  );
}

function getCurrencyKeyById(itemId) {
  switch (toSafeInt(itemId, 0)) {
    case 1: return 'diamond';
    case 2: return 'silver';
    case 6: return 'gold';
    default: return null;
  }
}

function consumeItemOrCurrency(player, itemId, count) {
  const id = toSafeInt(itemId, 0);
  const need = toSafeInt(count, 0);
  if (id <= 0 || need <= 0) return true;

  const currKey = getCurrencyKeyById(id);
  if (currKey) {
    player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
    const cur = toSafeInt(player.currencies[currKey], 0);
    if (cur < need) return false;
    player.currencies[currKey] = cur - need;
    return true;
  }

  player.items = player.items || {};
  const cur = toSafeInt(player.items[id], 0);
  if (cur < need) return false;
  player.items[id] = cur - need;
  return true;
}

function getSwordQualityById(swordId) {
  const swordCfg = config.get('SwordConfig') || {};
  const row = swordCfg[swordId] || swordCfg[String(swordId)];
  if (row) return Math.max(2, toSafeInt(row.quality, 2));
  return 2;
}

function getSwordRow(swordId) {
  const id = toSafeInt(swordId, 0);
  if (id <= 0) return null;
  const swordCfg = config.get('SwordConfig') || {};
  const assetsCfg = config.get('AssetsConfig') || {};
  const row = swordCfg[id] || swordCfg[String(id)] || null;
  const asset = assetsCfg[id] || assetsCfg[String(id)] || null;
  if (!row || !asset) return null;
  return { ...row, id, quality: Math.max(2, toSafeInt(row.quality, toSafeInt(asset.quality, 2))) };
}

function isValidSwordId(swordId) {
  return !!getSwordRow(swordId);
}

function getFallbackSwordId(preferredQuality = 2) {
  const swordCfg = config.get('SwordConfig') || {};
  const ids = Object.keys(swordCfg)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0 && isValidSwordId(id))
    .sort((a, b) => a - b);
  const quality = toSafeInt(preferredQuality, 0);
  return ids.find((id) => getSwordQualityById(id) === quality) || ids[0] || 22101;
}

function normalizeSwordId(swordId, preferredQuality = 2) {
  const id = toSafeInt(swordId, 0);
  return isValidSwordId(id) ? id : getFallbackSwordId(preferredQuality);
}

function clampMountLevel(quality, level) {
  const levelCfg = config.get('SwordLevelConfig') || {};
  const qualityCfg = levelCfg[toSafeInt(quality, 0)] || levelCfg[String(toSafeInt(quality, 0))] || {};
  const levels = Object.keys(qualityCfg).map((key) => toSafeInt(key, 0)).filter((id) => id > 0);
  const maxLevel = levels.length > 0 ? Math.max(...levels) : 1;
  return Math.max(1, Math.min(maxLevel, toSafeInt(level, 1)));
}

function clampMountStar(quality, star) {
  const starCfg = config.get('SwordStarLevelConfig') || {};
  const qualityCfg = starCfg[toSafeInt(quality, 0)] || starCfg[String(toSafeInt(quality, 0))] || {};
  const stars = Object.keys(qualityCfg).map((key) => toSafeInt(key, 0)).filter((id) => id > 0);
  const maxStar = stars.length > 0 ? Math.max(...stars) : 1;
  return Math.max(0, Math.min(maxStar, toSafeInt(star, 1)));
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
  return valid[valid.length - 1] || null;
}

function buildMountRewardPayload(rewards = []) {
  return {
    items: Array.isArray(rewards) ? rewards : [],
    equips: [],
    swords: [],
    pets: [],
    artifacts: [],
    gems: [],
    valhalla: [],
    bloodline: [],
    fashion: [],
    elves: [],
    sailor: [],
    extraReward: {},
  };
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

function buildMountCostSync(player, itemId, beforeCount) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return null;
  const afterCount = getItemOrCurrencyCount(player, id);
  if (afterCount === Math.max(0, toSafeInt(beforeCount, 0))) return null;
  return {
    tag: 1202,
    msgUid: 0,
    data: {
      result: 0,
      items: [{ id, count: afterCount - Math.max(0, toSafeInt(beforeCount, 0)) }],
      changed: [{ id, count: afterCount }],
    },
  };
}

function buildMountRewardSync(player, rewards = []) {
  const items = (Array.isArray(rewards) ? rewards : [])
    .map((row) => ({
      id: Math.max(0, toSafeInt(row && row.id, 0)),
      count: Math.max(0, toSafeInt(row && row.count, 0)),
    }))
    .filter((row) => row.id > 0 && row.count > 0);
  if (items.length <= 0) return null;
  return {
    tag: 1202,
    msgUid: 0,
    data: {
      result: 0,
      items,
      changed: items.map((row) => ({
        id: row.id,
        count: getItemOrCurrencyCount(player, row.id),
      })),
    },
  };
}

function buildMountRewardResponse(rewards = []) {
  return buildMountRewardPayload(rewards);
}

function normalizeMountSkills(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => buildMountPassiveSkill(
      row && row.id,
      row && row.quality,
      row && row.level
    ))
    .filter((row) => row && row.id > 0);
}

function getSwordPassiveSkillConfig() {
  return config.get('SwordPassiveSkillConfig') || {};
}

function getMountPassiveSkillCount(quality) {
  const baseCfg = config.get('SwordBaseConfig') || {};
  const countCfg = baseCfg.passiveSkillInitialCount || {};
  return Math.max(0, toSafeInt(countCfg[toSafeInt(quality, 0)], 0));
}

function getMountPrimaryPassiveAttrId(swordId) {
  const suffix = toSafeInt(swordId, 0) % 100;
  const primaryId = 100 + suffix;
  const passiveCfg = getSwordPassiveSkillConfig();
  return passiveCfg[primaryId] ? primaryId : 101;
}

function getMountPassiveSkillQuality() {
  const baseCfg = config.get('SwordBaseConfig') || {};
  const rateCfg = baseCfg.passiveSkillRefreshRate || {};
  const entries = Object.keys(rateCfg)
    .map((key) => ({ id: toSafeInt(key, 0), weight: Math.max(0, toSafeInt(rateCfg[key], 0)) }))
    .filter((row) => row.id > 0 && row.weight > 0)
    .sort((a, b) => a.id - b.id);
  const picked = randomPickWeighted(entries);
  return picked ? picked.id : 3;
}

function listMountPassiveAttrIds() {
  return Object.keys(getSwordPassiveSkillConfig())
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
}

function buildMountPassiveSkill(attrId, quality, level = 1) {
  const passiveCfg = getSwordPassiveSkillConfig();
  const requestedAttrId = toSafeInt(attrId, 0);
  const fallbackAttrId = listMountPassiveAttrIds()[0] || 101;
  const safeAttrId = passiveCfg[requestedAttrId] ? requestedAttrId : fallbackAttrId;
  const attrMap = passiveCfg[safeAttrId] || {};
  const qualityKeys = Object.keys(attrMap)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
  const targetQuality = attrMap[toSafeInt(quality, 0)]
    ? toSafeInt(quality, 0)
    : (qualityKeys.find((id) => id >= toSafeInt(quality, 0)) || qualityKeys[0] || 3);
  const levelMap = attrMap[targetQuality] || attrMap[String(targetQuality)] || {};
  const levelKeys = Object.keys(levelMap)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
  const maxLevel = levelKeys.length > 0 ? levelKeys[levelKeys.length - 1] : 1;
  return {
    id: Math.max(1, safeAttrId),
    quality: Math.max(1, targetQuality),
    level: Math.max(1, Math.min(maxLevel, toSafeInt(level, 1))),
  };
}

function buildMountPassiveSkills(swordId, quality) {
  const count = getMountPassiveSkillCount(quality);
  if (count <= 0) return [];

  const passiveIds = listMountPassiveAttrIds();
  const primaryId = getMountPrimaryPassiveAttrId(swordId);
  const secondaryPool = passiveIds.filter((id) => id !== primaryId);
  const skills = [];

  skills.push(buildMountPassiveSkill(primaryId, getMountPassiveSkillQuality(), 1));
  while (skills.length < count) {
    const pool = secondaryPool.length > 0 ? secondaryPool : passiveIds;
    const attrId = pool[Math.floor(Math.random() * pool.length)] || primaryId;
    skills.push(buildMountPassiveSkill(attrId, getMountPassiveSkillQuality(), 1));
  }
  return skills.slice(0, count);
}

function fillMountPassiveSkills(row) {
  const next = row;
  if (Array.isArray(next.skills) && next.skills.length > 0) return next;
  next.skills = buildMountPassiveSkills(next.id, next.quality);
  next.passiveSkills = next.skills;
  return next;
}

function normalizeMountRow(row = {}) {
  const normalized = row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : {};
  const skills = Array.isArray(normalized.skills) ? normalized.skills : normalized.passiveSkills;
  const uid = Math.max(0, toSafeInt(normalized.uid, 0));
  const id = normalizeSwordId(normalized.id, normalized.quality);
  const quality = getSwordQualityById(id);
  const level = clampMountLevel(quality, normalized.level);
  const star = clampMountStar(quality, normalized.star);
  const next = {
    ...normalized,
    uid,
    id,
    quality,
    level,
    star,
    lock: toSafeInt(normalized.lock, 0) > 0 ? 1 : 0,
    exp: Math.max(0, toSafeInt(normalized.exp, 0)),
    attrs: buildMountAttrs(id, quality, level, star, uid),
    skills: normalizeMountSkills(skills),
  };
  next.passiveSkills = next.skills;
  // 词条等级由星级推导，读档时统一校正（同时修复历史错误数据）
  syncMountSkillLevels(next);
  return fillMountPassiveSkills(next);
}

function normalizeIdList(list = []) {
  if (!Array.isArray(list)) return [];
  return list
    .map((value) => toSafeInt(value, 0))
    .filter((value, idx, arr) => value > 0 && arr.indexOf(value) === idx)
    .sort((a, b) => a - b);
}

function syncMountUnlockStats(info) {
  const ownedSwordIds = Array.isArray(info.data)
    ? info.data.map((row) => toSafeInt(row && row.id, 0)).filter((id) => id > 0)
    : [];
  info.unlockedSwords = normalizeIdList([...(Array.isArray(info.unlockedSwords) ? info.unlockedSwords : []), ...ownedSwordIds])
    .filter((id) => isValidSwordId(id));

  const unlockedSet = new Set(info.unlockedSwords);
  const bondCfg = config.get('SwordBondConfig') || {};
  const activeBondIds = Object.keys(bondCfg)
    .map((key) => {
      const row = bondCfg[key];
      const bondId = toSafeInt(row && row.id, toSafeInt(key, 0));
      const bonds = Array.isArray(row && row.bonds) ? row.bonds : [];
      if (bondId <= 0 || bonds.length <= 0) return 0;
      return bonds.every((id) => unlockedSet.has(toSafeInt(id, 0))) ? bondId : 0;
    })
    .filter((id) => id > 0);
  info.swordBond = normalizeIdList([...(Array.isArray(info.swordBond) ? info.swordBond : []), ...activeBondIds]);
}

function createMountRecord(info, swordId, overrides = {}) {
  return normalizeMountRow({
    uid: info.nextUid++,
    id: toSafeInt(swordId, 0),
    quality: getSwordQualityById(swordId),
    level: 1,
    star: 1,
    lock: 0,
    exp: 0,
    attrs: {},
    skills: [],
    ...overrides,
  });
}

function ensureMountInfo(player) {
  const baseCfg = config.get('SwordBaseConfig') || {};
  const initSwords = Array.isArray(baseCfg.initSword) ? baseCfg.initSword : [];

  player.swordInfo = player.swordInfo && typeof player.swordInfo === 'object' && !Array.isArray(player.swordInfo)
    ? player.swordInfo
    : {};
  const info = player.swordInfo;

  if (!Array.isArray(info.data)) info.data = [];
  if (!Array.isArray(info.unlockedSwords)) info.unlockedSwords = [];
  if (!Array.isArray(info.optionalSwords)) info.optionalSwords = [];
  if (!Array.isArray(info.summonedIds)) info.summonedIds = [];
  if (!Array.isArray(info.loglist)) info.loglist = [];
  if (!Array.isArray(info.skills)) info.skills = [];
  if (!Array.isArray(info.autoPriority)) info.autoPriority = [];
  if (!Array.isArray(info.swordBond)) info.swordBond = [];
  if (info.gridCount == null) info.gridCount = Math.max(1, toSafeInt(baseCfg.gridInitialCount, 6));
  if (info.equippedUid == null) info.equippedUid = 0;
  if (info.wishId == null) info.wishId = 0;
  if (info.wishCounter == null) info.wishCounter = 0;
  if (info.bestCounter == null) info.bestCounter = 0;
  if (info.adFreeCounter == null) info.adFreeCounter = 0;
  if (info.skinId == null) info.skinId = 0;
  info.wishId = isValidSwordId(info.wishId) ? toSafeInt(info.wishId, 0) : 0;
  info.skinId = isValidSwordId(info.skinId) ? toSafeInt(info.skinId, 0) : 0;

  info.data = info.data
    .map((row) => normalizeMountRow(row))
    .filter((row) => row.uid > 0 && row.id > 0);
  info.optionalSwords = info.optionalSwords
    .map((row) => normalizeMountRow({ level: 1, star: 0, lock: 0, ...row }))
    .filter((row) => row.uid > 0 && row.id > 0);

  const maxUid = info.data.reduce((m, row) => Math.max(m, toSafeInt(row && row.uid, 0)), 0);
  if (!Number.isFinite(Number(info.nextUid)) || toSafeInt(info.nextUid, 0) <= maxUid) {
    info.nextUid = Math.max(100001, maxUid + 1);
  }

  if (info.data.length === 0 && initSwords.length > 0) {
    initSwords.forEach((swordId) => {
      const id = normalizeSwordId(swordId);
      if (!isValidSwordId(id)) return;
      const mount = createMountRecord(info, id);
      info.data.push(mount);
      info.unlockedSwords.push(id);
    });
  }

  syncMountUnlockStats(info);

  if (!info.equippedUid && info.data.length > 0) {
    info.equippedUid = toSafeInt(info.data[0].uid, 0);
  }
  if (info.equippedUid && !info.data.some((row) => toSafeInt(row && row.uid, 0) === toSafeInt(info.equippedUid, 0))) {
    info.equippedUid = info.data.length > 0 ? toSafeInt(info.data[0].uid, 0) : 0;
  }

  return info;
}

function pickWeightedQuality() {
  const baseCfg = config.get('SwordBaseConfig') || {};
  const weights = baseCfg.callprobabilityShow || {};
  const entries = Object.keys(weights)
    .map((k) => [toSafeInt(k, 0), toSafeInt(weights[k], 0)])
    .filter((row) => row[0] > 0 && row[1] > 0);
  if (entries.length === 0) return 2;
  const total = entries.reduce((sum, row) => sum + row[1], 0);
  let roll = Math.random() * total;
  for (const [quality, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return quality;
  }
  return entries[entries.length - 1][0];
}

function pickSwordIdByQuality(quality) {
  const swordCfg = config.get('SwordConfig') || {};
  const pool = Object.keys(swordCfg)
    .map((k) => toSafeInt(k, 0))
    .filter((id) => id > 0 && isValidSwordId(id) && toSafeInt(swordCfg[id] && swordCfg[id].quality, 0) === quality);
  if (pool.length === 0) {
    const fallback = Object.keys(swordCfg).map((k) => toSafeInt(k, 0)).filter((id) => id > 0 && isValidSwordId(id));
    return fallback.length > 0 ? fallback[Math.floor(Math.random() * fallback.length)] : getFallbackSwordId(quality);
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildOptionalSword(info) {
  const quality = pickWeightedQuality();
  const swordId = pickSwordIdByQuality(quality);
  return normalizeMountRow({
    uid: info.nextUid++,
    id: swordId,
    quality: getSwordQualityById(swordId),
    level: 1,
    star: 0,
    lock: 0,
    exp: 0,
    attrs: {},
    skills: buildMountPassiveSkills(swordId, quality),
  });
}

function findMountByUid(info, uid) {
  const targetUid = toSafeInt(uid, 0);
  return info.data.find((row) => toSafeInt(row && row.uid, 0) === targetUid) || null;
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

function calcLevelConsumeCount(quality, level) {
  const levelCfg = config.get('SwordLevelConfig') || {};
  const qualityCfg = levelCfg[toSafeInt(quality, 0)] || {};
  let total = 0;
  const maxLv = Math.max(1, toSafeInt(level, 1));
  for (let lv = 2; lv <= maxLv; lv++) {
    const row = qualityCfg[lv];
    if (!row || !row.consumes) continue;
    if (toSafeInt(row.consumes.id, 0) !== 20) continue;
    total += Math.max(0, toSafeInt(row.consumes.count, 0));
  }
  return total;
}

function getFallbackMount(info) {
  if (info.data.length > 0) return info.data[0];
  const swordId = pickSwordIdByQuality(2);
  const mount = createMountRecord(info, swordId);
  info.data.push(mount);
  syncMountUnlockStats(info);
  if (!info.equippedUid) info.equippedUid = mount.uid;
  return mount;
}

function buildMountInfoUpdatePayload(info) {
  return {
    maxlayer: Math.max(0, toSafeInt(info.maxlayer, 0)),
    curlayer: Math.max(0, toSafeInt(info.curlayer, 0)),
    slotlist: Array.isArray(info.slotlist) ? info.slotlist : [],
    skills: Array.isArray(info.skills) ? info.skills : [],
    skillCount: Math.max(0, toSafeInt(info.skillCount, 0)),
    autoSelect: Math.max(0, toSafeInt(info.autoSelect, 0)),
    autoPriority: Array.isArray(info.autoPriority) ? info.autoPriority : [],
    score: Math.max(0, toSafeInt(info.score, 0)),
    challengelist: Array.isArray(info.challengelist) ? info.challengelist : [],
    refreshtime: Math.max(0, toSafeInt(info.refreshtime, 0)),
    loglist: Array.isArray(info.loglist) ? info.loglist : [],
    rankInfo: isPlainObject(info.rankInfo) ? info.rankInfo : {},
    unlockedSwords: Array.isArray(info.unlockedSwords) ? info.unlockedSwords : [],
    gridCount: Math.max(1, toSafeInt(info.gridCount, 6)),
    equippedUid: toSafeInt(info.equippedUid, 0),
    data: Array.isArray(info.data) ? info.data.map((row) => normalizeMountRow(row)) : [],
    optionalSwords: Array.isArray(info.optionalSwords) ? info.optionalSwords.map((row) => normalizeMountRow(row)) : [],
    wishId: Math.max(0, toSafeInt(info.wishId, 0)),
    wishCounter: Math.max(0, toSafeInt(info.wishCounter, 0)),
    bestCounter: Math.max(0, toSafeInt(info.bestCounter, 0)),
    adFreeCounter: Math.max(0, toSafeInt(info.adFreeCounter, 0)),
    summonedIds: Array.isArray(info.summonedIds) ? info.summonedIds : [],
    skinId: Math.max(0, toSafeInt(info.skinId, 0)),
    swordBond: Array.isArray(info.swordBond) ? info.swordBond : [],
  };
}

function grantMountToPlayer(player, swordId) {
  const info = ensureMountInfo(player);
  const id = normalizeSwordId(swordId);
  if (!isValidSwordId(id)) return null;

  if (info.data.length >= toSafeInt(info.gridCount, 0)) {
    info.gridCount = info.data.length + 1;
  }

  const mount = createMountRecord(info, id);
  info.data.push(mount);
  syncMountUnlockStats(info);
  if (!info.equippedUid) info.equippedUid = mount.uid;
  return mount;
}

// 装备坐骑 (tag:3200)
async function handleMountEquip(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3200, msgUid, data: { result: -1, uid: 0 } };

  const info = ensureMountInfo(player);
  const reqUid = toSafeInt(params && params.uid, 0);
  const mount = findMountByUid(info, reqUid);
  if (mount) {
    info.equippedUid = mount.uid;
  } else if (info.data.length > 0) {
    info.equippedUid = toSafeInt(info.data[0].uid, 0);
  } else {
    info.equippedUid = 0;
  }

  const taskChanged = info.equippedUid > 0 ? !!addMountRideCount(player, 1) : false;
  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 3200,
    msgUid,
    data: {
      result: 0,
      uid: info.equippedUid,
      info: buildMountInfoUpdatePayload(info),
    },
  };
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

// 刷新可召唤列表 (tag:3201)
async function handleMountRefresh(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3201, msgUid, data: { result: -1, data: [], wishCounter: 0, bestCounter: 0 } };

  const info = ensureMountInfo(player);
  const ad = toSafeInt(params && params.ad, 0);
  const baseCfg = config.get('SwordBaseConfig') || {};
  const refreshCost = ad > 0 ? null : baseCfg.callRefreshConsume;
  const refreshCostId = toSafeInt(refreshCost && refreshCost.id, 0);
  const refreshCostCount = Math.max(0, toSafeInt(refreshCost && refreshCost.count, 0));
  const beforeRefreshCostCount = getItemOrCurrencyCount(player, refreshCostId);
  if (refreshCostId > 0
    && refreshCostCount > 0
    && !consumeItemOrCurrency(player, refreshCostId, refreshCostCount)) {
    return {
      tag: 3201,
      msgUid,
      data: {
        result: 1,
        data: info.optionalSwords,
        wishCounter: toSafeInt(info.wishCounter, 0),
        bestCounter: toSafeInt(info.bestCounter, 0),
      },
    };
  }
  const optionCount = Math.max(3, toSafeInt((baseCfg.initSword || []).length, 3));

  const next = [];
  if (toSafeInt(info.wishId, 0) > 0) {
    next.push(normalizeMountRow({
      uid: info.nextUid++,
      id: info.wishId,
      quality: getSwordQualityById(info.wishId),
      level: 1,
      star: 0,
      lock: 0,
      exp: 0,
      attrs: {},
      skills: [],
    }));
  }
  while (next.length < optionCount) next.push(buildOptionalSword(info));
  info.optionalSwords = next;
  info.bestCounter = toSafeInt(info.bestCounter, 0) + 1;
  if (ad > 0) info.adFreeCounter = toSafeInt(info.adFreeCounter, 0) + 1;

  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 3201,
    msgUid,
    data: {
      result: 0,
      data: info.optionalSwords,
      wishCounter: toSafeInt(info.wishCounter, 0),
      bestCounter: toSafeInt(info.bestCounter, 0),
    },
  };
  const costSync = buildMountCostSync(player, refreshCostId, beforeRefreshCostCount);
  return costSync ? [costSync, response] : response;
}

// 设置心愿 (tag:3202)
async function handleMountSetWish(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3202, msgUid, data: { result: -1, id: 0, counter: 0 } };

  const info = ensureMountInfo(player);
  const id = toSafeInt(params && params.id, 0);
  info.wishId = id > 0 && isValidSwordId(id) ? id : 0;
  info.wishCounter = toSafeInt(info.wishCounter, 0) + 1;

  await playerService.savePlayer(session.userId, player);
  return { tag: 3202, msgUid, data: { result: 0, id: info.wishId, counter: info.wishCounter } };
}

// 召唤 (tag:3203)
async function handleMountSummon(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3203, msgUid, data: { result: -1, data: {} } };

  const info = ensureMountInfo(player);
  const targetUid = toSafeInt(params && params.uid, 0);
  let optional = info.optionalSwords.find((row) => toSafeInt(row && row.uid, 0) === targetUid);
  if (!optional) {
    if (info.optionalSwords.length === 0) info.optionalSwords = [buildOptionalSword(info)];
    optional = info.optionalSwords[0];
  }

  // Keep gameplay smooth: auto-grow bag by one if full so summon is never blocked.
  if (info.data.length >= toSafeInt(info.gridCount, 0)) {
    info.gridCount = info.data.length + 1;
  }

  const quality = getSwordQualityById(optional.id);
  const mount = createMountRecord(info, toSafeInt(optional.id, 22101), {
    uid: toSafeInt(optional.uid, info.nextUid++),
    quality,
  });

  const baseCfg = config.get('SwordBaseConfig') || {};
  const summonCost = (baseCfg.callConsume && baseCfg.callConsume[quality]) || null;
  const summonCostId = toSafeInt(summonCost && summonCost.id, 0);
  const beforeSummonCostCount = getItemOrCurrencyCount(player, summonCostId);
  if (summonCost) {
    consumeItemOrCurrency(player, summonCost.id, summonCost.count);
  }

  info.data.push(mount);
  syncMountUnlockStats(info);
  info.summonedIds.push(mount.uid);
  info.optionalSwords = info.optionalSwords.filter((row) => toSafeInt(row && row.uid, 0) !== mount.uid);
  if (!info.equippedUid) info.equippedUid = mount.uid;

  const taskChanged = !!addMountSummonCount(player, 1);
  await playerService.savePlayer(session.userId, player);
  const response = { tag: 3203, msgUid, data: { result: 0, data: mount } };
  const costSync = buildMountCostSync(player, summonCostId, beforeSummonCostCount);
  if (taskChanged || costSync) {
    return [
      ...(taskChanged ? buildTaskUpdatePacketsSafe(player) : []),
      ...(costSync ? [costSync] : []),
      response,
    ];
  }
  return response;
}

// 升级 (tag:3204)
async function handleMountUpgrade(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3204, msgUid, data: { result: -1, data: {} } };

  const info = ensureMountInfo(player);
  const mount = findMountByUid(info, params && params.uid) || getFallbackMount(info);
  const quality = toSafeInt(mount.quality, getSwordQualityById(mount.id));
  const prevLevel = Math.max(1, toSafeInt(mount.level, 1));
  const nextLevel = toSafeInt(mount.level, 1) + 1;
  const levelCfg = config.get('SwordLevelConfig') || {};
  const canUpgrade = !!(levelCfg[quality] && levelCfg[quality][nextLevel]);
  const row = levelCfg[quality] && levelCfg[quality][prevLevel];
  let costItemId = 0;
  let beforeCostCount = 0;
  if (!canUpgrade) {
    return { tag: 3204, msgUid, data: { result: -1, data: mount } };
  }
  if (row && row.consumes) {
    costItemId = toSafeInt(row.consumes.id, 0);
    beforeCostCount = getItemOrCurrencyCount(player, costItemId);
    const ok = consumeItemOrCurrency(player, row.consumes.id, row.consumes.count);
    if (ok || isMountUpgradeFailOpenEnabled()) mount.level = nextLevel;
  } else {
    mount.level = nextLevel;
  }
  mount.quality = quality;
  syncMountSkillLevels(mount);
  mount.attrs = buildMountAttrs(mount.id, mount.quality, mount.level, mount.star, mount.uid);

  const taskChanged = Math.max(1, toSafeInt(mount.level, 1)) > prevLevel
    ? !!addMountUpgradeCount(player, 1)
    : false;
  await playerService.savePlayer(session.userId, player);
  const response = { tag: 3204, msgUid, data: { result: 0, data: mount } };
  const costSyncPacket = buildMountCostSync(player, costItemId, beforeCostCount);
  if (costSyncPacket || taskChanged) {
    return [
      ...(taskChanged ? buildTaskUpdatePacketsSafe(player) : []),
      response,
      ...(costSyncPacket ? [costSyncPacket] : []),
    ];
  }
  return response;
}

// 吞噬 (tag:3205)
async function handleMountSwallow(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3205, msgUid, data: { result: -1, data: {}, rewards: buildMountRewardPayload() } };

  const info = ensureMountInfo(player);
  const targetUid = toSafeInt(params && params.targetUid, 0);
  const matUid = toSafeInt(params && params.matUid, 0);

  const target = findMountByUid(info, targetUid) || getFallbackMount(info);
  const mat = findMountByUid(info, matUid);
  if (mat && toSafeInt(mat.uid, 0) !== toSafeInt(target.uid, 0)) {
    const gainStar = Math.max(1, toSafeInt(mat.star, 0) + 1);
    target.star = Math.min(40, Math.max(0, toSafeInt(target.star, 1)) + gainStar);
    const maxSkillCount = Math.max(1, toSafeInt((config.get('SwordBaseConfig') || {}).passiveSkillMaxCount, 4));
    const mergedSkills = normalizeMountSkills(target.skills);
    const materialSkills = normalizeMountSkills(mat.skills);
    for (const skill of materialSkills) {
      if (mergedSkills.length >= maxSkillCount) break;
      mergedSkills.push({ ...skill });
    }
    while (mergedSkills.length < Math.min(maxSkillCount, Math.max(mergedSkills.length, toSafeInt(target.star, 0) + 1))) {
      const generated = buildMountPassiveSkills(target.id, target.quality);
      const nextSkill = generated[mergedSkills.length] || generated[generated.length - 1];
      if (!nextSkill) break;
      mergedSkills.push({ ...nextSkill });
    }
    target.skills = mergedSkills;
    target.passiveSkills = mergedSkills;
    // 合并词条后按新星级同步等级，再重算属性
    syncMountSkillLevels(target);
    target.attrs = buildMountAttrs(target.id, target.quality, target.level, target.star, target.uid);
    info.data = info.data.filter((row) => toSafeInt(row && row.uid, 0) !== mat.uid);
    if (toSafeInt(info.equippedUid, 0) === mat.uid) info.equippedUid = target.uid;
  }

  const baseCfg = config.get('SwordBaseConfig') || {};
  const rewardBase = toSafeInt(baseCfg.swallowReturn && baseCfg.swallowReturn[target.quality], 0);
  const rewardCount = Math.max(0, Math.floor(rewardBase / 4));
  const rewards = rewardCount > 0 ? [{ id: 20, count: rewardCount }] : [];
  rewards.forEach((reward) => addRewardToPlayer(player, reward.id, reward.count));

  await playerService.savePlayer(session.userId, player);
  const rewardInfo = buildMountRewardResponse(rewards);
  const response = { tag: 3205, msgUid, data: { result: 0, data: target, rewards: rewardInfo, rewardInfo } };
  const rewardSync = buildMountRewardSync(player, rewards);
  return rewardSync ? [rewardSync, response] : response;
}

// 重置 (tag:3206)
async function handleMountReset(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3206, msgUid, data: { result: -1, data: {}, rewards: buildMountRewardPayload() } };

  const info = ensureMountInfo(player);
  const mount = findMountByUid(info, params && params.uid) || getFallbackMount(info);
  const quality = toSafeInt(mount.quality, getSwordQualityById(mount.id));
  const baseCfg = config.get('SwordBaseConfig') || {};
  const consume = (baseCfg.resetReturnConsume && baseCfg.resetReturnConsume[quality]) || null;
  let success = true;
  if (consume) {
    success = consumeItemOrCurrency(player, consume.id, consume.count);
  }

  const oldLevel = Math.max(1, toSafeInt(mount.level, 1));
  if (success) mount.level = 1;
  const invested = calcLevelConsumeCount(quality, oldLevel);
  const returnRate = Math.max(0, toSafeInt(baseCfg.resetReturnRate, 100));
  const rewardCount = Math.max(0, Math.floor(invested * returnRate / 100));
  const rewards = rewardCount > 0 ? [{ id: 20, count: rewardCount }] : [];
  rewards.forEach((reward) => addRewardToPlayer(player, reward.id, reward.count));

  await playerService.savePlayer(session.userId, player);
  const rewardInfo = buildMountRewardResponse(rewards);
  const response = { tag: 3206, msgUid, data: { result: success ? 0 : -1, data: mount, rewards: rewardInfo, rewardInfo } };
  const rewardSync = buildMountRewardSync(player, rewards);
  return rewardSync ? [rewardSync, response] : response;
}

// 放生 (tag:3207)
async function handleMountRelease(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3207, msgUid, data: { result: -1, uid: 0, rewards: buildMountRewardPayload(), rewardInfo: buildMountRewardPayload() } };

  const info = ensureMountInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const mount = findMountByUid(info, uid);
  if (!mount) {
    const rewardInfo = buildMountRewardPayload();
    return { tag: 3207, msgUid, data: { result: -1, uid: 0, rewards: rewardInfo, rewardInfo } };
  }

  info.data = info.data.filter((row) => toSafeInt(row && row.uid, 0) !== mount.uid);
  if (toSafeInt(info.equippedUid, 0) === mount.uid) {
    info.equippedUid = info.data.length > 0 ? toSafeInt(info.data[0].uid, 0) : 0;
  }

  const baseCfg = config.get('SwordBaseConfig') || {};
  const base = toSafeInt(baseCfg.swallowReturn && baseCfg.swallowReturn[mount.quality], 0);
  const multiplier = Math.max(1, Math.floor(Math.max(1, toSafeInt(mount.level, 1)) / 10));
  const rewardCount = Math.max(0, base * multiplier);
  const rewards = rewardCount > 0 ? [{ id: 20, count: rewardCount }] : [];
  rewards.forEach((reward) => addRewardToPlayer(player, reward.id, reward.count));

  await playerService.savePlayer(session.userId, player);
  const rewardInfo = buildMountRewardResponse(rewards);
  const response = { tag: 3207, msgUid, data: { result: 0, uid: mount.uid, rewards: rewardInfo, rewardInfo } };
  const rewardSync = buildMountRewardSync(player, rewards);
  return rewardSync ? [rewardSync, response] : response;
}

// 购买格子 (tag:3208)
async function handleMountBuyGrid(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3208, msgUid, data: { result: -1, gridCount: 0 } };

  const info = ensureMountInfo(player);
  const baseCfg = config.get('SwordBaseConfig') || {};
  const initialCount = Math.max(1, toSafeInt(baseCfg.gridInitialCount, 6));
  const maxCount = Math.max(initialCount, toSafeInt(baseCfg.gridCountMax, 95));
  const buyCost = Array.isArray(baseCfg.gridBuy) ? baseCfg.gridBuy : [];
  const buyIndex = Math.max(0, toSafeInt(info.gridCount, initialCount) - initialCount);
  const diamondCost = Math.max(0, toSafeInt(buyCost[buyIndex], 0));

  let result = 0;
  if (toSafeInt(info.gridCount, initialCount) < maxCount) {
    const consumed = diamondCost > 0 ? consumeItemOrCurrency(player, 1, diamondCost) : true;
    if (consumed) {
      info.gridCount = Math.min(maxCount, toSafeInt(info.gridCount, initialCount) + 1);
    } else {
      result = -1;
    }
  } else {
    result = -1;
  }

  await playerService.savePlayer(session.userId, player);
  return { tag: 3208, msgUid, data: { result, gridCount: toSafeInt(info.gridCount, initialCount) } };
}

// 锁定/解锁 (tag:3209)
async function handleMountLock(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3209, msgUid, data: { result: -1, data: {} } };

  const info = ensureMountInfo(player);
  const mount = findMountByUid(info, params && params.uid) || getFallbackMount(info);
  mount.lock = toSafeInt(params && params.lock, 0) > 0 ? 1 : 0;

  await playerService.savePlayer(session.userId, player);
  return { tag: 3209, msgUid, data: { result: 0, data: mount } };
}

// 穿戴皮肤 (tag:3210)
async function handleMountEquipSkin(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3210, msgUid, data: { result: -1, skinId: 0 } };

  const info = ensureMountInfo(player);
  const skinId = toSafeInt(params && params.id, 0);
  info.skinId = skinId > 0 && isValidSwordId(skinId) ? skinId : 0;

  await playerService.savePlayer(session.userId, player);
  return { tag: 3210, msgUid, data: { result: 0, skinId: info.skinId } };
}

module.exports = {
  ensureMountInfo,
  buildMountInfoUpdatePayload,
  grantMountToPlayer,
  handleMountEquip,
  handleMountRefresh,
  handleMountSetWish,
  handleMountSummon,
  handleMountUpgrade,
  handleMountSwallow,
  handleMountReset,
  handleMountRelease,
  handleMountBuyGrid,
  handleMountLock,
  handleMountEquipSkin,
};
