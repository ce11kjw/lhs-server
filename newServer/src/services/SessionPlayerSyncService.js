'use strict';

const DEFAULT_SYNC_FIELDS = Object.freeze([
  'items',
  'currencies',
  'rechargeInfo',
  'shopInfo',
]);

function cloneValue(value) {
  if (value === undefined) return undefined;
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch (_err) {}
  return JSON.parse(JSON.stringify(value));
}

function normalizeIdList(value) {
  const rows = Array.isArray(value) ? value : [];
  return Array.from(new Set(rows
    .map((id) => Math.floor(Number(id)))
    .filter((id) => Number.isFinite(id) && id > 0)))
    .sort((a, b) => a - b);
}

function mergeIdLists(left, right) {
  return normalizeIdList([
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : []),
  ]);
}

function mergeSystemUnlockInfo(currentValue, updatedValue) {
  const current = currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)
    ? currentValue
    : {};
  const updated = updatedValue && typeof updatedValue === 'object' && !Array.isArray(updatedValue)
    ? updatedValue
    : {};
  const currentSettings = current.settings && typeof current.settings === 'object' && !Array.isArray(current.settings)
    ? current.settings
    : {};
  const updatedSettings = updated.settings && typeof updated.settings === 'object' && !Array.isArray(updated.settings)
    ? updated.settings
    : {};

  return {
    ...cloneValue(updated),
    ...cloneValue(current),
    unlockedSystem: mergeIdLists(current.unlockedSystem, updated.unlockedSystem),
    rewardedSystem: mergeIdLists(current.rewardedSystem, updated.rewardedSystem),
    guideStep: Math.max(0, Number(current.guideStep) || 0, Number(updated.guideStep) || 0),
    settings: {
      ...cloneValue(updatedSettings),
      ...cloneValue(currentSettings),
      seenNewFeatures: mergeIdLists(
        currentSettings.seenNewFeatures,
        updatedSettings.seenNewFeatures
      ),
    },
  };
}

/**
 * Apply only explicitly owned admin fields to a live player object. The live
 * object must remain authoritative for unrelated gameplay state.
 */
function syncSessionPlayerFields(sessionPlayer, updatedPlayer, options = {}) {
  if (!sessionPlayer || typeof sessionPlayer !== 'object') return sessionPlayer;
  if (!updatedPlayer || typeof updatedPlayer !== 'object') return sessionPlayer;

  const fields = Array.isArray(options.fields) ? options.fields : DEFAULT_SYNC_FIELDS;
  fields.forEach((field) => {
    if (typeof field !== 'string' || !field || updatedPlayer[field] === undefined) return;
    sessionPlayer[field] = cloneValue(updatedPlayer[field]);
  });

  if (options.mergeSystemUnlockInfo === true && updatedPlayer.systemUnlockInfo !== undefined) {
    sessionPlayer.systemUnlockInfo = mergeSystemUnlockInfo(
      sessionPlayer.systemUnlockInfo,
      updatedPlayer.systemUnlockInfo
    );
  }

  if (typeof options.initializePlayer === 'function') {
    options.initializePlayer(sessionPlayer);
  }

  return sessionPlayer;
}

module.exports = {
  DEFAULT_SYNC_FIELDS,
  mergeSystemUnlockInfo,
  syncSessionPlayerFields,
};
