/**
 * Homeland handlers.
 * tag: 6700~6742
 */

const playerService = require('../services/PlayerService');
const configService = require('../services/ConfigService');
const { addRewardToPlayer } = require('./raid');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensurePlainObject(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...fallback };
  }
  return value;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function getHomelandBuildingConfigMap() {
  const cfg = configService.get('HomelandBuildingConfig');
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
}

function getDefaultHomelandMapId() {
  const base = ensurePlainObject(configService.get('HomelandBaseConfig'));
  const initMap = toSafeInt(base.initMap, 0);
  const tileSceneCfg = ensurePlainObject(configService.get('TileSceneConfig'));
  if (initMap > 0 && (tileSceneCfg[initMap] || tileSceneCfg[String(initMap)])) return initMap;
  const ids = Object.keys(tileSceneCfg)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
  return ids[0] || 1001;
}

function pickDefaultBuildingId() {
  const cfg = getHomelandBuildingConfigMap();
  const ids = Object.keys(cfg)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0 && cfg[id] && toSafeInt(cfg[id].isShow, 1) !== 0)
    .sort((a, b) => a - b);
  return ids[0] || 170011;
}

function isClientHomelandBuildingId(id) {
  const safeId = Math.max(0, toSafeInt(id, 0));
  if (safeId <= 0) return false;
  const cfg = getHomelandBuildingConfigMap();
  if (Object.keys(cfg).length <= 0) return safeId === 170011 || safeId === 170013 || safeId === 170021;
  return !!(cfg[safeId] || cfg[String(safeId)]);
}

function normalizeHomelandBuildingId(id, fallback = pickDefaultBuildingId()) {
  const safeId = Math.max(0, toSafeInt(id, 0));
  if (isClientHomelandBuildingId(safeId)) return safeId;
  return isClientHomelandBuildingId(fallback) ? fallback : pickDefaultBuildingId();
}

function normalizeHomelandLayout(layout) {
  const source = ensurePlainObject(layout);
  const normalized = {};
  Object.keys(source).forEach((key) => {
    if (!isClientHomelandBuildingId(key)) return;
    const list = ensureArray(source[key])
      .map((row) => ensurePlainObject(row))
      .map((row) => ({
        x: Math.max(0, toSafeInt(row.x, 0)),
        y: Math.max(0, toSafeInt(row.y, 0)),
        dir: Math.max(0, toSafeInt(row.dir, 0)),
      }));
    if (list.length > 0) normalized[String(toSafeInt(key, 0))] = list;
  });
  return normalized;
}

function normalizeRewards(rows = []) {
  const map = new Map();
  ensureArray(rows).forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    map.set(id, (map.get(id) || 0) + count);
  });
  const rewards = [];
  map.forEach((count, id) => rewards.push({ id, count }));
  rewards.sort((a, b) => a.id - b.id);
  return rewards;
}

function buildRewardInfo(rows = []) {
  return {
    items: normalizeRewards(rows),
    equips: [],
    heros: [],
    extraReward: {},
  };
}

function grantRewardInfo(player, rows = []) {
  const rewardInfo = buildRewardInfo(rows);
  rewardInfo.items.forEach((row) => addRewardToPlayer(player, row.id, row.count));
  return rewardInfo;
}

function getCurrencyKeyById(itemId) {
  switch (toSafeInt(itemId, 0)) {
    case 1: return 'diamond';
    case 2: return 'silver';
    case 6: return 'gold';
    default: return null;
  }
}

function getItemOrCurrencyCount(player, itemId) {
  const id = Math.max(0, toSafeInt(itemId, 0));
  if (id <= 0) return 0;
  const currencyKey = getCurrencyKeyById(id);
  if (currencyKey) {
    return Math.max(0, toSafeInt(player && player.currencies && player.currencies[currencyKey], 0));
  }
  return Math.max(0, toSafeInt(player && player.items && player.items[id], 0));
}

function normalizeCostRows(rows = []) {
  return normalizeRewards(rows);
}

function canConsumeCostRows(player, rows = []) {
  return normalizeCostRows(rows).every((row) => getItemOrCurrencyCount(player, row.id) >= row.count);
}

function consumeCostRows(player, rows = []) {
  const costs = normalizeCostRows(rows);
  if (!canConsumeCostRows(player, costs)) return false;

  player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
  player.items = player.items || {};
  costs.forEach((row) => {
    const currencyKey = getCurrencyKeyById(row.id);
    if (currencyKey) {
      player.currencies[currencyKey] = Math.max(0, toSafeInt(player.currencies[currencyKey], 0) - row.count);
      return;
    }
    player.items[row.id] = Math.max(0, toSafeInt(player.items[row.id], 0) - row.count);
    if (player.items[row.id] <= 0) delete player.items[row.id];
  });
  return true;
}

function getConfigRow(tableName, id) {
  const table = ensurePlainObject(configService.get(tableName));
  return table[id] || table[String(id)] || null;
}

function getNestedConfigRow(tableName, firstKey, secondKey) {
  const group = ensurePlainObject(getConfigRow(tableName, firstKey));
  return group[secondKey] || group[String(secondKey)] || null;
}

function buildNormalBuildingUpgradeCost(player, buildingCfg, levelCfg) {
  const costs = [];
  const exchangeItems = [];
  const exchangeRewards = [];
  const levelUpIds = ensureArray(buildingCfg && buildingCfg.levelUpIds);
  const levelUpCounts = ensureArray(levelCfg && levelCfg.levelUpCounts);
  const resourceCount = Math.min(levelUpIds.length, levelUpCounts.length);
  for (let index = 0; index < resourceCount; index += 1) {
    costs.push({ id: levelUpIds[index], count: levelUpCounts[index] });
  }

  const pieceId = Math.max(0, toSafeInt(buildingCfg && buildingCfg.levelUpPiece, 0));
  const pieceNeed = Math.max(0, toSafeInt(levelCfg && levelCfg.levelUpPieceCount, 0));
  if (pieceId <= 0 || pieceNeed <= 0) return { costs, exchangeItems, exchangeRewards };

  const ownedPiece = getItemOrCurrencyCount(player, pieceId);
  if (ownedPiece >= pieceNeed) {
    costs.push({ id: pieceId, count: pieceNeed });
    return { costs, exchangeItems, exchangeRewards };
  }

  const baseCfg = ensurePlainObject(configService.get('HomelandBaseConfig'));
  const qualityPieces = ensurePlainObject(baseCfg.qualityPiece);
  const generalPieceId = Math.max(0, toSafeInt(qualityPieces[buildingCfg.qualityId], 0));
  const missing = pieceNeed - ownedPiece;
  if (ownedPiece > 0) costs.push({ id: pieceId, count: ownedPiece });
  if (generalPieceId > 0) {
    costs.push({ id: generalPieceId, count: missing });
    exchangeItems.push({ id: generalPieceId, count: missing });
    exchangeRewards.push({ id: pieceId, count: missing });
  } else {
    costs.push({ id: pieceId, count: missing });
  }
  return { costs, exchangeItems, exchangeRewards };
}

function randomShareCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function ensureCollect(info, id) {
  const bid = normalizeHomelandBuildingId(id);
  info.collectMap = ensurePlainObject(info.collectMap);
  const key = String(bid);
  info.collectMap[key] = ensurePlainObject(info.collectMap[key], {
    id: bid,
    count: 0,
    upgradeTime: 0,
    state: 0,
  });
  const row = info.collectMap[key];
  row.id = bid;
  row.count = Math.max(0, toSafeInt(row.count, 0));
  row.upgradeTime = Math.max(0, toSafeInt(row.upgradeTime, 0));
  if (row.upgradeTime > 0 && row.upgradeTime < 1000000000000) {
    row.upgradeTime *= 1000;
  }
  row.collectTime = Math.max(0, toSafeInt(row.collectTime, 0));
  if (row.collectTime > 0 && row.collectTime < 1000000000000) {
    row.collectTime *= 1000;
  }
  row.state = Math.max(0, toSafeInt(row.state, row.upgradeTime > 0 ? 1 : 0));
  return row;
}

function buildCollectsArray(info) {
  return Object.keys(ensurePlainObject(info.collectMap))
    .map((key) => ensureCollect(info, key))
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);
}

function ensureHomelandInfo(player) {
  if (!player || typeof player !== 'object') {
    return {
      lv: 1,
      areaLv: 1,
      mapId: getDefaultHomelandMapId(),
      layout: {},
      buildingLv: { [pickDefaultBuildingId()]: 1 },
      collectMap: {},
      fetters: [],
      likeCount: 0,
      dailyLike: [],
      likeRecord: { records: [] },
      msgRecord: { leaveMsg: '', records: [] },
      visitorMap: {},
      wishId: 0,
      unlockClues: {},
      prayBuff: 0,
      prayAttrs: {},
      lastPrayBuff: 0,
      shareLayouts: {},
      shareCode: randomShareCode(),
      prosperityRank: [],
      likeRank: [],
      aquariumFish: [],
      skinId: 0,
      exchangeHistory: [],
      lastVisitorRewardTime: 0,
      enterMapInfo: { map: getDefaultHomelandMapId(), x: 1000, y: 1000, id: '' },
    };
  }

  player.homelandInfo = ensurePlainObject(player.homelandInfo);
  const info = player.homelandInfo;
  info.lv = Math.max(1, toSafeInt(info.lv, 1));
  info.areaLv = Math.max(1, toSafeInt(info.areaLv, 1));
  const defaultMapId = getDefaultHomelandMapId();
  const tileSceneCfg = ensurePlainObject(configService.get('TileSceneConfig'));
  const rawMapId = Math.max(1, toSafeInt(info.mapId, defaultMapId));
  info.mapId = tileSceneCfg[rawMapId] || tileSceneCfg[String(rawMapId)] ? rawMapId : defaultMapId;
  info.layout = normalizeHomelandLayout(info.layout);
  info.buildingLv = ensurePlainObject(info.buildingLv);
  info.collectMap = ensurePlainObject(info.collectMap);
  info.fetters = ensureArray(info.fetters)
    .map((row) => Math.max(0, toSafeInt(row, 0)))
    .filter((row) => row > 0);
  info.likeCount = Math.max(0, toSafeInt(info.likeCount, 0));
  info.dailyLike = ensureArray(info.dailyLike).map((row) => String(row));
  info.aquariumFish = ensureArray(info.aquariumFish).map((row) => ensurePlainObject(row));
  info.skinId = Math.max(0, toSafeInt(info.skinId, 0));
  info.likeRecord = ensurePlainObject(info.likeRecord, { records: [] });
  info.likeRecord.records = ensureArray(info.likeRecord.records);
  info.msgRecord = ensurePlainObject(info.msgRecord, { leaveMsg: '', records: [] });
  info.msgRecord.leaveMsg = info.msgRecord.leaveMsg == null ? '' : String(info.msgRecord.leaveMsg);
  info.msgRecord.records = ensureArray(info.msgRecord.records);
  info.visitorMap = ensurePlainObject(info.visitorMap);
  info.wishId = Math.max(0, toSafeInt(info.wishId, 0));
  info.unlockClues = ensurePlainObject(info.unlockClues);
  info.prayBuff = Math.max(0, toSafeInt(info.prayBuff, 0));
  info.prayAttrs = ensurePlainObject(info.prayAttrs);
  info.lastPrayBuff = Math.max(0, toSafeInt(info.lastPrayBuff, 0));
  info.shareLayouts = ensurePlainObject(info.shareLayouts);
  info.shareCode = info.shareCode ? String(info.shareCode) : randomShareCode();
  info.prosperityRank = ensureArray(info.prosperityRank);
  info.likeRank = ensureArray(info.likeRank);
  info.exchangeHistory = ensureArray(info.exchangeHistory);
  info.lastVisitorRewardTime = Math.max(0, toSafeInt(info.lastVisitorRewardTime, 0));
  info.enterMapInfo = ensurePlainObject(info.enterMapInfo, { map: info.mapId, x: 1000, y: 1000, id: String(player.playerId || '') });
  const rawEnterMap = Math.max(1, toSafeInt(info.enterMapInfo.map, info.mapId));
  info.enterMapInfo.map = tileSceneCfg[rawEnterMap] || tileSceneCfg[String(rawEnterMap)] ? rawEnterMap : info.mapId;
  info.enterMapInfo.x = Math.max(0, toSafeInt(info.enterMapInfo.x, 1000));
  info.enterMapInfo.y = Math.max(0, toSafeInt(info.enterMapInfo.y, 1000));
  info.enterMapInfo.id = info.enterMapInfo.id == null ? String(player.playerId || '') : String(info.enterMapInfo.id);

  Object.keys(info.buildingLv).forEach((key) => {
    if (!isClientHomelandBuildingId(key)) delete info.buildingLv[key];
  });
  Object.keys(info.collectMap).forEach((key) => {
    if (!isClientHomelandBuildingId(key)) delete info.collectMap[key];
  });
  if (Object.keys(info.buildingLv).length === 0) {
    info.buildingLv[String(pickDefaultBuildingId())] = 1;
  }
  const buildingCfg = getHomelandBuildingConfigMap();
  Object.keys(buildingCfg).forEach((key) => {
    const row = ensurePlainObject(buildingCfg[key]);
    const id = Math.max(0, toSafeInt(row.id != null ? row.id : key, 0));
    const type = Math.max(0, toSafeInt(row.type, 0));
    if (id <= 0 || type === 3 || toSafeInt(row.spBuildingInit, 0) !== 1 || toSafeInt(row.isShow, 1) === 0) return;
    if (!Object.prototype.hasOwnProperty.call(info.buildingLv, String(id))) {
      info.buildingLv[String(id)] = 1;
    }
  });
  Object.keys(info.buildingLv).forEach((key) => {
    info.buildingLv[key] = Math.max(0, toSafeInt(info.buildingLv[key], 0));
    ensureCollect(info, key);
  });

  if (info.prosperityRank.length === 0) {
    for (let i = 1; i <= 20; i++) {
      info.prosperityRank.push({
        rank: i,
        playerId: i === 1 ? String(player.playerId || '') : `hl_rank_${i}`,
        name: i === 1 ? player.name || 'self' : `��԰����${i}`,
        value: Math.max(1, 1200 - i * 25),
        serverId: 1,
      });
    }
  }

  if (info.likeRank.length === 0) {
    for (let i = 1; i <= 20; i++) {
      info.likeRank.push({
        rank: i,
        playerId: i === 1 ? String(player.playerId || '') : `hl_like_${i}`,
        name: i === 1 ? player.name || 'self' : `������԰${i}`,
        value: Math.max(1, 300 - i * 5),
        serverId: 1,
      });
    }
  }

  return info;
}

function buildHomelandSummary(player, info) {
  return {
    dbid: String(player.playerId || ''),
    playerId: String(player.playerId || ''),
    name: player.name || '',
    level: Math.max(1, toSafeInt(player.level, 1)),
    avatar: Math.max(0, toSafeInt(player.avatar, 11300)),
    avatarFrame: Math.max(-1, toSafeInt(player.avatarFrame, -1)),
    title: Math.max(0, toSafeInt(player.title, 0)),
    serverId: 1,
    serverName: '',
    lv: info.lv,
    areaLv: info.areaLv,
    mapId: info.mapId,
    likeCount: info.likeCount,
  };
}

function buildHomelandMapEnterPacket(player, info, msgUid = 0) {
  return {
    tag: 6720,
    msgUid,
    data: {
      // Client compares this field with mapSceneData.playerId, not TileScene mapId.
      mapId: String(player.playerId || ''),
      id: String(player.playerId || ''),
      x: Math.max(0, toSafeInt(info.enterMapInfo && info.enterMapInfo.x, 1000)),
      y: Math.max(0, toSafeInt(info.enterMapInfo && info.enterMapInfo.y, 1000)),
      players: [],
    },
  };
}

function buildHomelandInitPayload(info = {}) {
  return {
    ...info,
    collects: buildCollectsArray(info),
    likeRecord: {
      records: ensureArray(info.likeRecord && info.likeRecord.records),
    },
    msgRecord: {
      leaveMsg: info.msgRecord && info.msgRecord.leaveMsg != null ? String(info.msgRecord.leaveMsg) : '',
      records: ensureArray(info.msgRecord && info.msgRecord.records),
    },
  };
}

async function handleHomelandActivateBuilding(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6700, msgUid, data: { result: -1, ids: [] } };

  const info = ensureHomelandInfo(player);
  const ids = ensureArray(params && params.ids)
    .map((row) => Math.max(1, toSafeInt(row, 0)))
    .filter((row) => isClientHomelandBuildingId(row));
  const unlocked = [];
  ids.forEach((id) => {
    const key = String(id);
    if (!Object.prototype.hasOwnProperty.call(info.buildingLv, key)) {
      info.buildingLv[key] = 0;
      ensureCollect(info, key);
      unlocked.push(id);
    }
  });

  await playerService.savePlayer(session.userId, player);
  return { tag: 6700, msgUid, data: { result: 0, ids: unlocked } };
}

async function handleHomelandUpgradeBuilding(params, session, msgUid) {
  const player = session.player;
  const emptyResponse = (result, upgradeTime = 0) => ({
    tag: 6701,
    msgUid,
    data: {
      result,
      upgradeTime,
      exchangeItems: [],
      rewardInfo: buildRewardInfo([]),
    },
  });
  if (!player) return emptyResponse(-1);

  const info = ensureHomelandInfo(player);
  const id = Math.max(0, toSafeInt(params && params.id, 0));
  if (!isClientHomelandBuildingId(id)) return emptyResponse(1);
  const key = String(id);
  if (!Object.prototype.hasOwnProperty.call(info.buildingLv, key)) return emptyResponse(1);
  const buildingCfg = getConfigRow('HomelandBuildingConfig', id);
  if (!buildingCfg) return emptyResponse(1);
  const currentLevel = Math.max(0, toSafeInt(info.buildingLv[key], 0));
  const collect = ensureCollect(info, id);
  const buildingType = Math.max(0, toSafeInt(buildingCfg.type, 0));
  let upgradeTime = 0;
  let exchangeItems = [];
  let exchangeRewards = [];

  if (buildingType === 3) {
    const levelCfg = getNestedConfigRow('HomelandBuildingLevelConfig', buildingCfg.qualityId, currentLevel);
    const nextLevelCfg = getNestedConfigRow('HomelandBuildingLevelConfig', buildingCfg.qualityId, currentLevel + 1);
    if (!levelCfg || !nextLevelCfg) return emptyResponse(2);
    const upgrade = buildNormalBuildingUpgradeCost(player, buildingCfg, levelCfg);
    if (!consumeCostRows(player, upgrade.costs)) return emptyResponse(3);
    info.buildingLv[key] = currentLevel + 1;
    collect.state = 0;
    collect.upgradeTime = 0;
    exchangeItems = upgrade.exchangeItems;
    exchangeRewards = upgrade.exchangeRewards;
  } else if (buildingType === 2) {
    const resourceCfg = getNestedConfigRow('HomelandBuildngResourceConfig', id, currentLevel);
    const nextResourceCfg = getNestedConfigRow('HomelandBuildngResourceConfig', id, currentLevel + 1);
    const homelandLevelCfg = getConfigRow('HomelandLevelConfig', info.lv);
    const levelCap = Math.max(0, toSafeInt(homelandLevelCfg && homelandLevelCfg.buildingLevelMax, 0));
    if (!resourceCfg || !nextResourceCfg || ensureArray(resourceCfg.consumes).length === 0) return emptyResponse(2);
    if (levelCap > 0 && currentLevel >= levelCap) return emptyResponse(4);
    if (collect.upgradeTime > Date.now()) return emptyResponse(5, collect.upgradeTime);
    const activeWorkers = buildCollectsArray(info).filter((row) => row.upgradeTime > Date.now()).length;
    const availableWorkers = getItemOrCurrencyCount(player, 226) + 1;
    if (activeWorkers >= availableWorkers) return emptyResponse(6);
    if (!consumeCostRows(player, resourceCfg.consumes)) return emptyResponse(3);
    const durationMs = Math.max(1, toSafeInt(resourceCfg.levelUpTime, 0)) * 1000;
    collect.state = 1;
    collect.upgradeTime = Date.now() + durationMs;
    upgradeTime = collect.upgradeTime;
  } else {
    return emptyResponse(2);
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6701,
    msgUid,
    data: {
      result: 0,
      upgradeTime,
      exchangeItems,
      rewardInfo: buildRewardInfo(exchangeRewards),
    },
  };
}

async function handleHomelandCheckUpgradeBuilding(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6702, msgUid, data: { result: -1, collects: [] } };

  const info = ensureHomelandInfo(player);
  const nowMs = Date.now();
  const collects = [];

  Object.keys(info.collectMap).forEach((key) => {
    const row = ensureCollect(info, key);
    if (row.state === 1 && row.upgradeTime > 0 && row.upgradeTime <= nowMs) {
      row.state = 0;
      row.upgradeTime = 0;
      row.count += 1;
      info.buildingLv[String(row.id)] = Math.max(0, toSafeInt(info.buildingLv[String(row.id)], 0) + 1);
      collects.push({ ...row });
    }
  });

  await playerService.savePlayer(session.userId, player);
  return { tag: 6702, msgUid, data: { result: 0, collects } };
}

async function handleHomelandCollect(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6703, msgUid, data: { result: -1, collects: [], reward: [] } };

  const info = ensureHomelandInfo(player);
  const id = normalizeHomelandBuildingId(params && params.id);
  const collect = ensureCollect(info, id);
  collect.count += 1;
  const reward = normalizeRewards([
    { id: 2, count: 100 + id % 10 * 10 },
    { id: 71, count: 5 + (collect.count % 3) },
  ]);
  reward.forEach((row) => addRewardToPlayer(player, row.id, row.count));

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6703,
    msgUid,
    data: {
      result: 0,
      collects: buildCollectsArray(info),
      reward,
    },
  };
}

async function handleHomelandLevelUp(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6704, msgUid, data: { result: -1, lv: 1 } };

  const info = ensureHomelandInfo(player);
  info.lv += 1;

  await playerService.savePlayer(session.userId, player);
  return { tag: 6704, msgUid, data: { result: 0, lv: info.lv } };
}

async function handleHomelandBuildingSpeedUp(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6705, msgUid, data: { result: -1 } };

  const info = ensureHomelandInfo(player);
  const id = normalizeHomelandBuildingId(params && params.id);
  const count = Math.max(1, toSafeInt(params && params.count, 1));
  const collect = ensureCollect(info, id);
  const nowMs = Date.now();

  if (collect.state === 1) {
    collect.upgradeTime = Math.max(nowMs, collect.upgradeTime - count * 5 * 60 * 1000);
    if (collect.upgradeTime <= nowMs) {
      collect.state = 0;
      collect.upgradeTime = 0;
      collect.count += 1;
      info.buildingLv[String(collect.id)] = Math.max(0, toSafeInt(info.buildingLv[String(collect.id)], 0) + 1);
    }
  }

  const updateInfo = collect.upgradeTime <= 0 ? { collects: [collect] } : null;

  await playerService.savePlayer(session.userId, player);
  return { tag: 6705, msgUid, data: { result: 0, updateInfo } };
}

async function handleHomelandBuildingSpeedUpAssist(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6706, msgUid, data: { result: -1 } };

  const info = ensureHomelandInfo(player);
  const id = normalizeHomelandBuildingId(params && params.id);
  const collect = ensureCollect(info, id);
  if (collect.state === 1) {
    collect.upgradeTime = Math.max(0, collect.upgradeTime - 20 * 1000);
  }

  await playerService.savePlayer(session.userId, player);
  return { tag: 6706, msgUid, data: { result: 0 } };
}

async function handleHomelandPayTribute(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6707, msgUid, data: { result: -1 } };

  const free = Math.max(0, toSafeInt(params && params.free, 0));
  const reward = { id: 1, count: free ? 10 : 30 };
  const rewardInfo = grantRewardInfo(player, [reward, { id: 2, count: free ? 200 : 500 }]);

  await playerService.savePlayer(session.userId, player);
  return { tag: 6707, msgUid, data: { result: 0, reward, rewardInfo } };
}

async function handleHomelandDraw(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6708, msgUid, data: { result: -1 } };

  const count = Math.max(1, toSafeInt(params && params.count, 1));
  const rewardInfo = grantRewardInfo(player, [
    { id: 71, count: count * 3 },
    { id: 2, count: count * 120 },
  ]);

  await playerService.savePlayer(session.userId, player);
  const rewards = ensureArray(rewardInfo.items).map((row) => ({
    id: Math.max(0, toSafeInt(row && row.id, 0)),
    count: Math.max(0, toSafeInt(row && row.count, 0)),
  })).filter((row) => row.id > 0 && row.count > 0);
  return {
    tag: 6708,
    msgUid,
    data: {
      result: 0,
      count,
      free: Math.max(0, toSafeInt(params && params.free, 0)),
      luck: Math.max(0, toSafeInt(params && params.luck, 0)),
      rewards,
      extraRewards: [],
      rewardInfo,
    },
  };
}

async function handleHomelandActivateResonance(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6709, msgUid, data: { result: -1, ids: [] } };

  const info = ensureHomelandInfo(player);
  const ids = ensureArray(params && params.ids)
    .map((row) => Math.max(1, toSafeInt(row, 0)))
    .filter((row) => row > 0);
  ids.forEach((id) => {
    if (!info.fetters.includes(id)) {
      info.fetters.push(id);
    }
  });
  info.fetters.sort((a, b) => a - b);
  const rewardInfo = grantRewardInfo(player, [{ id: 1, count: ids.length * 5 }]);

  await playerService.savePlayer(session.userId, player);
  return { tag: 6709, msgUid, data: { result: 0, ids, rewardInfo } };
}

async function handleHomelandSyncLayout(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6710, msgUid, data: { result: -1 } };

  const info = ensureHomelandInfo(player);
  info.layout = normalizeHomelandLayout(params && params.layout);

  await playerService.savePlayer(session.userId, player);
  return { tag: 6710, msgUid, data: { result: 0 } };
}

async function handleHomelandLike(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6711, msgUid, data: { result: -1 } };

  const info = ensureHomelandInfo(player);
  const playerId = params && params.playerId != null ? String(params.playerId) : '';
  if (playerId && !info.dailyLike.includes(playerId)) {
    info.dailyLike.push(playerId);
    info.likeCount += 1;
  }
  const rewardInfo = grantRewardInfo(player, [{ id: 2, count: 100 }]);

  info.likeRecord.records.push({
    playerId,
    name: `�ÿ�${playerId.slice(-4)}`,
    time: Date.now(),
  });
  if (info.likeRecord.records.length > 100) {
    info.likeRecord.records = info.likeRecord.records.slice(info.likeRecord.records.length - 100);
  }

  await playerService.savePlayer(session.userId, player);
  return { tag: 6711, msgUid, data: { result: 0, rewardInfo } };
}

async function handleHomelandGetLikeRecord(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6712, msgUid, data: { result: -1, likeCount: 0, records: [] } };

  const info = ensureHomelandInfo(player);
  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 6712,
    msgUid,
    data: {
      result: 0,
      likeCount: info.likeCount,
      records: ensureArray(info.likeRecord.records),
    },
  };
  return [
    { tag: 6700, msgUid: 0, data: buildHomelandInitPayload(info) },
    response,
  ];
}

async function handleHomelandGetMsgRecord(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6713, msgUid, data: { result: -1, leaveMsg: '', records: [] } };

  const info = ensureHomelandInfo(player);
  return {
    tag: 6713,
    msgUid,
    data: {
      result: 0,
      leaveMsg: info.msgRecord.leaveMsg,
      records: ensureArray(info.msgRecord.records),
    },
  };
}

async function handleHomelandAddOtherMsg(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6714, msgUid, data: { result: -1 } };

  const info = ensureHomelandInfo(player);
  const record = {
    uid: String(Date.now()),
    playerId: params && params.playerId != null ? String(params.playerId) : String(player.playerId || ''),
    content: params && params.content != null ? String(params.content) : '',
    time: Date.now(),
  };
  info.msgRecord.records.push(record);
  if (info.msgRecord.records.length > 100) {
    info.msgRecord.records = info.msgRecord.records.slice(info.msgRecord.records.length - 100);
  }

  await playerService.savePlayer(session.userId, player);
  return { tag: 6714, msgUid, data: { result: 0, record } };
}

async function handleHomelandRemoveOtherMsg(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6715, msgUid, data: { result: -1 } };

  const info = ensureHomelandInfo(player);
  const uid = params && params.uid != null ? String(params.uid) : '';
  info.msgRecord.records = ensureArray(info.msgRecord.records).filter((row) => String(row && row.uid ? row.uid : '') !== uid);

  await playerService.savePlayer(session.userId, player);
  return { tag: 6715, msgUid, data: { result: 0 } };
}

async function handleHomelandRemoveMsgRecord(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6716, msgUid, data: { result: -1 } };

  const info = ensureHomelandInfo(player);
  const uid = params && params.uid != null ? String(params.uid) : '';
  info.msgRecord.records = ensureArray(info.msgRecord.records).filter((row) => String(row && row.uid ? row.uid : '') !== uid);

  await playerService.savePlayer(session.userId, player);
  return { tag: 6716, msgUid, data: { result: 0 } };
}

async function handleHomelandChangeMsg(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6717, msgUid, data: { result: -1 } };

  const info = ensureHomelandInfo(player);
  info.msgRecord.leaveMsg = params && params.content != null ? String(params.content) : '';

  await playerService.savePlayer(session.userId, player);
  return { tag: 6717, msgUid, data: { result: 0 } };
}

async function handleHomelandPray(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6718, msgUid, data: { result: -1, prayBuff: 0, prayAttrs: {} } };

  const info = ensureHomelandInfo(player);
  const free = Math.max(0, toSafeInt(params && params.free, 1));
  info.prayBuff = free ? 1001 : 1002;
  info.prayAttrs = {
    atkPer: free ? 50 : 100,
    hpPer: free ? 80 : 150,
  };
  info.lastPrayBuff = 0;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6718,
    msgUid,
    data: {
      result: 0,
      prayBuff: info.prayBuff,
      prayAttrs: info.prayAttrs,
    },
  };
}

async function handleHomelandKeepPray(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 6719,
      msgUid,
      data: { result: -1, prayBuff: 0, prayAttrs: {}, rewards: buildRewardInfo([]) },
    };
  }

  const info = ensureHomelandInfo(player);
  const prayBuff = Math.max(0, toSafeInt(params && params.prayBuff, info.prayBuff || 1001));
  info.prayBuff = prayBuff;
  info.prayAttrs = {
    atkPer: prayBuff % 2 === 0 ? 120 : 80,
    hpPer: prayBuff % 2 === 0 ? 180 : 120,
  };
  info.lastPrayBuff = 0;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6719,
    msgUid,
    data: {
      result: 0,
      prayBuff: info.prayBuff,
      prayAttrs: info.prayAttrs,
      rewards: buildRewardInfo([]),
    },
  };
}

async function handleHomelandGetProsperityRankInfo(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6720, msgUid, data: { result: -1, rankList: [] } };

  const info = ensureHomelandInfo(player);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6720,
    msgUid,
    data: {
      result: 0,
      rankList: ensureArray(info.prosperityRank),
    },
  };
}

async function handleHomelandGetLikeRankInfo(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6721, msgUid, data: { result: -1, rankList: [] } };

  const info = ensureHomelandInfo(player);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6721,
    msgUid,
    data: {
      result: 0,
      rankList: ensureArray(info.likeRank),
    },
  };
}

async function handleHomelandShareLayout(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6722, msgUid, data: { result: -1, code: '' } };

  const info = ensureHomelandInfo(player);
  info.shareCode = randomShareCode();
  info.shareLayouts[info.shareCode] = {
    mapId: info.mapId,
    layout: info.layout,
    buildingLv: info.buildingLv,
  };

  await playerService.savePlayer(session.userId, player);
  return { tag: 6722, msgUid, data: { result: 0, code: info.shareCode } };
}

async function handleHomelandAreaUpgrade(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6723, msgUid, data: { result: -1, areaLv: 1 } };

  const info = ensureHomelandInfo(player);
  const areaLv = Math.max(1, toSafeInt(params && params.areaLv, info.areaLv + 1));
  info.areaLv = Math.max(info.areaLv, areaLv);

  await playerService.savePlayer(session.userId, player);
  return { tag: 6723, msgUid, data: { result: 0, areaLv: info.areaLv } };
}

async function handleHomelandBuildingAllLevelUp(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6724, msgUid, data: { result: -1, upgradeLv: {} } };

  const info = ensureHomelandInfo(player);
  const upgradeLv = {};
  Object.keys(info.buildingLv).forEach((key) => {
    info.buildingLv[key] = Math.max(0, toSafeInt(info.buildingLv[key], 0) + 1);
    upgradeLv[key] = info.buildingLv[key];
  });

  const rewardInfo = grantRewardInfo(player, [{ id: 2, count: 500 }, { id: 71, count: 20 }]);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6724,
    msgUid,
    data: {
      result: 0,
      upgradeLv,
      exchangeItems: [],
      rewardInfo,
    },
  };
}

async function handleHomelandStartExchange(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6725, msgUid, data: { result: -1 } };

  const info = ensureHomelandInfo(player);
  const itemId = Math.max(0, toSafeInt(params && params.itemId, 0));
  const exchanges = ensureArray(params && params.exchanges)
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .filter((id) => id > 0);
  const guild = require('./guild');
  const created = guild.createGuildExchangeRequest(player, session, itemId, exchanges);
  if (!created) return { tag: 6725, msgUid, data: { result: 1 } };

  info.exchangeHistory.push({ itemId, exchanges, uid: created.exchange.uid, time: Date.now() });
  if (info.exchangeHistory.length > 100) {
    info.exchangeHistory = info.exchangeHistory.slice(info.exchangeHistory.length - 100);
  }

  await playerService.savePlayer(session.userId, player);
  const packets = [{ tag: 6725, msgUid, data: { result: 0 } }];
  if (created.removedUids.length > 0) {
    packets.push({ tag: 1521, msgUid: 0, data: { uids: created.removedUids } });
  }
  packets.push({ tag: 1520, msgUid: 0, data: { exchange: created.exchange } });
  return packets;
}

async function handleHomelandVisitorReward(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6726, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };

  const info = ensureHomelandInfo(player);
  Object.keys(info.visitorMap).forEach((key) => {
    info.visitorMap[key] = [];
  });
  info.lastVisitorRewardTime = Date.now();
  const rewardInfo = grantRewardInfo(player, [{ id: 2, count: 300 }, { id: 71, count: 10 }]);

  await playerService.savePlayer(session.userId, player);
  return { tag: 6726, msgUid, data: { result: 0, rewardInfo } };
}

async function handleHomelandSelectClueWish(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6727, msgUid, data: { result: -1, id: 0 } };

  const info = ensureHomelandInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, 1));
  info.wishId = id;

  await playerService.savePlayer(session.userId, player);
  return { tag: 6727, msgUid, data: { result: 0, id } };
}

async function handleHomelandUnlockClue(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6728, msgUid, data: { result: -1 } };

  const info = ensureHomelandInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, 1));
  const index = Math.max(0, toSafeInt(params && params.index, 0));
  info.unlockClues[String(id)] = index;

  const clue = { id, index, name: `����${id}-${index}` };
  const piece = { id: 9900 + id, count: 1 };
  const rewardInfo = grantRewardInfo(player, [{ id: 71, count: 3 }]);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6728,
    msgUid,
    data: {
      result: 0,
      id,
      index,
      clue,
      piece,
      rewardInfo,
    },
  };
}

async function handleHomelandPlayerLayout(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6730, msgUid, data: { lv: 0 } };

  const info = ensureHomelandInfo(player);
  const summary = buildHomelandSummary(player, info);
  const playerId = params && params.playerId != null ? String(params.playerId) : String(player.playerId || '');
  const isSelf = playerId === String(player.playerId || '');

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6730,
    msgUid,
    data: {
      summary,
      lv: info.lv,
      areaLv: info.areaLv,
      mapId: info.mapId,
      layout: info.layout,
      buildingLv: info.buildingLv,
      likeCount: info.likeCount,
      aquariumFish: ensureArray(info.aquariumFish),
      skinId: Math.max(0, toSafeInt(info.skinId, 0)),
      isSelf,
      visitorMap: info.visitorMap,
    },
  };
}

async function handleHomelandGetPlayerMsgRecord(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6731, msgUid, data: { records: [], leaveMsg: '' } };

  const info = ensureHomelandInfo(player);
  const playerId = params && params.playerId != null ? String(params.playerId) : String(player.playerId || '');

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6731,
    msgUid,
    data: {
      playerId,
      leaveMsg: info.msgRecord.leaveMsg,
      records: ensureArray(info.msgRecord.records),
    },
  };
}

async function handleHomelandGetShareLayout(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6732, msgUid, data: { result: -1, layoutData: null } };

  const info = ensureHomelandInfo(player);
  const code = params && params.code != null ? String(params.code).toUpperCase() : '';
  const layoutData = info.shareLayouts[code] || {
    mapId: info.mapId,
    layout: info.layout,
    buildingLv: info.buildingLv,
  };

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6732,
    msgUid,
    data: {
      result: 0,
      code,
      layoutData,
    },
  };
}

async function handleHomelandEnterMap(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6740, msgUid, data: { result: -1 } };

  const info = ensureHomelandInfo(player);
  const tileSceneCfg = ensurePlainObject(configService.get('TileSceneConfig'));
  const requestedMap = Math.max(1, toSafeInt(params && params.map, info.mapId));
  info.enterMapInfo.map = tileSceneCfg[requestedMap] || tileSceneCfg[String(requestedMap)] ? requestedMap : info.mapId;
  info.enterMapInfo.id = String(player.playerId || '');

  await playerService.savePlayer(session.userId, player);
  return [
    buildHomelandMapEnterPacket(player, info, 0),
    {
      tag: 6740,
      msgUid,
      data: {
        result: 0,
        map: info.enterMapInfo.map,
        id: info.enterMapInfo.id,
        x: info.enterMapInfo.x,
        y: info.enterMapInfo.y,
      },
    },
  ];
}

async function handleHomelandLeaveMap(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6741, msgUid, data: { result: -1 } };

  const info = ensureHomelandInfo(player);
  await playerService.savePlayer(session.userId, player);
  return [
    {
      tag: 6722,
      msgUid: 0,
      data: {
        mapId: String(player.playerId || ''),
        id: String(player.playerId || ''),
      },
    },
    { tag: 6741, msgUid, data: { result: 0, map: info.enterMapInfo.map } },
  ];
}

async function handleHomelandMove(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6742, msgUid, data: { result: -1 } };

  const info = ensureHomelandInfo(player);
  info.enterMapInfo.x = Math.max(0, toSafeInt(params && params.x, info.enterMapInfo.x));
  info.enterMapInfo.y = Math.max(0, toSafeInt(params && params.y, info.enterMapInfo.y));

  await playerService.savePlayer(session.userId, player);
  return [
    {
      tag: 6723,
      msgUid: 0,
      data: {
        mapId: String(player.playerId || ''),
        id: String(player.playerId || ''),
        x: info.enterMapInfo.x,
        y: info.enterMapInfo.y,
      },
    },
    {
      tag: 6742,
      msgUid,
      data: {
        result: 0,
        id: String(player.playerId || ''),
        x: info.enterMapInfo.x,
        y: info.enterMapInfo.y,
      },
    },
  ];
}

async function handleHomelandLikeAll(params, session, msgUid) {
  const player = session.player;
  const playerIds = ensureArray(params && params.playerIds).map((id) => String(id)).filter(Boolean);
  if (!player) return { tag: 6729, msgUid, data: { result: playerIds.map(() => -1), rewardInfo: buildRewardInfo([]) } };
  const info = ensureHomelandInfo(player);
  const result = [];
  let newLikes = 0;
  playerIds.forEach((playerId) => {
    if (!info.dailyLike.includes(playerId)) {
      info.dailyLike.push(playerId);
      newLikes += 1;
    }
    result.push(0);
  });
  const rewardInfo = newLikes > 0 ? grantRewardInfo(player, [{ id: 2, count: newLikes * 20 }]) : buildRewardInfo([]);
  await playerService.savePlayer(session.userId, player);
  return { tag: 6729, msgUid, data: { result, rewardInfo } };
}

async function handleAquariumSet(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6750, msgUid, data: { result: -1, list: [] } };
  const info = ensureHomelandInfo(player);
  info.aquariumFish = ensureArray(params && params.list)
    .map((row) => ensurePlainObject(row))
    .map((row) => ({
      uid: Math.max(0, toSafeInt(row.uid, 0)),
      id: Math.max(0, toSafeInt(row.id, 0)),
      x: toSafeInt(row.x, 0),
      y: toSafeInt(row.y, 0),
      dir: Math.max(0, toSafeInt(row.dir, 0)),
    }))
    .filter((row) => row.uid > 0 || row.id > 0);
  await playerService.savePlayer(session.userId, player);
  return { tag: 6750, msgUid, data: { result: 0, list: info.aquariumFish } };
}

async function handleHomelandSwitchSkin(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6751, msgUid, data: { result: -1 } };
  const info = ensureHomelandInfo(player);
  info.skinId = Math.max(0, toSafeInt(params && params.skinId, 0));
  await playerService.savePlayer(session.userId, player);
  return { tag: 6751, msgUid, data: { result: 0, skinId: info.skinId } };
}

module.exports = {
  ensureHomelandInfo,
  handleHomelandActivateBuilding,
  handleHomelandUpgradeBuilding,
  handleHomelandCheckUpgradeBuilding,
  handleHomelandCollect,
  handleHomelandLevelUp,
  handleHomelandBuildingSpeedUp,
  handleHomelandBuildingSpeedUpAssist,
  handleHomelandPayTribute,
  handleHomelandDraw,
  handleHomelandActivateResonance,
  handleHomelandSyncLayout,
  handleHomelandLike,
  handleHomelandGetLikeRecord,
  handleHomelandGetMsgRecord,
  handleHomelandAddOtherMsg,
  handleHomelandRemoveOtherMsg,
  handleHomelandRemoveMsgRecord,
  handleHomelandChangeMsg,
  handleHomelandPray,
  handleHomelandKeepPray,
  handleHomelandGetProsperityRankInfo,
  handleHomelandGetLikeRankInfo,
  handleHomelandShareLayout,
  handleHomelandAreaUpgrade,
  handleHomelandBuildingAllLevelUp,
  handleHomelandStartExchange,
  handleHomelandVisitorReward,
  handleHomelandSelectClueWish,
  handleHomelandUnlockClue,
  handleHomelandPlayerLayout,
  handleHomelandGetPlayerMsgRecord,
  handleHomelandGetShareLayout,
  handleHomelandEnterMap,
  handleHomelandLeaveMap,
  handleHomelandMove,
  handleHomelandLikeAll,
  handleAquariumSet,
  handleHomelandSwitchSkin,
};
