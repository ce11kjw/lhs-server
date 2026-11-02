/**
 * Fashion handlers
 * tags: 1800, 1801, 1802, 1803, 1804, 1805, 1806, 1810
 */

const playerService = require('../services/PlayerService');
const { ensureRoleAppearance } = require('../services/RoleAppearanceService');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function toSignedInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function ensureObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function ensureArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function ensureFashionInfo(player = {}) {
  player.fashionInfo = ensureObject(player.fashionInfo);
  const info = player.fashionInfo;

  info.curFashion = ensureObject(info.curFashion);
  info.fashions = ensureObject(info.fashions);
  info.suits = ensureObject(info.suits);
  info.suitColors = ensureObject(info.suitColors);
  info.starUp = ensureObject(info.starUp);
  info.sets = ensureArray(info.sets);
  info.setId = Math.max(0, toSafeInt(info.setId, toSafeInt(info.curSetId, 0)));
  info.setNames = ensureObject(info.setNames);
  info.emojiGroups = ensureArray(info.emojiGroups);
  info.emojis = ensureArray(info.emojis);
  info.emoji = ensureArray(info.emoji);
  info.equipped = ensureObject(info.equipped);
  info.dress = ensureObject(info.dress);
  info.fashion = ensureObject(info.fashion);
  info.fashionMap = ensureObject(info.fashionMap);
  info.fashionData = ensureArray(info.fashionData);
  info.activateFashion = ensureArray(info.activateFashion);
  info.updatedAt = Date.now();

  return info;
}

function ensureSetRecord(info, setId) {
  const safeSetId = Math.max(0, toSafeInt(setId, info.setId));
  let row = info.sets.find((item) => toSafeInt(item && item.id, -1) === safeSetId);
  if (!row) {
    row = { id: safeSetId, name: info.setNames[String(safeSetId)] || null };
    info.sets.push(row);
    info.sets.sort((a, b) => toSafeInt(a && a.id, 0) - toSafeInt(b && b.id, 0));
  }
  return row;
}

function syncFashionSelection(player, info, type, id) {
  const typeKey = String(type);
  info.fashion[typeKey] = id;
  info.curFashion[typeKey] = id;
  info.fashionMap[typeKey] = id;
  info.equipped[typeKey] = id;

  if (id > 0) {
    info.fashions[String(id)] = 1;
    if (!info.activateFashion.includes(id)) {
      info.activateFashion.push(id);
    }
  }

  player.roleInfo = ensureObject(player.roleInfo);
  if (type === 101 && id > 0) {
    player.title = id;
    player.roleInfo.title = id;
  }
  if (type === 102 && id > 0) {
    player.avatar = id;
    player.roleInfo.avatar = id;
  }
  if (type === 103 && id > 0) {
    player.avatarFrame = id;
    player.roleInfo.avatarFrame = id;
  }
}

function buildFashionRows(info) {
  const rows = [];
  Object.keys(info.fashion || {}).forEach((typeKey) => {
    const type = Math.max(0, toSafeInt(typeKey, 0));
    const id = toSignedInt(info.fashion[typeKey], 0);
    if (type <= 0 || id <= 0) return;
    rows.push({ type, id });
  });
  rows.sort((a, b) => a.type - b.type);
  return rows;
}

function buildEmojiList(info) {
  const groups = Array.from(new Set(ensureArray(info.emojiGroups).map((v) => Math.max(0, toSafeInt(v, 0))).filter((v) => v > 0)));
  groups.sort((a, b) => a - b);
  info.emojiGroups = groups;
  info.emoji = groups;
  return groups;
}

function buildFashionDataPayload(info) {
  const data = ensureArray(info.fashionData)
    .map((row) => (row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : null))
    .filter((row) => row && toSafeInt(row.id, 0) > 0);
  const fashion = Array.from(new Set(
    ensureArray(info.activateFashion)
      .map((id) => Math.max(0, toSafeInt(id, 0)))
      .filter((id) => id > 0)
  )).sort((a, b) => a - b);
  info.fashionData = data;
  info.activateFashion = fashion;
  return { result: 0, data, fashion };
}

function isFashionChangeRequest(params = {}) {
  return !!(params && typeof params === 'object' && !Array.isArray(params) && params.type != null);
}

async function persistPlayer(session, player) {
  if (!session || !session.userId) return;
  const saved = await playerService.savePlayer(session.userId, player);
  if (saved && typeof saved === 'object') {
    session.player = saved;
  }
}

async function handleFashionData(_params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1800, msgUid, data: { result: -1, data: [], fashion: [] } };
  }

  ensureRoleAppearance(player);
  const info = ensureFashionInfo(player);
  return {
    tag: 1800,
    msgUid,
    data: buildFashionDataPayload(info),
  };
}

async function handleChangeFashion(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1801, msgUid, data: { result: -1, id: 0, type: 0, setId: 0 } };
  }

  ensureRoleAppearance(player);
  const info = ensureFashionInfo(player);
  const type = Math.max(1, toSafeInt(params.type, 0));
  const id = toSignedInt(params.id, 0);
  const setRaw = params.set == null ? info.setId : toSignedInt(params.set, info.setId);

  syncFashionSelection(player, info, type, id);
  if (setRaw >= 0) {
    info.setId = Math.max(0, setRaw);
    ensureSetRecord(info, info.setId);
  }

  await persistPlayer(session, player);
  return {
    tag: 1801,
    msgUid,
    data: {
      result: 0,
      id,
      type,
      setId: info.setId,
    },
  };
}

async function handleChangeSuit(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1802, msgUid, data: { result: -1, fashion: [] } };
  }

  ensureRoleAppearance(player);
  const info = ensureFashionInfo(player);
  const id = Math.max(0, toSafeInt(params.id, 0));
  const color = Math.max(0, toSafeInt(params.color, 0));
  const setId = Math.max(0, toSafeInt(params.set, info.setId));
  const type = Math.max(1, toSafeInt(params.type, 1));

  if (id > 0) {
    syncFashionSelection(player, info, type, id);
  }
  info.setId = setId;
  ensureSetRecord(info, setId);
  info.suits[String(setId)] = { id, color, type };

  await persistPlayer(session, player);
  return {
    tag: 1802,
    msgUid,
    data: {
      result: 0,
      fashion: buildFashionRows(info),
      setId: info.setId,
    },
  };
}

async function handleSuitColorUnlock(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1803, msgUid, data: { result: -1, id: 0, color: 0 } };
  }

  const info = ensureFashionInfo(player);
  const id = Math.max(0, toSafeInt(params.id, 0));
  const color = Math.max(0, toSafeInt(params.color, 0));
  const key = String(id);

  const list = ensureArray(info.suitColors[key]).map((v) => Math.max(0, toSafeInt(v, 0))).filter((v) => v > 0);
  if (color > 0 && !list.includes(color)) {
    list.push(color);
    list.sort((a, b) => a - b);
  }
  info.suitColors[key] = list;

  const replace = Math.max(0, toSafeInt(params.replace, 0));
  if (replace > 0 && id > 0) {
    const setKey = String(info.setId);
    const current = ensureObject(info.suits[setKey]);
    info.suits[setKey] = {
      ...current,
      id,
      color,
      type: Math.max(1, toSafeInt(current.type, 1)),
    };
  }

  await persistPlayer(session, player);
  return {
    tag: 1803,
    msgUid,
    data: { result: 0, id, color },
  };
}

async function handleDressStarUp(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1804, msgUid, data: { result: -1, data: { id: 0, star: 0 } } };
  }

  const info = ensureFashionInfo(player);
  const id = Math.max(0, toSafeInt(params.id, 0));
  const star = Math.max(0, toSafeInt(params.star, 0));
  info.starUp[String(id)] = star;
  info.dress[String(id)] = { id, star };

  await persistPlayer(session, player);
  return {
    tag: 1804,
    msgUid,
    data: {
      result: 0,
      data: { id, star },
    },
  };
}

async function handleFashionChangeSet(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1805, msgUid, data: { result: -1, setId: 0 } };
  }

  const info = ensureFashionInfo(player);
  const setId = Math.max(0, toSafeInt(params.setId, 0));
  info.setId = setId;
  ensureSetRecord(info, setId);

  await persistPlayer(session, player);
  return {
    tag: 1805,
    msgUid,
    data: { result: 0, setId },
  };
}

async function handleFashionRenameSet(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1806, msgUid, data: { result: -1, name: '' } };
  }

  const info = ensureFashionInfo(player);
  const setId = Math.max(0, toSafeInt(params.setId, 0));
  const name = params.name == null ? '' : String(params.name).slice(0, 24);
  info.setNames[String(setId)] = name;
  ensureSetRecord(info, setId).name = name;

  await persistPlayer(session, player);
  return {
    tag: 1806,
    msgUid,
    data: { result: 0, setId, name },
  };
}

async function handlePurchaseEmojiGroup(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1810, msgUid, data: { result: -1, emoji: [] } };
  }

  const info = ensureFashionInfo(player);
  const group = Math.max(0, toSafeInt(params.group, 0));
  if (group > 0 && !info.emojiGroups.includes(group)) {
    info.emojiGroups.push(group);
  }
  const emoji = buildEmojiList(info);

  await persistPlayer(session, player);
  return {
    tag: 1810,
    msgUid,
    data: { result: 0, emoji },
  };
}

module.exports = {
  ensureFashionInfo,
  isFashionChangeRequest,
  handleFashionData,
  handleChangeFashion,
  handleChangeSuit,
  handleSuitColorUnlock,
  handleDressStarUp,
  handleFashionChangeSet,
  handleFashionRenameSet,
  handlePurchaseEmojiGroup,
};
