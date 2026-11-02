/**
 * Valhalla system handlers
 * tag: 4100 change plan, 4101 equip, 4102 level up, 4103 star up, 4104 decompose
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const { buildClientItemList } = require('../services/CurrencySync');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function uniqueInts(values = []) {
  const seen = new Set();
  const out = [];
  values.forEach((v) => {
    const n = toSafeInt(v, 0);
    if (n <= 0 || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  });
  return out;
}

const LEGEND_RANDOM_ITEM_ID = 207;

function getSkillHeroSlotCount() {
  return Math.max(1, toSafeInt(getValhallaBaseConfig().skillCountLimit, 3));
}

function normalizeSkillHeroIds(values = [], heroIdSet = null) {
  const source = Array.isArray(values) ? values : [];
  return Array.from({ length: getSkillHeroSlotCount() }, (_v, idx) => {
    const id = toSafeInt(source[idx], -1);
    if (id <= 0) return -1;
    if (heroIdSet && !heroIdSet.has(id)) return -1;
    return id;
  });
}

function createEmptyPlan(id = 0) {
  return {
    id: Math.max(0, toSafeInt(id, 0)),
    equippedMap: {},
    skillHeroIds: normalizeSkillHeroIds(),
  };
}

function cloneEquippedMap(map = {}) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  Object.keys(map)
    .map((key) => ({ index: Math.max(0, toSafeInt(key, 0)), uid: toSafeInt(map[key], -1) }))
    .filter((row) => row.uid >= 0)
    .sort((a, b) => a.index - b.index)
    .forEach((row) => {
      out[String(row.index)] = row.uid;
    });
  return out;
}

function buildPlanPayload(row) {
  const plan = row && typeof row === 'object' ? row : createEmptyPlan(0);
  return {
    id: Math.max(0, toSafeInt(plan.id, 0)),
    equippedMap: cloneEquippedMap(plan.equippedMap),
    skillHeroIds: normalizeSkillHeroIds(plan.skillHeroIds),
  };
}

function buildHeroPayload(hero) {
  return {
    uid: toSafeInt(hero && hero.uid, -1),
    id: toSafeInt(hero && hero.id, 0),
    level: Math.max(1, toSafeInt(hero && hero.level, 1)),
    star: Math.max(0, toSafeInt(hero && hero.star, 0)),
    lock: !!(hero && hero.lock),
    attrUpgrades: Array.isArray(hero && hero.attrUpgrades)
      ? hero.attrUpgrades.map((v) => Math.max(0, toSafeInt(v, 0)))
      : Array.from({ length: getDefaultAttrUpgradeSlots() }, () => 0),
  };
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
  const id = toSafeInt(itemId, 0);
  const need = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || need <= 0) return true;
  if (!hasEnoughItemOrCurrency(player, id, need)) return false;

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

function addItemOrCurrency(player, itemId, count) {
  const id = toSafeInt(itemId, 0);
  const gain = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || gain <= 0) return;

  const currKey = getCurrencyKeyById(id);
  if (currKey) {
    player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
    player.currencies[currKey] = Math.max(0, toSafeInt(player.currencies[currKey], 0) + gain);
    return;
  }

  player.items = player.items || {};
  player.items[id] = Math.max(0, toSafeInt(player.items[id], 0) + gain);
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

function snapshotItemCounts(player, itemIds = []) {
  const counts = {};
  uniqueInts(itemIds).forEach((itemId) => {
    counts[itemId] = getItemOrCurrencyCount(player, itemId);
  });
  return counts;
}

function buildItemSyncPacket(player, beforeCounts = {}, touchedIds = []) {
  const rows = uniqueInts([
    ...Object.keys(beforeCounts).map((key) => toSafeInt(key, 0)),
    ...(Array.isArray(touchedIds) ? touchedIds : []),
  ])
    .map((itemId) => {
      const before = Math.max(0, toSafeInt(beforeCounts[itemId], 0));
      const after = getItemOrCurrencyCount(player, itemId);
      if (before === after) return null;
      return { id: itemId, delta: after - before, count: after };
    })
    .filter(Boolean);
  const changed = rows.map((row) => ({ id: row.id, count: row.count }));
  const itemDeltas = rows.map((row) => ({ id: row.id, count: row.delta }));

  if (changed.length <= 0) return null;
  return {
    tag: 1202,
    msgUid: 0,
    data: {
      result: 0,
      items: itemDeltas,
      changed,
    },
  };
}

function buildRewardInfo(items = [], valhalla = []) {
  return {
    items: (Array.isArray(items) ? items : [])
      .map((row) => ({ id: toSafeInt(row && row.id, 0), count: Math.max(0, toSafeInt(row && row.count, 0)) }))
      .filter((row) => row.id > 0 && row.count > 0),
    equips: [],
    swords: [],
    pets: [],
    artifacts: [],
    gems: [],
    valhalla: (Array.isArray(valhalla) ? valhalla : []).map((hero) => buildHeroPayload(hero)),
    bloodline: [],
    fashion: [],
    elves: [],
    sailor: [],
    extraReward: {},
  };
}

function getValhallaBaseConfig() {
  return config.get('ValhallaBaseConfig') || {};
}

function getValhallaFieldConfigMap() {
  return config.get('ValhallaFieldConfig') || {};
}

function getValhallaCfgMap() {
  return config.get('ValhallaConfig') || {};
}

function getValhallaCfgById(heroId) {
  return getValhallaCfgMap()[toSafeInt(heroId, 0)] || null;
}

function getFallbackValhallaId() {
  const ids = pickDefaultValhallaIds();
  return ids[0] || 26111;
}

function normalizeValhallaId(heroId) {
  const id = toSafeInt(heroId, 0);
  return getValhallaCfgById(id) ? id : getFallbackValhallaId();
}

function getValhallaQualityById(heroId) {
  const row = getValhallaCfgById(heroId);
  return Math.max(1, toSafeInt(row && row.quality, 3));
}

function getValhallaMaxStarById(heroId) {
  const row = getValhallaCfgById(heroId);
  return Math.max(0, toSafeInt(row ? row.maxStar : 5, 5));
}

function getDefaultAttrUpgradeSlots() {
  return 6;
}

function getServerOpenDay() {
  return Math.max(1, toSafeInt(process.env.SERVER_OPEN_DAY || process.env.SERVER_RUN_DAY, 1));
}

function pickDefaultValhallaIds() {
  const cfgMap = getValhallaCfgMap();
  const ids = Object.keys(cfgMap).map((k) => toSafeInt(k, 0)).filter((id) => id > 0).sort((a, b) => a - b);
  const grouped = new Map();
  ids.forEach((id) => {
    const row = cfgMap[id];
    if (!row) return;
    const type = toSafeInt(row.type, 0);
    if (type <= 0) return;
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type).push(id);
  });

  const out = [];
  Array.from(grouped.keys()).sort((a, b) => a - b).forEach((type) => {
    const list = grouped.get(type) || [];
    list.slice(0, 2).forEach((id) => out.push(id));
  });

  if (out.length > 0) return uniqueInts(out);
  return [26111, 26121, 26211, 26221, 26311, 26321, 26411, 26421, 26511, 26521];
}

function normalizeHero(raw, info) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const id = normalizeValhallaId(row.id);
  const uidRaw = toSafeInt(row.uid, -1);
  const uid = uidRaw >= 0 ? uidRaw : toSafeInt(info.nextUid, 0);
  if (uid >= toSafeInt(info.nextUid, 0)) info.nextUid = uid + 1;

  const quality = getValhallaQualityById(id);
  const levelCfg = (config.get('ValhallaLevelConfig') || {})[quality] || {};
  const levelRows = Object.keys(levelCfg).map((k) => toSafeInt(k, 0)).filter((n) => n > 0);
  const levelMax = levelRows.length > 0 ? Math.max(1, ...levelRows) : Number.MAX_SAFE_INTEGER;
  const maxStar = getValhallaMaxStarById(id);
  const star = Math.max(0, Math.min(maxStar, toSafeInt(row.star, 0)));
  const level = Math.max(1, Math.min(levelMax, toSafeInt(row.level, 1)));
  const lock = !!row.lock;

  const attrUpgrades = Array.isArray(row.attrUpgrades) ? row.attrUpgrades : [];
  const upgradeSlots = getDefaultAttrUpgradeSlots();
  const normalizedAttrUpgrades = Array.from({ length: upgradeSlots }, (_v, idx) => Math.max(0, toSafeInt(attrUpgrades[idx], 0)));

  return {
    uid,
    id,
    level,
    star,
    lock,
    attrUpgrades: normalizedAttrUpgrades,
  };
}

function getPlanCountLimit() {
  return Math.max(1, toSafeInt(getValhallaBaseConfig().planCountLimit, 3));
}

function getFightLimit() {
  return Math.max(1, toSafeInt(getValhallaBaseConfig().fightLimit, 4));
}

function getPlanSlotCount() {
  const fieldCfg = getValhallaFieldConfigMap();
  const configuredCount = Object.keys(fieldCfg)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0)
    .length;
  return Math.max(getFightLimit(), configuredCount);
}

function getSameHeroEquipLimit() {
  return getFightLimit();
}

function isSlotUnlockedForPlayer(player, slotIndex) {
  const idx = Math.max(0, toSafeInt(slotIndex, 0));
  const fieldCfg = getValhallaFieldConfigMap();
  const row = fieldCfg[idx + 1] || fieldCfg[String(idx + 1)] || null;
  if (!row) return idx < getFightLimit();
  const playerLevel = Math.max(1, toSafeInt(player && player.level, 1));
  return playerLevel >= Math.max(1, toSafeInt(row.playerLevel, 1))
    && getServerOpenDay() >= Math.max(1, toSafeInt(row.openDay, 1));
}

function normalizePlanRow(raw, uidSet, heroIdSet) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const id = Math.max(0, toSafeInt(row.id, 0));
  const slotCount = getPlanSlotCount();
  const equippedMap = {};
  const usedUid = new Set();

  const assignSlot = (indexRaw, uidRaw) => {
    const index = toSafeInt(indexRaw, -1);
    const uid = toSafeInt(uidRaw, -1);
    if (index < 0 || index >= slotCount) return;
    if (uid < 0 || !uidSet.has(uid)) return;
    if (usedUid.has(uid)) return;
    Object.keys(equippedMap).forEach((key) => {
      if (toSafeInt(equippedMap[key], -1) === uid || toSafeInt(key, -1) === index) {
        delete equippedMap[key];
      }
    });
    equippedMap[String(index)] = uid;
    usedUid.add(uid);
  };

  if (row.equippedMap && typeof row.equippedMap === 'object' && !Array.isArray(row.equippedMap)) {
    Object.keys(row.equippedMap).forEach((key) => assignSlot(key, row.equippedMap[key]));
  }

  const slotsRaw = Array.isArray(row.slots)
    ? row.slots
    : Array.isArray(row.list)
      ? row.list
      : Array.isArray(row.heroes)
        ? row.heroes
        : Array.isArray(row.uids)
          ? row.uids
          : [];

  slotsRaw.forEach((entry, idx) => {
    let uid = 0;
    let index = idx;
    if (typeof entry === 'number') {
      uid = toSafeInt(entry, 0);
    } else if (entry && typeof entry === 'object') {
      uid = toSafeInt(entry.uid, 0);
      index = toSafeInt(entry.index, toSafeInt(entry.slot, toSafeInt(entry.pos, idx)));
    }
    assignSlot(index, uid);
  });

  return {
    id,
    equippedMap,
    skillHeroIds: normalizeSkillHeroIds(row.skillHeroIds, heroIdSet),
  };
}

function ensureValhallaInfo(player) {
  player.other_attr_info = player.other_attr_info && typeof player.other_attr_info === 'object' && !Array.isArray(player.other_attr_info)
    ? player.other_attr_info
    : {};

  const holder = player.other_attr_info;
  holder.valhallaInfo = holder.valhallaInfo && typeof holder.valhallaInfo === 'object' && !Array.isArray(holder.valhallaInfo)
    ? holder.valhallaInfo
    : {};
  const info = holder.valhallaInfo;

  if (!Array.isArray(info.valhalla)) info.valhalla = [];
  if (!Array.isArray(info.planInfo)) info.planInfo = [];
  if (!Array.isArray(info.poolData)) info.poolData = [];
  if (!Array.isArray(info.unlockedIds)) info.unlockedIds = [];
  if (!Array.isArray(info.rewardedAtlas)) info.rewardedAtlas = [];
  if (!info.skillMap || typeof info.skillMap !== 'object' || Array.isArray(info.skillMap)) info.skillMap = {};
  if (!Array.isArray(info.wishList)) info.wishList = [];

  info.poolData = info.poolData
    .map((row) => {
      const id = Math.max(1, toSafeInt(row && row.id, 1));
      return {
        id,
        count: Math.max(0, toSafeInt(row && row.count, 0)),
        wishList: uniqueInts(Array.isArray(row && row.wishList) ? row.wishList : []),
      };
    })
    .filter((row, idx, arr) => arr.findIndex((it) => it.id === row.id) === idx)
    .sort((a, b) => a.id - b.id);
  if (info.poolData.length === 0) info.poolData.push({ id: 1, count: 0, wishList: [] });

  const maxUid = info.valhalla.reduce((max, hero) => Math.max(max, toSafeInt(hero && hero.uid, -1)), -1);
  if (toSafeInt(info.nextUid, -1) <= maxUid) info.nextUid = maxUid + 1;
  if (toSafeInt(info.nextUid, -1) < 0) info.nextUid = 0;

  if (info.valhalla.length === 0) {
    const ids = pickDefaultValhallaIds();
    info.valhalla = ids.map((heroId, idx) => ({
      uid: idx,
      id: heroId,
      level: 1,
      star: 0,
      lock: false,
      attrUpgrades: Array.from({ length: getDefaultAttrUpgradeSlots() }, () => 0),
    }));
    info.nextUid = info.valhalla.length;
  }

  const planLimit = getPlanCountLimit();
  info.plan = Math.max(0, Math.min(planLimit - 1, toSafeInt(info.plan, 0)));

  info.valhalla = info.valhalla.map((hero) => normalizeHero(hero, info));
  const uidSet = new Set(info.valhalla.map((hero) => toSafeInt(hero.uid, -1)));
  const heroIdSet = new Set(info.valhalla.map((hero) => toSafeInt(hero.id, 0)).filter((id) => id > 0));

  const normalizedPlanMap = new Map();
  info.planInfo.forEach((row) => {
    const norm = normalizePlanRow(row, uidSet, heroIdSet);
    if (norm.id < 0 || norm.id >= planLimit) return;
    normalizedPlanMap.set(norm.id, norm);
  });
  if (!normalizedPlanMap.has(info.plan)) {
    normalizedPlanMap.set(info.plan, createEmptyPlan(info.plan));
  }
  info.planInfo = Array.from(normalizedPlanMap.values()).sort((a, b) => a.id - b.id);

  const valhallaCfgMap = getValhallaCfgMap();
  const allHeroIds = new Set(Object.keys(valhallaCfgMap).map((k) => toSafeInt(k, 0)).filter((id) => id > 0));
  info.unlockedIds = uniqueInts([...info.unlockedIds, ...info.valhalla.map((hero) => hero.id)])
    .filter((id) => allHeroIds.has(id));
  const unlockedSet = new Set(info.unlockedIds);
  info.rewardedAtlas = uniqueInts(info.rewardedAtlas).filter((id) => unlockedSet.has(id));
  const validUidSet = new Set(info.valhalla.map((hero) => String(toSafeInt(hero.uid, -1))));
  const nextSkillMap = {};
  Object.keys(info.skillMap).forEach((uidKey) => {
    const uid = String(toSafeInt(uidKey, -1));
    const skillId = toSafeInt(info.skillMap[uidKey], 0);
    if (uid === '-1' || skillId <= 0) return;
    if (!validUidSet.has(uid)) return;
    nextSkillMap[uid] = skillId;
  });
  info.skillMap = nextSkillMap;

  info.wishList = uniqueInts(info.wishList).filter((id) => allHeroIds.has(id));

  return info;
}

function buildValhallaPayload(info) {
  return {
    plan: Math.max(0, toSafeInt(info.plan, 0)),
    planInfo: (Array.isArray(info.planInfo) ? info.planInfo : []).map((row) => buildPlanPayload(row)),
    valhalla: (Array.isArray(info.valhalla) ? info.valhalla : []).map((hero) => buildHeroPayload(hero)),
    poolData: (Array.isArray(info.poolData) ? info.poolData : []).map((row) => ({
      id: Math.max(1, toSafeInt(row && row.id, 1)),
      count: Math.max(0, toSafeInt(row && row.count, 0)),
      wishList: uniqueInts(Array.isArray(row && row.wishList) ? row.wishList : []),
    })),
    unlockedIds: Array.isArray(info.unlockedIds) ? [...info.unlockedIds] : [],
    rewardedAtlas: Array.isArray(info.rewardedAtlas) ? [...info.rewardedAtlas] : [],
  };
}

function getPlanById(info, planId) {
  const id = Math.max(0, Math.min(getPlanCountLimit() - 1, toSafeInt(planId, info.plan)));
  let row = info.planInfo.find((plan) => toSafeInt(plan && plan.id, -1) === id);
  if (!row) {
    row = createEmptyPlan(id);
    info.planInfo.push(row);
    info.planInfo.sort((a, b) => toSafeInt(a && a.id, 0) - toSafeInt(b && b.id, 0));
  }
  if (!row.equippedMap || typeof row.equippedMap !== 'object' || Array.isArray(row.equippedMap)) row.equippedMap = {};
  row.skillHeroIds = normalizeSkillHeroIds(row.skillHeroIds);
  return row;
}

function getHeroByUidMap(info) {
  const map = new Map();
  (Array.isArray(info && info.valhalla) ? info.valhalla : []).forEach((hero) => {
    map.set(toSafeInt(hero && hero.uid, -1), hero);
  });
  return map;
}

function buildStrongestEquippedHeroMap(info, plan) {
  const heroByUid = getHeroByUidMap(info);
  const strongest = new Map();
  const equippedMap = cloneEquippedMap(plan && plan.equippedMap);
  Object.keys(equippedMap).forEach((key) => {
    const hero = heroByUid.get(toSafeInt(equippedMap[key], -1));
    if (!hero) return;
    const heroId = toSafeInt(hero.id, 0);
    if (heroId <= 0) return;
    const current = strongest.get(heroId);
    const heroStar = Math.max(0, toSafeInt(hero.star, 0));
    const heroLevel = Math.max(1, toSafeInt(hero.level, 1));
    if (!current) {
      strongest.set(heroId, hero);
      return;
    }
    const currentStar = Math.max(0, toSafeInt(current.star, 0));
    const currentLevel = Math.max(1, toSafeInt(current.level, 1));
    if (heroStar > currentStar || (heroStar === currentStar && heroLevel > currentLevel)) {
      strongest.set(heroId, hero);
    }
  });
  return strongest;
}

function normalizeSkillHeroIdsForPlan(heroIds = [], info, plan) {
  const allowedSet = new Set(Array.from(buildStrongestEquippedHeroMap(info, plan).keys()));
  const normalized = normalizeSkillHeroIds(heroIds, allowedSet);
  const used = new Set();
  return normalized.map((heroId) => {
    if (heroId <= 0) return -1;
    if (used.has(heroId)) return -1;
    used.add(heroId);
    return heroId;
  });
}

function findHeroByUid(info, uid) {
  const target = toSafeInt(uid, -1);
  return info.valhalla.find((hero) => toSafeInt(hero && hero.uid, -1) === target) || null;
}

function isHeroEquipped(info, uid) {
  const target = toSafeInt(uid, -1);
  if (target < 0) return false;
  return info.planInfo.some((plan) => {
    const equippedMap = plan && plan.equippedMap && typeof plan.equippedMap === 'object' && !Array.isArray(plan.equippedMap)
      ? plan.equippedMap
      : {};
    return Object.keys(equippedMap).some((key) => toSafeInt(equippedMap[key], -1) === target);
  });
}

function removeHeroByUid(info, uid) {
  const target = toSafeInt(uid, -1);
  if (target < 0) return;
  const removedHero = findHeroByUid(info, target);
  info.valhalla = info.valhalla.filter((hero) => toSafeInt(hero && hero.uid, -1) !== target);
  info.planInfo.forEach((plan) => {
    const equippedMap = plan && plan.equippedMap && typeof plan.equippedMap === 'object' && !Array.isArray(plan.equippedMap)
      ? plan.equippedMap
      : {};
    Object.keys(equippedMap).forEach((key) => {
      if (toSafeInt(equippedMap[key], -1) === target) delete equippedMap[key];
    });
    plan.equippedMap = equippedMap;
    if (removedHero) {
      const removedId = toSafeInt(removedHero.id, 0);
      const stillOwnsHeroId = info.valhalla.some((hero) => toSafeInt(hero && hero.id, 0) === removedId);
      if (!stillOwnsHeroId) {
        plan.skillHeroIds = normalizeSkillHeroIds(plan.skillHeroIds)
          .map((heroId) => (heroId === removedId ? -1 : heroId));
      }
    }
  });
}

function getLevelUpCfg(hero) {
  const quality = getValhallaQualityById(hero.id);
  const levelCfgMap = config.get('ValhallaLevelConfig') || {};
  const qualityMap = levelCfgMap[quality] || {};
  const nextLevel = Math.max(1, toSafeInt(hero.level, 1)) + 1;
  const row = qualityMap[nextLevel] || null;
  if (row) return row;
  const fallbackId = Math.max(1, toSafeInt(getValhallaBaseConfig().exchangeMaterial, 71));
  return { costs: [{ id: fallbackId, count: 1 }] };
}

function getLevelLimitByStar(hero) {
  const quality = getValhallaQualityById(hero.id);
  const starCfgMap = config.get('ValhallaStarConfig') || {};
  const qualityMap = starCfgMap[quality] || {};
  const row = qualityMap[Math.max(0, toSafeInt(hero.star, 0))] || null;
  return row ? Math.max(1, toSafeInt(row.levelLimit, 1)) : Number.MAX_SAFE_INTEGER;
}

function getStarConsumeCount(hero) {
  const quality = getValhallaQualityById(hero.id);
  const starCfgMap = config.get('ValhallaStarUpConfig') || {};
  const qualityMap = starCfgMap[quality] || {};
  const row = qualityMap[Math.max(0, toSafeInt(hero.star, 0))] || null;
  return Math.max(1, toSafeInt(row && row.starUp, 1));
}

function getDecomposeReward(hero) {
  const quality = getValhallaQualityById(hero.id);
  const level = Math.max(1, toSafeInt(hero.level, 1));
  const table = config.get('ValhallaReturnConfig') || {};
  const qualityMap = table[quality] || {};
  const row = qualityMap[level] || null;
  const reward = row && row.returnItem ? row.returnItem : null;
  if (reward && toSafeInt(reward.id, 0) > 0 && toSafeInt(reward.count, 0) > 0) {
    return { id: toSafeInt(reward.id, 0), count: toSafeInt(reward.count, 0) };
  }
  const fallbackId = Math.max(1, toSafeInt(getValhallaBaseConfig().exchangeMaterial, 71));
  return { id: fallbackId, count: Math.max(1, quality * 10) };
}

function appendReward(rewardMap, itemId, count) {
  const id = toSafeInt(itemId, 0);
  const val = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || val <= 0) return;
  rewardMap.set(id, (rewardMap.get(id) || 0) + val);
}

function getResetCostRows(hero) {
  const quality = getValhallaQualityById(hero.id);
  const cfg = (config.get('ValhallaResetConfig') || {})[quality] || {};
  const baseCosts = Array.isArray(cfg.baseCosts) ? cfg.baseCosts : [];
  const levelCosts = Array.isArray(cfg.levelCosts) ? cfg.levelCosts : [];
  const starCosts = Array.isArray(cfg.starCosts) ? cfg.starCosts : [];

  const rows = [];
  baseCosts.forEach((row) => rows.push({ id: toSafeInt(row.id, 0), count: Math.max(0, toSafeInt(row.count, 0)) }));
  levelCosts.forEach((row) => {
    rows.push({
      id: toSafeInt(row.id, 0),
      count: Math.max(0, toSafeInt(row.count, 0) * Math.max(0, toSafeInt(hero.level, 1) - 1)),
    });
  });
  starCosts.forEach((row) => {
    rows.push({
      id: toSafeInt(row.id, 0),
      count: Math.max(0, toSafeInt(row.count, 0) * Math.max(0, toSafeInt(hero.star, 0))),
    });
  });
  return rows.filter((row) => row.id > 0 && row.count > 0);
}

function buildCostMap(rows = []) {
  const map = {};
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const id = toSafeInt(row && row.id, 0);
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    map[id] = (map[id] || 0) + count;
  });
  return map;
}

function convertValhallaCostMap(player, costMap = {}) {
  const next = { ...costMap };
  const exchangeCount = getValhallaBaseConfig().exchangeCount || {};
  [73, 72, 71].forEach((itemId) => {
    const need = Math.max(0, toSafeInt(next[itemId], 0));
    const have = getItemOrCurrencyCount(player, itemId);
    const exchange = exchangeCount[itemId] || exchangeCount[String(itemId)] || null;
    if (need <= 0 || have >= need || !exchange) return;
    const shortage = need - have;
    next[itemId] = have;
    const nextId = toSafeInt(exchange.id, 0);
    const nextCount = Math.max(0, toSafeInt(exchange.count, 0));
    if (nextId > 0 && nextCount > 0) {
      next[nextId] = (next[nextId] || 0) + shortage * nextCount;
    }
  });
  Object.keys(next).forEach((key) => {
    if (toSafeInt(next[key], 0) <= 0) delete next[key];
  });
  return next;
}

function convertResetCostMap(player, costMap = {}) {
  const next = { ...costMap };
  const need209 = Math.max(0, toSafeInt(next[209], 0));
  const have209 = getItemOrCurrencyCount(player, 209);
  const resetExchangeRate = Math.max(0, toSafeInt(getValhallaBaseConfig().resetExchangeRate, 0));
  if (need209 > 0 && have209 < need209 && resetExchangeRate > 0) {
    const shortage = need209 - have209;
    next[209] = have209;
    next[73] = (next[73] || 0) + shortage * resetExchangeRate;
  }
  return convertValhallaCostMap(player, next);
}

function hasEnoughCostMap(player, costMap = {}) {
  return Object.keys(costMap).every((key) => {
    const itemId = toSafeInt(key, 0);
    return hasEnoughItemOrCurrency(player, itemId, costMap[key]);
  });
}

function consumeCostMap(player, costMap = {}) {
  Object.keys(costMap).forEach((key) => {
    const itemId = toSafeInt(key, 0);
    const count = Math.max(0, toSafeInt(costMap[key], 0));
    if (itemId > 0 && count > 0) consumeItemOrCurrency(player, itemId, count);
  });
}

function getPromoteSourceHeroId(heroId) {
  const targetId = Math.max(0, toSafeInt(heroId, 0));
  if (targetId <= 0) return 0;
  const cfgMap = getValhallaCfgMap();
  for (const key of Object.keys(cfgMap)) {
    const row = cfgMap[key];
    if (toSafeInt(row && row.promoteId, 0) === targetId) return Math.max(0, toSafeInt(row.id, 0));
  }
  return 0;
}

function canLegendStageUp(hero, strict = true) {
  const row = getValhallaCfgById(hero && hero.id) || {};
  if (toSafeInt(row.quality, 0) !== 7) return false;
  if (toSafeInt(row.promoteId, 0) <= 0 || !getValhallaCfgById(row.promoteId)) return false;
  if (!strict) return true;
  if (Math.max(0, toSafeInt(hero && hero.star, 0)) < Math.max(0, toSafeInt(row.maxStar, 0))) return false;
  return Math.max(1, toSafeInt(hero && hero.level, 1)) >= getLevelLimitByStar(hero);
}

function getLegendEnhanceConfig(hero) {
  const row = getValhallaCfgById(hero && hero.id) || {};
  const quality = Math.max(0, toSafeInt(row.quality, 0));
  const star = Math.max(0, toSafeInt(hero && hero.star, 0));
  const maxStar = Math.max(0, toSafeInt(row.maxStar, 0));
  const legendCfg = config.get('ValhallaLegendStarUpConfig') || {};
  if (quality === 7) {
    if (!canLegendStageUp(hero, true)) return null;
    return legendCfg[0] || legendCfg['0'] || null;
  }
  if (quality !== 9 || star >= maxStar) return null;
  return legendCfg[star + 1] || legendCfg[String(star + 1)] || null;
}

function getLegendMainHeroId(hero) {
  const row = getValhallaCfgById(hero && hero.id) || {};
  const quality = Math.max(0, toSafeInt(row.quality, 0));
  if (quality === 9) return getPromoteSourceHeroId(row.id);
  return Math.max(0, toSafeInt(row.id, 0));
}

function normalizeSetFlag(params) {
  return !!(params && (params.set === true || toSafeInt(params.set, 0) > 0));
}

function pickEquipSlot(plan, preferredIndex) {
  const slotCount = getPlanSlotCount();
  const preferred = toSafeInt(preferredIndex, -1);
  if (preferred >= 0 && preferred < slotCount) return preferred;
  const equippedMap = plan && plan.equippedMap && typeof plan.equippedMap === 'object' && !Array.isArray(plan.equippedMap)
    ? plan.equippedMap
    : {};
  const used = new Set(Object.keys(equippedMap).map((key) => toSafeInt(key, -1)));
  for (let i = 0; i < slotCount; i++) {
    if (!used.has(i)) return i;
  }
  return 0;
}

function applyPlanEquip(plan, uid, slotIndex) {
  if (!plan.equippedMap || typeof plan.equippedMap !== 'object' || Array.isArray(plan.equippedMap)) {
    plan.equippedMap = {};
  }
  const targetUid = toSafeInt(uid, -1);
  const targetSlot = toSafeInt(slotIndex, -1);
  Object.keys(plan.equippedMap).forEach((key) => {
    if (toSafeInt(plan.equippedMap[key], -1) === targetUid || toSafeInt(key, -1) === targetSlot) {
      delete plan.equippedMap[key];
    }
  });
  if (targetUid >= 0 && targetSlot >= 0 && targetSlot < getPlanSlotCount()) {
    plan.equippedMap[String(targetSlot)] = targetUid;
  }
}

function canEquipHeroInPlan(info, plan, uid, slotIndex) {
  const hero = findHeroByUid(info, uid);
  if (!hero) return false;
  if (slotIndex < 0 || slotIndex >= getPlanSlotCount()) return false;
  const preview = cloneEquippedMap(plan && plan.equippedMap);
  Object.keys(preview).forEach((key) => {
    if (toSafeInt(preview[key], -1) === uid || toSafeInt(key, -1) === slotIndex) {
      delete preview[key];
    }
  });
  const sameHeroCount = Object.keys(preview).reduce((sum, key) => {
    const equippedHero = findHeroByUid(info, preview[key]);
    return sum + (equippedHero && toSafeInt(equippedHero.id, 0) === toSafeInt(hero.id, 0) ? 1 : 0);
  }, 0);
  return sameHeroCount < getSameHeroEquipLimit();
}

function randomPickWeighted(entries) {
  const valid = (Array.isArray(entries) ? entries : []).filter((row) => row && row.weight > 0);
  if (valid.length === 0) return null;
  const total = valid.reduce((sum, row) => sum + row.weight, 0);
  let roll = Math.random() * total;
  for (const row of valid) {
    roll -= row.weight;
    if (roll <= 0) return row;
  }
  return valid[valid.length - 1];
}

function listValhallaIdsByQuality(quality) {
  const q = Math.max(1, toSafeInt(quality, 1));
  const cfgMap = getValhallaCfgMap();
  return Object.keys(cfgMap)
    .map((k) => toSafeInt(k, 0))
    .filter((id) => {
      const row = cfgMap[id];
      return row && toSafeInt(row.quality, 0) === q;
    })
    .sort((a, b) => a - b);
}

function pickSummonRateMap(callType) {
  const callCfg = (config.get('ValhallaCallConfig') || {})[Math.max(1, toSafeInt(callType, 1))] || {};
  const base = getValhallaBaseConfig();
  const type = Math.max(1, toSafeInt(callType, 1));
  const fallbackByType = {
    1: callCfg.callRateShow1 || base.callRateShow1,
    2: callCfg.callRateShow2 || base.callRateShow2,
    3: callCfg.callRateShow3 || base.callRateShow3,
  };
  const rateMap = {
    ...(fallbackByType[type]
    || callCfg.callRateShow1
    || callCfg.callRateShow2
    || base.callRateShow1
    || { 3: 10000 }),
  };
  const baseRateMap = base[`callRateShow${type}`] || base.callRateShow1 || {};
  Object.keys(baseRateMap).forEach((quality) => {
    if (rateMap[quality] == null) rateMap[quality] = baseRateMap[quality];
  });
  return rateMap;
}

function pickSummonQuality(callType) {
  const rateMap = pickSummonRateMap(callType);
  const weighted = Object.keys(rateMap)
    .map((qualityKey) => ({
      quality: Math.max(1, toSafeInt(qualityKey, 1)),
      weight: Math.max(0, toSafeInt(rateMap[qualityKey], 0)),
    }))
    .filter((row) => row.weight > 0);
  const picked = randomPickWeighted(weighted);
  return picked ? picked.quality : 3;
}

function getSummonTargetQuality(callType) {
  const callCfg = (config.get('ValhallaCallConfig') || {})[Math.max(1, toSafeInt(callType, 1))] || {};
  const fromAdjust = Math.max(0, toSafeInt(Array.isArray(callCfg.rateAdjust) ? callCfg.rateAdjust[0] : 0, 0));
  if (fromAdjust > 0) return fromAdjust;
  return Object.keys(pickSummonRateMap(callType))
    .map((key) => toSafeInt(key, 0))
    .filter((quality) => quality > 0)
    .sort((a, b) => b - a)[0] || 0;
}

function buildSummonRateMap(callType, pityCount = 0) {
  const callCfg = (config.get('ValhallaCallConfig') || {})[Math.max(1, toSafeInt(callType, 1))] || {};
  const rateMap = { ...pickSummonRateMap(callType) };
  const adjustQuality = Math.max(0, toSafeInt(Array.isArray(callCfg.rateAdjust) ? callCfg.rateAdjust[0] : 0, 0));
  const rateRow = ((config.get('ValhallaCallRateConfig') || {})[Math.max(1, toSafeInt(callType, 1))] || {})[Math.max(0, toSafeInt(pityCount, 0))] || {};
  const adjustRow = rateRow[adjustQuality] || rateRow[String(adjustQuality)] || null;
  const adjustedRate = Math.min(9999, Math.max(0, toSafeInt(adjustRow && adjustRow.rateShow, 0)));
  if (adjustQuality <= 0 || adjustedRate <= 0) return rateMap;

  const otherKeys = Object.keys(rateMap).filter((key) => toSafeInt(key, 0) !== adjustQuality);
  const otherTotal = otherKeys.reduce((sum, key) => sum + Math.max(0, toSafeInt(rateMap[key], 0)), 0);
  const remain = Math.max(0, 10000 - adjustedRate);
  rateMap[adjustQuality] = adjustedRate;
  if (otherKeys.length <= 0) return rateMap;
  if (otherTotal <= 0) {
    const share = Math.floor(remain / otherKeys.length);
    let tail = remain - share * otherKeys.length;
    otherKeys.forEach((key) => {
      rateMap[key] = share + (tail > 0 ? 1 : 0);
      if (tail > 0) tail -= 1;
    });
    return rateMap;
  }

  let assigned = 0;
  otherKeys.forEach((key, idx) => {
    if (idx === otherKeys.length - 1) {
      rateMap[key] = Math.max(0, remain - assigned);
      return;
    }
    const weight = Math.max(0, toSafeInt(rateMap[key], 0));
    const scaled = Math.floor(remain * weight / otherTotal);
    rateMap[key] = scaled;
    assigned += scaled;
  });
  return rateMap;
}

function getMaxVisiblePityCount(callType) {
  const type = Math.max(1, toSafeInt(callType, 1));
  const callCfg = (config.get('ValhallaCallConfig') || {})[type] || {};
  const adjustQuality = Math.max(0, toSafeInt(Array.isArray(callCfg.rateAdjust) ? callCfg.rateAdjust[0] : 0, 0));
  const rows = (config.get('ValhallaCallRateConfig') || {})[type] || {};
  const counts = Object.keys(rows)
    .map((key) => toSafeInt(key, -1))
    .filter((count) => count >= 0)
    .sort((a, b) => a - b);
  const visibleCounts = counts.filter((count) => {
    const row = rows[count] || rows[String(count)] || {};
    const qualityRow = row[adjustQuality] || row[String(adjustQuality)] || null;
    return Math.max(0, toSafeInt(qualityRow && qualityRow.rateShow, 0)) < 10000;
  });
  if (visibleCounts.length > 0) return visibleCounts[visibleCounts.length - 1];
  return counts.length > 0 ? counts[counts.length - 1] : Number.MAX_SAFE_INTEGER;
}

function pickPoolWishList(info, callType) {
  const poolId = Math.max(1, toSafeInt(callType, 1));
  const poolData = (Array.isArray(info && info.poolData) ? info.poolData : [])
    .find((row) => toSafeInt(row && row.id, 0) === poolId);
  const poolWishList = uniqueInts(Array.isArray(poolData && poolData.wishList) ? poolData.wishList : []);
  if (poolWishList.length > 0) return poolWishList;
  return uniqueInts(Array.isArray(info && info.wishList) ? info.wishList : []);
}

function addSummonedHero(info, heroId) {
  const uid = toSafeInt(info.nextUid, 0);
  info.nextUid = uid + 1;
  const hero = normalizeHero({
    uid,
    id: heroId,
    level: 1,
    star: 0,
    lock: false,
    attrUpgrades: Array.from({ length: getDefaultAttrUpgradeSlots() }, () => 0),
  }, info);
  info.valhalla.push(hero);
  info.unlockedIds = uniqueInts([...info.unlockedIds, hero.id]);
  return hero;
}

function grantValhallaToPlayer(player, heroId) {
  if (!player) return null;
  const info = ensureValhallaInfo(player);
  return buildHeroPayload(addSummonedHero(info, heroId));
}

function getValhallaFragmentReward() {
  const fragmentIds = [100101, 100102, 100103, 100104, 100105];
  const idx = Math.max(0, Math.min(fragmentIds.length - 1, Math.floor(Math.random() * fragmentIds.length)));
  return { id: fragmentIds[idx], count: 1 };
}

function getSummonCostRows(callType) {
  const cfg = (config.get('ValhallaCallConfig') || {})[Math.max(1, toSafeInt(callType, 1))] || {};
  const rows = [];
  if (cfg.cost && toSafeInt(cfg.cost.id, 0) > 0 && toSafeInt(cfg.cost.count, 0) > 0) rows.push(cfg.cost);
  if (cfg.diamondCost && toSafeInt(cfg.diamondCost.id, 0) > 0 && toSafeInt(cfg.diamondCost.count, 0) > 0) rows.push(cfg.diamondCost);
  if (rows.length === 0) rows.push({ id: 79 + Math.max(1, toSafeInt(callType, 1)), count: 1 });
  return rows;
}

function consumeSummonCost(player, callType) {
  const costRows = getSummonCostRows(callType);
  for (const row of costRows) {
    if (hasEnoughItemOrCurrency(player, row.id, row.count)) {
      consumeItemOrCurrency(player, row.id, row.count);
      return { id: toSafeInt(row.id, 0), count: Math.max(0, toSafeInt(row.count, 0)) };
    }
  }
  return null;
}

function updateSummonPoolData(info, callType, quality) {
  const type = Math.max(1, toSafeInt(callType, 1));
  const q = Math.max(1, toSafeInt(quality, 1));
  const targetQuality = getSummonTargetQuality(type);
  const maxVisiblePityCount = getMaxVisiblePityCount(type);
  let row = info.poolData.find((it) => toSafeInt(it && it.id, 0) === type);
  if (!row) {
    row = { id: type, count: 0, wishList: [], lastQuality: q };
    info.poolData.push(row);
  }
  row.count = q >= targetQuality ? 0 : Math.min(maxVisiblePityCount, Math.max(0, toSafeInt(row.count, 0) + 1));
  if (!Array.isArray(row.wishList)) row.wishList = [];
  row.lastQuality = q;
  return row;
}

// change plan (tag:4100)
async function handleValhallaChangePlan(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4100, msgUid, data: { plan: 0, planInfo: [], valhalla: [], poolData: [], unlockedIds: [], rewardedAtlas: [] } };

  const info = ensureValhallaInfo(player);
  const targetPlan = toSafeInt(params && (params.plan != null ? params.plan : params.id), info.plan);
  info.plan = Math.max(0, Math.min(getPlanCountLimit() - 1, targetPlan));
  await playerService.savePlayer(session.userId, player);
  return { tag: 4100, msgUid, data: buildValhallaPayload(info) };
}

// equip / unequip hero in current plan (tag:4101)
async function handleValhallaEquip(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4101, msgUid, data: { data: createEmptyPlan(0) } };

  const info = ensureValhallaInfo(player);
  const targetPlan = toSafeInt(params && (params.plan != null ? params.plan : params.id), info.plan);
  info.plan = Math.max(0, Math.min(getPlanCountLimit() - 1, targetPlan));
  const plan = getPlanById(info, info.plan);

  const isBatchRequest = Array.isArray(params && params.uids);
  const uids = isBatchRequest ? params.uids : [];
  const slots = Array.isArray(params && params.slots)
    ? params.slots
    : params && (params.index != null || params.slot != null)
      ? [params.index != null ? params.index : params.slot]
      : [];

  if (isBatchRequest) {
    uids.forEach((uidRaw, idx) => {
      const uid = toSafeInt(uidRaw, -1);
      if (!findHeroByUid(info, uid)) return;
      const slotRaw = slots.length > idx ? slots[idx] : pickEquipSlot(plan, -1);
      const slotIndex = toSafeInt(slotRaw, -1);
      if (!isSlotUnlockedForPlayer(player, slotIndex)) return;
      if (!canEquipHeroInPlan(info, plan, uid, slotIndex)) return;
      applyPlanEquip(plan, uid, slotIndex);
    });
  } else {
    const uid = toSafeInt(params && params.uid, -1);
    if (findHeroByUid(info, uid)) {
      const set = normalizeSetFlag(params);
      const slotIndex = pickEquipSlot(plan, params && (params.index != null ? params.index : params.slot));
      if (!set || (isSlotUnlockedForPlayer(player, slotIndex) && canEquipHeroInPlan(info, plan, uid, slotIndex))) {
        applyPlanEquip(plan, uid, set ? slotIndex : -1);
      }
    }
  }

  plan.skillHeroIds = normalizeSkillHeroIdsForPlan(plan.skillHeroIds, info, plan);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4101,
    msgUid,
    data: {
      data: buildPlanPayload(plan),
      result: 0,
      planInfo: buildValhallaPayload(info).planInfo,
    },
  };
}

// level up hero (tag:4102)
async function handleValhallaLevelUp(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4102, msgUid, data: { result: -1 } };

  const info = ensureValhallaInfo(player);
  const uid = toSafeInt(params && params.uid, -1);
  const hero = findHeroByUid(info, uid);
  if (!hero) return { tag: 4102, msgUid, data: { result: -1 } };

  const levelLimit = getLevelLimitByStar(hero);
  if (toSafeInt(hero.level, 1) >= levelLimit) {
    return { tag: 4102, msgUid, data: { result: 1 } };
  }

  const nextCfg = getLevelUpCfg(hero);
  if (!nextCfg) return { tag: 4102, msgUid, data: { result: 1 } };

  const costMap = convertValhallaCostMap(player, buildCostMap(nextCfg.costs));
  if (!hasEnoughCostMap(player, costMap)) {
    return { tag: 4102, msgUid, data: { result: 1 } };
  }
  const touchedIds = Object.keys(costMap).map((key) => toSafeInt(key, 0));
  const beforeCounts = snapshotItemCounts(player, touchedIds);
  consumeCostMap(player, costMap);

  hero.level = Math.min(levelLimit, Math.max(1, toSafeInt(hero.level, 1) + 1));
  await playerService.savePlayer(session.userId, player);
  const response = { tag: 4102, msgUid, data: { result: 0, data: buildHeroPayload(hero), valhalla: buildValhallaPayload(info).valhalla } };
  const syncPacket = buildItemSyncPacket(player, beforeCounts, touchedIds);
  return syncPacket ? [syncPacket, response] : response;
}

// star up hero (tag:4103)
async function handleValhallaStarUp(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4103, msgUid, data: { result: -1 } };

  const info = ensureValhallaInfo(player);
  const uid = toSafeInt(params && (params.targetUid != null ? params.targetUid : params.uid), -1);
  const hero = findHeroByUid(info, uid);
  if (!hero) return { tag: 4103, msgUid, data: { result: -1, rewards: buildRewardInfo() } };

  const maxStar = getValhallaMaxStarById(hero.id);
  if (toSafeInt(hero.star, 0) >= maxStar) {
    return { tag: 4103, msgUid, data: { result: 1, rewards: buildRewardInfo() } };
  }

  const consumeCount = getStarConsumeCount(hero);
  const requestedCosts = uniqueInts(Array.isArray(params && params.costs) ? params.costs : []);
  const candidatePool = info.valhalla
    .filter((row) => toSafeInt(row.id, 0) === toSafeInt(hero.id, 0))
    .filter((row) => toSafeInt(row.uid, -1) !== uid)
    .filter((row) => !row.lock)
    .filter((row) => !isHeroEquipped(info, row.uid))
    .sort((a, b) => toSafeInt(a.uid, 0) - toSafeInt(b.uid, 0));
  const requestedValid = requestedCosts
    .map((costUid) => candidatePool.find((row) => toSafeInt(row.uid, -1) === costUid))
    .filter(Boolean);
  const candidates = requestedValid.length >= consumeCount ? requestedValid : candidatePool;
  if (candidates.length < consumeCount) {
    return { tag: 4103, msgUid, data: { result: 1, rewards: buildRewardInfo() } };
  }

  const costUids = candidates.slice(0, consumeCount).map((row) => toSafeInt(row.uid, -1));
  costUids.forEach((costUid) => removeHeroByUid(info, costUid));

  hero.star = Math.min(maxStar, Math.max(0, toSafeInt(hero.star, 0) + 1));
  const levelLimit = getLevelLimitByStar(hero);
  hero.level = Math.min(levelLimit, Math.max(1, toSafeInt(hero.level, 1)));

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4103,
    msgUid,
    data: {
      result: 0,
      costs: costUids,
      costUids,
      data: buildHeroPayload(hero),
      rewards: buildRewardInfo(),
      valhalla: buildValhallaPayload(info).valhalla,
    },
  };
}

// equip skill for hero (tag:4105)
async function handleValhallaSkillEquip(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4105, msgUid, data: { result: -1 } };

  const info = ensureValhallaInfo(player);
  const targetPlan = toSafeInt(params && (params.plan != null ? params.plan : params.id), info.plan);
  info.plan = Math.max(0, Math.min(getPlanCountLimit() - 1, targetPlan));
  const plan = getPlanById(info, info.plan);

  if (Array.isArray(params && params.heroIds)) {
    plan.skillHeroIds = normalizeSkillHeroIdsForPlan(params.heroIds, info, plan);
  } else {
    const uid = toSafeInt(params && params.uid, -1);
    const hero = findHeroByUid(info, uid);
    if (!hero) return { tag: 4105, msgUid, data: { result: -1, plan: plan.id, heroIds: buildPlanPayload(plan).skillHeroIds } };
    const nextSkillHeroIds = normalizeSkillHeroIdsForPlan(plan.skillHeroIds, info, plan);
    const allowedSet = new Set(Array.from(buildStrongestEquippedHeroMap(info, plan).keys()));
    if (!allowedSet.has(toSafeInt(hero.id, -1))) {
      return { tag: 4105, msgUid, data: { result: -1, plan: plan.id, heroIds: buildPlanPayload(plan).skillHeroIds } };
    }
    const slotCount = getSkillHeroSlotCount();
    const index = Math.max(0, Math.min(slotCount - 1, toSafeInt(params && params.index, 0)));
    nextSkillHeroIds[index] = toSafeInt(hero.id, -1);
    plan.skillHeroIds = normalizeSkillHeroIdsForPlan(nextSkillHeroIds, info, plan);
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4105,
    msgUid,
    data: {
      plan: plan.id,
      heroIds: buildPlanPayload(plan).skillHeroIds,
    },
  };
}

// summon valhalla heroes (tag:4106)
async function handleValhallaSummon(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 4106,
      msgUid,
      data: {
        result: -1,
        rewards: buildRewardInfo(),
        summonResult: [],
        poolData: { id: 0, count: 0, wishList: [] },
        valhalla: [],
      },
    };
  }

  const info = ensureValhallaInfo(player);
  const callType = Math.max(1, toSafeInt(params && (params.pool != null ? params.pool : (params.type != null ? params.type : params.id)), 1));
  const reqTimes = Math.max(1, toSafeInt(params && (params.count != null ? params.count : params.times), 1));
  const onceCount = Math.max(1, toSafeInt(getValhallaBaseConfig().callNum, 5));
  const maxTimes = onceCount * onceCount;
  const usesRoundCount = params && Object.prototype.hasOwnProperty.call(params, 'useDiamond');
  const times = Math.min(maxTimes, usesRoundCount ? reqTimes * onceCount : reqTimes);
  const decomposeQuality = Math.max(0, toSafeInt(params && params.decomposeQuality, 0));

  const summoned = [];
  const costs = [];
  const extraRewards = [];
  const touchedIds = new Set();
  const beforeCounts = {};
  const knownUnlockedIds = new Set((Array.isArray(info.unlockedIds) ? info.unlockedIds : []).map((id) => toSafeInt(id, 0)));
  let poolData = info.poolData.find((row) => toSafeInt(row && row.id, 0) === callType) || { id: callType, count: 0, wishList: [] };
  for (let i = 0; i < times; i++) {
    const pityCount = Math.max(0, toSafeInt(poolData && poolData.count, 0));
    const paid = (!usesRoundCount || i % onceCount === 0) ? consumeSummonCost(player, callType) : null;
    if ((!usesRoundCount || i % onceCount === 0) && !paid) break;
    if (paid) {
      costs.push(paid);
      if (beforeCounts[paid.id] == null) beforeCounts[paid.id] = getItemOrCurrencyCount(player, paid.id) + paid.count;
      touchedIds.add(toSafeInt(paid.id, 0));
    }

    const quality = (() => {
      const rateMap = buildSummonRateMap(callType, pityCount);
      const weighted = Object.keys(rateMap)
        .map((qualityKey) => ({
          quality: Math.max(1, toSafeInt(qualityKey, 1)),
          weight: Math.max(0, toSafeInt(rateMap[qualityKey], 0)),
        }))
        .filter((row) => row.weight > 0);
      const picked = randomPickWeighted(weighted);
      return picked ? picked.quality : pickSummonQuality(callType);
    })();
    const wishList = pickPoolWishList(info, callType);
    const qualityIds = listValhallaIdsByQuality(quality);
    if (qualityIds.length === 0) {
      const reward = getValhallaFragmentReward();
      if (beforeCounts[reward.id] == null) beforeCounts[reward.id] = getItemOrCurrencyCount(player, reward.id);
      addItemOrCurrency(player, reward.id, reward.count);
      extraRewards.push(reward);
      touchedIds.add(reward.id);
      summoned.push(reward);
      poolData = updateSummonPoolData(info, callType, quality);
      continue;
    }
    const wished = qualityIds.filter((id) => wishList.includes(id));
    const pool = wished.length > 0 ? wished : qualityIds;
    const heroId = pool[toSafeInt(Math.floor(Math.random() * pool.length), 0)];
    const hero = addSummonedHero(info, heroId);
    summoned.push(hero);
    const isDuplicate = knownUnlockedIds.has(heroId);
    if (decomposeQuality > 0 && isDuplicate && getValhallaQualityById(heroId) <= decomposeQuality) {
      const reward = getDecomposeReward(hero);
      removeHeroByUid(info, hero.uid);
      if (reward.id > 0 && reward.count > 0) {
        if (beforeCounts[reward.id] == null) beforeCounts[reward.id] = getItemOrCurrencyCount(player, reward.id);
        addItemOrCurrency(player, reward.id, reward.count);
        extraRewards.push(reward);
        touchedIds.add(reward.id);
      }
    }
    poolData = updateSummonPoolData(info, callType, quality);
    knownUnlockedIds.add(heroId);
  }

  if (summoned.length === 0) {
    return { tag: 4106, msgUid, data: { result: 1, rewards: buildRewardInfo(), summonResult: [], poolData } };
  }

  await playerService.savePlayer(session.userId, player);
  const summonResult = summoned.map((row) => ({
    id: toSafeInt(row && row.id, 0),
    count: Math.max(1, toSafeInt(row && row.count, 1)),
  }));
  const remainingUidSet = new Set((Array.isArray(info.valhalla) ? info.valhalla : []).map((hero) => toSafeInt(hero && hero.uid, -1)));
  const keptSummoned = summoned.filter((hero) => remainingUidSet.has(toSafeInt(hero && hero.uid, -1)));
  const response = {
    tag: 4106,
    msgUid,
    data: {
      result: 0,
      summonResult,
      poolData: {
        id: Math.max(1, toSafeInt(poolData && poolData.id, callType)),
        count: Math.max(0, toSafeInt(poolData && poolData.count, 0)),
        wishList: uniqueInts(Array.isArray(poolData && poolData.wishList) ? poolData.wishList : []),
      },
      rewards: buildRewardInfo(extraRewards, keptSummoned),
      summoned,
      valhalla: buildValhallaPayload(info).valhalla,
      costs,
    },
  };
  const syncPacket = buildItemSyncPacket(player, beforeCounts, Array.from(touchedIds));
  return syncPacket ? [syncPacket, response] : response;
}

// set summon wish list (tag:4107)
async function handleValhallaSummonWishList(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4107, msgUid, data: { result: -1, wishList: [] } };

  const info = ensureValhallaInfo(player);
  const poolId = Math.max(1, toSafeInt(params && (params.pool != null ? params.pool : params.id), 1));
  const rawIds = Array.isArray(params && params.wish)
    ? params.wish
    : Array.isArray(params && params.ids)
      ? params.ids
      : params && params.heroId != null
        ? [params.heroId]
        : [];
  const allHeroIds = new Set(Object.keys(getValhallaCfgMap()).map((k) => toSafeInt(k, 0)).filter((id) => id > 0));
  const wishLimit = Math.max(1, toSafeInt(getValhallaBaseConfig().callNum, 5));
  const wishList = uniqueInts(rawIds)
    .filter((id) => allHeroIds.size === 0 || allHeroIds.has(id))
    .slice(0, wishLimit);
  info.wishList = wishList;
  let poolData = info.poolData.find((row) => toSafeInt(row && row.id, 0) === poolId);
  if (!poolData) {
    poolData = { id: poolId, count: 0, wishList: [] };
    info.poolData.push(poolData);
  }
  poolData.wishList = wishList;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4107,
    msgUid,
    data: {
      data: {
        id: poolId,
        count: Math.max(0, toSafeInt(poolData.count, 0)),
        wishList: [...wishList],
      },
      result: 0,
      wishList: [...wishList],
    },
  };
}

// claim atlas reward by hero id (tag:4108)
async function handleValhallaAtlasReward(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    const emptyReward = buildRewardInfo([], []);
    return { tag: 4108, msgUid, data: { result: -1, rewarded: [], rewardedAtlas: [], rewards: emptyReward, rewardInfo: emptyReward } };
  }

  const info = ensureValhallaInfo(player);
  let atlasId = toSafeInt(params && params.id, 0);
  const rewardedAtlas = [];
  const rewardItems = [];
  const touchedIds = new Set();
  const beforeCounts = {};

  if (atlasId <= 0) {
    atlasId = info.unlockedIds.find((id) => !info.rewardedAtlas.includes(id)) || 0;
  }

  if (
    atlasId > 0
    && info.unlockedIds.includes(atlasId)
    && !info.rewardedAtlas.includes(atlasId)
  ) {
    info.rewardedAtlas.push(atlasId);
    rewardedAtlas.push(atlasId);

    const row = getValhallaCfgById(atlasId) || {};
    const reward = row.atlasReward || { id: 1, count: 10 };
    if (reward && toSafeInt(reward.id, 0) > 0 && toSafeInt(reward.count, 0) > 0) {
      const item = { id: toSafeInt(reward.id, 0), count: Math.max(0, toSafeInt(reward.count, 0)) };
      beforeCounts[item.id] = getItemOrCurrencyCount(player, item.id);
      addItemOrCurrency(player, item.id, item.count);
      rewardItems.push(item);
      touchedIds.add(item.id);
    }
  }

  await playerService.savePlayer(session.userId, player);
  const rewardInfo = buildRewardInfo(rewardItems, []);
  const response = {
    tag: 4108,
    msgUid,
    data: {
      result: 0,
      rewarded: rewardedAtlas,
      rewardedAtlas,
      rewards: rewardInfo,
      rewardInfo,
    },
  };
  const syncPacket = buildItemSyncPacket(player, beforeCounts, Array.from(touchedIds));
  return syncPacket ? [syncPacket, response] : response;
}

// lock / unlock hero (tag:4109)
async function handleValhallaHeroLock(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4109, msgUid, data: { result: -1 } };

  const info = ensureValhallaInfo(player);
  const uid = toSafeInt(params && params.uid, -1);
  const hero = findHeroByUid(info, uid);
  if (!hero) return { tag: 4109, msgUid, data: { result: -1 } };

  hero.lock = !!(params && (params.lock === true || toSafeInt(params.lock, 0) > 0));
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4109,
    msgUid,
    data: {
      result: 0,
      data: buildHeroPayload(hero),
      uid,
      lock: hero.lock ? 1 : 0,
      valhalla: buildValhallaPayload(info).valhalla,
    },
  };
}

// reset hero level/star and refund materials (tag:4110)
async function handleValhallaReset(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4110, msgUid, data: { result: -1, data: [], rewardInfo: buildRewardInfo() } };

  const info = ensureValhallaInfo(player);
  const uid = toSafeInt(params && params.uid, -1);
  const hero = findHeroByUid(info, uid);
  if (!hero) return { tag: 4110, msgUid, data: { result: -1, data: [], rewardInfo: buildRewardInfo() } };
  if (isHeroEquipped(info, uid)) return { tag: 4110, msgUid, data: { result: 1, data: [], rewardInfo: buildRewardInfo() } };

  const level = Math.max(1, toSafeInt(hero.level, 1));
  const star = Math.max(0, toSafeInt(hero.star, 0));
  if (level <= 1 && star <= 0) return { tag: 4110, msgUid, data: { result: 1, data: [], rewardInfo: buildRewardInfo() } };

  const costMap = convertResetCostMap(player, buildCostMap(getResetCostRows(hero)));
  if (!hasEnoughCostMap(player, costMap)) {
    return { tag: 4110, msgUid, data: { result: 1, data: [], rewardInfo: buildRewardInfo() } };
  }
  const touchedIds = new Set(Object.keys(costMap).map((key) => toSafeInt(key, 0)));
  const beforeCounts = snapshotItemCounts(player, Array.from(touchedIds));
  consumeCostMap(player, costMap);

  const rewardMap = new Map();
  const levelReward = getDecomposeReward(hero);
  appendReward(rewardMap, levelReward.id, levelReward.count);
  if (star > 0) {
    const matId = Math.max(1, toSafeInt(getValhallaBaseConfig().exchangeMaterial, 71));
    appendReward(rewardMap, matId, star * 20);
  }

  hero.level = 1;
  hero.star = 0;
  hero.attrUpgrades = Array.from({ length: getDefaultAttrUpgradeSlots() }, () => 0);

  const rewards = Array.from(rewardMap.entries())
    .map(([id, count]) => ({ id: toSafeInt(id, 0), count: Math.max(0, toSafeInt(count, 0)) }))
    .filter((row) => row.id > 0 && row.count > 0);
  rewards.forEach((row) => {
    if (beforeCounts[row.id] == null) beforeCounts[row.id] = getItemOrCurrencyCount(player, row.id);
    addItemOrCurrency(player, row.id, row.count);
    touchedIds.add(row.id);
  });

  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 4110,
    msgUid,
    data: {
      result: 0,
      uid,
      rewards,
      data: [buildHeroPayload(hero)],
      rewardInfo: buildRewardInfo(rewards),
      valhalla: buildValhallaPayload(info).valhalla,
    },
  };
  const syncPacket = buildItemSyncPacket(player, beforeCounts, Array.from(touchedIds));
  return syncPacket ? [syncPacket, response] : response;
}

// legend stage-up / red-star-up (tag:4111)
async function handleValhallaEnhance(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4111, msgUid, data: { result: -1 } };

  const info = ensureValhallaInfo(player);
  const uid = toSafeInt(params && params.uid, -1);
  const hero = findHeroByUid(info, uid);
  if (!hero) return { tag: 4111, msgUid, data: { result: -1 } };

  const legendCfg = getLegendEnhanceConfig(hero);
  if (!legendCfg) return { tag: 4111, msgUid, data: { result: 1 } };

  const mainHeroId = getLegendMainHeroId(hero);
  const mainCostCount = Math.max(0, toSafeInt(legendCfg.mainCosts, 0));
  const randomCostCount = Math.max(0, toSafeInt(legendCfg.randomCosts, 0));
  const selfUids = uniqueInts(Array.isArray(params && params.self) ? params.self : []);
  const otherEntries = Array.isArray(params && params.others) ? params.others : [];
  const standCount = Math.max(0, toSafeInt(params && params.stand, 0));
  const sourceQuality = getValhallaQualityById(mainHeroId || hero.id);

  const mainUids = selfUids
    .filter((costUid) => costUid !== uid)
    .filter((costUid) => {
      const costHero = findHeroByUid(info, costUid);
      return costHero && toSafeInt(costHero.id, 0) === mainHeroId;
    })
    .slice(0, mainCostCount);

  const randomHeroUids = [];
  const extraItemCostMap = {};
  otherEntries.forEach((entry) => {
    const heroCost = findHeroByUid(info, entry);
    if (heroCost && toSafeInt(heroCost.uid, -1) !== uid) {
      if (getValhallaQualityById(heroCost.id) === sourceQuality) {
        randomHeroUids.push(toSafeInt(heroCost.uid, -1));
      }
      return;
    }
    const itemId = toSafeInt(entry, 0);
    if (itemId > 0) extraItemCostMap[itemId] = (extraItemCostMap[itemId] || 0) + 1;
  });
  if (standCount > 0) extraItemCostMap[LEGEND_RANDOM_ITEM_ID] = (extraItemCostMap[LEGEND_RANDOM_ITEM_ID] || 0) + standCount;

  const usableRandomHeroUids = uniqueInts(randomHeroUids).filter((costUid) => mainUids.indexOf(costUid) < 0);
  const randomItemCount = Object.keys(extraItemCostMap).reduce((sum, key) => sum + Math.max(0, toSafeInt(extraItemCostMap[key], 0)), 0);
  if (mainUids.length < mainCostCount || usableRandomHeroUids.length + randomItemCount < randomCostCount) {
    return { tag: 4111, msgUid, data: { result: 1 } };
  }

  const itemCostMap = buildCostMap(legendCfg.costs);
  Object.keys(extraItemCostMap).forEach((key) => {
    const itemId = toSafeInt(key, 0);
    const count = Math.max(0, toSafeInt(extraItemCostMap[key], 0));
    if (itemId > 0 && count > 0) itemCostMap[itemId] = (itemCostMap[itemId] || 0) + count;
  });
  if (!hasEnoughCostMap(player, itemCostMap)) {
    return { tag: 4111, msgUid, data: { result: 1 } };
  }

  const touchedIds = Object.keys(itemCostMap).map((key) => toSafeInt(key, 0));
  const beforeCounts = snapshotItemCounts(player, touchedIds);
  consumeCostMap(player, itemCostMap);

  const randomHeroCostUids = usableRandomHeroUids.slice(0, Math.max(0, randomCostCount - randomItemCount));
  const consumedUids = uniqueInts([...mainUids, ...randomHeroCostUids]);
  consumedUids.forEach((costUid) => removeHeroByUid(info, costUid));

  if (canLegendStageUp(hero, true)) {
    const promoteId = toSafeInt((getValhallaCfgById(hero.id) || {}).promoteId, 0);
    if (promoteId > 0) hero.id = promoteId;
    hero.star = 0;
    hero.level = Math.min(getLevelLimitByStar(hero), Math.max(1, toSafeInt(hero.level, 1)));
    info.unlockedIds = uniqueInts([...(Array.isArray(info.unlockedIds) ? info.unlockedIds : []), hero.id]);
  } else {
    hero.star = Math.min(getValhallaMaxStarById(hero.id), Math.max(0, toSafeInt(hero.star, 0) + 1));
    hero.level = Math.min(getLevelLimitByStar(hero), Math.max(1, toSafeInt(hero.level, 1)));
  }

  const plan = getPlanById(info, info.plan);
  if (plan) plan.skillHeroIds = normalizeSkillHeroIdsForPlan(plan.skillHeroIds, info, plan);

  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 4111,
    msgUid,
    data: {
      result: 0,
      uid,
      costs: consumedUids,
      consume: itemCostMap,
      data: buildHeroPayload(hero),
      plan: plan ? buildPlanPayload(plan) : null,
    },
  };
  const syncPacket = buildItemSyncPacket(player, beforeCounts, touchedIds);
  return syncPacket ? [syncPacket, response] : response;
}

// decompose selected heroes (tag:4104)
async function handleValhallaDecompose(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4104, msgUid, data: { result: -1, costs: [], rewards: buildRewardInfo() } };

  const info = ensureValhallaInfo(player);
  const uidList = Array.isArray(params && params.costs)
    ? params.costs
    : Array.isArray(params && params.uids)
      ? params.uids
      : params && params.uid != null
        ? [params.uid]
        : [];
  const requestUids = uniqueInts(uidList);
  const removedUids = [];
  const rewardMap = new Map();

  requestUids.forEach((uid) => {
    const hero = findHeroByUid(info, uid);
    if (!hero) return;
    if (hero.lock) return;
    if (isHeroEquipped(info, uid)) return;

    const reward = getDecomposeReward(hero);
    removedUids.push(uid);
    removeHeroByUid(info, uid);
    rewardMap.set(reward.id, (rewardMap.get(reward.id) || 0) + reward.count);
  });

  const rewards = Array.from(rewardMap.entries())
    .map(([id, count]) => ({ id: toSafeInt(id, 0), count: Math.max(0, toSafeInt(count, 0)) }))
    .filter((row) => row.id > 0 && row.count > 0);
  const touchedIds = rewards.map((row) => row.id);
  const beforeCounts = snapshotItemCounts(player, touchedIds);
  rewards.forEach((row) => addItemOrCurrency(player, row.id, row.count));

  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 4104,
    msgUid,
    data: {
      result: 0,
      costs: removedUids,
      uids: removedUids,
      rewards: buildRewardInfo(rewards),
      items: rewards,
      valhalla: buildValhallaPayload(info).valhalla,
    },
  };
  const syncPacket = buildItemSyncPacket(player, beforeCounts, touchedIds);
  return syncPacket ? [syncPacket, response] : response;
}

module.exports = {
  ensureValhallaInfo,
  grantValhallaToPlayer,
  buildValhallaPayload,
  handleValhallaChangePlan,
  handleValhallaEquip,
  handleValhallaLevelUp,
  handleValhallaStarUp,
  handleValhallaSkillEquip,
  handleValhallaSummon,
  handleValhallaSummonWishList,
  handleValhallaAtlasReward,
  handleValhallaHeroLock,
  handleValhallaReset,
  handleValhallaEnhance,
  handleValhallaDecompose,
};
