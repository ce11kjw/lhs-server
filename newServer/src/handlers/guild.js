const Guild = require('../db/models/Guild');
const playerService = require('../services/PlayerService');
const configService = require('../services/ConfigService');
const battleService = require('../services/BattleService');
const runtimeBus = require('../services/RuntimeBus');
const { addGuildJoinCount } = require('../services/MainTaskProgressService');
const { buildRewardItemSync } = require('../services/RewardSync');
const { addRewardToPlayer } = require('./raid');

const MAX_GUILD_CHAT_HISTORY = 80;
const guildChatMap = new Map();
const MAX_GUILD_EXCHANGE_HISTORY = 120;
const guildExchangeMap = new Map();
const MAX_GUILD_RECORD_HISTORY = 120;
const guildRecordMap = new Map();
const MAX_GUILD_BATTLE_LOG = 100;
const guildBattleLogMap = new Map();
const MEMBER_PLAYER_CACHE_TTL_MS = 60000;
const MAX_MEMBER_PLAYER_CACHE = 1000;
const memberPlayerCache = new Map();

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function toSafeString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function createDefaultGuildPlayerData() {
  return {
    guildId: 0,
    guildName: '',
    identity: 3,
    activation: 0,
    joinTime: 0,
    donateCount: 0,
    dailyReward: [],
    leaveTime: 0,
    blessLv: 1,
    blessValue: 0,
    blessRewards: [],
    blessRecords: [],
    blessCount: 0,
    blessRecord: 0,
    blessDailyClaimTime: 0,
    bossAssist: 0,
    bossCount: 0,
    bossReward: [],
    bossGuildId: 0,
    totalDamage: 0,
    autoJoin: 0,
    needLevel: 0,
    searchable: 1,
    templeBuffId: 0,
    templeBuffTime: 0,
    dailyResetTime: 0,
    assistRecords: [],
    damageRecords: [],
  };
}

function calcGuildActivation(guildInfo = {}) {
  return Math.max(
    0,
    toSafeInt(guildInfo.donateCount, 0)
      + toSafeInt(guildInfo.blessCount, 0)
      + toSafeInt(guildInfo.bossAssist, 0)
  );
}

function syncGuildActivation(guildInfo = {}) {
  const activation = calcGuildActivation(guildInfo);
  guildInfo.activation = activation;
  return activation;
}

function getGuildDonateActivationGain() {
  const baseCfg = configService.get('GuildBaseConfig') || {};
  return Math.max(0, toSafeInt(baseCfg.guildDonate, 5));
}

function getGuildBlessActivationGain() {
  const baseCfg = configService.get('GuildBaseConfig') || {};
  return Math.max(0, toSafeInt(baseCfg.blessCount, 1));
}

function getGuildAssistActivationGain() {
  return 1;
}

function getPlayerDbid(player = {}, fallback = '') {
  return toSafeString(
    player.playerId
    || player.playerid
    || player.dbid
    || player._id
    || player.userId
    || fallback
  );
}

function getMemberDbid(member = {}, fallback = '') {
  return toSafeString(
    member.playerid
    || member.playerId
    || member.dbid
    || member._id
    || member.userId
    || fallback
  );
}

function ensureGuildPlayerData(player = {}) {
  if (!player.guildInfo || typeof player.guildInfo !== 'object' || Array.isArray(player.guildInfo)) {
    player.guildInfo = createDefaultGuildPlayerData();
    return player.guildInfo;
  }

  const data = player.guildInfo;
  const defaults = createDefaultGuildPlayerData();
  Object.keys(defaults).forEach((key) => {
    if (data[key] === undefined || data[key] === null) {
      data[key] = defaults[key];
    }
  });

  if (!Array.isArray(data.dailyReward)) data.dailyReward = [];
  if (!Array.isArray(data.bossReward)) data.bossReward = [];
  if (!Array.isArray(data.assistRecords)) data.assistRecords = [];
  if (!Array.isArray(data.damageRecords)) data.damageRecords = [];
  if (!Array.isArray(data.blessRewards)) data.blessRewards = [];
  if (!Array.isArray(data.blessRecords)) data.blessRecords = [];

  data.guildId = toSafeInt(data.guildId, 0);
  data.identity = toSafeInt(data.identity, data.guildId > 0 ? 2 : 3);
  data.activation = toSafeInt(data.activation, 0);
  data.joinTime = toSafeInt(data.joinTime, 0);
  data.leaveTime = toSafeInt(data.leaveTime, 0);
  data.donateCount = toSafeInt(data.donateCount, 0);
  data.blessLv = Math.max(1, toSafeInt(data.blessLv, 1));
  data.blessValue = Math.max(0, toSafeInt(data.blessValue, 0));
  data.blessCount = toSafeInt(data.blessCount, 0);
  data.blessRecord = toSafeInt(data.blessRecord, 0);
  data.blessDailyClaimTime = toSafeInt(data.blessDailyClaimTime, 0);
  data.bossAssist = toSafeInt(data.bossAssist, 0);
  data.bossCount = toSafeInt(data.bossCount, 0);
  data.bossGuildId = toSafeInt(data.bossGuildId, 0);
  data.totalDamage = Math.max(0, toSafeInt(data.totalDamage, 0));
  data.guildName = toSafeString(data.guildName);
  data.autoJoin = toSafeInt(data.autoJoin, 0);
  data.needLevel = Math.max(0, toSafeInt(data.needLevel, 0));
  data.searchable = toSafeInt(data.searchable, 1);
  data.templeBuffId = toSafeInt(data.templeBuffId, 0);
  data.templeBuffTime = toSafeInt(data.templeBuffTime, 0);
  const today = startOfDay(Date.now());
  if (startOfDay(data.dailyResetTime || 0) < today) {
    data.donateCount = 0;
    data.dailyReward = [];
    data.blessCount = 0;
    data.blessRecord = 0;
    data.blessDailyClaimTime = 0;
    data.bossAssist = 0;
    data.bossCount = 0;
    data.bossReward = [];
    data.dailyResetTime = today;
  } else {
    data.dailyResetTime = toSafeInt(data.dailyResetTime, today);
  }
  syncGuildActivation(data);

  return data;
}

function buildGuildPlayerData(player = {}) {
  return { ...ensureGuildPlayerData(player) };
}

function buildFullRewardInfo(items = []) {
  return {
    items: Array.isArray(items) ? items.slice() : [],
    equips: [],
    swords: [],
    pets: [],
    artifacts: [],
    gems: [],
    valhalla: [],
    bloodline: [],
    fashion: [],
    elves: [],
    sailor: [],
    extraReward: {},
  };
}

function normalizeItemRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      id: Math.max(0, toSafeInt(row && row.id, 0)),
      count: Math.max(0, toSafeInt(row && row.count, 0)),
    }))
    .filter((row) => row.id > 0 && row.count > 0);
}

function buildCostSyncPacket(player = {}, costs = []) {
  const data = buildRewardItemSync(player, normalizeItemRows(costs));
  return {
    tag: 1202,
    data: {
      ...data,
      items: [],
    },
  };
}

function buildItemSyncPacket(items = []) {
  return {
    tag: 1202,
    data: {
      result: 0,
      items: Array.isArray(items) ? items.slice() : [],
    },
  };
}

function buildRewardSyncPacket(player = {}, items = []) {
  return {
    tag: 1202,
    data: buildRewardItemSync(player, items),
  };
}

function getPowerValue(source = {}) {
  return Math.max(0, toSafeInt(
    source.power != null ? source.power
      : source.powerScore != null ? source.powerScore
        : source.totalPower != null ? source.totalPower
          : source.combatPower,
    0
  ));
}

function calcPlayerPowerValue(player = {}) {
  const cached = getPowerValue(player);
  if (cached > 0) return cached;
  try {
    if (battleService && typeof battleService.calcPlayerPower === 'function' && typeof battleService.calcPowerScore === 'function') {
      return Math.max(0, toSafeInt(battleService.calcPowerScore(battleService.calcPlayerPower(player) || {}), 0));
    }
  } catch (_err) {}
  return 0;
}

async function loadMemberPlayer(member = {}) {
  const userId = toSafeString(member.userId || member.userid);
  const playerId = getMemberDbid(member);
  const cacheKey = userId ? `u:${userId}` : (playerId ? `p:${playerId}` : '');
  if (cacheKey) {
    const cached = memberPlayerCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) memberPlayerCache.delete(cacheKey);
  }
  let loaded = null;
  if (userId && typeof playerService.loadPlayer === 'function') {
    loaded = await playerService.loadPlayer(userId).catch(() => null);
  }

  if (!loaded && playerId && typeof playerService.findByDbidOrPlayerId === 'function') {
    loaded = await playerService.findByDbidOrPlayerId(playerId).catch(() => null);
  }

  if (cacheKey && loaded) {
    if (memberPlayerCache.size >= MAX_MEMBER_PLAYER_CACHE) {
      const firstKey = memberPlayerCache.keys().next().value;
      if (firstKey) memberPlayerCache.delete(firstKey);
    }
    memberPlayerCache.set(cacheKey, { value: loaded, expiresAt: Date.now() + MEMBER_PLAYER_CACHE_TTL_MS });
  }

  return loaded;
}

function mergeMemberWithPlayer(member = {}, player = {}) {
  if (!player || typeof player !== 'object') return member;
  const roleInfo = player.roleInfo && typeof player.roleInfo === 'object' ? player.roleInfo : {};
  const playerid = getMemberDbid(member) || getPlayerDbid(player);
  return {
    ...member,
    userId: toSafeString(member.userId || member.userid || player.userId),
    playerId: playerid,
    playerid,
    dbid: playerid,
    name: toSafeString(player.name || player.playername || member.name || member.playername),
    playername: toSafeString(player.playername || player.name || member.playername || member.name),
    level: Math.max(1, toSafeInt(player.level, toSafeInt(member.level, 1))),
    power: calcPlayerPowerValue(player) || getPowerValue(member),
    kungfuId: toSafeInt(roleInfo.kungfuId, toSafeInt(member.kungfuId, 1)),
    subJob: toSafeInt(roleInfo.subJob, toSafeInt(member.subJob, 1)),
    avatar: toSafeInt(player.avatar, toSafeInt(member.avatar, 0)),
    avatarFrame: toSafeInt(player.avatarFrame, toSafeInt(member.avatarFrame, 0)),
    avatarurl: toSafeString(player.avatarurl || player.avatarUrl || member.avatarurl || member.avatarUrl),
    avatarUrl: toSafeString(player.avatarUrl || player.avatarurl || member.avatarUrl || member.avatarurl),
    title: toSafeInt(player.title, toSafeInt(member.title, -1)),
    logouttime: toSafeInt(player.logouttime, toSafeInt(member.logouttime, 0)),
  };
}

async function enrichGuildMembersFromPlayers(guild = {}, session = {}) {
  if (!guild || typeof guild !== 'object') return guild;
  const members = Array.isArray(guild.members) ? guild.members.slice() : [];
  if (members.length <= 0) {
    guild.members = members;
    return guild;
  }

  const sessionPlayer = session && session.player;
  const enriched = [];
  for (const member of members) {
    const localMergedGuild = { members: [member] };
    applySessionPlayerToGuildMembers(localMergedGuild, sessionPlayer, session);
    let nextMember = localMergedGuild.members[0] || member;
    if (getPowerValue(nextMember) <= 0) {
      const memberPlayer = await loadMemberPlayer(nextMember);
      if (memberPlayer) nextMember = mergeMemberWithPlayer(nextMember, memberPlayer);
    }
    enriched.push(nextMember);
  }
  guild.members = enriched;
  return guild;
}

function applySessionPlayerToGuildMembers(guild = {}, player = {}, session = {}) {
  if (!guild || typeof guild !== 'object') return guild;
  const members = Array.isArray(guild.members) ? guild.members.slice() : [];
  if (!player || typeof player !== 'object' || members.length <= 0) {
    guild.members = members;
    return guild;
  }

  const roleInfo = player.roleInfo && typeof player.roleInfo === 'object' ? player.roleInfo : {};
  const selfKeys = new Set([
    toSafeString(session && session.userId),
    toSafeString(player.userId),
    getPlayerDbid(player),
  ].filter(Boolean));

  guild.members = members.map((member) => {
    const memberKeys = [
      toSafeString(member && member.userId),
      toSafeString(member && member.userid),
      getMemberDbid(member),
    ].filter(Boolean);
    if (!memberKeys.some((key) => selfKeys.has(key))) return member;
    return {
      ...member,
      playerId: getMemberDbid(member) || getPlayerDbid(player),
      playerid: getMemberDbid(member) || getPlayerDbid(player),
      dbid: getMemberDbid(member) || getPlayerDbid(player),
      name: toSafeString(member && (member.name || member.playername)) || toSafeString(player.name || player.playername),
      playername: toSafeString(member && (member.playername || member.name)) || toSafeString(player.playername || player.name),
      level: Math.max(1, toSafeInt(member && member.level, toSafeInt(player.level, 1))),
      power: calcPlayerPowerValue(player) || getPowerValue(member),
      kungfuId: toSafeInt(member && member.kungfuId, toSafeInt(roleInfo.kungfuId, 1)),
      subJob: toSafeInt(member && member.subJob, toSafeInt(roleInfo.subJob, 1)),
      avatar: toSafeInt(member && member.avatar, toSafeInt(player.avatar, 0)),
      avatarFrame: toSafeInt(member && member.avatarFrame, toSafeInt(player.avatarFrame, 0)),
      avatarurl: toSafeString(member && (member.avatarurl || member.avatarUrl)) || toSafeString(player.avatarurl || player.avatarUrl),
    };
  });
  return guild;
}

function getGuildDailyRewardConfig() {
  const baseCfg = configService.get('GuildBaseConfig') || {};
  return baseCfg.guildDailyReward && typeof baseCfg.guildDailyReward === 'object'
    ? baseCfg.guildDailyReward
    : {};
}

function getGuildBaseConfig() {
  return configService.get('GuildBaseConfig') || {};
}

function getGuildLevelConfig(level = 1) {
  const cfg = configService.get('GuildConfig') || {};
  const safeLevel = Math.max(1, toSafeInt(level, 1));
  return cfg[safeLevel] || cfg[String(safeLevel)] || {};
}

function getGuildMemberLimit(level = 1, fallback = 20) {
  const cfg = getGuildLevelConfig(level);
  return Math.max(1, toSafeInt(cfg.menberNum != null ? cfg.menberNum : cfg.memberNum, fallback));
}

function getGuildDonateConfig(donateCount = 0) {
  const cfg = configService.get('GuildDonateConfig') || {};
  const nextId = Math.max(1, toSafeInt(donateCount, 0) + 1);
  return cfg[nextId] || cfg[String(nextId)] || null;
}

function getDefaultGuildBlessRewards() {
  const configured = toSafeString(process.env.GUILD_BLESS_REWARDS_JSON);
  if (configured) {
    try {
      const parsed = JSON.parse(configured);
      const rows = normalizeItemRows(parsed);
      if (rows.length > 0) return rows;
    } catch (_err) {}
  }
  const rewardMap = getGuildDailyRewardConfig();
  const thresholds = Object.keys(rewardMap)
    .map((key) => toSafeInt(key, 0))
    .filter((key) => key > 0)
    .sort((a, b) => b - a);
  return thresholds.length > 0 ? normalizeItemRows(rewardMap[thresholds[0]]) : [];
}

function getGuildBlessRewards(guild = {}) {
  const rows = normalizeItemRows(guild.blessRewards);
  return rows.length > 0 ? rows : getDefaultGuildBlessRewards();
}

function hasGuildAuthority(identity, authority) {
  const value = toSafeInt(identity, 3);
  if (value === 0) return true;
  if (value === 1) return [1, 2, 4, 5, 6].includes(toSafeInt(authority, 0));
  if (value === 2) return toSafeInt(authority, 0) === 6;
  return false;
}

function normalizeDamageRecordRow(row = {}) {
  return {
    name: toSafeString(row.name),
    damage: Math.max(0, toSafeInt(row.damage, 0)),
  };
}

function getGuildRecordList(guildId) {
  const safeGuildId = toSafeInt(guildId, 0);
  if (safeGuildId <= 0) return [];
  return guildRecordMap.get(safeGuildId) || [];
}

function setGuildRecordList(guildId, list = []) {
  const safeGuildId = toSafeInt(guildId, 0);
  if (safeGuildId <= 0) return;
  guildRecordMap.set(safeGuildId, list.slice(0, MAX_GUILD_RECORD_HISTORY));
}

function nextGuildRecordUid(guildId) {
  const list = getGuildRecordList(guildId);
  const latest = list[list.length - 1];
  return Math.max(1, toSafeInt(latest && latest.uid, 0) + 1);
}

function pushGuildRecord(guildId, row = {}) {
  const safeGuildId = toSafeInt(guildId, 0);
  if (safeGuildId <= 0) return null;
  const list = getGuildRecordList(safeGuildId).slice();
  const record = {
    uid: nextGuildRecordUid(safeGuildId),
    ...row,
  };
  list.push(record);
  if (list.length > MAX_GUILD_RECORD_HISTORY) {
    list.splice(0, list.length - MAX_GUILD_RECORD_HISTORY);
  }
  setGuildRecordList(safeGuildId, list);
  return record;
}

function pushPacketToGuildMembers(guild = {}, tag, data, excludeUserIds = []) {
  const wsServer = runtimeBus.getWsServer();
  if (!wsServer || typeof wsServer.pushToUser !== 'function') return;
  const excluded = new Set((Array.isArray(excludeUserIds) ? excludeUserIds : []).map(toSafeString));
  const members = Array.isArray(guild.members) ? guild.members : [];
  members.forEach((member) => {
    const userId = toSafeString(member && (member.userId || member.userid));
    if (!userId || excluded.has(userId)) return;
    wsServer.pushToUser(userId, tag, data);
  });
}

async function applyTempleBuffToGuild(session = {}, buffId = 0, buffTime = 0) {
  const player = session && session.player;
  if (!player || !session.userId) return null;
  const guildInfo = ensureGuildPlayerData(player);
  const guildId = Math.max(0, toSafeInt(guildInfo.guildId, 0));
  const safeBuffId = Math.max(0, toSafeInt(buffId, 0));
  const safeBuffTime = Math.max(0, toSafeInt(buffTime, 0));
  if (guildId <= 0 || safeBuffId <= 0 || safeBuffTime <= Date.now()) return null;

  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) return null;
  await Guild.updateOne({ guildId }, {
    $set: {
      templeBuffId: safeBuffId,
      templeBuffTime: safeBuffTime,
    },
  });
  guildInfo.templeBuffId = safeBuffId;
  guildInfo.templeBuffTime = safeBuffTime;

  const data = { buffId: safeBuffId, buffTime: safeBuffTime };
  pushPacketToGuildMembers(guild, 1518, data, [session.userId]);
  return { tag: 1518, msgUid: 0, data };
}

function buildGuildChatSummary(player = {}) {
  const roleInfo = player.roleInfo && typeof player.roleInfo === 'object' ? player.roleInfo : {};
  return {
    dbid: getPlayerDbid(player),
    name: toSafeString(player.name || player.playername),
    avatar: toSafeInt(player.avatar != null ? player.avatar : roleInfo.avatar, 0),
    avatarFrame: toSafeInt(player.avatarFrame != null ? player.avatarFrame : roleInfo.avatarFrame, 0),
    avatarurl: toSafeString(player.avatarurl || player.avatarUrl),
    level: Math.max(1, toSafeInt(player.level, 1)),
    title: toSafeInt(player.title != null ? player.title : roleInfo.title, -1),
  };
}

function buildGuildChatRecord(player = {}, params = {}, guildId = 0) {
  const content = toSafeString(params.str != null ? params.str : (params.content || params.msg || params.text));
  if (!content) return null;
  const reply = params.reply && typeof params.reply === 'object' ? params.reply : null;
  let replyRecord = null;
  if (reply && reply.uid != null) {
    replyRecord = getGuildRecordList(guildId).find((row) => String(row && row.uid) === String(reply.uid)) || null;
  }
  return pushGuildRecord(guildId, {
    type: 2,
    time: Date.now(),
    playerId: getPlayerDbid(player),
    kungfuId: toSafeInt(player.roleInfo && player.roleInfo.kungfuId, 0),
    chatinfo: {
      str: content.length > 200 ? content.slice(0, 200) : content,
      summary: buildGuildChatSummary(player),
      chatFrame: toSafeInt(player.chatFrame, -1),
      replyContent: replyRecord && replyRecord.chatinfo ? toSafeString(replyRecord.chatinfo.str) : null,
      replyName: replyRecord && replyRecord.chatinfo && replyRecord.chatinfo.summary
        ? toSafeString(replyRecord.chatinfo.summary.name)
        : null,
    },
  });
}

function getGuildRecordTimestamp() {
  return Math.floor(Date.now() / 1000);
}

function pushGuildJoinRecord(guildId, player = {}) {
  pushGuildRecord(guildId, {
    type: 1,
    time: getGuildRecordTimestamp(),
    playerId: getPlayerDbid(player),
    kungfuId: 0,
    eventinfo: {
      event: 1,
      name: toSafeString(player.name),
    },
  });
}

function pushGuildLeaveRecord(guildId, player = {}) {
  pushGuildRecord(guildId, {
    type: 1,
    time: getGuildRecordTimestamp(),
    playerId: getPlayerDbid(player),
    kungfuId: 0,
    eventinfo: {
      event: 2,
      name: toSafeString(player.name),
    },
  });
}

function buildGuildMemberRecord(player = {}, userId = '', identity = 2, joinTime = 0, donateCount = 0, totalDonate = 0) {
  const roleInfo = player && player.roleInfo && typeof player.roleInfo === 'object' ? player.roleInfo : {};
  const safeUserId = toSafeString(userId || player.userId || player.playerId);
  const playerid = getPlayerDbid(player, safeUserId);
  const playername = toSafeString(player.playername || player.name);
  const avatarurl = toSafeString(player.avatarurl || player.avatarUrl);
  const safeDonate = toSafeInt(donateCount, 0);
  const safeTotalDonate = toSafeInt(totalDonate != null ? totalDonate : donateCount, 0);
  return {
    userId: safeUserId,
    playerId: playerid,
    playerid,
    dbid: playerid,
    name: playername,
    playername,
    identity: toSafeInt(identity, 0),
    joinTime: toSafeInt(joinTime, 0),
    donateCount: safeDonate,
    donate: safeDonate,
    weekdonate: safeDonate,
    totalDonate: safeTotalDonate,
    totaldonate: safeTotalDonate,
    level: toSafeInt(player.level, 1),
    power: getPowerValue(player),
    kungfuId: toSafeInt(roleInfo.kungfuId || player.kungfuId, 1),
    subJob: toSafeInt(roleInfo.subJob || player.subJob, 1),
    avatar: toSafeInt(player.avatar, 0),
    avatarUrl: avatarurl,
    avatarurl,
    avatarFrame: toSafeInt(player.avatarFrame, 0),
    title: toSafeInt(player.title, -1),
    logouttime: toSafeInt(player.logouttime, 0),
  };
}

function buildGuildApplicationRecord(player = {}, userId = '', applyTime = Date.now()) {
  const playerid = getPlayerDbid(player, userId);
  return {
    userId: toSafeString(userId || player.userId || playerid),
    playerid,
    playerId: playerid,
    dbid: playerid,
    name: toSafeString(player.name || player.playername),
    level: Math.max(1, toSafeInt(player.level, 1)),
    power: getPowerValue(player),
    avatar: Math.max(0, toSafeInt(player.avatar, 0)),
    avatarurl: toSafeString(player.avatarurl || player.avatarUrl),
    avatarFrame: Math.max(0, toSafeInt(player.avatarFrame, 0)),
    applyTime: Math.max(0, toSafeInt(applyTime, Date.now())),
  };
}

function normalizeGuildIdentities(guild) {
  if (!guild || typeof guild !== 'object') return guild;
  const leaderId = toSafeString(guild.leaderId);
  const members = Array.isArray(guild.members) ? guild.members : [];
  guild.members = members.map((member) => {
    const next = { ...member };
    if (leaderId && toSafeString(next.userId || next.userid) === leaderId) {
      next.identity = 0;
    } else if (toSafeInt(next.identity, 2) === 0) {
      // Older builds used 2 for the leader and 0 for regular members.
      next.identity = 2;
    }
    return next;
  });
  return guild;
}

function buildGuildLeaderInfo(guild = {}) {
  normalizeGuildIdentities(guild);
  const members = Array.isArray(guild.members) ? guild.members : [];
  const leader = members.find((m) => toSafeInt(m && m.identity, 2) === 0) || members[0] || {};
  const member = buildGuildMember(leader);
  return {
    ...member,
    identity: toSafeInt(member.identity, 0),
  };
}

function buildGuildSummary(guild = {}) {
  normalizeGuildIdentities(guild);
  const members = Array.isArray(guild.members) ? guild.members : [];
  const leader = members.find((m) => toSafeInt(m && m.identity, 2) === 0) || members[0] || {};
  const leaderinfo = buildGuildLeaderInfo(guild);
  const memberPower = members.reduce((sum, member) => sum + getPowerValue(member), 0);
  const estimatedPower = members.reduce((sum, member) => {
    if (getPowerValue(member) > 0) return sum;
    return sum + Math.max(0, toSafeInt(member && member.level, 1)) * 1000;
  }, 0);
  const totalPower = memberPower || getPowerValue(guild) || estimatedPower;
  return {
    id: toSafeInt(guild.guildId, 0),
    guildId: toSafeInt(guild.guildId, 0),
    name: toSafeString(guild.name),
    guildName: toSafeString(guild.name),
    level: toSafeInt(guild.level, 1),
    exp: toSafeInt(guild.exp, 0),
    icon: toSafeInt(guild.icon, 0),
    notice: toSafeString(guild.notice),
    serverId: toSafeInt(process.env.SERVER_ID, 1),
    serverName: toSafeString(process.env.SERVER_NAME),
    playercount: members.length,
    maxMembers: toSafeInt(guild.maxMembers, getGuildMemberLimit(guild.level, 20)),
    memberCount: members.length,
    leaderId: toSafeString(guild.leaderId),
    leaderName: toSafeString(leader.playername || leader.name),
    leaderinfo,
    needLevel: toSafeInt(guild.needLevel, 0),
    createTime: toSafeInt(guild.createTime, 0),
    totalPower,
    power: totalPower,
    powerScore: totalPower,
  };
}

function ensureSessionPlayerInGuildRank(guild = {}, session = {}) {
  const player = session && session.player;
  if (!player || typeof player !== 'object') return guild;
  const guildId = toSafeInt(guild && guild.guildId, 0);
  const playerGuildId = toSafeInt(player && player.guildInfo && player.guildInfo.guildId, 0);
  if (guildId <= 0 || guildId !== playerGuildId) return guild;

  const members = Array.isArray(guild.members) ? guild.members.slice() : [];
  const selfKeys = new Set([
    toSafeString(session.userId),
    toSafeString(player.userId),
    getPlayerDbid(player),
  ].filter(Boolean));
  const hasSelf = members.some((member) => [
    toSafeString(member && member.userId),
    toSafeString(member && member.userid),
    getMemberDbid(member),
  ].filter(Boolean).some((key) => selfKeys.has(key)));

  if (!hasSelf) {
    members.push(buildGuildMemberRecord(
      player,
      session.userId || player.userId || player.playerId,
      Math.min(2, Math.max(0, toSafeInt(player.guildInfo && player.guildInfo.identity, 2))),
      Math.max(0, toSafeInt(player.guildInfo && player.guildInfo.joinTime, 0)),
      Math.max(0, toSafeInt(player.guildInfo && player.guildInfo.donateCount, 0)),
    ));
  }

  guild.members = members;
  return applySessionPlayerToGuildMembers(guild, player, session);
}

function buildGuildMember(member = {}) {
  const playerid = getMemberDbid(member);
  const userId = toSafeString(member.userId || member.userid || playerid);
  const playername = toSafeString(member.playername || member.name);
  const avatarurl = toSafeString(member.avatarurl || member.avatarUrl);
  const donate = toSafeInt(member.donate != null ? member.donate : member.donateCount, 0);
  const totaldonate = toSafeInt(
    member.totaldonate != null ? member.totaldonate : (member.totalDonate != null ? member.totalDonate : donate),
    0
  );
  return {
    playerid,
    userId,
    playerId: playerid,
    dbid: playerid,
    name: playername,
    playername,
    identity: toSafeInt(member.identity, 2),
    level: toSafeInt(member.level, 1),
    power: getPowerValue(member),
    kungfuId: toSafeInt(member.kungfuId, 1),
    subJob: toSafeInt(member.subJob, 1),
    avatar: toSafeInt(member.avatar, 0),
    avatarUrl: avatarurl,
    avatarurl,
    avatarFrame: toSafeInt(member.avatarFrame, 0),
    title: toSafeInt(member.title, -1),
    joinTime: toSafeInt(member.joinTime, 0),
    donate,
    donateCount: donate,
    weekdonate: toSafeInt(member.weekdonate, donate),
    totaldonate,
    totalDonate: totaldonate,
    logouttime: toSafeInt(member.logouttime, 0),
  };
}

function buildGuildInfo(guild = {}) {
  return {
    summary: buildGuildSummary(guild),
    notice: toSafeString(guild.notice),
    exp: toSafeInt(guild.exp, 0),
    activation: toSafeInt(guild.activation, 0),
    blessLv: toSafeInt(guild.blessLv, 1),
    blessValue: toSafeInt(guild.blessValue, 0),
    blessRewards: getGuildBlessRewards(guild),
    blessRecords: Array.isArray(guild.blessRecords) ? guild.blessRecords.slice() : [],
    autoJoin: toSafeInt(guild.autoJoin, 0),
    searchable: toSafeInt(guild.searchable, 1),
    templeBuffId: toSafeInt(guild.templeBuffId, 0),
    templeBuffTime: toSafeInt(guild.templeBuffTime, 0),
  };
}

function getGuildChatList(guildId) {
  const safeGuildId = toSafeInt(guildId, 0);
  if (safeGuildId <= 0) return [];
  return guildChatMap.get(safeGuildId) || [];
}

function pushGuildChat(guildId, row) {
  const safeGuildId = toSafeInt(guildId, 0);
  if (safeGuildId <= 0) return;
  const list = getGuildChatList(safeGuildId).slice();
  list.push(row);
  if (list.length > MAX_GUILD_CHAT_HISTORY) {
    list.splice(0, list.length - MAX_GUILD_CHAT_HISTORY);
  }
  guildChatMap.set(safeGuildId, list);
}

function getGuildExchangeList(guildId) {
  const safeGuildId = toSafeInt(guildId, 0);
  if (safeGuildId <= 0) return [];
  return guildExchangeMap.get(safeGuildId) || [];
}

function setGuildExchangeList(guildId, list = []) {
  const safeGuildId = toSafeInt(guildId, 0);
  if (safeGuildId <= 0) return;
  guildExchangeMap.set(safeGuildId, list.slice(0, MAX_GUILD_EXCHANGE_HISTORY));
}

function pushGuildExchange(guildId, row) {
  const list = getGuildExchangeList(guildId).slice();
  list.push(row);
  if (list.length > MAX_GUILD_EXCHANGE_HISTORY) {
    list.splice(0, list.length - MAX_GUILD_EXCHANGE_HISTORY);
  }
  setGuildExchangeList(guildId, list);
}

function createGuildExchangeRequest(player = {}, session = {}, itemIdValue = 0, exchangesValue = []) {
  const guildId = toSafeInt(ensureGuildPlayerData(player).guildId, 0);
  const itemId = Math.max(0, toSafeInt(itemIdValue, 0));
  const exchanges = Array.from(new Set(
    (Array.isArray(exchangesValue) ? exchangesValue : [])
      .map((id) => Math.max(0, toSafeInt(id, 0)))
      .filter((id) => id > 0)
  ));
  if (guildId <= 0 || itemId <= 0 || exchanges.length <= 0) return null;

  const userId = toSafeString(session.userId || player.userId || player.playerId);
  const oldList = getGuildExchangeList(guildId);
  const removedUids = oldList
    .filter((row) => toSafeString(row && row.userId) === userId)
    .map((row) => toSafeString(row && row.uid))
    .filter(Boolean);
  setGuildExchangeList(
    guildId,
    oldList.filter((row) => toSafeString(row && row.userId) !== userId)
  );

  const uid = `${guildId}-${getPlayerDbid(player) || userId}-${Date.now()}`;
  const exchange = {
    uid,
    guildId,
    userId,
    summary: {
      dbid: getPlayerDbid(player),
      name: toSafeString(player.name),
      avatar: toSafeInt(player.avatar, 0),
      avatarFrame: toSafeInt(player.avatarFrame, 0),
      level: Math.max(1, toSafeInt(player.level, 1)),
    },
    itemId,
    exchanges,
    time: Date.now(),
  };
  pushGuildExchange(guildId, exchange);
  return { exchange, removedUids };
}

function getGuildBattleLogs(guildId) {
  const safeGuildId = toSafeInt(guildId, 0);
  if (safeGuildId <= 0) return [];
  return guildBattleLogMap.get(safeGuildId) || [];
}

function pushGuildBattleLog(guildId, row) {
  const safeGuildId = toSafeInt(guildId, 0);
  if (safeGuildId <= 0) return;
  const list = getGuildBattleLogs(safeGuildId).slice();
  list.push(row);
  if (list.length > MAX_GUILD_BATTLE_LOG) {
    list.splice(0, list.length - MAX_GUILD_BATTLE_LOG);
  }
  guildBattleLogMap.set(safeGuildId, list);
}

function getGuildBattleConfig() {
  return configService.get('GuildBattleConfig') || {};
}

function getGuildBattlePlayerCount() {
  const cfg = getGuildBattleConfig();
  return Math.max(1, toSafeInt(cfg.playerCount, 20));
}

function getGuildBattleAttackLimit() {
  const cfg = getGuildBattleConfig();
  return Math.max(0, toSafeInt(cfg.attackCount, 2));
}

function buildGuildBattleSummary(guild = {}) {
  const score = getGuildBattleScore(guild);
  const summary = buildGuildSummary(guild);
  return {
    id: summary.id,
    guildId: summary.id,
    name: summary.name,
    icon: summary.icon,
    serverId: summary.serverId,
    serverName: summary.serverName,
    star: 0,
    score,
    changeScore: 0,
  };
}

function getGuildBattleScore(guild = {}) {
  const raw = [
    guild.battleScore,
    guild.guildBattleScore,
    guild.score,
    guild.guildscore,
    guild.guildBattleInfo && guild.guildBattleInfo.score,
  ].find((value) => Number.isFinite(Number(value)));
  if (raw !== undefined) return Math.max(0, toSafeInt(raw, 0));
  const level = Math.max(1, toSafeInt(guild.level, 1));
  const exp = Math.max(0, toSafeInt(guild.exp, 0));
  return 900 + (level * 20) + Math.min(199, Math.floor(exp / 10));
}

function buildGuildBattlePlayer(entry = {}, rank = 1, guildId = 0) {
  const dbid = toSafeString(entry.dbid || entry.playerid || entry.playerId);
  const avatarurl = toSafeString(entry.avatarurl || entry.avatarUrl);
  const serverId = Math.max(1, toSafeInt(entry.serverId, toSafeInt(process.env.SERVER_ID, 1)));
  const serverName = toSafeString(entry.serverName || process.env.SERVER_NAME);
  const userId = entry.userId == null ? 0 : entry.userId;
  const guildName = toSafeString(entry.guildName);
  return {
    dbid,
    playerid: dbid,
    userId,
    serverId,
    serverName,
    name: toSafeString(entry.name || entry.playername),
    playername: toSafeString(entry.name || entry.playername),
    rank: Math.max(1, toSafeInt(rank, 1)),
    star: Math.max(0, toSafeInt(entry.star, 0)),
    power: Math.max(0, toSafeInt(entry.power, 0)),
    avatar: toSafeInt(entry.avatar, 0),
    avatarUrl: avatarurl,
    avatarurl,
    avatarFrame: toSafeInt(entry.avatarFrame, 0),
    title: toSafeInt(entry.title, -1),
    guildId: Math.max(0, toSafeInt(guildId, 0)),
    guildName,
    protectCount: Math.max(0, toSafeInt(entry.protectCount, 0)),
    kungfuId: toSafeInt(entry.kungfuId, 1),
    subJob: toSafeInt(entry.subJob, 0),
    level: Math.max(1, toSafeInt(entry.level, 1)),
  };
}

function buildGuildBattleRobotPlayer(robotId = 1, rank = 1, guildId = 0) {
  const cfgTable = configService.get('GuildRobotConfig') || {};
  const cfg = cfgTable[robotId] || cfgTable[String(robotId)] || {};
  return buildGuildBattlePlayer({
    dbid: String(robotId),
    name: '',
    power: toSafeInt(cfg.combatPower, 1000),
    level: toSafeInt(cfg.robotLv, 1),
    star: 0,
  }, rank, guildId);
}

function buildGuildBattlePlayerList(guild = {}, playerCount = 20) {
  const guildId = toSafeInt(guild.guildId, 0);
  const members = Array.isArray(guild.members) ? guild.members : [];
  const sorted = members
    .map((member) => buildGuildMember(member))
    .sort((a, b) => toSafeInt(b.power, 0) - toSafeInt(a.power, 0));
  const list = [];

  for (let i = 0; i < playerCount; i += 1) {
    if (i < sorted.length) {
      list.push(buildGuildBattlePlayer(sorted[i], i + 1, guildId));
    } else {
      list.push(buildGuildBattleRobotPlayer((i % 63) + 1, i + 1, guildId));
    }
  }

  return list;
}

function buildGuildBattleGuildSide(guild = {}) {
  const playerList = buildGuildBattlePlayerList(guild, getGuildBattlePlayerCount());
  const star = playerList.reduce((sum, row) => sum + toSafeInt(row.star, 0), 0);
  const summary = buildGuildBattleSummary(guild);
  summary.star = star;
  return {
    summary,
    playerList,
    star,
    score: Math.max(0, toSafeInt(summary.score, 0)),
    atkCount: 0,
    defCount: 0,
  };
}

function buildSyntheticEnemyGuild(myGuildId = 0) {
  const enemyId = Math.max(100000, toSafeInt(myGuildId, 0) + 90000);
  return {
    guildId: enemyId,
    name: '敌方仙盟',
    level: 1,
    exp: 0,
    icon: 0,
    notice: '',
    members: [],
    maxMembers: getGuildMemberLimit(1, 20),
    createTime: Date.now(),
  };
}

function buildSyntheticPlayerGuild(player = {}, guildId = 0) {
  const safeGuildId = Math.max(1, toSafeInt(guildId, 0));
  const guildInfo = ensureGuildPlayerData(player);
  const leader = buildGuildMemberRecord(
    player,
    player.userId || player.playerId,
    Math.min(2, Math.max(0, toSafeInt(guildInfo.identity, 0))),
    Math.max(0, toSafeInt(guildInfo.joinTime, Date.now())),
  );
  return {
    guildId: safeGuildId,
    name: toSafeString(guildInfo.guildName) || `仙盟${safeGuildId}`,
    level: 1,
    exp: 0,
    icon: 0,
    notice: '',
    members: [leader],
    maxMembers: getGuildMemberLimit(1, 20),
    createTime: Date.now(),
  };
}

async function loadGuildDoc(filter = {}) {
  const query = Guild.findOne(filter);
  if (!query) return null;
  if (typeof query.lean === 'function') {
    return normalizeGuildIdentities(await query.lean());
  }
  return normalizeGuildIdentities(await query);
}

async function findEnemyGuildDoc(myGuildId = 0) {
  const safeMyGuildId = toSafeInt(myGuildId, 0);
  if (safeMyGuildId <= 0) return buildSyntheticEnemyGuild(safeMyGuildId);

  try {
    const enemy = await loadGuildDoc({ guildId: { $ne: safeMyGuildId } });
    if (enemy) return enemy;
  } catch (_err) {
    // ignore and fall back to synthetic enemy for local dev
  }

  return buildSyntheticEnemyGuild(safeMyGuildId);
}

function normalizeGuildBattleLogEntry(row = {}, guildId = 0) {
  if (!row || typeof row !== 'object') return null;
  if (row.atkPlayerInfo && row.defPlayerInfo) {
    return {
      ...row,
      time: Math.max(0, toSafeInt(row.time, Date.now())),
      isWin: !!row.isWin,
      addStar: Math.max(0, toSafeInt(row.addStar, 0)),
      recordId: row.recordId == null ? null : row.recordId,
    };
  }
  return null;
}

function buildGuildBattleRecordDataList(myGuild = {}, enemyGuild = {}, logs = []) {
  const mySummary = buildGuildBattleSummary(myGuild);
  const enemySummary = buildGuildBattleSummary(enemyGuild);
  const battleLogs = logs
    .map((row) => normalizeGuildBattleLogEntry(row, mySummary.id))
    .filter(Boolean);

  return battleLogs.map((row) => ({
    self: {
      ...mySummary,
      score: Math.max(0, toSafeInt(row.selfScore != null ? row.selfScore : mySummary.score, mySummary.score)),
      changeScore: row.isWin ? Math.max(0, toSafeInt(row.addStar, 1)) : 0,
    },
    other: enemySummary.id > 0 ? {
      ...enemySummary,
      score: Math.max(0, toSafeInt(row.otherScore != null ? row.otherScore : enemySummary.score, enemySummary.score)),
      changeScore: row.isWin ? 0 : Math.max(0, toSafeInt(row.addStar, 1)),
    } : null,
    time: Math.max(0, toSafeInt(row.time, Date.now())),
  }));
}

async function buildGuildBattleRankRows(limit = 50) {
  const pageSize = Math.min(100, Math.max(1, toSafeInt(limit, 50)));
  const rows = await Guild.find({}).sort({ level: -1, exp: -1, guildId: 1 }).limit(pageSize).lean();
  return (rows || []).map((guild, idx) => ({
    rank: idx + 1,
    icon: toSafeInt(guild && guild.icon, 0),
    name: toSafeString(guild && guild.name),
    serverId: Math.max(1, toSafeInt(guild && guild.serverId, toSafeInt(process.env.SERVER_ID, 1))),
    serverName: toSafeString(guild && guild.serverName || process.env.SERVER_NAME),
    score: getGuildBattleScore(guild),
    guildId: toSafeInt(guild && guild.guildId, 0),
  }));
}

async function buildGuildBattleTopSummary(limit = 3) {
  const rows = await buildGuildBattleRankRows(limit);
  return rows.map((row) => ({
    summary: {
      id: row.guildId,
      guildId: row.guildId,
      name: row.name,
      icon: row.icon,
      serverId: row.serverId,
      serverName: row.serverName,
    },
    star: 0,
    score: row.score,
  }));
}

async function buildGuildBattleInfo(player = {}, myGuild = {}, enemyGuild = null) {
  const now = Date.now();
  const myGuildSide = buildGuildBattleGuildSide(myGuild);
  const enemyGuildSide = enemyGuild ? buildGuildBattleGuildSide(enemyGuild) : null;
  const guildId = toSafeInt(myGuild && myGuild.guildId, 0);
  const guildInfo = ensureGuildPlayerData(player);
  const atkCount = Math.max(0, toSafeInt(guildInfo.guildBattleAtkCount, 0));
  const rawLogs = getGuildBattleLogs(guildId);
  const loglist = rawLogs
    .map((row) => normalizeGuildBattleLogEntry(row, guildId))
    .filter(Boolean);
  const dataList = buildGuildBattleRecordDataList(myGuild, enemyGuild || {}, rawLogs);
  const curBattleRank = await buildGuildBattleTopSummary(3);

  return {
    status: enemyGuildSide ? 4 : 1,
    battleGuildId: myGuildSide.summary.id,
    endTime: now + (2 * 86400000),
    seasonEndTime: now + (14 * 86400000),
    atkCount,
    loglist,
    broadCastLog: [],
    curBattleRank,
    myGuild: myGuildSide,
    enemyGuild: enemyGuildSide,
    dataList,
  };
}

async function buildGuildBattleInitPacket(player = {}, msgUid = 0) {
  const guildId = toSafeInt(ensureGuildPlayerData(player).guildId, 0);
  if (guildId <= 0) return null;

  let myGuild = await loadGuildDoc({ guildId });
  if (!myGuild) {
    myGuild = buildSyntheticPlayerGuild(player, guildId);
  }

  const enemyGuild = await findEnemyGuildDoc(guildId);
  const battleInfo = await buildGuildBattleInfo(player, myGuild, enemyGuild);
  return {
    tag: 1550,
    msgUid,
    data: {
      result: 0,
      guildId,
      ...battleInfo,
      status: Math.max(1, toSafeInt(battleInfo.status, 1)),
    },
  };
}

const DONATE_CONFIG = {
  1: {
    cost: { id: 2, count: 10000 },
    guildExp: 20,
    donateCount: 20,
    rewards: [{ id: 2, count: 2000 }],
  },
  2: {
    cost: { id: 2, count: 50000 },
    guildExp: 120,
    donateCount: 120,
    rewards: [{ id: 2, count: 10000 }, { id: 3, count: 30 }],
  },
  3: {
    cost: { id: 1, count: 100 },
    guildExp: 300,
    donateCount: 300,
    rewards: [{ id: 1, count: 20 }, { id: 3, count: 120 }],
  },
};

const DONATE_DAILY_REWARD = [
  { id: 1, need: 20, rewards: [{ id: 2, count: 3000 }] },
  { id: 2, need: 120, rewards: [{ id: 1, count: 20 }] },
  { id: 3, need: 300, rewards: [{ id: 1, count: 80 }] },
];

const GUILD_HUNTING_REWARD = [
  { id: 1, need: 1, rewards: [{ id: 2, count: 5000 }] },
  { id: 2, need: 3, rewards: [{ id: 3, count: 30 }] },
  { id: 3, need: 5, rewards: [{ id: 1, count: 50 }] },
];

function getGuildHuntingRewardRows() {
  const cfg = configService.get('GuildBossConfig') || {};
  const rows = Object.keys(cfg)
    .map((key) => {
      const row = cfg[key] || cfg[String(key)] || {};
      const id = Math.max(0, toSafeInt(row.id != null ? row.id : key, 0));
      const need = Math.max(0, toSafeInt(row.damage != null ? row.damage : row.need, 0));
      const rewards = Array.isArray(row.rewards) ? row.rewards : [];
      return { id, need, rewards };
    })
    .filter((row) => row.id > 0 && row.need > 0 && row.rewards.length > 0)
    .sort((a, b) => a.id - b.id);
  return rows.length > 0 ? rows : GUILD_HUNTING_REWARD;
}

function toCurrencyKey(itemId) {
  if (itemId === 1) return 'diamond';
  if (itemId === 2) return 'silver';
  if (itemId === 6) return 'gold';
  return '';
}

function hasEnoughCost(player, cost = {}) {
  const itemId = toSafeInt(cost.id, 0);
  const count = toSafeInt(cost.count, 0);
  if (itemId <= 0 || count <= 0) return false;

  const currKey = toCurrencyKey(itemId);
  if (currKey) {
    player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
    return toSafeInt(player.currencies[currKey], 0) >= count;
  }

  player.items = player.items || {};
  return toSafeInt(player.items[itemId], 0) >= count;
}

function hasEnoughCosts(player, costs = []) {
  return normalizeItemRows(costs).every((cost) => hasEnoughCost(player, cost));
}

function consumeCost(player, cost = {}) {
  const itemId = toSafeInt(cost.id, 0);
  const count = toSafeInt(cost.count, 0);
  if (itemId <= 0 || count <= 0) return;

  const currKey = toCurrencyKey(itemId);
  if (currKey) {
    player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
    player.currencies[currKey] = Math.max(0, toSafeInt(player.currencies[currKey], 0) - count);
    return;
  }

  player.items = player.items || {};
  player.items[itemId] = Math.max(0, toSafeInt(player.items[itemId], 0) - count);
  if (player.items[itemId] <= 0) delete player.items[itemId];
}

function consumeCosts(player, costs = []) {
  normalizeItemRows(costs).forEach((cost) => consumeCost(player, cost));
}

function applyGuildGrowth(guild = {}, gainExp = 0) {
  guild.level = toSafeInt(guild.level, 1);
  guild.exp = toSafeInt(guild.exp, 0) + toSafeInt(gainExp, 0);
  guild.maxMembers = toSafeInt(guild.maxMembers, getGuildMemberLimit(guild.level, 20));

  let levelUp = 0;
  while (guild.level < 100) {
    const levelCfg = getGuildLevelConfig(guild.level);
    const needExp = Math.max(0, toSafeInt(levelCfg.exp, 0));
    if (needExp <= 0 || guild.exp < needExp) break;
    guild.exp -= needExp;
    guild.level += 1;
    levelUp += 1;
  }

  guild.maxMembers = getGuildMemberLimit(guild.level, guild.maxMembers);
  return levelUp;
}

async function saveSessionPlayer(session) {
  const userId = session && session.userId;
  const player = session && session.player;
  if (!userId || !player) return;
  const saved = await playerService.savePlayer(userId, player);
  if (saved) session.player = saved;
}

async function nextGuildId() {
  const startId = toSafeInt(process.env.GUILD_ID_START, 1000);
  const last = await Guild.findOne({}).sort({ guildId: -1 }).lean();
  const lastGuildId = toSafeInt(last && last.guildId, startId - 1);
  return Math.max(startId, lastGuildId + 1);
}

function setPlayerGuild(player, guild, identity, now) {
  const guildData = ensureGuildPlayerData(player);
  guildData.guildId = toSafeInt(guild.guildId, 0);
  guildData.guildName = toSafeString(guild.name);
  guildData.identity = toSafeInt(identity, 2);
  guildData.joinTime = toSafeInt(now, 0);
  guildData.leaveTime = 0;
}

function clearPlayerGuild(player, leaveTime) {
  player.guildInfo = createDefaultGuildPlayerData();
  player.guildInfo.leaveTime = toSafeInt(leaveTime, 0);
}

function buildTaskUpdatePacketsSafe(player, msgUid = 0) {
  try {
    // eslint-disable-next-line global-require
    const task = require('./task');
    if (task && typeof task.buildActiveTaskUpdatePackets === 'function') {
      return task.buildActiveTaskUpdatePackets(player, msgUid);
    }
  } catch (_err) {}
  return [];
}

async function handleGetGuildList(params = {}, _session, msgUid) {
  const keyword = toSafeString(params.keyword || params.name);
  const pageSize = Math.min(100, Math.max(1, toSafeInt(params.pageSize || params.count, 50)));
  const filter = keyword ? { name: { $regex: keyword, $options: 'i' } } : {};

  const rows = await Guild.find(filter).sort({ level: -1, exp: -1, guildId: 1 }).limit(pageSize).lean();
  const guilds = (rows || []).map(buildGuildSummary);
  return {
    tag: 1500,
    msgUid,
    data: {
      result: 0,
      guilds,
    },
  };
}

async function buildGuildInitPacket(player = {}, msgUid = 0) {
  const guildPlayerData = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildPlayerData.guildId, 0);
  if (guildId <= 0) return null;

  let guild = await loadGuildDoc({ guildId });
  if (!guild) {
    guild = buildSyntheticPlayerGuild(player, guildId);
  }
  normalizeGuildIdentities(guild);
  const selfDbid = getPlayerDbid(player);
  const selfMember = (Array.isArray(guild.members) ? guild.members : []).find((member) => (
    getMemberDbid(member) === selfDbid || toSafeString(member && member.userId) === toSafeString(player.userId)
  ));
  if (selfMember) guildPlayerData.identity = toSafeInt(selfMember.identity, 2);
  guild = applySessionPlayerToGuildMembers(guild, player, { userId: player.userId });
  guild = await enrichGuildMembersFromPlayers(guild, { userId: player.userId, player });

  return {
    tag: 1500,
    msgUid,
    data: buildGuildInfo(guild),
  };
}

async function buildGuildRecordInitPacket(player = {}, msgUid = 0) {
  const guildId = toSafeInt(ensureGuildPlayerData(player).guildId, 0);
  if (guildId <= 0) return null;
  return {
    tag: 1506,
    msgUid,
    data: {
      records: getGuildRecordList(guildId),
    },
  };
}

async function buildGuildExchangeInitPacket(player = {}, msgUid = 0) {
  const guildId = toSafeInt(ensureGuildPlayerData(player).guildId, 0);
  if (guildId <= 0) return null;
  return {
    tag: 1519,
    msgUid,
    data: {
      exchanges: getGuildExchangeList(guildId),
    },
  };
}

async function buildGuildHuntingInitPacket(player = {}, msgUid = 0) {
  const guildId = toSafeInt(ensureGuildPlayerData(player).guildId, 0);
  if (guildId <= 0) return null;
  const guildInfo = ensureGuildPlayerData(player);
  return {
    tag: 1513,
    msgUid,
    data: {
      assistRecords: Array.isArray(guildInfo.assistRecords) ? guildInfo.assistRecords.slice() : [],
      result: 0,
      totalDamage: Math.max(0, toSafeInt(guildInfo.totalDamage, 0)),
      damageRecords: Array.isArray(guildInfo.damageRecords) ? guildInfo.damageRecords.slice() : [],
      bossCount: Math.max(0, toSafeInt(guildInfo.bossCount, 0)),
      bossAssist: Math.max(0, toSafeInt(guildInfo.bossAssist, 0)),
      bossReward: Array.isArray(guildInfo.bossReward) ? guildInfo.bossReward.slice() : [],
    },
  };
}

async function buildGuildExchangeUpdatePacket(player = {}, msgUid = 0) {
  return buildGuildExchangeInitPacket(player, msgUid);
}

function buildGuildDamageProgressPacket(payload = {}, msgUid = 0) {
  return {
    tag: 1514,
    msgUid,
    data: payload && typeof payload === 'object' ? { ...payload } : {},
  };
}

function recordGuildDamage(player = {}, damage = 0) {
  const guildInfo = ensureGuildPlayerData(player);
  const delta = Math.max(0, toSafeInt(damage, 0));
  guildInfo.totalDamage = Math.max(0, toSafeInt(guildInfo.totalDamage, 0)) + delta;
  const nextRow = normalizeDamageRecordRow({ name: player && player.name, damage: delta });
  if (nextRow.damage > 0) {
    guildInfo.damageRecords = [nextRow, ...guildInfo.damageRecords.map(normalizeDamageRecordRow)]
      .sort((a, b) => b.damage - a.damage)
      .slice(0, 20);
  }
  return buildGuildDamageProgressPacket({
    totalDamage: guildInfo.totalDamage,
    damageRecord: nextRow,
  });
}

function recordGuildAssist(player = {}) {
  const guildInfo = ensureGuildPlayerData(player);
  const assistId = getPlayerDbid(player);
  guildInfo.assistRecords = [assistId, ...guildInfo.assistRecords
    .map((row) => toSafeString(row && typeof row === 'object' ? row.assistId : row))
    .filter(Boolean)]
    .filter((value, index, rows) => rows.indexOf(value) === index)
    .slice(0, 50);
  return buildGuildDamageProgressPacket({
    assistId,
    totalDamage: Math.max(0, toSafeInt(guildInfo.totalDamage, 0)),
  });
}

function recordGuildHuntingChallenge(player = {}, damage = 0) {
  const guildInfo = ensureGuildPlayerData(player);
  guildInfo.bossCount = Math.max(0, toSafeInt(guildInfo.bossCount, 0)) + 1;
  guildInfo.bossGuildId = Math.max(0, toSafeInt(guildInfo.guildId, 0));
  return recordGuildDamage(player, damage);
}

async function handleCreateGuild(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1501, msgUid, data: { result: 1, error: 100006 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  if (guildInfo.guildId > 0) {
    return { tag: 1501, msgUid, data: { result: 1, error: 100006, guild: null, myGuild: buildGuildPlayerData(player) } };
  }

  const name = toSafeString(params.name || params.guildName);
  const baseCfg = getGuildBaseConfig();
  const nameLengthMax = Math.max(1, toSafeInt(baseCfg.nameLengthMax, 6));
  if (!name || name.length > nameLengthMax) {
    return { tag: 1501, msgUid, data: { result: 1, error: 100006, guild: null, myGuild: buildGuildPlayerData(player) } };
  }

  const existed = await Guild.findOne({ name }).lean();
  if (existed) {
    return { tag: 1501, msgUid, data: { result: 1, error: 100005, guild: null, myGuild: buildGuildPlayerData(player) } };
  }

  const createCosts = normalizeItemRows(baseCfg.createCost ? [baseCfg.createCost] : []);
  if (!hasEnoughCosts(player, createCosts)) {
    return { tag: 1501, msgUid, data: { result: 1, error: 100006, guild: null, myGuild: buildGuildPlayerData(player) } };
  }

  const now = Date.now();
  const guildId = await nextGuildId();
  const guildDoc = {
    guildId,
    name,
    leaderId: session.userId,
    level: 1,
    exp: 0,
    notice: '',
    autoJoin: 0,
    needLevel: 0,
    applications: [],
    blessRewards: getDefaultGuildBlessRewards(),
    members: [
      {
        ...buildGuildMemberRecord(player, session.userId, 0, now, 0, 0),
      },
    ],
    maxMembers: getGuildMemberLimit(1, 20),
    createTime: now,
  };

  try {
    await Guild.create(guildDoc);
  } catch (err) {
    if (err && err.code === 11000) {
      return { tag: 1501, msgUid, data: { result: 1, error: 100005, guild: null, myGuild: buildGuildPlayerData(player) } };
    }
    throw err;
  }

  consumeCosts(player, createCosts);
  setPlayerGuild(player, guildDoc, 0, now);
  pushGuildJoinRecord(guildId, player);
  const taskChanged = !!addGuildJoinCount(player, 1);
  await saveSessionPlayer(session);

  const packets = [
    ...(createCosts.length > 0 ? [buildCostSyncPacket(player, createCosts)] : []),
    {
      tag: 1500,
      msgUid: 0,
      data: buildGuildInfo(guildDoc),
    },
    {
      tag: 1504,
      msgUid: 0,
      data: buildGuildPlayerData(player),
    },
    {
      tag: 1501,
      msgUid,
      data: {
        result: 0,
        guild: buildGuildSummary(guildDoc),
        myGuild: buildGuildPlayerData(player),
      },
    },
  ];
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), ...packets] : packets;
}

async function handleJoinGuild(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1502, msgUid, data: { result: 1, error: 100006 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  if (guildInfo.guildId > 0) {
    return { tag: 1502, msgUid, data: { result: 1, error: 100006 } };
  }

  const guildId = toSafeInt(params.guildId || params.id, 0);
  if (guildId <= 0) {
    return { tag: 1502, msgUid, data: { result: 1, error: 100006 } };
  }

  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) {
    return { tag: 1502, msgUid, data: { result: 1, error: 100006 } };
  }

  const members = Array.isArray(guild.members) ? guild.members.slice() : [];
  const maxMembers = getGuildMemberLimit(guild.level, toSafeInt(guild.maxMembers, 20));
  const alreadyMember = members.some((m) => toSafeString(m.userId) === session.userId);
  if (!alreadyMember && members.length >= maxMembers) {
    return { tag: 1502, msgUid, data: { result: 1, error: 100007 } };
  }

  const now = Date.now();
  if (toSafeInt(player.level, 1) < Math.max(0, toSafeInt(guild.needLevel, 0))) {
    return { tag: 1502, msgUid, data: { result: 1, error: 100006 } };
  }

  if (!alreadyMember && toSafeInt(guild.autoJoin, 0) !== 1) {
    const applications = Array.isArray(guild.applications) ? guild.applications.slice() : [];
    const playerid = getPlayerDbid(player);
    const applicationIndex = applications.findIndex((row) => (
      toSafeString(row && (row.playerid || row.playerId || row.dbid)) === playerid
    ));
    const record = buildGuildApplicationRecord(player, session.userId, now);
    if (applicationIndex >= 0) applications[applicationIndex] = record;
    else applications.push(record);
    await Guild.updateOne({ guildId }, { $set: { applications } });
    pushPacketToGuildMembers(guild, 1501, {}, []);
    return { tag: 1502, msgUid, data: { result: 0, error: 0 } };
  }

  if (!alreadyMember) {
    members.push({
      ...buildGuildMemberRecord(player, session.userId, 2, now, 0, 0),
    });
    await Guild.updateOne(
      { guildId },
      { $set: { members } }
    );
  }

  guild.members = members;
  setPlayerGuild(player, guild, 2, now);
  pushGuildJoinRecord(guildId, player);
  const taskChanged = !!addGuildJoinCount(player, 1);
  await saveSessionPlayer(session);

  const response = {
    tag: 1502,
    msgUid,
    data: {
      result: 0,
      error: 0,
      guild: buildGuildSummary(guild),
      myGuild: buildGuildPlayerData(player),
    },
  };
  const packets = [
    { tag: 1500, msgUid: 0, data: buildGuildInfo(guild) },
    { tag: 1504, msgUid: 0, data: buildGuildPlayerData(player) },
    await buildGuildRecordInitPacket(player, 0),
    await buildGuildExchangeInitPacket(player, 0),
    await buildGuildHuntingInitPacket(player, 0),
    await buildGuildBattleInitPacket(player, 0),
    response,
  ].filter(Boolean);
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), ...packets] : packets;
}

async function handleLeaveGuild(_params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1503, msgUid, data: { result: -1 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildInfo.guildId, 0);
  if (guildId <= 0) {
    return { tag: 1503, msgUid, data: { result: 0, myGuild: buildGuildPlayerData(player) } };
  }

  const guild = await Guild.findOne({ guildId }).lean();
  const now = Date.now();

  if (!guild) {
    pushGuildLeaveRecord(guildId, player);
    clearPlayerGuild(player, now);
    await saveSessionPlayer(session);
    return { tag: 1503, msgUid, data: { result: 0, myGuild: buildGuildPlayerData(player) } };
  }
  normalizeGuildIdentities(guild);

  let members = Array.isArray(guild.members) ? guild.members.slice() : [];
  members = members.filter((m) => toSafeString(m.userId) !== session.userId);

  if (members.length === 0) {
    await Guild.deleteOne({ guildId });
  } else {
    const leavingIsLeader = toSafeString(guild.leaderId) === session.userId;
    let leaderId = guild.leaderId;
    if (leavingIsLeader) {
      const nextLeader = members.find((member) => toSafeInt(member && member.identity, 2) === 1) || members[0];
      nextLeader.identity = 0;
      leaderId = toSafeString(nextLeader.userId);
      pushPacketToGuildMembers({ ...guild, members }, 1503, { playerid: getMemberDbid(nextLeader) }, [session.userId]);
    }
    await Guild.updateOne(
      { guildId },
      { $set: { members, leaderId } }
    );
  }

  pushPacketToGuildMembers({ ...guild, members }, 1502, {
    playerid: getPlayerDbid(player),
    leaveTime: now,
  }, [session.userId]);
  pushGuildLeaveRecord(guildId, player);
  clearPlayerGuild(player, now);
  await saveSessionPlayer(session);
  return {
    tag: 1503,
    msgUid,
    data: {
      result: 0,
      myGuild: buildGuildPlayerData(player),
    },
  };
}

async function handleGuildApplyList(_params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) return { tag: 1503, msgUid, data: { applys: [] } };
  const guildInfo = ensureGuildPlayerData(player);
  const guildId = Math.max(0, toSafeInt(guildInfo.guildId, 0));
  if (guildId <= 0 || !hasGuildAuthority(guildInfo.identity, 1)) {
    return { tag: 1503, msgUid, data: { applys: [] } };
  }
  const guild = await Guild.findOne({ guildId }).lean();
  normalizeGuildIdentities(guild);
  const applys = guild && Array.isArray(guild.applications)
    ? guild.applications.map((row) => ({
      ...row,
      playerid: toSafeString(row && (row.playerid || row.playerId || row.dbid)),
      level: Math.max(1, toSafeInt(row && row.level, 1)),
      power: Math.max(0, toSafeInt(row && row.power, 0)),
    }))
    : [];
  return { tag: 1503, msgUid, data: { applys } };
}

async function handleQuitGuild(params = {}, session, msgUid) {
  const playerid = getPlayerDbid(session && session.player);
  const res = await handleLeaveGuild(params, session, msgUid);
  const ack = {
    ...res,
    tag: 1506,
    data: {
      ...(res && res.data),
      result: res && res.data && res.data.result === 0 ? 0 : 1,
    },
  };
  if (!playerid || !res || !res.data || res.data.result !== 0) return ack;
  return [
    {
      tag: 1502,
      msgUid: 0,
      data: {
        playerid,
        leaveTime: toSafeInt(res.data.myGuild && res.data.myGuild.leaveTime, Date.now()),
      },
    },
    ack,
  ];
}

async function handleGuildPlayerInfo(_params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return { tag: 1504, msgUid, data: createDefaultGuildPlayerData() };
  }
  return {
    tag: 1504,
    msgUid,
    data: buildGuildPlayerData(player),
  };
}

async function handleGuildApplyAction(params = {}, session, msgUid) {
  const player = session && session.player;
  const playerid = toSafeString(params.playerid || params.playerId || params.dbid);
  const response = (result, error = 0) => ({
    tag: 1504,
    msgUid,
    data: { result, error, playerid },
  });
  if (!player || !session.userId || !playerid) return response(1, 100001);

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = Math.max(0, toSafeInt(guildInfo.guildId, 0));
  if (guildId <= 0 || !hasGuildAuthority(guildInfo.identity, 1)) return response(1, 100001);

  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) return response(1, 100001);
  normalizeGuildIdentities(guild);
  const applications = Array.isArray(guild.applications) ? guild.applications.slice() : [];
  const applicationIndex = applications.findIndex((row) => (
    toSafeString(row && (row.playerid || row.playerId || row.dbid)) === playerid
  ));
  if (applicationIndex < 0) return response(1, 100002);

  applications.splice(applicationIndex, 1);
  if (toSafeInt(params.approve, 0) !== 1) {
    await Guild.updateOne({ guildId }, { $set: { applications } });
    return response(0, 0);
  }

  const targetPlayer = await playerService.findByDbidOrPlayerId(playerid);
  if (!targetPlayer) {
    await Guild.updateOne({ guildId }, { $set: { applications } });
    return response(1, 100002);
  }
  if (toSafeInt(targetPlayer.guildInfo && targetPlayer.guildInfo.guildId, 0) > 0) {
    await Guild.updateOne({ guildId }, { $set: { applications } });
    return response(1, 100003);
  }

  const members = Array.isArray(guild.members) ? guild.members.slice() : [];
  if (members.length >= Math.max(1, toSafeInt(guild.maxMembers, 30))) {
    await Guild.updateOne({ guildId }, { $set: { applications } });
    return response(1, 100004);
  }

  const now = Date.now();
  members.push(buildGuildMemberRecord(targetPlayer, targetPlayer.userId, 2, now, 0, 0));
  await Guild.updateOne({ guildId }, { $set: { members, applications } });
  guild.members = members;
  setPlayerGuild(targetPlayer, guild, 2, now);
  addGuildJoinCount(targetPlayer, 1);
  await playerService.savePlayer(targetPlayer.userId, targetPlayer);
  pushGuildJoinRecord(guildId, targetPlayer);
  const wsServer = runtimeBus.getWsServer();
  if (wsServer && typeof wsServer.pushToUser === 'function' && targetPlayer.userId) {
    wsServer.pushToUser(targetPlayer.userId, 1500, buildGuildInfo(guild));
    wsServer.pushToUser(targetPlayer.userId, 1504, buildGuildPlayerData(targetPlayer));
  }
  return response(0, 0);
}

async function handleGuildKickPlayer(params = {}, session, msgUid) {
  const player = session && session.player;
  const targetId = toSafeString(params.playerid || params.playerId || params.dbid);
  if (!player || !session.userId || !targetId) return { tag: 1507, msgUid, data: { result: 1 } };
  const guildInfo = ensureGuildPlayerData(player);
  const guildId = Math.max(0, toSafeInt(guildInfo.guildId, 0));
  if (guildId <= 0 || !hasGuildAuthority(guildInfo.identity, 2)) {
    return { tag: 1507, msgUid, data: { result: 1 } };
  }
  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) return { tag: 1507, msgUid, data: { result: 1 } };
  normalizeGuildIdentities(guild);
  const members = Array.isArray(guild.members) ? guild.members.slice() : [];
  const targetIndex = members.findIndex((row) => getMemberDbid(row) === targetId);
  if (targetIndex < 0 || toSafeInt(members[targetIndex].identity, 2) <= toSafeInt(guildInfo.identity, 3)) {
    return { tag: 1507, msgUid, data: { result: 1 } };
  }
  const targetMember = members[targetIndex];
  members.splice(targetIndex, 1);
  await Guild.updateOne({ guildId }, { $set: { members } });
  const targetPlayer = await playerService.findByDbidOrPlayerId(targetId);
  if (targetPlayer) {
    clearPlayerGuild(targetPlayer, Date.now());
    await playerService.savePlayer(targetPlayer.userId || targetMember.userId, targetPlayer);
    pushGuildLeaveRecord(guildId, targetPlayer);
  }
  const wsServer = runtimeBus.getWsServer();
  if (wsServer && typeof wsServer.pushToUser === 'function' && targetMember.userId) {
    wsServer.pushToUser(targetMember.userId, 1502, {
      playerid: targetId,
      leaveTime: Date.now(),
    });
  }
  pushPacketToGuildMembers({ ...guild, members }, 1502, {
    playerid: targetId,
    leaveTime: Date.now(),
  }, [targetMember.userId]);
  return { tag: 1507, msgUid, data: { result: 0 } };
}

async function handleGuildNeedLevel(params = {}, session, msgUid) {
  const player = session && session.player;
  const level = Math.max(0, toSafeInt(params.level, 0));
  if (!player || !session.userId) return { tag: 1510, msgUid, data: { result: 1 } };
  const guildInfo = ensureGuildPlayerData(player);
  const guildId = Math.max(0, toSafeInt(guildInfo.guildId, 0));
  if (guildId <= 0 || !hasGuildAuthority(guildInfo.identity, 1)) {
    return { tag: 1510, msgUid, data: { result: 1 } };
  }
  await Guild.updateOne({ guildId }, { $set: { needLevel: level } });
  guildInfo.needLevel = level;
  await saveSessionPlayer(session);
  return { tag: 1510, msgUid, data: { result: 0 } };
}

async function handleGuildAutoAdd(params = {}, session, msgUid) {
  const player = session && session.player;
  const auto = toSafeInt(params.auto, 0) > 0 ? 1 : 0;
  if (!player || !session.userId) return { tag: 1511, msgUid, data: { result: 1 } };
  const guildInfo = ensureGuildPlayerData(player);
  const guildId = Math.max(0, toSafeInt(guildInfo.guildId, 0));
  if (guildId <= 0 || !hasGuildAuthority(guildInfo.identity, 1)) {
    return { tag: 1511, msgUid, data: { result: 1 } };
  }
  await Guild.updateOne({ guildId }, { $set: { autoJoin: auto } });
  guildInfo.autoJoin = auto;
  await saveSessionPlayer(session);
  return { tag: 1511, msgUid, data: { result: 0 } };
}

async function handleGuildDetail(params = {}, session, msgUid) {
  const player = session && session.player;
  const fallbackGuildId = player ? toSafeInt(ensureGuildPlayerData(player).guildId, 0) : 0;
  const guildId = toSafeInt(params.guildId || params.id, fallbackGuildId);

  if (guildId <= 0) {
    return { tag: 1505, msgUid, data: { result: -1, guild: null, members: [] } };
  }

  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) {
    return { tag: 1505, msgUid, data: { result: -2, guild: null, members: [] } };
  }

  applySessionPlayerToGuildMembers(guild, player, session);
  await enrichGuildMembersFromPlayers(guild, session);
  const members = (Array.isArray(guild.members) ? guild.members : []).map(buildGuildMember);
  const detailGuild = { ...guild, members };
  return {
    tag: 1505,
    msgUid,
    data: {
      result: 0,
      ...buildGuildInfo(detailGuild),
      members,
    },
  };
}

async function handleGuildDonate(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1506, msgUid, data: { result: -1 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildInfo.guildId, 0);
  if (guildId <= 0) {
    return { tag: 1506, msgUid, data: { result: -2, myGuild: buildGuildPlayerData(player) } };
  }

  const donateType = toSafeInt(params.type || params.id, 1);
  const donateCfg = DONATE_CONFIG[donateType];
  if (!donateCfg) {
    return { tag: 1506, msgUid, data: { result: -1, myGuild: buildGuildPlayerData(player) } };
  }

  if (!hasEnoughCost(player, donateCfg.cost)) {
    return { tag: 1506, msgUid, data: { result: -3, myGuild: buildGuildPlayerData(player) } };
  }

  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) {
    clearPlayerGuild(player, Date.now());
    await saveSessionPlayer(session);
    return { tag: 1506, msgUid, data: { result: -2, myGuild: buildGuildPlayerData(player) } };
  }

  const members = Array.isArray(guild.members) ? guild.members.slice() : [];
  const memberIdx = members.findIndex((m) => toSafeString(m.userId) === session.userId);
  if (memberIdx < 0) {
    clearPlayerGuild(player, Date.now());
    await saveSessionPlayer(session);
    return { tag: 1506, msgUid, data: { result: -2, myGuild: buildGuildPlayerData(player) } };
  }

  consumeCost(player, donateCfg.cost);

  const member = { ...members[memberIdx] };
  member.donateCount = toSafeInt(member.donateCount, 0) + donateCfg.donateCount;
  members[memberIdx] = member;

  applyGuildGrowth(guild, donateCfg.guildExp);
  guild.activation = Math.max(0, toSafeInt(guild.activation, 0)) + getGuildDonateActivationGain();

  guildInfo.donateCount = toSafeInt(guildInfo.donateCount, 0) + donateCfg.donateCount;
  syncGuildActivation(guildInfo);
  guildInfo.guildName = toSafeString(guild.name);

  donateCfg.rewards.forEach((reward) => addRewardToPlayer(player, reward.id, reward.count));

  await Guild.updateOne(
    { guildId },
    {
      $set: {
        members,
        level: guild.level,
        exp: guild.exp,
        activation: Math.max(0, toSafeInt(guild.activation, 0)),
        maxMembers: guild.maxMembers,
      },
    }
  );
  await saveSessionPlayer(session);

  const rewardInfo = buildFullRewardInfo(donateCfg.rewards);
  const ack = {
    tag: 1506,
    msgUid,
    data: {
      result: 0,
      type: donateType,
      donateCount: toSafeInt(guildInfo.donateCount, 0),
      playerid: getPlayerDbid(player),
      donate: toSafeInt(guildInfo.donateCount, 0),
      totalDonate: toSafeInt(guildInfo.donateCount, 0),
      guild: buildGuildSummary({ ...guild, members }),
      rewards: rewardInfo,
      rewardInfo,
      myGuild: buildGuildPlayerData(player),
    },
  };
  return [buildRewardSyncPacket(player, donateCfg.rewards), ack];
}

async function handleGuildDonateDailyReward(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1507, msgUid, data: { result: -1 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const rewardId = toSafeInt(params.rewardId || params.id, 0);
  const rewardCfg = DONATE_DAILY_REWARD.find((row) => row.id === rewardId);
  if (!rewardCfg) {
    return { tag: 1507, msgUid, data: { result: -1, myGuild: buildGuildPlayerData(player) } };
  }

  if (toSafeInt(guildInfo.guildId, 0) <= 0) {
    return { tag: 1507, msgUid, data: { result: -2, myGuild: buildGuildPlayerData(player) } };
  }

  if (!Array.isArray(guildInfo.dailyReward)) guildInfo.dailyReward = [];
  if (guildInfo.dailyReward.includes(rewardId)) {
    return { tag: 1507, msgUid, data: { result: -4, myGuild: buildGuildPlayerData(player) } };
  }

  if (toSafeInt(guildInfo.donateCount, 0) < rewardCfg.need) {
    return { tag: 1507, msgUid, data: { result: -3, myGuild: buildGuildPlayerData(player) } };
  }

  rewardCfg.rewards.forEach((reward) => addRewardToPlayer(player, reward.id, reward.count));
  guildInfo.dailyReward.push(rewardId);
  await saveSessionPlayer(session);

  const rewardInfo = buildFullRewardInfo(rewardCfg.rewards);
  const ack = {
    tag: 1507,
    msgUid,
    data: {
      result: 0,
      rewardId,
      rewards: rewardInfo,
      rewardInfo,
      myGuild: buildGuildPlayerData(player),
    },
  };
  return [buildRewardSyncPacket(player, rewardCfg.rewards), ack];
}

async function handleGuildChangeNotice(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1509, msgUid, data: { result: 1, desc: '' } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildInfo.guildId, 0);
  if (guildId <= 0) {
    return { tag: 1509, msgUid, data: { result: 1, desc: '', notice: '' } };
  }
  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) {
    clearPlayerGuild(player, Date.now());
    await saveSessionPlayer(session);
    return { tag: 1509, msgUid, data: { result: 1, desc: '', notice: '' } };
  }
  normalizeGuildIdentities(guild);

  const members = Array.isArray(guild.members) ? guild.members.slice() : [];
  const self = members.find((m) => toSafeString(m.userId) === session.userId);
  if (!self || !hasGuildAuthority(self.identity, 4)) {
    return { tag: 1509, msgUid, data: { result: 1, desc: '', notice: toSafeString(guild.notice) } };
  }

  const noticeRaw = toSafeString(params.notice || params.content || params.text);
  const noticeLengthMax = Math.max(1, toSafeInt(getGuildBaseConfig().noticeLengthMax, 90));
  const notice = noticeRaw.length > noticeLengthMax ? noticeRaw.slice(0, noticeLengthMax) : noticeRaw;
  await Guild.updateOne({ guildId }, { $set: { notice } });

  const pushData = { notice };
  pushPacketToGuildMembers(guild, 1515, pushData, [session.userId]);
  return [{ tag: 1515, msgUid: 0, data: pushData }, {
    tag: 1509,
    msgUid,
    data: {
      result: 0,
      guildId,
      notice,
    },
  }];
}

async function handleGuildIdentityChange(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1510, msgUid, data: { result: -1 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildInfo.guildId, 0);
  if (guildId <= 0) {
    return { tag: 1510, msgUid, data: { result: -2 } };
  }
  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) {
    clearPlayerGuild(player, Date.now());
    await saveSessionPlayer(session);
    return { tag: 1510, msgUid, data: { result: -2 } };
  }
  normalizeGuildIdentities(guild);

  const members = Array.isArray(guild.members) ? guild.members.slice() : [];
  const self = members.find((m) => toSafeString(m.userId) === session.userId);
  if (!self || !hasGuildAuthority(self.identity, 7)) {
    return { tag: 1510, msgUid, data: { result: -3 } };
  }

  const targetPlayerId = toSafeString(params.playerId || params.playerid || params.dbid || params.targetId || params.id || params.userId);
  const identity = toSafeInt(params.identity, -1);
  if (!targetPlayerId || (identity !== 0 && identity !== 1 && identity !== 2)) {
    return { tag: 1510, msgUid, data: { result: -1 } };
  }

  const targetIdx = members.findIndex((member) => (
    getMemberDbid(member) === targetPlayerId || toSafeString(member && member.userId) === targetPlayerId
  ));
  if (targetIdx < 0) {
    return { tag: 1510, msgUid, data: { result: -4 } };
  }

  const targetMember = members[targetIdx];
  const targetUserId = toSafeString(targetMember.userId || targetMember.userid);
  const targetDbid = getMemberDbid(targetMember, targetPlayerId);
  if (!targetUserId || targetUserId === session.userId) {
    return { tag: 1510, msgUid, data: { result: -5 } };
  }

  const pushPackets = [];
  if (identity === 0) {
    self.identity = 1;
    targetMember.identity = 0;
    guild.leaderId = targetUserId;
    guildInfo.identity = 1;
    const selfPush = { playerid: getMemberDbid(self, getPlayerDbid(player)), identity: 1 };
    pushPackets.push({ tag: 1510, msgUid: 0, data: selfPush });
    pushPacketToGuildMembers({ ...guild, members }, 1510, selfPush, [session.userId]);
  } else {
    targetMember.identity = identity;
  }

  await Guild.updateOne(
    { guildId },
    { $set: { members, leaderId: guild.leaderId } }
  );

  await saveSessionPlayer(session);
  const targetPlayer = await playerService.findByDbidOrPlayerId(targetDbid).catch(() => null);
  if (targetPlayer) {
    ensureGuildPlayerData(targetPlayer).identity = identity;
    await playerService.savePlayer(targetPlayer.userId || targetUserId, targetPlayer);
  }

  const identityPush = { playerid: targetDbid, identity };
  pushPackets.push({ tag: 1510, msgUid: 0, data: identityPush });
  pushPacketToGuildMembers({ ...guild, members }, 1510, identityPush, [session.userId]);
  if (identity === 0) {
    const leaderPush = { playerid: targetDbid };
    pushPackets.push({ tag: 1503, msgUid: 0, data: leaderPush });
    pushPacketToGuildMembers({ ...guild, members }, 1503, leaderPush, [session.userId]);
  }

  pushPackets.push({
    tag: 1510,
    msgUid,
    data: {
      result: 0,
      guildId,
      userId: targetUserId,
      playerid: targetDbid,
      identity,
      members: members.map(buildGuildMember),
    },
  });
  return pushPackets;
}

async function handleGuildDonateUpdate(_params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1511, msgUid, data: { result: -1 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildInfo.guildId, 0);
  if (guildId <= 0) {
    return {
      tag: 1511,
      msgUid,
      data: {
        result: 0,
        myGuild: buildGuildPlayerData(player),
        guild: null,
      },
    };
  }

  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) {
    clearPlayerGuild(player, Date.now());
    await saveSessionPlayer(session);
    return {
      tag: 1511,
      msgUid,
      data: {
        result: 0,
        myGuild: buildGuildPlayerData(player),
        guild: null,
      },
    };
  }

  return {
    tag: 1511,
    msgUid,
    data: {
      result: 0,
      myGuild: buildGuildPlayerData(player),
      guild: buildGuildSummary(guild),
    },
  };
}

async function handleGuildActivationUpdate(_params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1508, msgUid, data: { result: -1 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  return {
    tag: 1508,
    msgUid,
    data: {
      result: 0,
      guildId: toSafeInt(guildInfo.guildId, 0),
      activation: {
        donateCount: toSafeInt(guildInfo.donateCount, 0),
        blessCount: toSafeInt(guildInfo.blessCount, 0),
        bossAssist: toSafeInt(guildInfo.bossAssist, 0),
      },
      myGuild: buildGuildPlayerData(player),
    },
  };
}

async function handleGuildChangeIcon(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1514, msgUid, data: { result: -1 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildInfo.guildId, 0);
  if (guildId <= 0) {
    return { tag: 1514, msgUid, data: { result: -2 } };
  }
  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) {
    clearPlayerGuild(player, Date.now());
    await saveSessionPlayer(session);
    return { tag: 1514, msgUid, data: { result: -2 } };
  }
  normalizeGuildIdentities(guild);

  const members = Array.isArray(guild.members) ? guild.members : [];
  const self = members.find((m) => toSafeString(m.userId) === session.userId);
  if (!self || !hasGuildAuthority(self.identity, 5)) {
    return { tag: 1514, msgUid, data: { result: -3, icon: toSafeInt(guild.icon, 0) } };
  }

  const icon = toSafeInt(params.icon != null ? params.icon : (params.iconId != null ? params.iconId : params.id), -1);
  const iconCount = Array.isArray(getGuildBaseConfig().guildIcon) ? getGuildBaseConfig().guildIcon.length : 30;
  if (icon < 0 || icon >= iconCount) {
    return { tag: 1514, msgUid, data: { result: -1, icon: toSafeInt(guild.icon, 0) } };
  }

  await Guild.updateOne({ guildId }, { $set: { icon } });
  return {
    tag: 1514,
    msgUid,
    data: {
      result: 0,
      guildId,
      icon,
    },
  };
}

async function handleGuildRename(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1515, msgUid, data: { result: 1, error: 100006 } };
  }
  const guildInfo = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildInfo.guildId, 0);
  if (guildId <= 0) {
    return { tag: 1515, msgUid, data: { result: 1, error: 100006 } };
  }

  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) {
    clearPlayerGuild(player, Date.now());
    await saveSessionPlayer(session);
    return { tag: 1515, msgUid, data: { result: 1, error: 100006 } };
  }
  normalizeGuildIdentities(guild);

  const members = Array.isArray(guild.members) ? guild.members : [];
  const self = members.find((m) => toSafeString(m.userId) === session.userId);
  if (!self || !hasGuildAuthority(self.identity, 3)) {
    return { tag: 1515, msgUid, data: { result: 1, error: 100006, name: toSafeString(guild.name) } };
  }

  const nextNameRaw = toSafeString(params.name || params.guildName || params.rename);
  const baseCfg = getGuildBaseConfig();
  const nameLengthMax = Math.max(1, toSafeInt(baseCfg.nameLengthMax, 6));
  const nextName = nextNameRaw;
  if (!nextName || nextName.length > nameLengthMax) {
    return { tag: 1515, msgUid, data: { result: 1, error: 100006, name: toSafeString(guild.name) } };
  }

  const renameCosts = nextName !== toSafeString(guild.name)
    ? normalizeItemRows(baseCfg.changeNameCost ? [baseCfg.changeNameCost] : [])
    : [];
  if (!hasEnoughCosts(player, renameCosts)) {
    return { tag: 1515, msgUid, data: { result: 1, error: 100006, name: toSafeString(guild.name) } };
  }

  if (nextName !== toSafeString(guild.name)) {
    const existed = await Guild.findOne({ name: nextName }).lean();
    if (existed && toSafeInt(existed.guildId, 0) !== guildId) {
      return { tag: 1515, msgUid, data: { result: 1, error: 100005, name: toSafeString(guild.name) } };
    }
    await Guild.updateOne({ guildId }, { $set: { name: nextName } });
    consumeCosts(player, renameCosts);
  }

  guildInfo.guildName = nextName;
  await saveSessionPlayer(session);

  const nextGuild = { ...guild, name: nextName };
  const initData = buildGuildInfo(nextGuild);
  pushPacketToGuildMembers(guild, 1500, initData, [session.userId]);
  return [
    ...(renameCosts.length > 0 ? [buildCostSyncPacket(player, renameCosts)] : []),
    { tag: 1500, msgUid: 0, data: initData },
    {
    tag: 1515,
    msgUid,
    data: {
      result: 0,
      guildId,
      name: nextName,
      myGuild: buildGuildPlayerData(player),
    },
    },
  ];
}

async function handleGuildDonateV2(params = {}, session, msgUid) {
  const player = session && session.player;
  const fail = (donateCount = 0) => ({
    tag: 1516,
    msgUid,
    data: {
      result: 1,
      donateCount: Math.max(0, toSafeInt(donateCount, 0)),
      rewards: buildFullRewardInfo([]),
    },
  });
  if (!player || !session.userId) return fail(0);

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = Math.max(0, toSafeInt(guildInfo.guildId, 0));
  const donateCount = Math.max(0, toSafeInt(guildInfo.donateCount, 0));
  if (guildId <= 0) return fail(donateCount);

  const dailyLimit = Math.max(0, toSafeInt(getGuildBaseConfig().guildDonate, 5));
  const donateCfg = getGuildDonateConfig(donateCount);
  if (!donateCfg || donateCount >= dailyLimit) return fail(donateCount);

  const costs = normalizeItemRows(donateCfg.costs);
  const rewards = normalizeItemRows(donateCfg.rewards);
  if (!hasEnoughCosts(player, costs)) return fail(donateCount);

  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) return fail(donateCount);
  const members = Array.isArray(guild.members) ? guild.members.slice() : [];
  const selfDbid = getPlayerDbid(player);
  const memberIdx = members.findIndex((member) => (
    toSafeString(member && member.userId) === session.userId || getMemberDbid(member) === selfDbid
  ));
  if (memberIdx < 0) return fail(donateCount);

  consumeCosts(player, costs);
  const playerRewards = rewards.filter((reward) => reward.id !== 18);
  playerRewards.forEach((reward) => addRewardToPlayer(player, reward.id, reward.count));

  const guildExp = rewards
    .filter((reward) => reward.id === 18)
    .reduce((sum, reward) => sum + reward.count, 0);
  const contribution = rewards
    .filter((reward) => reward.id === 16)
    .reduce((sum, reward) => sum + reward.count, 0);
  applyGuildGrowth(guild, guildExp);

  const member = { ...members[memberIdx] };
  member.donateCount = Math.max(0, toSafeInt(member.donateCount, 0)) + contribution;
  member.donate = Math.max(0, toSafeInt(member.donate, 0)) + contribution;
  member.weekdonate = Math.max(0, toSafeInt(member.weekdonate, 0)) + contribution;
  member.totalDonate = Math.max(0, toSafeInt(member.totalDonate, 0)) + contribution;
  member.totaldonate = member.totalDonate;
  members[memberIdx] = member;

  guildInfo.donateCount = donateCount + 1;
  await Guild.updateOne({ guildId }, {
    $set: {
      members,
      level: guild.level,
      exp: guild.exp,
      maxMembers: guild.maxMembers,
    },
  });
  await saveSessionPlayer(session);

  const expPush = { exp: Math.max(0, toSafeInt(guild.exp, 0)), level: Math.max(1, toSafeInt(guild.level, 1)) };
  const donatePush = {
    playerid: selfDbid,
    donate: Math.max(0, toSafeInt(member.donate, 0)),
    totalDonate: Math.max(0, toSafeInt(member.totalDonate, 0)),
  };
  pushPacketToGuildMembers({ ...guild, members }, 1505, expPush, [session.userId]);
  pushPacketToGuildMembers({ ...guild, members }, 1511, donatePush, [session.userId]);

  const rewardInfo = buildFullRewardInfo(rewards);
  return [
    ...(costs.length > 0 ? [buildCostSyncPacket(player, costs)] : []),
    ...(playerRewards.length > 0 ? [buildRewardSyncPacket(player, playerRewards)] : []),
    { tag: 1505, msgUid: 0, data: expPush },
    { tag: 1511, msgUid: 0, data: donatePush },
    {
      tag: 1516,
      msgUid,
      data: {
        result: 0,
        donateCount: guildInfo.donateCount,
        rewards: rewardInfo,
        rewardInfo,
      },
    },
  ];
}

async function handleGuildDonateDailyRewardV2(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1517, msgUid, data: { result: -1, ids: [], rewardInfo: buildFullRewardInfo([]) } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  if (toSafeInt(guildInfo.guildId, 0) <= 0) {
    return { tag: 1517, msgUid, data: { result: -2, ids: [], rewardInfo: buildFullRewardInfo([]), myGuild: buildGuildPlayerData(player) } };
  }

  const guildQuery = Guild.findOne({ guildId: toSafeInt(guildInfo.guildId, 0) });
  const guild = guildQuery && typeof guildQuery.lean === 'function'
    ? await guildQuery.lean().catch(() => null)
    : null;
  if (!guild) {
    clearPlayerGuild(player, Date.now());
    await saveSessionPlayer(session);
    return { tag: 1517, msgUid, data: { result: -2, ids: [], rewardInfo: buildFullRewardInfo([]), myGuild: buildGuildPlayerData(player) } };
  }

  if (!Array.isArray(guildInfo.dailyReward)) guildInfo.dailyReward = [];
  const rewardCfgMap = getGuildDailyRewardConfig();
  const requestIds = (Array.isArray(params.ids) ? params.ids : [params.rewardId || params.id])
    .map((id) => toSafeInt(id, 0))
    .filter((id) => id > 0);
  const activation = Math.max(0, toSafeInt(guild.activation, toSafeInt(params.activation, 0)));
  const claimed = [];
  const rewards = [];

  requestIds.forEach((rewardId) => {
    if (guildInfo.dailyReward.includes(rewardId)) return;
    if (activation < rewardId) return;
    const rows = Array.isArray(rewardCfgMap[rewardId] || rewardCfgMap[String(rewardId)])
      ? (rewardCfgMap[rewardId] || rewardCfgMap[String(rewardId)])
      : [];
    if (rows.length <= 0) return;
    rows.forEach((row) => {
      const reward = { id: toSafeInt(row && row.id, 0), count: Math.max(0, toSafeInt(row && row.count, 0)) };
      if (reward.id <= 0 || reward.count <= 0) return;
      addRewardToPlayer(player, reward.id, reward.count);
      rewards.push(reward);
    });
    guildInfo.dailyReward.push(rewardId);
    claimed.push(rewardId);
  });

  if (claimed.length <= 0) {
    return { tag: 1517, msgUid, data: { result: -3, ids: [], rewardInfo: buildFullRewardInfo([]), myGuild: buildGuildPlayerData(player) } };
  }

  await saveSessionPlayer(session);
  const rewardInfo = buildFullRewardInfo(rewards);
  return [
    buildRewardSyncPacket(player, rewards),
    {
      tag: 1517,
      msgUid,
      data: {
        result: 0,
        ids: claimed,
        rewards: rewardInfo,
        rewardInfo,
        myGuild: buildGuildPlayerData(player),
      },
    },
  ];
}

async function handleGuildIdentityChangeV2(params = {}, session, msgUid) {
  const res = await handleGuildIdentityChange(params, session, msgUid);
  if (Array.isArray(res)) {
    return res.map((packet) => (
      packet && packet.tag === 1510 && packet.msgUid === msgUid
        ? { ...packet, tag: 1520 }
        : packet
    ));
  }
  return {
    ...res,
    tag: 1520,
  };
}

async function handleGuildChat(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1518, msgUid, data: { result: 1, list: [] } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildInfo.guildId, 0);
  if (guildId <= 0) {
    return { tag: 1518, msgUid, data: { result: 1, list: [] } };
  }

  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) return { tag: 1518, msgUid, data: { result: 1, list: [] } };

  const record = buildGuildChatRecord(player, params, guildId);
  if (!record) return { tag: 1518, msgUid, data: { result: 1, list: [] } };
  pushGuildChat(guildId, record);

  const pushData = { record };
  pushPacketToGuildMembers(guild, 1507, pushData, [session.userId]);
  return [{ tag: 1507, msgUid: 0, data: pushData }, {
    tag: 1518,
    msgUid,
    data: {
      result: 0,
      guildId,
      list: getGuildChatList(guildId),
    },
  }];
}

async function handleGuildAssistOther(params = {}, session, msgUid) {
  const player = session && session.player;
  const fail = () => ({ tag: 1519, msgUid, data: { result: 0 } });
  if (!player || !session.userId) return fail();
  const guildId = Math.max(0, toSafeInt(ensureGuildPlayerData(player).guildId, 0));
  if (guildId <= 0) return fail();

  const targetPlayerId = toSafeString(params.playerId || params.playerid || params.dbid || params.targetId);
  const type = Math.max(0, toSafeInt(params.type, 0));
  const index = Math.max(0, toSafeInt(params.index, 0));
  const selfDbid = getPlayerDbid(player);
  if (!targetPlayerId || targetPlayerId === selfDbid || type <= 0) return fail();

  const records = getGuildRecordList(guildId).slice();
  const recordIndex = records.findIndex((row) => {
    const assist = row && row.assistData;
    if (!assist || assist.finish || toSafeString(row.playerId) !== targetPlayerId || toSafeInt(assist.type, 0) !== type) return false;
    if ((type === 2 || type === 4) && toSafeInt(assist.plantBuildInfo && assist.plantBuildInfo.index, 0) !== index) return false;
    if (type === 3 && toSafeInt(assist.fightInfo && assist.fightInfo.index, 0) !== index) return false;
    return true;
  });
  if (recordIndex < 0) return fail();

  const record = records[recordIndex];
  const assist = { ...record.assistData };
  let list = null;
  if (type === 1 && assist.boxinfo) {
    assist.boxinfo = { ...assist.boxinfo, list: Array.isArray(assist.boxinfo.list) ? assist.boxinfo.list.slice() : [] };
    list = assist.boxinfo.list;
  } else if ((type === 2 || type === 4) && assist.plantBuildInfo) {
    assist.plantBuildInfo = {
      ...assist.plantBuildInfo,
      list: Array.isArray(assist.plantBuildInfo.list) ? assist.plantBuildInfo.list.slice() : [],
    };
    list = assist.plantBuildInfo.list;
  }

  const helperLimit = type === 3 ? 1 : Math.max(1, toSafeInt(getGuildBaseConfig().helperCount, 10));
  if (list && (list.includes(selfDbid) || list.length >= helperLimit)) return fail();
  if (list) list.push(selfDbid);
  records[recordIndex] = { ...record, assistData: assist };
  setGuildRecordList(guildId, records);

  const guild = await Guild.findOne({ guildId }).lean();
  const assistPush = { playerId: targetPlayerId, assist };
  if (guild) pushPacketToGuildMembers(guild, 1509, assistPush, [session.userId]);
  const packets = [{ tag: 1509, msgUid: 0, data: assistPush }];
  if (type === 3) {
    const playerAttrs = battleService.calcPlayerPower(player);
    const enemyAttrs = battleService.generateOpponentAttrs(Math.max(1, toSafeInt(player.level, 1)), 0);
    packets.push({
      tag: 1517,
      msgUid: 0,
      data: { fightResult: battleService.simulateBattle(playerAttrs, enemyAttrs) },
    });
  }
  packets.push({ tag: 1519, msgUid, data: { result: 1 } });
  return packets;
}

async function handleGuildAssistAction(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1525, msgUid, data: {} };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildInfo.guildId, 0);
  if (guildId <= 0) {
    return { tag: 1525, msgUid, data: {} };
  }

  const dailyLimit = Math.max(0, toSafeInt(getGuildBaseConfig().guildBossPlusDailyCount, 1));
  if (toSafeInt(guildInfo.bossAssist, 0) >= dailyLimit) {
    return { tag: 1525, msgUid, data: { result: -1 } };
  }
  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) return { tag: 1525, msgUid, data: { result: -1 } };

  guildInfo.bossAssist = toSafeInt(guildInfo.bossAssist, 0) + 1;
  pushGuildBattleLog(guildId, {
    type: 'assist',
    userId: session.userId,
    time: Date.now(),
  });
  const assistPacket = recordGuildAssist(player);
  await saveSessionPlayer(session);

  pushPacketToGuildMembers(guild, 1514, assistPacket.data, [session.userId]);
  return [assistPacket, {
    tag: 1525,
    msgUid,
    data: {
      result: 0,
      myGuild: buildGuildPlayerData(player),
    },
  }];
}

async function handleGuildBless(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1521, msgUid, data: { result: -1 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildInfo.guildId, 0);
  if (guildId <= 0) {
    return { tag: 1521, msgUid, data: { result: -2, myGuild: buildGuildPlayerData(player) } };
  }

  const dailyLimit = Math.max(1, toSafeInt(getGuildBaseConfig().blessCount, 1));
  if (toSafeInt(guildInfo.blessCount, 0) >= dailyLimit) {
    return { tag: 1521, msgUid, data: { result: -3, myGuild: buildGuildPlayerData(player) } };
  }

  const blessGain = Math.max(1, toSafeInt(params.value || process.env.GUILD_BLESS_VALUE_GAIN, 138));
  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) return { tag: 1521, msgUid, data: { result: -2, myGuild: buildGuildPlayerData(player) } };
  const blessValue = Math.max(0, toSafeInt(guild && guild.blessValue, 0)) + blessGain;
  const blessRecords = (Array.isArray(guild && guild.blessRecords) ? guild.blessRecords.slice() : [])
    .concat(getPlayerDbid(player))
    .slice(-50);
  if (guild) {
    await Guild.updateOne({ guildId }, { $set: { blessValue, blessRecords } });
  }
  guildInfo.blessValue = blessValue;
  guildInfo.blessRecords = blessRecords;

  guildInfo.blessCount = toSafeInt(guildInfo.blessCount, 0) + 1;
  const rewardSilver = Math.max(0, toSafeInt(params.rewardSilver, 0));
  if (rewardSilver > 0) addRewardToPlayer(player, 2, rewardSilver);
  await saveSessionPlayer(session);

  const blessPushData = {
    blessValue,
    playerid: getPlayerDbid(player),
  };
  pushPacketToGuildMembers(guild, 1512, blessPushData, [session.userId]);
  const blessUpdatePacket = { tag: 1512, msgUid: 0, data: blessPushData };
  const ack = {
    tag: 1521,
    msgUid,
    data: {
      result: 0,
      value: blessGain,
      blessValue,
      blessCount: toSafeInt(guildInfo.blessCount, 0),
      blessRecord: toSafeInt(guildInfo.blessRecord, 0),
      playerid: getPlayerDbid(player),
      rewards: rewardSilver > 0 ? buildFullRewardInfo([{ id: 2, count: rewardSilver }]) : buildFullRewardInfo([]),
      rewardInfo: rewardSilver > 0 ? buildFullRewardInfo([{ id: 2, count: rewardSilver }]) : buildFullRewardInfo([]),
      myGuild: buildGuildPlayerData(player),
    },
  };
  return rewardSilver > 0
    ? [buildRewardSyncPacket(player, [{ id: 2, count: rewardSilver }]), blessUpdatePacket, ack]
    : [blessUpdatePacket, ack];
}

function startOfDay(ts) {
  const date = new Date(toSafeInt(ts, Date.now()));
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

async function handleGuildBlessReward(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1522, msgUid, data: { result: -1 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  if (toSafeInt(guildInfo.guildId, 0) <= 0) {
    return { tag: 1522, msgUid, data: { result: -2, myGuild: buildGuildPlayerData(player) } };
  }

  const guildId = Math.max(0, toSafeInt(guildInfo.guildId, 0));
  const guild = await Guild.findOne({ guildId }).lean();
  if (!guild) return { tag: 1522, msgUid, data: { result: -2, myGuild: buildGuildPlayerData(player) } };
  const blessMax = Math.max(1, toSafeInt(getGuildLevelConfig(guild.blessLv || guild.level).blessValueMax, 1600));
  if (Math.max(0, toSafeInt(guild.blessValue, 0)) < blessMax) {
    return { tag: 1522, msgUid, data: { result: -3, myGuild: buildGuildPlayerData(player) } };
  }
  if (toSafeInt(guildInfo.blessRecord, 0) > 0) {
    return { tag: 1522, msgUid, data: { result: -4, myGuild: buildGuildPlayerData(player) } };
  }

  const now = Date.now();
  const rewards = getGuildBlessRewards(guild);
  if (rewards.length <= 0) {
    return { tag: 1522, msgUid, data: { result: -3, myGuild: buildGuildPlayerData(player) } };
  }
  rewards.forEach((reward) => addRewardToPlayer(player, reward.id, reward.count));

  guildInfo.blessRecord = 1;
  guildInfo.blessDailyClaimTime = now;
  await saveSessionPlayer(session);

  const rewardInfo = buildFullRewardInfo(rewards);
  return [
    buildRewardSyncPacket(player, rewards),
    {
    tag: 1522,
    msgUid,
    data: {
      result: 0,
      rewards: rewardInfo,
      rewardInfo,
      myGuild: buildGuildPlayerData(player),
    },
    },
  ];
}

async function handleGuildBlessUpdate(_params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1512, msgUid, data: { result: -1 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildInfo.guildId, 0);
  let guild = null;
  if (guildId > 0) {
    const query = Guild.findOne({ guildId });
    guild = query && typeof query.lean === 'function'
      ? await query.lean().catch(() => null)
      : null;
  }
  if (guild) {
    guildInfo.blessLv = Math.max(1, toSafeInt(guild.blessLv, guildInfo.blessLv));
    guildInfo.blessValue = Math.max(0, toSafeInt(guild.blessValue, guildInfo.blessValue));
    guildInfo.blessRewards = getGuildBlessRewards(guild);
    guildInfo.blessRecords = Array.isArray(guild.blessRecords) ? guild.blessRecords.slice() : [];
  }
  return {
    tag: 1512,
    msgUid,
    data: {
      result: 0,
      blessLv: Math.max(1, toSafeInt(guildInfo.blessLv, 1)),
      blessCount: toSafeInt(guildInfo.blessCount, 0),
      blessRecord: toSafeInt(guildInfo.blessRecord, 0),
      blessValue: Math.max(0, toSafeInt(guildInfo.blessValue, 0)),
      blessRewards: Array.isArray(guildInfo.blessRewards) ? guildInfo.blessRewards.slice() : [],
      blessRecords: Array.isArray(guildInfo.blessRecords) ? guildInfo.blessRecords.slice() : [],
      playerid: getPlayerDbid(player),
    },
  };
}

async function handleGuildBossInfo(_params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1513, msgUid, data: { result: -1 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  return {
    tag: 1513,
    msgUid,
    data: {
      assistRecords: Array.isArray(guildInfo.assistRecords) ? guildInfo.assistRecords.slice() : [],
      result: 0,
      totalDamage: Math.max(0, toSafeInt(guildInfo.totalDamage, 0)),
      damageRecords: Array.isArray(guildInfo.damageRecords) ? guildInfo.damageRecords.map(normalizeDamageRecordRow) : [],
      bossCount: Math.max(0, toSafeInt(guildInfo.bossCount, 0)),
      bossAssist: Math.max(0, toSafeInt(guildInfo.bossAssist, 0)),
      bossReward: Array.isArray(guildInfo.bossReward) ? guildInfo.bossReward.slice() : [],
    },
  };
}

async function handleGuildHuntingReceiveReward(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1523, msgUid, data: { result: -1, list: [], rewardInfo: buildFullRewardInfo([]) } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildInfo.guildId, 0);
  if (guildId <= 0) {
    return { tag: 1523, msgUid, data: { result: -2, list: [], rewardInfo: buildFullRewardInfo([]), myGuild: buildGuildPlayerData(player) } };
  }

  if (!Array.isArray(guildInfo.bossReward)) guildInfo.bossReward = [];
  const requestList = Array.isArray(params.list) ? params.list : [params.rewardId || params.id];
  const rewardIds = requestList.map((id) => toSafeInt(id, 0)).filter((id) => id > 0);
  if (!rewardIds.length) {
    return { tag: 1523, msgUid, data: { result: -1, list: [], rewardInfo: buildFullRewardInfo([]) } };
  }

  const allItems = [];
  const claimed = [];

  rewardIds.forEach((rewardId) => {
    const rewardCfg = getGuildHuntingRewardRows().find((row) => row.id === rewardId);
    if (!rewardCfg) return;
    if (guildInfo.bossReward.includes(rewardId)) return;
    if (Math.max(0, toSafeInt(guildInfo.totalDamage, 0)) < rewardCfg.need) return;

    rewardCfg.rewards.forEach((reward) => {
      addRewardToPlayer(player, reward.id, reward.count);
      allItems.push({ id: reward.id, count: reward.count });
    });
    guildInfo.bossReward.push(rewardId);
    claimed.push(rewardId);
    pushGuildBattleLog(guildId, {
      type: 'huntingReward',
      userId: session.userId,
      rewardId,
      time: Date.now(),
    });
  });

  await saveSessionPlayer(session);

  if (claimed.length <= 0) {
    return {
      tag: 1523,
      msgUid,
      data: {
        result: -4,
        list: [],
        rewardInfo: buildFullRewardInfo([]),
      },
    };
  }

  return [
    buildRewardSyncPacket(player, allItems),
    {
      tag: 1523,
      msgUid,
      data: {
        result: 0,
        list: claimed,
        bossReward: guildInfo.bossReward.slice(),
        totalDamage: Math.max(0, toSafeInt(guildInfo.totalDamage, 0)),
        rewardInfo: buildFullRewardInfo(allItems),
      },
    },
  ];
}

async function handleGuildRank(params = {}, session, msgUid) {
  const pageSize = Math.min(100, Math.max(1, toSafeInt(params.pageSize || params.count, 50)));
  const rows = await Guild.find({}).sort({ level: -1, exp: -1, guildId: 1 }).limit(pageSize).lean();
  const list = (rows || []).map((row, idx) => {
    const guild = ensureSessionPlayerInGuildRank({ ...row }, session);
    return {
      rank: idx + 1,
      ...buildGuildSummary(guild),
    };
  });

  const player = session && session.player;
  const myGuildId = player ? toSafeInt(ensureGuildPlayerData(player).guildId, 0) : 0;
  let myRank = 0;
  if (myGuildId > 0) {
    const selfIndex = list.findIndex((row) => toSafeInt(row.guildId, 0) === myGuildId);
    if (selfIndex >= 0) myRank = selfIndex + 1;
  }

  return {
    tag: 1524,
    msgUid,
    data: {
      result: 0,
      ranklist: list,
      rank: myRank,
      list,
      myRank,
    },
  };
}

async function handleGuildHuntingAssist(params = {}, session, msgUid) {
  return handleGuildAssistAction(params, session, msgUid);
}

async function handleGuildExchange(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1526, msgUid, data: { result: -1 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildInfo.guildId, 0);
  if (guildId <= 0) {
    return { tag: 1526, msgUid, data: { result: -2, list: [] } };
  }

  const uid = toSafeString(params.uid);
  const itemId = Math.max(0, toSafeInt(params.itemId, 0));
  const exchangeId = Math.max(0, toSafeInt(params.exchangeId, 0));
  const list = getGuildExchangeList(guildId).slice();
  const idx = list.findIndex((row) => toSafeString(row && row.uid) === uid);
  const exchange = idx >= 0 ? list[idx] : null;
  if (!exchange || itemId <= 0 || exchangeId <= 0) {
    return { tag: 1526, msgUid, data: { result: -1, list: getGuildExchangeList(guildId) } };
  }
  if (toSafeString(exchange.userId) === session.userId
    || toSafeInt(exchange.itemId, 0) !== itemId
    || !Array.isArray(exchange.exchanges)
    || !exchange.exchanges.map((id) => toSafeInt(id, 0)).includes(exchangeId)) {
    return { tag: 1526, msgUid, data: { result: -2, list } };
  }

  const publisher = typeof playerService.loadPlayer === 'function'
    ? await playerService.loadPlayer(toSafeString(exchange.userId))
    : null;
  if (!publisher
    || !hasEnoughCost(player, { id: itemId, count: 1 })
    || !hasEnoughCost(publisher, { id: exchangeId, count: 1 })) {
    return { tag: 1526, msgUid, data: { result: -3, list: getGuildExchangeList(guildId) } };
  }

  consumeCost(player, { id: itemId, count: 1 });
  addRewardToPlayer(player, exchangeId, 1);
  consumeCost(publisher, { id: exchangeId, count: 1 });
  addRewardToPlayer(publisher, itemId, 1);
  list.splice(idx, 1);
  setGuildExchangeList(guildId, list);

  await saveSessionPlayer(session);
  await playerService.savePlayer(toSafeString(exchange.userId), publisher);

  return [
    {
      tag: 1526,
      msgUid,
      data: { result: 0 },
    },
    {
      tag: 1521,
      msgUid: 0,
      data: { uids: [uid] },
    },
  ];
}

async function handleGuildCancelExchange(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player || !session.userId) {
    return { tag: 1527, msgUid, data: { result: -1 } };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = toSafeInt(guildInfo.guildId, 0);
  if (guildId <= 0) {
    return { tag: 1527, msgUid, data: { result: -2, list: [] } };
  }

  const list = getGuildExchangeList(guildId).slice();
  const uids = list
    .filter((row) => toSafeString(row && row.userId) === session.userId)
    .map((row) => toSafeString(row && row.uid))
    .filter(Boolean);
  setGuildExchangeList(
    guildId,
    list.filter((row) => toSafeString(row && row.userId) !== session.userId)
  );
  await saveSessionPlayer(session);

  const packets = [
    {
      tag: 1527,
      msgUid,
      data: { result: 0 },
    },
  ];
  if (uids.length > 0) packets.push({ tag: 1521, msgUid: 0, data: { uids } });
  return packets;
}

async function handleGuildDetailV2(params = {}, session, msgUid) {
  const res = await handleGuildDetail(params, session, msgUid);
  return {
    ...res,
    tag: 1530,
  };
}

async function handleGuildBattleInfo(params = {}, session = {}, msgUid = 0) {
  const player = session && session.player;
  if (!player) {
    return {
      tag: 1550,
      msgUid,
      data: {
        dataList: [],
      },
    };
  }

  const guildInfo = ensureGuildPlayerData(player);
  const guildId = Math.max(0, toSafeInt(guildInfo.guildId, toSafeInt(params.guildId || params.id, 0)));
  if (guildId <= 0) {
    return {
      tag: 1550,
      msgUid,
      data: {
        dataList: [],
      },
    };
  }

  const myGuild = await loadGuildDoc({ guildId });
  if (!myGuild) {
    return {
      tag: 1550,
      msgUid,
      data: {
        dataList: [],
      },
    };
  }

  const enemyGuild = await findEnemyGuildDoc(guildId);
  const battleInfo = await buildGuildBattleInfo(player, myGuild, enemyGuild);

  return {
    tag: 1550,
    msgUid,
    data: {
      result: 0,
      guildId,
      ...battleInfo,
      dataList: Array.isArray(battleInfo.dataList) ? battleInfo.dataList : [],
    },
  };
}

async function handleGuildBattleRecord(params = {}, session = {}, msgUid = 0) {
  return handleGuildBattleInfo(params, session, msgUid);
}

async function handleGuildBattleRank(params = {}, session = {}, msgUid) {
  const dataList = await buildGuildBattleRankRows(params.pageSize || params.count || 50);
  const player = session && session.player;
  const myGuildId = player ? Math.max(0, toSafeInt(ensureGuildPlayerData(player).guildId, 0)) : 0;
  const self = dataList.find((row) => toSafeInt(row && row.guildId, 0) === myGuildId) || null;

  return {
    tag: 1551,
    msgUid,
    data: {
      result: 0,
      list: dataList,
      dataList,
      myRank: self ? Math.max(1, toSafeInt(self.rank, 1)) : 0,
      myScore: self ? Math.max(0, toSafeInt(self.score, 0)) : 0,
    },
  };
}

module.exports = {
  buildGuildPlayerData,
  buildGuildInitPacket,
  buildGuildRecordInitPacket,
  buildGuildExchangeInitPacket,
  buildGuildExchangeUpdatePacket,
  createGuildExchangeRequest,
  buildGuildHuntingInitPacket,
  buildGuildBattleInitPacket,
  buildGuildBattleInfo,
  buildGuildDamageProgressPacket,
  recordGuildDamage,
  recordGuildHuntingChallenge,
  applyTempleBuffToGuild,
  createDefaultGuildPlayerData,
  ensureGuildPlayerData,
  handleGetGuildList,
  handleCreateGuild,
  handleJoinGuild,
  handleLeaveGuild,
  handleGuildApplyList,
  handleQuitGuild,
  handleGuildPlayerInfo,
  handleGuildApplyAction,
  handleGuildKickPlayer,
  handleGuildNeedLevel,
  handleGuildAutoAdd,
  handleGuildDetail,
  handleGuildDonate,
  handleGuildDonateDailyReward,
  handleGuildChangeNotice,
  handleGuildIdentityChange,
  handleGuildDonateUpdate,
  handleGuildActivationUpdate,
  handleGuildChangeIcon,
  handleGuildRename,
  handleGuildDonateV2,
  handleGuildDonateDailyRewardV2,
  handleGuildIdentityChangeV2,
  handleGuildChat,
  handleGuildAssistOther,
  handleGuildAssistAction,
  handleGuildBless,
  handleGuildBlessReward,
  handleGuildBlessUpdate,
  handleGuildBossInfo,
  handleGuildHuntingReceiveReward,
  handleGuildRank,
  handleGuildHuntingAssist,
  handleGuildExchange,
  handleGuildCancelExchange,
  handleGuildDetailV2,
  handleGuildBattleInfo,
  handleGuildBattleRecord,
  handleGuildBattleRank,
  _debug: {
    guildChatMap,
    guildExchangeMap,
    guildRecordMap,
    guildBattleLogMap,
  },
};
