/**
 * Gem system handlers
 * tag: 3901 set, 3902 compose, 3903 auto compose, 3904 exchange,
 *      3905 buy field, 3906 special compose
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const {
  addGemComposeCount,
  addGemObtainCount,
  refreshMainTaskProgress,
} = require('../services/MainTaskProgressService');

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

function getGemBaseConfig() {
  return config.get('GemBaseConfig') || {};
}

function getGemLevelConfig() {
  return config.get('GemLevelConfig') || {};
}

function getGemComposeConfig() {
  return config.get('GemComposeConfig') || {};
}

function getGemShapeConfig() {
  return config.get('GemShapeConfig') || {};
}

function getGemLevelById(gemId) {
  const row = getGemLevelConfig()[toSafeInt(gemId, 0)];
  return Math.max(1, toSafeInt(row && row.level, 1));
}

function getNextGemId(gemId) {
  const cfg = getGemLevelConfig();
  const id = toSafeInt(gemId, 0);
  const row = cfg[id] || cfg[String(id)];
  if (!row) return id || getFallbackGemId();

  const targetLevel = toSafeInt(row.synthesisLevel, 0);
  const type = toSafeInt(row.type, 0);
  if (targetLevel <= 0 || type <= 0) return id;

  const nextId = Object.keys(cfg)
    .map((key) => toSafeInt(key, 0))
    .filter((candidateId) => {
      const candidate = cfg[candidateId] || cfg[String(candidateId)];
      return candidate
        && toSafeInt(candidate.type, 0) === type
        && toSafeInt(candidate.level, 0) === targetLevel;
    })
    .sort((a, b) => a - b)[0];

  return nextId || id;
}

function getGemLevelRow(gemId) {
  const cfg = getGemLevelConfig();
  const id = toSafeInt(gemId, 0);
  return cfg[id] || cfg[String(id)] || null;
}

function getNormalComposeNeed(gemId) {
  const row = getGemLevelRow(gemId);
  const nextId = getNextGemId(gemId);
  if (!row || nextId === toSafeInt(gemId, 0)) return 0;
  if (toSafeInt(row.synthesisLevel, 0) <= 0) return 0;
  return Math.max(2, toSafeInt(row.synthesisValue, 3));
}

function pickShapeIdByLevel(level) {
  const shapeCfg = getGemShapeConfig();
  const targetLevel = Math.max(1, toSafeInt(level, 1));
  const candidates = Object.keys(shapeCfg)
    .map((k) => toSafeInt(k, 0))
    .filter((id) => toSafeInt(shapeCfg[id] && shapeCfg[id].level, 0) === targetLevel)
    .sort((a, b) => a - b);
  if (candidates.length > 0) return candidates[0];

  const all = Object.keys(shapeCfg).map((k) => toSafeInt(k, 0)).filter((id) => id > 0).sort((a, b) => a - b);
  return all.length > 0 ? all[0] : 1;
}

function getFallbackGemId() {
  const gemCfg = getGemLevelConfig();
  const ids = Object.keys(gemCfg).map((k) => toSafeInt(k, 0)).filter((id) => id > 0).sort((a, b) => a - b);
  return ids.length > 0 ? ids[0] : 25001;
}

function hasGemLevelConfig(gemId) {
  const cfg = getGemLevelConfig();
  return !!cfg[toSafeInt(gemId, 0)];
}

function hasGemShapeConfig(shapeId) {
  const cfg = getGemShapeConfig();
  return !!cfg[toSafeInt(shapeId, 0)];
}

function getStarterGemRows() {
  // Captured login payloads show the soul-gem system starts with these three gems.
  return [
    { uid: 1, id: 25002, shapeId: 19 },
    { uid: 2, id: 25003, shapeId: 33 },
    { uid: 3, id: 25003, shapeId: 19 },
  ];
}

function normalizeGem(raw, info) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const fallbackId = getFallbackGemId();
  const rawId = toSafeInt(row.id, fallbackId);
  const id = hasGemLevelConfig(rawId) ? rawId : fallbackId;
  const uidRaw = toSafeInt(row.uid, 0);
  const uid = uidRaw > 0 ? uidRaw : toSafeInt(info.nextUid, 1);
  if (uid >= toSafeInt(info.nextUid, 1)) info.nextUid = uid + 1;

  const level = getGemLevelById(id);
  return {
    uid,
    id,
    shapeId: hasGemShapeConfig(row.shapeId)
      ? Math.max(1, toSafeInt(row.shapeId, pickShapeIdByLevel(level)))
      : pickShapeIdByLevel(level),
  };
}

function ensureGemInfo(player) {
  player.other_attr_info = player.other_attr_info && typeof player.other_attr_info === 'object' && !Array.isArray(player.other_attr_info)
    ? player.other_attr_info
    : {};

  const legacyGemInfo = player.gemInfo && typeof player.gemInfo === 'object' && !Array.isArray(player.gemInfo)
    ? player.gemInfo
    : null;

  const holder = player.other_attr_info;
  holder.gemInfo = holder.gemInfo && typeof holder.gemInfo === 'object' && !Array.isArray(holder.gemInfo)
    ? holder.gemInfo
    : (legacyGemInfo ? { ...legacyGemInfo } : {});

  if (legacyGemInfo) delete player.gemInfo;

  const info = holder.gemInfo;
  if (!info.plan || typeof info.plan !== 'object' || Array.isArray(info.plan)) info.plan = {};
  if (!Array.isArray(info.plan.positions)) info.plan.positions = [];
  if (info.plan.id == null) info.plan.id = 0;
  if (!Array.isArray(info.gems)) info.gems = [];
  if (info.exchangeTimes == null) info.exchangeTimes = 0;

  const baseCfg = getGemBaseConfig();
  const initialField = Math.max(1, toSafeInt(baseCfg.initialField, 30));
  const fieldMax = Math.max(initialField, toSafeInt(baseCfg.fieldMax, initialField));
  if (info.fieldCount == null) info.fieldCount = initialField;
  info.fieldCount = Math.max(initialField, Math.min(fieldMax, toSafeInt(info.fieldCount, initialField)));

  const maxUid = info.gems.reduce((max, row) => Math.max(max, toSafeInt(row && row.uid, 0)), 0);
  if (toSafeInt(info.nextUid, 0) <= maxUid) info.nextUid = maxUid + 1;
  if (toSafeInt(info.nextUid, 0) <= 0) info.nextUid = 1;

  if (info.gems.length === 0) {
    info.gems = getStarterGemRows().map((row) => ({ ...row }));
    info.nextUid = Math.max(info.nextUid, 4);
  }

  info.gems = info.gems.map((row) => normalizeGem(row, info));

  const gemUidSet = new Set(info.gems.map((gem) => toSafeInt(gem.uid, 0)));
  info.plan.positions = info.plan.positions
    .map((row) => ({
      uid: toSafeInt(row && row.uid, 0),
      row: Math.max(0, toSafeInt(row && row.row, 0)),
      col: Math.max(0, toSafeInt(row && row.col, 0)),
    }))
    .filter((row, idx, arr) => row.uid > 0 && gemUidSet.has(row.uid) && arr.findIndex((r) => r.uid === row.uid) === idx);

  info.exchangeTimes = Math.max(0, toSafeInt(info.exchangeTimes, 0));
  info.plan.id = Math.max(0, toSafeInt(info.plan.id, 0));
  return info;
}

function findGemByUid(info, uid) {
  const target = toSafeInt(uid, 0);
  return info.gems.find((row) => toSafeInt(row && row.uid, 0) === target) || null;
}

function removeGemByUid(info, uid) {
  const target = toSafeInt(uid, 0);
  info.gems = info.gems.filter((row) => toSafeInt(row && row.uid, 0) !== target);
  info.plan.positions = info.plan.positions.filter((row) => toSafeInt(row && row.uid, 0) !== target);
}

function isGemPlaced(info, uid) {
  const target = toSafeInt(uid, 0);
  return info.plan.positions.some((row) => toSafeInt(row && row.uid, 0) === target);
}

function takeUnplacedGemUidsById(info, gemId, count) {
  const id = toSafeInt(gemId, 0);
  const need = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || need <= 0) return [];
  return info.gems
    .filter((gem) => toSafeInt(gem && gem.id, 0) === id && !isGemPlaced(info, gem && gem.uid))
    .map((gem) => toSafeInt(gem.uid, 0))
    .filter((uid) => uid > 0)
    .slice(0, need);
}

function addGem(info, gemId, customUid = 0) {
  const id = toSafeInt(gemId, getFallbackGemId());
  const level = getGemLevelById(id);
  const uid = toSafeInt(customUid, 0) > 0 ? toSafeInt(customUid, 0) : toSafeInt(info.nextUid, 1);
  if (uid >= toSafeInt(info.nextUid, 1)) info.nextUid = uid + 1;

  const gem = { uid, id, shapeId: pickShapeIdByLevel(level) };
  info.gems.push(gem);
  return gem;
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

function pickGemIdByType(type) {
  const targetType = toSafeInt(type, 0);
  const cfg = getGemLevelConfig();
  const candidates = Object.keys(cfg)
    .map((k) => toSafeInt(k, 0))
    .filter((id) => toSafeInt(cfg[id] && cfg[id].type, 0) === targetType)
    .sort((a, b) => toSafeInt(cfg[b] && cfg[b].level, 0) - toSafeInt(cfg[a] && cfg[a].level, 0) || a - b);
  if (candidates.length > 0) return candidates[0];
  return getFallbackGemId();
}

// set / unset gem placement (tag:3901)
async function handleGemSet(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3901, msgUid, data: { result: -1 } };

  const info = ensureGemInfo(player);
  const uid = Math.max(1, toSafeInt(params && params.uid, 1));
  const row = Math.max(0, toSafeInt(params && params.row, 0));
  const col = Math.max(0, toSafeInt(params && params.col, 0));
  const set = !!(params && (params.set === true || toSafeInt(params.set, 0) > 0));
  const planId = Math.max(0, toSafeInt(params && params.id, info.plan.id || 0));
  info.plan.id = planId;

  const gem = findGemByUid(info, uid);
  if (!gem) {
    return {
      tag: 3901,
      msgUid,
      data: {
        result: -1,
        id: planId,
        uid,
      },
    };
  }

  if (set) {
    info.plan.positions = info.plan.positions.filter((pos) => !(pos.row === row && pos.col === col && pos.uid !== uid));
    const idx = info.plan.positions.findIndex((pos) => pos.uid === uid);
    const nextPos = { uid, row, col };
    if (idx >= 0) info.plan.positions[idx] = nextPos;
    else info.plan.positions.push(nextPos);
  } else {
    info.plan.positions = info.plan.positions.filter((pos) => pos.uid !== uid);
  }

  const taskChanged = !!refreshMainTaskProgress(player);
  await playerService.savePlayer(session.userId, player);
  const response = {
    tag: 3901,
    msgUid,
    data: {
      result: 0,
      id: gem.id,
      uid: gem.uid,
      shapeId: gem.shapeId,
    },
  };
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

// compose selected gems (tag:3902)
async function handleGemCompose(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3902, msgUid, data: { uids: [], gems: [] } };

  const info = ensureGemInfo(player);
  const uidList = Array.isArray(params && params.uids) ? params.uids : [];
  const uids = uidList.map((v) => toSafeInt(v, 0)).filter((v, idx, arr) => v > 0 && arr.indexOf(v) === idx);
  if (uids.length === 0) return { tag: 3902, msgUid, data: { uids: [], gems: [] } };

  const selected = uids.map((uid) => findGemByUid(info, uid)).filter(Boolean);
  if (selected.length !== uids.length || selected.some((gem) => isGemPlaced(info, gem.uid))) {
    return { tag: 3902, msgUid, data: { uids: [], gems: [] } };
  }

  const gemId = toSafeInt(selected[0] && selected[0].id, 0);
  if (selected.some((gem) => toSafeInt(gem.id, 0) !== gemId)) {
    return { tag: 3902, msgUid, data: { uids: [], gems: [] } };
  }

  const need = getNormalComposeNeed(gemId);
  const composeCount = need > 0 ? Math.floor(selected.length / need) : 0;
  if (composeCount <= 0) return { tag: 3902, msgUid, data: { uids: [], gems: [] } };

  const consumed = uids.slice(0, composeCount * need);
  const nextId = getNextGemId(gemId);
  consumed.forEach((uid) => removeGemByUid(info, uid));
  const gems = [];
  for (let i = 0; i < composeCount; i += 1) gems.push(addGem(info, nextId));

  const obtainTaskChanged = !!addGemObtainCount(player, gems.length);
  const composeTaskChanged = !!addGemComposeCount(player, gems.length);
  const taskChanged = obtainTaskChanged || composeTaskChanged;
  await playerService.savePlayer(session.userId, player);
  const response = { tag: 3902, msgUid, data: { uids: consumed, gems } };
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

// auto compose (tag:3903)
async function handleGemAutoCompose(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3903, msgUid, data: { costs: [], gems: [] } };

  const info = ensureGemInfo(player);
  const baseCfg = getGemBaseConfig();
  const maxQuickLevel = Math.max(1, toSafeInt(baseCfg.maxQuickLevel, 6));
  const levelLimit = Math.max(1, Math.min(maxQuickLevel, toSafeInt(params && params.level, maxQuickLevel)));
  const levelCfg = getGemLevelConfig();
  const costs = [];
  const gems = [];
  let changed = true;

  while (changed) {
    changed = false;
    const groupMap = new Map();
    info.gems.forEach((gem) => {
      const id = toSafeInt(gem && gem.id, 0);
      const row = levelCfg[id] || levelCfg[String(id)];
      const level = toSafeInt(row && row.level, 1);
      const need = getNormalComposeNeed(id);
      if (need <= 0 || level > levelLimit || isGemPlaced(info, gem.uid)) return;
      const key = String(id);
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(gem.uid);
    });

    for (const [idKey, uidGroup] of groupMap.entries()) {
      const id = toSafeInt(idKey, 0);
      const need = getNormalComposeNeed(id);
      const nextId = getNextGemId(id);
      while (need > 0 && uidGroup.length >= need) {
        const consumeUids = uidGroup.splice(0, need);
        consumeUids.forEach((uid) => {
          costs.push(uid);
          removeGemByUid(info, uid);
        });
        gems.push(addGem(info, nextId));
        changed = true;
      }
    }
  }

  let taskChanged = false;
  if (gems.length > 0) {
    const obtainTaskChanged = !!addGemObtainCount(player, gems.length);
    const composeTaskChanged = !!addGemComposeCount(player, gems.length);
    taskChanged = obtainTaskChanged || composeTaskChanged;
  }
  await playerService.savePlayer(session.userId, player);
  const response = { tag: 3903, msgUid, data: { costs, gems } };
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

// exchange gems (tag:3904)
async function handleGemExchange(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3904, msgUid, data: { uids: [], exchangeTimes: 0, gems: [] } };

  const info = ensureGemInfo(player);
  const uidList = Array.isArray(params && params.uids) ? params.uids : [];
  const type = toSafeInt(params && params.type, 0);
  const uids = uidList.map((v) => toSafeInt(v, 0)).filter((v, idx, arr) => v > 0 && arr.indexOf(v) === idx);

  const consumed = [];
  uids.forEach((uid) => {
    if (findGemByUid(info, uid)) {
      consumed.push(uid);
      removeGemByUid(info, uid);
    }
  });

  const rewardId = pickGemIdByType(type);
  const gems = [];
    for (let i = 0; i < consumed.length; i++) {
      gems.push(addGem(info, rewardId));
    }

  if (consumed.length > 0) info.exchangeTimes = Math.max(0, toSafeInt(info.exchangeTimes, 0) + 1);
  const taskChanged = gems.length > 0 ? !!addGemObtainCount(player, gems.length) : false;
  await playerService.savePlayer(session.userId, player);
  const response = { tag: 3904, msgUid, data: { uids: consumed, exchangeTimes: info.exchangeTimes, gems } };
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

// buy gem field (tag:3905)
async function handleGemBuyField(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3905, msgUid, data: { fieldCount: 0 } };

  const info = ensureGemInfo(player);
  const baseCfg = getGemBaseConfig();
  const initialField = Math.max(1, toSafeInt(baseCfg.initialField, 30));
  const fieldMax = Math.max(initialField, toSafeInt(baseCfg.fieldMax, initialField));
  const consumeList = Array.isArray(baseCfg.fieldConsume) ? baseCfg.fieldConsume : [];
  const idx = Math.max(0, toSafeInt(info.fieldCount, initialField) - initialField);
  const diamondCost = Math.max(0, toSafeInt(consumeList[idx], 0));

  if (info.fieldCount < fieldMax) {
    if (diamondCost <= 0 || hasEnoughItemOrCurrency(player, 1, diamondCost)) {
      if (diamondCost > 0) consumeItemOrCurrency(player, 1, diamondCost);
      info.fieldCount += 1;
    }
  }

  await playerService.savePlayer(session.userId, player);
  return { tag: 3905, msgUid, data: { fieldCount: info.fieldCount } };
}

// special compose (tag:3906)
async function handleGemSpecialCompose(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3906, msgUid, data: { uids: [], gems: [] } };

  const info = ensureGemInfo(player);
  const gemId = toSafeInt(params && params.id, getFallbackGemId());
  const count = Math.max(1, toSafeInt(params && params.count, 1));
  const compose = !!(params && (params.compose === true || toSafeInt(params.compose, 0) > 0));
  const composeCfg = getGemComposeConfig()[gemId] || getGemComposeConfig()[String(gemId)] || null;
  const consumeList = Array.isArray(composeCfg && composeCfg.consume) ? composeCfg.consume : [];
  if (!composeCfg || consumeList.length <= 0) {
    return { tag: 3906, msgUid, data: { uids: [], gems: [] } };
  }

  const uids = [];
  const gems = [];
  if (compose) {
    for (const cost of consumeList) {
      const need = Math.max(0, toSafeInt(cost.count, 0) * count);
      if (takeUnplacedGemUidsById(info, cost.id, need).length < need) {
        return { tag: 3906, msgUid, data: { uids: [], gems: [] } };
      }
    }
    consumeList.forEach((cost) => {
      const need = Math.max(0, toSafeInt(cost.count, 0) * count);
      takeUnplacedGemUidsById(info, cost.id, need).forEach((uid) => {
        uids.push(uid);
        removeGemByUid(info, uid);
      });
    });
    for (let i = 0; i < count; i += 1) gems.push(addGem(info, gemId));
  } else {
    const level = getGemLevelById(gemId);
    const diamondPrice = Math.max(0, toSafeInt((getGemBaseConfig().price || {})[level], 0));
    if (diamondPrice > 0 && !hasEnoughItemOrCurrency(player, 1, diamondPrice * count)) {
      return { tag: 3906, msgUid, data: { uids: [], gems: [] } };
    }
    const sameGemUids = takeUnplacedGemUidsById(info, gemId, count);
    if (sameGemUids.length < count) {
      return { tag: 3906, msgUid, data: { uids: [], gems: [] } };
    }
    sameGemUids.forEach((uid) => {
      uids.push(uid);
      removeGemByUid(info, uid);
    });
    if (diamondPrice > 0) consumeItemOrCurrency(player, 1, diamondPrice * count);
    consumeList.forEach((cost) => {
      const rewardCount = Math.max(0, toSafeInt(cost.count, 0) * count);
      for (let i = 0; i < rewardCount; i += 1) gems.push(addGem(info, cost.id));
    });
  }

  let taskChanged = false;
  if (gems.length > 0) {
    const obtainTaskChanged = !!addGemObtainCount(player, gems.length);
    const composeTaskChanged = !!addGemComposeCount(player, gems.length);
    taskChanged = obtainTaskChanged || composeTaskChanged;
  }
  await playerService.savePlayer(session.userId, player);
  const response = { tag: 3906, msgUid, data: { uids, gems } };
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

module.exports = {
  ensureGemInfo,
  addGem,
  handleGemSet,
  handleGemCompose,
  handleGemAutoCompose,
  handleGemExchange,
  handleGemBuyField,
  handleGemSpecialCompose,
};
