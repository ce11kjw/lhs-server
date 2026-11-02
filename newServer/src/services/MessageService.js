const MAX_GLOBAL_NOTICE_HISTORY = 50;
const MAX_PLAYER_NOTICE_HISTORY = 50;
const MAX_PLAYER_DIALOG_HISTORY = 50;

const runtimeState = {
  globalNotices: [],
};

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.floor(num) : fallback;
}

function ensureObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function trimHistory(list, limit) {
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }
  return list;
}

function ensureMessageCenter(player = {}) {
  player.other_attr_info = ensureObject(player.other_attr_info);
  const holder = player.other_attr_info;
  holder.messageCenter = ensureObject(holder.messageCenter);
  const center = holder.messageCenter;

  center.notices = ensureArray(center.notices)
    .filter((row) => row && typeof row === 'object')
    .slice(-MAX_PLAYER_NOTICE_HISTORY);
  center.dialogs = ensureArray(center.dialogs)
    .filter((row) => row && typeof row === 'object')
    .slice(-MAX_PLAYER_DIALOG_HISTORY);

  return center;
}

function normalizeNoticeRow(raw = {}) {
  const row = ensureObject(raw);
  const content = row.content == null ? '' : String(row.content).trim();
  return {
    id: row.id || `notice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: row.type == null ? 'system' : String(row.type),
    title: row.title == null ? '' : String(row.title),
    content,
    time: Math.max(0, toSafeInt(row.time, Date.now())),
    read: toSafeInt(row.read, 0) > 0 ? 1 : 0,
  };
}

function normalizeDialogRow(raw = {}) {
  const row = ensureObject(raw);
  return {
    id: row.id || `dialog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sceneId: Math.max(0, toSafeInt(row.sceneId, 0)),
    from: row.from == null ? 'system' : String(row.from),
    title: row.title == null ? '' : String(row.title),
    content: row.content == null ? '' : String(row.content),
    time: Math.max(0, toSafeInt(row.time, Date.now())),
    read: toSafeInt(row.read, 0) > 0 ? 1 : 0,
  };
}

function pushGlobalNotice(raw = {}) {
  const row = normalizeNoticeRow(raw);
  if (!row.content) return null;
  runtimeState.globalNotices.push(row);
  trimHistory(runtimeState.globalNotices, MAX_GLOBAL_NOTICE_HISTORY);
  return row;
}

function pushPlayerNotice(player = {}, raw = {}) {
  const row = normalizeNoticeRow(raw);
  if (!row.content) return null;
  const center = ensureMessageCenter(player);
  center.notices.push(row);
  trimHistory(center.notices, MAX_PLAYER_NOTICE_HISTORY);
  return row;
}

function pushPlayerDialog(player = {}, raw = {}) {
  const row = normalizeDialogRow(raw);
  if (!row.content) return null;
  const center = ensureMessageCenter(player);
  center.dialogs.push(row);
  trimHistory(center.dialogs, MAX_PLAYER_DIALOG_HISTORY);
  return row;
}

function listGlobalNoticeTexts(limit = MAX_GLOBAL_NOTICE_HISTORY) {
  return runtimeState.globalNotices
    .slice(-Math.max(1, toSafeInt(limit, MAX_GLOBAL_NOTICE_HISTORY)))
    .map((row) => row.content)
    .filter(Boolean);
}

function listPlayerNoticeTexts(player = {}, limit = MAX_PLAYER_NOTICE_HISTORY) {
  const center = ensureMessageCenter(player);
  return center.notices
    .slice(-Math.max(1, toSafeInt(limit, MAX_PLAYER_NOTICE_HISTORY)))
    .map((row) => row.content == null ? '' : String(row.content))
    .filter(Boolean);
}

function listPlayerDialogs(player = {}, limit = MAX_PLAYER_DIALOG_HISTORY) {
  const center = ensureMessageCenter(player);
  return center.dialogs.slice(-Math.max(1, toSafeInt(limit, MAX_PLAYER_DIALOG_HISTORY)));
}

function mergeUniqueTexts(...groups) {
  const seen = new Set();
  const result = [];
  groups.forEach((group) => {
    ensureArray(group).forEach((row) => {
      const text = row == null ? '' : String(row).trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      result.push(text);
    });
  });
  return result;
}

module.exports = {
  ensureMessageCenter,
  pushGlobalNotice,
  pushPlayerNotice,
  pushPlayerDialog,
  listGlobalNoticeTexts,
  listPlayerNoticeTexts,
  listPlayerDialogs,
  mergeUniqueTexts,
  _debug: {
    runtimeState,
  },
};
