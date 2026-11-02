/**
 * Curios handlers
 * tag: 5200 upgrade, 5201 star up, 5208 compose
 */

const playerService = require('../services/PlayerService');
const configService = require('../services/ConfigService');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensurePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function getCuriosPolicy() {
  const raw = String(process.env.CURIOS_RESOURCE_POLICY || 'strict').toLowerCase();
  return raw === 'strict' ? 'strict' : 'always_pass';
}

function isAlwaysPassPolicy() {
  return getCuriosPolicy() === 'always_pass';
}

function getCurrencyKeyById(itemId) {
  switch (toSafeInt(itemId, 0)) {
    case 1: return 'diamond';
    case 2: return 'silver';
    case 6: return 'gold';
    default: return null;
  }
}

function ensurePlayerCurrency(player) {
  player.currencies = ensurePlainObject(player.currencies);
  player.currencies.gold = Math.max(0, toSafeInt(player.currencies.gold, 0));
  player.currencies.diamond = Math.max(0, toSafeInt(player.currencies.diamond, 0));
  player.currencies.silver = Math.max(0, toSafeInt(player.currencies.silver, 0));
}

function ensurePlayerItems(player) {
  if (!player.items || typeof player.items !== 'object' || Array.isArray(player.items)) {
    player.items = {};
  }
}

function getCuriosBaseConfig() {
  return configService.get('CuriosBaseConfig') || {};
}

function getCuriosConfigMap() {
  return configService.get('CuriosConfig') || {};
}

function getCuriosShopConfigMap() {
  return configService.get('CuriosShopConfig') || {};
}

function getConfiguredCuriosShopIds() {
  return Object.values(getCuriosShopConfigMap() || {})
    .map((row) => toSafeInt(row && (row.shopId != null ? row.shopId : row.id), 0))
    .filter((id) => id > 0);
}

function getAssetsConfig() {
  return configService.get('AssetsConfig') || {};
}

function getCuriosUpgradeConfig() {
  return configService.get('CuriosUpgradeConfig') || {};
}

function getCuriosUpstarConfig() {
  return configService.get('CuriosUpstarConfig') || {};
}

function getCuriosConfigById(curiosId) {
  const map = getCuriosConfigMap();
  const id = toSafeInt(curiosId, 0);
  return map[id] || map[String(id)] || null;
}

function getCuriosShopConfigById(shopId) {
  const map = getCuriosShopConfigMap();
  const id = toSafeInt(shopId, 0);
  return map[id] || map[String(id)] || null;
}

function normalizeCuriosDataRow(row, curiosCfgMap) {
  const source = ensurePlainObject(row);
  const id = toSafeInt(source.id, 0);
  if (id <= 0) return null;

  const cfg = curiosCfgMap[id] || curiosCfgMap[String(id)] || null;
  const quality = Math.max(1, toSafeInt(cfg && cfg.quality, 3));
  const baseCfg = getCuriosBaseConfig();
  const maxLevel = Math.max(0, toSafeInt((baseCfg.maxLevel || {})[quality], 10));
  const maxStar = Math.max(0, toSafeInt((baseCfg.maxStar || {})[quality], 11));

  return {
    id,
    level: Math.max(0, Math.min(maxLevel, toSafeInt(source.level, 0))),
    star: Math.max(0, Math.min(maxStar, toSafeInt(source.star, 0))),
  };
}

function normalizeShopCacheRow(row) {
  const source = ensurePlainObject(row);
  const cacheListRaw = Array.isArray(source.cacheList) ? source.cacheList : [];
  const cacheList = [];

  cacheListRaw.slice(0, 3).forEach((group) => {
    const list = Array.isArray(group) ? group : [];
    const out = [];
    list.slice(0, 6).forEach((item) => {
      const data = ensurePlainObject(item);
      const id = toSafeInt(data.id, 0);
      const count = Math.max(0, toSafeInt(data.count, 0));
      if (id <= 0 || count <= 0) return;
      out.push({
        id,
        count,
        quality: Math.max(1, toSafeInt(data.quality, 1)),
        type: Math.max(1, toSafeInt(data.type, 1)),
      });
    });
    cacheList.push(out);
  });

  return {
    shopId: Math.max(0, toSafeInt(source.shopId, 0)),
    maxQuality: Math.max(0, toSafeInt(source.maxQuality, 0)),
    cacheList,
  };
}

function normalizePendingRewardRow(row) {
  const source = ensurePlainObject(row);
  const id = toSafeInt(source.id, 0);
  const count = Math.max(0, toSafeInt(source.count, 0));
  if (id <= 0 || count <= 0) return null;
  return { id, count };
}

function ensureCuriosInfo(player) {
  const now = Date.now();
  player.other_attr_info = ensurePlainObject(player.other_attr_info);

  const holder = player.other_attr_info;
  holder.curiosInfo = ensurePlainObject(holder.curiosInfo);
  const info = holder.curiosInfo;

  info.resCount = toSafeInt(info.resCount, -1);
  info.resLastTime = toSafeInt(info.resLastTime, -1);
  info.echos = ensurePlainObject(info.echos);
  info.xray = Math.max(0, Math.min(10000, toSafeInt(info.xray, 10000)));
  info.xrayLastTime = Math.max(0, toSafeInt(info.xrayLastTime, now));
  info.cacheRewardCount = Math.max(0, toSafeInt(info.cacheRewardCount, 0));

  const curiosCfgMap = getCuriosConfigMap();
  const curiosRows = Array.isArray(info.curiosData) ? info.curiosData : [];
  const curiosById = new Map();
  curiosRows.forEach((row) => {
    const normalized = normalizeCuriosDataRow(row, curiosCfgMap);
    if (!normalized) return;
    curiosById.set(normalized.id, normalized);
  });
  info.curiosData = Array.from(curiosById.values()).sort((a, b) => a.id - b.id);

  const shopRows = Array.isArray(info.shopCache) ? info.shopCache : [];
  const shopById = new Map();
  shopRows.forEach((row) => {
    const normalized = normalizeShopCacheRow(row);
    if (normalized.shopId <= 0) return;
    shopById.set(normalized.shopId, normalized);
  });
  getConfiguredCuriosShopIds().forEach((shopId) => {
    if (!shopById.has(shopId)) {
      shopById.set(shopId, { shopId, maxQuality: 0, cacheList: [] });
    }
  });
  info.shopCache = Array.from(shopById.values()).sort((a, b) => a.shopId - b.shopId);

  const pendingRows = Array.isArray(info.pendingRewardItems) ? info.pendingRewardItems : [];
  info.pendingRewardItems = pendingRows
    .map((row) => normalizePendingRewardRow(row))
    .filter((row) => !!row);

  return info;
}

function buildCuriosPayload(info) {
  const safe = info || {
    resCount: -1,
    resLastTime: -1,
    curiosData: [],
    echos: {},
    xray: 10000,
    shopCache: [],
  };

  return {
    resCount: toSafeInt(safe.resCount, -1),
    resLastTime: toSafeInt(safe.resLastTime, -1),
    curiosData: Array.isArray(safe.curiosData) ? safe.curiosData : [],
    echos: ensurePlainObject(safe.echos),
    xray: Math.max(0, toSafeInt(safe.xray, 10000)),
    shopCache: Array.isArray(safe.shopCache) ? safe.shopCache : [],
  };
}

function getCuriosQuality(curiosId) {
  const cfg = getCuriosConfigById(curiosId);
  return Math.max(1, toSafeInt(cfg && cfg.quality, 3));
}

function getCuriosMaxLevel(quality) {
  const baseCfg = getCuriosBaseConfig();
  return Math.max(0, toSafeInt((baseCfg.maxLevel || {})[Math.max(1, toSafeInt(quality, 1))], 10));
}

function getCuriosMaxStar(quality) {
  const baseCfg = getCuriosBaseConfig();
  return Math.max(0, toSafeInt((baseCfg.maxStar || {})[Math.max(1, toSafeInt(quality, 1))], 11));
}

function getCuriosInfoRow(info, curiosId) {
  const id = toSafeInt(curiosId, 0);
  if (id <= 0 || !Array.isArray(info.curiosData)) return null;
  return info.curiosData.find((row) => toSafeInt(row && row.id, 0) === id) || null;
}

function upsertCuriosInfoRow(info, curiosId) {
  let row = getCuriosInfoRow(info, curiosId);
  if (row) return row;

  row = { id: toSafeInt(curiosId, 0), level: 0, star: 0 };
  info.curiosData.push(row);
  info.curiosData.sort((a, b) => a.id - b.id);
  return row;
}

function buildCuriosDataRow(row, fallbackId = 0) {
  const id = Math.max(0, toSafeInt(row && row.id, toSafeInt(fallbackId, 0)));
  const level = Math.max(0, toSafeInt(row && row.level, 0));
  const star = Math.max(0, toSafeInt(row && row.star, 0));
  return { id, level, star };
}

function getItemOrCurrencyCount(player, itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return 0;

  const currencyKey = getCurrencyKeyById(id);
  if (currencyKey) {
    ensurePlayerCurrency(player);
    return Math.max(0, toSafeInt(player.currencies[currencyKey], 0));
  }

  ensurePlayerItems(player);
  return Math.max(0, toSafeInt(player.items[id], 0));
}

function addItemOrCurrency(player, itemId, count) {
  const id = toSafeInt(itemId, 0);
  const gain = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || gain <= 0) return;

  const currencyKey = getCurrencyKeyById(id);
  if (currencyKey) {
    ensurePlayerCurrency(player);
    player.currencies[currencyKey] = Math.max(0, toSafeInt(player.currencies[currencyKey], 0)) + gain;
    return;
  }

  ensurePlayerItems(player);
  player.items[id] = Math.max(0, toSafeInt(player.items[id], 0)) + gain;
}

function consumeItemOrCurrency(player, itemId, count, options = {}) {
  const id = toSafeInt(itemId, 0);
  const need = Math.max(0, toSafeInt(count, 0));
  const allowOverdraft = !!options.allowOverdraft;
  if (id <= 0 || need <= 0) return true;

  const have = getItemOrCurrencyCount(player, id);
  if (!allowOverdraft && have < need) return false;

  const next = Math.max(0, have - need);
  const currencyKey = getCurrencyKeyById(id);
  if (currencyKey) {
    ensurePlayerCurrency(player);
    player.currencies[currencyKey] = next;
    return true;
  }

  ensurePlayerItems(player);
  if (next <= 0) {
    delete player.items[id];
  } else {
    player.items[id] = next;
  }
  return true;
}

function canConsumeRows(player, rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    const id = toSafeInt(row && row.id, 0);
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) continue;
    if (getItemOrCurrencyCount(player, id) < count) return false;
  }
  return true;
}

function consumeRows(player, rows, allowOverdraft) {
  const list = Array.isArray(rows) ? rows : [];
  list.forEach((row) => {
    const id = toSafeInt(row && row.id, 0);
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    consumeItemOrCurrency(player, id, count, { allowOverdraft });
  });
}

function normalizeCostRows(rows) {
  const list = Array.isArray(rows) ? rows : (rows && typeof rows === 'object' ? [rows] : []);
  return list
    .map((row) => ({
      id: toSafeInt(row && row.id, 0),
      count: Math.max(0, toSafeInt(row && row.count, 0)),
    }))
    .filter((row) => row.id > 0 && row.count > 0);
}

function buildItemChangedRows(player, ids = []) {
  return Array.from(new Set((Array.isArray(ids) ? ids : [])
    .map((id) => toSafeInt(id, 0))
    .filter((id) => id > 0)))
    .map((id) => ({ id, count: getItemOrCurrencyCount(player, id) }))
    .sort((a, b) => a.id - b.id);
}

function buildItemDeltaPacket(player, msgUid, deltaRows = []) {
  const rows = normalizeCostRows(deltaRows);
  if (rows.length <= 0) return null;
  return {
    tag: 1202,
    msgUid: 0,
    data: {
      result: 0,
      items: rows.map((row) => ({ id: row.id, count: -row.count })),
      changed: buildItemChangedRows(player, rows.map((row) => row.id)),
    },
  };
}

function canConsumePieceWithGeneral(player, pieceId, generalPieceId, need) {
  const target = Math.max(0, toSafeInt(need, 0));
  if (target <= 0) return true;
  const own = getItemOrCurrencyCount(player, pieceId);
  if (own >= target) return true;
  const general = getItemOrCurrencyCount(player, generalPieceId);
  return own + general >= target;
}

function consumePieceWithGeneral(player, pieceId, generalPieceId, need, allowOverdraft) {
  const target = Math.max(0, toSafeInt(need, 0));
  if (target <= 0) return;

  const own = getItemOrCurrencyCount(player, pieceId);
  const ownUse = Math.min(own, target);
  const remain = Math.max(0, target - ownUse);

  if (ownUse > 0 || allowOverdraft) {
    consumeItemOrCurrency(player, pieceId, ownUse > 0 ? ownUse : remain, { allowOverdraft });
  }
  if (remain > 0) {
    consumeItemOrCurrency(player, generalPieceId, remain, { allowOverdraft });
  }
}

async function persistCuriosPlayer(session, player) {
  if (!session || !session.userId) return;
  const saved = await playerService.savePlayer(session.userId, player);
  if (saved && typeof saved === 'object') {
    session.player = saved;
  }
}

function resolveUpgradeConfig(quality, level) {
  const map = getCuriosUpgradeConfig();
  const qMap = map[Math.max(1, toSafeInt(quality, 1))] || map[String(Math.max(1, toSafeInt(quality, 1)))] || {};
  return qMap[Math.max(1, toSafeInt(level, 1))] || qMap[String(Math.max(1, toSafeInt(level, 1)))] || null;
}

function resolveUpstarConfig(quality, star) {
  const map = getCuriosUpstarConfig();
  const qMap = map[Math.max(1, toSafeInt(quality, 1))] || map[String(Math.max(1, toSafeInt(quality, 1)))] || {};
  return qMap[Math.max(1, toSafeInt(star, 1))] || qMap[String(Math.max(1, toSafeInt(star, 1)))] || null;
}

function buildRewardInfo(items = []) {
  return {
    items: Array.isArray(items) ? items : [],
    equips: [],
    swords: [],
    pets: [],
    artifacts: [],
    gems: [],
    valhalla: [],
    bloodline: [],
    fashion: [],
    elves: [],
    extraReward: {},
  };
}

function applyRewardRows(player, rows = []) {
  const rewardRows = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      id: toSafeInt(row && row.id, 0),
      count: Math.max(0, toSafeInt(row && row.count, 0)),
    }))
    .filter((row) => row.id > 0 && row.count > 0);

  rewardRows.forEach((row) => addItemOrCurrency(player, row.id, row.count));
  return rewardRows;
}

function resolveCuriosStock(info, nowMs) {
  const baseCfg = getCuriosBaseConfig();
  const stockLimit = Math.max(0, toSafeInt(baseCfg.freeResStockLim, 3));
  const cdMs = Math.max(1, toSafeInt(baseCfg.freeResCD, 28800)) * 1000;

  const rawCount = toSafeInt(info.resCount, -1);
  const rawLastTime = toSafeInt(info.resLastTime, -1);
  if (rawCount < 0 || rawLastTime < 0) {
    return { stock: stockLimit, stockLimit, cdMs, anchorTime: nowMs };
  }

  const elapsedMs = Math.max(0, nowMs - rawLastTime);
  const elapsedTick = Math.floor(elapsedMs / cdMs);
  const stock = Math.min(stockLimit, rawCount + elapsedTick);
  const anchorTime = rawLastTime + elapsedTick * cdMs;
  return { stock, stockLimit, cdMs, anchorTime };
}

function cloneShopCacheRow(row) {
  const normalized = normalizeShopCacheRow(row);
  return {
    shopId: normalized.shopId,
    maxQuality: normalized.maxQuality,
    cacheList: normalized.cacheList.map((group) => group.map((item) => ({ ...item }))),
  };
}

function getOrCreateShopCacheRow(info, shopId) {
  const targetId = Math.max(1, toSafeInt(shopId, 0));
  let row = (Array.isArray(info.shopCache) ? info.shopCache : [])
    .find((item) => toSafeInt(item && item.shopId, 0) === targetId);
  if (row) return row;

  row = { shopId: targetId, maxQuality: 0, cacheList: [] };
  info.shopCache.push(row);
  info.shopCache.sort((a, b) => toSafeInt(a.shopId, 0) - toSafeInt(b.shopId, 0));
  return row;
}

function updateXrayEnergy(info, nowMs) {
  const baseCfg = getCuriosBaseConfig();
  const recoverPerSec = Math.max(0, toSafeInt(baseCfg.xrayEyeTime, 1));
  const now = Math.max(0, toSafeInt(nowMs, Date.now()));
  const lastTime = Math.max(0, toSafeInt(info.xrayLastTime, now));

  if (recoverPerSec <= 0 || now <= lastTime) {
    info.xrayLastTime = now;
    return;
  }

  const elapsedSec = Math.floor((now - lastTime) / 1000);
  if (elapsedSec <= 0) return;

  info.xray = Math.max(0, Math.min(10000, toSafeInt(info.xray, 10000) + elapsedSec * recoverPerSec));
  info.xrayLastTime = lastTime + elapsedSec * 1000;
  if (info.xray >= 10000) {
    info.xray = 10000;
    info.xrayLastTime = now;
  }
}

function getAssetRow(itemId, assetsCfg = null) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return null;
  const map = assetsCfg || getAssetsConfig();
  return map[id] || map[String(id)] || null;
}

function getAssetType(itemId, assetsCfg = null) {
  const id = toSafeInt(itemId, 0);
  const row = getAssetRow(id, assetsCfg);
  if (row) return Math.max(1, toSafeInt(row.type, 1));
  if (id >= 130000 && id < 140000) return 24;
  if (id >= 140000 && id < 150000) return 25;
  return 1;
}

function getAssetQuality(itemId, assetsCfg = null) {
  const id = toSafeInt(itemId, 0);
  const row = getAssetRow(id, assetsCfg);
  if (row) return Math.max(1, toSafeInt(row.quality, 1));
  return 1;
}

function pickWeightedKey(weightMap, fallback = 3) {
  const entries = Object.entries(ensurePlainObject(weightMap))
    .map(([key, value]) => ({ key: toSafeInt(key, 0), weight: Math.max(0, toSafeInt(value, 0)) }))
    .filter((entry) => entry.key > 0 && entry.weight > 0);
  if (entries.length <= 0) return Math.max(1, toSafeInt(fallback, 3));

  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return Math.max(1, toSafeInt(fallback, 3));

  let roll = Math.random() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll < 0) return entry.key;
  }
  return entries[entries.length - 1].key;
}

function listCuriosCandidatesByShopAndQuality(shopId, quality) {
  const targetShopId = Math.max(1, toSafeInt(shopId, 1));
  const targetQuality = Math.max(1, toSafeInt(quality, 3));
  const rows = Object.values(getCuriosConfigMap() || {})
    .filter((row) => ensurePlainObject(row).id)
    .filter((row) => toSafeInt(row.materialType, 0) === targetShopId);

  const exact = rows.filter((row) => toSafeInt(row.quality, 0) === targetQuality);
  if (exact.length > 0) return exact;

  if (rows.length <= 0) return [];
  const qualities = Array.from(
    new Set(rows.map((row) => Math.max(1, toSafeInt(row.quality, 1))))
  ).sort((a, b) => a - b);
  let nearest = qualities[0];
  let bestDiff = Math.abs(nearest - targetQuality);
  qualities.forEach((q) => {
    const diff = Math.abs(q - targetQuality);
    if (diff < bestDiff) {
      bestDiff = diff;
      nearest = q;
    }
  });
  return rows.filter((row) => toSafeInt(row.quality, 0) === nearest);
}

function pickRandomFromList(list = []) {
  if (!Array.isArray(list) || list.length <= 0) return null;
  const idx = Math.floor(Math.random() * list.length);
  return list[idx];
}

function buildDrawMatrixByShop(shopId) {
  const baseCfg = getCuriosBaseConfig();
  const shopCfg = getCuriosShopConfigById(shopId) || {};
  const assetsCfg = getAssetsConfig();
  const firstDrawResult = Array.isArray(baseCfg.firstDrawResult) ? baseCfg.firstDrawResult : [];

  const result = [];
  const cacheList = [];
  let maxQuality = 0;

  for (let groupIdx = 0; groupIdx < 3; groupIdx += 1) {
    const qualityWeights = ensurePlainObject(shopCfg[`callRateShow${groupIdx + 1}`]);
    const rollQuality = pickWeightedKey(qualityWeights, 3);
    const candidates = listCuriosCandidatesByShopAndQuality(shopId, rollQuality);
    const templateGroup = Array.isArray(firstDrawResult[groupIdx]) ? firstDrawResult[groupIdx] : [];
    const resultGroup = [];
    const cacheGroup = [];

    for (let slotIdx = 0; slotIdx < 6; slotIdx += 1) {
      const template = ensurePlainObject(templateGroup[slotIdx]);
      const templateId = toSafeInt(template.id, 120);
      const templateCount = Math.max(1, toSafeInt(template.count, 1));
      const slotType = getAssetType(templateId, assetsCfg);

      let id = templateId;
      let count = templateCount;
      let quality = getAssetQuality(templateId, assetsCfg);
      let type = slotType;
      const pickedCurios = pickRandomFromList(candidates);

      if (slotType === 24 && pickedCurios) {
        id = toSafeInt(pickedCurios.id, templateId);
        count = Math.max(1, templateCount);
        quality = Math.max(1, toSafeInt(pickedCurios.quality, quality));
        type = 24;
      } else if (slotType === 25 && pickedCurios) {
        id = toSafeInt(pickedCurios.pieceID, templateId);
        count = Math.max(1, templateCount);
        quality = Math.max(1, toSafeInt(pickedCurios.quality, quality));
        type = 25;
      } else if (slotType === 1) {
        type = 1;
      } else {
        type = getAssetType(id, assetsCfg);
        quality = getAssetQuality(id, assetsCfg);
      }

      maxQuality = Math.max(maxQuality, quality);
      resultGroup.push({ id, count });
      cacheGroup.push({ id, count, quality, type });
    }

    result.push(resultGroup);
    cacheList.push(cacheGroup);
  }

  return { result, cacheList, maxQuality };
}

function aggregateRewardRows(rows = []) {
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const id = toSafeInt(row && row.id, 0);
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    map.set(id, (map.get(id) || 0) + count);
  });
  return Array.from(map.entries())
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => a.id - b.id);
}

function applyCuriosSummonRewardRows(player, info, rows = []) {
  const rewardRows = aggregateRewardRows(rows);
  const assetsCfg = getAssetsConfig();

  rewardRows.forEach((row) => {
    const type = getAssetType(row.id, assetsCfg);
    if (type === 24) {
      if (!getCuriosInfoRow(info, row.id)) {
        upsertCuriosInfoRow(info, row.id);
      }
      return;
    }
    addItemOrCurrency(player, row.id, row.count);
  });
  return rewardRows;
}

async function handleCuriosUpgrade(params, session, msgUid) {
  const player = session && session.player;
  const curiosId = toSafeInt(params && params.id, 0);
  if (!player || curiosId <= 0) {
    return { tag: 5200, msgUid, data: { curiosData: buildCuriosDataRow({ id: curiosId, level: 0, star: 0 }, curiosId) } };
  }

  const info = ensureCuriosInfo(player);
  const cfg = getCuriosConfigById(curiosId);
  const alwaysPass = isAlwaysPassPolicy();

  if (!cfg) {
    return { tag: 5200, msgUid, data: { curiosData: buildCuriosDataRow(getCuriosInfoRow(info, curiosId), curiosId) } };
  }

  let row = getCuriosInfoRow(info, curiosId);
  if (!row && alwaysPass) {
    row = upsertCuriosInfoRow(info, curiosId);
  }

  if (!row) {
    return { tag: 5200, msgUid, data: { curiosData: buildCuriosDataRow(null, curiosId) } };
  }

  const quality = getCuriosQuality(curiosId);
  const maxLevel = getCuriosMaxLevel(quality);
  const currentLevel = Math.max(0, toSafeInt(row.level, 0));

  if (currentLevel < maxLevel) {
    const nextLevel = currentLevel + 1;
    const upgradeCfg = resolveUpgradeConfig(quality, nextLevel) || {};
    const costs = Array.isArray(upgradeCfg.consumes) ? upgradeCfg.consumes : [];

    if (alwaysPass || canConsumeRows(player, costs)) {
      consumeRows(player, costs, alwaysPass);
      row.level = nextLevel;
    }
  }

  await persistCuriosPlayer(session, player);
  return { tag: 5200, msgUid, data: { curiosData: buildCuriosDataRow(row, curiosId) } };
}

async function handleCuriosStarUp(params, session, msgUid) {
  const player = session && session.player;
  const curiosId = toSafeInt(params && params.id, 0);
  if (!player || curiosId <= 0) {
    return { tag: 5201, msgUid, data: { curiosData: buildCuriosDataRow({ id: curiosId, level: 0, star: 0 }, curiosId) } };
  }

  const info = ensureCuriosInfo(player);
  const cfg = getCuriosConfigById(curiosId);
  const alwaysPass = isAlwaysPassPolicy();

  if (!cfg) {
    return { tag: 5201, msgUid, data: { curiosData: buildCuriosDataRow(getCuriosInfoRow(info, curiosId), curiosId) } };
  }

  let row = getCuriosInfoRow(info, curiosId);
  if (!row && alwaysPass) {
    row = upsertCuriosInfoRow(info, curiosId);
  }

  if (!row) {
    return { tag: 5201, msgUid, data: { curiosData: buildCuriosDataRow(null, curiosId) } };
  }

  const quality = getCuriosQuality(curiosId);
  const maxStar = getCuriosMaxStar(quality);
  const currentStar = Math.max(0, toSafeInt(row.star, 0));

  if (currentStar < maxStar) {
    const nextStar = currentStar + 1;
    const upstarCfg = resolveUpstarConfig(quality, nextStar) || {};
    const pieceConsumes = Math.max(0, toSafeInt(upstarCfg.pieceConsumes, 0));
    const costs = Array.isArray(upstarCfg.consumes) ? upstarCfg.consumes : [];
    const baseCfg = getCuriosBaseConfig();
    const generalPieceMap = ensurePlainObject(baseCfg.generalPiece);
    const generalPieceId = toSafeInt(generalPieceMap[quality], 0);

    let canStarUp = alwaysPass || canConsumeRows(player, costs);
    if (canStarUp && pieceConsumes > 0 && !alwaysPass) {
      canStarUp = canConsumePieceWithGeneral(player, cfg.pieceID, generalPieceId, pieceConsumes);
    }

    if (canStarUp) {
      if (pieceConsumes > 0) {
        consumePieceWithGeneral(player, cfg.pieceID, generalPieceId, pieceConsumes, alwaysPass);
      }
      consumeRows(player, costs, alwaysPass);
      row.star = nextStar;
    }
  }

  await persistCuriosPlayer(session, player);
  return { tag: 5201, msgUid, data: { curiosData: buildCuriosDataRow(row, curiosId) } };
}

async function handleCuriosDecompose(params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 5202, msgUid, data: { reward: buildRewardInfo([]) } };
  }

  const info = ensureCuriosInfo(player);
  const baseCfg = getCuriosBaseConfig();
  const returnNum = ensurePlainObject(baseCfg.returnNum);
  const ids = Array.isArray(params && params.ids) ? params.ids : [];
  const idSet = new Set(
    ids
      .map((id) => toSafeInt(id, 0))
      .filter((id) => id > 0)
  );

  const rewardMap = new Map();
  info.curiosData = info.curiosData.filter((row) => {
    const id = toSafeInt(row && row.id, 0);
    if (!idSet.has(id)) return true;

    const cfg = getCuriosConfigById(id);
    const quality = Math.max(1, toSafeInt(cfg && cfg.quality, 3));
    const rewardCfg = ensurePlainObject(returnNum[quality]);
    const rewardId = toSafeInt(rewardCfg.id, 0);
    const rewardCount = Math.max(0, toSafeInt(rewardCfg.count, 0));
    if (rewardId > 0 && rewardCount > 0) {
      rewardMap.set(rewardId, (rewardMap.get(rewardId) || 0) + rewardCount);
    }
    return false;
  });

  const rewardRows = Array.from(rewardMap.entries())
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => a.id - b.id);
  const granted = applyRewardRows(player, rewardRows);

  await persistCuriosPlayer(session, player);
  return { tag: 5202, msgUid, data: { reward: buildRewardInfo(granted) } };
}

async function handleCuriosBoxReward(params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return {
      tag: 5203,
      msgUid,
      data: {
        resCount: -1,
        resLastTime: -1,
        reward: buildRewardInfo([]),
      },
    };
  }

  const info = ensureCuriosInfo(player);
  const baseCfg = getCuriosBaseConfig();
  const freeResContent = Math.max(0, toSafeInt(baseCfg.freeResContent, 100));
  const freeResMax = Math.max(0, toSafeInt(baseCfg.freeResMax, 300));
  const now = Date.now();
  const stockState = resolveCuriosStock(info, now);
  const stock = Math.max(0, toSafeInt(stockState.stock, 0));

  const currentBoxItem = getItemOrCurrencyCount(player, 128);
  const remainByCap = Math.max(0, freeResMax - currentBoxItem);
  const maxClaimTimesByCap = freeResContent > 0 ? Math.floor(remainByCap / freeResContent) : 0;
  const claimTimes = Math.max(0, Math.min(stock, maxClaimTimesByCap));
  const rewardRows = claimTimes > 0 && freeResContent > 0
    ? [{ id: 128, count: claimTimes * freeResContent }]
    : [];
  const granted = applyRewardRows(player, rewardRows);

  info.resCount = Math.max(0, stock - claimTimes);
  if (claimTimes > 0 || toSafeInt(info.resLastTime, -1) < 0) {
    info.resLastTime = now;
  } else {
    info.resLastTime = Math.max(0, toSafeInt(stockState.anchorTime, now));
  }

  await persistCuriosPlayer(session, player);
  return {
    tag: 5203,
    msgUid,
    data: {
      resCount: info.resCount,
      resLastTime: info.resLastTime,
      reward: buildRewardInfo(granted),
    },
  };
}

async function handleCuriosUseEye(params, session, msgUid) {
  const player = session && session.player;
  const shopId = Math.max(1, toSafeInt(params && params.shopId, 1));
  if (!player) {
    return {
      tag: 5204,
      msgUid,
      data: { cache: { shopId, maxQuality: 0, cacheList: [] }, xray: 10000 },
    };
  }

  const info = ensureCuriosInfo(player);
  const alwaysPass = isAlwaysPassPolicy();
  const now = Date.now();
  updateXrayEnergy(info, now);

  const cacheRow = getOrCreateShopCacheRow(info, shopId);
  const baseCfg = getCuriosBaseConfig();
  const eyeCost = Math.max(0, toSafeInt(baseCfg.xrayEyeEnergy, 200));
  const hasEnoughEnergy = toSafeInt(info.xray, 0) >= eyeCost;

  if (alwaysPass || hasEnoughEnergy) {
    info.xray = Math.max(0, toSafeInt(info.xray, 10000) - eyeCost);
    info.xrayLastTime = now;

    const draw = buildDrawMatrixByShop(shopId);
    cacheRow.maxQuality = Math.max(0, toSafeInt(draw.maxQuality, 0));
    cacheRow.cacheList = draw.cacheList;
  }

  await persistCuriosPlayer(session, player);
  return {
    tag: 5204,
    msgUid,
    data: {
      cache: cloneShopCacheRow(cacheRow),
      xray: Math.max(0, toSafeInt(info.xray, 0)),
    },
  };
}

async function handleCuriosSummon(params, session, msgUid) {
  const player = session && session.player;
  const shopId = Math.max(1, toSafeInt(params && params.shopId, 1));
  const index = Math.max(0, Math.min(2, toSafeInt(params && params.index, 0)));
  const cacheReward = !!(params && params.cache);

  if (!player) {
    return {
      tag: 5205,
      msgUid,
      data: {
        xray: 10000,
        shopId,
        cache: { shopId, maxQuality: 0, cacheList: [] },
        cacheRewardCount: 0,
        reward: buildRewardInfo([]),
        result: [[], [], []],
      },
    };
  }

  const info = ensureCuriosInfo(player);
  const alwaysPass = isAlwaysPassPolicy();
  const now = Date.now();
  updateXrayEnergy(info, now);

  const cacheRow = getOrCreateShopCacheRow(info, shopId);
  const hasCache = Array.isArray(cacheRow.cacheList)
    && cacheRow.cacheList.length === 3
    && cacheRow.cacheList.every((group) => Array.isArray(group) && group.length === 6);

  const draw = hasCache
    ? {
      result: cacheRow.cacheList.map((group) => group.map((item) => ({ id: item.id, count: item.count }))),
      cacheList: cacheRow.cacheList,
      maxQuality: cacheRow.maxQuality,
    }
    : buildDrawMatrixByShop(shopId);

  const shopCfg = getCuriosShopConfigById(shopId) || {};
  const costRows = normalizeCostRows(shopCfg.cost);
  if (costRows.length > 0 && !alwaysPass && !canConsumeRows(player, costRows)) {
    return {
      tag: 5205,
      msgUid,
      data: {
        code: -1,
        xray: Math.max(0, toSafeInt(info.xray, 0)),
        shopId,
        cache: cloneShopCacheRow(cacheRow),
        cacheRewardCount: Math.max(0, toSafeInt(info.cacheRewardCount, 0)),
        reward: buildRewardInfo([]),
        result: draw.result,
      },
    };
  }
  consumeRows(player, costRows, alwaysPass);

  const selectedGroup = Array.isArray(draw.result[index]) ? draw.result[index] : [];
  let grantedRows = [];

  if (cacheReward) {
    const pending = Array.isArray(info.pendingRewardItems) ? info.pendingRewardItems : [];
    selectedGroup.forEach((row) => {
      const id = toSafeInt(row && row.id, 0);
      const count = Math.max(0, toSafeInt(row && row.count, 0));
      if (id <= 0 || count <= 0) return;
      pending.push({ id, count });
    });
    info.pendingRewardItems = pending;
    info.cacheRewardCount = Math.max(0, toSafeInt(info.cacheRewardCount, 0)) + 1;
  } else {
    grantedRows = applyCuriosSummonRewardRows(player, info, selectedGroup);
  }

  cacheRow.maxQuality = 0;
  cacheRow.cacheList = [];

  await persistCuriosPlayer(session, player);
  const response = {
    tag: 5205,
    msgUid,
    data: {
      xray: Math.max(0, toSafeInt(info.xray, 0)),
      shopId,
      cache: cloneShopCacheRow(cacheRow),
      cacheRewardCount: Math.max(0, toSafeInt(info.cacheRewardCount, 0)),
      reward: buildRewardInfo(grantedRows),
      result: draw.result,
    },
  };
  const costSyncPacket = buildItemDeltaPacket(player, msgUid, costRows);
  return costSyncPacket ? [costSyncPacket, response] : response;
}

async function handleCuriosPass(params, session, msgUid) {
  const player = session && session.player;
  const shopId = Math.max(1, toSafeInt(params && params.shopId, 1));
  if (!player) {
    return { tag: 5206, msgUid, data: { cache: { shopId, maxQuality: 0, cacheList: [] } } };
  }

  const info = ensureCuriosInfo(player);
  const cacheRow = getOrCreateShopCacheRow(info, shopId);
  cacheRow.maxQuality = 0;
  cacheRow.cacheList = [];

  await persistCuriosPlayer(session, player);
  return { tag: 5206, msgUid, data: { cache: cloneShopCacheRow(cacheRow) } };
}

async function handleCuriosAllReward(params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 5207, msgUid, data: { reward: buildRewardInfo([]), result: [] } };
  }

  const info = ensureCuriosInfo(player);
  const pendingRows = Array.isArray(info.pendingRewardItems) ? info.pendingRewardItems : [];
  const grantedRows = applyCuriosSummonRewardRows(player, info, pendingRows);

  info.pendingRewardItems = [];
  info.cacheRewardCount = 0;

  await persistCuriosPlayer(session, player);
  return {
    tag: 5207,
    msgUid,
    data: {
      reward: buildRewardInfo(grantedRows),
      result: grantedRows,
    },
  };
}

async function handleCuriosCompose(params, session, msgUid) {
  const player = session && session.player;
  const curiosId = toSafeInt(params && params.id, 0);
  if (!player || curiosId <= 0) {
    return { tag: 5208, msgUid, data: { curiosData: buildCuriosDataRow({ id: curiosId, level: 0, star: 0 }, curiosId) } };
  }

  const info = ensureCuriosInfo(player);
  const cfg = getCuriosConfigById(curiosId);
  const alwaysPass = isAlwaysPassPolicy();

  if (!cfg) {
    return { tag: 5208, msgUid, data: { curiosData: buildCuriosDataRow(getCuriosInfoRow(info, curiosId), curiosId) } };
  }

  const baseCfg = getCuriosBaseConfig();
  const composeNumMap = ensurePlainObject(baseCfg.composeNum);
  const quality = getCuriosQuality(curiosId);
  const composeNeed = Math.max(0, toSafeInt(composeNumMap[quality], 0));

  const hasEnough = getItemOrCurrencyCount(player, cfg.pieceID) >= composeNeed;
  if (alwaysPass || hasEnough) {
    consumeItemOrCurrency(player, cfg.pieceID, composeNeed, { allowOverdraft: alwaysPass });
  }

  let row = getCuriosInfoRow(info, curiosId);
  if (!row && (alwaysPass || hasEnough)) {
    row = upsertCuriosInfoRow(info, curiosId);
  }

  await persistCuriosPlayer(session, player);
  return { tag: 5208, msgUid, data: { curiosData: buildCuriosDataRow(row, curiosId) } };
}

module.exports = {
  ensureCuriosInfo,
  buildCuriosPayload,
  handleCuriosUpgrade,
  handleCuriosStarUp,
  handleCuriosDecompose,
  handleCuriosBoxReward,
  handleCuriosUseEye,
  handleCuriosSummon,
  handleCuriosPass,
  handleCuriosAllReward,
  handleCuriosCompose,
};
