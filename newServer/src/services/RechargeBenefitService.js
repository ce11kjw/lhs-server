const configService = require('./ConfigService');

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_CARD_DURATION_MS = 30 * DAY_MS;
const LIFETIME_CARD_DURATION_MS = 100 * 365 * DAY_MS;
const KNOWN_MONTH_CARD_IDS = new Set([11000001, 11000002, 11000007, 11000009, 11000012]);

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function getCfgRow(table, id) {
  const safeId = toSafeInt(id, 0);
  if (safeId <= 0) return null;
  const source = ensureObject(table);
  return source[safeId] || source[String(safeId)] || null;
}

function getConfigTable(name) {
  try {
    return ensureObject(configService.get(name));
  } catch (_err) {
    return {};
  }
}

function getShopPayId(row, fallback = 0) {
  const source = ensureObject(row);
  return toSafeInt(
    source.payId != null ? source.payId : (source.payid != null ? source.payid : source.rechargeId),
    fallback
  );
}

function isMonthCardShopId(id) {
  const safeId = toSafeInt(id, 0);
  if (KNOWN_MONTH_CARD_IDS.has(safeId)) return true;
  return !!getCfgRow(getConfigTable('PrivilegeConfig'), safeId);
}

function listShopRows() {
  const shopCfg = getConfigTable('ShopConfig');
  return Object.keys(shopCfg)
    .map((key) => shopCfg[key])
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

function resolveRechargeProduct(rawId) {
  const requestedId = toSafeInt(rawId, 0);
  const shopCfg = getConfigTable('ShopConfig');
  const rows = listShopRows();
  const linkedRows = requestedId > 0
    ? rows.filter((row) => getShopPayId(row, 0) === requestedId)
    : [];
  const linkedMonthCard = linkedRows.find((row) => isMonthCardShopId(row.id));
  const directRow = getCfgRow(shopCfg, requestedId);
  const shopRow = linkedMonthCard || directRow || linkedRows[0] || null;
  const shopId = toSafeInt(shopRow && shopRow.id, requestedId);
  const payId = getShopPayId(shopRow, requestedId);
  const monthCardId = isMonthCardShopId(shopId) ? shopId : 0;

  return {
    requestedId,
    payId,
    shopId,
    shopRow,
    monthCardId,
  };
}

function ensureRechargeInfo(player = {}) {
  player.rechargeInfo = ensureObject(player.rechargeInfo);
  const info = player.rechargeInfo;
  info.monthCards = ensureObject(info.monthCards);
  info.monthCardRecords = ensureObject(info.monthCardRecords);
  info.privilegeItem = ensureObject(info.privilegeItem);
  info.records = Array.isArray(info.records) ? info.records : [];
  return info;
}

function addRechargeRecord(info, id, addCount = 1) {
  const safeId = toSafeInt(id, 0);
  const count = Math.max(1, toSafeInt(addCount, 1));
  if (safeId <= 0) return;
  const found = info.records.find((row) => toSafeInt(row && row.id, 0) === safeId);
  if (found) found.count = Math.max(0, toSafeInt(found.count, 0)) + count;
  else info.records.push({ id: safeId, count });
}

function getMonthCardDurationMs(monthCardId, shopRow) {
  if (toSafeInt(monthCardId, 0) === 11000001) return LIFETIME_CARD_DURATION_MS;
  const row = ensureObject(shopRow);
  const dayValue = [row.days, row.day, row.durationDay, row.durationDays, row.validDay, row.validDays]
    .map((value) => toSafeInt(value, 0))
    .find((value) => value > 0);
  return (dayValue || 30) * DAY_MS;
}

function buildMonthCardEndTime(currentEndTime, now, durationMs, multi, isLifetime) {
  const current = Math.max(0, toSafeInt(currentEndTime, 0));
  const safeNow = Math.max(0, toSafeInt(now, Date.now()));
  const safeMulti = Math.max(1, toSafeInt(multi, 1));
  if (isLifetime) return Math.max(current, safeNow + durationMs);
  return Math.max(current, safeNow) + durationMs * safeMulti;
}

function applyRechargeBenefits(player = {}, options = {}) {
  const rawId = options.payId != null ? options.payId : options.productId;
  const product = resolveRechargeProduct(rawId);
  const info = ensureRechargeInfo(player);
  const now = Math.max(0, toSafeInt(options.now, Date.now()));
  const multi = Math.max(1, toSafeInt(options.multi, 1));
  const recordId = product.payId || product.requestedId;
  const monthCardUpdates = [];

  addRechargeRecord(info, recordId, multi);

  if (product.monthCardId > 0) {
    const key = String(product.monthCardId);
    const durationMs = getMonthCardDurationMs(product.monthCardId, product.shopRow);
    const endTime = buildMonthCardEndTime(
      info.monthCards[key],
      now,
      durationMs,
      multi,
      product.monthCardId === 11000001
    );
    info.monthCards[key] = endTime;
    monthCardUpdates.push({ id: product.monthCardId, time: endTime });
  }

  return {
    ...product,
    recordId,
    monthCardUpdates,
  };
}

function buildMonthCardUpdatePackets(updates = []) {
  return updates.map((row) => ({
    tag: 1211,
    msgUid: 0,
    data: {
      id: toSafeInt(row && row.id, 0),
      time: Math.max(0, toSafeInt(row && row.time, 0)),
    },
  })).filter((packet) => packet.data.id > 0 && packet.data.time > 0);
}

module.exports = {
  applyRechargeBenefits,
  buildMonthCardUpdatePackets,
  ensureRechargeInfo,
  getCfgRow,
  resolveRechargeProduct,
  toSafeInt,
};
