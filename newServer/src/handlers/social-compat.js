/**
 * Social compatibility handlers.
 * tag: 300/301/302/303
 */

const playerService = require('../services/PlayerService');
const { addRewardToPlayer } = require('./raid');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensureObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildRewardInfo(items = []) {
  return {
    items,
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

function normalizeRewardRows(rows) {
  const source = ensureArray(rows);
  const merged = new Map();
  source.forEach((row) => {
    const id = toSafeInt(row && row.id, 0);
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    merged.set(id, (merged.get(id) || 0) + count);
  });
  return Array.from(merged.entries()).map(([id, count]) => ({ id, count }));
}

function applyRewardRows(player, rows) {
  rows.forEach((row) => {
    addRewardToPlayer(player, row.id, row.count);
  });
}

function resolveItemRewardRows(params = {}) {
  const fromParam = normalizeRewardRows(params.rewards);
  if (fromParam.length > 0) return fromParam;

  const id = Math.max(0, toSafeInt(params.id, 0));
  if (id > 0) {
    // Keep reward content deterministic for playtest while preserving claim flow.
    return [{ id: 3, count: 50 + (id % 10) * 10 }];
  }
  return [{ id: 3, count: 50 }];
}

async function handleCommentGift(_params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 300, msgUid, data: { result: -1, commentGift: 0 } };
  }

  player.commentGift = Math.max(0, toSafeInt(player.commentGift, 0)) + 1;
  if (session.userId) {
    const saved = await playerService.savePlayer(session.userId, player);
    if (saved) session.player = saved;
  }

  return {
    tag: 300,
    msgUid,
    data: {
      result: 0,
      commentGift: player.commentGift,
    },
  };
}

async function handleFBReward(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 301, msgUid, data: { result: -1, type: 0 } };
  }

  const type = Math.max(0, toSafeInt(params.type, 0));
  player.fbGiftRecord = ensureObject(player.fbGiftRecord);
  if (type > 0 && !player.fbGiftRecord[type]) {
    player.fbGiftRecord[type] = 1;
  }
  if (type === 3) {
    player.fbShareCount = Math.max(0, toSafeInt(player.fbShareCount, 0)) + 1;
  }

  if (session.userId) {
    const saved = await playerService.savePlayer(session.userId, player);
    if (saved) session.player = saved;
  }

  return {
    tag: 301,
    msgUid,
    data: {
      result: 0,
      type,
      fbGiftRecord: player.fbGiftRecord,
      fbShareCount: Math.max(0, toSafeInt(player.fbShareCount, 0)),
    },
  };
}

async function handleItemReward(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 302, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };
  }

  const rows = resolveItemRewardRows(params);
  applyRewardRows(player, rows);
  if (session.userId) {
    const saved = await playerService.savePlayer(session.userId, player);
    if (saved) session.player = saved;
  }

  return {
    tag: 302,
    msgUid,
    data: {
      result: 0,
      id: Math.max(0, toSafeInt(params.id, 0)),
      rewardInfo: buildRewardInfo(rows),
    },
  };
}

async function handleReport(params = {}, session, msgUid) {
  const player = session && session.player;
  const targetPlayerId = String(params.playerId || '');
  const type = Math.max(0, toSafeInt(params.type, 0));

  if (!player || !targetPlayerId) {
    return { tag: 303, msgUid, data: { result: 2, playerId: targetPlayerId, type } };
  }

  player.other_attr_info = ensureObject(player.other_attr_info);
  const reportIds = new Set(ensureArray(player.other_attr_info.reportedPlayerIds).map((id) => String(id)));
  if (reportIds.has(targetPlayerId)) {
    return {
      tag: 303,
      msgUid,
      data: {
        result: 1,
        playerId: targetPlayerId,
        type,
      },
    };
  }

  reportIds.add(targetPlayerId);
  player.other_attr_info.reportedPlayerIds = Array.from(reportIds);
  if (session.userId) {
    const saved = await playerService.savePlayer(session.userId, player);
    if (saved) session.player = saved;
  }

  return {
    tag: 303,
    msgUid,
    data: {
      result: 0,
      playerId: targetPlayerId,
      type,
    },
  };
}

module.exports = {
  handleCommentGift,
  handleFBReward,
  handleItemReward,
  handleReport,
};
