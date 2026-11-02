/**
 * Arena and cross-arena handlers.
 * tag: 2600/2601/2602 arena
 * tag: 4500/4501 double tower basic flow
 * tag: 5000/5001/5002 cross arena basic flow
 */

const battle = require('../services/BattleService');
const playerService = require('../services/PlayerService');
const rank = require('../services/RankService');
const config = require('../services/ConfigService');
const logger = require('../logger');
const Account = require('../db/models/Account');
const Player = require('../db/models/Player');
const { addArenaChallengeCount } = require('../services/MainTaskProgressService');
const { addRewardToPlayer } = require('./raid');
const { buildPlayer500Data } = require('./playerPayload');
const runtimeBus = require('../services/RuntimeBus');
const {
  ensureRoleAppearance,
  getPlayerFashionMap,
  getPrimaryBattlePetId,
  applyPrimaryBattlePetParts,
} = require('../services/RoleAppearanceService');
const { ensureValhallaInfo } = require('./valhalla');

const ARENA_ROBOT_KUNGFU_IDS = [4, 5, 6, 8, 1];
const ARENA_PLAYER_SKILL_ID = 1002;
const ARENA_PLAYER_BEHAVIOR_ID = 10020;

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

const DOUBLE_TOWER_DAY_MS = 24 * 60 * 60 * 1000;
const TOP_COMBAT_FALLBACK_RANK = 9999;
const TOP_COMBAT_REFRESH_SEC = 30;
const TOP_ARENA_DEFAULT_RANK = 200;
const TOP_ARENA_MAX_RANK = 2000;
const TOP_ARENA_REFRESH_SEC = 30;

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensurePlainObject(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...fallback };
  }
  return value;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueInts(values = []) {
  const seen = new Set();
  const out = [];
  ensureArray(values).forEach((value) => {
    const id = Math.max(0, toSafeInt(value, 0));
    if (id <= 0 || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

function buildFightVars(hpValue = 0) {
  const hp = Math.max(0, toSafeInt(hpValue, 0));
  return {
    1: hp,
    2: 0,
    3: 0,
    '-1': hp,
  };
}

function normalizeArenaRoleSelection(kungfuId, subJob = 0) {
  const probe = { roleInfo: { kungfuId, subJob }, fashionInfo: {} };
  ensureRoleAppearance(probe);
  const roleInfo = ensurePlainObject(probe.roleInfo);
  let normalizedKungfuId = Math.max(1, toSafeInt(roleInfo.kungfuId, 4));
  let normalizedSubJob = Math.max(0, toSafeInt(roleInfo.subJob, 0));

  // GetInitShowDataByKungfu indexes RoleGenderConfig[kungfuId][subJob]
  // directly. A stale persisted row must not be allowed to reach that path.
  const roleGenderConfig = config.get('RoleGenderConfig') || {};
  const hasRoleRow = (id, job) => {
    const kungfu = roleGenderConfig[id] || roleGenderConfig[String(id)];
    if (!kungfu || typeof kungfu !== 'object' || Array.isArray(kungfu)) return false;
    const row = kungfu[job] || kungfu[String(job)];
    return !!row && typeof row === 'object' && !Array.isArray(row);
  };

  if (!hasRoleRow(normalizedKungfuId, normalizedSubJob)) {
    const fallback = Object.keys(roleGenderConfig)
      .map((id) => Math.max(0, toSafeInt(id, 0)))
      .filter((id) => id > 0)
      .sort((a, b) => a - b)
      .map((id) => {
        const kungfu = roleGenderConfig[id] || roleGenderConfig[String(id)];
        const jobs = kungfu && typeof kungfu === 'object' && !Array.isArray(kungfu)
          ? Object.keys(kungfu)
            .map((job) => Math.max(0, toSafeInt(job, -1)))
            .filter((job) => job >= 0)
            .sort((a, b) => a - b)
          : [];
        return jobs.length > 0 ? { kungfuId: id, subJob: jobs.includes(0) ? 0 : jobs[0] } : null;
      })
      .find(Boolean);
    if (fallback) {
      normalizedKungfuId = fallback.kungfuId;
      normalizedSubJob = fallback.subJob;
    }
  }

  return { kungfuId: normalizedKungfuId, subJob: normalizedSubJob };
}

function pickArenaRobotKungfuId(rank) {
  const idx = Math.max(0, toSafeInt(rank, 1) - 1) % ARENA_ROBOT_KUNGFU_IDS.length;
  return ARENA_ROBOT_KUNGFU_IDS[idx] || 4;
}

function getArenaConfigRow(map, id) {
  if (!map || id == null) return null;
  return map[id] || map[String(id)] || null;
}

function resolveArenaBattleActionIds(skillId, fallbackSkillId, fallbackBehaviorId) {
  const skillCfgMap = config.get('SkillConfig') || {};
  const behaviorCfgMap = config.get('SkillBehaviorConfig') || {};
  const safeFallbackSkillId = Math.max(1, toSafeInt(fallbackSkillId, ARENA_PLAYER_SKILL_ID));
  const safeFallbackBehaviorId = Math.max(1, toSafeInt(fallbackBehaviorId, ARENA_PLAYER_BEHAVIOR_ID));

  const preferredSkillCfg = getArenaConfigRow(skillCfgMap, skillId);
  const fallbackSkillCfg = getArenaConfigRow(skillCfgMap, safeFallbackSkillId);
  const skillCfg = preferredSkillCfg || fallbackSkillCfg;
  const resolvedSkillId = Math.max(
    1,
    toSafeInt(skillCfg && skillCfg.id, toSafeInt(skillId, safeFallbackSkillId) || safeFallbackSkillId),
  );

  const actionIds = Array.isArray(skillCfg && skillCfg.actions) ? skillCfg.actions : [];
  let behaviorId = actionIds
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .find((id) => id > 0) || 0;

  if (behaviorId <= 0 && getArenaConfigRow(behaviorCfgMap, resolvedSkillId)) {
    behaviorId = resolvedSkillId;
  }

  if (behaviorId <= 0) {
    behaviorId = safeFallbackBehaviorId;
  }

  return {
    skillId: resolvedSkillId,
    behaviorId,
  };
}

function buildArenaDamageAction(casterPos, targetPos, damage, targetHpAfterHit) {
  const safeDamage = Math.max(0, toSafeInt(damage, 0));
  if (safeDamage <= 0) return null;

  const action = {
    typ: 3,
    i: 0,
    c: casterPos,
    t: targetPos,
    as: [0],
    vs: { 1: -safeDamage },
  };

  if (Math.max(0, toSafeInt(targetHpAfterHit, 0)) <= 0) {
    action.es = [[{ typ: 6, i: 0, c: casterPos, t: targetPos }]];
  }

  return action;
}

function buildArenaSkillEvent(skillId, behaviorId, casterPos, targetPos, damage, targetHpAfterHit) {
  const damageAction = buildArenaDamageAction(casterPos, targetPos, damage, targetHpAfterHit);
  if (!damageAction) return null;

  return {
    typ: 1,
    i: Math.max(1, toSafeInt(skillId, ARENA_PLAYER_SKILL_ID)),
    c: casterPos,
    t: 0,
    as: [0],
    es: [[{
      typ: 2,
      i: Math.max(1, toSafeInt(behaviorId, ARENA_PLAYER_BEHAVIOR_ID)),
      c: casterPos,
      t: 0,
      es: [[damageAction]],
    }]],
  };
}

function buildArenaBattleEvents(playerHpMax, enemyHpMax, enemyShowInfo = {}, playerWins = true) {
  const roundCount = 4;
  const playerSkill = resolveArenaBattleActionIds(
    ARENA_PLAYER_SKILL_ID,
    ARENA_PLAYER_SKILL_ID,
    ARENA_PLAYER_BEHAVIOR_ID,
  );
  const enemyRoleSelection = normalizeArenaRoleSelection(enemyShowInfo.kungfuId, enemyShowInfo.subJob);
  const enemySkill = resolveArenaBattleActionIds(
    enemyRoleSelection.kungfuId,
    ARENA_PLAYER_SKILL_ID,
    ARENA_PLAYER_BEHAVIOR_ID,
  );
  const enemyHit = Math.max(1, Math.floor(playerHpMax * 0.12));
  const playerHit = Math.max(1, Math.floor(enemyHpMax / roundCount));
  let currentEnemyHp = enemyHpMax;
  let currentPlayerHp = playerHpMax;
  const events = [{ typ: 0, i: 0, c: 0, t: 0, es: [] }];

  for (let roundIndex = 1; roundIndex <= roundCount; roundIndex += 1) {
    const round = { typ: 0, i: roundIndex, c: 0, t: 0, es: [] };
    const isFinalRound = roundIndex === roundCount;
    const playerDamage = playerWins && isFinalRound
      ? currentEnemyHp
      : Math.max(0, Math.min(Math.max(0, currentEnemyHp - 1), playerHit));
    currentEnemyHp = Math.max(0, currentEnemyHp - playerDamage);
    const playerEvent = buildArenaSkillEvent(
      playerSkill.skillId,
      playerSkill.behaviorId,
      1,
      -1,
      playerDamage,
      currentEnemyHp,
    );
    if (playerEvent) round.es.push([playerEvent]);

    if (!playerWins || !isFinalRound) {
      const enemyDamage = !playerWins && isFinalRound
        ? currentPlayerHp
        : Math.max(0, Math.min(Math.max(0, currentPlayerHp - 1), enemyHit));
      currentPlayerHp = Math.max(0, currentPlayerHp - enemyDamage);
      const enemyEvent = buildArenaSkillEvent(
        enemySkill.skillId,
        enemySkill.behaviorId,
        -1,
        1,
        enemyDamage,
        currentPlayerHp,
      );
      if (enemyEvent) round.es.push([enemyEvent]);
    }

    if (round.es.length > 0) events.push(round);
  }

  return {
    events,
    currentPlayerHp,
    currentEnemyHp,
  };
}

function buildArenaPostFightChallengeList(challengeList = [], selectedChallenge = null, selectedIndex = -1) {
  const selectedDbid = String(selectedChallenge && selectedChallenge.dbid || '');
  const selectedPlayerId = String(selectedChallenge && selectedChallenge.playerId || '');

  return ensureArray(challengeList)
    .filter((row, index) => {
      if (row === selectedChallenge) return false;
      const rowDbid = String(row && row.dbid || '');
      const rowPlayerId = String(row && row.playerId || '');
      if (selectedDbid && rowDbid === selectedDbid) return false;
      if (selectedPlayerId && rowPlayerId === selectedPlayerId) return false;
      return selectedChallenge ? true : index !== selectedIndex;
    })
    .map((row, index) => {
      const source = ensurePlainObject(row);
      const roleSelection = normalizeArenaRoleSelection(source.kungfuId, source.subJob);
      const level = Math.max(1, toSafeInt(source.level || source.robotLv, 1));
      const power = Math.max(100, toSafeInt(source.power || source.powerScore, 100 + level * 100));
      return {
        ...source,
        score: Math.max(0, toSafeInt(source.score != null ? source.score : source.point, 0)),
        point: Math.max(0, toSafeInt(source.point != null ? source.point : source.score, 0)),
        nextChallengeTime: Math.max(0, toSafeInt(source.nextChallengeTime, 0)),
        dbid: String(source.dbid || source.playerId || (index + 1)),
        serverId: Math.max(1, toSafeInt(source.serverId, 1)),
        avatar: Math.max(0, toSafeInt(source.avatar, 11300)),
        avatarFrame: Math.max(-1, toSafeInt(source.avatarFrame, -1)),
        level,
        power,
        powerScore: power,
        kungfuId: roleSelection.kungfuId,
        subJob: roleSelection.subJob,
      };
    });
}

function getArenaRobotConfigMap(crossArena = false) {
  if (crossArena) {
    const crossRows = ensurePlainObject(config.get('CrossArenaRobotConfig'));
    if (Object.keys(crossRows).length > 0) return crossRows;
  }
  return ensurePlainObject(config.get('ArenaRobotConfig'));
}

function parseServerIdFromPrefixedId(value, prefix) {
  const text = String(value || '').trim();
  if (!text.startsWith(`${prefix}_`)) return 0;
  const parts = text.split('_');
  return Math.max(0, toSafeInt(parts[1], 0));
}

function resolveArenaServerId(session, player) {
  const candidates = [
    toSafeInt(session && session.serverId, 0),
    parseServerIdFromPrefixedId(session && session.roleId, 'r'),
    parseServerIdFromPrefixedId(player && player.roleId, 'r'),
    parseServerIdFromPrefixedId(session && session.userId, 'u'),
    parseServerIdFromPrefixedId(player && player.userId, 'u'),
    toSafeInt(process.env.DEFAULT_SERVER_ID, 1001),
  ];
  return candidates.find((value) => value > 0) || 1001;
}

function toArenaDbid(targetPlayer) {
  const objectId = targetPlayer && targetPlayer._id != null ? String(targetPlayer._id) : '';
  if (objectId.length === 24) return objectId;
  const raw = String(
    (targetPlayer && (targetPlayer.playerId || targetPlayer.userId || targetPlayer.name)) || 'arena_player'
  )
    .replace(/[^0-9a-z]/gi, '')
    .toLowerCase();
  const normalized = raw.length > 0 ? raw : 'arenaplayer';
  return normalized.padEnd(24, '0').slice(0, 24);
}

function clonePlayerSnapshot(player = {}) {
  if (!player || typeof player !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(player));
  } catch (_err) {
    return { ...player };
  }
}

function buildArenaChallengeRowFromPlayer(targetPlayer, serverId) {
  const show = clonePlayerSnapshot(targetPlayer);
  ensureRoleAppearance(show);
  const attrs = battle.calcPlayerPower(show);
  const roleInfo = ensurePlainObject(show.roleInfo);
  const roleSelection = normalizeArenaRoleSelection(show.kungfuId || roleInfo.kungfuId, roleInfo.subJob);
  const point = Math.max(0, toSafeInt(show.arenaScore, 1000));
  const power = Math.max(100, toSafeInt(battle.calcPowerScore(attrs), 100));
  return {
    dbid: toArenaDbid(show),
    playerId: show.playerId || '',
    serverId: Math.max(1, toSafeInt(serverId, 1)),
    serverName: '',
    name: show.name || '同服道友',
    level: Math.max(1, toSafeInt(show.level, 1)),
    avatar: Math.max(0, toSafeInt(show.avatar, 11300)),
    avatarUrl: show.avatarUrl || '',
    avatarFrame: Math.max(-1, toSafeInt(show.avatarFrame, -1)),
    title: Math.max(0, toSafeInt(show.title, 0)),
    kungfuId: roleSelection.kungfuId,
    subJob: roleSelection.subJob,
    petId: getPrimaryBattlePetId(show),
    robotLv: Math.max(1, toSafeInt(show.level, 1)),
    point,
    score: point,
    power,
    powerScore: power,
    nextChallengeTime: 0,
  };
}

async function notifyArenaTargetUpdate(selectedChallenge, player, serverId, pushTag = 2603) {
  const targetPlayerId = String(selectedChallenge && selectedChallenge.playerId || '').trim();
  const selfPlayerId = String(player && player.playerId || '').trim();
  if (!targetPlayerId || targetPlayerId === selfPlayerId || /^\d+$/.test(targetPlayerId)) return;

  try {
    const target = await Player.findOne({ playerId: targetPlayerId }).select({ userId: 1 }).lean();
    const wsServer = runtimeBus.getWsServer();
    if (!target || !target.userId || !wsServer || typeof wsServer.pushToUser !== 'function') return;
    const info = buildArenaChallengeRowFromPlayer(player, serverId);
    wsServer.pushToUser(String(target.userId), pushTag, { info });
  } catch (err) {
    logger.warn(`[Arena] failed to push player update: ${err.message}`);
  }
}

function buildArenaFightSelfShowInfo(player, serverId, power = 0) {
  const show = clonePlayerSnapshot(player);
  ensureRoleAppearance(show);
  const roleInfo = ensurePlainObject(show.roleInfo);
  const equipInfo = ensurePlainObject(show.equipInfo);
  const roleSelection = normalizeArenaRoleSelection(show.kungfuId || roleInfo.kungfuId, roleInfo.subJob);
  return {
    dbid: String(show.playerId || show.userId || 'arena_self'),
    serverId: Math.max(1, toSafeInt(serverId, 1)),
    serverName: '',
    kungfuId: roleSelection.kungfuId,
    subJob: roleSelection.subJob,
    level: Math.max(1, toSafeInt(show.level, 1)),
    name: String(show.name || 'Player'),
    power: Math.max(0, toSafeInt(power, 0)),
    stage: Math.max(1, toSafeInt(roleInfo.stage, toSafeInt(roleInfo.stageId, 1))),
    petId: getPrimaryBattlePetId(show),
    petSoulId: -1,
    artifactId: 0,
    fate: 0,
    foreverCard: 0,
    equipMap: ensurePlainObject(equipInfo.equipMap),
    fashionMap: getPlayerFashionMap(show),
    avatar: Math.max(0, toSafeInt(show.avatar, toSafeInt(roleInfo.avatar, 11300))),
    avatarUrl: show.avatarUrl ? String(show.avatarUrl) : '',
    avatarFrame: Math.max(-1, toSafeInt(show.avatarFrame, toSafeInt(roleInfo.avatarFrame, -1))),
    title: Math.max(-1, toSafeInt(show.title, toSafeInt(roleInfo.title, -1))),
  };
}

function buildArenaFightOpponentShowInfo(challenge = {}, fallbackLevel = 1) {
  const row = ensurePlainObject(challenge);
  const roleSelection = normalizeArenaRoleSelection(row.kungfuId, row.subJob);
  return {
    dbid: String(row.dbid || row.playerId || 'arena_enemy'),
    serverId: Math.max(1, toSafeInt(row.serverId, 1)),
    serverName: row.serverName || '',
    kungfuId: roleSelection.kungfuId,
    subJob: roleSelection.subJob,
    level: Math.max(1, toSafeInt(row.level, fallbackLevel)),
    name: String(row.name || '武道会对手'),
    power: Math.max(100, toSafeInt(row.power || row.powerScore, 100)),
    stage: Math.max(1, toSafeInt(row.stage, Math.floor(Math.max(1, toSafeInt(row.level, fallbackLevel)) / 10) + 1)),
    petId: Math.max(0, toSafeInt(row.petId, 0)),
    petSoulId: toSafeInt(row.petSoulId, -1),
    artifactId: Math.max(-1, toSafeInt(row.artifactId, -1)),
    fate: Math.max(0, toSafeInt(row.fate, 0)),
    foreverCard: Math.max(0, toSafeInt(row.foreverCard, 0)),
    equipMap: ensurePlainObject(row.equipMap),
    fashionMap: ensurePlainObject(row.fashionMap),
    avatar: Math.max(0, toSafeInt(row.avatar, 11300)),
    avatarUrl: row.avatarUrl ? String(row.avatarUrl) : '',
    avatarFrame: Math.max(-1, toSafeInt(row.avatarFrame, -1)),
    title: Math.max(-1, toSafeInt(row.title, -1)),
  };
}

async function loadSameServerArenaOpponents(session, player, limit = 5) {
  const maxCount = Math.max(0, toSafeInt(limit, 5));
  if (!player || maxCount <= 0) return [];

  const serverId = resolveArenaServerId(session, player);
  const selfUserId = String((session && session.userId) || (player && player.userId) || '').trim();
  const selfPlayerId = String((player && player.playerId) || '').trim();

  try {
    const accountRows = await Account.find(
      { 'roles.serverId': serverId },
      { roles: 1, _id: 0 }
    ).lean();

    const roleRows = [];
    ensureArray(accountRows).forEach((accountRow) => {
      ensureArray(accountRow && accountRow.roles).forEach((role) => {
        if (toSafeInt(role && role.serverId, 0) !== serverId) return;
        const userId = String((role && role.userId) || '').trim();
        if (!userId || userId === selfUserId) return;
        roleRows.push({
          userId,
          lastLoginTime: toSafeInt(role && role.lastLoginTime, 0),
          createTime: toSafeInt(role && role.createTime, 0),
        });
      });
    });

    if (roleRows.length <= 0) return [];

    roleRows.sort((a, b) => {
      if (b.lastLoginTime !== a.lastLoginTime) return b.lastLoginTime - a.lastLoginTime;
      return b.createTime - a.createTime;
    });

    const userIds = Array.from(new Set(roleRows.map((row) => row.userId))).slice(0, Math.max(maxCount * 4, 20));
    if (userIds.length <= 0) return [];

    const playerRows = await Player.find({ userId: { $in: userIds } }).lean();
    const playerMap = new Map(
      ensureArray(playerRows).map((row) => [String((row && row.userId) || '').trim(), row])
    );

    const selfScore = Math.max(0, toSafeInt(player && player.arenaScore, 1000));
    const selfLevel = Math.max(1, toSafeInt(player && player.level, 1));
    const challengers = [];

    userIds.forEach((userId) => {
      const targetPlayer = playerMap.get(userId);
      if (!targetPlayer) return;
      const targetPlayerId = String(targetPlayer.playerId || '').trim();
      if (!targetPlayerId || targetPlayerId === selfPlayerId) return;
      challengers.push(buildArenaChallengeRowFromPlayer(targetPlayer, serverId));
    });

    challengers.sort((a, b) => {
      const scoreDelta = Math.abs(toSafeInt(a.point, 0) - selfScore) - Math.abs(toSafeInt(b.point, 0) - selfScore);
      if (scoreDelta !== 0) return scoreDelta;
      const levelDelta = Math.abs(toSafeInt(a.level, 1) - selfLevel) - Math.abs(toSafeInt(b.level, 1) - selfLevel);
      if (levelDelta !== 0) return levelDelta;
      return toSafeInt(b.point, 0) - toSafeInt(a.point, 0);
    });

    return challengers.slice(0, maxCount);
  } catch (err) {
    logger.warn(`[Arena] failed to load same-server opponents: ${err.message}`);
    return [];
  }
}

async function buildArenaChallengeList(session, player, limit = 5) {
  const maxCount = Math.max(1, toSafeInt(limit, 5));
  const challengers = await loadSameServerArenaOpponents(session, player, maxCount);
  if (challengers.length >= maxCount) {
    return challengers.slice(0, maxCount);
  }

  const taken = new Set(
    challengers.map((row) => String((row && (row.dbid || row.playerId)) || '').trim()).filter(Boolean)
  );
  const robots = generateOpponents(player).filter((row) => {
    const id = String((row && (row.dbid || row.playerId)) || '').trim();
    return !id || !taken.has(id);
  });
  return [...challengers, ...robots].slice(0, maxCount);
}

async function buildCrossArenaChallengeList(session, player, limit = 5) {
  const maxCount = Math.max(1, toSafeInt(limit, 5));
  const challengers = await loadSameServerArenaOpponents(session, player, maxCount);
  if (challengers.length >= maxCount) return challengers.slice(0, maxCount);

  const taken = new Set(
    challengers.map((row) => String((row && (row.dbid || row.playerId)) || '').trim()).filter(Boolean)
  );
  const robots = generateOpponents(player, { crossArena: true }).filter((row) => {
    const id = String((row && (row.dbid || row.playerId)) || '').trim();
    return !id || !taken.has(id);
  });
  return [...challengers, ...robots].slice(0, maxCount);
}

function ensureDoubleTowerInfo(player) {
  const now = Date.now();
  if (!player || typeof player !== 'object') {
    return {
      outbounds: {},
      index: 0,
      winAdsNum: 0,
      dailyWinNum: 0,
      stage: 1,
      endTime: now + DOUBLE_TOWER_DAY_MS,
      point: 0,
      maxPoint: 0,
      rankRewardList: [],
      loglist: [],
      rank: 0,
      defence: 0,
      enemyId: '',
    };
  }

  player.doubleTowerInfo = ensurePlainObject(player.doubleTowerInfo);
  const info = player.doubleTowerInfo;
  info.outbounds = ensurePlainObject(info.outbounds);
  info.index = Math.max(1, toSafeInt(info.index, 1));
  info.winAdsNum = Math.max(0, toSafeInt(info.winAdsNum, 0));
  info.dailyWinNum = Math.max(0, toSafeInt(info.dailyWinNum, 0));
  info.stage = Math.max(1, toSafeInt(info.stage, 1));
  info.endTime = Math.max(now + 60 * 1000, toSafeInt(info.endTime, now + DOUBLE_TOWER_DAY_MS));
  info.point = toSafeInt(info.point, 0);
  info.maxPoint = Math.max(info.point, toSafeInt(info.maxPoint, info.point));
  info.rankRewardList = ensureArray(info.rankRewardList);
  info.loglist = ensureArray(info.loglist);
  info.rank = Math.max(0, toSafeInt(info.rank, 0));
  info.defence = Math.max(0, toSafeInt(info.defence, 0));
  info.enemyId = typeof info.enemyId === 'string' ? info.enemyId : '';
  info.outbounds = normalizeDoubleTowerOutbounds(player, info.outbounds, info.index);
  return info;
}

function ensureCrossArenaInfo(player) {
  if (!player || typeof player !== 'object') {
    return {
      score: 1000,
      dailyCount: 0,
      maxCount: 10,
      refreshtime: 0,
      loglist: [],
    };
  }

  player.crossArenaInfo = ensurePlainObject(player.crossArenaInfo);
  const info = player.crossArenaInfo;
  info.score = Math.max(0, toSafeInt(info.score, toSafeInt(player.arenaScore, 1000)));
  info.dailyCount = Math.max(0, toSafeInt(info.dailyCount, 0));
  info.maxCount = Math.max(1, toSafeInt(info.maxCount, 10));
  info.refreshtime = Math.max(0, toSafeInt(info.refreshtime, 0));
  info.loglist = ensureArray(info.loglist);
  return info;
}

function normalizeOutbound(outbound) {
  if (!Array.isArray(outbound)) return [];
  return outbound.map((row) => ({
    id: Math.max(0, toSafeInt(row && row.id, 0)),
    level: Math.max(0, toSafeInt(row && row.level, 0)),
  }));
}

function getDoubleTowerFallbackHeroIds() {
  const cfgMap = ensurePlainObject(config.get('DoubleTowerHeroConfig'));
  const ids = Object.keys(cfgMap)
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
  if (ids.length > 0) return ids;
  return [26111, 26112, 26113, 26121, 26122, 26123, 26131, 26132, 26133, 26211];
}

function buildDefaultDoubleTowerOutbound(player, minimumSize = 6) {
  const safePlayer = player && typeof player === 'object' ? player : {};
  const level = Math.max(1, toSafeInt(safePlayer.level, 1));
  const validHeroIds = new Set(getDoubleTowerFallbackHeroIds());
  const valhallaInfo = ensureValhallaInfo(safePlayer);
  const unlockedIds = ensureArray(valhallaInfo.unlockedIds)
    .concat(ensureArray(valhallaInfo.valhalla).map((hero) => toSafeInt(hero && hero.id, 0)));
  const pickedIds = uniqueInts([...unlockedIds, ...Array.from(validHeroIds)])
    .filter((id) => validHeroIds.has(id))
    .slice(0, Math.max(3, minimumSize));
  return pickedIds.map((id) => ({ id, level }));
}

function normalizeDoubleTowerTeam(outbound, defaultOutbound) {
  const fallback = Array.isArray(defaultOutbound) ? defaultOutbound : [];
  const levelFallback = Math.max(1, toSafeInt(fallback[0] && fallback[0].level, 1));
  const rows = [];
  const seen = new Set();

  normalizeOutbound(outbound).forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    if (id <= 0 || seen.has(id)) return;
    seen.add(id);
    rows.push({
      id,
      level: Math.max(1, toSafeInt(row && row.level, levelFallback)),
    });
  });

  fallback.forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    if (rows.length >= fallback.length || id <= 0 || seen.has(id)) return;
    seen.add(id);
    rows.push({
      id,
      level: Math.max(1, toSafeInt(row && row.level, levelFallback)),
    });
  });

  return rows;
}

function normalizeDoubleTowerOutbounds(player, rawOutbounds, currentIndex = 1) {
  const outbounds = ensurePlainObject(rawOutbounds);
  const defaultOutbound = buildDefaultDoubleTowerOutbound(player);
  const normalized = {};

  Object.keys(outbounds).forEach((key) => {
    const idx = Math.max(1, toSafeInt(key, 0));
    normalized[String(idx)] = normalizeDoubleTowerTeam(outbounds[key], defaultOutbound);
  });

  const activeIndex = Math.max(1, toSafeInt(currentIndex, 1));
  if (!Array.isArray(normalized['1']) || normalized['1'].length < 3) {
    normalized['1'] = normalizeDoubleTowerTeam(normalized['1'], defaultOutbound);
  }
  if (!Array.isArray(normalized[String(activeIndex)]) || normalized[String(activeIndex)].length < 3) {
    normalized[String(activeIndex)] = clonePlain(normalized['1']);
  }

  return normalized;
}

function buildDoubleTowerData(info) {
  return {
    outbounds: info.outbounds,
    index: info.index,
    winAdsNum: info.winAdsNum,
    dailyWinNum: info.dailyWinNum,
    stage: info.stage,
    endTime: info.endTime,
    point: info.point,
    maxPoint: info.maxPoint,
    rankRewardList: info.rankRewardList,
    loglist: info.loglist,
    rank: info.rank,
    defence: info.defence,
    enemyId: info.enemyId,
  };
}

function normalizeRewardRows(rows = []) {
  const map = new Map();
  ensureArray(rows).forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    map.set(id, (map.get(id) || 0) + count);
  });
  const items = [];
  map.forEach((count, id) => items.push({ id, count }));
  items.sort((a, b) => a.id - b.id);
  return items;
}

function buildRewardInfo(rows = []) {
  return {
    items: normalizeRewardRows(rows),
    equips: [],
    heros: [],
  };
}

function grantRewardInfo(player, rows = []) {
  const rewardInfo = buildRewardInfo(rows);
  rewardInfo.items.forEach((row) => addRewardToPlayer(player, row.id, row.count));
  return rewardInfo;
}

function appendDoubleTowerLog(info, row = {}) {
  info.loglist = ensureArray(info.loglist);
  info.loglist.push({
    logtime: Math.floor(Date.now() / 1000),
    type: toSafeInt(row.type, 0),
    result: toSafeInt(row.result, 0),
    uid: row.uid == null ? '' : String(row.uid),
    point: toSafeInt(row.point, 0),
    rank: toSafeInt(row.rank, 0),
  });
  if (info.loglist.length > 50) {
    info.loglist = info.loglist.slice(info.loglist.length - 50);
  }
  return info.loglist[info.loglist.length - 1];
}

function getDoubleTowerBattleScore(type = 0) {
  const scoreRows = ensureArray((config.get('DoubleTowerBaseConfig') || {}).firstBattleScore);
  const idx = Math.max(0, Math.min(scoreRows.length - 1, toSafeInt(type, 0)));
  if (scoreRows.length > 0) return toSafeInt(scoreRows[idx], 0);
  if (idx === 0) return 30;
  if (idx === 2) return -10;
  return 0;
}

function resolveDoubleTowerAIId() {
  const aiConfig = ensurePlainObject(config.get('DoubleTowerAIConfig'));
  const aiBaseConfig = ensurePlainObject(config.get('DoubleTowerAIBaseConfig'));
  const baseCfg = ensurePlainObject(config.get('DoubleTowerBaseConfig'));
  const preferred = Math.max(0, toSafeInt(baseCfg.firstBattleAI, 0));
  if (preferred > 0 && aiConfig[preferred] && aiBaseConfig[preferred]) return preferred;

  const ids = Object.keys(aiConfig)
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .filter((id) => id > 0 && aiConfig[id] && aiBaseConfig[id])
    .sort((a, b) => a - b);
  return ids[0] || 101;
}

function updateDoubleTowerPointRank(info, pointChange = 0) {
  info.point = Math.max(0, toSafeInt(info.point, 0) + toSafeInt(pointChange, 0));
  info.maxPoint = Math.max(toSafeInt(info.maxPoint, 0), info.point);
  info.rank = Math.max(1, 1000 - Math.floor(info.point / 10));
}

function buildDoubleTowerRankList(player, info) {
  const selfDbid = player && player.playerId ? player.playerId : 'self';
  const self = {
    dbid: selfDbid,
    name: player && player.name ? player.name : 'self',
    level: Math.max(1, toSafeInt(player && player.level, 1)),
    avatar: 11300,
    avatarFrame: -1,
    point: toSafeInt(info.point, 0),
  };

  const robots = generateOpponents(player).map((row, idx) => ({
    dbid: `double_robot_${idx + 1}`,
    name: row.name,
    level: row.level,
    avatar: row.avatar,
    avatarFrame: -1,
    point: Math.max(0, toSafeInt(row.point, 0) + 50),
  }));

  const rankList = [self, ...robots].sort((a, b) => b.point - a.point);
  rankList.forEach((row, idx) => {
    row.rank = idx + 1;
  });
  return rankList;
}

function buildDoubleTowerEnemyInfo(player, info, params = {}) {
  const index = Math.max(1, toSafeInt(params.index, 1));
  const uid = params.uid == null ? '' : String(params.uid);
  const robotCfgMap = ensurePlainObject(config.get('DoubleTowerRankRobotConfig'));
  const robotCfg = robotCfgMap[uid] || robotCfgMap[toSafeInt(uid, 0)] || null;
  const heroRows = ensureArray(robotCfg && robotCfg.hero);
  const fallbackHeroIds = getDoubleTowerFallbackHeroIds().slice(0, 10);
  const outbound = heroRows.map((id) => ({ id: Math.max(0, toSafeInt(id, 0)), level: Math.max(1, toSafeInt(player && player.level, 1)) }));

  return {
    dbid: uid || `double_enemy_${Date.now() % 100000}`,
    name: uid ? `守擂者-${uid}` : '守擂者',
    avatar: 11320 + (index % 5),
    avatarUrl: '',
    avatarFrame: 0,
    point: Math.max(0, toSafeInt(info.point, 0) + 50 + index * 5),
    outbound: outbound.length > 0
      ? outbound
      : (fallbackHeroIds.length > 0 ? fallbackHeroIds : [26111])
        .map((id) => ({ id, level: Math.max(1, toSafeInt(player && player.level, 1)) })),
    formationSkill: {},
    hp: Math.max(1000, toSafeInt((config.get('DoubleTowerBaseConfig') || {}).CarBasicHP, 100000)),
  };
}

function ensureTopCombatInfo(player) {
  const nowSec = Math.floor(Date.now() / 1000);
  const initialRank = getTopCombatInitialRank();
  if (!player || typeof player !== 'object') {
    return {
      rank: initialRank,
      maxRank: initialRank,
      records: [],
      loglist: [],
      matchStatus: 1,
      matchEndTime: nowSec + 24 * 3600,
      refreshtime: nowSec + TOP_COMBAT_REFRESH_SEC,
      challengeList: [],
      infoMap: {},
    };
  }

  player.topCombatInfo = ensurePlainObject(player.topCombatInfo);
  const info = player.topCombatInfo;
  if (toSafeInt(info.protocolVersion, 0) < 2) {
    info.rank = initialRank;
    info.maxRank = initialRank;
    info.challengeList = [];
    info.infoMap = {};
    info.refreshtime = 0;
    info.protocolVersion = 2;
  }
  info.rank = Math.max(1, Math.min(initialRank, toSafeInt(info.rank, initialRank)));

  const maxRank = toSafeInt(info.maxRank, info.rank);
  info.maxRank = Math.max(1, Math.min(info.rank, maxRank));

  const records = ensureArray(info.records)
    .map((row) => Math.max(0, toSafeInt(row, 0)))
    .filter((row) => row > 0);
  info.records = Array.from(new Set(records)).sort((a, b) => a - b);

  info.loglist = ensureArray(info.loglist).map((row) => ({
    atk: Math.max(0, toSafeInt(row && row.atk, 0)),
    logtime: Math.max(0, toSafeInt(row && row.logtime, 0)),
    rank: Math.max(1, toSafeInt(row && row.rank, info.rank)),
  }));
  if (info.loglist.length > 100) {
    info.loglist = info.loglist.slice(info.loglist.length - 100);
  }

  info.matchStatus = Math.max(0, toSafeInt(info.matchStatus, 1));
  info.matchEndTime = Math.max(nowSec + 300, toSafeInt(info.matchEndTime, nowSec + 24 * 3600));
  info.refreshtime = Math.max(0, toSafeInt(info.refreshtime, nowSec + TOP_COMBAT_REFRESH_SEC));
  info.challengeList = ensureArray(info.challengeList)
    .map((row) => Math.max(0, toSafeInt(row, 0)))
    .filter((row) => row > 0);
  info.infoMap = ensurePlainObject(info.infoMap);
  return info;
}

function buildTopCombatSelfShowInfo(player) {
  player = clonePlayerSnapshot(player);
  ensureRoleAppearance(player);
  const roleInfo = ensurePlainObject(player && player.roleInfo);
  const equipInfo = ensurePlainObject(player && player.equipInfo);
  return {
    dbid: toArenaDbid(player),
    serverId: 1,
    serverName: '',
    kungfuId: Math.max(1, toSafeInt((player && player.kungfuId) || roleInfo.kungfuId, 4)),
    subJob: Math.max(0, toSafeInt(roleInfo.subJob, 0)),
    level: Math.max(1, toSafeInt(player && player.level, 1)),
    name: (player && player.name) || 'self',
    power: Math.max(100, toSafeInt((player && player.power) || (player && player.powerScore), 1000)),
    stage: Math.max(1, toSafeInt(roleInfo.stageId, 1)),
    petId: getPrimaryBattlePetId(player),
    petSoulId: -1,
    artifactId: 0,
    fate: 0,
    foreverCard: 0,
    equipMap: ensurePlainObject(equipInfo.equipMap),
    fashionMap: getPlayerFashionMap(player),
    avatar: Math.max(0, toSafeInt(player && player.avatar, 11300)),
    avatarUrl: (player && player.avatarUrl) || '',
    avatarFrame: Math.max(-1, toSafeInt(player && player.avatarFrame, -1)),
    title: Math.max(0, toSafeInt(player && player.title, 0)),
  };
}

function getTopCombatInitialRank() {
  const base = ensurePlainObject(config.get('TopCombatConfig'));
  return Math.max(1, toSafeInt(base.initialRank, TOP_COMBAT_FALLBACK_RANK));
}

function getTopCombatRobotId(rank) {
  const rankSafe = Math.max(1, toSafeInt(rank, 1));
  const base = ensurePlainObject(config.get('TopCombatConfig'));
  const rules = ensurePlainObject(config.get('TopCombatRobotRuleConfig'));
  const matchedRule = Object.keys(rules)
    .map((key) => ensurePlainObject(rules[key]))
    .find((row) => rankSafe >= toSafeInt(row.rankMin, 1) && rankSafe <= toSafeInt(row.rankMax, 0));
  const robotIds = ensureArray(matchedRule && matchedRule.robotId)
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .filter((id) => id > 0);
  if (robotIds.length > 0) {
    const minRank = Math.max(1, toSafeInt(matchedRule.rankMin, 1));
    return robotIds[(rankSafe - minRank) % robotIds.length];
  }
  return Math.max(1, toSafeInt(base.initialRobotId, 1));
}

function getConfiguredRobotName(nameId, fallback) {
  const language = ensurePlainObject(config.get('LanguageConfig'));
  const row = ensurePlainObject(language[nameId] || language[String(nameId)]);
  return String(row.cn || row.tw || row.en || fallback);
}

function buildRobotFashionMap(robotShow = []) {
  const fashionCfg = ensurePlainObject(config.get('FashionConfig'));
  const fashionMap = {};
  ensureArray(robotShow).forEach((fashionIdRaw) => {
    const fashionId = Math.max(0, toSafeInt(fashionIdRaw, 0));
    const row = ensurePlainObject(fashionCfg[fashionId] || fashionCfg[String(fashionId)]);
    const type = Math.max(0, toSafeInt(row.type, 0));
    if (fashionId > 0 && type > 0) fashionMap[type] = fashionId;
  });
  return fashionMap;
}

function buildTopCombatRobotShowInfo(player, rank) {
  const playerLv = Math.max(1, toSafeInt(player && player.level, 1));
  const rankSafe = Math.max(1, toSafeInt(rank, 1));
  const initialRank = getTopCombatInitialRank();
  const robotId = getTopCombatRobotId(rankSafe);
  const robotCfgMap = ensurePlainObject(config.get('TopCombatRobotConfig'));
  const robotCfg = ensurePlainObject(robotCfgMap[robotId] || robotCfgMap[String(robotId)]);
  const levelDelta = Math.max(-5, Math.min(10, Math.floor((initialRank - rankSafe) / 1000)));
  const level = Math.max(1, toSafeInt(robotCfg.robotLv, playerLv + levelDelta));
  const robotAttrs = ensurePlainObject(robotCfg.robotAttrs);
  const power = Math.max(100, toSafeInt(
    Object.keys(robotAttrs).length > 0 ? battle.calcPowerScore(robotAttrs) : 0,
    1000 + level * 120 + Math.max(0, initialRank - rankSafe),
  ));
  const roleSelection = normalizeArenaRoleSelection(1, 0);
  const fashionMap = buildRobotFashionMap(robotCfg.robotShow);
  return {
    dbid: String(robotId),
    serverId: 1,
    serverName: '',
    kungfuId: roleSelection.kungfuId,
    subJob: roleSelection.subJob,
    level,
    name: getConfiguredRobotName(robotCfg.name, `天梯守擂者${rankSafe}`),
    power,
    stage: Math.max(1, Math.floor(level / 10) + 1),
    petId: 0,
    petSoulId: -1,
    artifactId: 0,
    fate: 0,
    foreverCard: 0,
    equipMap: {},
    fashionMap,
    avatar: Math.max(0, toSafeInt(fashionMap[102], 11300 + (robotId % 6))),
    avatarUrl: '',
    avatarFrame: -1,
    title: 0,
  };
}

function buildTopCombatRankList(rank) {
  const initialRank = getTopCombatInitialRank();
  const rankSafe = Math.max(1, toSafeInt(rank, initialRank));
  const list = [];
  for (let offset = -3; offset <= 3; offset++) {
    if (offset === 0) continue;
    const row = rankSafe + offset;
    if (row < 1 || row > initialRank) continue;
    list.push(row);
  }
  if (!list.includes(Math.max(1, rankSafe - 1))) {
    list.push(Math.max(1, rankSafe - 1));
  }
  return Array.from(new Set(list)).sort((a, b) => a - b);
}

function buildTopCombatChallengeInfo(player, info, forceRefresh = false) {
  const nowSec = Math.floor(Date.now() / 1000);
  const shouldRefresh =
    forceRefresh ||
    !Array.isArray(info.challengeList) ||
    info.challengeList.length === 0 ||
    !info.infoMap ||
    typeof info.infoMap !== 'object' ||
    nowSec >= toSafeInt(info.refreshtime, 0);

  if (shouldRefresh) {
    info.challengeList = buildTopCombatRankList(info.rank);
    info.refreshtime = nowSec + TOP_COMBAT_REFRESH_SEC;
    const map = {};
    const ranks = new Set([1, 2, 3, info.rank, ...info.challengeList]);
    ranks.forEach((rank) => {
      map[rank] =
        rank === info.rank ? buildTopCombatSelfShowInfo(player) : buildTopCombatRobotShowInfo(player, rank);
    });
    info.infoMap = map;
  }

  return {
    rank: info.rank,
    refreshtime: info.refreshtime,
    challengeList: ensureArray(info.challengeList),
    infoMap: ensurePlainObject(info.infoMap),
  };
}

function toTopCombatRankBaseInfo(showInfo = {}, isSelf = false) {
  const row = ensurePlainObject(showInfo);
  return {
    dbid: row.dbid == null ? '' : String(row.dbid),
    name: row.name || (isSelf ? 'self' : '守擂者'),
    level: Math.max(1, toSafeInt(row.level, 1)),
    avatar: Math.max(0, toSafeInt(row.avatar, 11300)),
    avatarUrl: row.avatarUrl || '',
    avatarFrame: Math.max(-1, toSafeInt(row.avatarFrame, -1)),
    title: Math.max(0, toSafeInt(row.title, 0)),
    kungfuId: Math.max(1, toSafeInt(row.kungfuId, 4)),
    power: Math.max(100, toSafeInt(row.power, 1000)),
  };
}

function buildTopCombatRankInfo(player, info) {
  const count = 20;
  const rankMap = {};
  const topMap = {};
  const selfShowInfo = buildTopCombatSelfShowInfo(player);

  for (let i = 1; i <= count; i++) {
    const showInfo = i === info.rank ? selfShowInfo : buildTopCombatRobotShowInfo(player, i);
    rankMap[i] = toTopCombatRankBaseInfo(showInfo, i === info.rank);
    if (i <= 3) {
      topMap[i] = showInfo;
    }
  }

  return {
    rank: info.rank,
    count,
    topMap,
    rankMap,
  };
}

function appendTopCombatLog(info, row = {}) {
  info.loglist = ensureArray(info.loglist);
  info.loglist.push({
    atk: Math.max(0, toSafeInt(row.atk, 0)),
    logtime: Math.max(0, toSafeInt(row.logtime, Math.floor(Date.now() / 1000))),
    rank: Math.max(1, toSafeInt(row.rank, info.rank)),
  });
  if (info.loglist.length > 100) {
    info.loglist = info.loglist.slice(info.loglist.length - 100);
  }
}

function ensureTopArenaInfo(player) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (!player || typeof player !== 'object') {
    return {
      rank: TOP_ARENA_DEFAULT_RANK,
      maxRank: TOP_ARENA_DEFAULT_RANK,
      loglist: [],
      matchStatus: 1,
      matchEndTime: nowSec + 24 * 3600,
      refreshtime: nowSec + TOP_ARENA_REFRESH_SEC,
      challengeList: [],
      infoMap: {},
      showInfo: { worship: 0, showMap: {} },
      lockTime: 0,
      passRecord: 0,
      guessLogs: [],
    };
  }

  player.topArenaInfo = ensurePlainObject(player.topArenaInfo);
  const info = player.topArenaInfo;
  info.rank = Math.max(1, toSafeInt(info.rank, TOP_ARENA_DEFAULT_RANK));
  info.maxRank = Math.max(1, Math.min(info.rank, toSafeInt(info.maxRank, info.rank)));
  info.loglist = ensureArray(info.loglist).map((row) => ({
    atk: Math.max(0, toSafeInt(row && row.atk, 0)),
    logtime: Math.max(0, toSafeInt(row && row.logtime, 0)),
    rank: Math.max(1, toSafeInt(row && row.rank, info.rank)),
  }));
  if (info.loglist.length > 100) {
    info.loglist = info.loglist.slice(info.loglist.length - 100);
  }
  info.matchStatus = Math.max(0, toSafeInt(info.matchStatus, 1));
  info.matchEndTime = Math.max(nowSec + 300, toSafeInt(info.matchEndTime, nowSec + 24 * 3600));
  info.refreshtime = Math.max(0, toSafeInt(info.refreshtime, nowSec + TOP_ARENA_REFRESH_SEC));
  info.challengeList = ensureArray(info.challengeList)
    .map((row) => Math.max(0, toSafeInt(row, 0)))
    .filter((row) => row > 0);
  info.infoMap = ensurePlainObject(info.infoMap);
  info.showInfo = ensurePlainObject(info.showInfo, { worship: 0, showMap: {} });
  info.showInfo.worship = Math.max(0, Math.min(1, toSafeInt(info.showInfo.worship, 0)));
  info.showInfo.showMap = ensurePlainObject(info.showInfo.showMap);
  info.lockTime = Math.max(0, toSafeInt(info.lockTime, 0));
  info.passRecord = Math.max(0, toSafeInt(info.passRecord, 0));
  info.guessLogs = ensureArray(info.guessLogs).map((row) => ({
    round: Math.max(0, toSafeInt(row && row.round, 0)),
    roomId: Math.max(0, toSafeInt(row && row.roomId, 0)),
    playerId: row && row.playerId != null ? String(row.playerId) : '',
    supportCount: Math.max(0, toSafeInt(row && row.supportCount, 0)),
    isWin: Math.max(0, toSafeInt(row && row.isWin, 0)),
    logtime: Math.max(0, toSafeInt(row && row.logtime, 0)),
  }));
  if (info.guessLogs.length > 100) {
    info.guessLogs = info.guessLogs.slice(info.guessLogs.length - 100);
  }
  return info;
}

function buildTopArenaSelfShowInfo(player) {
  return buildTopCombatSelfShowInfo(player);
}

function buildTopArenaRobotShowInfo(player, rank) {
  const playerLv = Math.max(1, toSafeInt(player && player.level, 1));
  const rankSafe = Math.max(1, toSafeInt(rank, 1));
  const levelDelta = Math.max(-5, Math.min(10, Math.floor((TOP_ARENA_DEFAULT_RANK - rankSafe) / 20)));
  const level = Math.max(1, playerLv + levelDelta);
  return {
    dbid: `ta_robot_${rankSafe}`,
    serverId: 1,
    serverName: '',
    kungfuId: pickArenaRobotKungfuId(rankSafe),
    subJob: 0,
    level,
    name: `巅峰擂主${rankSafe}`,
    power: 1200 + level * 130 + Math.max(0, TOP_ARENA_DEFAULT_RANK - rankSafe) * 5,
    stage: Math.max(1, Math.floor(level / 10) + 1),
    petId: 0,
    petSoulId: -1,
    artifactId: 0,
    fate: 0,
    foreverCard: 0,
    equipMap: {},
    fashionMap: {},
    avatar: 11300 + (rankSafe % 6),
    avatarUrl: '',
    avatarFrame: -1,
    title: 0,
  };
}

function buildTopArenaRankList(rank) {
  const rankSafe = Math.max(1, toSafeInt(rank, TOP_ARENA_DEFAULT_RANK));
  const list = [];
  for (let offset = -3; offset <= 3; offset++) {
    if (offset === 0) continue;
    const row = rankSafe + offset;
    if (row < 1 || row > TOP_ARENA_MAX_RANK) continue;
    list.push(row);
  }
  if (!list.includes(Math.max(1, rankSafe - 1))) {
    list.push(Math.max(1, rankSafe - 1));
  }
  return Array.from(new Set(list)).sort((a, b) => a - b);
}

function buildTopArenaChallengeInfo(player, info, forceRefresh = false) {
  const nowSec = Math.floor(Date.now() / 1000);
  const shouldRefresh =
    forceRefresh ||
    !Array.isArray(info.challengeList) ||
    info.challengeList.length === 0 ||
    !info.infoMap ||
    typeof info.infoMap !== 'object' ||
    nowSec >= toSafeInt(info.refreshtime, 0);

  if (shouldRefresh) {
    info.challengeList = buildTopArenaRankList(info.rank);
    info.refreshtime = nowSec + TOP_ARENA_REFRESH_SEC;
    const map = {};
    const ranks = new Set([1, 2, 3, info.rank, ...info.challengeList]);
    ranks.forEach((rank) => {
      map[rank] =
        rank === info.rank ? buildTopArenaSelfShowInfo(player) : buildTopArenaRobotShowInfo(player, rank);
    });
    info.infoMap = map;
  }

  return {
    rank: info.rank,
    refreshtime: info.refreshtime,
    challengeList: ensureArray(info.challengeList),
    infoMap: ensurePlainObject(info.infoMap),
  };
}

function appendTopArenaLog(info, row = {}) {
  info.loglist = ensureArray(info.loglist);
  info.loglist.push({
    atk: Math.max(0, toSafeInt(row.atk, 0)),
    logtime: Math.max(0, toSafeInt(row.logtime, Math.floor(Date.now() / 1000))),
    rank: Math.max(1, toSafeInt(row.rank, info.rank)),
  });
  if (info.loglist.length > 100) {
    info.loglist = info.loglist.slice(info.loglist.length - 100);
  }
}

function buildTopArenaRankPayload(player, info, type = 1) {
  const rankType = Math.max(1, toSafeInt(type, 1));
  const selfRank = Math.max(1, toSafeInt(info.rank, TOP_ARENA_DEFAULT_RANK));
  const selfValue = Math.max(1, TOP_ARENA_MAX_RANK - selfRank + 1);
  const rankList = [];

  for (let i = 1; i <= 20; i++) {
    const show = i === selfRank ? buildTopArenaSelfShowInfo(player) : buildTopArenaRobotShowInfo(player, i);
    rankList.push({
      dbid: show.dbid == null ? '' : String(show.dbid),
      serverId: Math.max(1, toSafeInt(show.serverId, 1)),
      name: show.name || '',
      level: Math.max(1, toSafeInt(show.level, 1)),
      avatar: Math.max(0, toSafeInt(show.avatar, 11300)),
      avatarUrl: show.avatarUrl || '',
      avatarFrame: Math.max(-1, toSafeInt(show.avatarFrame, -1)),
      title: Math.max(0, toSafeInt(show.title, 0)),
      kungfuId: Math.max(1, toSafeInt(show.kungfuId, 4)),
      power: Math.max(100, toSafeInt(show.power, 1000)),
      value: Math.max(1, TOP_ARENA_MAX_RANK - i + 1),
    });
  }

  return {
    type: rankType,
    rank: selfRank,
    value: selfValue,
    rankList,
  };
}

function buildTopArenaShowInfo(player, info) {
  const selfRank = Math.max(1, toSafeInt(info.rank, TOP_ARENA_DEFAULT_RANK));
  const expected = {
    1: selfRank === 1 ? buildTopArenaSelfShowInfo(player) : buildTopArenaRobotShowInfo(player, 1),
    2: selfRank === 2 ? buildTopArenaSelfShowInfo(player) : buildTopArenaRobotShowInfo(player, 2),
    3: selfRank === 3 ? buildTopArenaSelfShowInfo(player) : buildTopArenaRobotShowInfo(player, 3),
  };

  // showMap is persisted, but the client indexes every row through
  // RoleGenderConfig[kungfuId][subJob]. Rebuild missing or malformed rows so
  // an old record cannot crash the top-arena panel on login/open.
  const current = ensurePlainObject(info.showInfo.showMap);
  [1, 2, 3].forEach((position) => {
    const row = ensurePlainObject(current[position] || current[String(position)]);
    const role = normalizeArenaRoleSelection(row.kungfuId, row.subJob);
    const hasIdentity = String(row.dbid || '').trim().length > 0;
    const hasShowFields = Object.prototype.hasOwnProperty.call(row, 'fashionMap')
      && Object.prototype.hasOwnProperty.call(row, 'equipMap');
    const configured = role.kungfuId > 0 && role.subJob >= 0;
    const isSelfRow = String(row.dbid || '') === String(player && player.playerId || '');
    const identityMatchesRank = selfRank === position ? isSelfRow : !isSelfRow;
    if (!hasIdentity || !hasShowFields || !configured || !identityMatchesRank) {
      current[position] = expected[position];
      return;
    }
    current[position] = {
      ...expected[position],
      ...row,
      kungfuId: role.kungfuId,
      subJob: role.subJob,
      equipMap: ensurePlainObject(row.equipMap),
      fashionMap: ensurePlainObject(row.fashionMap),
    };
  });
  info.showInfo.showMap = current;

  return {
    worship: info.showInfo.worship,
    showMap: ensurePlainObject(info.showInfo.showMap),
  };
}

function normalizeTopArenaRoomPlayer(playerRow = {}, index = 0) {
  const row = ensurePlainObject(playerRow);
  const role = normalizeArenaRoleSelection(row.kungfuId, row.subJob);
  return {
    dbid: row.dbid == null ? '' : String(row.dbid),
    serverId: Math.max(1, toSafeInt(row.serverId, 1)),
    name: row.name || `房间选手${index + 1}`,
    level: Math.max(1, toSafeInt(row.level, 1)),
    avatar: Math.max(0, toSafeInt(row.avatar, 11300)),
    avatarUrl: row.avatarUrl || '',
    avatarFrame: Math.max(-1, toSafeInt(row.avatarFrame, -1)),
    title: Math.max(0, toSafeInt(row.title, 0)),
    kungfuId: role.kungfuId,
    subJob: role.subJob,
    power: Math.max(100, toSafeInt(row.power, 1000)),
  };
}

function buildTopArenaRoomPlayerMap(player, info, roomId = 1) {
  const map = {};
  const selfIndex = Math.max(0, Math.min(7, toSafeInt(info.rank, TOP_ARENA_DEFAULT_RANK) % 8));
  const selfShow = buildTopArenaSelfShowInfo(player);
  for (let i = 0; i < 8; i++) {
    if (i === selfIndex) {
      map[i] = normalizeTopArenaRoomPlayer(selfShow, i);
      continue;
    }
    const robotRank = Math.max(1, i + 1 + (roomId - 1) * 8);
    map[i] = normalizeTopArenaRoomPlayer(buildTopArenaRobotShowInfo(player, robotRank), i);
  }
  return map;
}

function ensureTopArenaMatchInfo(player, info) {
  info.matchInfo = ensurePlainObject(info.matchInfo);
  const matchInfo = info.matchInfo;
  matchInfo.round = Math.max(1, toSafeInt(matchInfo.round, 1));
  matchInfo.roomInfo = ensurePlainObject(matchInfo.roomInfo);
  const roomInfo = matchInfo.roomInfo;
  roomInfo.roomId = Math.max(1, toSafeInt(roomInfo.roomId, 1));
  roomInfo.step = Math.max(1, toSafeInt(roomInfo.step, 1));
  roomInfo.playerMap = ensurePlainObject(roomInfo.playerMap);
  roomInfo.winCount = ensurePlainObject(roomInfo.winCount);

  if (Object.keys(roomInfo.playerMap).length === 0) {
    roomInfo.playerMap = buildTopArenaRoomPlayerMap(player, info, roomInfo.roomId);
  } else {
    Object.keys(roomInfo.playerMap).forEach((key) => {
      const idx = Math.max(0, toSafeInt(key, 0));
      roomInfo.playerMap[key] = normalizeTopArenaRoomPlayer(roomInfo.playerMap[key], idx);
    });
  }

  Object.keys(roomInfo.playerMap).forEach((key) => {
    const row = roomInfo.playerMap[key];
    const dbid = row.dbid == null ? '' : String(row.dbid);
    if (!Object.prototype.hasOwnProperty.call(roomInfo.winCount, dbid)) {
      roomInfo.winCount[dbid] = 0;
    } else {
      roomInfo.winCount[dbid] = Math.max(0, toSafeInt(roomInfo.winCount[dbid], 0));
    }
  });

  return matchInfo;
}

function ensureTopArenaGuessMap(info) {
  info.roomGuessMap = ensurePlainObject(info.roomGuessMap);
  return info.roomGuessMap;
}

function buildTopArenaGuessInfo(roomInfo, row = {}) {
  const room = ensurePlainObject(roomInfo);
  const data = ensurePlainObject(row, { roomGuess: {}, playerGuess: {} });
  data.roomGuess = ensurePlainObject(data.roomGuess);
  data.playerGuess = ensurePlainObject(data.playerGuess);
  if (Object.keys(data.roomGuess).length === 0) {
    Object.keys(ensurePlainObject(room.playerMap)).forEach((slot) => {
      const playerRow = room.playerMap[slot];
      const dbid = playerRow && playerRow.dbid != null ? String(playerRow.dbid) : '';
      if (!dbid) return;
      data.roomGuess[dbid] = Math.max(0, toSafeInt(data.roomGuess[dbid], 0));
    });
  }
  return data;
}

function getTopArenaRoomGuessStore(info, round, roomId, roomInfo) {
  const guessMap = ensureTopArenaGuessMap(info);
  const key = `${Math.max(1, toSafeInt(round, 1))}_${Math.max(1, toSafeInt(roomId, 1))}`;
  guessMap[key] = buildTopArenaGuessInfo(roomInfo, guessMap[key]);
  return guessMap[key];
}

function buildCrossArenaRankRows(player, score, challengelist) {
  const selfDbid = player && player.playerId ? player.playerId : 'self';
  const selfAttrs = battle.calcPlayerPower(player || {});
  const selfPower = Math.max(100, toSafeInt(battle.calcPowerScore(selfAttrs), Math.max(100, score * 10)));
  const self = {
    dbid: selfDbid,
    playerId: selfDbid,
    name: player && player.name ? player.name : 'self',
    level: Math.max(1, toSafeInt(player && player.level, 1)),
    avatar: 11300,
    point: score,
    score,
    power: selfPower,
    powerScore: selfPower,
  };

  const rows = [self];
  for (const row of challengelist) {
    rows.push({
      dbid: row.dbid,
      playerId: row.playerId || row.dbid,
      name: row.name,
      level: row.level,
      avatar: row.avatar,
      point: row.point,
      score: row.point,
      power: Math.max(100, toSafeInt(row.power || row.powerScore, 100)),
      powerScore: Math.max(100, toSafeInt(row.powerScore || row.power, 100)),
    });
  }

  rows.sort((a, b) => b.point - a.point);
  return rows.map((row, idx) => ({ ...row, rank: idx + 1 }));
}

// Arena info (tag:2600)
async function handleArenaInfo(_params, session, msgUid) {
  const player = session.player;
  const score = player ? player.arenaScore || 1000 : 1000;
  const playerId = player ? player.playerId : '';
  const myRank = playerId ? await rank.getRank('arena', playerId) : 999;
  const challengelist = await buildArenaChallengeList(session, player);
  const rankRows = buildCrossArenaRankRows(player, score, challengelist);

  return {
    tag: 2600,
    msgUid,
    data: {
      score,
      rank: myRank > 0 ? myRank : 999,
      dailyCount: player ? player.arenaDailyCount || 0 : 0,
      maxCount: 10,
      challengelist,
      refreshtime: 0,
      loglist: [],
      ranklist: rankRows,
      toplist: rankRows.slice(0, 3),
    },
  };
}

// Arena refresh (tag:2601)
async function handleArenaRefresh(_params, session, msgUid) {
  return {
    tag: 2601,
    msgUid,
    data: { result: 0, challengelist: await buildArenaChallengeList(session, session.player) },
  };
}

async function performArenaFight(params, session, msgUid, options = {}) {
  const player = session.player;
  const arenaServerId = resolveArenaServerId(session, player);
  const responseTag = Math.max(0, toSafeInt(options.responseTag, 2602)) || 2602;
  const crossArena = !!options.crossArena;
  const fightType = Math.max(1, toSafeInt(params && params.type, crossArena ? 16 : 2));
  if (!player) return { tag: responseTag, msgUid, data: { result: -1 } };

  const crossInfo = crossArena ? ensureCrossArenaInfo(player) : null;
  if (crossInfo) crossInfo.dailyCount += 1;
  else player.arenaDailyCount = (player.arenaDailyCount || 0) + 1;
  const taskChanged = options.syncTask ? !!addArenaChallengeCount(player, 1) : false;
  const playerAttrs = battle.calcPlayerPower(player);
  const targetIdx = Math.max(0, toSafeInt(params && (params.index ?? params.targetIndex), 0));
  const difficulty = targetIdx - 2;
  const challengelist = crossArena
    ? await buildCrossArenaChallengeList(session, player)
    : await buildArenaChallengeList(session, player);
  const requestedEnemyId = String((params && params.enemyid) || '').trim();
  const selectedChallenge = challengelist.find((row) => (
    requestedEnemyId
    && (String(row && row.dbid || '') === requestedEnemyId
      || String(row && row.playerId || '') === requestedEnemyId)
  )) || challengelist[Math.max(0, targetIdx)] || challengelist[0] || null;
  const configuredOpponentAttrs = ensurePlainObject(selectedChallenge && selectedChallenge.robotAttrs);
  const opAttrs = Object.keys(configuredOpponentAttrs).length > 0
    ? configuredOpponentAttrs
    : battle.generateOpponentAttrs(player.level, difficulty);
  const result = battle.simulateBattle(playerAttrs, opAttrs, { isPvp: true });
  // Keep numeric robot ids intact. The H5 settlement view parses them with
  // Number.parseInt before calling CreateRobotShowInfo; `arena_enemy_*` becomes NaN.
  const selectedEnemyId = selectedChallenge && (selectedChallenge.dbid || selectedChallenge.playerId);
  const enemyid = String(selectedEnemyId || (params && params.enemyid) || `arena_enemy_${Math.max(0, targetIdx)}`);
  const enemyScore = Math.max(0, toSafeInt(params && params.enemyscore, selectedChallenge && (selectedChallenge.score ?? selectedChallenge.point), 1000 + Math.max(1, toSafeInt(player.level, 1)) * 10));

  let currentScore = crossInfo
    ? Math.max(0, toSafeInt(crossInfo.score, 1000))
    : Math.max(0, toSafeInt(player.arenaScore, 1000));
  const rewards = [];
  let scoreChange = 0;
  if (result.win) {
    scoreChange = 10 + Math.max(0, difficulty) * 5;
    currentScore += scoreChange;
    rewards.push({ id: 2, count: 100 + player.level * 10 });
    rewards.push({ id: 7, count: 2 });
    rewards.forEach((r) => addRewardToPlayer(player, r.id, r.count));
  } else {
    scoreChange = -(5 + Math.max(0, -difficulty) * 3);
    currentScore = Math.max(0, currentScore + scoreChange);
  }
  if (crossInfo) crossInfo.score = currentScore;
  else player.arenaScore = currentScore;

  const enemyDbid = enemyid;
  const playerHpMax = Math.max(1, toSafeInt(playerAttrs && playerAttrs[1], 100));
  const enemyHpMax = Math.max(1, toSafeInt(opAttrs && opAttrs[1], 100));
  const arenaFightShowInfo = buildArenaFightSelfShowInfo(player, arenaServerId, battle.calcPowerScore(playerAttrs || {}));
  const arenaOpponentShowInfo = buildArenaFightOpponentShowInfo({
    ...selectedChallenge,
    dbid: enemyDbid,
  }, player.level);
  const arenaBattleFlow = buildArenaBattleEvents(
    playerHpMax,
    enemyHpMax,
    arenaOpponentShowInfo,
    !!(result && result.win),
  );
  const selfEntity = applyPrimaryBattlePetParts({
    id: Math.max(1, toSafeInt(arenaFightShowInfo.kungfuId, 4)),
    dbid: String(player.playerId || player.userId || 'arena_self'),
    name: String(player.name || 'Player'),
    type: 1,
    side: 1,
    camp: 1,
    pos: 1,
    posIndex: 1,
    hp: playerHpMax,
    maxhp: playerHpMax,
    maxHp: playerHpMax,
    vars: buildFightVars(playerHpMax),
    showInfo: arenaFightShowInfo,
    parts: {},
    partValues: {},
  }, player);

  const fightResult = {
    type: fightType,
    win: result && result.win ? 1 : 0,
    mustChangeTurn: 0,
    notChangeTurn: 1,
    atkAttr: playerAttrs || {},
    defAttr: opAttrs || {},
    damage: { 1: Math.max(0, toSafeInt(result && result.monsterDamage, 0)), '-1': Math.max(0, toSafeInt(result && result.playerDamage, 0)) },
    isBackFight: false,
    events: responseTag === 2300 ? arenaBattleFlow.events : (Array.isArray(result && result.rounds) ? result.rounds : []),
    entitys: [
      selfEntity,
      {
        id: Math.max(1, toSafeInt(arenaOpponentShowInfo.kungfuId, 4)),
        dbid: enemyDbid,
        name: String((selectedChallenge && selectedChallenge.name) || '武道会对手'),
        type: 1,
        side: 2,
        camp: 2,
        pos: -1,
        posIndex: -1,
        hp: enemyHpMax,
        maxhp: enemyHpMax,
        maxHp: enemyHpMax,
        vars: buildFightVars(enemyHpMax),
        showInfo: arenaOpponentShowInfo,
        parts: {},
        partValues: {},
      },
    ],
    guildBossAllDamage: 0,
    bloodlineOffset: 0,
  };

  await playerService.savePlayer(session.userId, player);
  const rankType = crossArena ? 'crossArena' : 'arena';
  await rank.updateScore(rankType, player.playerId, currentScore);
  await notifyArenaTargetUpdate(selectedChallenge, player, arenaServerId, crossArena ? 5003 : 2603);
  const myRank = player.playerId ? await rank.getRank(rankType, player.playerId) : 999;
  const response = {
    tag: responseTag,
    msgUid,
    data: {
      result: 0,
      enemyid,
      enemyscore: enemyScore,
      score: currentScore,
      scorechange: scoreChange,
      rank: myRank > 0 ? myRank : 999,
      topList: responseTag === 2300
        ? challengelist.slice(0, 3).map((row) => buildArenaFightOpponentShowInfo(row, player.level))
        : challengelist.slice(0, 3),
      rankList: challengelist,
      challengelist: responseTag === 2300
        ? buildArenaPostFightChallengeList(challengelist, selectedChallenge, targetIdx)
        : challengelist,
      rewards,
      rewardInfo: buildRewardInfo(rewards),
      fightResult,
      win: result.win,
      star: result.star,
      rounds: result.totalRounds,
      battleLog: result.rounds,
      playerAttrs,
      opponentAttrs: opAttrs,
      powerScore: result.powerScore,
    },
  };

  if (options.asPackets) {
    const packets = [];
    if (rewards.length > 0) packets.push({ tag: 1202, msgUid: 0, data: { items: rewards } });
    if (taskChanged) packets.push(...buildTaskUpdatePacketsSafe(player));
    packets.push(response);
    return packets;
  }
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

// Latest H5 top-arena battle entry (tag:2350).
async function handleTopArenaStartFight(params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return {
      tag: 2350,
      msgUid,
      data: {
        result: 1,
        challengeInfo: { rank: TOP_ARENA_DEFAULT_RANK, refreshtime: 0, challengeList: [], infoMap: {} },
      },
    };
  }

  const info = ensureTopArenaInfo(player);
  const beforeRank = info.rank;
  const beforeChallengeInfo = buildTopArenaChallengeInfo(player, info, false);
  const targetIndex = Math.max(0, toSafeInt(params && params.index, 0));
  const requestedEnemyId = params && params.enemyid != null ? String(params.enemyid) : '';
  const parsedEnemyRank = /^\d+$/.test(requestedEnemyId) ? Math.max(1, toSafeInt(requestedEnemyId, 0)) : 0;
  const targetRank = Math.max(
    1,
    parsedEnemyRank
      || toSafeInt(beforeChallengeInfo.challengeList[targetIndex], 0)
      || Math.max(1, beforeRank - 1),
  );
  const enemyid = requestedEnemyId || String(targetRank);
  const enemyShow = {
    ...buildTopArenaRobotShowInfo(player, targetRank),
    dbid: enemyid,
  };

  const playerAttrs = battle.calcPlayerPower(player);
  const enemyAttrs = battle.generateOpponentAttrs(
    Math.max(1, toSafeInt(enemyShow.level, player.level)),
    Math.max(-5, Math.min(10, beforeRank - targetRank)),
  );
  const fight = battle.simulateBattle(playerAttrs, enemyAttrs, { isPvp: true });
  const win = fight && fight.win ? 1 : 0;
  const rankChange = win && targetRank < beforeRank ? beforeRank - targetRank : 0;

  if (rankChange > 0) {
    info.rank = targetRank;
    info.maxRank = Math.min(info.maxRank, info.rank);
  }
  appendTopArenaLog(info, { atk: 1, rank: targetRank, logtime: Math.floor(Date.now() / 1000) });

  const rewards = [];
  if (win) {
    rewards.push({ id: 2, count: 200 + Math.max(1, toSafeInt(player.level, 1)) * 20 });
    rewards.forEach((row) => addRewardToPlayer(player, row.id, row.count));
  }

  const arenaServerId = resolveArenaServerId(session, player);
  const selfShow = buildArenaFightSelfShowInfo(player, arenaServerId, battle.calcPowerScore(playerAttrs || {}));
  const opponentShow = buildArenaFightOpponentShowInfo(enemyShow, player.level);
  const playerHpMax = Math.max(1, toSafeInt(playerAttrs && playerAttrs[1], 100));
  const enemyHpMax = Math.max(1, toSafeInt(enemyAttrs && enemyAttrs[1], 100));
  const flow = buildArenaBattleEvents(playerHpMax, enemyHpMax, opponentShow, !!win);
  const selfEntity = applyPrimaryBattlePetParts({
    id: Math.max(1, toSafeInt(selfShow.kungfuId, 4)),
    dbid: String(player.playerId || player.userId || 'top_arena_self'),
    name: String(player.name || 'Player'),
    type: 1,
    side: 1,
    camp: 1,
    pos: 1,
    posIndex: 1,
    hp: playerHpMax,
    maxhp: playerHpMax,
    maxHp: playerHpMax,
    vars: buildFightVars(playerHpMax),
    showInfo: selfShow,
    parts: {},
    partValues: {},
  }, player);
  const fightResult = {
    type: 2,
    win,
    mustChangeTurn: 0,
    notChangeTurn: 1,
    atkAttr: playerAttrs || {},
    defAttr: enemyAttrs || {},
    damage: {
      1: Math.max(0, toSafeInt(fight && fight.monsterDamage, 0)),
      '-1': Math.max(0, toSafeInt(fight && fight.playerDamage, 0)),
    },
    isBackFight: false,
    events: flow.events,
    entitys: [
      selfEntity,
      {
        id: Math.max(1, toSafeInt(opponentShow.kungfuId, 4)),
        dbid: enemyid,
        name: String(opponentShow.name || '巅峰竞技场对手'),
        type: 1,
        side: 2,
        camp: 2,
        pos: -1,
        posIndex: -1,
        hp: enemyHpMax,
        maxhp: enemyHpMax,
        maxHp: enemyHpMax,
        vars: buildFightVars(enemyHpMax),
        showInfo: opponentShow,
        parts: {},
        partValues: {},
      },
    ],
    guildBossAllDamage: 0,
    bloodlineOffset: 0,
  };

  const challengeInfo = buildTopArenaChallengeInfo(player, info, true);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 2350,
    msgUid,
    data: {
      result: 0,
      enemyid,
      fightResult,
      challengeInfo,
      rank: info.rank,
      rankChange,
      rewards,
    },
  };
}

// Arena fight (tag:2602)
async function handleArenaFight(params, session, msgUid) {
  const hasFightParams = !!(params && (params.index != null || params.targetIndex != null || params.enemyid != null));
  if (!hasFightParams) {
    return {
      tag: 2602,
      msgUid,
      data: { challengelist: await buildArenaChallengeList(session, session.player) },
    };
  }
  return performArenaFight(params, session, msgUid, { responseTag: 2602, syncTask: true, asPackets: false });
}

// Double tower outbound setup (tag:4500)
async function handleDoubleTowerOutbound(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4500, msgUid, data: { result: -1 } };

  const info = ensureDoubleTowerInfo(player);
  const index = Math.max(1, toSafeInt(params && params.index, 1));
  const outbound = normalizeDoubleTowerTeam(params && params.outbound, buildDefaultDoubleTowerOutbound(player));

  info.index = index;
  info.outbounds[String(index)] = outbound;
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 4500,
    msgUid,
    data: {
      result: 0,
      index,
      outbound,
      ...buildDoubleTowerData(info),
    },
  };
}

// Double tower start battle (tag:4501)
async function handleDoubleTowerBattle(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4501, msgUid, data: { result: -1 } };

  const info = ensureDoubleTowerInfo(player);
  const index = Math.max(1, toSafeInt(params && params.index, info.index || 1));
  const aiId = resolveDoubleTowerAIId();
  const logInfo = {
    logtime: Math.floor(Date.now() / 1000),
    type: 0,
    result: 0,
    uid: `double_tower_${aiId}`,
    index,
  };

  info.loglist.push(logInfo);
  if (info.loglist.length > 30) {
    info.loglist = info.loglist.slice(info.loglist.length - 30);
  }
  info.enemyId = String(aiId);
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 4501,
    msgUid,
    data: {
      result: 0,
      id: aiId,
      logInfo,
      ...buildDoubleTowerData(info),
    },
  };
}

// Double tower battle finish (tag:4502)
async function handleDoubleTowerBattleFinish(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4502, msgUid, data: { result: -1 } };

  const info = ensureDoubleTowerInfo(player);
  const battleType = Math.max(0, toSafeInt(params && params.type, 0));
  const isWin = battleType === 0;
  const scoreChange = getDoubleTowerBattleScore(battleType);
  updateDoubleTowerPointRank(info, scoreChange);

  const baseCfg = config.get('DoubleTowerBaseConfig') || {};
  const dailyWinMax = Math.max(1, toSafeInt(baseCfg.dailyWinCountMax, 5));
  let rewardInfo = buildRewardInfo([]);
  if (isWin && info.dailyWinNum < dailyWinMax) {
    rewardInfo = grantRewardInfo(player, ensureArray(baseCfg.battleWinRewards));
    info.dailyWinNum += 1;
  }

  const log = appendDoubleTowerLog(info, {
    type: battleType,
    result: isWin ? 0 : 1,
    uid: info.enemyId || '',
    point: info.point,
    rank: info.rank,
  });
  info.enemyId = '';

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4502,
    msgUid,
    data: {
      result: 0,
      point: info.point,
      rank: info.rank,
      log,
      rewardInfo,
      ...buildDoubleTowerData(info),
    },
  };
}

// Double tower battle ads reward (tag:4503)
async function handleDoubleTowerBattleAdsReward(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4503, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };

  const baseCfg = config.get('DoubleTowerBaseConfig') || {};
  const adsLimit = Math.max(1, toSafeInt(baseCfg.DailyWinAdsLimit, 5));
  const rawDt = ensurePlainObject(player.doubleTowerInfo);
  const winAdsNum = Math.max(0, toSafeInt(rawDt.winAdsNum, 0));
  if (winAdsNum >= adsLimit) {
    const snap = clonePlayerSnapshot(player);
    const infoSnap = ensureDoubleTowerInfo(snap);
    return {
      tag: 4503,
      msgUid,
      data: { result: 1, rewardInfo: buildRewardInfo([]), ...buildDoubleTowerData(infoSnap) },
    };
  }

  const info = ensureDoubleTowerInfo(player);
  const type = Math.max(0, toSafeInt(params && params.type, 0));

  const rewardRows = type === 1
    ? ensureArray(baseCfg.battleWinAddRewards)
    : [{ id: 71, count: 100 }];
  const rewardInfo = grantRewardInfo(player, rewardRows);
  info.winAdsNum += 1;

  await playerService.savePlayer(session.userId, player);
  return { tag: 4503, msgUid, data: { result: 0, rewardInfo, ...buildDoubleTowerData(info) } };
}

// Double tower rank battle start (tag:4504)
async function handleDoubleTowerRankBattle(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4504, msgUid, data: { result: -1, info: {} } };

  const info = ensureDoubleTowerInfo(player);
  const enemyInfo = buildDoubleTowerEnemyInfo(player, info, params);
  info.enemyId = String(enemyInfo.dbid || '');

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4504,
    msgUid,
    data: {
      result: 0,
      info: enemyInfo,
      ...buildDoubleTowerData(info),
    },
  };
}

// Double tower rank battle finish (tag:4505)
async function handleDoubleTowerRankBattleFinish(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4505, msgUid, data: { result: -1 } };

  const info = ensureDoubleTowerInfo(player);
  const battleType = Math.max(0, toSafeInt(params && params.type, 0));
  const scoreChange = getDoubleTowerBattleScore(battleType);
  updateDoubleTowerPointRank(info, scoreChange);

  const log = appendDoubleTowerLog(info, {
    type: battleType,
    result: battleType === 0 ? 0 : 1,
    uid: info.enemyId || '',
    point: info.point,
    rank: info.rank,
  });
  info.enemyId = '';

  // Return the battle result immediately; the save queue has already taken a
  // snapshot and will persist the updated score without blocking the client.
  playerService.savePlayer(session.userId, player).catch((err) => {
    logger.warn(`[Arena] async double tower save failed user=${session.userId}: ${err.message}`);
  });
  return {
    tag: 4505,
    msgUid,
    data: {
      result: 0,
      point: info.point,
      rank: info.rank,
      log,
      ...buildDoubleTowerData(info),
    },
  };
}

// Double tower rank battle ads reward (tag:4506)
async function handleDoubleTowerRankBattleAdsReward(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4506, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };

  const baseCfg = config.get('DoubleTowerBaseConfig') || {};
  const adsLimit = Math.max(1, toSafeInt(baseCfg.DailyWinAdsLimit, 5));
  const rawDt = ensurePlainObject(player.doubleTowerInfo);
  const winAdsNum = Math.max(0, toSafeInt(rawDt.winAdsNum, 0));
  if (winAdsNum >= adsLimit) {
    const snap = clonePlayerSnapshot(player);
    const infoSnap = ensureDoubleTowerInfo(snap);
    return {
      tag: 4506,
      msgUid,
      data: { result: 1, rewardInfo: buildRewardInfo([]), ...buildDoubleTowerData(infoSnap) },
    };
  }

  const info = ensureDoubleTowerInfo(player);
  const type = Math.max(0, toSafeInt(params && params.type, 0));

  const rewardRows = type === 1
    ? [{ id: 72, count: 120 }]
    : [{ id: 71, count: 120 }];
  const rewardInfo = grantRewardInfo(player, rewardRows);
  info.winAdsNum += 1;

  await playerService.savePlayer(session.userId, player);
  return { tag: 4506, msgUid, data: { result: 0, rewardInfo, ...buildDoubleTowerData(info) } };
}

// Double tower rank reward claim (tag:4507)
async function handleDoubleTowerRankReward(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4507, msgUid, data: { result: -1, rewards: [] } };

  const index = Math.max(1, toSafeInt(params && params.index, 1));
  const rawDt = ensurePlainObject(player.doubleTowerInfo);
  const claimed = new Set(
    ensureArray(rawDt.rankRewardList)
      .map((v) => Math.max(0, toSafeInt(v, 0)))
      .filter((v) => v > 0),
  );
  if (claimed.has(index)) {
    return { tag: 4507, msgUid, data: { result: 1, rewards: [] } };
  }

  const info = ensureDoubleTowerInfo(player);

  const rewardCfg = config.get('DoubleTowerRankRewardsConfig') || {};
  const row = rewardCfg[index] || rewardCfg[String(index)] || null;
  const rewards = normalizeRewardRows(row && row.rewards);
  rewards.forEach((reward) => addRewardToPlayer(player, reward.id, reward.count));
  claimed.add(index);
  info.rankRewardList = Array.from(claimed).sort((a, b) => a - b);

  await playerService.savePlayer(session.userId, player);
  return { tag: 4507, msgUid, data: { result: 0, index, rewards } };
}

// Double tower top rank list (tag:4508)
async function handleDoubleTowerTopRank(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4508, msgUid, data: { result: -1, rankList: [] } };

  const info = ensureDoubleTowerInfo(player);
  const rankList = buildDoubleTowerRankList(player, info);
  const selfRow = rankList.find((row) => String(row.dbid) === String(player.playerId));
  if (selfRow) {
    info.rank = Math.max(1, toSafeInt(selfRow.rank, info.rank));
    info.point = Math.max(0, toSafeInt(selfRow.point, info.point));
    info.maxPoint = Math.max(toSafeInt(info.maxPoint, 0), info.point);
  }
  await playerService.savePlayer(session.userId, player);

  return { tag: 4508, msgUid, data: { result: 0, rankList } };
}

// Double tower set defence index (tag:4509)
async function handleDoubleTowerSetDefence(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4509, msgUid, data: { result: -1, index: 0 } };

  const info = ensureDoubleTowerInfo(player);
  const index = Math.max(1, toSafeInt(params && params.index, 1));
  info.defence = index;
  await playerService.savePlayer(session.userId, player);
  return { tag: 4509, msgUid, data: { result: 0, ...buildDoubleTowerData(info), index } };
}

async function handleTopCombatStartFight(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2300, msgUid, data: { result: 1 } };

  const info = ensureTopCombatInfo(player);
  const beforeChallengeInfo = buildTopCombatChallengeInfo(player, info, false);
  const beforeRank = info.rank;
  const requestedRobotId = String(params && params.enemyid || '').trim();
  const requestedRank = Math.max(0, toSafeInt(params && params.index, 0));
  const rankByRobot = ensureArray(beforeChallengeInfo.challengeList).find((rank) => {
    const row = ensurePlainObject(beforeChallengeInfo.infoMap && beforeChallengeInfo.infoMap[rank]);
    return requestedRobotId && String(row.dbid || '') === requestedRobotId;
  });
  const targetRank = Math.max(
    1,
    requestedRank
      || toSafeInt(rankByRobot, 0)
      || toSafeInt(beforeChallengeInfo.challengeList[0], 0)
      || Math.max(1, beforeRank - 1),
  );
  const enemyShow = {
    ...buildTopCombatRobotShowInfo(player, targetRank),
    ...ensurePlainObject(beforeChallengeInfo.infoMap && beforeChallengeInfo.infoMap[targetRank]),
  };
  const enemyid = String(enemyShow.dbid || getTopCombatRobotId(targetRank));

  const playerAttrs = battle.calcPlayerPower(player);
  const robotCfgMap = ensurePlainObject(config.get('TopCombatRobotConfig'));
  const robotCfg = ensurePlainObject(robotCfgMap[enemyid] || robotCfgMap[toSafeInt(enemyid, 0)]);
  const configuredEnemyAttrs = ensurePlainObject(robotCfg.robotAttrs);
  const enemyAttrs = Object.keys(configuredEnemyAttrs).length > 0
    ? configuredEnemyAttrs
    : battle.generateOpponentAttrs(
      Math.max(1, toSafeInt(enemyShow.level, player.level)),
      Math.max(-5, Math.min(10, beforeRank - targetRank)),
    );
  const fight = battle.simulateBattle(playerAttrs, enemyAttrs, { isPvp: true });
  const win = fight && fight.win ? 1 : 0;
  const rankChange = win && targetRank < beforeRank ? beforeRank - targetRank : 0;
  if (rankChange > 0) {
    info.rank = targetRank;
    info.maxRank = Math.min(info.maxRank, targetRank);
  }
  appendTopCombatLog(info, { atk: 1, rank: targetRank, logtime: Math.floor(Date.now() / 1000) });

  const rewards = win
    ? [{ id: 2, count: 200 + Math.max(1, toSafeInt(player.level, 1)) * 20 }]
    : [];
  rewards.forEach((row) => addRewardToPlayer(player, row.id, row.count));

  const arenaServerId = resolveArenaServerId(session, player);
  const selfShow = buildArenaFightSelfShowInfo(player, arenaServerId, battle.calcPowerScore(playerAttrs || {}));
  const opponentShow = buildArenaFightOpponentShowInfo(enemyShow, player.level);
  const playerHpMax = Math.max(1, toSafeInt(playerAttrs && playerAttrs[1], 100));
  const enemyHpMax = Math.max(1, toSafeInt(enemyAttrs && enemyAttrs[1], 100));
  const flow = buildArenaBattleEvents(playerHpMax, enemyHpMax, opponentShow, !!win);
  const selfEntity = applyPrimaryBattlePetParts({
    id: Math.max(1, toSafeInt(selfShow.kungfuId, 4)),
    dbid: toArenaDbid(player),
    name: String(player.name || 'Player'),
    type: 1,
    side: 1,
    camp: 1,
    pos: 1,
    posIndex: 1,
    hp: playerHpMax,
    maxhp: playerHpMax,
    maxHp: playerHpMax,
    vars: buildFightVars(playerHpMax),
    showInfo: selfShow,
    parts: {},
    partValues: {},
  }, player);
  const fightResult = {
    type: 10,
    win,
    mustChangeTurn: 0,
    notChangeTurn: 1,
    atkAttr: playerAttrs || {},
    defAttr: enemyAttrs || {},
    damage: {
      1: Math.max(0, toSafeInt(fight && fight.monsterDamage, 0)),
      '-1': Math.max(0, toSafeInt(fight && fight.playerDamage, 0)),
    },
    isBackFight: false,
    events: flow.events,
    entitys: [
      selfEntity,
      {
        id: Math.max(1, toSafeInt(opponentShow.kungfuId, 1)),
        dbid: enemyid,
        name: String(opponentShow.name || `天梯守擂者${targetRank}`),
        type: 1,
        side: 2,
        camp: 2,
        pos: -1,
        posIndex: -1,
        hp: enemyHpMax,
        maxhp: enemyHpMax,
        maxHp: enemyHpMax,
        vars: buildFightVars(enemyHpMax),
        showInfo: opponentShow,
        parts: {},
        partValues: {},
      },
    ],
    guildBossAllDamage: 0,
    bloodlineOffset: 0,
  };

  const challengeInfo = buildTopCombatChallengeInfo(player, info, true);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 2300,
    msgUid,
    data: {
      result: 0,
      enemyid,
      rank: info.rank,
      rankChange,
      rewards,
      rewardInfo: buildRewardInfo(rewards),
      challengeInfo,
      fightResult,
    },
  };
}

// Top combat challenge info (tag:4600)
async function handleTopCombatChallengeInfo(_params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 4600,
      msgUid,
      data: {
        result: -1,
        matchStatus: 0,
        matchEndTime: 0,
        challengeInfo: { rank: getTopCombatInitialRank(), refreshtime: 0, challengeList: [], infoMap: {} },
      },
    };
  }

  const info = ensureTopCombatInfo(player);
  const challengeInfo = buildTopCombatChallengeInfo(player, info, false);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4600,
    msgUid,
    data: {
      result: 0,
      matchStatus: info.matchStatus,
      matchEndTime: info.matchEndTime,
      challengeInfo,
      maxRank: info.maxRank,
      records: ensureArray(info.records),
      loglist: ensureArray(info.loglist),
    },
  };
}

// Top combat refresh challenge list (tag:4601)
async function handleTopCombatRefreshChallenge(_params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 4601,
      msgUid,
      data: {
        result: -1,
        rank: getTopCombatInitialRank(),
        challengeInfo: { rank: getTopCombatInitialRank(), refreshtime: 0, challengeList: [], infoMap: {} },
      },
    };
  }

  const info = ensureTopCombatInfo(player);
  const challengeInfo = buildTopCombatChallengeInfo(player, info, true);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4601,
    msgUid,
    data: {
      result: 0,
      rank: info.rank,
      matchStatus: info.matchStatus,
      matchEndTime: info.matchEndTime,
      challengeInfo,
    },
  };
}

// Top combat rank info (tag:4602)
async function handleTopCombatRankInfo(_params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 4602, msgUid, data: { result: -1, rank: getTopCombatInitialRank(), count: 0, topMap: {}, rankMap: {} } };
  }

  const info = ensureTopCombatInfo(player);
  const challengeInfo = buildTopCombatChallengeInfo(player, info, false);
  const rankInfo = buildTopCombatRankInfo(player, info);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4602,
    msgUid,
    data: {
      result: 0,
      ...rankInfo,
      matchStatus: info.matchStatus,
      matchEndTime: info.matchEndTime,
      challengeInfo,
    },
  };
}

// Top combat first rank reward (tag:4603)
async function handleTopCombatFirstReward(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4603, msgUid, data: { result: -1, index: 0, rewardInfo: buildRewardInfo([]) } };

  const info = ensureTopCombatInfo(player);
  const index = Math.max(1, toSafeInt(params && params.index, 1));
  const claimed = new Set(ensureArray(info.records).map((row) => Math.max(0, toSafeInt(row, 0))).filter((row) => row > 0));
  const rewardRows = [];
  if (!claimed.has(index)) {
    rewardRows.push({ id: 1, count: 5 * index });
    rewardRows.push({ id: 2, count: 100 * index });
    claimed.add(index);
    info.records = Array.from(claimed).sort((a, b) => a - b);
  }

  const rewardInfo = grantRewardInfo(player, rewardRows);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4603,
    msgUid,
    data: {
      result: 0,
      index,
      rewardInfo,
    },
  };
}

// Top combat quick sweep reward (tag:4604)
async function handleTopCombatSweepReward(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 4604, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };

  const info = ensureTopCombatInfo(player);
  const count = Math.max(1, Math.min(20, toSafeInt(params && params.count, 1)));
  const rewardRows = [];
  const nowSec = Math.floor(Date.now() / 1000);

  for (let i = 0; i < count; i++) {
    rewardRows.push({ id: 2, count: 120 + Math.max(1, toSafeInt(player.level, 1)) * 10 });
    rewardRows.push({ id: 71, count: 20 });
    info.rank = Math.max(1, info.rank - 1);
    info.maxRank = Math.min(Math.max(1, toSafeInt(info.maxRank, info.rank)), info.rank);
    appendTopCombatLog(info, { atk: 1, logtime: nowSec + i, rank: info.rank });
  }

  const challengeInfo = buildTopCombatChallengeInfo(player, info, true);
  const rewardInfo = grantRewardInfo(player, rewardRows);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 4604,
    msgUid,
    data: {
      result: 0,
      count,
      rank: info.rank,
      challengeInfo,
      rewardInfo,
    },
  };
}

// Top arena challenge info (tag:6200)
async function handleTopArenaChallengeInfo(_params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 6200,
      msgUid,
      data: {
        result: -1,
        matchStatus: 0,
        matchEndTime: 0,
        challengeInfo: { rank: TOP_ARENA_DEFAULT_RANK, refreshtime: 0, challengeList: [], infoMap: {} },
      },
    };
  }

  const info = ensureTopArenaInfo(player);
  const challengeInfo = buildTopArenaChallengeInfo(player, info, false);
  await playerService.savePlayer(session.userId, player);
  return [{
    tag: 6200,
    msgUid,
    data: {
      result: 0,
      matchStatus: info.matchStatus,
      matchEndTime: info.matchEndTime,
      challengeInfo,
    },
  }, {
    tag: 6200,
    msgUid: 0,
    data: {
      info: {
        stage: 1,
        season: 1,
        round: 1,
        matchId: 1,
      },
      playerInfo: {
        round: -1,
        passRecord: Math.max(0, toSafeInt(info.passRecord, 0)),
      },
    },
  }];
}

// Top arena refresh challenge list (tag:6201)
async function handleTopArenaRefreshChallenge(_params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 6201,
      msgUid,
      data: {
        result: -1,
        rank: TOP_ARENA_DEFAULT_RANK,
        challengeInfo: { rank: TOP_ARENA_DEFAULT_RANK, refreshtime: 0, challengeList: [], infoMap: {} },
      },
    };
  }

  const info = ensureTopArenaInfo(player);
  const challengeInfo = buildTopArenaChallengeInfo(player, info, true);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6201,
    msgUid,
    data: {
      result: 0,
      rank: info.rank,
      challengeInfo,
      matchStatus: info.matchStatus,
      matchEndTime: info.matchEndTime,
    },
  };
}

// Top arena sweep reward (tag:6202)
async function handleTopArenaSweepReward(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6202, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };

  const info = ensureTopArenaInfo(player);
  const count = Math.max(1, Math.min(20, toSafeInt(params && params.count, 1)));
  const rewardRows = [];
  const nowSec = Math.floor(Date.now() / 1000);

  for (let i = 0; i < count; i++) {
    rewardRows.push({ id: 2, count: 150 + Math.max(1, toSafeInt(player.level, 1)) * 10 });
    rewardRows.push({ id: 71, count: 25 });
    info.rank = Math.max(1, info.rank - 1);
    info.maxRank = Math.max(1, Math.min(info.maxRank, info.rank));
    appendTopArenaLog(info, { atk: 1, logtime: nowSec + i, rank: info.rank });
  }

  const challengeInfo = buildTopArenaChallengeInfo(player, info, true);
  const rewardInfo = grantRewardInfo(player, rewardRows);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6202,
    msgUid,
    data: {
      result: 0,
      count,
      rank: info.rank,
      challengeInfo,
      rewardInfo,
    },
  };
}

// Top arena challenge logs (tag:6203)
async function handleTopArenaChallengeLog(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6203, msgUid, data: { result: -1, loglist: [] } };

  const info = ensureTopArenaInfo(player);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6203,
    msgUid,
    data: {
      result: 0,
      loglist: ensureArray(info.loglist),
    },
  };
}

// Top arena match room info (tag:6210)
async function handleTopArenaMatchInfo(_params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 6210, msgUid, data: { result: -1, round: 1, roomInfo: { roomId: 1, step: 1, playerMap: {}, winCount: {} } } };
  }

  const info = ensureTopArenaInfo(player);
  const matchInfo = ensureTopArenaMatchInfo(player, info);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6210,
    msgUid,
    data: {
      result: 0,
      round: matchInfo.round,
      roomInfo: matchInfo.roomInfo,
    },
  };
}

// Top arena room detail (tag:6211)
async function handleTopArenaRoomData(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 6211, msgUid, data: { result: -1, roomInfo: { roomId: 1, step: 1, playerMap: {}, winCount: {} } } };
  }

  const info = ensureTopArenaInfo(player);
  const matchInfo = ensureTopArenaMatchInfo(player, info);
  const round = Math.max(1, toSafeInt(params && params.round, matchInfo.round));
  const roomId = Math.max(1, toSafeInt(params && params.roomId, matchInfo.roomInfo.roomId));
  matchInfo.round = round;
  matchInfo.roomInfo.roomId = roomId;
  if (Object.keys(ensurePlainObject(matchInfo.roomInfo.playerMap)).length === 0) {
    matchInfo.roomInfo.playerMap = buildTopArenaRoomPlayerMap(player, info, roomId);
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6211,
    msgUid,
    data: {
      result: 0,
      roomInfo: matchInfo.roomInfo,
    },
  };
}

// Top arena room guess info (tag:6212)
async function handleTopArenaRoomGuessInfo(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 6212, msgUid, data: { result: -1, guessInfo: { roomGuess: {}, playerGuess: {} }, winner: '', playerMap: {} } };
  }

  const info = ensureTopArenaInfo(player);
  const matchInfo = ensureTopArenaMatchInfo(player, info);
  const round = Math.max(1, toSafeInt(params && params.round, matchInfo.round));
  const roomId = Math.max(1, toSafeInt(params && params.roomId, matchInfo.roomInfo.roomId));
  const guessInfo = getTopArenaRoomGuessStore(info, round, roomId, matchInfo.roomInfo);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6212,
    msgUid,
    data: {
      result: 0,
      guessInfo,
      winner: '',
      playerMap: matchInfo.roomInfo.playerMap,
    },
  };
}

// Top arena guess/support (tag:6213)
async function handleTopArenaGuess(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 6213, msgUid, data: { result: -1, guessInfo: { roomGuess: {}, playerGuess: {} } } };
  }

  const info = ensureTopArenaInfo(player);
  const matchInfo = ensureTopArenaMatchInfo(player, info);
  const roomId = Math.max(1, toSafeInt(params && params.roomId, matchInfo.roomInfo.roomId));
  const round = Math.max(1, toSafeInt(matchInfo.round, 1));
  const playerId = params && params.playerId != null ? String(params.playerId) : '';
  const count = Math.max(1, toSafeInt(params && params.count, 1));
  const guessInfo = getTopArenaRoomGuessStore(info, round, roomId, matchInfo.roomInfo);

  if (playerId && Object.prototype.hasOwnProperty.call(guessInfo.roomGuess, playerId)) {
    guessInfo.roomGuess[playerId] = Math.max(0, toSafeInt(guessInfo.roomGuess[playerId], 0) + count);
    const selfId = String(player.playerId || '');
    if (selfId) {
      guessInfo.playerGuess[selfId] = playerId;
    }
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6213,
    msgUid,
    data: {
      result: 0,
      guessInfo,
    },
  };
}

// Top arena room rank info (tag:6214)
async function handleTopArenaRoomRankInfo(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 6214, msgUid, data: { result: -1, type: 1, rank: TOP_ARENA_DEFAULT_RANK, value: 0, rankList: [] } };
  }

  const info = ensureTopArenaInfo(player);
  const payload = buildTopArenaRankPayload(player, info, params && params.type);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6214,
    msgUid,
    data: {
      result: 0,
      ...payload,
    },
  };
}

// Top arena show info (tag:6215)
async function handleTopArenaShowInfo(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6215, msgUid, data: { result: -1, worship: 0, showMap: {} } };

  const info = ensureTopArenaInfo(player);
  const showInfo = buildTopArenaShowInfo(player, info);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6215,
    msgUid,
    data: {
      result: 0,
      ...showInfo,
    },
  };
}

// Top arena worship reward (tag:6216)
async function handleTopArenaWorship(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6216, msgUid, data: { result: -1, worship: 0 } };

  const previewPlayer = clonePlayerSnapshot(player);
  const previewInfo = ensureTopArenaInfo(previewPlayer);
  const showPreview = buildTopArenaShowInfo(previewPlayer, previewInfo);
  if (showPreview.worship === 1) {
    return { tag: 6216, msgUid, data: { result: 1, worship: 1, rewardInfo: buildRewardInfo([]) } };
  }

  const info = ensureTopArenaInfo(player);
  const supportRewards = ensureArray((config.get('TopArenaBaseConfig') || {}).supportRewards);
  const rewardInfo = grantRewardInfo(player, supportRewards);
  info.showInfo.worship = 1;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6216,
    msgUid,
    data: {
      result: 0,
      worship: 1,
      rewardInfo,
    },
  };
}

// Top arena get cross player detail (tag:6217)
async function handleTopArenaCrossPlayerDetail(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6217, msgUid, data: {} };

  const targetId = params && params.playerId ? String(params.playerId) : String(player.playerId || '');
  const isSelf = String(player.playerId || '') === targetId;
  const shadowPlayer = isSelf
    ? player
    : {
      ...player,
      playerId: targetId,
      name: `跨服玩家${targetId.slice(-4)}`,
      level: Math.max(1, toSafeInt(player.level, 1)),
    };

  return {
    tag: 6217,
    msgUid,
    data: {
      ...buildPlayer500Data(shadowPlayer),
      playerId: targetId,
      dbid: targetId,
      serverId: Math.max(1, toSafeInt(params && params.serverId, 1)),
    },
  };
}

// Top arena lock status update (tag:6218)
async function handleTopArenaLockStatus(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6218, msgUid, data: { result: -1, lockTime: 0 } };

  const info = ensureTopArenaInfo(player);
  const nowSec = Math.floor(Date.now() / 1000);
  info.lockTime = Math.max(info.lockTime, nowSec + 3600);
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6218,
    msgUid,
    data: {
      result: 0,
      lockTime: info.lockTime,
    },
  };
}

// Top arena pass reward (tag:6220)
async function handleTopArenaPassReward(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6220, msgUid, data: { result: -1, passRecord: 0, rewardInfo: buildRewardInfo([]) } };

  const info = ensureTopArenaInfo(player);
  const rewardRows = [{ id: 1, count: 20 }, { id: 2, count: 500 }];
  const rewardInfo = grantRewardInfo(player, rewardRows);
  info.passRecord += 1;

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6220,
    msgUid,
    data: {
      result: 0,
      passRecord: info.passRecord,
      rewardInfo,
    },
  };
}

// Top arena guess logs (tag:6221)
async function handleTopArenaGuessLog(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6221, msgUid, data: { result: -1, logs: [] } };

  const info = ensureTopArenaInfo(player);
  const round = Math.max(0, toSafeInt(params && params.round, 0));
  if (info.guessLogs.length === 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    info.guessLogs.push({
      round,
      roomId: 1,
      playerId: `ta_robot_${Math.max(1, info.rank - 1)}`,
      supportCount: 1,
      isWin: 1,
      logtime: nowSec,
    });
  }

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 6221,
    msgUid,
    data: {
      result: 0,
      logs: ensureArray(info.guessLogs),
    },
  };
}

// Cross arena initial info (tag:5000)
async function handleCrossArenaInfo(_params, session, msgUid) {
  const player = session.player;
  const snapshot = clonePlayerSnapshot(player);
  const info = ensureCrossArenaInfo(snapshot);
  const challengelist = await buildCrossArenaChallengeList(session, snapshot);
  const rankRows = buildCrossArenaRankRows(snapshot, info.score, challengelist);
  const selfDbid = snapshot && snapshot.playerId ? snapshot.playerId : '';
  const myRank = selfDbid ? rankRows.findIndex((row) => row.dbid === selfDbid) + 1 : 0;
  const fallbackRank = selfDbid ? await rank.getRank('crossArena', selfDbid) : 0;

  return {
    tag: 5000,
    msgUid,
    data: {
      score: info.score,
      rank: myRank > 0 ? myRank : Math.max(1, toSafeInt(fallbackRank, 999)),
      dailyCount: info.dailyCount,
      maxCount: info.maxCount,
      challengelist,
      refreshtime: info.refreshtime,
      loglist: info.loglist,
      ranklist: rankRows,
      toplist: rankRows.slice(0, 3),
    },
  };
}

// Cross arena refresh challenge list (tag:5001)
async function handleCrossArenaRefresh(_params, session, msgUid) {
  const player = session.player;
  const info = ensureCrossArenaInfo(player);
  const challengelist = await buildCrossArenaChallengeList(session, player);
  info.refreshtime = Math.floor(Date.now() / 1000) + 30;
  if (player) await playerService.savePlayer(session.userId, player);

  return {
    tag: 5001,
    msgUid,
    data: {
      result: 0,
      score: info.score,
      challengelist,
      refreshtime: info.refreshtime,
    },
  };
}

// Cross arena challenge list (tag:5002)
async function handleCrossArenaChallengeList(_params, session, msgUid) {
  const player = session.player;
  const snapshot = clonePlayerSnapshot(player);
  const info = ensureCrossArenaInfo(snapshot);
  const challengelist = await buildCrossArenaChallengeList(session, snapshot);
  const loginfo = {
    logtime: Math.floor(Date.now() / 1000),
    type: 0,
  };

  return {
    tag: 5002,
    msgUid,
    data: {
      result: 0,
      score: info.score,
      challengelist,
      loginfo,
    },
  };
}

// Generate challenge opponent list
function generateOpponents(player, options = {}) {
  const level = player ? player.level || 1 : 1;
  const names = ['剑修·青云', '法修·紫霄', '体修·铁拳', '器修·灵匠', '丹修·妙手'];
  const robotCfgMap = getArenaRobotConfigMap(!!options.crossArena);
  const robotIds = Object.keys(robotCfgMap)
    .map((key) => Math.max(0, toSafeInt(key, 0)))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
  const list = [];
  for (let i = 0; i < 5; i++) {
    const opLv = Math.max(1, level + i - 2);
    const robotId = robotIds[i] || (1000 + i + 1);
    const robotCfg = ensurePlainObject(robotCfgMap[robotId] || robotCfgMap[String(robotId)]);
    const configuredAttrs = ensurePlainObject(robotCfg.robotAttrs);
    const attrs = Object.keys(configuredAttrs).length > 0
      ? configuredAttrs
      : battle.generateOpponentAttrs(opLv, i - 2);
    const fightPet = ensureArray(robotCfg.fightPet)
      .map((id) => Math.max(0, toSafeInt(id, 0)))
      .filter((id) => id > 0);
    const point = Math.max(0, toSafeInt(robotCfg.score, 1000 + opLv * 10));
    const roleSelection = normalizeArenaRoleSelection(
      robotCfg.kungfuId,
      toSafeInt(robotCfg.subJob, 0)
    );
    if (toSafeInt(robotCfg.kungfuId, 0) <= 0) {
      Object.assign(roleSelection, normalizeArenaRoleSelection(ARENA_ROBOT_KUNGFU_IDS[i] || 4, 0));
    }
    const power = Math.max(100, toSafeInt(battle.calcPowerScore(attrs), 100));
    list.push({
      dbid: String(robotId),
      playerId: String(robotId),
      name: robotCfg.name || names[i],
      level: Math.max(1, toSafeInt(robotCfg.robotLv, opLv)),
      robotLv: Math.max(1, toSafeInt(robotCfg.robotLv, opLv)),
      avatar: Math.max(0, toSafeInt(robotCfg.head, 11300 + i)),
      avatarFrame: -1,
      title: -1,
      petId: fightPet[0] || 0,
      kungfuId: roleSelection.kungfuId,
      subJob: roleSelection.subJob,
      serverId: resolveArenaServerId(null, player),
      serverName: '',
      score: point,
      point,
      power,
      powerScore: power,
      robotAttrs: attrs,
      robotSkill: ensureArray(robotCfg.robotSkill),
      fightPet,
      fightPetSkill: ensureArray(robotCfg.fightPetSkill),
    });
  }
  return list;
}

module.exports = {
  ensureDoubleTowerInfo,
  buildDoubleTowerData,
  handleArenaInfo,
  handleArenaRefresh,
  handleArenaFight,
  handleTopArenaStartFight,
  handleArenaFight2300: (params, session, msgUid) => performArenaFight(params, session, msgUid, {
    responseTag: 2300,
    syncTask: true,
    asPackets: true,
    crossArena: [16, 17].includes(toSafeInt(params && params.type, 0)),
  }),
  handleDoubleTowerOutbound,
  handleDoubleTowerBattle,
  handleDoubleTowerBattleFinish,
  handleDoubleTowerBattleAdsReward,
  handleDoubleTowerRankBattle,
  handleDoubleTowerRankBattleFinish,
  handleDoubleTowerRankBattleAdsReward,
  handleDoubleTowerRankReward,
  handleDoubleTowerTopRank,
  handleDoubleTowerSetDefence,
  handleTopCombatStartFight,
  handleTopCombatChallengeInfo,
  handleTopCombatRefreshChallenge,
  handleTopCombatRankInfo,
  handleTopCombatFirstReward,
  handleTopCombatSweepReward,
  handleTopArenaChallengeInfo,
  handleTopArenaRefreshChallenge,
  handleTopArenaSweepReward,
  handleTopArenaChallengeLog,
  handleTopArenaMatchInfo,
  handleTopArenaRoomData,
  handleTopArenaRoomGuessInfo,
  handleTopArenaGuess,
  handleTopArenaRoomRankInfo,
  handleTopArenaShowInfo,
  handleTopArenaWorship,
  handleTopArenaCrossPlayerDetail,
  handleTopArenaLockStatus,
  handleTopArenaPassReward,
  handleTopArenaGuessLog,
  handleCrossArenaInfo,
  handleCrossArenaRefresh,
  handleCrossArenaChallengeList,
};
