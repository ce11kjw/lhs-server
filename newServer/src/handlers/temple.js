/**
 * Temple handlers
 * tag: 5400 mini-game rank info
 * tag: 5420/5421/5422 mini-game lifecycle
 * tag: 5450 temple event operation
 * tag: 5451/5452/5453 temple stage and info sync
 * tag: 5460 temple mini-game snapshot
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const { refreshMainTaskProgress } = require('../services/MainTaskProgressService');
const { addRewardToPlayer } = require('./raid');
const {
  ensureRoleAppearance,
  getPlayerFashionMap,
  getPrimaryBattlePetId,
  normalizeRoleSelection,
  buildDefaultFashionMap,
} = require('../services/RoleAppearanceService');

const TEMPLE_LINGYUN_ITEM_ID = 137;
const TEMPLE_LINGYUN_MAX = 10;
const TEMPLE_LINGYUN_RECOVER_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TEMPLE_PLAYBACK_ROUNDS = 15;

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function normalizeObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function clonePlayerSnapshot(player = {}) {
  if (!player || typeof player !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(player));
  } catch (_err) {
    return { ...player };
  }
}

function getGmt8DateParts(nowMs = Date.now()) {
  const shifted = new Date(nowMs + 8 * 60 * 60 * 1000);
  const day = shifted.getUTCDay() || 7;
  const sec = shifted.getUTCHours() * 3600 + shifted.getUTCMinutes() * 60 + shifted.getUTCSeconds();
  return { day, sec, shiftedMs: shifted.getTime() };
}

function isTempleDayEnabled(dayList = [], currentDay = 0) {
  const enabledDays = ensureArray(dayList)
    .map((v) => Math.max(0, toSafeInt(v, 0)))
    .filter((v) => v > 0);
  return enabledDays.length <= 0 || enabledDays.includes(currentDay);
}

function isTempleSecRangeActive(range = [], currentSec = 0) {
  const values = ensureArray(range).map((v) => Math.max(0, toSafeInt(v, 0)));
  if (values.length < 2) return false;
  const start = values[0];
  const end = values[1];
  if (start <= end) return currentSec >= start && currentSec <= end;
  return currentSec >= start || currentSec <= end;
}

function isTempleWindowActive(openTime, closeTime, nowMs = Date.now()) {
  const start = Math.max(0, toSafeInt(openTime, 0));
  const end = Math.max(0, toSafeInt(closeTime, 0));
  if (start <= 0 || end <= 0) return false;
  return nowMs >= start && nowMs <= end;
}

function resolveTemplePartDefaultState(id, nowMs = Date.now()) {
  const baseCfg = config.get('TempleBaseConfig') || {};
  const { day, sec } = getGmt8DateParts(nowMs);

  if (id === 3) {
    return isTempleDayEnabled(baseCfg.celebrateDay, day)
      && isTempleSecRangeActive(baseCfg.celebrateTime, sec)
      ? 1
      : 0;
  }

  if (id === 5) {
    return isTempleDayEnabled(baseCfg.guessDay, day)
      && ensureArray(baseCfg.guessTime).some((range) => isTempleSecRangeActive(range, sec))
      ? 1
      : 0;
  }

  if (id === 6) {
    return isTempleWindowActive(baseCfg.festivalCelebrateOpen, baseCfg.festivalCelebrateClose, nowMs)
      && isTempleSecRangeActive(baseCfg.festivalCelebrateTime, sec)
      ? 1
      : 0;
  }

  if (id === 7) {
    return isTempleWindowActive(baseCfg.festivalGiftOpen, baseCfg.festivalGiftClose, nowMs)
      ? 1
      : 0;
  }

  return 1;
}

function ensureArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizeRewardRows(raw) {
  return ensureArray(raw)
    .map((row) => ({
      id: Math.max(0, toSafeInt(row && row.id, 0)),
      count: Math.max(0, toSafeInt(row && row.count, 0)),
    }))
    .filter((row) => row.id > 0 && row.count > 0);
}

function getCurrencyKeyById(itemId) {
  switch (Math.max(0, toSafeInt(itemId, 0))) {
    case 1: return 'diamond';
    case 2: return 'silver';
    case 6: return 'gold';
    default: return null;
  }
}

function getPlayerResourceCount(player = {}, itemId = 0) {
  const currencyKey = getCurrencyKeyById(itemId);
  if (currencyKey) {
    return Math.max(0, toSafeInt(player && player.currencies && player.currencies[currencyKey], 0));
  }
  return getPlayerItemCount(player, itemId);
}

function consumeTempleCosts(player = {}, rawCosts = []) {
  const costs = normalizeRewardRows(rawCosts);
  if (costs.some((row) => getPlayerResourceCount(player, row.id) < row.count)) return false;

  for (const row of costs) {
    const currencyKey = getCurrencyKeyById(row.id);
    if (currencyKey) {
      player.currencies = normalizeObject(player.currencies);
      player.currencies[currencyKey] = Math.max(0, toSafeInt(player.currencies[currencyKey], 0) - row.count);
    } else {
      setPlayerItemCount(player, row.id, getPlayerItemCount(player, row.id) - row.count);
    }
  }
  return true;
}

function grantTempleRewards(player = {}, rawRewards = []) {
  const rewards = normalizeRewardRows(rawRewards);
  rewards.forEach((row) => addRewardToPlayer(player, row.id, row.count));
  return rewards;
}

function getPlayerItemCount(player = {}, itemId = 0) {
  const items = normalizeObject(player && player.items);
  return Math.max(0, toSafeInt(items[itemId], 0));
}

function setPlayerItemCount(player = {}, itemId = 0, count = 0) {
  if (!player || typeof player !== 'object') return;
  player.items = normalizeObject(player.items);
  const safeItemId = Math.max(0, toSafeInt(itemId, 0));
  const safeCount = Math.max(0, toSafeInt(count, 0));
  if (safeItemId <= 0) return;
  if (safeCount > 0) {
    player.items[String(safeItemId)] = safeCount;
    player.items[safeItemId] = safeCount;
  } else {
    delete player.items[String(safeItemId)];
    delete player.items[safeItemId];
  }
}

function buildLingyunSyncPacket(player = {}) {
  const count = getPlayerItemCount(player, TEMPLE_LINGYUN_ITEM_ID);
  return {
    tag: 1202,
    msgUid: 0,
    data: {
      result: 0,
      items: [{ id: TEMPLE_LINGYUN_ITEM_ID, count }],
      changed: [{ id: TEMPLE_LINGYUN_ITEM_ID, count }],
      timeRecords: buildTempleLingyunTimeRecords(player),
    },
  };
}

function buildTempleLingyunTimeRecords(player = {}) {
  const holder = normalizeObject(player && player.other_attr_info);
  const templeInfo = normalizeObject(holder.templeInfo);
  const lingyun = normalizeObject(templeInfo.lingyun);
  const count = getPlayerItemCount(player, TEMPLE_LINGYUN_ITEM_ID);
  const nextRecoverTime = Math.max(
    0,
    toSafeInt(templeInfo.lingyunNextRecoverTime, toSafeInt(lingyun.nextRecoverTime, 0)),
  );
  const startTime = count >= TEMPLE_LINGYUN_MAX || nextRecoverTime <= 0
    ? 0
    : Math.max(0, nextRecoverTime - TEMPLE_LINGYUN_RECOVER_MS);
  return {
    [TEMPLE_LINGYUN_ITEM_ID]: startTime,
  };
}

function withTempleLingyunSync(player = {}, response, shouldSync = false) {
  if (!shouldSync) return response;
  return [buildLingyunSyncPacket(player), response];
}

function buildDefaultTempleGameEntry(gameId = 1) {
  return {
    gameId: Math.max(1, toSafeInt(gameId, 1)),
    bestScore: 0,
    lastScore: 0,
    playCount: 0,
    lastLevel: 0,
    sequenceId: 0,
    updatedAt: 0,
    extra: {
      sequenceId: 0,
      level: 0,
      state: 0,
      canPlay: TEMPLE_LINGYUN_MAX,
      sync: 0,
    },
  };
}

function pickTempleGameId(inputGameId = 1) {
  const roomCfg = config.get('TempleGameRoomConfig') || {};
  const ids = Object.keys(roomCfg)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);

  const preferred = Math.max(1, toSafeInt(inputGameId, 1));
  if (ids.length === 0) return preferred;
  return ids.includes(preferred) ? preferred : ids[0];
}

function getTemplePartIds() {
  const moduleCfg = config.get('TempleModuleConfig') || {};
  const ids = Object.keys(moduleCfg)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
  return ids.length > 0 ? ids : [1, 2, 3, 4, 5, 6, 7];
}

function getTempleRotatingPartId(info, player = {}) {
  const partIds = getTemplePartIds();
  if (partIds.length <= 0) return 1;

  const statusMap = normalizeObject(info && info.partStatusMap);
  const unlockableIds = partIds.filter((id) => {
    const status = normalizeObject(statusMap[String(id)]);
    return Math.max(0, toSafeInt(status.state, resolveTemplePartDefaultState(id))) > 0;
  });

  const candidates = unlockableIds.length > 0 ? unlockableIds : partIds;
  const levelSeed = Math.max(0, toSafeInt(player && player.raidInfo && player.raidInfo.level, 0));
  const chapterSeed = Math.max(0, toSafeInt(player && player.raidInfo && player.raidInfo.chapter, 0));
  const extraSeed = Math.max(0, toSafeInt(info && info.lingyunCount, 0));
  const idx = (levelSeed + chapterSeed + extraSeed) % candidates.length;
  return candidates[idx];
}

function pickTemplePartId(inputId = 1) {
  const ids = getTemplePartIds();
  const preferred = Math.max(1, toSafeInt(inputId, 1));
  return ids.includes(preferred) ? preferred : ids[0];
}

function pickTempleFightGuildBuffId(inputId = 0) {
  const table = normalizeObject(config.get('TempleFightGuildBuffConfig'));
  const ids = Object.keys(table)
    .map((key) => Math.max(0, toSafeInt(table[key] && table[key].id, toSafeInt(key, 0))))
    .filter((id, index, rows) => id > 0 && rows.indexOf(id) === index)
    .sort((left, right) => left - right);
  const requestedId = Math.max(0, toSafeInt(inputId, 0));
  return ids.includes(requestedId) ? requestedId : (ids[0] || 0);
}

function ensureTempleGameEntry(info, gameId) {
  const key = String(gameId);
  if (!info.rankByGame[key]) {
    info.rankByGame[key] = buildDefaultTempleGameEntry(gameId);
  }
  return info.rankByGame[key];
}

function buildTempleTaskInfos() {
  const taskCfg = config.get('TempleTaskConfig') || {};
  const taskIds = Object.keys(taskCfg)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);

  if (taskIds.length === 0) {
    return [];
  }

  return taskIds.map((id) => {
    const row = normalizeObject(taskCfg[String(id)]);
    return {
      id,
      progress: Math.max(0, toSafeInt(row.progress, 0)),
      status: Math.max(0, toSafeInt(row.status, 0)),
      records: ensureArray(row.records),
    };
  });
}

function buildPlayerArenaShowInfo(player = {}) {
  player = clonePlayerSnapshot(player);
  ensureRoleAppearance(player);
  const roleInfo = normalizeObject(player.roleInfo);
  const roleSelection = normalizeRoleSelection(roleInfo);
  const playerId = String(player.playerId || player.userId || 'temple_player');
  return {
    dbid: playerId,
    name: String(player.name || 'Player'),
    kungfuId: roleSelection.kungfuId,
    subJob: roleSelection.subJob,
    power: Math.max(0, toSafeInt(roleInfo.power, toSafeInt(player.power, 0))),
    petId: getPrimaryBattlePetId(player),
    fashionMap: getPlayerFashionMap(player),
    equipMap: normalizeObject(player.equipInfo && player.equipInfo.equipMap),
    playerInfo: {
      dbid: playerId,
      level: Math.max(1, toSafeInt(player.level, 1)),
      avatar: Math.max(0, toSafeInt(roleInfo.avatar, toSafeInt(player.avatar, 0))),
      avatarUrl: player.avatarUrl ? String(player.avatarUrl) : '',
      avatarFrame: Math.max(0, toSafeInt(roleInfo.avatarFrame, toSafeInt(player.avatarFrame, 0))),
      title: Math.max(0, toSafeInt(roleInfo.title, toSafeInt(player.title, 0))),
    },
  };
}

function normalizeArenaShowInfo(showInfo = {}, fallbackPlayer = {}) {
  const fallback = buildPlayerArenaShowInfo(fallbackPlayer);
  const source = Object.keys(normalizeObject(showInfo)).length > 0 ? normalizeObject(showInfo) : fallback;
  const roleSelection = normalizeRoleSelection(source);
  const fashionMap = normalizeObject(source.fashionMap);
  const equipMap = normalizeObject(source.equipMap);

  return {
    ...fallback,
    ...source,
    kungfuId: roleSelection.kungfuId,
    subJob: roleSelection.subJob,
    level: Math.max(1, toSafeInt(source.level, toSafeInt(fallback.level, 1))),
    stage: Math.max(1, toSafeInt(source.stage, toSafeInt(fallback.stage, 1))),
    fashionMap: Object.keys(fashionMap).length > 0 ? fashionMap : buildDefaultFashionMap(roleSelection),
    equipMap,
    playerInfo: {
      ...normalizeObject(fallback.playerInfo),
      ...normalizeObject(source.playerInfo),
    },
  };
}

function buildDefaultTemplePartStatus(id, player = {}) {
  const now = Date.now();
  const base = {
    id,
    state: resolveTemplePartDefaultState(id, now),
    score: 0,
    openTime: now,
    endTime: now + 24 * 60 * 60 * 1000,
    extra: {},
  };

  if (id === 4) {
    base.extra = {
      buffId: pickTempleFightGuildBuffId(),
      playerId: String(player.playerId || player.userId || ''),
      showInfo: normalizeArenaShowInfo(buildPlayerArenaShowInfo(player), player),
      nextFightTime: 0,
    };
    return base;
  }

  if (id === 5) {
    base.extra = {
      count: 0,
      robotId: 1,
      fightResult: -1,
      localState: 0,
    };
    return base;
  }

  return base;
}

function buildDefaultTemplePartInfo(id) {
  switch (id) {
    case 1:
      return {
        gameInfo: { playData: [] },
        playerRank: {},
      };
    case 2:
      return {
        taskInfos: buildTempleTaskInfos(),
        randomRewardCount: 0,
      };
    case 3:
      return { fireworkCount: 0 };
    case 4:
      return { buffId: 0, playerId: '', showInfo: null, nextFightTime: 0 };
    case 5:
      return { guessId: 0, side: -1, round: 0 };
    case 6:
      return { fireworkCount: 0 };
    case 7:
      return { gifts: [] };
    default:
      return {};
  }
}

function normalizeTemplePartInfo(id, raw) {
  const info = normalizeObject(raw);
  if (id === 1) {
    const gameInfo = normalizeObject(info.gameInfo);
    gameInfo.playData = ensureArray(gameInfo.playData);
    return {
      gameInfo,
      playerRank: normalizeObject(info.playerRank),
    };
  }
  if (id === 2) {
    return {
      taskInfos: ensureArray(info.taskInfos),
      randomRewardCount: Math.max(0, toSafeInt(info.randomRewardCount, 0)),
    };
  }
  if (id === 3 || id === 6) {
    return { fireworkCount: Math.max(0, toSafeInt(info.fireworkCount, 0)) };
  }
  if (id === 4) {
    return {
      buffId: Math.max(0, toSafeInt(info.buffId, 0)),
      playerId: info.playerId == null ? '' : String(info.playerId),
      showInfo: info.showInfo && typeof info.showInfo === 'object' ? info.showInfo : null,
      nextFightTime: Math.max(0, toSafeInt(info.nextFightTime, 0)),
    };
  }
  if (id === 5) {
    return {
      guessId: Math.max(0, toSafeInt(info.guessId, 0)),
      side: toSafeInt(info.side, -1),
      round: Math.max(0, toSafeInt(info.round, 0)),
    };
  }
  if (id === 7) {
    return {
      gifts: ensureArray(info.gifts).map((giftId) => Math.max(0, toSafeInt(giftId, 0))).filter((giftId) => giftId > 0),
    };
  }
  return info;
}

function buildTemplePlayerRank(info) {
  const rows = Object.keys(info.rankByGame)
    .map((key) => normalizeObject(info.rankByGame[key]))
    .filter((row) => toSafeInt(row.gameId, 0) > 0)
    .sort((a, b) => {
      const scoreDiff = toSafeInt(b.bestScore, 0) - toSafeInt(a.bestScore, 0);
      if (scoreDiff !== 0) return scoreDiff;
      return toSafeInt(a.gameId, 0) - toSafeInt(b.gameId, 0);
    });

  const rankMap = {};
  rows.forEach((row, index) => {
    const gameId = Math.max(1, toSafeInt(row.gameId, 1));
    rankMap[String(gameId)] = {
      gameId,
      rank: index + 1,
      score: Math.max(0, toSafeInt(row.bestScore, 0)),
    };
  });
  return rankMap;
}

function buildTemplePlayData(info) {
  const roomCfg = config.get('TempleGameRoomConfig') || {};
  const cfgIds = Object.keys(roomCfg)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);

  const gameIds = cfgIds.length > 0
    ? cfgIds
    : Object.keys(info.rankByGame)
      .map((key) => toSafeInt(key, 0))
      .filter((id) => id > 0)
      .sort((a, b) => a - b);

  return gameIds.map((gameId) => {
    const entry = ensureTempleGameEntry(info, gameId);
    const nextExtra = mergeMiniGameExtra(entry, {}, entry.lastLevel);
    nextExtra.canPlay = Math.max(0, toSafeInt(info.lingyunCount, 0));
    nextExtra.nextRecoverTime = Math.max(0, toSafeInt(info.lingyunNextRecoverTime, 0));
    nextExtra.maxCount = TEMPLE_LINGYUN_MAX;
    entry.extra = nextExtra;
    return {
      id: gameId,
      currentLevel: Math.max(0, toSafeInt(entry.lastLevel, 0)),
      maxLevel: Math.max(0, toSafeInt(entry.bestScore, 0)),
      extra: nextExtra,
    };
  });
}

function ensureTemplePartStatus(info, player, id) {
  const key = String(id);
  const row = normalizeObject(info.partStatusMap[key]);
  const fallback = buildDefaultTemplePartStatus(id, player);

  const status = {
    id,
    state: Math.max(0, toSafeInt(row.state, fallback.state)),
    score: Math.max(0, toSafeInt(row.score, fallback.score)),
    openTime: Math.max(0, toSafeInt(row.openTime, fallback.openTime)),
    endTime: Math.max(0, toSafeInt(row.endTime, fallback.endTime)),
    extra: normalizeObject(row.extra),
  };

  if (id === 4) {
    status.extra.buffId = Math.max(0, toSafeInt(status.extra.buffId, toSafeInt(fallback.extra.buffId, 0)));
    status.extra.playerId = status.extra.playerId == null
      ? String(fallback.extra.playerId || '')
      : String(status.extra.playerId);
    status.extra.showInfo = status.extra.showInfo && typeof status.extra.showInfo === 'object'
      ? status.extra.showInfo
      : fallback.extra.showInfo;
    status.extra.nextFightTime = Math.max(0, toSafeInt(status.extra.nextFightTime, toSafeInt(fallback.extra.nextFightTime, 0)));
  }

  if (id === 5) {
    status.extra.count = Math.max(0, toSafeInt(status.extra.count, toSafeInt(fallback.extra.count, 0)));
    status.extra.robotId = Math.max(1, toSafeInt(status.extra.robotId, toSafeInt(fallback.extra.robotId, 1)));
    status.extra.fightResult = toSafeInt(status.extra.fightResult, toSafeInt(fallback.extra.fightResult, -1));
    status.extra.localState = Math.max(0, toSafeInt(status.extra.localState, toSafeInt(fallback.extra.localState, 0)));
  }

  info.partStatusMap[key] = status;
  return status;
}

function ensureTemplePartInfo(info, id) {
  const key = String(id);
  const normalized = normalizeTemplePartInfo(id, info.partInfoMap[key]);
  const defaults = buildDefaultTemplePartInfo(id);

  const merged = { ...defaults, ...normalized };
  if (id === 1) {
    merged.gameInfo = normalizeObject(merged.gameInfo);
    merged.gameInfo.playData = ensureArray(merged.gameInfo.playData);
    merged.playerRank = normalizeObject(merged.playerRank);
  } else if (id === 2) {
    merged.taskInfos = ensureArray(merged.taskInfos);
    merged.randomRewardCount = Math.max(0, toSafeInt(merged.randomRewardCount, 0));
  } else if (id === 7) {
    merged.gifts = ensureArray(merged.gifts);
  }

  info.partInfoMap[key] = merged;
  return merged;
}

function syncTempleMiniGamePartInfo(info) {
  const miniGame = ensureTemplePartInfo(info, 1);
  miniGame.gameInfo = normalizeObject(miniGame.gameInfo);
  miniGame.gameInfo.playData = buildTemplePlayData(info);
  miniGame.playerRank = buildTemplePlayerRank(info);
  miniGame.gameInfo.lingyun = {
    count: Math.max(0, toSafeInt(info.lingyunCount, 0)),
    maxCount: TEMPLE_LINGYUN_MAX,
    nextRecoverTime: Math.max(0, toSafeInt(info.lingyunNextRecoverTime, 0)),
    recoverInterval: TEMPLE_LINGYUN_RECOVER_MS,
  };
  info.partInfoMap['1'] = miniGame;
  return miniGame;
}

function settleTempleLingyun(info, player = {}) {
  const now = Date.now();
  info.lingyun = normalizeObject(info.lingyun);
  let count = Math.max(0, toSafeInt(getPlayerItemCount(player, TEMPLE_LINGYUN_ITEM_ID), 0));
  let nextRecoverTime = Math.max(0, toSafeInt(info.lingyun.nextRecoverTime, 0));
  let changed = false;

  if (count >= TEMPLE_LINGYUN_MAX) {
    if (count > TEMPLE_LINGYUN_MAX) {
      count = TEMPLE_LINGYUN_MAX;
      changed = true;
    }
    if (nextRecoverTime !== 0) {
      nextRecoverTime = 0;
      changed = true;
    }
  } else if (nextRecoverTime <= 0) {
    nextRecoverTime = now + TEMPLE_LINGYUN_RECOVER_MS;
    changed = true;
  } else if (now >= nextRecoverTime) {
    const recoverCount = Math.max(1, Math.floor((now - nextRecoverTime) / TEMPLE_LINGYUN_RECOVER_MS) + 1);
    const nextCount = Math.min(TEMPLE_LINGYUN_MAX, count + recoverCount);
    if (nextCount !== count) {
      count = nextCount;
      changed = true;
    }
    if (count >= TEMPLE_LINGYUN_MAX) {
      nextRecoverTime = 0;
    } else {
      nextRecoverTime += recoverCount * TEMPLE_LINGYUN_RECOVER_MS;
    }
    changed = true;
  }

  setPlayerItemCount(player, TEMPLE_LINGYUN_ITEM_ID, count);
  info.lingyun.count = count;
  info.lingyun.maxCount = TEMPLE_LINGYUN_MAX;
  info.lingyun.nextRecoverTime = nextRecoverTime;
  info.lingyun.recoverInterval = TEMPLE_LINGYUN_RECOVER_MS;
  info.lingyunCount = count;
  info.lingyunNextRecoverTime = nextRecoverTime;
  return changed;
}

function ensureTempleInfo(player) {
  player.other_attr_info = normalizeObject(player.other_attr_info);
  const holder = player.other_attr_info;
  holder.templeInfo = normalizeObject(holder.templeInfo);
  const info = holder.templeInfo;

  info.rankByGame = normalizeObject(info.rankByGame);
  Object.keys(info.rankByGame).forEach((key) => {
    const gameId = Math.max(1, toSafeInt(key, 1));
    const row = normalizeObject(info.rankByGame[key]);
    const normalized = buildDefaultTempleGameEntry(gameId);
    normalized.bestScore = Math.max(0, toSafeInt(row.bestScore, toSafeInt(row.score, 0)));
    normalized.lastScore = Math.max(0, toSafeInt(row.lastScore, normalized.bestScore));
    normalized.playCount = Math.max(0, toSafeInt(row.playCount, 0));
    normalized.lastLevel = Math.max(0, toSafeInt(row.lastLevel, 0));
    normalized.sequenceId = Math.max(0, toSafeInt(row.sequenceId, 0));
    normalized.updatedAt = Math.max(0, toSafeInt(row.updatedAt, 0));
    normalized.extra = {
      sequenceId: Math.max(0, toSafeInt(row.extra && row.extra.sequenceId, normalized.sequenceId)),
      level: Math.max(0, toSafeInt(row.extra && row.extra.level, normalized.lastLevel)),
      state: Math.max(0, toSafeInt(row.extra && row.extra.state, 0)),
      canPlay: toSafeInt(row.extra && row.extra.canPlay, 1) > 0 ? 1 : 0,
      sync: Math.max(0, toSafeInt(row.extra && row.extra.sync, 0)),
    };
    info.rankByGame[String(gameId)] = normalized;
  });

  info.eventState = normalizeObject(info.eventState);
  info.partStatusMap = normalizeObject(info.partStatusMap);
  info.partInfoMap = normalizeObject(info.partInfoMap);

  const partIds = getTemplePartIds();
  for (const id of partIds) {
    ensureTemplePartStatus(info, player, id);
    ensureTemplePartInfo(info, id);
  }
  info._lingyunChanged = settleTempleLingyun(info, player);
  syncTempleMiniGamePartInfo(info);

  return info;
}

function buildTempleAllStatus(info, player = {}) {
  const activePartId = getTempleRotatingPartId(info, player);
  return getTemplePartIds().map((id) => {
    const status = ensureTemplePartStatus(info, player, id);
    if (id === 1) {
      const openTime = Date.now();
      const nextRecoverTime = Math.max(0, toSafeInt(info.lingyunNextRecoverTime, 0));
      status.score = Math.max(0, toSafeInt(info.lingyunCount, 0));
      status.openTime = openTime;
      status.endTime = nextRecoverTime > 0 ? nextRecoverTime : openTime;
      status.extra = {
        ...normalizeObject(status.extra),
        count: Math.max(0, toSafeInt(info.lingyunCount, 0)),
        maxCount: TEMPLE_LINGYUN_MAX,
        nextRecoverTime,
        recoverInterval: TEMPLE_LINGYUN_RECOVER_MS,
      };
    }
    if (id === 4) {
      status.extra.showInfo = normalizeArenaShowInfo(status.extra.showInfo, player);
    }
    const baseState = Math.max(0, toSafeInt(status.state, 0));
    const isActive = id === activePartId;
    return {
      id,
      state: isActive ? Math.max(1, baseState) : baseState,
      score: Math.max(0, toSafeInt(status.score, 0)),
      openTime: Math.max(0, toSafeInt(status.openTime, 0)),
      endTime: Math.max(0, toSafeInt(status.endTime, 0)),
      extra: {
        ...normalizeObject(status.extra),
        active: isActive ? 1 : 0,
      },
    };
  });
}

function buildTempleAllInfo(info, player = {}) {
  syncTempleMiniGamePartInfo(info);
  const activePartId = getTempleRotatingPartId(info, player);
  return getTemplePartIds().map((id) => {
    const partInfo = ensureTemplePartInfo(info, id);
    if (id === 4) {
      const status = ensureTemplePartStatus(info, player, id);
      partInfo.buffId = Math.max(0, toSafeInt(status.extra.buffId, toSafeInt(partInfo.buffId, 0)));
      partInfo.playerId = status.extra.playerId == null ? '' : String(status.extra.playerId);
      const showInfo = status.extra.showInfo && typeof status.extra.showInfo === 'object'
        ? status.extra.showInfo
        : buildPlayerArenaShowInfo(player);
      partInfo.showInfo = normalizeArenaShowInfo(showInfo, player);
      status.extra.showInfo = partInfo.showInfo;
      partInfo.nextFightTime = Math.max(0, toSafeInt(status.extra.nextFightTime, toSafeInt(partInfo.nextFightTime, 0)));
      info.partInfoMap[String(id)] = partInfo;
    }
    return {
      id,
      info: {
        ...partInfo,
        active: id === activePartId ? 1 : 0,
      },
    };
  });
}

function buildSelfRankRow(player, score) {
  const roleInfo = normalizeObject(player && player.roleInfo);
  const rawPlayerId = player && (player.playerId || player.userId || '');

  return {
    dbid: String(rawPlayerId),
    level: Math.max(1, toSafeInt(player && player.level, 1)),
    avatar: Math.max(0, toSafeInt(roleInfo.avatar, toSafeInt(player && player.avatar, 0))),
    avatarUrl: player && player.avatarUrl ? String(player.avatarUrl) : '',
    avatarFrame: Math.max(0, toSafeInt(roleInfo.avatarFrame, toSafeInt(player && player.avatarFrame, 0))),
    title: Math.max(0, toSafeInt(roleInfo.title, toSafeInt(player && player.title, 0))),
    name: String((player && player.name) || 'Player'),
    kungfuId: Math.max(0, toSafeInt(roleInfo.kungfuId, 0)),
    power: Math.max(0, toSafeInt(roleInfo.power, toSafeInt(player && player.power, 0))),
    score: Math.max(0, toSafeInt(score, 0)),
  };
}

function buildRobotRankRows(gameId, baseScore, selfPower) {
  const base = Math.max(100, toSafeInt(baseScore, 0));
  const basePower = Math.max(1000, toSafeInt(selfPower, 1000));
  const scoreOffsets = [260, 120, -40, -120];
  return scoreOffsets.map((offset, index) => {
    const score = Math.max(0, base + offset + gameId * 3);
    return {
      dbid: `temple_robot_${gameId}_${index + 1}`,
      level: 40 + gameId * 2 + index,
      avatar: 1100 + gameId * 10 + index,
      avatarUrl: '',
      avatarFrame: 0,
      title: 0,
      name: `Temple NPC ${index + 1}`,
      kungfuId: 4 + (index % 3),
      power: Math.max(1000, basePower + (3 - index) * 500),
      score,
    };
  });
}

function buildTempleRankPayload(player, gameId, bestScore) {
  const self = buildSelfRankRow(player, bestScore);
  const robots = buildRobotRankRows(gameId, bestScore, self.power);
  const rankList = [self, ...robots].sort((a, b) => {
    const scoreDiff = toSafeInt(b.score, 0) - toSafeInt(a.score, 0);
    if (scoreDiff !== 0) return scoreDiff;
    return String(a.dbid).localeCompare(String(b.dbid));
  });

  const selfId = String(self.dbid);
  const rank = rankList.findIndex((row) => String(row.dbid) === selfId) + 1;

  return {
    result: 0,
    gameId,
    rank: rank > 0 ? rank : -1,
    score: Math.max(0, toSafeInt(bestScore, 0)),
    rankList,
  };
}

function buildTempleRewardInfo(rewards = []) {
  return {
    items: Array.isArray(rewards) ? rewards : [],
    equips: [],
    swords: [],
    pets: [],
    artifacts: [],
    gems: [],
    bloodline: [],
    valhalla: [],
  };
}

function buildFightVars(hpValue = 0) {
  const hp = Math.max(0, toSafeInt(hpValue, 0));
  return { 1: hp, 2: 0, 3: 0, '-1': hp };
}

function buildTempleSkillEvent(skillId, behaviorId, casterPos, targetPos, damage, targetHpAfterHit) {
  const safeDamage = Math.max(1, toSafeInt(damage, 1));
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
  return {
    typ: 1,
    i: Math.max(1, toSafeInt(skillId, 1002)),
    c: casterPos,
    t: 0,
    as: [0],
    es: [[{
      typ: 2,
      i: Math.max(1, toSafeInt(behaviorId, 10020)),
      c: casterPos,
      t: 0,
      es: [[action]],
    }]],
  };
}

function buildTempleFightEvents(seed = 0) {
  const safeSeed = Math.max(0, toSafeInt(seed, 0));
  const events = [{ typ: 0, i: 0, c: 0, t: 0, es: [] }];
  let playerHp = 100;
  let enemyHp = 100;
  const playerFinalHp = Math.max(35, 55 - (safeSeed % 12));

  for (let round = 1; round <= TEMPLE_PLAYBACK_ROUNDS; round += 1) {
    const isFinal = round === TEMPLE_PLAYBACK_ROUNDS;
    const nextPlayerHp = Math.max(playerFinalHp, Math.ceil(100 - ((100 - playerFinalHp) * round) / TEMPLE_PLAYBACK_ROUNDS));
    const nextEnemyHp = isFinal ? 0 : Math.max(1, Math.ceil(100 - (100 * round) / TEMPLE_PLAYBACK_ROUNDS));
    const enemyDamage = Math.max(1, playerHp - nextPlayerHp);
    const playerDamage = Math.max(1, enemyHp - nextEnemyHp);
    playerHp = nextPlayerHp;
    enemyHp = nextEnemyHp;

    const es = [[buildTempleSkillEvent(9001, 90010, -1, 1, enemyDamage, playerHp)]];
    es.push([buildTempleSkillEvent(1002, 10020, 1, -1, playerDamage, enemyHp)]);
    events.push({ typ: 0, i: round, c: 0, t: 0, es });
  }
  return events;
}

function buildTempleFightResult(player, enemyDbid, seed = 0) {
  const selfDbid = String((player && (player.playerId || player.userId)) || 'temple_self');
  const enemyId = String(enemyDbid || 'temple_enemy');
  const safeSeed = Math.max(0, toSafeInt(seed, 0));
  const selfEntity = {
    id: Math.max(1, toSafeInt(player && player.roleInfo && player.roleInfo.kungfuId, 4)),
    dbid: selfDbid,
    name: String((player && player.name) || 'TemplePlayer'),
    type: 1,
    side: 1,
    camp: 1,
    pos: 1,
    posIndex: 1,
    hp: 100,
    maxhp: 100,
    maxHp: 100,
    vars: buildFightVars(100),
    showInfo: buildPlayerArenaShowInfo(player),
    parts: {},
    partValues: {},
  };
  return {
    type: 9,
    win: 1,
    atkAttr: { 1: 100, 2: 25, 3: 5, 4: 120 },
    defAttr: { 1: 100, 2: 8, 3: 3, 4: 80 },
    damage: { 1: 100, '-1': 21 + (safeSeed % 15) },
    isBackFight: false,
    events: buildTempleFightEvents(safeSeed),
    entitys: [
      selfEntity,
      {
        id: 100101,
        dbid: enemyId,
        name: `TempleNPC-${safeSeed || 1}`,
        type: 2,
        side: 2,
        camp: 2,
        pos: -1,
        posIndex: -1,
        hp: 100,
        maxhp: 100,
        maxHp: 100,
        vars: buildFightVars(100),
        parts: {},
        partValues: {},
      },
    ],
    guildBossAllDamage: 0,
    bloodlineOffset: 0,
  };
}

function extractMiniGameScore(params = {}) {
  const directScore = toSafeInt(params.score, -1);
  if (directScore >= 0) return directScore;

  const payloadCandidates = [
    params.woodProgress,
    params.flappyManProgress,
    params.goldenMinerProgress,
    params.searchTreasureProgress,
    params.synthTowerProgress,
  ];
  for (const payload of payloadCandidates) {
    if (!payload || typeof payload !== 'object') continue;
    if (toSafeInt(payload.score, -1) >= 0) return Math.max(0, toSafeInt(payload.score, 0));
    if (toSafeInt(payload.round, -1) >= 0) return Math.max(0, toSafeInt(payload.round, 0));
    if (toSafeInt(payload.piece, -1) >= 0) return Math.max(0, toSafeInt(payload.piece, 0));
  }

  return 0;
}

function mergeMiniGameExtra(entry, params = {}, fallbackLevel = 0) {
  const oldExtra = normalizeObject(entry.extra);
  const nextExtra = {
    sequenceId: Math.max(0, toSafeInt(params.sequenceId, toSafeInt(oldExtra.sequenceId, toSafeInt(entry.sequenceId, 0)))),
    level: Math.max(0, toSafeInt(params.level, toSafeInt(oldExtra.level, fallbackLevel))),
    state: Math.max(0, toSafeInt(oldExtra.state, 0)),
    canPlay: toSafeInt(oldExtra.canPlay, 1) > 0 ? 1 : 0,
    sync: Math.max(0, toSafeInt(oldExtra.sync, 0)),
  };

  const candidates = [
    params.woodProgress,
    params.flappyManProgress,
    params.goldenMinerProgress,
    params.searchTreasureProgress,
    params.synthTowerProgress,
  ];
  for (const payload of candidates) {
    if (!payload || typeof payload !== 'object') continue;
    if (payload.state != null) nextExtra.state = Math.max(0, toSafeInt(payload.state, nextExtra.state));
    if (payload.canPlay != null) nextExtra.canPlay = toSafeInt(payload.canPlay, nextExtra.canPlay) > 0 ? 1 : 0;
    if (payload.sync != null) nextExtra.sync = Math.max(0, toSafeInt(payload.sync, nextExtra.sync));
    if (payload.sequenceId != null) nextExtra.sequenceId = Math.max(0, toSafeInt(payload.sequenceId, nextExtra.sequenceId));
    if (payload.level != null) nextExtra.level = Math.max(0, toSafeInt(payload.level, nextExtra.level));
  }

  if (params.param != null) nextExtra.param = Math.max(0, toSafeInt(params.param, 0));
  if (params.force != null) nextExtra.force = toSafeInt(params.force, 0) > 0 ? 1 : 0;
  return nextExtra;
}

async function persistPlayer(session, player) {
  if (!session || !session.userId) return;
  const saved = await playerService.savePlayer(session.userId, player);
  if (saved && typeof saved === 'object') {
    session.player = saved;
  }
}

async function handleTempleRankInfo(params = {}, session = {}, msgUid) {
  const player = session && session.player;
  if (!player) {
    return {
      tag: 5400,
      msgUid,
      data: {
        result: 0,
        gameId: pickTempleGameId(params && params.gameId),
        rank: -1,
        score: 0,
        rankList: [],
      },
    };
  }

  const gameId = pickTempleGameId(params && params.gameId);
  const info = ensureTempleInfo(player);
  const entry = ensureTempleGameEntry(info, gameId);
  entry.gameId = gameId;

  const payload = buildTempleRankPayload(player, gameId, entry.bestScore);
  entry.updatedAt = Date.now();
  syncTempleMiniGamePartInfo(info);
  await persistPlayer(session, player);

  return withTempleLingyunSync(player, {
    tag: 5400,
    msgUid,
    data: payload,
  }, !!info._lingyunChanged);
}

async function handleTempleMiniGameStart(params = {}, session = {}, msgUid) {
  const player = session && session.player;
  const gameId = pickTempleGameId(params && params.gameId);
  const level = Math.max(0, toSafeInt(params && params.level, 0));
  if (!player) {
    return {
      tag: 5420,
      msgUid,
      data: {
        result: -1,
        gameId,
        level,
        extra: {},
        rewards: [],
        rewardInfo: buildTempleRewardInfo([]),
      },
    };
  }

  const info = ensureTempleInfo(player);
  const entry = ensureTempleGameEntry(info, gameId);
  const now = Date.now();
  const lingyunCount = getPlayerItemCount(player, TEMPLE_LINGYUN_ITEM_ID);

  if (lingyunCount <= 0) {
    entry.extra = {
      ...mergeMiniGameExtra(entry, params, level),
      canPlay: 0,
      nextRecoverTime: Math.max(0, toSafeInt(info.lingyunNextRecoverTime, 0)),
      maxCount: TEMPLE_LINGYUN_MAX,
    };
    syncTempleMiniGamePartInfo(info);
    await persistPlayer(session, player);
    return withTempleLingyunSync(player, {
      tag: 5420,
      msgUid,
      data: {
        result: 1,
        gameId,
        level,
        extra: entry.extra,
        rewards: [],
        rewardInfo: buildTempleRewardInfo([]),
      },
    }, !!info._lingyunChanged);
  }

  setPlayerItemCount(player, TEMPLE_LINGYUN_ITEM_ID, lingyunCount - 1);
  info.lingyunCount = lingyunCount - 1;
  info.lingyun.count = info.lingyunCount;
  if (info.lingyunCount < TEMPLE_LINGYUN_MAX && Math.max(0, toSafeInt(info.lingyun.nextRecoverTime, 0)) <= 0) {
    info.lingyun.nextRecoverTime = now + TEMPLE_LINGYUN_RECOVER_MS;
    info.lingyunNextRecoverTime = info.lingyun.nextRecoverTime;
  }

  entry.gameId = gameId;
  entry.playCount = Math.max(0, toSafeInt(entry.playCount, 0)) + 1;
  entry.lastLevel = Math.max(0, level);
  entry.sequenceId = Math.max(0, toSafeInt(entry.sequenceId, 0)) + 1;
  entry.updatedAt = Date.now();
  entry.extra = {
    sequenceId: entry.sequenceId,
    level,
    state: 0,
    canPlay: Math.max(0, toSafeInt(info.lingyunCount, 0)),
    sync: 0,
    param: Math.max(0, toSafeInt(params.param, 0)),
    nextRecoverTime: Math.max(0, toSafeInt(info.lingyunNextRecoverTime, 0)),
    maxCount: TEMPLE_LINGYUN_MAX,
    };

  // Scheduled rank prizes are not per-start rewards.
  const rewards = [];
  syncTempleMiniGamePartInfo(info);
  refreshMainTaskProgress(player);
  await persistPlayer(session, player);

  return withTempleLingyunSync(player, {
    tag: 5420,
    msgUid,
    data: {
      result: 0,
      gameId,
      level,
      extra: entry.extra,
      rewards,
      rewardInfo: buildTempleRewardInfo(rewards),
    },
  }, true);
}

async function handleTempleMiniGameProgress(params = {}, session = {}, msgUid) {
  const player = session && session.player;
  const gameId = pickTempleGameId(params && params.gameId);
  const level = Math.max(0, toSafeInt(params && params.level, 0));
  if (!player) {
    return {
      tag: 5421,
      msgUid,
      data: {
        result: -1,
        gameId,
        level,
        score: 0,
        extra: {},
        rewards: [],
        rewardInfo: buildTempleRewardInfo([]),
      },
    };
  }

  const info = ensureTempleInfo(player);
  const entry = ensureTempleGameEntry(info, gameId);

  const score = extractMiniGameScore(params);
  entry.gameId = gameId;
  entry.lastLevel = Math.max(entry.lastLevel, level);
  entry.lastScore = Math.max(0, score);
  entry.bestScore = Math.max(0, toSafeInt(entry.bestScore, 0), entry.lastScore);
  entry.updatedAt = Date.now();
  entry.extra = mergeMiniGameExtra(entry, params, level);
  entry.sequenceId = Math.max(entry.sequenceId, toSafeInt(entry.extra.sequenceId, entry.sequenceId));

  syncTempleMiniGamePartInfo(info);
  await persistPlayer(session, player);

  return withTempleLingyunSync(player, {
    tag: 5421,
    msgUid,
    data: {
      result: 0,
      gameId,
      level,
      score: entry.lastScore,
      extra: entry.extra,
      rewards: [],
      rewardInfo: buildTempleRewardInfo([]),
    },
  }, !!info._lingyunChanged);
}

async function handleTempleMiniGameEnd(params = {}, session = {}, msgUid) {
  const player = session && session.player;
  const gameId = pickTempleGameId(params && params.gameId);
  const level = Math.max(0, toSafeInt(params && params.level, 0));
  if (!player) {
    return {
      tag: 5422,
      msgUid,
      data: {
        result: -1,
        gameId,
        level,
        rank: -1,
        score: 0,
        rewards: [],
        rewardInfo: buildTempleRewardInfo([]),
        extra: {},
      },
    };
  }

  const score = Math.max(0, toSafeInt(params.score, extractMiniGameScore(params)));
  const force = toSafeInt(params.force, 0) > 0 ? 1 : 0;

  const info = ensureTempleInfo(player);
  const entry = ensureTempleGameEntry(info, gameId);
  entry.gameId = gameId;
  entry.lastLevel = Math.max(entry.lastLevel, level);
  entry.lastScore = score;
  entry.bestScore = Math.max(0, toSafeInt(entry.bestScore, 0), score);
  entry.sequenceId = Math.max(0, toSafeInt(params.sequenceId, entry.sequenceId));
  entry.extra = mergeMiniGameExtra(entry, params, level);
  entry.extra.state = force > 0 ? 2 : 1;
  entry.updatedAt = Date.now();

  const rankPayload = buildTempleRankPayload(player, gameId, entry.bestScore);
  // TempleGameRankConfig is settled separately; do not fabricate run-end rewards.
  const rewards = [];
  syncTempleMiniGamePartInfo(info);
  await persistPlayer(session, player);

  return withTempleLingyunSync(player, {
    tag: 5422,
    msgUid,
    data: {
      result: 0,
      gameId,
      level,
      score,
      rank: rankPayload.rank,
      rewards,
      rewardInfo: buildTempleRewardInfo(rewards),
      extra: entry.extra,
    },
  }, !!info._lingyunChanged);
}

async function handleTempleEventOperate(params = {}, session = {}, msgUid) {
  const player = session && session.player;
  const id = pickTemplePartId(params && params.id);
  const operate = Math.max(0, toSafeInt(params && params.operate, 0));
  const value = Math.max(0, toSafeInt(params && params.value, 0));
  const param = Math.max(0, toSafeInt(params && params.param, 0));
  const strParam = params && params.strParam != null ? String(params.strParam) : '';
  if (!player) {
    return {
      tag: 5450,
      msgUid,
      data: {
        result: -1,
        id,
        operate,
        value,
        param,
        strParam,
        rewards: [],
        rewardInfo: buildTempleRewardInfo([]),
        extra: {},
      },
    };
  }

  const info = ensureTempleInfo(player);

  const key = `${id}:${operate}`;
  const row = normalizeObject(info.eventState[key]);
  row.id = id;
  row.operate = operate;
  row.value = value;
  row.param = param;
  row.strParam = strParam;
  row.times = Math.max(0, toSafeInt(row.times, 0)) + 1;
  row.updatedAt = Date.now();
  info.eventState[key] = row;

  const status = ensureTemplePartStatus(info, player, id);
  const partInfo = ensureTemplePartInfo(info, id);
  let rewards = [];
  let result = 0;
  let extra = {};
  const pushPackets = [];

  if (id === 2) {
    if (operate === 1) {
      partInfo.randomRewardCount = Math.max(0, toSafeInt(partInfo.randomRewardCount, 0)) + 1;
    }
    if (operate === 0) {
      const tasks = ensureArray(partInfo.taskInfos);
      if (tasks.length === 0) {
        partInfo.taskInfos = buildTempleTaskInfos();
      }
      const qaTask = ensureArray(partInfo.taskInfos).find((taskRow) => taskRow && Array.isArray(taskRow.records));
      if (qaTask) {
        qaTask.records = ensureArray(qaTask.records);
        const previousProgress = Math.max(0, toSafeInt(qaTask.progress, 0));
        const previousRecordCount = qaTask.records.length;
        if (value > 0 && !qaTask.records.includes(value)) {
          qaTask.records.push(value);
        }
        qaTask.progress = Math.max(toSafeInt(qaTask.progress, 0), qaTask.records.length);
        if (qaTask.progress !== previousProgress || qaTask.records.length !== previousRecordCount) {
          const taskIndex = ensureArray(partInfo.taskInfos).indexOf(qaTask);
          pushPackets.push({
            tag: 5402,
            msgUid: 0,
            data: {
              index: Math.max(0, taskIndex),
              rewards: buildTempleRewardInfo([]),
              taskInfo: normalizeObject(qaTask),
            },
          });
        }
      }
    }
  }

  if (id === 3 || id === 6) {
    const baseCfg = normalizeObject(config.get('TempleBaseConfig'));
    const currentCount = Math.max(0, toSafeInt(partInfo.fireworkCount, 0));
    const freeCount = id === 6
      ? Math.max(0, toSafeInt(baseCfg.festivalFreeFireworkNum, 0))
      : Math.max(0, toSafeInt(baseCfg.freeFireworkNum, 0));
    const rawCost = id === 6 ? baseCfg.festivalFireworkCost : [baseCfg.extraFireworkCost];
    if (currentCount >= freeCount && !consumeTempleCosts(player, rawCost)) {
      result = 1;
    } else {
      partInfo.fireworkCount = currentCount + 1;
      if (id === 6) rewards = grantTempleRewards(player, baseCfg.festivalFireworkRewards);
      // The client uses this push to render another player's firework. The
      // request itself already drives the local player's own animation.
      pushPackets.push({
        tag: 5404,
        msgUid: 0,
        data: {
          index: param,
          type: id === 6 ? 1 : 0,
        },
      });
    }
  }

  if (id === 7 && value > 0) {
    partInfo.gifts = ensureArray(partInfo.gifts);
    const baseCfg = normalizeObject(config.get('TempleBaseConfig'));
    const giftMax = Math.max(0, toSafeInt(baseCfg.festivalGiftNum, 0));
    if (partInfo.gifts.includes(value) || (giftMax > 0 && partInfo.gifts.length >= giftMax)) {
      result = 1;
    } else {
      partInfo.gifts.push(value);
      rewards = grantTempleRewards(player, baseCfg.festivalGiftContent);
    }
  }

  if (id === 4 && operate === 0) {
    status.extra.buffId = pickTempleFightGuildBuffId(value || status.extra.buffId);
    status.extra.playerId = String(player.playerId || player.userId || '');
    status.extra.showInfo = buildPlayerArenaShowInfo(player);
    const baseCfg = normalizeObject(config.get('TempleBaseConfig'));
    status.extra.nextFightTime = Date.now() + Math.max(0, toSafeInt(baseCfg.fightCD, 0)) * 1000;
    partInfo.buffId = status.extra.buffId;
    partInfo.playerId = status.extra.playerId;
    partInfo.showInfo = status.extra.showInfo;
    partInfo.nextFightTime = status.extra.nextFightTime;
    extra = {
      buffId: status.extra.buffId,
      playerId: status.extra.playerId,
      arenaPlayerId: status.extra.playerId,
      showInfo: status.extra.showInfo,
      nextFightTime: status.extra.nextFightTime,
      fightResult: buildTempleFightResult(player, status.extra.playerId, status.extra.buffId),
    };
    pushPackets.push({
      tag: 5410,
      msgUid: 0,
      data: {
        buffId: status.extra.buffId,
        playerId: status.extra.playerId,
        showInfo: status.extra.showInfo,
        nextFightTime: status.extra.nextFightTime,
      },
    });
    const guildBuffTime = Math.max(0, toSafeInt(status.endTime, 0));
    if (status.extra.buffId > 0 && guildBuffTime > Date.now()) {
      const guild = require('./guild');
      const guildPush = await guild.applyTempleBuffToGuild(
        session,
        status.extra.buffId,
        guildBuffTime,
      );
      if (guildPush) pushPackets.push(guildPush);
    }
  }

  if (id === 5) {
    status.extra.count = Math.max(0, toSafeInt(status.extra.count, 0));
    status.extra.robotId = Math.max(1, toSafeInt(status.extra.robotId, 1));

    if (operate === 0) {
      extra = { count: status.extra.count };
    } else if (operate === 1) {
      const guessCfgMap = normalizeObject(config.get('TempleGuessConfig'));
      const guessId = Math.max(1, toSafeInt(param, 1));
      const guessCfg = normalizeObject(guessCfgMap[String(guessId)]);
      if (Object.keys(guessCfg).length <= 0 || !consumeTempleCosts(player, guessCfg.cost)) {
        result = 1;
      } else {
        status.extra.count += normalizeRewardRows(guessCfg.cost).reduce((sum, row) => sum + row.count, 0);
        partInfo.guessId = guessId;
        partInfo.side = Math.max(0, Math.min(1, value));
        extra = {
          count: status.extra.count,
          index: partInfo.guessId,
          side: partInfo.side,
        };
      }
    } else if (operate === 2) {
      partInfo.guessId = Math.max(1, toSafeInt(partInfo.guessId, 1));
      partInfo.round = Math.max(0, toSafeInt(partInfo.round, 0)) + 1;
      if (partInfo.side !== 0 && partInfo.side !== 1) {
        partInfo.side = status.extra.count % 2;
      }
      const winningSide = (status.extra.robotId + partInfo.guessId + partInfo.round) % 2;
      status.extra.fightResult = partInfo.side === winningSide ? 1 : 0;
      status.extra.localState = 1;
      const guessCfgMap = normalizeObject(config.get('TempleGuessConfig'));
      const guessCfg = normalizeObject(guessCfgMap[String(partInfo.guessId)]);
      rewards = grantTempleRewards(
        player,
        status.extra.fightResult === 1 ? guessCfg.successRewards : guessCfg.failRewards,
      );
      const enemyDbid = `temple_robot_${status.extra.robotId}_${partInfo.guessId}`;
      extra = {
        count: status.extra.count,
        index: partInfo.guessId,
        side: partInfo.side,
        round: partInfo.round,
        robotId: status.extra.robotId,
        fightResult: buildTempleFightResult(player, enemyDbid, partInfo.guessId),
      };
    }
  }

  syncTempleMiniGamePartInfo(info);
  await persistPlayer(session, player);

  const payload = {
    result,
    id,
    operate,
    value,
    param,
    strParam,
    rewards,
    rewardInfo: buildTempleRewardInfo(rewards),
  };

  payload.extra = normalizeObject(extra);

  const response = withTempleLingyunSync(player, {
    tag: 5450,
    msgUid,
    data: payload,
  }, !!info._lingyunChanged);
  return Array.isArray(response) ? [...response, ...pushPackets] : [response, ...pushPackets];
}

async function handleTempleAllStage(_params = {}, session = {}, msgUid) {
  const player = session && session.player;
  if (!player) {
    return {
      tag: 5451,
      msgUid,
      data: {
        allStatus: [],
      },
    };
  }

  const info = ensureTempleInfo(player);
  const allStatus = buildTempleAllStatus(info, player);
  await persistPlayer(session, player);

  return withTempleLingyunSync(player, {
    tag: 5451,
    msgUid,
    data: {
      allStatus,
    },
  }, !!info._lingyunChanged);
}

async function handleTempleSubInfo(params = {}, session = {}, msgUid) {
  const player = session && session.player;
  const id = pickTemplePartId(params && params.id);

  if (!player) {
    return {
      tag: 5452,
      msgUid,
      data: {
        result: -1,
        id,
        info: buildDefaultTemplePartInfo(id),
      },
    };
  }

  const info = ensureTempleInfo(player);
  if (id === 1) {
    syncTempleMiniGamePartInfo(info);
  }
  const partInfo = ensureTemplePartInfo(info, id);
  await persistPlayer(session, player);

  return withTempleLingyunSync(player, {
    tag: 5452,
    msgUid,
    data: {
      result: 0,
      id,
      info: partInfo,
    },
  }, !!info._lingyunChanged);
}

async function handleTempleAllInfo(_params = {}, session = {}, msgUid) {
  const player = session && session.player;
  if (!player) {
    return {
      tag: 5453,
      msgUid,
      data: {
        allInfo: [],
      },
    };
  }

  const info = ensureTempleInfo(player);
  const allInfo = buildTempleAllInfo(info, player);
  await persistPlayer(session, player);

  return withTempleLingyunSync(player, {
    tag: 5453,
    msgUid,
    data: {
      allInfo,
    },
  }, !!info._lingyunChanged);
}

async function handleTempleGetAllMiniGameInfo(_params = {}, session = {}, msgUid) {
  const player = session && session.player;
  if (!player) {
    return {
      tag: 5460,
      msgUid,
      data: { result: -1, allStatus: [], allInfo: [], inGame: 0, gameInfo: { playData: [] } },
    };
  }

  const info = ensureTempleInfo(player);
  const allStatus = buildTempleAllStatus(info, player);
  const allInfo = buildTempleAllInfo(info, player);
  const miniInfo = normalizeObject((allInfo.find((row) => toSafeInt(row.id, 0) === 1) || {}).info);
  const gameInfo = normalizeObject(miniInfo.gameInfo);
  gameInfo.playData = ensureArray(gameInfo.playData);
  await persistPlayer(session, player);

  return withTempleLingyunSync(player, {
    tag: 5460,
    msgUid,
    data: {
      result: 0,
      inGame: 0,
      allStatus,
      allInfo,
      gameInfo,
    },
  }, !!info._lingyunChanged);
}

module.exports = {
  ensureTempleInfo,
  buildTempleAllStatus,
  buildTempleAllInfo,
  buildTempleLingyunTimeRecords,
  handleTempleRankInfo,
  handleTempleMiniGameStart,
  handleTempleMiniGameProgress,
  handleTempleMiniGameEnd,
  handleTempleEventOperate,
  handleTempleAllStage,
  handleTempleSubInfo,
  handleTempleAllInfo,
  handleTempleGetAllMiniGameInfo,
};
