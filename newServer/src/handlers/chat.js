const playerService = require('../services/PlayerService');
const messageService = require('../services/MessageService');
const runtimeBus = require('../services/RuntimeBus');
const battleService = require('../services/BattleService');
const {
  ensureRoleAppearance,
  getPlayerFashionMap,
  getPrimaryBattlePetId,
} = require('../services/RoleAppearanceService');

const CHAT_CHANNEL_WORLD = 0;
const CHAT_CHANNEL_SYSTEM = 1;
const MAX_CHAT_HISTORY = 100;

const historyMap = new Map([
  [CHAT_CHANNEL_WORLD, []],
  [CHAT_CHANNEL_SYSTEM, []],
]);

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function ensurePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function getDbid(player = {}) {
  if (player && player._id != null) return String(player._id);
  return String((player && (player.playerId || player.userId)) || '');
}

function getPlayerPower(player = {}) {
  const cached = toSafeInt(player.power || player.powerScore || player.combat || player.totalPower, 0);
  if (cached > 0) return cached;
  try {
    return Math.max(0, toSafeInt(battleService.calcPowerScore(battleService.calcPlayerPower(player)), 0));
  } catch (_err) {
    return Math.max(0, toSafeInt(player.level, 1) * 100);
  }
}

function ensureChannel(channel) {
  const safe = toSafeInt(channel, CHAT_CHANNEL_WORLD);
  if (!historyMap.has(safe)) historyMap.set(safe, []);
  return safe;
}

function pushHistory(channel, row) {
  const safe = ensureChannel(channel);
  const list = historyMap.get(safe);
  list.push(row);
  if (list.length > MAX_CHAT_HISTORY) {
    list.splice(0, list.length - MAX_CHAT_HISTORY);
  }
}

function getHistory(channel, maxCount = 30) {
  const safe = ensureChannel(channel);
  const list = historyMap.get(safe) || [];
  const count = Math.max(1, toSafeInt(maxCount, 30));
  return list.slice(Math.max(0, list.length - count));
}

function buildSummary(player = {}) {
  if (player && typeof player === 'object') {
    try { ensureRoleAppearance(player); } catch (_err) {}
  }
  const roleInfo = ensurePlainObject(player && player.roleInfo);
  const guildInfo = ensurePlainObject(player && player.guildInfo);
  const dbid = getDbid(player);
  const avatar = toSafeInt(roleInfo.avatar, toSafeInt(player.avatar, 0));
  const avatarFrame = toSafeInt(roleInfo.avatarFrame, toSafeInt(player.avatarFrame, 0));
  const title = toSafeInt(roleInfo.title, toSafeInt(player.title, 0));
  const power = getPlayerPower(player);
  const stage = Math.max(1, toSafeInt(roleInfo.stage, toSafeInt(roleInfo.stageId, 1)));
  const fashionMap = getPlayerFashionMap(player);
  return {
    dbid,
    playerId: player.playerId || dbid,
    userId: player.userId || '',
    name: player.name || '',
    avatar,
    avatarFrame,
    level: toSafeInt(player.level, 1),
    avatarUrl: player.avatarUrl || '',
    guildId: toSafeInt(guildInfo.guildId, 0),
    guildName: guildInfo.guildName || guildInfo.name || '',
    power,
    powerScore: power,
    title,
    serverId: toSafeInt(player.serverId, toSafeInt(process.env.SERVER_ID || process.env.DEFAULT_SERVER_ID, 1)),
    serverName: player.serverName || process.env.SERVER_NAME || '',
    kungfuId: toSafeInt(roleInfo.kungfuId, 4),
    subJob: toSafeInt(roleInfo.subJob, 0),
    stage,
    stageId: stage,
    gender: toSafeInt(roleInfo.gender, 0),
    petId: getPrimaryBattlePetId(player),
    petSoulId: -1,
    artifactId: 0,
    fate: 0,
    foreverCard: 0,
    equipMap: ensurePlainObject(player.equipMap),
    fashionMap,
    playerInfo: {
      dbid,
      level: toSafeInt(player.level, 1),
      avatar,
      avatarUrl: player.avatarUrl || '',
      avatarFrame,
      title,
    },
  };
}

function toJsonChatContent(params = {}) {
  const raw = params.content != null ? params.content : params.msg;
  const text = raw == null ? '' : String(raw).trim();
  const emoji = toSafeInt(params.emoji, 0);
  if (text.startsWith('{') && text.endsWith('}')) {
    return text;
  }
  if (!text && emoji <= 0) return '';

  const payload = { content: text };
  if (emoji > 0) payload.emoji = emoji;
  return JSON.stringify(payload);
}

function buildChatEntry(params = {}, player = {}, overrides = {}) {
  const content = overrides.content != null ? String(overrides.content) : toJsonChatContent(params);
  return {
    summary: overrides.summary || buildSummary(player),
    content,
    time: overrides.time != null ? toSafeInt(overrides.time, Date.now()) : Date.now(),
    sys: !!overrides.sys,
    chatFrame: toSafeInt(
      overrides.chatFrame != null ? overrides.chatFrame : params.chatFrame,
      overrides.sys ? 0 : -1,
    ),
    msgType: toSafeInt(overrides.msgType != null ? overrides.msgType : params.msgType, 0),
    reply: overrides.reply != null ? overrides.reply : (params.reply || null),
    reportId: overrides.reportId != null ? overrides.reportId : (params.reportId || ''),
  };
}

function buildChatInitPacket(channel, msgUid = 0, maxCount = 30) {
  return {
    tag: 1600,
    msgUid,
    data: {
      channel: ensureChannel(channel),
      list: getHistory(channel, maxCount),
      sysList: [],
    },
  };
}

function buildWorldChatPushPacket(channel, entry, msgUid = 0) {
  return {
    tag: 1601,
    msgUid,
    data: {
      channel,
      data: entry,
    },
  };
}

function pushWorldChat(channel, entry) {
  const wsServer = runtimeBus.getWsServer();
  if (wsServer && typeof wsServer.broadcast === 'function') {
    wsServer.broadcast(1601, {
      channel,
      data: entry,
    });
  }
}

function pushChatEntry(channel, entry, options = {}) {
  if (!entry || !entry.content) return;
  pushHistory(channel, entry);
  if (options.broadcast !== false) {
    pushWorldChat(channel, entry);
  }
}

function handleSendChat(params, session, msgUid, options = {}) {
  const player = session && session.player ? session.player : {};
  const adminStatus = player && player.adminStatus && typeof player.adminStatus === 'object' ? player.adminStatus : {};
  if (adminStatus.muted) {
    const muteUntil = toSafeInt(adminStatus.muteUntil, 0);
    if (muteUntil <= 0 || muteUntil > Date.now()) {
      return {
        tag: 1600,
        msgUid,
        data: {
          result: 2,
          channel: ensureChannel(params && params.channel),
          msg: adminStatus.muteReason || '当前账号已被禁言',
        },
      };
    }
    adminStatus.muted = false;
    player.adminStatus = adminStatus;
    if (typeof player.markModified === 'function') player.markModified('adminStatus');
  }
  const channel = ensureChannel(params && params.channel);
  const entry = buildChatEntry(params, player, {
    msgType: toSafeInt(params && params.msgType, 0),
    sys: false,
  });

  pushChatEntry(channel, entry, options);

  return {
    tag: 1600,
    msgUid,
    data: {
      result: 0,
      channel,
    },
  };
}

function pushSystemBroadcast(content, options = {}) {
  const text = content == null ? '' : String(content).trim();
  if (!text) return null;
  const entry = buildChatEntry({ content: text }, {}, {
    summary: {
      dbid: 'system',
      userId: 0,
      serverId: toSafeInt(process.env.SERVER_ID, 1),
      serverName: process.env.SERVER_NAME || '',
      name: options.name || '系统',
      avatar: toSafeInt(options.avatar, 0),
      avatarFrame: -1,
      level: 0,
      avatarUrl: '',
      guildId: 0,
      guildName: '',
      power: 0,
      title: 0,
      kungfuId: 0,
      subJob: 0,
    },
    sys: true,
    msgType: toSafeInt(options.msgType, 14),
    chatFrame: toSafeInt(options.chatFrame, 0),
    time: options.time,
    content: options.rawContent ? String(options.rawContent) : text,
  });
  pushHistory(CHAT_CHANNEL_SYSTEM, entry);
  messageService.pushGlobalNotice({
    type: 'broadcast',
    title: options.title || '系统广播',
    content: text,
    time: entry.time,
  });

  pushWorldChat(CHAT_CHANNEL_SYSTEM, entry);
  return entry;
}

async function handleWorldChat(params, session, msgUid) {
  const channel = ensureChannel(params && params.channel);
  if ((params && params.content) || (params && params.msg) || (params && params.emoji)) {
    return handleSendChat(params, session, msgUid);
  }
  return buildChatInitPacket(channel, msgUid, params && params.maxCount);
}

async function handleGetBlockPlayerList(params, session, msgUid) {
  const ids = Array.isArray(params && params.playerIds) ? params.playerIds : [];
  const infoList = [];

  for (const rawId of ids) {
    const dbid = String(rawId || '').trim();
    if (!dbid) continue;

    let row = null;
    try {
      if (typeof playerService.findByDbidOrPlayerId === 'function') {
        row = await playerService.findByDbidOrPlayerId(dbid);
      } else {
        row = await playerService.findByPlayerId(dbid);
      }
    } catch (_e) {
      row = null;
    }

    if (!row && session && session.player && (
      String(session.player.playerId || '') === dbid || String(session.player._id || '') === dbid
    )) {
      row = session.player;
    }

    infoList.push({ ...buildSummary(row || { playerId: dbid }), dbid });
  }

  return {
    tag: 1602,
    msgUid,
    data: {
      result: 0,
      infoList,
    },
  };
}

module.exports = {
  handleWorldChat,
  handleSendChat,
  handleGetBlockPlayerList,
  buildChatEntry,
  buildChatInitPacket,
  buildWorldChatPushPacket,
  buildSummary,
  pushChatEntry,
  pushSystemBroadcast,
  pushHistoryEntry: pushHistory,
  getChatHistory: getHistory,
  _debug: {
    historyMap,
    getHistory,
  },
};
