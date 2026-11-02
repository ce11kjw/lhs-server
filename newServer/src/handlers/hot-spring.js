/** Hot spring protocol (7100-7106). */

const playerService = require('../services/PlayerService');
const { addRewardToPlayer } = require('./raid');

function int(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function rewardInfo(player, rows = []) {
  const items = [];
  rows.forEach((row) => {
    const id = Math.max(0, int(row && row.id, 0));
    const count = Math.max(0, int(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    addRewardToPlayer(player, id, count);
    items.push({ id, count });
  });
  return { items, equips: [], heros: [] };
}

function ensureHotSpringInfo(player) {
  player.other_attr_info = obj(player.other_attr_info);
  const info = player.other_attr_info.hotSpringInfo = obj(player.other_attr_info.hotSpringInfo);
  info.dailyRewardTime = Math.max(0, int(info.dailyRewardTime, 0));
  info.lastBathRewardTime = Math.max(0, int(info.lastBathRewardTime, 0));
  info.reject = int(info.reject, 0) ? 1 : 0;
  info.guildReward = Math.max(0, int(info.guildReward, 0));
  info.guildCanClaimed = Math.max(info.guildReward, int(info.guildCanClaimed, 1));
  info.lastGuildRewardTime = Math.max(0, int(info.lastGuildRewardTime, 0));
  info.tpRequest = obj(info.tpRequest);
  return info;
}

function buildHotSpringPayload(player) {
  const info = ensureHotSpringInfo(player);
  return {
    dailyRewardTime: info.dailyRewardTime,
    lastBathRewardTime: info.lastBathRewardTime,
    reject: info.reject,
    guildReward: info.guildReward,
    guildCanClaimed: info.guildCanClaimed,
  };
}

async function save(session) {
  if (session && session.userId && session.player) await playerService.savePlayer(session.userId, session.player);
}

async function handleHotSpringLaunch(params, session, msgUid) {
  const info = ensureHotSpringInfo(session.player);
  const launch = !!(params && params.launch);
  info.tpRequest = launch ? {
    state: 0,
    attackerId: String(session.player.playerId || session.userId || ''),
    defenderId: String((params && params.targetId) || ''),
    line: Math.max(0, int(params && params.line, 0)),
    timeout: Date.now() + 30000,
  } : {};
  if (launch) info.reject = 0;
  await save(session);
  return { tag: 7101, msgUid, data: { result: 0 } };
}

async function handleHotSpringAccept(params, session, msgUid) {
  const info = ensureHotSpringInfo(session.player);
  if (Object.keys(info.tpRequest).length > 0) {
    info.tpRequest.state = params && params.accept ? 2 : 3;
    info.tpRequest.line = Math.max(0, int(params && params.line, info.tpRequest.line));
  }
  await save(session);
  return { tag: 7102, msgUid, data: { result: 0 } };
}

async function handleHotSpringReward(_params, session, msgUid) {
  const info = ensureHotSpringInfo(session.player);
  const now = Date.now();
  const elapsed = info.lastBathRewardTime > 0 ? Math.max(0, now - info.lastBathRewardTime) : 1000;
  info.dailyRewardTime += Math.min(60000, elapsed);
  info.lastBathRewardTime = now;
  await save(session);
  return { tag: 7103, msgUid, data: { dailyRewardTime: info.dailyRewardTime, lastBathRewardTime: info.lastBathRewardTime } };
}

async function handleHotSpringGuildReward(_params, session, msgUid) {
  const info = ensureHotSpringInfo(session.player);
  let rewards = rewardInfo(session.player, []);
  if (info.guildReward < info.guildCanClaimed) {
    info.guildReward = info.guildCanClaimed;
    info.lastGuildRewardTime = Date.now();
    rewards = rewardInfo(session.player, [{ id: 2, count: 100 }]);
  }
  await save(session);
  return { tag: 7104, msgUid, data: { guildReward: info.guildReward, rewards } };
}

async function handleHotSpringRoomInfo(_params, session, msgUid) {
  const info = ensureHotSpringInfo(session.player);
  const actorId = String(session.player.playerId || session.userId || '');
  return {
    tag: 7105,
    msgUid,
    data: {
      infos: [{ line: 1, count: 1, max: 30, players: [{ id: actorId, dbid: actorId, name: session.player.name || 'Player' }] }],
      reject: info.reject,
    },
  };
}

async function handleHotSpringReject(params, session, msgUid) {
  const info = ensureHotSpringInfo(session.player);
  info.reject = int(params && params.reject, info.reject) ? 1 : 0;
  await save(session);
  return { tag: 7106, msgUid, data: { result: 0, reject: info.reject } };
}

module.exports = {
  ensureHotSpringInfo,
  buildHotSpringPayload,
  handleHotSpringLaunch,
  handleHotSpringAccept,
  handleHotSpringReward,
  handleHotSpringGuildReward,
  handleHotSpringRoomInfo,
  handleHotSpringReject,
};
