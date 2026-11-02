const currencySync = require('./CurrencySync');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function normalizeRewardItems(items = []) {
  return Array.isArray(items)
    ? items
        .map((row) => ({
          id: Math.max(0, toSafeInt(row && row.id, 0)),
          count: Math.max(0, toSafeInt(row && row.count, 0)),
        }))
        .filter((row) => row.id > 0 && row.count > 0)
    : [];
}

function getPlayerItemCount(player, itemId) {
  const safeItemId = Math.max(0, toSafeInt(itemId, 0));
  if (!player || typeof player !== 'object' || safeItemId <= 0) return 0;

  switch (safeItemId) {
    case 1:
      return Math.max(0, toSafeInt(player.currencies && player.currencies.diamond, 0));
    case 2:
      return Math.max(0, toSafeInt(player.currencies && player.currencies.silver, 0));
    case 6:
      return Math.max(0, toSafeInt(player.currencies && player.currencies.gold, 0));
    default:
      return Math.max(0, toSafeInt(player.items && player.items[safeItemId], 0));
  }
}

function buildRewardItemSync(player = {}, items = []) {
  const rewardItems = normalizeRewardItems(items);
  if (player && typeof player === 'object' && currencySync && typeof currencySync.syncCurrencyItems === 'function') {
    currencySync.syncCurrencyItems(player);
  }

  const changedMap = new Map();
  rewardItems.forEach((row) => {
    if (!changedMap.has(row.id)) {
      changedMap.set(row.id, {
        id: row.id,
        count: getPlayerItemCount(player, row.id),
      });
    }
  });

  return {
    result: 0,
    items: rewardItems,
    changed: Array.from(changedMap.values()),
  };
}

module.exports = {
  buildRewardItemSync,
  normalizeRewardItems,
};
