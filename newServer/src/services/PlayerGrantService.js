const { buildClientItemList } = require('./CurrencySync');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensurePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sanitizeGivePayload(value = {}) {
  const raw = ensurePlainObject(value);
  const rewards = {};
  ['diamond', 'gold', 'silver'].forEach((key) => {
    const count = toSafeInt(raw[key], 0);
    if (count !== 0) rewards[key] = count;
  });
  const items = ensurePlainObject(raw.items);
  const normalizedItems = {};
  Object.keys(items).forEach((key) => {
    const itemId = Math.max(1, toSafeInt(key, 0));
    const count = toSafeInt(items[key], 0);
    if (itemId > 0 && count !== 0) normalizedItems[String(itemId)] = count;
  });
  if (Object.keys(normalizedItems).length > 0) rewards.items = normalizedItems;
  return rewards;
}

function hasGivePayloadContent(value = {}) {
  const raw = ensurePlainObject(value);
  return ['diamond', 'gold', 'silver'].some((key) => toSafeInt(raw[key], 0) !== 0)
    || Object.keys(ensurePlainObject(raw.items)).some((key) => toSafeInt(raw.items[key], 0) !== 0);
}

function buildGivePayloadFromRewardItems(items = []) {
  const payload = { items: {} };
  (Array.isArray(items) ? items : []).forEach((row) => {
    const itemId = Math.max(1, toSafeInt(row && row.id, 0));
    const count = toSafeInt(row && row.count, 0);
    if (itemId <= 0 || count === 0) return;
    if (itemId === 1) {
      payload.diamond = toSafeInt(payload.diamond, 0) + count;
      return;
    }
    if (itemId === 2) {
      payload.silver = toSafeInt(payload.silver, 0) + count;
      return;
    }
    if (itemId === 6) {
      payload.gold = toSafeInt(payload.gold, 0) + count;
      return;
    }
    payload.items[String(itemId)] = toSafeInt(payload.items[String(itemId)], 0) + count;
  });
  if (Object.keys(payload.items).length <= 0) delete payload.items;
  return sanitizeGivePayload(payload);
}

function applyGivePayloadToPlayer(player, body = {}) {
  const payload = sanitizeGivePayload(body);
  player.currencies = player.currencies || {};
  ['diamond', 'gold', 'silver'].forEach((key) => {
    if (payload[key] != null) {
      player.currencies[key] = Math.max(0, toSafeInt(player.currencies[key], 0) + toSafeInt(payload[key], 0));
    }
  });
  player.markModified('currencies');

  const items = ensurePlainObject(payload.items);
  const itemIds = Object.keys(items).map(Number).filter((id) => id > 0);
  if (itemIds.length > 0) {
    player.items = player.items || {};
    itemIds.forEach((itemId) => {
      const key = String(itemId);
      player.items[key] = Math.max(0, toSafeInt(player.items[key], 0) + toSafeInt(items[key], 0));
      if (player.items[key] <= 0) delete player.items[key];
    });
    player.markModified('items');
  }

  if (body.exp != null || Object.prototype.hasOwnProperty.call(items, '3')) {
    const { checkLevelUp } = require('../handlers/raid');
    checkLevelUp(player);
  }
  return { payload, itemIds };
}

function buildItemSyncPayload(player, changedItemIds = []) {
  const items = buildClientItemList(player);
  const changed = [];
  const currencies = (player && player.currencies) || {};
  [{ id: 1, v: currencies.diamond }, { id: 2, v: currencies.silver }, { id: 6, v: currencies.gold }]
    .forEach(({ id, v }) => changed.push({ id, count: Math.max(0, Number(v) || 0) }));
  if (player && player.items) {
    Object.keys(player.items).forEach((k) => {
      const id = Number(k);
      if (id > 0 && id !== 1 && id !== 2 && id !== 6) {
        changed.push({ id, count: Math.max(0, Number(player.items[k]) || 0) });
      }
    });
  }
  if (changedItemIds) {
    const inChanged = new Set(changed.map((row) => row.id));
    changedItemIds.forEach((id) => {
      if (!inChanged.has(id)) changed.push({ id, count: 0 });
    });
  }
  return {
    result: 0,
    items,
    changed,
  };
}

module.exports = {
  applyGivePayloadToPlayer,
  buildGivePayloadFromRewardItems,
  buildItemSyncPayload,
  hasGivePayloadContent,
  sanitizeGivePayload,
};
