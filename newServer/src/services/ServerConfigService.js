const GameServer = require('../db/models/GameServer');
const logger = require('../logger');

const DEFAULT_SERVER_ROWS = Object.freeze(
  typeof GameServer.getDefaultRows === 'function' ? GameServer.getDefaultRows() : []
);

const DEFAULT_PAGE_NAME_BY_ID = Object.freeze(
  DEFAULT_SERVER_ROWS.reduce((acc, row) => {
    acc[row.pageId] = row.pageName;
    return acc;
  }, {})
);

const DEFAULT_SERVER_PAGES = Object.freeze(
  Object.entries(DEFAULT_PAGE_NAME_BY_ID)
    .map(([pageId, pageName]) => ({ pageId: Number(pageId), pageName }))
    .sort((a, b) => a.pageId - b.pageId)
);

const DEFAULT_SERVERS_BY_PAGE = Object.freeze(
  DEFAULT_SERVER_ROWS.reduce((acc, row) => {
    const pageId = row.pageId;
    if (!acc[pageId]) acc[pageId] = [];
    acc[pageId].push({
      serverId: row.serverId,
      serverName: row.serverName,
      isNew: !!row.isNew,
      isRecommend: !!row.isRecommend,
    });
    return acc;
  }, {})
);

let seedPromise = null;

// ⚠️ rechargeArea 是几乎不变的服务器配置，但 tag=1230（充值/兑换）每个包都要读它，
// 每次 findServerConfig 都打一次 MongoDB（实测 ~600ms），且跑在单会话串行队列里，
// 会把整条队列堵死（实测队列深度冲到 576、等待 13s，表现为"游戏突然卡死"）。
// 这里加一个 60s TTL 的内存缓存，把热路径的 DB 往返彻底消掉。
const RECHARGE_AREA_CACHE_TTL_MS = Math.max(1000, Number(process.env.RECHARGE_AREA_CACHE_TTL_MS) || 60000);
const rechargeAreaCache = new Map(); // serverId -> { value, expiresAt }

function normalizeRechargeArea(value, fallback = 1) {
  const area = Number(value);
  if ([1, 2, 3].includes(area)) return area;
  const safeFallback = Number(fallback);
  return [1, 2, 3].includes(safeFallback) ? safeFallback : 1;
}

function normalizeStatus(value, fallback = 1) {
  const status = Number(value);
  if (Number.isFinite(status) && status >= 0) return Math.floor(status);
  const safeFallback = Number(fallback);
  return Number.isFinite(safeFallback) && safeFallback >= 0 ? Math.floor(safeFallback) : 1;
}

function getDefaultRechargeArea() {
  return normalizeRechargeArea(process.env.DEFAULT_RECHARGE_AREA || process.env.RECHARGE_AREA || 1, 1);
}

function normalizeServerRow(row = {}) {
  const serverId = Number(row.serverId) || 0;
  const pageId = Number(row.pageId) || (serverId > 0 ? Math.floor(serverId / 1000) : 1);
  const pageName = String(row.pageName || DEFAULT_PAGE_NAME_BY_ID[pageId] || `page-${pageId}`);
  const isNew = !!row.isNew;

  return {
    serverId,
    pageId,
    pageName,
    serverName: String(row.serverName || `server-${serverId || 1001}`),
    isNew,
    isRecommend: !!row.isRecommend,
    status: normalizeStatus(row.status, 1),
    running: row.running !== false,
    openTime: Number(row.openTime) || 0,
    rechargeArea: normalizeRechargeArea(row.rechargeArea ?? row.area, getDefaultRechargeArea()),
  };
}

function isDuplicateKeyError(err) {
  if (!err) return false;
  if (err.code === 11000) return true;
  if (!Array.isArray(err.writeErrors)) return false;
  return err.writeErrors.every((item) => item && item.code === 11000);
}

function ensureNonEmptyText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

async function ensureSeeded() {
  if (!seedPromise) {
    seedPromise = GameServer.initializeDefaults()
      .then((result) => {
        if (result && result.inserted > 0) {
          logger.info(`[ServerConfig] seeded ${result.inserted} servers into MongoDB`);
        }
      })
      .catch((err) => {
        if (!isDuplicateKeyError(err)) throw err;
        logger.warn('[ServerConfig] seed skipped because another process already inserted the data');
      })
      .finally(() => {
        seedPromise = null;
      });
  }

  await seedPromise;
}

async function initializeServerConfigs() {
  await ensureSeeded();
}

async function listAllServers() {
  await ensureSeeded();
  const rows = await GameServer.find({}).sort({ pageId: 1, serverId: 1 }).lean();
  return rows.map(normalizeServerRow);
}

async function listServerPages() {
  const servers = await listAllServers();
  const seen = new Set();
  const pages = [];

  servers.forEach((row) => {
    if (seen.has(row.pageId)) return;
    seen.add(row.pageId);
    pages.push({ pageId: row.pageId, pageName: row.pageName });
  });

  return pages.length > 0 ? pages : DEFAULT_SERVER_PAGES.map((row) => ({ ...row }));
}

async function listServersByPage(pageIdInput) {
  const servers = await listAllServers();
  if (servers.length <= 0) return [];

  const pageId = Number(pageIdInput) || 0;
  if (pageId > 0) {
    const filtered = servers.filter((row) => row.pageId === pageId);
    if (filtered.length > 0) return filtered;
  }

  const fallbackPageId = servers[0].pageId;
  return servers.filter((row) => row.pageId === fallbackPageId);
}

async function findServerConfig(serverIdInput) {
  const serverId = Number(serverIdInput) || 0;
  if (serverId <= 0) return null;

  await ensureSeeded();
  const row = await GameServer.findOne({ serverId }).lean();
  return row ? normalizeServerRow(row) : null;
}

async function resolvePageName(pageId, pageNameInput = '', excludeServerId = 0) {
  const requested = ensureNonEmptyText(pageNameInput);
  if (requested) return requested;

  const filter = { pageId: Number(pageId) || 1 };
  const excludeId = Number(excludeServerId) || 0;
  if (excludeId > 0) filter.serverId = { $ne: excludeId };

  const samePageServer = await GameServer.findOne(filter).sort({ serverId: 1 }).lean();
  if (samePageServer && samePageServer.pageName) return String(samePageServer.pageName);
  return DEFAULT_PAGE_NAME_BY_ID[Number(pageId) || 1] || `page-${Number(pageId) || 1}`;
}

async function normalizeServerInput(payload = {}, options = {}) {
  const fallbackServerId = Number(options.serverId) || 0;
  const serverId = Number(payload.serverId ?? fallbackServerId) || 0;
  if (serverId <= 0) throw new Error('INVALID_SERVER_ID');

  const pageId = Number(payload.pageId) || Math.floor(serverId / 1000) || 1;
  if (pageId <= 0) throw new Error('INVALID_PAGE_ID');

  const pageName = await resolvePageName(pageId, payload.pageName, options.excludeServerId);
  const serverName = ensureNonEmptyText(payload.serverName, `server-${serverId}`);
  return normalizeServerRow({
    serverId,
    pageId,
    pageName,
    serverName,
    isNew: payload.isNew,
    isRecommend: payload.isRecommend,
    status: payload.status,
    running: payload.running,
    openTime: payload.openTime,
    rechargeArea: payload.rechargeArea ?? payload.area,
  });
}

async function createServer(payload = {}) {
  await ensureSeeded();
  const normalized = await normalizeServerInput(payload);
  const created = await GameServer.create(normalized);

  invalidateRechargeAreaCache(normalized.serverId);

  if (ensureNonEmptyText(payload.pageName)) {
    await GameServer.updateMany({ pageId: normalized.pageId }, { $set: { pageName: normalized.pageName } });
  }

  return normalizeServerRow(created && created.toObject ? created.toObject() : created);
}

async function updateServer(serverIdInput, payload = {}) {
  await ensureSeeded();
  const serverId = Number(serverIdInput) || 0;
  if (serverId <= 0) throw new Error('INVALID_SERVER_ID');

  const existing = await GameServer.findOne({ serverId });
  if (!existing) throw new Error('SERVER_NOT_FOUND');

  const normalized = await normalizeServerInput(
    { ...existing.toObject(), ...payload, serverId },
    { serverId, excludeServerId: serverId }
  );

  existing.pageId = normalized.pageId;
  existing.pageName = normalized.pageName;
  existing.serverName = normalized.serverName;
  existing.isNew = normalized.isNew;
  existing.isRecommend = normalized.isRecommend;
  existing.status = normalized.status;
  existing.running = normalized.running;
  existing.openTime = normalized.openTime;
  existing.rechargeArea = normalized.rechargeArea;
  await existing.save();

  // 配置被改动，清掉热路径缓存
  invalidateRechargeAreaCache(serverId);

  if (ensureNonEmptyText(payload.pageName)) {
    await GameServer.updateMany({ pageId: normalized.pageId }, { $set: { pageName: normalized.pageName } });
  }

  return normalizeServerRow(existing.toObject ? existing.toObject() : existing);
}

async function deleteServer(serverIdInput) {
  await ensureSeeded();
  const serverId = Number(serverIdInput) || 0;
  if (serverId <= 0) throw new Error('INVALID_SERVER_ID');

  const result = await GameServer.deleteOne({ serverId });
  if (!result || result.deletedCount <= 0) throw new Error('SERVER_NOT_FOUND');

  invalidateRechargeAreaCache(serverId);
  return true;
}

async function getCurrentRechargeArea(serverIdInput = 0) {
  const serverId = Number(serverIdInput) || Number(process.env.SERVER_ID) || Number(process.env.DEFAULT_SERVER_ID) || 1001;

  const cached = rechargeAreaCache.get(serverId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const row = await findServerConfig(serverId);
    const value = normalizeRechargeArea(row && row.rechargeArea, getDefaultRechargeArea());
    rechargeAreaCache.set(serverId, { value, expiresAt: Date.now() + RECHARGE_AREA_CACHE_TTL_MS });
    return value;
  } catch (err) {
    logger.warn(`[ServerConfig] failed to load recharge area for server ${serverId}: ${err.message}`);
    return getDefaultRechargeArea();
  }
}

/** 服务器配置被后台改动时清缓存（新建/更新/删除服务器后调用）。 */
function invalidateRechargeAreaCache(serverIdInput = 0) {
  const serverId = Number(serverIdInput) || 0;
  if (serverId > 0) rechargeAreaCache.delete(serverId);
  else rechargeAreaCache.clear();
}

module.exports = {
  DEFAULT_SERVER_PAGES,
  DEFAULT_SERVER_ROWS,
  DEFAULT_SERVERS_BY_PAGE,
  createServer,
  deleteServer,
  initializeServerConfigs,
  updateServer,
  listAllServers,
  listServerPages,
  listServersByPage,
  findServerConfig,
  getCurrentRechargeArea,
  invalidateRechargeAreaCache,
};
