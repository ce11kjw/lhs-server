/**
 * Community handlers
 * tag: 5300 wx moments interaction report
 */

const playerService = require('../services/PlayerService');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensureWxCircleInfo(player) {
  player.other_attr_info = player.other_attr_info && typeof player.other_attr_info === 'object' && !Array.isArray(player.other_attr_info)
    ? player.other_attr_info
    : {};

  const holder = player.other_attr_info;
  holder.wxCircleInfo = holder.wxCircleInfo && typeof holder.wxCircleInfo === 'object' && !Array.isArray(holder.wxCircleInfo)
    ? holder.wxCircleInfo
    : {};

  const info = holder.wxCircleInfo;
  info.zan = Math.max(0, toSafeInt(info.zan, 0));
  info.comment = Math.max(0, toSafeInt(info.comment, 0));
  info.zanGF = Math.max(0, toSafeInt(info.zanGF, 0));
  info.commentGF = Math.max(0, toSafeInt(info.commentGF, 0));
  info.browseTime = Math.max(0, toSafeInt(info.browseTime, 0));
  info.uploadCount = Math.max(0, toSafeInt(info.uploadCount, 0));
  info.lastUploadAt = Math.max(0, toSafeInt(info.lastUploadAt, 0));

  return info;
}

async function handleWxCircleInfo(params = {}, session = {}, msgUid) {
  const player = session && session.player;
  if (!player) {
    return {
      tag: 5300,
      msgUid,
      data: { result: -1 },
    };
  }

  const info = ensureWxCircleInfo(player);
  const next = {
    zan: Math.max(0, toSafeInt(params.zan, 0)),
    comment: Math.max(0, toSafeInt(params.comment, 0)),
    zanGF: Math.max(0, toSafeInt(params.zanGF, 0)),
    commentGF: Math.max(0, toSafeInt(params.commentGF, 0)),
    browseTime: Math.max(0, toSafeInt(params.browseTime, 0)),
  };

  // Client reports cumulative values; keep monotonic progress to avoid accidental rollback.
  info.zan = Math.max(info.zan, next.zan);
  info.comment = Math.max(info.comment, next.comment);
  info.zanGF = Math.max(info.zanGF, next.zanGF);
  info.commentGF = Math.max(info.commentGF, next.commentGF);
  info.browseTime = Math.max(info.browseTime, next.browseTime);
  info.uploadCount = Math.max(0, toSafeInt(info.uploadCount, 0)) + 1;
  info.lastUploadAt = Date.now();

  if (session.userId) {
    const saved = await playerService.savePlayer(session.userId, player);
    if (saved && typeof saved === 'object') {
      session.player = saved;
    }
  }

  return {
    tag: 5300,
    msgUid,
    data: {
      result: 0,
      zan: info.zan,
      comment: info.comment,
      zanGF: info.zanGF,
      commentGF: info.commentGF,
      browseTime: info.browseTime,
    },
  };
}

module.exports = {
  ensureWxCircleInfo,
  handleWxCircleInfo,
};
