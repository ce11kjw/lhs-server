/**
 * PlayerService - 玩家数据持久化服务
 * 替代原 LHS-file/src/db.js 的 JSON 文件存储
 * 提供 loadPlayer / createPlayer / savePlayer 接口
 */

const fs = require('fs');
const path = require('path');
const Player = require('../db/models/Player');
const logger = require('../logger');
const { syncCurrencyItems } = require('./CurrencySync');
const { attachTaskSyncMeta, getTaskSyncMeta } = require('./TaskDirtyService');

function readPositiveInt(name, fallback, min = 1) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

const DB_OPERATION_TIMEOUT_MS = readPositiveInt('MONGO_OPERATION_TIMEOUT_MS', 5000, 500);
// withRetry performs up to three DB attempts plus 100/200ms backoff. The
// outer queue deadline must not expire first, otherwise the next save begins
// while the previous Mongo write is still running in the background.
const MIN_PLAYER_SAVE_TIMEOUT_MS = (DB_OPERATION_TIMEOUT_MS * 3) + 1000;
const PLAYER_SAVE_TIMEOUT_MS = Math.max(
  MIN_PLAYER_SAVE_TIMEOUT_MS,
  readPositiveInt('PLAYER_SAVE_TIMEOUT_MS', 20000, 1000)
);

function createTimeoutError(label, timeoutMs) {
  const err = new Error(`${label} timeout after ${timeoutMs}ms`);
  err.name = 'OperationTimeoutError';
  err.code = 'OPERATION_TIMEOUT';
  return err;
}

function withTimeout(work, timeoutMs, label) {
  let timer = null;
  const operation = Promise.resolve().then(work);
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(createTimeoutError(label, timeoutMs)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 带重试的数据库操作包装
 * @param {Function} fn - 异步操作
 * @param {number} retries - 重试次数（默认2）
 * @returns {Promise<*>}
 */
async function withRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await withTimeout(fn, DB_OPERATION_TIMEOUT_MS, 'MongoDB operation');
    } catch (err) {
      if (i === retries) throw err;
      const isTransient = err.name === 'MongoNetworkError'
        || err.name === 'MongoTimeoutError'
        || err.code === 'OPERATION_TIMEOUT'
        || (err.code && err.code === 112); // WriteConflict
      if (!isTransient) throw err;
      logger.warn(`[Player] DB 操作重试 (${i + 1}/${retries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

// 加载玩家模板（完整初始数据）
const TEMPLATE_PATH = path.join(__dirname, '..', '..', '..', 'LHS-file', 'src', 'data', 'player_template.json');
let _template = null;
const lastSavedAt = new WeakMap();
const pendingSaveAt = new WeakMap();
// 上次成功保存的快照，用于字段级 diff（只写真正变化的字段）
const lastSavedSnapshot = new WeakMap();
const saveQueues = new Map();
const saveQueueDepths = new Map();

function markSaveScheduled(value) {
  const at = Date.now();
  if (value && typeof value === 'object') pendingSaveAt.set(value, at);
  return at;
}

function clearSaveScheduled(value, at) {
  if (value && typeof value === 'object' && pendingSaveAt.get(value) === at) {
    pendingSaveAt.delete(value);
  }
}

function markSaved(value) {
  if (value && typeof value === 'object') lastSavedAt.set(value, Date.now());
}

function wasRecentlySaved(value, since = 0) {
  if (!value || typeof value !== 'object') return false;
  const savedAt = lastSavedAt.get(value) || 0;
  const scheduledAt = pendingSaveAt.get(value) || 0;
  return Math.max(savedAt, scheduledAt) >= Math.max(0, Number(since) || 0);
}

function cloneSaveData(value) {
  if (!value || typeof value !== 'object') return value;
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch (_err) {}
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return { ...value };
  }
}

/**
 * 浅层字段级 diff：找出相比「上次已保存的快照」真正变化的顶层字段。
 *
 * ⚠️ 原实现每次 savePlayer 都把整份玩家数据（实测 68KB~数百 KB）$set 写一遍，
 * MongoDB 单次整文档写实测 180~900ms，且跑在单会话串行队列里。
 * 所有升级 handler 都是 await playerService.savePlayer(...)，
 * 于是「每次升级都要等 200~900ms 才回包」——这是「全部升级都有延迟」的直接原因。
 *
 * 改为只写变化的顶层字段：升级通常只动 currencies/items/formationInfo 等 2~3 个字段，
 * 写量从数十 KB 降到几百字节。
 */
function pickChangedTopLevelFields(previousSnapshot, incomingData) {
  if (!incomingData || typeof incomingData !== 'object') return null;
  const changed = {};
  let changedCount = 0;
  const unsafeStringify = (value) => {
    try { return JSON.stringify(value); } catch (_err) { return null; }
  };
  for (const key of Object.keys(incomingData)) {
    if (key === '_id' || key === '__v' || key === 'createdAt' || key === 'updatedAt') continue;
    const nextValue = incomingData[key];
    if (previousSnapshot === null) { changed[key] = nextValue; changedCount += 1; continue; }
    const prevValue = previousSnapshot[key];
    const nextStr = unsafeStringify(nextValue);
    const prevStr = unsafeStringify(prevValue);
    if (nextStr === null || prevStr === null || nextStr !== prevStr) {
      changed[key] = nextValue; changedCount += 1;
    }
  }
  return { changed, changedCount };
}

function enqueueSave(userId, work) {
  const key = String(userId || '');
  const previous = saveQueues.get(key) || Promise.resolve();
  const queuedAt = Date.now();
  const depth = (saveQueueDepths.get(key) || 0) + 1;
  saveQueueDepths.set(key, depth);
  if (depth >= 4) {
    logger.warn(`[Player] save queue backlog user=${key} depth=${depth}`);
  }
  const current = previous.catch(() => undefined).then(() => {
    const waitMs = Date.now() - queuedAt;
    if (waitMs >= DB_OPERATION_TIMEOUT_MS) {
      logger.warn(`[Player] save queue wait user=${key} depth=${depth} wait=${waitMs}ms`);
    }
    return withTimeout(work, PLAYER_SAVE_TIMEOUT_MS, `save player ${key}`);
  });
  const cleanup = () => {
    if (saveQueues.get(key) === tracked) saveQueues.delete(key);
    const nextDepth = Math.max(0, (saveQueueDepths.get(key) || 1) - 1);
    if (nextDepth > 0) saveQueueDepths.set(key, nextDepth);
    else saveQueueDepths.delete(key);
  };
  // Keep the bookkeeping promise resolved on failure; callers still receive
  // the original `current` rejection, while the queue itself cannot trigger
  // an unhandled-rejection warning.
  const tracked = current.then(
    (value) => { cleanup(); return value; },
    () => { cleanup(); return undefined; }
  );
  saveQueues.set(key, tracked);
  return current;
}

function getTemplate() {
  if (_template) return _template;
  try {
    _template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8'));
  } catch (_e) {
    logger.warn('[Player] player_template.json 不存在，使用内置默认值');
    _template = {};
  }
  return _template;
}

function buildFreshPlayerData(userId, name, extra = {}, options = {}) {
  const now = Date.now();
  const template = getTemplate();
  const data = JSON.parse(JSON.stringify(template));
  const playerId = options.preservePlayerId
    ? String(options.preservePlayerId)
    : `p_${userId}_${now}`;

  data.userId = userId;
  data.playerId = playerId;
  data.name = name;
  data.createTime = now;

  if (data.raidInfo) data.raidInfo.hangUpTime = now;

  if (!data.items || typeof data.items !== 'object' || Array.isArray(data.items)) {
    data.items = {};
  }
  const starterBaoziRaw = Number(process.env.STARTER_BAOZI || 1000);
  const starterBaozi = Number.isFinite(starterBaoziRaw) && starterBaoziRaw > 0
    ? Math.floor(starterBaoziRaw)
    : 1000;
  const currentBaozi = Number(data.items[4]);
  if (!Number.isFinite(currentBaozi) || currentBaozi <= 0) {
    data.items[4] = starterBaozi;
  }

  const starterSpiritStoneRaw = Number(process.env.STARTER_SPIRIT_STONE || 100);
  const starterSpiritStone = Number.isFinite(starterSpiritStoneRaw) && starterSpiritStoneRaw > 0
    ? Math.floor(starterSpiritStoneRaw)
    : 100;
  const currentSpiritStone = Number(data.items[60]);
  if (!Number.isFinite(currentSpiritStone) || currentSpiritStone < starterSpiritStone) {
    data.items[60] = starterSpiritStone;
  }

  const starterSpiritEssenceRaw = Number(process.env.STARTER_SPIRIT_ESSENCE || 10);
  const starterSpiritEssence = Number.isFinite(starterSpiritEssenceRaw) && starterSpiritEssenceRaw > 0
    ? Math.floor(starterSpiritEssenceRaw)
    : 10;
  const currentSpiritEssence = Number(data.items[61]);
  if (!Number.isFinite(currentSpiritEssence) || currentSpiritEssence < starterSpiritEssence) {
    data.items[61] = starterSpiritEssence;
  }

  Object.assign(data, extra);
  syncCurrencyItems(data);
  delete data.mail;
  return data;
}

/**
 * 加载玩家数据
 * @param {string} userId - 玩家唯一标识
 * @returns {Promise<Object|null>} 玩家文档（lean 对象），不存在返回 null
 */
async function loadPlayer(userId) {
  return withRetry(() => Player.findOne({ userId }).maxTimeMS(DB_OPERATION_TIMEOUT_MS).lean());
}

/**
 * 创建新玩家（基于 player_template.json 完整初始化）
 * @param {string} userId - 玩家唯一标识
 * @param {string} name - 玩家名称
 * @param {Object} [extra] - 额外字段（如 agentId, inviteCode）
 * @returns {Promise<Object>} 新建的玩家文档
 */
async function createPlayer(userId, name, extra = {}) {
  const data = buildFreshPlayerData(userId, name, extra);

  const player = await Player.create(data);
  logger.info(`[Player] 新建玩家: ${name} (${userId})`);
  return player.toObject();
}

/**
 * 保存玩家数据（部分更新）
 * @param {string} userId - 玩家唯一标识
 * @param {Object} data - 要更新的字段
 * @returns {Promise<Object|null>} 更新后的玩家文档
 */
async function savePlayer(userId, data, options = {}) {
  const sourceData = data;
  const taskSyncMeta = getTaskSyncMeta(sourceData);
  const snapshot = cloneSaveData(sourceData);
  const scheduledAt = markSaveScheduled(sourceData);
  const previousSnapshot = lastSavedSnapshot.get(sourceData) || null;

  return enqueueSave(userId, async () => {
    const { _id, __v, createdAt, updatedAt, ...updateData } = snapshot || {};
    if (updateData && (updateData.currencies || updateData.items)) {
      syncCurrencyItems(updateData);
    }

    // 字段级 diff：只写变化的顶层字段（拿不到基线时回退为全量写）
    let writePayload = updateData;
    const diff = pickChangedTopLevelFields(previousSnapshot, updateData);
    if (diff) {
      if (diff.changedCount === 0) {
        const unchanged = attachTaskSyncMeta(sourceData, getTaskSyncMeta(sourceData));
        markSaved(sourceData);
        markSaved(unchanged);
        return unchanged;
      }
      writePayload = diff.changed;
    }
    const incomingLevel = Math.max(0, Number(updateData && updateData.level) || 0);
    const allowLevelDowngrade = options && options.allowLevelDowngrade === true;
    const filter = { userId };
    if (!allowLevelDowngrade && incomingLevel > 0) {
      filter.$or = [
        { level: { $exists: false } },
        { level: { $lte: incomingLevel } },
      ];
    }
    try {
      const saved = await withRetry(() =>
        Player.findOneAndUpdate(
          filter,
          { $set: writePayload },
          { returnDocument: 'after', lean: true, maxTimeMS: DB_OPERATION_TIMEOUT_MS }
        )
      );
      if (!saved && !allowLevelDowngrade && incomingLevel > 0) {
        const current = await loadPlayer(userId);
        logger.warn(
          `[Player] skip stale save user=${userId} incomingLevel=${incomingLevel} `
          + `currentLevel=${current && current.level != null ? current.level : 'missing'}`
        );
        const stale = attachTaskSyncMeta(current, taskSyncMeta);
        markSaved(sourceData);
        markSaved(stale);
        return stale;
      }
      // ⚠️ 注意：字段级 diff 模式下 $set 只写了部分字段，
      // findOneAndUpdate 的返回值可能缺字段（取决于 Mongo 行为），
      // 因此这里以「内存里的完整数据」为准来构造返回值，保证调用方拿到完整对象。
      const merged = writePayload === updateData
        ? (saved || updateData)
        : Object.assign({}, saved || {}, updateData);
      const result = attachTaskSyncMeta(merged, taskSyncMeta);
      lastSavedSnapshot.set(sourceData, updateData);
      lastSavedSnapshot.set(result, updateData);
      markSaved(sourceData);
      markSaved(result);
      return result;
    } finally {
      clearSaveScheduled(sourceData, scheduledAt);
    }
  });
}

/**
 * Defer the synchronous player snapshot until after the current handler has
 * returned its protocol response. This keeps hot gameplay RPCs responsive
 * even when the in-memory player document has grown large.
 */
function savePlayerDeferred(userId, data, options = {}) {
  return new Promise((resolve, reject) => {
    const run = () => {
      savePlayer(userId, data, options).then(resolve, reject);
    };
    if (typeof setImmediate === 'function') setImmediate(run);
    else setTimeout(run, 0);
  });
}

async function resetPlayerForServerSwitch(userId, options = {}) {
  const player = await loadPlayer(userId);
  if (!player) return null;
  const resetRoleSelection = options.resetRoleSelection === true;
  const fresh = buildFreshPlayerData(userId, player.name || `Player_${userId}`, {
    accountId: player.accountId,
    roleId: player.roleId,
    inviteCode: player.inviteCode,
    agentId: player.agentId,
  }, { preservePlayerId: player.playerId });

  fresh._id = player._id;
  fresh.userId = player.userId || userId;
  fresh.playerId = player.playerId || fresh.playerId;
  fresh.name = player.name || fresh.name;
  fresh.accountId = player.accountId;
  fresh.roleId = player.roleId;
  fresh.serverSwitchResetAt = Date.now();

  if (resetRoleSelection) {
    fresh.roleInfo = {
      ...(fresh.roleInfo && typeof fresh.roleInfo === 'object' ? fresh.roleInfo : {}),
      kungfuId: 0,
      subJob: 0,
    };
    if (fresh.fashionInfo && typeof fresh.fashionInfo === 'object') {
      fresh.fashionInfo.curFashion = {};
      fresh.fashionInfo.fashionMap = {};
    }
  }

  return savePlayer(userId, fresh, { allowLevelDowngrade: true });
}

async function resetPlayerGameData(userId, options = {}) {
  const player = await loadPlayer(userId);
  if (!player) return null;

  const fresh = buildFreshPlayerData(userId, player.name || `Player_${userId}`, {
    accountId: player.accountId,
    inviteCode: player.inviteCode,
    agentId: player.agentId,
    adminStatus: player.adminStatus,
  }, { preservePlayerId: player.playerId });

  fresh.userId = player.userId || userId;
  fresh.playerId = player.playerId || fresh.playerId;
  fresh.name = player.name || fresh.name;
  fresh.accountId = player.accountId;
  fresh.createdAt = player.createdAt;
  fresh.clearGameDataAt = Date.now();
  fresh.clearGameDataReason = String(options.reason || 'admin_clear_game_data').slice(0, 128);

  const { _id, __v, ...replacement } = fresh;
  syncCurrencyItems(replacement);
  return withRetry(() => Player.findOneAndReplace(
    { userId },
    replacement,
    { returnDocument: 'after', lean: true, maxTimeMS: DB_OPERATION_TIMEOUT_MS }
  ));
}

/**
 * 通过 playerId 查找玩家
 * @param {string} playerId
 * @returns {Promise<Object|null>}
 */
async function findByPlayerId(playerId) {
  return withRetry(() => Player.findOne({ playerId }).maxTimeMS(DB_OPERATION_TIMEOUT_MS).lean());
}

async function findByDbidOrPlayerId(id) {
  const value = String(id || '').trim();
  if (!value) return null;
  const filters = [{ playerId: value }];
  if (/^[0-9a-fA-F]{24}$/.test(value)) {
    filters.push({ _id: value });
  }
  return withRetry(() => Player.findOne({ $or: filters }).maxTimeMS(DB_OPERATION_TIMEOUT_MS).lean());
}

async function listPlayersBasic(filter = {}, limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  return withRetry(() => Player.find(filter)
    .select({
      userId: 1,
      playerId: 1,
      name: 1,
      avatar: 1,
      avatarUrl: 1,
      avatarFrame: 1,
      guildInfo: 1,
      farmInfo: 1,
      roleInfo: 1,
      level: 1,
    })
    .limit(safeLimit)
    .maxTimeMS(DB_OPERATION_TIMEOUT_MS)
    .lean());
}

module.exports = {
  loadPlayer,
  createPlayer,
  savePlayer,
  savePlayerDeferred,
  wasRecentlySaved,
  resetPlayerForServerSwitch,
  resetPlayerGameData,
  findByPlayerId,
  findByDbidOrPlayerId,
  listPlayersBasic,
};
