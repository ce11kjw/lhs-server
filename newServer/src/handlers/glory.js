/**
 * Glory handlers
 * tag: 6600 glory info + notice list
 */

const playerService = require('../services/PlayerService');
const messageService = require('../services/MessageService');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function normalizeObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function ensureArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizeGloryRow(raw) {
  const row = normalizeObject(raw);
  return {
    id: Math.max(0, toSafeInt(row.id, 0)),
    record: Math.max(0, toSafeInt(row.record, 0)),
    updateTime: Math.max(0, toSafeInt(row.updateTime, toSafeInt(row.time, 0))),
  };
}

function normalizeGloryRecordRow(raw) {
  const row = normalizeObject(raw);
  return {
    id: Math.max(0, toSafeInt(row.id, 0)),
    record: Math.max(0, toSafeInt(row.record, 0)),
    time: Math.max(0, toSafeInt(row.time, Date.now())),
    text: row.text == null ? '' : String(row.text),
  };
}

function ensureGloryInfo(player = {}) {
  player.other_attr_info = normalizeObject(player.other_attr_info);
  const holder = player.other_attr_info;

  holder.gloryInfo = normalizeObject(holder.gloryInfo);
  const info = holder.gloryInfo;

  info.gloryTotal = ensureArray(info.gloryTotal).map(normalizeGloryRow).filter((row) => row.id > 0);
  info.gloryAch = ensureArray(info.gloryAch).map(normalizeGloryRow).filter((row) => row.id > 0);
  info.gloryRecords = ensureArray(info.gloryRecords)
    .map(normalizeGloryRecordRow)
    .filter((row) => row.id > 0)
    .slice(-100);
  info.noticeList = ensureArray(info.noticeList)
    .map((value) => Math.max(0, toSafeInt(value, 0)))
    .filter((value) => value > 0)
    .slice(-50);
  info.updatedAt = Date.now();

  return info;
}

function buildGloryPayload(info = {}, player = null) {
  return {
    gloryTotal: ensureArray(info.gloryTotal),
    gloryAch: ensureArray(info.gloryAch),
    gloryRecords: ensureArray(info.gloryRecords),
    noticeList: ensureArray(info.noticeList),
    dialogList: player ? messageService.listPlayerDialogs(player) : [],
  };
}

function normalizeGloryUpdateRows(rows) {
  const byId = new Map();
  ensureArray(rows).map(normalizeGloryRow).forEach((row) => {
    if (row.id > 0) byId.set(row.id, row);
  });
  return Array.from(byId.values());
}

function buildGloryTotalUpdatePacket(glories) {
  return {
    tag: 6601,
    msgUid: 0,
    data: { glories: normalizeGloryUpdateRows(glories) },
  };
}

function buildGloryAchievementUpdatePacket(glories) {
  return {
    tag: 6602,
    msgUid: 0,
    data: { glories: normalizeGloryUpdateRows(glories) },
  };
}

function buildGloryRecordUpdatePacket(record) {
  return {
    tag: 6603,
    msgUid: 0,
    data: { record: normalizeGloryRecordRow(record) },
  };
}

async function persistPlayer(session, player) {
  if (!session || !session.userId) return;
  const saved = await playerService.savePlayer(session.userId, player);
  if (saved && typeof saved === 'object') {
    session.player = saved;
  }
}

async function handleGloryInfo(_params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 6600,
      msgUid,
      data: {
        gloryTotal: [],
        gloryAch: [],
        gloryRecords: [],
        noticeList: [],
        dialogList: [],
      },
    };
  }

  const info = ensureGloryInfo(player);
  await persistPlayer(session, player);

  return [
    { tag: 6600, msgUid, data: buildGloryPayload(info, player) },
    buildGloryTotalUpdatePacket(info.gloryTotal),
    buildGloryAchievementUpdatePacket(info.gloryAch),
    ...info.gloryRecords.map(buildGloryRecordUpdatePacket),
  ];
}

module.exports = {
  ensureGloryInfo,
  buildGloryPayload,
  buildGloryTotalUpdatePacket,
  buildGloryAchievementUpdatePacket,
  buildGloryRecordUpdatePacket,
  handleGloryInfo,
};
