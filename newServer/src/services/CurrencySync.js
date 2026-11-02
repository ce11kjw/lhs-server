/**
 * Keep currency fields and client item payload aligned.
 * Client UI reads currencies from item ids (1,2,6) instead of player.currencies.
 */

function _toSafeCount(val) {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

function _toSafeIdList(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const set = new Set();
  arr.forEach((item) => {
    const id = Number(item);
    if (Number.isFinite(id) && id !== 0) set.add(Math.floor(id));
  });
  return Array.from(set);
}

function _isDenseMode() {
  const mode = String(process.env.ITEM_PAYLOAD_MODE || 'dense').trim().toLowerCase();
  return mode !== 'sparse';
}

function _getDenseBaseIds() {
  const defaults = '1,2,3,4,6';
  return _toSafeIdList(process.env.ITEM_PAYLOAD_DENSE_IDS || defaults);
}

function reconcilePlayerExpFromItems(player = {}) {
  if (!player || typeof player !== 'object') return player;
  if (!player.items || typeof player.items !== 'object' || Array.isArray(player.items)) {
    return player;
  }
  const bagExp = _toSafeCount(player.items[3]);
  const curExp = Number(player.exp);
  const safeCurExp = Number.isFinite(curExp) && curExp >= 0 ? Math.floor(curExp) : 0;
  if (bagExp > safeCurExp) {
    player.exp = bagExp;
  }
  return player;
}

function syncExpItem(player = {}) {
  if (!player || typeof player !== 'object') return player;

  if (!player.items || typeof player.items !== 'object' || Array.isArray(player.items)) {
    player.items = {};
  }

  reconcilePlayerExpFromItems(player);

  const rawExp = Number(player.exp);
  const finalExp = Number.isFinite(rawExp) && rawExp >= 0 ? Math.floor(rawExp) : 0;

  player.exp = finalExp;
  if (finalExp > 0) {
    player.items[3] = finalExp;
  } else if (Object.prototype.hasOwnProperty.call(player.items, '3')) {
    delete player.items[3];
  }

  return player;
}

function syncCurrencyItems(player = {}) {
  if (!player || typeof player !== 'object') return player;

  if (!player.items || typeof player.items !== 'object' || Array.isArray(player.items)) {
    player.items = {};
  }

  syncExpItem(player);

  const currencies = player.currencies || {};
  const mapping = {
    1: _toSafeCount(currencies.diamond), // 元宝
    2: _toSafeCount(currencies.silver),  // 银元
    6: _toSafeCount(currencies.gold),    // 加速符
  };

  Object.keys(mapping).forEach((itemId) => {
    const count = mapping[itemId];
    if (count > 0) {
      player.items[itemId] = count;
    } else if (Object.prototype.hasOwnProperty.call(player.items, itemId)) {
      delete player.items[itemId];
    }
  });

  return player;
}

function buildClientItemList(player = {}) {
  const merged = {};
  const items = player && player.items && typeof player.items === 'object' && !Array.isArray(player.items)
    ? player.items
    : {};
  const playerExp = _toSafeCount(player && player.exp);
  const bagExp = _toSafeCount(items[3]);
  const finalExp = Math.max(playerExp, bagExp);

  Object.keys(items).forEach((id) => {
    const count = _toSafeCount(items[id]);
    if (count > 0) merged[id] = count;
  });
  if (finalExp > 0) merged[3] = finalExp;

  const currencies = player && player.currencies && typeof player.currencies === 'object'
    ? player.currencies
    : {};
  const currencyMap = {
    1: _toSafeCount(currencies.diamond),
    2: _toSafeCount(currencies.silver),
    6: _toSafeCount(currencies.gold),
  };
  Object.keys(currencyMap).forEach((id) => {
    if (currencyMap[id] > 0) merged[id] = currencyMap[id];
  });

  if (_isDenseMode()) {
    const denseIds = new Set(_getDenseBaseIds());
    Object.keys(items).forEach((id) => {
      const num = Number(id);
      if (Number.isFinite(num) && num !== 0) denseIds.add(Math.floor(num));
    });
    Object.keys(currencyMap).forEach((id) => {
      const num = Number(id);
      if (Number.isFinite(num) && num > 0) denseIds.add(Math.floor(num));
    });

    return Array.from(denseIds)
      .sort((a, b) => a - b)
      .map((id) => ({
        id,
        count: merged[id] || 0,
      }));
  }

  return Object.keys(merged)
    .map((id) => ({ id: Number(id), count: merged[id] }))
    .sort((a, b) => a.id - b.id);
}

module.exports = {
  reconcilePlayerExpFromItems,
  syncExpItem,
  syncCurrencyItems,
  buildClientItemList,
};
