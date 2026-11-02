/**
 * Battle share / playback compatibility handlers.
 * tag: 2310, 2311, 2351, 2352
 */

const playerService = require('../services/PlayerService');

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

function normalizeRecordId(value) {
  return String(value == null ? '' : value).trim();
}

function buildReplayFightResult(recordId, isCross = false) {
  const safeRecordId = normalizeRecordId(recordId) || 'replay';
  const enemyDbid = `${isCross ? 'cross' : 'share'}_${safeRecordId}`;
  return {
    type: 1,
    win: 1,
    mustChangeTurn: 0,
    notChangeTurn: 1,
    atkAttr: {},
    defAttr: {},
    events: [],
    entitys: [
      {
        id: 1,
        dbid: 'replay_self',
        name: 'ReplaySelf',
        side: 1,
        camp: 1,
        pos: 1,
        posIndex: 1,
        hp: 100,
        maxhp: 100,
        maxHp: 100,
      },
      {
        id: 2,
        dbid: enemyDbid,
        name: 'ReplayEnemy',
        side: 2,
        camp: 2,
        pos: -1,
        posIndex: -1,
        hp: 0,
        maxhp: 100,
        maxHp: 100,
      },
    ],
    guildBossAllDamage: 0,
    bloodlineOffset: 0,
  };
}

function ensureBattleShareInfo(player) {
  player.other_attr_info = ensureObject(player.other_attr_info);
  const root = ensureObject(player.other_attr_info.battleShareInfo);
  root.sharedRecords = ensureArray(root.sharedRecords).map((id) => String(id));
  root.sharedCrossRecords = ensureArray(root.sharedCrossRecords).map((id) => String(id));
  root.lastShareAt = Math.max(0, toSafeInt(root.lastShareAt, 0));
  player.other_attr_info.battleShareInfo = root;
  return root;
}

async function persistPlayer(session, player) {
  if (!session || !session.userId || !player) return;
  const saved = await playerService.savePlayer(session.userId, player);
  if (saved) session.player = saved;
}

async function handleShareFight(params = {}, session = {}, msgUid) {
  const player = session.player;
  const recordId = normalizeRecordId(params.recordId);
  const channel = Math.max(0, toSafeInt(params.channel, 0));
  if (!player || !recordId) {
    return { tag: 2310, msgUid, data: { result: 4, recordId, channel } };
  }

  const info = ensureBattleShareInfo(player);
  if (info.sharedRecords.includes(recordId)) {
    return { tag: 2310, msgUid, data: { result: 3, recordId, channel } };
  }

  info.sharedRecords.push(recordId);
  info.lastShareAt = Date.now();
  await persistPlayer(session, player);

  return {
    tag: 2310,
    msgUid,
    data: {
      result: 0,
      recordId,
      channel,
    },
  };
}

async function handleShareFightCross(params = {}, session = {}, msgUid) {
  const player = session.player;
  const recordId = normalizeRecordId(params.recordId);
  const channel = Math.max(0, toSafeInt(params.channel, 0));
  if (!player || !recordId) {
    return { tag: 2352, msgUid, data: { result: 4, recordId, channel } };
  }

  const info = ensureBattleShareInfo(player);
  if (info.sharedCrossRecords.includes(recordId)) {
    return { tag: 2352, msgUid, data: { result: 3, recordId, channel } };
  }

  info.sharedCrossRecords.push(recordId);
  info.lastShareAt = Date.now();
  await persistPlayer(session, player);

  return {
    tag: 2352,
    msgUid,
    data: {
      result: 0,
      recordId,
      channel,
    },
  };
}

async function handleShareCallbackFight(params = {}, _session = {}, msgUid) {
  const recordId = normalizeRecordId(params.recordId);
  return {
    tag: 2311,
    msgUid,
    data: {
      result: 0,
      recordId,
      fightResult: buildReplayFightResult(recordId, false),
    },
  };
}

async function handlePlayback(params = {}, _session = {}, msgUid) {
  const recordId = normalizeRecordId(params.recordId);
  return {
    tag: 2351,
    msgUid,
    data: {
      result: 0,
      recordId,
      fightResult: buildReplayFightResult(recordId, true),
    },
  };
}

module.exports = {
  handleShareFight,
  handleShareFightCross,
  handleShareCallbackFight,
  handlePlayback,
};
