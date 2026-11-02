/**
 * Bloodline system handlers
 * tag: 4700 refine, 4701 back refine / init, 4702 refine lock, 4703 wear, 4704 compose
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');

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

function getBloodlineBaseConfig() {
  return config.get('BloodlineBaseConfig') || {};
}

function getBloodlineConfigMap() {
  return config.get('BloodlineConfig') || {};
}

function getBloodlineCfgById(bloodlineId) {
  return getBloodlineConfigMap()[toSafeInt(bloodlineId, 0)] || null;
}

function getFallbackBloodlineId() {
  const initial = toSafeInt(getBloodlineBaseConfig().initialBloodline, 27341);
  if (getBloodlineCfgById(initial)) return initial;

  const firstId = Object.keys(getBloodlineConfigMap())
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b)[0];
  return firstId || 27341;
}

function normalizeBloodlineId(bloodlineId) {
  const id = toSafeInt(bloodlineId, 0);
  return getBloodlineCfgById(id) ? id : getFallbackBloodlineId();
}

function getBloodlineQualityById(bloodlineId) {
  const row = getBloodlineCfgById(bloodlineId);
  return Math.max(3, toSafeInt(row && row.quality, 3));
}

function getBloodlineGradeConfigMap() {
  return config.get('BloodlineGradeConfig') || {};
}

function getMaxTierByQuality(quality) {
  const q = Math.max(1, toSafeInt(quality, 3));
  const tierMap = getBloodlineGradeConfigMap()[q] || {};
  const levels = Object.keys(tierMap).map((k) => toSafeInt(k, 0)).filter((n) => n >= 0).sort((a, b) => a - b);
  return levels.length > 0 ? levels[levels.length - 1] : 0;
}

function getMaxRefineLevelByQuality(quality) {
  const q = Math.max(1, toSafeInt(quality, 3));
  const maxLevel = getBloodlineBaseConfig().maxLevel || {};
  return Math.max(0, toSafeInt(maxLevel[q] || maxLevel[String(q)], 0));
}

function calcTierByScore(quality, score) {
  const q = Math.max(1, toSafeInt(quality, 3));
  const s = Math.max(0, toSafeInt(score, 0));
  const tierMap = getBloodlineGradeConfigMap()[q] || {};
  const levels = Object.keys(tierMap).map((k) => toSafeInt(k, 0)).filter((n) => n >= 0).sort((a, b) => a - b);
  let tier = 0;
  levels.forEach((lv) => {
    const cond = Math.max(0, toSafeInt(tierMap[lv] && tierMap[lv].condition, 0));
    if (s >= cond) tier = lv;
  });
  return tier;
}

function getRefineCfgByTier(quality, tier) {
  const refineMap = (config.get('BloodlineRefineConfig') || {})[Math.max(1, toSafeInt(quality, 3))] || {};
  const requested = Math.max(0, toSafeInt(tier, 0));
  if (refineMap[requested]) return refineMap[requested];

  const keys = Object.keys(refineMap).map((k) => toSafeInt(k, -1)).filter((n) => n >= 0).sort((a, b) => a - b);
  if (keys.length === 0) return null;
  return refineMap[keys[keys.length - 1]] || null;
}

function getRefineRangeCfgByQuality(quality) {
  const rangeMap = config.get('BloodlineRefineRangeConfig') || {};
  const q = Math.max(1, toSafeInt(quality, 3));
  if (rangeMap[q]) return rangeMap[q];
  return Object.values(rangeMap).find((row) => toSafeInt(row && row.quality, 0) === q) || null;
}

function normalizeRefineAttr(entry = {}, quality = 3) {
  const normalized = (entry && typeof entry === 'object' && !Array.isArray(entry)) ? { ...entry } : {};
  const q = Math.max(1, toSafeInt(quality, 3));
  normalized.star = Math.max(1, toSafeInt(normalized.star, q));
  normalized.lock = toSafeInt(normalized.lock, 0) > 0 ? 1 : 0;
  normalized.attrs = normalized.attrs && typeof normalized.attrs === 'object' && !Array.isArray(normalized.attrs)
    ? { ...normalized.attrs }
    : {};
  Object.keys(normalized.attrs).forEach((key) => {
    const value = toSafeInt(normalized.attrs[key], 0);
    if (value === 0) delete normalized.attrs[key];
    else normalized.attrs[key] = value;
  });
  if (Object.keys(normalized.attrs).length === 0) {
    const gradeMap = getBloodlineGradeConfigMap()[q] || {};
    const baseAttrs = (gradeMap[1] && gradeMap[1].attrs) || (gradeMap[0] && gradeMap[0].attrs) || { 51: q * 100 };
    const firstAttrId = Object.keys(baseAttrs)[0] || '51';
    normalized.attrs[firstAttrId] = Math.max(1, Math.floor(toSafeInt(baseAttrs[firstAttrId], q * 100) / 10));
  }
  return normalized;
}

function createRefineAttr(quality, index = 0, multiplier = 1) {
  const q = Math.max(1, toSafeInt(quality, 3));
  const gradeMap = getBloodlineGradeConfigMap()[q] || {};
  const baseAttrs = (gradeMap[1] && gradeMap[1].attrs) || (gradeMap[0] && gradeMap[0].attrs) || { 51: q * 100 };
  const attrIds = Object.keys(baseAttrs).sort((a, b) => Number(a) - Number(b));
  const attrId = attrIds[Math.max(0, toSafeInt(index, 0)) % Math.max(1, attrIds.length)] || '51';
  const baseValue = Math.max(1, toSafeInt(baseAttrs[attrId], q * 100));
  return normalizeRefineAttr({
    star: q,
    lock: 0,
    attrs: { [attrId]: Math.max(1, Math.floor(baseValue * Math.max(1, toSafeInt(multiplier, 1)) / 10)) },
  }, q);
}

function calcScoreByRefineList(refineList = []) {
  const rangeMap = config.get('BloodlineRefineRangeConfig') || {};
  return (Array.isArray(refineList) ? refineList : []).reduce((sum, entry) => {
    const star = Math.max(0, toSafeInt(entry && entry.star, 0));
    const range = rangeMap[star] || rangeMap[String(star)] || null;
    return sum + Math.max(0, toSafeInt(range && range.score, 0));
  }, 0);
}

function getComposeCfg(quality, count) {
  const composeMap = (config.get('BloodlineComposeConfig') || {})[Math.max(1, toSafeInt(quality, 3))] || {};
  const c = Math.max(1, toSafeInt(count, 1));
  if (composeMap[c]) return composeMap[c];
  return null;
}

function listBloodlineIdsByQuality(quality) {
  const q = Math.max(1, toSafeInt(quality, 3));
  const cfgMap = getBloodlineConfigMap();
  return Object.keys(cfgMap)
    .map((k) => toSafeInt(k, 0))
    .filter((id) => {
      const row = cfgMap[id];
      return row && toSafeInt(row.quality, 0) === q;
    })
    .sort((a, b) => a - b);
}

function listBloodlineIdsByQualityAndTypes(quality, types = []) {
  const typeSet = new Set(uniqueInts(types));
  if (typeSet.size === 0) return listBloodlineIdsByQuality(quality);
  const cfgMap = getBloodlineConfigMap();
  return listBloodlineIdsByQuality(quality).filter((id) => typeSet.has(toSafeInt(cfgMap[id] && cfgMap[id].type, 0)));
}

function nextComposeQuality(quality) {
  const q = Math.max(1, toSafeInt(quality, 3));
  const order = [3, 4, 5, 6, 7, 9];
  const idx = order.indexOf(q);
  if (idx < 0 || idx >= order.length - 1) return q;
  return order[idx + 1];
}

function pickBloodlineIdByQuality(quality, wishedId = 0) {
  const q = Math.max(1, toSafeInt(quality, 3));
  const ids = listBloodlineIdsByQuality(q);
  const wished = toSafeInt(wishedId, 0);
  if (wished > 0 && ids.includes(wished)) return wished;
  if (ids.length > 0) return ids[toSafeInt(Math.floor(Math.random() * ids.length), 0)];
  return toSafeInt(getBloodlineBaseConfig().initialBloodline, 27341);
}

function pickBloodlineIdByQualityAndTypes(quality, types = [], wishedId = 0, excludeId = 0) {
  const q = Math.max(1, toSafeInt(quality, 3));
  const excluded = toSafeInt(excludeId, 0);
  let ids = listBloodlineIdsByQualityAndTypes(q, types).filter((id) => id !== excluded);
  if (ids.length === 0) ids = listBloodlineIdsByQuality(q).filter((id) => id !== excluded);
  const wished = toSafeInt(wishedId, 0);
  if (wished > 0 && ids.includes(wished)) return wished;
  if (ids.length > 0) return ids[toSafeInt(Math.floor(Math.random() * ids.length), 0)];
  return excluded || pickBloodlineIdByQuality(q, wished);
}

function createBloodlineData(info, bloodlineId, score = 0) {
  const id = normalizeBloodlineId(bloodlineId);
  const uid = Math.max(1, toSafeInt(info.nextUid, 1));
  info.nextUid = uid + 1;

  const quality = getBloodlineQualityById(id);
  const normalizedScore = Math.max(0, toSafeInt(score, 0));
  const tier = Math.min(getMaxTierByQuality(quality), calcTierByScore(quality, normalizedScore));
  return {
    uid,
    id,
    tier,
    score: normalizedScore,
    lock: 0,
    refineList: [],
  };
}

function inheritRefineState(target, source) {
  const quality = getBloodlineQualityById(target.id);
  target.refineList = Array.isArray(source && source.refineList)
    ? source.refineList.map((entry) => normalizeRefineAttr(entry, quality))
    : [];
  target.score = calcScoreByRefineList(target.refineList);
  target.luck = Math.max(0, toSafeInt(source && source.luck, 0));
  delete target.lastScore;
}

function findBloodlineByUid(info, uid) {
  const target = toSafeInt(uid, -1);
  return info.dataList.find((row) => toSafeInt(row && row.uid, -1) === target) || null;
}

function removeBloodlineByUid(info, uid) {
  const target = toSafeInt(uid, -1);
  info.dataList = info.dataList.filter((row) => toSafeInt(row && row.uid, -1) !== target);
  if (toSafeInt(info.wearUid, 0) === target) info.wearUid = 0;
}

function refreshBloodlineSummary(info) {
  let maxTier = 0;
  info.dataList.forEach((row) => {
    const quality = getBloodlineQualityById(row.id);
    if (Array.isArray(row.refineList) && row.refineList.length > 0) {
      row.score = calcScoreByRefineList(row.refineList);
    } else {
      row.score = Math.max(0, toSafeInt(row.score, 0));
    }
    row.tier = Math.min(getMaxTierByQuality(quality), calcTierByScore(quality, row.score));
    row.lock = toSafeInt(row.lock, 0) > 0 ? 1 : 0;
    maxTier = Math.max(maxTier, toSafeInt(row.tier, 0));
  });
  info.maxTier = maxTier;

  const hasWear = info.dataList.some((row) => toSafeInt(row.uid, 0) === toSafeInt(info.wearUid, 0));
  if (!hasWear) info.wearUid = info.dataList.length > 0 ? toSafeInt(info.dataList[0].uid, 0) : 0;
}

function ensureBloodlineInfo(player) {
  player.other_attr_info = player.other_attr_info && typeof player.other_attr_info === 'object' && !Array.isArray(player.other_attr_info)
    ? player.other_attr_info
    : {};
  const holder = player.other_attr_info;

  holder.bloodlineInfo = holder.bloodlineInfo && typeof holder.bloodlineInfo === 'object' && !Array.isArray(holder.bloodlineInfo)
    ? holder.bloodlineInfo
    : {};
  const info = holder.bloodlineInfo;

  if (!Array.isArray(info.dataList)) info.dataList = [];
  if (!info.picMap || typeof info.picMap !== 'object' || Array.isArray(info.picMap)) info.picMap = {};
  if (!info.wishMap || typeof info.wishMap !== 'object' || Array.isArray(info.wishMap)) info.wishMap = {};
  if (info.wearUid == null) info.wearUid = 0;
  if (info.maxTier == null) info.maxTier = 0;
  if (toSafeInt(info.nextUid, 0) <= 0) info.nextUid = 1;

  const maxUid = info.dataList.reduce((max, row) => Math.max(max, toSafeInt(row && row.uid, 0)), 0);
  if (toSafeInt(info.nextUid, 1) <= maxUid) info.nextUid = maxUid + 1;

  info.dataList = info.dataList.map((row) => {
    const id = normalizeBloodlineId(row && row.id);
    const uidRaw = toSafeInt(row && row.uid, 0);
    const uid = uidRaw > 0 ? uidRaw : toSafeInt(info.nextUid, 1);
    if (uid >= toSafeInt(info.nextUid, 1)) info.nextUid = uid + 1;

    const quality = getBloodlineQualityById(id);
    const score = Math.max(0, toSafeInt(row && row.score, 0));
    const tier = Math.min(getMaxTierByQuality(quality), Math.max(0, toSafeInt(row && row.tier, calcTierByScore(quality, score))));
    const lock = toSafeInt(row && row.lock, 0) > 0 ? 1 : 0;
    const luck = Math.max(0, toSafeInt(row && row.luck, 0));
    const refineList = Array.isArray(row && row.refineList)
      ? row.refineList.map((entry) => normalizeRefineAttr(entry, quality))
      : [];
    const out = { uid, id, tier, score, lock, luck, refineList };
    if (row && row.lastScore != null) out.lastScore = Math.max(0, toSafeInt(row.lastScore, 0));
    return out;
  });

  if (info.dataList.length === 0) {
    info.dataList.push(createBloodlineData(info, toSafeInt(getBloodlineBaseConfig().initialBloodline, 27341), 0));
  }

  const validIds = new Set(Object.keys(getBloodlineConfigMap()).map((k) => toSafeInt(k, 0)).filter((id) => id > 0));
  const cleanWishMap = {};
  Object.keys(info.wishMap).forEach((k) => {
    const quality = Math.max(1, toSafeInt(k, 0));
    const wishedId = toSafeInt(info.wishMap[k], 0);
    if (quality <= 0 || wishedId <= 0 || !validIds.has(wishedId)) return;
    if (!listBloodlineIdsByQuality(quality).includes(wishedId)) return;
    cleanWishMap[String(quality)] = wishedId;
  });
  info.wishMap = cleanWishMap;

  const cleanPicMap = {};
  Object.keys(info.picMap).forEach((k) => {
    const id = toSafeInt(k, 0);
    if (id <= 0 || !validIds.has(id)) return;
    cleanPicMap[String(id)] = toSafeInt(info.picMap[k], 0) > 0 ? 1 : 0;
  });
  info.dataList.forEach((row) => {
    const id = toSafeInt(row && row.id, 0);
    if (id > 0 && validIds.has(id) && cleanPicMap[String(id)] == null) cleanPicMap[String(id)] = 0;
  });
  info.picMap = cleanPicMap;

  refreshBloodlineSummary(info);
  return info;
}

function buildBloodlinePayload(info) {
  return {
    dataList: (Array.isArray(info.dataList) ? info.dataList : []).map((row) => ({
      uid: toSafeInt(row && row.uid, 0),
      id: toSafeInt(row && row.id, 0),
      tier: Math.max(0, toSafeInt(row && row.tier, 0)),
      score: Math.max(0, toSafeInt(row && row.score, 0)),
      lock: toSafeInt(row && row.lock, 0) > 0 ? 1 : 0,
      luck: Math.max(0, toSafeInt(row && row.luck, 0)),
      refineMaxLevel: getMaxRefineLevelByQuality(getBloodlineQualityById(row && row.id)),
      refineList: Array.isArray(row && row.refineList)
        ? row.refineList.map((entry) => normalizeRefineAttr(entry, getBloodlineQualityById(row && row.id)))
        : [],
    })),
    wearUid: toSafeInt(info.wearUid, 0),
    maxTier: Math.max(0, toSafeInt(info.maxTier, 0)),
    picMap: { ...(info.picMap || {}) },
    wishMap: { ...(info.wishMap || {}) },
  };
}

// refine
async function handleBloodlineRefining(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4700, msgUid, data: { result: -1 } };

  const info = ensureBloodlineInfo(player);
  const uid = toSafeInt(params && params.uid, toSafeInt(info.wearUid, 0));
  const data = findBloodlineByUid(info, uid);
  if (!data) return { tag: 4700, msgUid, data: { result: -1, ...buildBloodlinePayload(info) } };

  const quality = getBloodlineQualityById(data.id);
  const refineIndex = Array.isArray(data.refineList) ? data.refineList.length : 0;
  const maxRefineLevel = getMaxRefineLevelByQuality(quality);
  if (maxRefineLevel > 0 && refineIndex >= maxRefineLevel) {
    return { tag: 4700, msgUid, data: { result: 1, ...buildBloodlinePayload(info) } };
  }
  const refineCfg = getRefineCfgByTier(quality, refineIndex);
  const costs = Array.isArray(refineCfg && refineCfg.costs) ? refineCfg.costs : [];
  for (const cost of costs) {
    if (!hasEnoughItemOrCurrency(player, cost.id, cost.count)) {
      return { tag: 4700, msgUid, data: { result: 1, ...buildBloodlinePayload(info) } };
    }
  }
  costs.forEach((cost) => consumeItemOrCurrency(player, cost.id, cost.count));

  data.lastScore = Math.max(0, toSafeInt(data.score, 0));
  const attr = createRefineAttr(quality, refineIndex, 1);
  data.refineList = Array.isArray(data.refineList) ? data.refineList : [];
  data.refineList.push(attr);
  data.score = calcScoreByRefineList(data.refineList);
  data.luck = Math.max(0, toSafeInt(data.luck, 0)) + 1;
  const scoreGain = Math.max(0, toSafeInt(data.score, 0) - toSafeInt(data.lastScore, 0));
  refreshBloodlineSummary(info);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4700,
    msgUid,
    data: {
      result: 0,
      uid,
      attr,
      luck: data.luck,
      scoreGain,
      ...buildBloodlinePayload(info),
    },
  };
}

function grantBloodlineToPlayer(player, bloodlineId, score = 0) {
  const info = ensureBloodlineInfo(player);
  const row = createBloodlineData(info, bloodlineId, score);
  info.dataList.push(row);
  refreshBloodlineSummary(info);
  return row;
}

// back refine / init snapshot
async function handleBloodlineBackRefining(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4701, msgUid, data: { result: -1, dataList: [], wearUid: 0, maxTier: 0, picMap: {}, wishMap: {} } };

  const info = ensureBloodlineInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  if (uid <= 0) {
    return { tag: 4701, msgUid, data: buildBloodlinePayload(info) };
  }

  const data = findBloodlineByUid(info, uid);
  if (!data) {
    return { tag: 4701, msgUid, data: { result: 1, ...buildBloodlinePayload(info) } };
  }

  const refineList = Array.isArray(data.refineList) ? data.refineList : [];
  const maxRefineLevel = getMaxRefineLevelByQuality(getBloodlineQualityById(data.id));
  if (maxRefineLevel > 0 && refineList.length < maxRefineLevel) {
    return { tag: 4701, msgUid, data: { result: 1, ...buildBloodlinePayload(info) } };
  }

  const unlocked = refineList.filter((entry) => toSafeInt(entry && entry.lock, 0) <= 0);
  if (unlocked.length === 0) return { tag: 4701, msgUid, data: { result: 1, ...buildBloodlinePayload(info) } };

  const normalCost = {};
  const diamondCost = {};
  unlocked.forEach((entry) => {
    const rangeCfg = getRefineRangeCfgByQuality(toSafeInt(entry && entry.star, 0)) || {};
    const rbCost = Array.isArray(rangeCfg.rollBackCost) ? rangeCfg.rollBackCost[0] : null;
    const rbDiamond = Array.isArray(rangeCfg.rollBackDiamondCost) ? rangeCfg.rollBackDiamondCost[0] : null;
    if (rbCost && toSafeInt(rbCost.id, 0) > 0) normalCost[toSafeInt(rbCost.id, 0)] = Math.max(0, toSafeInt(normalCost[toSafeInt(rbCost.id, 0)], 0)) + Math.max(0, toSafeInt(rbCost.count, 0));
    if (rbDiamond && toSafeInt(rbDiamond.id, 0) > 0) diamondCost[toSafeInt(rbDiamond.id, 0)] = Math.max(0, toSafeInt(diamondCost[toSafeInt(rbDiamond.id, 0)], 0)) + Math.max(0, toSafeInt(rbDiamond.count, 0));
  });
  const normalRows = Object.keys(normalCost).map((id) => ({ id: toSafeInt(id, 0), count: normalCost[id] }));
  const diamondRows = Object.keys(diamondCost).map((id) => ({ id: toSafeInt(id, 0), count: diamondCost[id] }));
  const canPay = (rows) => rows.length > 0 && rows.every((row) => hasEnoughItemOrCurrency(player, row.id, row.count));
  const preferDiamond = toSafeInt(params && params.useDiamond, 0) > 0;
  const payRows = preferDiamond && canPay(diamondRows) ? diamondRows : canPay(normalRows) ? normalRows : canPay(diamondRows) ? diamondRows : [];
  if (payRows.length === 0) return { tag: 4701, msgUid, data: { result: 1, ...buildBloodlinePayload(info) } };

  payRows.forEach((row) => consumeItemOrCurrency(player, row.id, row.count));
  data.refineList = refineList.filter((entry) => toSafeInt(entry && entry.lock, 0) > 0);
  data.score = calcScoreByRefineList(data.refineList);
  delete data.lastScore;
  refreshBloodlineSummary(info);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4701,
    msgUid,
    data: {
      result: 0,
      uid,
      refineList: Array.isArray(data.refineList) ? data.refineList : [],
      rollbackCost: payRows,
      ...buildBloodlinePayload(info),
    },
  };
}

// lock refine
async function handleBloodlineRefineLock(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4702, msgUid, data: { result: -1 } };

  const info = ensureBloodlineInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const data = findBloodlineByUid(info, uid);
  if (!data) return { tag: 4702, msgUid, data: { result: -1, ...buildBloodlinePayload(info) } };

  const lockRaw = params && params.lock;
  const index = Math.max(0, toSafeInt(params && params.index, 0));
  const refineList = Array.isArray(data.refineList) ? data.refineList : [];
  const targetIndex = refineList.findIndex((entry, idx) => toSafeInt(entry && entry.serverIndex, idx) === index);
  const target = targetIndex >= 0 ? refineList[targetIndex] : null;
  const nextLock = lockRaw == null ? (toSafeInt(target && target.lock, 0) > 0 ? 0 : 1) : (toSafeInt(lockRaw, 0) > 0 ? 1 : 0);
  if (target) target.lock = nextLock;
  else data.lock = nextLock;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4702,
    msgUid,
    data: {
      result: 0,
      uid,
      index,
      lock: nextLock,
      ...buildBloodlinePayload(info),
    },
  };
}

// wear
async function handleBloodlineWear(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4703, msgUid, data: { result: -1 } };

  const info = ensureBloodlineInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  if (uid > 0) {
    const data = findBloodlineByUid(info, uid);
    if (!data) return { tag: 4703, msgUid, data: { result: -1, ...buildBloodlinePayload(info) } };
    info.wearUid = uid;
  } else {
    info.wearUid = 0;
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4703,
    msgUid,
    data: {
      result: 0,
      wearUid: info.wearUid,
      ...buildBloodlinePayload(info),
      uid: info.wearUid,
    },
  };
}

// compose
async function handleBloodlineCompose(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4704, msgUid, data: { result: -1 } };

  const info = ensureBloodlineInfo(player);
  const legacyUids = Array.isArray(params && params.uids) ? uniqueInts(params.uids) : [];
  const mainUid = toSafeInt(params && (params.mainId != null ? params.mainId : params.uid), legacyUids[0] || 0);
  const main = findBloodlineByUid(info, mainUid);
  const subUids = uniqueInts(Array.isArray(params && params.subIds) ? params.subIds : legacyUids.slice(1)).filter((uid) => uid !== mainUid);
  if (!main || toSafeInt(main.lock, 0) > 0 || subUids.length === 0) return { tag: 4704, msgUid, data: { result: 1, ...buildBloodlinePayload(info) } };

  const selected = subUids
    .map((uid) => findBloodlineByUid(info, uid))
    .filter((row) => row && toSafeInt(row.lock, 0) <= 0);
  if (selected.length !== subUids.length) return { tag: 4704, msgUid, data: { result: 1, ...buildBloodlinePayload(info) } };

  const sourceQuality = getBloodlineQualityById(main.id);
  const sameQuality = selected.every((row) => getBloodlineQualityById(row.id) === sourceQuality);
  if (!sameQuality) return { tag: 4704, msgUid, data: { result: 1, ...buildBloodlinePayload(info) } };

  const composeCfg = getComposeCfg(sourceQuality, selected.length);
  const rate = Math.max(0, Math.min(100, toSafeInt(composeCfg && composeCfg.rate, 0)));
  const success = Math.random() * 100 < rate;

  selected.forEach((row) => removeBloodlineByUid(info, row.uid));
  let addData = null;
  if (success) {
    const inherited = { refineList: main.refineList, luck: main.luck };
    const targetQuality = nextComposeQuality(sourceQuality);
    const wishId = toSafeInt(info.wishMap[String(targetQuality)], 0);
    const elementTypes = [main].concat(selected).map((row) => getBloodlineCfgById(row.id)).map((row) => toSafeInt(row && row.type, 0));
    main.id = pickBloodlineIdByQualityAndTypes(targetQuality, elementTypes, wishId, 0);
    inheritRefineState(main, inherited);
    addData = main;
  }
  refreshBloodlineSummary(info);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4704,
    msgUid,
    data: {
      result: 0,
      success: success ? 1 : 0,
      id: addData ? addData.id : toSafeInt(main.id, 0),
      uid: toSafeInt(main.uid, 0),
      costUids: selected.map((row) => row.uid),
      addData: addData
        ? {
          uid: addData.uid,
          id: addData.id,
          tier: addData.tier,
          score: addData.score,
          lock: addData.lock,
          luck: addData.luck,
          refineList: addData.refineList,
        }
        : null,
      ...buildBloodlinePayload(info),
    },
  };
}

// swap bloodline id with same quality
async function handleBloodlineSwap(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4705, msgUid, data: { result: -1 } };

  const info = ensureBloodlineInfo(player);
  const uid = toSafeInt(params && (params.mainId != null ? params.mainId : params.uid), 0);
  const data = findBloodlineByUid(info, uid);
  if (!data) return { tag: 4705, msgUid, data: { result: -1, ...buildBloodlinePayload(info) } };

  const currentId = toSafeInt(data.id, 0);
  const currentCfg = getBloodlineCfgById(currentId) || {};
  const quality = getBloodlineQualityById(currentId);
  const minSwapQuality = Math.max(1, toSafeInt(getBloodlineBaseConfig().swapQuality, 7));
  if (quality < minSwapQuality) return { tag: 4705, msgUid, data: { result: 1, ...buildBloodlinePayload(info) } };

  const usePermuteCost = toSafeInt(params && params.type, 0) > 0;
  const subUids = uniqueInts(Array.isArray(params && params.subIds) ? params.subIds : []);
  if (usePermuteCost) {
    const costs = Array.isArray(currentCfg.permuteCost) ? currentCfg.permuteCost : [];
    if (!costs.every((cost) => hasEnoughItemOrCurrency(player, cost.id, cost.count))) {
      return { tag: 4705, msgUid, data: { result: 1, ...buildBloodlinePayload(info) } };
    }
    costs.forEach((cost) => consumeItemOrCurrency(player, cost.id, cost.count));
  } else {
    const costQuality = toSafeInt(currentCfg.swapCost, 0);
    const costCount = Math.max(0, toSafeInt(currentCfg.swapCostCount, 0));
    const selected = subUids.map((subUid) => findBloodlineByUid(info, subUid)).filter(Boolean);
    if (costQuality > 0 && (selected.length < costCount || !selected.every((row) => row.uid !== uid && toSafeInt(row.lock, 0) <= 0 && getBloodlineQualityById(row.id) === costQuality))) {
      return { tag: 4705, msgUid, data: { result: 1, ...buildBloodlinePayload(info) } };
    }
    selected.slice(0, costCount).forEach((row) => removeBloodlineByUid(info, row.uid));
  }

  const inherited = { refineList: data.refineList, luck: data.luck };
  const wishId = toSafeInt(info.wishMap[String(quality)], 0);
  const targetId = pickBloodlineIdByQualityAndTypes(quality, [], wishId, currentId);
  data.id = targetId;
  inheritRefineState(data, inherited);
  refreshBloodlineSummary(info);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4705,
    msgUid,
    data: {
      result: 0,
      uid,
      id: targetId,
      costUids: subUids,
      ...buildBloodlinePayload(info),
    },
  };
}

// claim atlas reward
async function handleBloodlinePicReward(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4706, msgUid, data: { result: -1, rewards: [], updateList: [] } };

  const info = ensureBloodlineInfo(player);
  const picId = toSafeInt(params && params.id, 0);
  const unlockedIds = uniqueInts(info.dataList.map((row) => toSafeInt(row && row.id, 0)));
  const targetIds = picId > 0 ? [picId] : unlockedIds;

  const rewards = [];
  const updateList = [];
  targetIds.forEach((targetId) => {
    const unlocked = unlockedIds.includes(targetId);
    const claimed = toSafeInt(info.picMap[String(targetId)], 0) > 0;
    if (targetId <= 0 || !unlocked || claimed) return;

    info.picMap[String(targetId)] = 1;
    updateList.push(targetId);
    const cfg = getBloodlineCfgById(targetId) || {};
    const reward = cfg.atlasReward || null;
    if (reward && toSafeInt(reward.id, 0) > 0 && toSafeInt(reward.count, 0) > 0) {
      const row = { id: toSafeInt(reward.id, 0), count: Math.max(0, toSafeInt(reward.count, 0)) };
      addItemOrCurrency(player, row.id, row.count);
      rewards.push(row);
    }
  });

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4706,
    msgUid,
    data: {
      result: 0,
      id: picId,
      rewards,
      updateList,
      ...buildBloodlinePayload(info),
    },
  };
}

// set compose wish by quality
async function handleBloodlineSetWish(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4707, msgUid, data: { result: -1 } };

  const info = ensureBloodlineInfo(player);
  const quality = Math.max(1, toSafeInt(params && params.quality, 0));
  const wishedId = toSafeInt(params && params.id, 0);

  if (quality > 0) {
    if (wishedId <= 0) {
      delete info.wishMap[String(quality)];
    } else if (listBloodlineIdsByQuality(quality).includes(wishedId)) {
      info.wishMap[String(quality)] = wishedId;
    }
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4707,
    msgUid,
    data: {
      result: 0,
      quality,
      id: toSafeInt(info.wishMap[String(quality)], 0),
      ...buildBloodlinePayload(info),
    },
  };
}

// special refine using special material
async function handleBloodlineSpecialRefining(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4708, msgUid, data: { result: -1 } };

  const info = ensureBloodlineInfo(player);
  const uid = toSafeInt(params && params.uid, toSafeInt(info.wearUid, 0));
  const data = findBloodlineByUid(info, uid);
  if (!data) return { tag: 4708, msgUid, data: { result: -1, ...buildBloodlinePayload(info) } };

  const specialRefine = getBloodlineBaseConfig().specialRefine || {};
  const specialId = toSafeInt(specialRefine.id, 0);
  const specialCount = Math.max(0, toSafeInt(specialRefine.count, 1));
  if (specialId <= 0 || specialCount <= 0 || !hasEnoughItemOrCurrency(player, specialId, specialCount)) {
    return { tag: 4708, msgUid, data: { result: 1, ...buildBloodlinePayload(info) } };
  }
  consumeItemOrCurrency(player, specialId, specialCount);

  const quality = getBloodlineQualityById(data.id);
  data.lastScore = Math.max(0, toSafeInt(data.score, 0));
  const requestedIndex = Math.max(0, toSafeInt(params && params.index, Array.isArray(data.refineList) ? data.refineList.length : 0));
  const maxRefineLevel = getMaxRefineLevelByQuality(quality);
  if (maxRefineLevel > 0 && requestedIndex >= maxRefineLevel) {
    return { tag: 4708, msgUid, data: { result: 1, ...buildBloodlinePayload(info) } };
  }
  const attr = createRefineAttr(quality, requestedIndex, 3);
  data.refineList = Array.isArray(data.refineList) ? data.refineList : [];
  if (requestedIndex < data.refineList.length) data.refineList[requestedIndex] = attr;
  else data.refineList.push(attr);
  data.score = calcScoreByRefineList(data.refineList);
  const scoreGain = Math.max(0, toSafeInt(data.score, 0) - toSafeInt(data.lastScore, 0));
  refreshBloodlineSummary(info);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4708,
    msgUid,
    data: {
      result: 0,
      uid,
      index: requestedIndex,
      attr,
      scoreGain,
      consume: { id: specialId, count: specialCount },
      ...buildBloodlinePayload(info),
    },
  };
}

module.exports = {
  ensureBloodlineInfo,
  buildBloodlinePayload,
  grantBloodlineToPlayer,
  handleBloodlineRefining,
  handleBloodlineBackRefining,
  handleBloodlineRefineLock,
  handleBloodlineWear,
  handleBloodlineCompose,
  handleBloodlineSwap,
  handleBloodlinePicReward,
  handleBloodlineSetWish,
  handleBloodlineSpecialRefining,
  addItemOrCurrency,
};
