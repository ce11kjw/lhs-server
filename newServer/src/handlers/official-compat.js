/**
 * Compatibility handlers for protocol tags introduced by the latest official H5.
 * These handlers keep the wire shape stable and persist lightweight activity state.
 */

const playerService = require('../services/PlayerService');
const configService = require('../services/ConfigService');
const { addRewardToPlayer } = require('./raid');
const { ensureFashionInfo } = require('./fashion');

function safeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function state(player, key, fallback = {}) {
  player.other_attr_info = object(player.other_attr_info);
  if (!player.other_attr_info[key] || typeof player.other_attr_info[key] !== 'object') {
    player.other_attr_info[key] = JSON.parse(JSON.stringify(fallback));
  }
  return player.other_attr_info[key];
}

function rewardInfo(player, rows = []) {
  const merged = new Map();
  array(rows).forEach((row) => {
    const id = Math.max(0, safeInt(row && row.id, 0));
    const count = Math.max(0, safeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    addRewardToPlayer(player, id, count);
    merged.set(id, (merged.get(id) || 0) + count);
  });
  return { items: [...merged].map(([id, count]) => ({ id, count })), equips: [], heros: [] };
}

async function save(session) {
  if (session && session.userId && session.player) await playerService.savePlayer(session.userId, session.player);
}

function response(tag, msgUid, data = {}) {
  return { tag, msgUid, data };
}

async function handleClientTelemetry(params, session, msgUid) {
  const info = state(session.player, 'officialTelemetry', { records: [] });
  info.records = array(info.records);
  info.records.push({ ...object(params), time: Date.now() });
  if (info.records.length > 50) info.records = info.records.slice(-50);
  await save(session);
  return response(102, msgUid, { result: 0 });
}

async function handleServerReport(params, session, msgUid) {
  const info = state(session.player, 'serverReports', { records: [] });
  info.records = array(info.records);
  const playerId = params && params.playerId != null ? String(params.playerId) : '';
  if (info.records.some((row) => row.playerId === playerId)) return response(305, msgUid, { playerId, result: 1 });
  info.records.push({ playerId, serverId: safeInt(params && params.serverId, 0), type: safeInt(params && params.type, 0), time: Date.now() });
  await save(session);
  return response(305, msgUid, { playerId, result: 0 });
}

async function handleActivityDraw(params, session, msgUid) {
  const info = state(session.player, 'officialActivity', { draw: {}, backInvite: {}, pair: {} });
  const id = safeInt(params && params.id, 0);
  const type = safeInt(params && params.type, 0);
  const index = safeInt(params && params.index, 0);
  const key = `${id}:${type}`;
  const record = info.draw[key] || { count: 0, records: [] };
  record.count += 1;
  record.records = array(record.records);
  record.records[index] = safeInt(record.records[index], 0) + 1;
  info.draw[key] = record;
  await save(session);
  return response(1720, msgUid, { result: 0, records: { [index]: record.records[index] || 0 } });
}

async function handleBackInviteWrite(params, session, msgUid) {
  const info = state(session.player, 'officialActivity', { draw: {}, backInvite: {}, pair: {} });
  info.backInvite = { id: safeInt(params && params.id, 0), code: String((params && params.code) || '').slice(0, 64), time: Date.now() };
  await save(session);
  return response(1775, msgUid, { result: 0, record: info.backInvite, extra: {} });
}

async function handleBackReward(_params, session, msgUid) {
  const info = state(session.player, 'officialActivity', { draw: {}, backInvite: {}, pair: {} });
  if (info.backInvite && info.backInvite.claimed) return response(1792, msgUid, { rewardInfo: { items: [], equips: [] } });
  if (info.backInvite) info.backInvite.claimed = true;
  const reward = rewardInfo(session.player, [{ id: 2, count: 100 }]);
  await save(session);
  return response(1792, msgUid, { rewardInfo: reward });
}

function normalizePairBoard(value) {
  const source = array(value);
  return Array.from({ length: 9 }, (_unused, index) => {
    const cell = safeInt(source[index], 0);
    if (cell < 0) return -1;
    return cell > 0 ? cell : (index % 7) + 1;
  });
}

function ensurePairState(info) {
  info.pair = object(info.pair);
  const pair = info.pair;
  pair.round = Math.max(0, safeInt(pair.round, 0));
  pair.refresh = Math.max(0, safeInt(pair.refresh, 0));
  pair.talent = Math.max(0, safeInt(pair.talent, 0));
  pair.colors = array(pair.colors)
    .map((value) => Math.max(0, safeInt(value, 0)))
    .filter((value, index, rows) => value > 0 && value <= 7 && rows.indexOf(value) === index);
  pair.totalScore = Math.max(0, safeInt(pair.totalScore, 0));
  pair.records = array(pair.records);
  pair.roundInfo = object(pair.roundInfo);
  pair.roundInfo.board = normalizePairBoard(pair.roundInfo.board);
  pair.roundInfo.score = Math.max(0, safeInt(pair.roundInfo.score, 0));
  pair.roundInfo.multi = Math.max(1, safeInt(pair.roundInfo.multi, 1));
  pair.roundInfo.box = Math.max(0, safeInt(pair.roundInfo.box, 0));
  return pair;
}

function makePairBoard(seed = 0) {
  const offset = Math.max(0, safeInt(seed, 0)) % 7;
  return Array.from({ length: 9 }, (_unused, index) => ((index * 2 + offset) % 7) + 1);
}

function emptyPairRewardInfo() {
  return { items: [], equips: [], heros: [] };
}

async function handlePair(tag, params, session, msgUid) {
  const info = state(session.player, 'officialActivity', { draw: {}, backInvite: {}, pair: {} });
  const pair = ensurePairState(info);
  const request = object(params);
  let data = { result: 0 };

  if (tag === 1795) {
    pair.colors = array(request.colors)
      .map((value) => Math.max(0, safeInt(value, 0)))
      .filter((value, index, rows) => value > 0 && value <= 7 && rows.indexOf(value) === index);
  } else if (tag === 1796) {
    pair.refresh += 1;
    pair.talent = (pair.refresh % 9) + 1;
    data = { result: 0, talent: pair.talent, refresh: pair.refresh };
  } else if (tag === 1797) {
    pair.round += 1;
    const multi = Math.max(1, safeInt(request.multi, 1));
    pair.roundInfo = {
      board: makePairBoard(pair.round + pair.refresh),
      score: 0,
      multi,
      box: 0,
    };
    if (safeInt(request.skip, 0) > 0) {
      const score = 9 * multi;
      pair.roundInfo.score = score;
      pair.totalScore += score;
      data = { result: 0, score: pair.totalScore, rewardInfo: emptyPairRewardInfo(), effects: [] };
    } else {
      data = { result: 0, roundInfo: clone(pair.roundInfo), effects: [] };
    }
  } else if (tag === 1798) {
    const board = normalizePairBoard(pair.roundInfo.board);
    const positions = array(request.pos)
      .map((value) => safeInt(value, -1))
      .filter((value, index, rows) => value >= 0 && value < board.length && rows.indexOf(value) === index);
    const firstCell = positions.length > 0 ? board[positions[0]] : 1;
    positions.forEach((index) => { board[index] = -1; });
    const score = positions.length * Math.max(1, safeInt(pair.roundInfo.multi, 1));
    const box = positions.length > 0 ? 1 : 0;
    const effect = { type: 1, id: Math.max(1, Math.abs(safeInt(firstCell, 1)) % 100), box };
    pair.roundInfo.board = board;
    pair.roundInfo.score += score;
    pair.roundInfo.box += box;
    pair.totalScore += score;
    data = { result: 0, board: clone(board), score, effects: positions.length > 0 ? [[effect]] : [[]] };
  } else if (tag === 1799) {
    const oldBoard = normalizePairBoard(pair.roundInfo.board);
    const board = oldBoard.map((cell, index) => (cell < 0 ? ((pair.round + pair.refresh + index) % 7) + 1 : cell));
    pair.roundInfo.board = board;
    data = { result: 0, board: clone(board), box: pair.roundInfo.box, effects: [] };
  }

  pair.records.push({ tag, data: object(params), time: Date.now() });
  if (pair.records.length > 100) pair.records = pair.records.slice(-100);
  await save(session);
  return response(tag, msgUid, data);
}

async function handleFashionExpired(params, session, msgUid) {
  const ids = Array.from(new Set(
    array(params && params.ids).map((id) => safeInt(id, 0)).filter((id) => id > 0)
  ));
  if (!session || !session.player) return response(1811, msgUid, { ids: [] });

  const info = ensureFashionInfo(session.player);
  const expired = new Set(ids);
  const fashionCfg = object(configService.get('FashionConfig'));
  info.fashionData = array(info.fashionData).filter((row) => !expired.has(safeInt(row && row.id, 0)));
  info.activateFashion = array(info.activateFashion).filter((id) => !expired.has(safeInt(id, 0)));
  ids.forEach((id) => {
    delete info.fashions[String(id)];
    const cfg = fashionCfg[id] || fashionCfg[String(id)] || null;
    const type = Math.max(0, safeInt(cfg && cfg.type, 0));
    ['fashion', 'curFashion', 'fashionMap', 'equipped', 'dress'].forEach((field) => {
      const holder = object(info[field]);
      Object.keys(holder).forEach((key) => {
        if (safeInt(holder[key], 0) === id || (type > 0 && safeInt(key, 0) === type)) holder[key] = 0;
      });
      info[field] = holder;
    });
  });
  await save(session);
  return response(1811, msgUid, { ids });
}

async function handleMainPanelChange(params, session, msgUid) {
  const info = state(session.player, 'officialActivity', { draw: {}, backInvite: {}, pair: {} });
  info.mainPanel = safeInt(params && params.id, 0);
  await save(session);
  return [
    response(1803, 0, { mainPanel: info.mainPanel }),
    response(1812, msgUid, { result: 0, mainPanel: info.mainPanel }),
  ];
}

async function handleReportFight(_params, session, msgUid) {
  const info = state(session.player, 'officialActivity', { draw: {}, backInvite: {}, pair: {} });
  info.reportedFight = safeInt(_params && _params.recordId, 0);
  await save(session);
  return response(2312, msgUid, { result: 0 });
}

async function handleSubscribeOff(params, session, msgUid) {
  const info = state(session.player, 'officialSubscriptions', { disabled: [] });
  info.disabled = array(params && params.types).map((v) => safeInt(v, 0)).filter((v) => v > 0);
  await save(session);
  return response(11102, msgUid, { result: 0 });
}

async function handleNoop(tag, params, session, msgUid) {
  if (session && session.player) {
    const info = state(session.player, 'officialCompat', { records: [] });
    info.records = array(info.records);
    info.records.push({ tag, data: object(params), time: Date.now() });
    if (info.records.length > 100) info.records = info.records.slice(-100);
    await save(session);
  }
  return response(tag, msgUid, { result: 0 });
}

module.exports = {
  handleClientTelemetry,
  handleServerReport,
  handleActivityDraw,
  handleBackInviteWrite,
  handleBackReward,
  handlePair,
  handleFashionExpired,
  handleMainPanelChange,
  handleReportFight,
  handleSubscribeOff,
  handleNoop,
};
