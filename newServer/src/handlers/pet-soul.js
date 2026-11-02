const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const { addRewardToPlayer } = require('./raid');

const PET_SOUL_CATCH_ITEM_BY_QUALITY = {
  3: 253,
  4: 254,
  5: 255,
  6: 256,
  7: 257,
};

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
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

function toDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return Number(`${y}${m}${day}`);
}

function weightedPick(rows = [], getWeight = (row) => row.weight || 0) {
  const normalized = rows
    .map((row) => ({ row, weight: Math.max(0, toSafeInt(getWeight(row), 0)) }))
    .filter((entry) => entry.weight > 0);
  if (normalized.length === 0) return null;

  const total = normalized.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < normalized.length; i++) {
    roll -= normalized[i].weight;
    if (roll <= 0) return normalized[i].row;
  }
  return normalized[normalized.length - 1].row;
}

function buildRewardInfo(rows = []) {
  return {
    items: (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        id: toSafeInt(row && row.id, 0),
        count: Math.max(0, toSafeInt(row && row.count, 0)),
      }))
      .filter((row) => row.id > 0 && row.count > 0),
    equips: [],
    heros: [],
  };
}

function grantRewards(player, rows = []) {
  const merged = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const id = toSafeInt(row && row.id, 0);
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    addRewardToPlayer(player, id, count);
    merged.set(id, (merged.get(id) || 0) + count);
  });
  return buildRewardInfo(Array.from(merged.entries()).map(([id, count]) => ({ id, count })));
}

function consumeItem(player, itemId, count) {
  const id = toSafeInt(itemId, 0);
  const need = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || need <= 0) return true;
  player.items = player.items || {};
  const have = Math.max(0, toSafeInt(player.items[id], 0));
  if (have < need) return false;
  player.items[id] = have - need;
  return true;
}

function getItemCount(player, itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return 0;
  return Math.max(0, toSafeInt(player && player.items && player.items[id], 0));
}

function normalizeItemRows(rows = []) {
  const merged = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const id = toSafeInt(row && row.id, 0);
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    merged.set(id, (merged.get(id) || 0) + count);
  });
  return Array.from(merged.entries()).map(([id, count]) => ({ id, count }));
}

function hasItems(player, rows = []) {
  return normalizeItemRows(rows).every((row) => getItemCount(player, row.id) >= row.count);
}

function consumeItems(player, rows = []) {
  const normalized = normalizeItemRows(rows);
  if (!hasItems(player, normalized)) return false;
  normalized.forEach((row) => {
    consumeItem(player, row.id, row.count);
  });
  return true;
}

function buildItemSyncPacket(player, items, msgUid = 0) {
  const rows = (Array.isArray(items) ? items : [])
    .map((row) => ({ id: toSafeInt(row && row.id, 0), count: Math.max(0, toSafeInt(row && row.count, 0)) }))
    .filter((row) => row.id > 0 && row.count > 0);
  return {
    tag: 1202,
    msgUid,
    data: {
      result: 0,
      items: rows.map((row) => ({ id: row.id, count: -row.count })),
      changed: rows.map((row) => ({ id: row.id, count: Math.max(0, toSafeInt(player && player.items && player.items[row.id], 0)) })),
    },
  };
}

function getPetSoulConfig() {
  return config.get('PetSoulConfig') || {};
}

function getPetSoulUpgradeConfig() {
  return config.get('PetSoulUpgradeConfig') || {};
}

function getPetSoulBaseConfig() {
  return config.get('PetSoulBaseConfig') || {};
}

function getPetSoulCallRateConfig() {
  return config.get('PetSoulCallRateConfig') || {};
}

function getPetSoulQualityConfig() {
  return config.get('PetSoulQualityConfig') || {};
}

function getPetSoulPillConfig() {
  return config.get('PetSoulPillConfig') || {};
}

function getPetSoulUpgradeMaterialConfig() {
  return config.get('PetSoulUpgradeMaterialConfig') || {};
}

function getPetSoulSpecialConfig() {
  return config.get('PetSoulSpecialConfig') || {};
}

function getPetSoulCatchRateConfig() {
  return config.get('PetSoulCatchRateConfig') || {};
}

function getPetSoulEscapeRateConfig() {
  return config.get('PetSoulEscapeRateConfig') || {};
}

function getConfiguredRewardRows(...names) {
  for (const name of names) {
    const value = getPetSoulBaseConfig()[name];
    if (Array.isArray(value)) return normalizeItemRows(value);
    if (value && typeof value === 'object') return normalizeItemRows([value]);
  }
  return [];
}

function getPetSoulMaxStarByQuality(quality) {
  const upgradeCfg = getPetSoulUpgradeConfig()[Math.max(0, toSafeInt(quality, 0))] || {};
  return Object.keys(upgradeCfg)
    .map((key) => toSafeInt(key, 0))
    .reduce((max, star) => Math.max(max, star), 0);
}

function getPetSoulQuality(id) {
  const row = getPetSoulConfig()[Math.max(0, toSafeInt(id, 0))] || {};
  return Math.max(3, toSafeInt(row.quality, 3));
}

function createDefaultPetSoulData(id) {
  const petSoulCfg = getPetSoulConfig()[Math.max(0, toSafeInt(id, 0))] || {};
  const maxAttr = petSoulCfg.maxAttr || {};
  const initialAttr = Math.max(1000, toSafeInt(getPetSoulBaseConfig().initialAttr, 3000));
  const attrRatio = {};
  Object.keys(maxAttr).forEach((attrId) => {
    attrRatio[attrId] = initialAttr;
  });

  const initialPassive = Array.isArray(petSoulCfg.initialPassiveSkill)
    ? petSoulCfg.initialPassiveSkill.map((skillId) => toSafeInt(skillId, 0)).filter((skillId) => skillId > 0)
    : [];

  return {
    id: Math.max(1, toSafeInt(id, 1)),
    star: 0,
    petUid: -1,
    special: 0,
    attrRatio,
    passive: initialPassive,
    life: Math.max(0, toSafeInt(petSoulCfg.initialLifeSkill, 0)),
    wash: 0,
    attrDrugUse: {},
  };
}

function normalizePetSoulData(row) {
  const src = row && typeof row === 'object' ? row : {};
  const requestedId = Math.max(0, toSafeInt(src.id, 0));
  const cfgMap = getPetSoulConfig();
  const safeId = cfgMap[requestedId] ? requestedId : getFallbackPetSoulId();
  const cfg = cfgMap[safeId] || {};
  const quality = Math.max(3, toSafeInt(cfg.quality, 3));
  const maxStar = getPetSoulMaxStarByQuality(quality);

  const attrRatio = {};
  const maxAttr = cfg.maxAttr || {};
  if (src.attrRatio && typeof src.attrRatio === 'object') {
    Object.keys(src.attrRatio).forEach((attrId) => {
      attrRatio[attrId] = Math.max(0, toSafeInt(src.attrRatio[attrId], 0));
    });
  }
  Object.keys(maxAttr).forEach((attrId) => {
    if (attrRatio[attrId] == null) attrRatio[attrId] = Math.max(1000, toSafeInt(getPetSoulBaseConfig().initialAttr, 3000));
  });

  const attrDrugUse = {};
  if (src.attrDrugUse && typeof src.attrDrugUse === 'object') {
    Object.keys(src.attrDrugUse).forEach((itemId) => {
      const count = Math.max(0, toSafeInt(src.attrDrugUse[itemId], 0));
      if (count <= 0) return;
      attrDrugUse[itemId] = count;
    });
  }

  return {
    id: safeId,
    star: Math.max(0, Math.min(maxStar, toSafeInt(src.star, 0))),
    petUid: toSafeInt(src.petUid, -1),
    special: normalizePetSoulSpecial(quality, src.special),
    attrRatio,
    passive: uniqueInts(Array.isArray(src.passive) ? src.passive : []),
    life: Math.max(0, toSafeInt(src.life, toSafeInt(cfg.initialLifeSkill, 0))),
    wash: Math.max(0, toSafeInt(src.wash, 0)),
    attrDrugUse,
  };
}

function normalizeSummonData(row) {
  const src = row && typeof row === 'object' ? row : {};
  return {
    pos: Math.max(1, toSafeInt(src.pos, 1)),
    id: Math.max(1, toSafeInt(src.id, 1)),
    state: Math.max(0, toSafeInt(src.state, 0)),
    round: Math.max(0, toSafeInt(src.round, 0)),
  };
}

function normalizeDispatchMap(dispatch) {
  const out = {};
  if (!dispatch || typeof dispatch !== 'object') return out;
  Object.keys(dispatch).forEach((type) => {
    const typeId = Math.max(0, toSafeInt(type, 0));
    const soulId = Math.max(0, toSafeInt(dispatch[type], 0));
    if (typeId <= 0 || soulId <= 0) return;
    out[typeId] = soulId;
  });
  return out;
}

function normalizeNumericMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  Object.keys(raw).forEach((key) => {
    out[key] = Math.max(0, toSafeInt(raw[key], 0));
  });
  return out;
}

function getDefaultPetSoulIds() {
  const petSoulCfg = getPetSoulConfig();
  return Object.keys(petSoulCfg)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b)
    .slice(0, 3);
}

function getFallbackPetSoulId() {
  return getDefaultPetSoulIds()[0] || 210101;
}

function normalizePetSoulSpecial(quality, special) {
  const refiningByQuality = getPetSoulQualityConfig() && (config.get('PetSoulRefiningConfig') || {})[Math.max(0, toSafeInt(quality, 0))];
  if (!refiningByQuality || typeof refiningByQuality !== 'object') return 0;
  const keys = Object.keys(refiningByQuality)
    .map((key) => toSafeInt(key, -1))
    .filter((key) => key >= 0)
    .sort((a, b) => a - b);
  if (keys.length === 0) return 0;
  const requested = Math.max(0, toSafeInt(special, 0));
  return keys.includes(requested) ? requested : keys[0];
}

function ensurePetSoulInfo(player) {
  player.other_attr_info = player.other_attr_info && typeof player.other_attr_info === 'object' && !Array.isArray(player.other_attr_info)
    ? player.other_attr_info
    : {};

  const holder = player.other_attr_info;
  holder.petSoulInfo = holder.petSoulInfo && typeof holder.petSoulInfo === 'object' && !Array.isArray(holder.petSoulInfo)
    ? holder.petSoulInfo
    : {};

  const info = holder.petSoulInfo;
  info.petSouls = Array.isArray(info.petSouls) ? info.petSouls.map((row) => normalizePetSoulData(row)) : [];
  if (info.petSouls.length === 0) {
    getDefaultPetSoulIds().forEach((id) => {
      info.petSouls.push(createDefaultPetSoulData(id));
    });
  }

  info.dispatch = normalizeDispatchMap(info.dispatch);
  info.dailyReward = Math.max(0, toSafeInt(info.dailyReward, 0));
  info.summon = Array.isArray(info.summon) ? info.summon.map((row) => normalizeSummonData(row)) : [];
  info.summonEndTime = Math.max(0, toSafeInt(info.summonEndTime, 0));
  info.cache = Array.isArray(info.cache) ? info.cache.map((row) => normalizePetSoulData(row)) : [];
  info.atlas = uniqueInts(Array.isArray(info.atlas) ? info.atlas : []);
  info.wishId = normalizeNumericMap(info.wishId);
  info.wishCount = normalizeNumericMap(info.wishCount);
  info.loyalty = normalizeNumericMap(info.loyalty);
  info.cachedRewardCount = Math.max(0, toSafeInt(info.cachedRewardCount, 0));

  return info;
}

function buildPetSoulPayload(info) {
  return {
    petSouls: clonePlain(info.petSouls),
    dispatch: clonePlain(info.dispatch),
    dailyReward: Math.max(0, toSafeInt(info.dailyReward, 0)),
    summon: clonePlain(info.summon),
    summonEndTime: Math.max(0, toSafeInt(info.summonEndTime, 0)),
    cache: clonePlain(info.cache),
    atlas: clonePlain(info.atlas),
    wishId: clonePlain(info.wishId),
    wishCount: clonePlain(info.wishCount),
    loyalty: clonePlain(info.loyalty),
    cachedRewardCount: Math.max(0, toSafeInt(info.cachedRewardCount, 0)),
  };
}

function findPetSoul(info, soulId) {
  const id = Math.max(1, toSafeInt(soulId, 1));
  return info.petSouls.find((row) => row.id === id) || null;
}

function upsertPetSoul(info, soulData) {
  const soul = normalizePetSoulData(soulData);
  const idx = info.petSouls.findIndex((row) => row.id === soul.id);
  if (idx >= 0) info.petSouls[idx] = soul;
  else info.petSouls.push(soul);
  return soul;
}

function findCachedPetSoul(info, soulId) {
  const id = Math.max(1, toSafeInt(soulId, 1));
  return info.cache.find((row) => row.id === id) || null;
}

function upsertCachedPetSoul(info, soulData) {
  const soul = normalizePetSoulData(soulData);
  const idx = info.cache.findIndex((row) => row.id === soul.id);
  if (idx >= 0) info.cache[idx] = soul;
  else info.cache.push(soul);
  return soul;
}

function removeCachedPetSoul(info, soulId) {
  const id = Math.max(1, toSafeInt(soulId, 1));
  info.cache = info.cache.filter((row) => row.id !== id);
}

function buildWashedPetSoul(source) {
  const washed = normalizePetSoulData(source);
  const quality = getPetSoulQuality(washed.id);
  const refiningCfg = (config.get('PetSoulRefiningConfig') || {})[quality] || {};
  const keys = Object.keys(washed.attrRatio);
  keys.forEach((key) => {
    const cur = toSafeInt(washed.attrRatio[key], 0);
    const delta = toSafeInt(Math.floor(Math.random() * 1501) - 500, 0);
    washed.attrRatio[key] = Math.max(1000, Math.min(10000, cur + delta));
  });

  const nextSpecial = Math.min(washed.special + 1, 2);
  if (Math.random() < 0.2 && refiningCfg[nextSpecial]) {
    washed.special = nextSpecial;
  }
  washed.special = normalizePetSoulSpecial(quality, washed.special);
  washed.wash = Math.max(0, toSafeInt(washed.wash, 0) + 1);
  return washed;
}

function getPetSoulWashCost(soul, requestedItem = 0) {
  return getPetSoulWashCosts(soul, requestedItem)[0] || { id: 261, count: 1 };
}

function getPetSoulWashCosts(soul, requestedItem = 0) {
  const quality = getPetSoulQuality(soul && soul.id);
  const qualityCfg = getPetSoulQualityConfig()[quality] || getPetSoulQualityConfig()[String(quality)] || {};
  const refiningCost = qualityCfg.refiningCost && typeof qualityCfg.refiningCost === 'object'
    ? qualityCfg.refiningCost
    : null;
  const rows = [];
  if (refiningCost && toSafeInt(refiningCost.id, 0) > 0) {
    const specialCfg = getPetSoulSpecialConfig()[Math.max(0, toSafeInt(soul && soul.special, 0))] || {};
    const rate = Math.max(1, Number(specialCfg.refiningCostRate) || 1);
    rows.push({
      id: Math.max(1, toSafeInt(refiningCost.id, 1)),
      count: Math.max(1, Math.ceil(Math.max(1, toSafeInt(refiningCost.count, 1)) * rate)),
    });
  }
  const item = Math.max(0, toSafeInt(requestedItem, 0));
  if (item > 0) rows.push({ id: item, count: 1 });
  return normalizeItemRows(rows.length > 0 ? rows : [{ id: 261, count: 1 }]);
}

function pickPetSoulIdByQuality(quality) {
  const q = Math.max(3, toSafeInt(quality, 3));
  const rows = Object.keys(getPetSoulConfig())
    .map((key) => getPetSoulConfig()[key])
    .filter((row) => row && toSafeInt(row.quality, 0) === q);
  const picked = weightedPick(rows, () => 1000);
  if (!picked) return getDefaultPetSoulIds()[0] || 210101;
  return Math.max(1, toSafeInt(picked.id, 210101));
}

function grantPetSoulToPlayer(player, soulId) {
  const info = ensurePetSoulInfo(player);
  const id = Math.max(1, toSafeInt(soulId, 0));
  if (id <= 0) return null;

  let soul = findPetSoul(info, id);
  if (!soul) soul = upsertPetSoul(info, createDefaultPetSoulData(id));
  return soul;
}

function getPetSoulUpgradeRow(soul) {
  const quality = getPetSoulQuality(soul && soul.id);
  const star = Math.max(0, toSafeInt(soul && soul.star, 0));
  return (getPetSoulUpgradeConfig()[quality] || {})[star] || null;
}

function getPetSoulUpgradeScore(soulId, items = {}) {
  const soulCfg = getPetSoulConfig()[Math.max(0, toSafeInt(soulId, 0))] || {};
  const materialCfg = getPetSoulUpgradeMaterialConfig();
  const extraPercent = Math.max(0, toSafeInt(getPetSoulBaseConfig().extraValuePercent, 0));
  let score = 0;
  Object.keys(items || {}).forEach((itemId) => {
    const mat = materialCfg[itemId] || materialCfg[toSafeInt(itemId, 0)];
    const count = Math.max(0, toSafeInt(items[itemId], 0));
    if (!mat || count <= 0) return;
    let itemScore = Math.max(0, toSafeInt(mat.score, 0)) * count;
    if (toSafeInt(soulCfg.races, 0) === toSafeInt(mat.element, -1)) {
      itemScore = Math.floor(itemScore * (1 + extraPercent / 10000));
    }
    score += itemScore;
  });
  return score;
}

function getPetSoulCatchItemQuality(itemId) {
  const id = Math.max(0, toSafeInt(itemId, 0));
  return Number(Object.keys(PET_SOUL_CATCH_ITEM_BY_QUALITY)
    .find((quality) => PET_SOUL_CATCH_ITEM_BY_QUALITY[quality] === id)) || 0;
}

function getCatchFailureData(info, pos) {
  const catchData = info && Array.isArray(info.summon)
    ? info.summon.find((row) => row.pos === pos)
    : null;
  return {
    result: -1,
    catchData: catchData ? clonePlain(catchData) : { pos, id: 0, state: 0, round: 0 },
    loyalty: {},
    wishId: clonePlain((info && info.wishId) || {}),
    wishCount: clonePlain((info && info.wishCount) || {}),
    rewards: [],
  };
}

async function savePlayer(session) {
  if (!session || !session.userId || !session.player) return;
  await playerService.savePlayer(session.userId, session.player);
}

async function handlePetSoulSet(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6900, msgUid, data: { result: -1, oldId: 0, id: 0, uid: 0 } };

  const info = ensurePetSoulInfo(player);
  const uid = toSafeInt(params && params.uid, -1);
  const id = Math.max(1, toSafeInt(params && params.id, 1));
  const soul = findPetSoul(info, id);
  if (!soul || !getPetSoulConfig()[id]) {
    return { tag: 6900, msgUid, data: { result: -1, oldId: 0, id, uid } };
  }

  let oldId = 0;
  info.petSouls.forEach((soul) => {
    if (toSafeInt(soul.petUid, -1) !== uid) return;
    oldId = soul.id;
    soul.petUid = -1;
  });

  soul.petUid = uid;

  await savePlayer(session);
  return { tag: 6900, msgUid, data: { result: 0, oldId, id: soul.id, uid } };
}

async function handlePetSoulStarUp(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6901, msgUid, data: { result: -1, data: null } };

  const info = ensurePetSoulInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, 1));
  const items = (params && params.items && typeof params.items === 'object') ? params.items : {};
  const soul = findPetSoul(info, id);
  if (!soul || !getPetSoulConfig()[id]) {
    return { tag: 6901, msgUid, data: { result: -1, data: soul ? clonePlain(soul) : null } };
  }

  const maxStar = getPetSoulMaxStarByQuality(getPetSoulQuality(id));
  if (toSafeInt(soul.star, 0) >= maxStar) {
    return { tag: 6901, msgUid, data: { result: -2, data: clonePlain(soul) } };
  }

  const upgradeRow = getPetSoulUpgradeRow(soul);
  const requireScore = Math.max(0, toSafeInt(upgradeRow && upgradeRow.require, 0));
  const minRequireRate = Math.max(0, toSafeInt(getPetSoulBaseConfig().upgradeMinRequire, 0));
  const rows = normalizeItemRows(Object.keys(items).map((itemId) => ({ id: toSafeInt(itemId, 0), count: toSafeInt(items[itemId], 0) })));
  const validMaterial = rows.length > 0 && rows.every((row) => (getPetSoulUpgradeMaterialConfig()[row.id] || getPetSoulUpgradeMaterialConfig()[String(row.id)]));
  const score = getPetSoulUpgradeScore(id, items);
  if (!upgradeRow || requireScore <= 0 || !validMaterial || Math.floor(score / requireScore * 10000) < minRequireRate) {
    return { tag: 6901, msgUid, data: { result: -3, data: clonePlain(soul) } };
  }
  if (!consumeItems(player, rows)) {
    return { tag: 6901, msgUid, data: { result: -4, data: clonePlain(soul) } };
  }

  soul.star = Math.max(0, Math.min(maxStar, toSafeInt(soul.star, 0) + 1));

  await savePlayer(session);
  return [
    buildItemSyncPacket(player, rows),
    { tag: 6901, msgUid, data: { result: 0, data: clonePlain(soul) } },
  ];
}

async function handlePetSoulWash(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6902, msgUid, data: { result: -1, data: null } };

  const info = ensurePetSoulInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, 1));
  const item = Math.max(0, toSafeInt(params && params.item, 0));

  let soul = findPetSoul(info, id);
  if (!soul) soul = upsertPetSoul(info, createDefaultPetSoulData(id));

  const costs = getPetSoulWashCosts(soul, item);
  if (!consumeItems(player, costs)) {
    return { tag: 6902, msgUid, data: { result: -1, data: clonePlain(soul), cache: null } };
  }

  const cache = buildWashedPetSoul(soul);
  upsertCachedPetSoul(info, cache);

  await savePlayer(session);
  return [
    buildItemSyncPacket(player, costs),
    { tag: 6902, msgUid, data: { result: 0, data: clonePlain(soul), cache: clonePlain(cache) } },
  ];
}

async function handlePetSoulWashConfirm(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6903, msgUid, data: { result: -1, data: null } };

  const info = ensurePetSoulInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, 1));

  const cached = findCachedPetSoul(info, id);
  let soul = findPetSoul(info, id);
  if (!soul) soul = upsertPetSoul(info, createDefaultPetSoulData(id));
  if (cached) soul = upsertPetSoul(info, cached);
  removeCachedPetSoul(info, id);

  await savePlayer(session);
  return { tag: 6903, msgUid, data: { result: 0, data: clonePlain(soul) } };
}

async function handlePetSoulUseDrug(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6904, msgUid, data: { result: -1, data: null } };

  const info = ensurePetSoulInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, 1));
  const itemId = Math.max(1, toSafeInt(params && params.itemId, 1));
  const count = Math.max(1, toSafeInt(params && params.count, 1));

  const soul = findPetSoul(info, id);
  const pillCfg = getPetSoulPillConfig()[itemId] || getPetSoulPillConfig()[String(itemId)] || null;
  if (!soul || !pillCfg) {
    return { tag: 6904, msgUid, data: { result: -1, data: soul ? clonePlain(soul) : null } };
  }

  const usageLimit = (getPetSoulUpgradeRow(soul) && getPetSoulUpgradeRow(soul).usageLimit) || {};
  const pillType = toSafeInt(pillCfg.type, 0);
  const typeLimit = Math.max(0, toSafeInt(usageLimit[pillType] || usageLimit[String(pillType)], 0));
  const perPillLimit = Math.floor(typeLimit * Math.max(0, toSafeInt(pillCfg.limit, 0)) / 10000);
  const curPillUse = Math.max(0, toSafeInt(soul.attrDrugUse[itemId], 0));
  const totalUse = Object.keys(soul.attrDrugUse || {}).reduce((sum, key) => sum + Math.max(0, toSafeInt(soul.attrDrugUse[key], 0)), 0);
  if (typeLimit <= 0 || curPillUse + count > perPillLimit || totalUse + count > typeLimit) {
    return { tag: 6904, msgUid, data: { result: -2, data: clonePlain(soul) } };
  }
  const cost = [{ id: itemId, count }];
  if (!consumeItems(player, cost)) {
    return { tag: 6904, msgUid, data: { result: -3, data: clonePlain(soul) } };
  }
  soul.attrDrugUse[itemId] = Math.max(0, toSafeInt(soul.attrDrugUse[itemId], 0) + count);

  await savePlayer(session);
  return [
    buildItemSyncPacket(player, cost),
    { tag: 6904, msgUid, data: { result: 0, data: clonePlain(soul) } },
  ];
}

async function handlePetSoulResetDrug(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6905, msgUid, data: { result: -1, data: null, rewardInfo: buildRewardInfo([]) } };

  const info = ensurePetSoulInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, 1));

  const soul = findPetSoul(info, id);
  if (!soul) return { tag: 6905, msgUid, data: { result: -1, data: null, rewardInfo: buildRewardInfo([]) } };

  const usedRows = Object.keys(soul.attrDrugUse || {})
    .map((itemId) => ({ id: toSafeInt(itemId, 0), count: Math.max(0, toSafeInt(soul.attrDrugUse[itemId], 0)) }))
    .filter((row) => row.id > 0 && row.count > 0);
  if (usedRows.length <= 0) {
    return { tag: 6905, msgUid, data: { result: -2, data: clonePlain(soul), rewardInfo: buildRewardInfo([]) } };
  }

  const resetConsume = getPetSoulBaseConfig().resetConsume || {};
  const resetCost = toSafeInt(resetConsume.id, 0) > 0 ? [{ id: resetConsume.id, count: Math.max(1, toSafeInt(resetConsume.count, 1)) }] : [];
  if (!consumeItems(player, resetCost)) {
    return { tag: 6905, msgUid, data: { result: -3, data: clonePlain(soul), rewardInfo: buildRewardInfo([]) } };
  }
  soul.attrDrugUse = {};
  const rewardInfo = grantRewards(player, usedRows);

  await savePlayer(session);
  return [
    buildItemSyncPacket(player, resetCost),
    { tag: 6905, msgUid, data: { result: 0, data: clonePlain(soul), rewardInfo } },
  ];
}

async function handlePetSoulAtlasReward(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6906, msgUid, data: { result: -1, rewarded: [], rewardInfo: buildRewardInfo([]) } };

  const info = ensurePetSoulInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, 1));
  const rewarded = [];

  const petSoulCfg = getPetSoulConfig()[id] || {};
  if (!findPetSoul(info, id) || !petSoulCfg.id) {
    return { tag: 6906, msgUid, data: { result: -1, rewarded: [], rewardInfo: buildRewardInfo([]) } };
  }
  if (info.atlas.includes(id)) {
    return { tag: 6906, msgUid, data: { result: -2, rewarded: [], rewardInfo: buildRewardInfo([]) } };
  }
  info.atlas.push(id);
  rewarded.push(id);

  const rewardRows = Array.isArray(petSoulCfg.atlasReward) ? petSoulCfg.atlasReward : [];
  const rewardInfo = grantRewards(player, rewardRows);

  await savePlayer(session);
  return { tag: 6906, msgUid, data: { result: 0, rewarded, rewardInfo } };
}

async function handlePetSoulDispatch(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6907, msgUid, data: { result: -1 } };

  const info = ensurePetSoulInfo(player);
  const types = Array.isArray(params && params.type) ? params.type : [];
  const ids = Array.isArray(params && params.id) ? params.id : [];

  for (let i = 0; i < Math.min(types.length, ids.length); i++) {
    const type = Math.max(1, toSafeInt(types[i], 1));
    const soulId = Math.max(0, toSafeInt(ids[i], 0));
    if (soulId > 0 && !findPetSoul(info, soulId)) {
      return { tag: 6907, msgUid, data: { result: -1 } };
    }
    if (soulId > 0) info.dispatch[type] = soulId;
    else delete info.dispatch[type];
  }

  await savePlayer(session);
  return { tag: 6907, msgUid, data: { result: 0 } };
}

async function handlePetSoulDailyReward(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6908, msgUid, data: { result: -1, dailyReward: 0, rewards: buildRewardInfo([]) } };

  const info = ensurePetSoulInfo(player);
  const dayKey = toDayKey();
  const rewardRows = getConfiguredRewardRows('dailyReward', 'dailyRewards');
  if (toSafeInt(info.dailyReward, 0) !== dayKey && rewardRows.length <= 0) {
    return { tag: 6908, msgUid, data: { result: -2, dailyReward: info.dailyReward, rewards: buildRewardInfo([]) } };
  }
  let rewardInfo = buildRewardInfo([]);
  if (toSafeInt(info.dailyReward, 0) !== dayKey) {
    info.dailyReward = dayKey;
    rewardInfo = grantRewards(player, rewardRows);
  }

  await savePlayer(session);
  return { tag: 6908, msgUid, data: { result: 0, dailyReward: info.dailyReward, rewards: rewardInfo } };
}

async function handlePetSoulClaimDispatchReward(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6909, msgUid, data: { result: -1, cacheRewardCount: 0, rewards: buildRewardInfo([]) } };

  const info = ensurePetSoulInfo(player);
  const count = Math.max(0, toSafeInt(info.cachedRewardCount, 0));
  const baseRows = getConfiguredRewardRows('dispatchReward', 'dispatchRewards');
  if (count > 0 && baseRows.length <= 0) {
    return { tag: 6909, msgUid, data: { result: -2, cacheRewardCount: count, rewards: buildRewardInfo([]) } };
  }
  const rewardRows = [];
  baseRows.forEach((row) => rewardRows.push({ id: row.id, count: row.count * Math.max(1, count) }));
  const rewardInfo = count > 0 ? grantRewards(player, rewardRows) : buildRewardInfo([]);
  info.cachedRewardCount = 0;

  await savePlayer(session);
  return { tag: 6909, msgUid, data: { result: 0, cacheRewardCount: info.cachedRewardCount, rewards: rewardInfo } };
}

async function handlePetSoulSummon(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6920, msgUid, data: { result: -1, summon: [], summonEndTime: 0, loyalty: {} } };

  const info = ensurePetSoulInfo(player);
  const summonType = Math.max(0, toSafeInt(params && params.id, 0));
  const trans = Math.max(0, toSafeInt(params && params.trans, 0));

  const callCfg = getPetSoulCallRateConfig()[summonType] || {};
  const rateRows = Array.isArray(callCfg.rate) ? callCfg.rate : [];
  if (!callCfg.callType || rateRows.length <= 0) {
    return { tag: 6920, msgUid, data: { result: -1, summon: clonePlain(info.summon), summonEndTime: info.summonEndTime, loyalty: {} } };
  }
  const consume = callCfg.consume || {};
  const costs = trans > 0
    ? [{ id: Math.max(0, toSafeInt(consume.id, 0)), count: Math.max(0, toSafeInt(consume.count, 0)) }]
    : [{ id: summonType, count: 1 }];
  if (!consumeItems(player, costs)) {
    return { tag: 6920, msgUid, data: { result: -2, summon: clonePlain(info.summon), summonEndTime: info.summonEndTime, loyalty: {} } };
  }

  const summon = [];
  for (let pos = 1; pos <= 3; pos++) {
    const qualityPick = weightedPick(rateRows, (row) => toSafeInt(row && row.weight, 0));
    const quality = Math.max(3, toSafeInt(qualityPick && qualityPick.id, 3));
    const soulId = pickPetSoulIdByQuality(quality);
    summon.push({ pos, id: soulId, state: 0, round: 0 });
  }

  info.summon = summon;
  info.summonEndTime = Date.now() + 60 * 60 * 1000;

  await savePlayer(session);
  return [
    buildItemSyncPacket(player, costs),
    {
      tag: 6920,
      msgUid,
      data: {
        result: 0,
        summon: clonePlain(info.summon),
        summonEndTime: info.summonEndTime,
        loyalty: {},
      },
    },
  ];
}

async function handlePetSoulCatch(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6921, msgUid, data: { result: -1, catchData: null, loyalty: {} } };

  const info = ensurePetSoulInfo(player);
  const pos = Math.max(1, toSafeInt(params && params.pos, 1));
  const catchItemId = Math.max(1, toSafeInt(params && (params.id || params.itemId || params.item), 0));
  const catchData = info.summon.find((row) => row.pos === pos) || null;
  if (!catchData || toSafeInt(catchData.state, 0) !== 0) {
    return { tag: 6921, msgUid, data: getCatchFailureData(info, pos) };
  }
  const soulId = Math.max(1, toSafeInt(catchData.id, 1));
  const soulCfg = getPetSoulConfig()[soulId] || null;
  const soulQuality = Math.max(3, toSafeInt(soulCfg && soulCfg.quality, 3));
  const catchQuality = getPetSoulCatchItemQuality(catchItemId);
  const rateCfg = ((getPetSoulCatchRateConfig()[soulQuality] || {})[catchQuality]) || null;
  if (!soulCfg || !rateCfg) {
    return { tag: 6921, msgUid, data: getCatchFailureData(info, pos) };
  }
  const cost = [{ id: catchItemId, count: 1 }];
  if (!consumeItems(player, cost)) {
    return { tag: 6921, msgUid, data: getCatchFailureData(info, pos) };
  }

  const round = Math.max(1, toSafeInt(catchData.round, 0) + 1);
  const showRate = Math.max(0, Math.min(10000, toSafeInt(rateCfg.showRate, 0)));
  const success = Math.random() * 10000 < showRate;
  catchData.round = round;
  catchData.state = success ? 10 : 20;

  let soul = findPetSoul(info, soulId);
  if (success && !soul) soul = upsertPetSoul(info, createDefaultPetSoulData(soulId));
  const loyaltyAddCfg = getPetSoulBaseConfig().loyaltyAddValue || {};
  const loyaltyAdd = Math.max(0, toSafeInt(loyaltyAddCfg[success ? 2 : 1] || loyaltyAddCfg[String(success ? 2 : 1)], success ? 10 : 3));
  info.loyalty[soulId] = Math.max(0, toSafeInt(info.loyalty[soulId], 0) + loyaltyAdd);
  const loyalty = { [soulId]: info.loyalty[soulId] };
  const rewardRows = success ? [] : (Array.isArray(soulCfg.loseReward) ? soulCfg.loseReward : []);
  const rewardInfo = rewardRows.length > 0 ? grantRewards(player, rewardRows) : buildRewardInfo([]);

  await savePlayer(session);
  const packets = [
    buildItemSyncPacket(player, [{ id: catchItemId, count: 1 }]),
  ];
  if (success && soul) packets.push({ tag: 6901, msgUid: 0, data: { result: 0, data: clonePlain(soul) } });
  packets.push(
    {
      tag: 6921,
      msgUid,
      data: {
        result: 0,
        rewards: clonePlain(rewardInfo.items),
        catchData: clonePlain(catchData),
        loyalty,
        wishId: clonePlain(info.wishId),
        wishCount: clonePlain(info.wishCount),
      },
    },
  );
  return packets;
}

async function handlePetSoulSetWish(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6922, msgUid, data: { result: -1, wishId: {} } };

  const info = ensurePetSoulInfo(player);
  const ids = uniqueInts(Array.isArray(params && params.ids) ? params.ids : [])
    .filter((id) => getPetSoulConfig()[id]);
  const nextWishId = {};
  const nextWishCount = {};
  ids.forEach((id, idx) => {
    const key = String(idx + 1);
    nextWishId[key] = id;
    nextWishCount[key] = Math.max(0, toSafeInt(info.wishCount[key], 0));
  });

  info.wishId = nextWishId;
  info.wishCount = nextWishCount;

  await savePlayer(session);
  return { tag: 6922, msgUid, data: { result: 0, wishId: clonePlain(info.wishId) } };
}

module.exports = {
  ensurePetSoulInfo,
  grantPetSoulToPlayer,
  buildPetSoulPayload,
  handlePetSoulSet,
  handlePetSoulStarUp,
  handlePetSoulWash,
  handlePetSoulWashConfirm,
  handlePetSoulUseDrug,
  handlePetSoulResetDrug,
  handlePetSoulAtlasReward,
  handlePetSoulDispatch,
  handlePetSoulDailyReward,
  handlePetSoulClaimDispatchReward,
  handlePetSoulSummon,
  handlePetSoulCatch,
  handlePetSoulSetWish,
};
