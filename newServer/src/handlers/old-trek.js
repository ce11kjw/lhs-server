const playerService = require('../services/PlayerService');
const configService = require('../services/ConfigService');
const { addRewardToPlayer } = require('./raid');

const FALLBACK_SAILOR_IDS = [340101, 340102, 340103];
const DEFAULT_SHIP_SKIN = 300001;

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensureObject(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...fallback };
  return value;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function getCurrencyKeyById(itemId) {
  switch (toSafeInt(itemId, 0)) {
    case 1: return 'diamond';
    case 2: return 'silver';
    case 6: return 'gold';
    default: return null;
  }
}

function getItemCount(player, itemId) {
  const id = Math.max(0, toSafeInt(itemId, 0));
  if (id <= 0) return 0;
  const currencyKey = getCurrencyKeyById(id);
  if (currencyKey) {
    return Math.max(0, toSafeInt(player && player.currencies && player.currencies[currencyKey], 0));
  }
  return Math.max(0, toSafeInt(player && player.items && player.items[id], 0));
}

function normalizeItemRows(rows) {
  const merged = new Map();
  ensureArray(rows).forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id > 0 && count > 0) merged.set(id, (merged.get(id) || 0) + count);
  });
  return Array.from(merged.entries()).map(([id, count]) => ({ id, count }));
}

function canConsumeItems(player, rows) {
  return normalizeItemRows(rows).every((row) => getItemCount(player, row.id) >= row.count);
}

function consumeItems(player, rows) {
  const costs = normalizeItemRows(rows);
  if (!canConsumeItems(player, costs)) return false;
  player.currencies = ensureObject(player.currencies, { gold: 0, diamond: 0, silver: 0 });
  player.items = ensureObject(player.items);
  costs.forEach((row) => {
    const currencyKey = getCurrencyKeyById(row.id);
    if (currencyKey) {
      player.currencies[currencyKey] = Math.max(0, getItemCount(player, row.id) - row.count);
    } else {
      const left = Math.max(0, getItemCount(player, row.id) - row.count);
      if (left > 0) player.items[row.id] = left;
      else delete player.items[row.id];
    }
  });
  return true;
}

function buildRewardInfo(items = []) {
  return {
    items: normalizeItemRows(items),
    equips: [],
    heros: [],
    sailor: [],
    fashion: [],
  };
}

function getDefaultSailorIds(limit = 3) {
  const sailorConfig = ensureObject(configService.get('OldTrekSailorConfig'));
  const configured = Object.keys(sailorConfig)
    .map((key) => Math.max(0, toSafeInt(sailorConfig[key] && sailorConfig[key].id, toSafeInt(key, 0))))
    .filter((id, index, rows) => id > 0 && rows.indexOf(id) === index)
    .sort((a, b) => a - b)
    .slice(0, Math.max(1, toSafeInt(limit, 3)));
  return configured.length > 0 ? configured : FALLBACK_SAILOR_IDS.slice(0, limit);
}

function normalizeSailorId(id, fallbackId) {
  const safeId = Math.max(0, toSafeInt(id, 0));
  const sailorConfig = ensureObject(configService.get('OldTrekSailorConfig'));
  if (safeId > 0 && sailorConfig[String(safeId)]) return safeId;
  const defaults = getDefaultSailorIds();
  const safeFallback = Math.max(0, toSafeInt(fallbackId, defaults[0]));
  return sailorConfig[String(safeFallback)] ? safeFallback : defaults[0];
}

function buildSailor(id, overrides = {}, fallbackId) {
  const sailorId = normalizeSailorId(id, fallbackId);
  const source = ensureObject(overrides);
  const sailorConfig = ensureObject(configService.get('OldTrekSailorConfig'));
  const sailorRow = ensureObject(sailorConfig[sailorId] || sailorConfig[String(sailorId)]);
  const task = ensureObject(source.task);
  for (let taskType = 1; taskType <= 5; taskType += 1) {
    task[taskType] = Math.max(0, toSafeInt(task[taskType], 0));
  }
  return {
    id: sailorId,
    star: Math.max(0, toSafeInt(source.star, toSafeInt(sailorRow.minStar, 0))),
    dim: ensureObject(source.dim, ensureObject(sailorRow.baseDimAttrs)),
    nextDim: ensureObject(source.nextDim),
    recruitDate: Math.max(0, toSafeInt(source.recruitDate, Date.now())),
    task,
  };
}

function buildLineData(id = 0) {
  return { id, leader: -1, skill: -1, slots: [0, 0, 0, 0] };
}

function normalizeLineData(row, id = 0) {
  const source = ensureObject(row);
  const slots = ensureArray(source.slots)
    .slice(0, 4)
    .map((sailorId) => Math.max(0, toSafeInt(sailorId, 0)));
  while (slots.length < 4) slots.push(0);
  return {
    ...source,
    id: Math.max(0, toSafeInt(source.id, id)),
    leader: toSafeInt(source.leader, -1),
    skill: toSafeInt(source.skill, -1),
    slots,
  };
}

function normalizeSetLines(rows) {
  const source = ensureArray(rows);
  const result = [];
  for (let lineId = 0; lineId < 3; lineId += 1) {
    const row = source.find((item) => toSafeInt(item && item.id, -1) === lineId);
    result.push(normalizeLineData(row || buildLineData(lineId), lineId));
  }
  return result;
}

function ensureSetLines(info, setId) {
  const safeSetId = Math.max(0, toSafeInt(setId, 0));
  info.setMap = ensureObject(info.setMap);
  const key = String(safeSetId);
  info.setMap[key] = normalizeSetLines(info.setMap[key]);
  return info.setMap[key];
}

function syncLegacySetInfo(info) {
  info.setInfo = ensureSetLines(info, info.sailSetId);
}

function normalizeSailorSlots(slots) {
  const rows = ensureArray(slots);
  const out = [];
  for (let i = 0; i < 4; i += 1) {
    const row = ensureObject(rows[i]);
    out.push({
      slot: i,
      sailorId: Math.max(0, toSafeInt(row.sailorId, 0)),
      level: Math.max(1, toSafeInt(row.level, 1)),
    });
  }
  return out;
}

function normalizeDestRecords(value) {
  const source = Array.isArray(value)
    ? value
    : Object.keys(ensureObject(value)).map((key) => {
      const row = ensureObject(value[key]);
      return { ...row, id: Math.max(0, toSafeInt(row.id, toSafeInt(key, 0))) };
    });
  return source
    .map((value) => {
      const row = ensureObject(value);
      return {
        ...row,
        id: Math.max(0, toSafeInt(row.id, 0)),
        taskClaimed: ensureArray(row.taskClaimed)
          .map((id) => Math.max(0, toSafeInt(id, 0)))
          .filter((id, index, rows) => id > 0 && rows.indexOf(id) === index),
        rewardClaimed: ensureArray(row.rewardClaimed)
          .map((id) => Math.max(0, toSafeInt(id, 0)))
          .filter((id, index, rows) => id > 0 && rows.indexOf(id) === index),
      };
    })
    .filter((row, index, rows) => row.id > 0 && rows.findIndex((candidate) => candidate.id === row.id) === index);
}

function ensureDestRecord(info, destId) {
  const id = Math.max(1, toSafeInt(destId, 1));
  let dest = info.dest.find((row) => row.id === id);
  if (!dest) {
    dest = { id, taskClaimed: [], rewardClaimed: [] };
    info.dest.push(dest);
  }
  dest.taskClaimed = ensureArray(dest.taskClaimed);
  dest.rewardClaimed = ensureArray(dest.rewardClaimed);
  return dest;
}

function getTaskDestination(taskId) {
  const id = Math.max(1, toSafeInt(taskId, 1));
  const taskConfig = ensureObject(configService.get('OldTrekTaskConfig'));
  const row = ensureObject(taskConfig[id] || taskConfig[String(id)]);
  return Math.max(1, toSafeInt(row.destination, id));
}

function getConfigRow(tableName, id) {
  const table = ensureObject(configService.get(tableName));
  return ensureObject(table[id] || table[String(id)]);
}

function getDestinationConfig(destId, difficulty = 1) {
  const destinations = ensureObject(configService.get('OldTrekDestinationConfig'));
  const group = ensureObject(destinations[destId] || destinations[String(destId)]);
  return ensureObject(group[difficulty] || group[String(difficulty)]);
}

function buildTrekUpdate(trekData = {}) {
  const source = ensureObject(trekData);
  return {
    uid: Math.max(1, toSafeInt(source.uid, 1)),
    dist: Math.max(0, Number(source.dist) || 0),
    lastUpdateTime: Math.max(0, toSafeInt(source.lastUpdateTime, Date.now())),
    stable: Math.max(0, toSafeInt(source.stable, 0)),
  };
}

function ensureSailInfo(info) {
  info.sailInfo = ensureObject(info.sailInfo);
  const sailInfo = info.sailInfo;
  sailInfo.trekData = sailInfo.trekData && typeof sailInfo.trekData === 'object'
    ? ensureObject(sailInfo.trekData)
    : null;
  if (sailInfo.trekData) {
    const cfg = getDestinationConfig(sailInfo.trekData.id, sailInfo.trekData.diff);
    sailInfo.trekData = {
      ...sailInfo.trekData,
      ...buildTrekUpdate(sailInfo.trekData),
      id: Math.max(1, toSafeInt(sailInfo.trekData.id, 1)),
      diff: Math.max(1, toSafeInt(sailInfo.trekData.diff, 1)),
      stableMax: Math.max(1, toSafeInt(sailInfo.trekData.stableMax, toSafeInt(configService.get('OldTrekBaseConfig') && configService.get('OldTrekBaseConfig').baseStable, 100))),
      roundScore: Math.max(0, toSafeInt(sailInfo.trekData.roundScore, toSafeInt(cfg.baseSettleScore, 0))),
    };
  }
  sailInfo.currentEvent = sailInfo.currentEvent && typeof sailInfo.currentEvent === 'object'
    ? ensureObject(sailInfo.currentEvent)
    : null;
  sailInfo.cabin = ensureArray(sailInfo.cabin).map((row) => ensureObject(row));
  sailInfo.eventLogs = ensureArray(sailInfo.eventLogs).map((row) => ensureObject(row));
  sailInfo.effects = ensureArray(sailInfo.effects).map((row) => ensureObject(row));
  sailInfo.multi = Math.max(1, toSafeInt(sailInfo.multi, 1));
  const offlineCache = ensureObject(sailInfo.offlineCache);
  sailInfo.offlineCache = {
    reward: ensureArray(offlineCache.reward),
    event: ensureObject(offlineCache.event),
    lose: ensureArray(offlineCache.lose),
    robCount: Math.max(0, toSafeInt(offlineCache.robCount, 0)),
    stable: Math.max(0, toSafeInt(offlineCache.stable, 0)),
  };
  return sailInfo;
}

function startSailing(info, destId, difficulty) {
  const id = Math.max(1, toSafeInt(destId, 1));
  const diff = Math.max(1, toSafeInt(difficulty, 1));
  const cfg = getDestinationConfig(id, diff);
  if (toSafeInt(cfg.id, 0) <= 0) return null;
  const base = ensureObject(configService.get('OldTrekBaseConfig'));
  const sailInfo = ensureSailInfo(info);
  sailInfo.trekData = {
    uid: Math.max(1, toSafeInt(info.nextTrekUid, Date.now())),
    id,
    diff,
    dist: 0,
    lastUpdateTime: Date.now(),
    stable: Math.max(1, toSafeInt(base.baseStable, 100)),
    stableMax: Math.max(1, toSafeInt(base.baseStable, 100)),
    roundScore: Math.max(0, toSafeInt(cfg.baseSettleScore, 0)),
  };
  info.nextTrekUid = sailInfo.trekData.uid + 1;
  sailInfo.currentEvent = null;
  sailInfo.cabin = [];
  sailInfo.eventLogs = [];
  sailInfo.effects = [];
  info.sailing = true;
  return sailInfo;
}

function getSailorConfig(id) {
  return getConfigRow('OldTrekSailorConfig', id);
}

function getSailorStarConfig(sailorId, star) {
  const sailor = getSailorConfig(sailorId);
  const starTable = ensureObject(configService.get('OldTrekSailorStarUpConfig'));
  const qualityTable = ensureObject(starTable[sailor.quality] || starTable[String(sailor.quality)]);
  return ensureObject(qualityTable[star] || qualityTable[String(star)]);
}

function getSailorStarCost(sailorId, star) {
  const sailor = getSailorConfig(sailorId);
  const element = getConfigRow('OldTrekSailorElementConfig', sailor.recruitElement);
  const starCosts = ensureObject(element.starCosts);
  const itemId = Math.max(0, toSafeInt(starCosts[sailor.quality] || starCosts[String(sailor.quality)], 0));
  const starRow = getSailorStarConfig(sailorId, star);
  const count = Math.max(0, toSafeInt(starRow.starCosts, 0));
  return itemId > 0 && count > 0 ? [{ id: itemId, count }] : [];
}

function taskRecordValue(info, taskRow) {
  const destination = Math.max(0, toSafeInt(taskRow.destination, 0));
  const type = Math.max(0, toSafeInt(taskRow.type, 0));
  const value2 = Math.max(0, toSafeInt(taskRow.taskValue2, 0));
  const keys = [
    10000 * value2 + 100 * destination + type,
    10000 * value2 + type,
    100 * destination + type,
    type,
  ];
  return keys.reduce((max, key) => Math.max(max, toSafeInt(info.taskRecord[key], 0)), 0);
}

function taskRowsForDestination(destId) {
  const destination = Math.max(1, toSafeInt(destId, 1));
  const table = ensureObject(configService.get('OldTrekTaskConfig'));
  return Object.keys(table)
    .map((key) => ensureObject(table[key]))
    .filter((row) => toSafeInt(row.destination, 0) === destination && toSafeInt(row.id, 0) > 0)
    .sort((left, right) => toSafeInt(left.id, 0) - toSafeInt(right.id, 0));
}

function calculateDestinationScore(dest, taskTable) {
  return ensureArray(dest && dest.taskClaimed).reduce((score, taskId) => {
    const row = ensureObject(taskTable[taskId] || taskTable[String(taskId)]);
    return score + Math.max(0, toSafeInt(row.score, 0));
  }, 0);
}

function normalizePlayerDbid(value, fallbackDigit = '1') {
  const source = String(value || '').replace(/[^a-zA-Z0-9]/g, '');
  if (source.length === 24) return source;
  return String(fallbackDigit || '1').slice(0, 1).padStart(24, '0');
}

function buildBattlePlayer(player = {}, dbid, name) {
  return {
    dbid: normalizePlayerDbid(dbid, name === '灵舟对手' ? '2' : '1'),
    name: String(name || player.name || 'Player'),
    avatar: Math.max(0, toSafeInt(player.avatar, 11301)),
    avatarFrame: Math.max(0, toSafeInt(player.avatarFrame, 0)),
    title: Math.max(0, toSafeInt(player.title, 0)),
    level: Math.max(1, toSafeInt(player.level, 1)),
    hp: 100,
    maxHp: 100,
    sailorIds: [],
    sailors: [],
    commonAttr: {},
    cabin: [],
    privilege: [],
    skill: 0,
  };
}

function pickRecruitSailorIds(info, count) {
  const table = ensureObject(configService.get('OldTrekSailorConfig'));
  const ids = Object.keys(table)
    .map((key) => Math.max(0, toSafeInt(table[key] && table[key].id, toSafeInt(key, 0))))
    .filter((id, index, rows) => id > 0 && rows.indexOf(id) === index)
    .sort((left, right) => left - right);
  if (ids.length <= 0) return getDefaultSailorIds(count);
  const start = Math.max(0, toSafeInt(info.refreshSerial, 0)) % ids.length;
  const selected = [];
  for (let index = 0; index < ids.length && selected.length < count; index += 1) {
    selected.push(ids[(start + index) % ids.length]);
  }
  info.refreshSerial = (start + Math.max(1, selected.length)) % ids.length;
  return selected;
}

function ensureOldTrekInfo(player = {}) {
  player.other_attr_info = ensureObject(player.other_attr_info);
  const holder = player.other_attr_info;
  holder.oldTrekInfo = ensureObject(holder.oldTrekInfo);
  const info = holder.oldTrekInfo;

  info.lv = Math.max(1, toSafeInt(info.lv, 1));
  info.exp = Math.max(0, toSafeInt(info.exp, 0));
  info.stage = Math.max(1, toSafeInt(info.stage, 1));
  info.matchId = Math.max(1, toSafeInt(info.matchId, 1));
  info.season = Math.max(1, toSafeInt(info.season, 1));
  info.totalSeason = Math.max(info.season, toSafeInt(info.totalSeason, info.season));
  info.endTime = Math.max(Date.now() + 86400000, toSafeInt(info.endTime, Date.now() + 86400000));
  info.job = Math.max(0, toSafeInt(info.job, 0));
  info.battleLogUid = Math.max(0, toSafeInt(info.battleLogUid, 0));
  info.arenaLogUid = Math.max(0, toSafeInt(info.arenaLogUid, 0));
  info.name = info.name == null || info.name === '' ? '灵舟' : String(info.name);
  info.skin = Math.max(1, toSafeInt(info.skin, DEFAULT_SHIP_SKIN));
  info.shipSkins = ensureArray(info.shipSkins).map((id) => Math.max(0, toSafeInt(id, 0))).filter((id, idx, arr) => id > 0 && arr.indexOf(id) === idx);
  if (!info.shipSkins.includes(info.skin)) info.shipSkins.unshift(info.skin);
  info.unlockTechs = ensureArray(info.unlockTechs).map((id) => Math.max(0, toSafeInt(id, 0))).filter((id) => id > 0);
  info.unlocking = ensureArray(info.unlocking).map((row) => ensureObject(row));
  info.privilegeEffect = ensureObject(info.privilegeEffect);
  const defaultSailorIds = getDefaultSailorIds();
  info.sailorList = ensureArray(info.sailorList)
    .map((row, index) => buildSailor(row && row.id, row, defaultSailorIds[index % defaultSailorIds.length]))
    .filter((row, index, rows) => rows.findIndex((candidate) => candidate.id === row.id) === index);
  info.sailorAtlas = ensureObject(info.sailorAtlas);
  info.sailorList.forEach((row) => { if (info.sailorAtlas[row.id] == null) info.sailorAtlas[row.id] = 0; });
  info.sailorSlotList = normalizeSailorSlots(info.sailorSlotList);
  const baseConfig = ensureObject(configService.get('OldTrekBaseConfig'));
  const recruitCount = Math.max(1, toSafeInt(baseConfig.recruitNum, 5));
  info.refreshId = ensureArray(info.refreshId)
    .map((id, index) => normalizeSailorId(id, defaultSailorIds[index % defaultSailorIds.length]))
    .filter((id, idx, arr) => id > 0 && arr.indexOf(id) === idx);
  getDefaultSailorIds(recruitCount).forEach((id) => {
    if (info.refreshId.length < recruitCount && !info.refreshId.includes(id)) info.refreshId.push(id);
  });
  info.rewardCache = Array.isArray(info.rewardCache) || (info.rewardCache && typeof info.rewardCache === 'object')
    ? info.rewardCache
    : [];
  info.cacheCount = Math.max(0, toSafeInt(info.cacheCount, 0));
  info.dailyFreeRefresh = Math.max(0, toSafeInt(info.dailyFreeRefresh, 0));
  info.sailorPackages = ensureArray(info.sailorPackages).map((row) => ({
    ...ensureObject(row),
    id: Math.max(0, toSafeInt(row && row.id, 0)),
    expire: Math.max(0, toSafeInt(row && row.expire, 0)),
    freeClaim: Math.max(0, toSafeInt(row && row.freeClaim, 0)),
  })).filter((row) => row.id > 0);
  info.passRecords = ensureArray(info.passRecords).map((row) => ({
    ...ensureObject(row),
    id: Math.max(0, toSafeInt(row && row.id, 0)),
    buyRecord: Math.max(1, toSafeInt(row && row.buyRecord, 1)),
    claimRecord: ensureObject(row && row.claimRecord),
  })).filter((row) => row.id > 0);
  info.destRecords = ensureArray(info.destRecords);
  info.chatList = ensureArray(info.chatList);
  info.battleLogs = ensureArray(info.battleLogs);
  info.arenaBattleLogs = ensureArray(info.arenaBattleLogs);
  info.battleRecords = ensureObject(info.battleRecords);
  info.arenaGradeReward = Math.max(0, toSafeInt(info.arenaGradeReward, 0));
  info.totalDistance = Math.max(0, toSafeInt(info.totalDistance, 0));
  info.sailSetId = Math.max(0, toSafeInt(info.sailSetId, 0));
  info.arenaSetId = Math.max(0, toSafeInt(info.arenaSetId, 0));
  info.arenaSetInfo = normalizeSetLines(info.arenaSetInfo);

  // The client reads formations exclusively from setMap[selectedSetId].
  // Migrate the old setInfo-only shape so existing player documents remain usable.
  const legacySetInfo = ensureArray(info.setInfo);
  const sourceSetMap = ensureObject(info.setMap);
  const normalizedSetMap = {};
  Object.keys(sourceSetMap).forEach((key) => {
    const setId = toSafeInt(key, -1);
    if (setId >= 0 && Array.isArray(sourceSetMap[key])) {
      normalizedSetMap[String(setId)] = normalizeSetLines(sourceSetMap[key]);
    }
  });
  [info.sailSetId, info.arenaSetId].forEach((setId) => {
    const key = String(setId);
    if (!normalizedSetMap[key]) normalizedSetMap[key] = normalizeSetLines(legacySetInfo);
  });
  info.setMap = normalizedSetMap;
  syncLegacySetInfo(info);
  info.sailing = !!info.sailing;
  info.blessGift = ensureObject(info.blessGift);
  info.giftLevel = Math.max(0, toSafeInt(info.giftLevel, 0));
  info.giftExp = Math.max(0, toSafeInt(info.giftExp, 0));
  info.moraleSkill = ensureObject(info.moraleSkill);
  info.taskRecord = ensureObject(info.taskRecord);
  // The latest client iterates info.dest and calls .length in several task paths.
  info.dest = normalizeDestRecords(info.dest);
  if (!info.dest.some((row) => row.id === 1) && toSafeInt(getDestinationConfig(1, 1).id, 0) === 1) {
    info.dest.unshift({ id: 1, taskClaimed: [], rewardClaimed: [] });
  }
  info.pray = Math.max(0, toSafeInt(info.pray, 0));
  info.prayDate = String(info.prayDate || '');
  info.endCache = !!info.endCache;
  const sailInfo = ensureSailInfo(info);
  if (info.sailing && !sailInfo.trekData) startSailing(info, 1, 1);
  if (!info.sailing && sailInfo.trekData) info.sailing = true;
  return info;
}

async function handleOldTrekInfo(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7000, msgUid, data: ensureOldTrekInfo({}) };
  const info = ensureOldTrekInfo(player);
  const request = ensureObject(params);
  const destId = Math.max(0, toSafeInt(request.id, 0));

  if (destId > 0) {
    const sailInfo = startSailing(info, destId, Math.max(1, toSafeInt(request.diff, 1)));
    await playerService.savePlayer(session.userId, player);
    return {
      tag: 7000,
      msgUid,
      data: {
        result: sailInfo ? 0 : 1,
        data: sailInfo ? sailInfo.trekData : null,
        effects: sailInfo ? sailInfo.effects : [],
      },
    };
  }

  await playerService.savePlayer(session.userId, player);
  return { tag: 7000, msgUid, data: info };
}

async function handleOldTrekRefreshSailor(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7020, msgUid, data: { result: -1, refreshId: [], rewardCache: [], cacheCount: 0, dailyFree: 0, rewardInfo: buildRewardInfo() } };
  const info = ensureOldTrekInfo(player);
  const base = ensureObject(configService.get('OldTrekBaseConfig'));
  const requestedFree = toSafeInt(params && params.free, 0) === 1;
  const freeLimit = Math.max(0, toSafeInt(base.sailorRecruitDailyFree, 0));
  const canUseFree = requestedFree && info.dailyFreeRefresh < freeLimit;
  if (!canUseFree && !consumeItems(player, [ensureObject(base.recruitRefreshCosts)])) {
    return {
      tag: 7020,
      msgUid,
      data: {
        result: 1,
        refreshId: info.refreshId,
        rewardCache: info.rewardCache,
        cacheCount: info.cacheCount,
        dailyFree: info.dailyFreeRefresh,
        rewardInfo: buildRewardInfo(),
      },
    };
  }
  if (canUseFree) info.dailyFreeRefresh += 1;
  info.refreshId = pickRecruitSailorIds(info, Math.max(1, toSafeInt(base.recruitNum, 5)));
  info.rewardCache = [];
  info.cacheCount = 0;
  info.refreshId.forEach((id) => { if (info.sailorAtlas[id] == null) info.sailorAtlas[id] = 0; });
  await playerService.savePlayer(session.userId, player);
  return {
    tag: 7020,
    msgUid,
    data: {
      result: 0,
      refreshId: info.refreshId,
      rewardCache: info.rewardCache,
      cacheCount: info.cacheCount,
      dailyFree: info.dailyFreeRefresh,
      rewardInfo: buildRewardInfo(),
    },
  };
}

async function handleOldTrekHireSailor(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 7021, msgUid, data: { result: -1, rewardInfo: buildRewardInfo() } };
  const info = ensureOldTrekInfo(player);
  const sailorId = Math.max(0, toSafeInt(params && params.id, 0));
  const hire = Math.max(0, toSafeInt(params && params.hire, 0));
  if (!getSailorConfig(sailorId).id || !info.refreshId.includes(sailorId)) {
    return { tag: 7021, msgUid, data: { result: 1, rewardInfo: buildRewardInfo() } };
  }
  const sailor = buildSailor(sailorId);
  let slot = null;

  if (hire === 0 && !info.sailorList.some((row) => row.id === sailorId)) {
    info.sailorList.push(sailor);
    if (info.sailorAtlas[sailorId] == null) info.sailorAtlas[sailorId] = 0;
    slot = info.sailorSlotList.find((row) => toSafeInt(row.sailorId, 0) <= 0) || null;
    if (slot) slot.sailorId = sailorId;
  }
  info.refreshId = info.refreshId.filter((id) => id !== sailorId);
  if (info.refreshId.length <= 0) info.refreshId = getDefaultSailorIds().filter((id) => id !== sailorId);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 7021,
    msgUid,
    data: {
      result: 0,
      sailor,
      slot,
      rewardInfo: buildRewardInfo(),
    },
  };
}

function oldTrekRewardInfo(player, rows = []) {
  const items = normalizeItemRows(rows);
  items.forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    addRewardToPlayer(player, id, count);
  });
  return buildRewardInfo(items);
}

function rewardRowsFromEvent(event) {
  const source = ensureObject(event);
  const rows = [];
  const append = (value) => {
    if (Array.isArray(value)) rows.push(...value);
    else if (value && typeof value === 'object') rows.push(value);
  };
  append(source.rewards);
  append(source.reward);
  append(source.items);
  append(source.rewardInfo && source.rewardInfo.items);
  return normalizeItemRows(rows);
}

function buildTrekUpdatePush(info, player, overrides = {}) {
  const sailInfo = ensureSailInfo(info);
  return {
    updateData: buildTrekUpdate(sailInfo.trekData),
    itemUpdate: ensureArray(overrides.itemUpdate),
    battleLog: overrides.battleLog || null,
    rewardInfo: overrides.rewardInfo || buildRewardInfo(),
  };
}

function normalizeCabinUpdates(rows, sailInfo) {
  return ensureArray(rows).map((row) => {
    const source = ensureObject(row);
    const uid = toSafeInt(source.uid, 0);
    const current = ensureArray(sailInfo && sailInfo.cabin)
      .find((item) => toSafeInt(item && item.uid, 0) === uid) || {};
    return {
      ...source,
      uid,
      id: Math.max(0, toSafeInt(source.id, toSafeInt(current.id, 0))),
      count: Math.max(0, toSafeInt(source.count, toSafeInt(current.count, 0))),
      state: Math.max(0, toSafeInt(source.state, toSafeInt(current.state, 0))),
      targetUid: toSafeInt(source.targetUid, toSafeInt(current.targetUid, -1)),
    };
  });
}

function buildOldTrekEventLog(event, params) {
  const source = ensureObject(event);
  const id = Math.max(0, toSafeInt(source.id, toSafeInt(params && params.id, 0)));
  const requestEventUid = Math.max(0, toSafeInt(params && params.eventUid, 0));
  if (id <= 0 && !source.uid && requestEventUid <= 0) return null;
  return {
    ...source,
    uid: Math.max(0, toSafeInt(source.uid, requestEventUid || Date.now())),
    id,
    result: Math.max(0, toSafeInt(params && params.operate, 0)),
    param: toSafeInt(params && params.param, 0),
    pre: toSafeInt(source.pre, -1),
    time: Date.now(),
  };
}

function buildEventUpdatePush(info, player, overrides = {}) {
  const sailInfo = ensureSailInfo(info);
  return {
    event: Object.prototype.hasOwnProperty.call(overrides, 'event') ? overrides.event : (sailInfo.currentEvent || null),
    itemUpdate: normalizeCabinUpdates(overrides.itemUpdate, sailInfo),
    lastLog: overrides.lastLog || null,
    updateData: buildTrekUpdate(sailInfo.trekData),
    battleLog: overrides.battleLog || null,
    battleResult: overrides.battleResult || null,
    rewardInfo: overrides.rewardInfo || buildRewardInfo(),
    effects: ensureArray(overrides.effects),
    check: ensureArray(overrides.check),
  };
}

function buildBlessGiftUpdate(info, player, rewardRows = []) {
  return {
    giftLevel: Math.max(0, toSafeInt(info && info.giftLevel, 0)),
    giftExp: Math.max(0, toSafeInt(info && info.giftExp, 0)),
    rewards: oldTrekRewardInfo(player, rewardRows),
  };
}

function rewardRowsFromCache(cache) {
  if (Array.isArray(cache)) return normalizeItemRows(cache);
  const source = ensureObject(cache);
  return normalizeItemRows(Object.keys(source).map((key) => {
    const value = source[key];
    if (value && typeof value === 'object') return value;
    return { id: toSafeInt(key, 0), count: toSafeInt(value, 0) };
  }));
}

function oldTrekLine(info, setId = 0, lineId = 0) {
  const lines = ensureSetLines(info, setId);
  return lines.find((row) => toSafeInt(row && row.id, -1) === lineId) || buildLineData(lineId);
}

function oldTrekBattleResult(session, enemy = {}) {
  const actor = session.player || {};
  const info = ensureOldTrekInfo(actor);
  const left = buildBattlePlayer(actor, actor.playerId || session.userId, actor.name || 'Player');
  const right = buildBattlePlayer({}, enemy && enemy.dbid, enemy && enemy.name || '灵舟对手');
  right.hp = 0;
  const validSailors = info.sailorList.map((row) => row.id).filter((id) => getSailorConfig(id).id);
  const leftId = validSailors[0] || getDefaultSailorIds(1)[0];
  const rightId = getDefaultSailorIds(1)[0];
  const results = [{
    win: 1,
    line: 1,
    entitys: [
      { side: 1, leader: leftId, ids: [leftId], maxHp: 100000 },
      { side: -1, leader: rightId, ids: [rightId], maxHp: 100000 },
    ],
    events: [
      { type: 0, index: 0, caster: 0, target: 0, args: [], values: {}, events: [] },
      {
        type: 0,
        index: 1,
        caster: 0,
        target: 0,
        args: [],
        values: {},
        events: [
          {
            type: 2,
            index: 101,
            caster: 1,
            target: 0,
            args: [],
            values: {},
            events: [
              { type: 3, index: 101, caster: 1, target: -1, args: [0], values: { 1: -100000 }, events: [] },
            ],
          },
          { type: 8888, index: 0, caster: 0, target: 0, args: [300], values: {}, events: [] },
        ],
      },
    ],
  }];
  return {
    win: 1,
    params: {},
    results,
    playerInfos: {
      1: left,
      '-1': right,
    },
  };
}

function buildOldTrekSettlement(info, player, options = {}) {
  const sailInfo = ensureSailInfo(info);
  const trekData = ensureObject(sailInfo.trekData);
  const id = Math.max(1, toSafeInt(options.id, toSafeInt(trekData.id, 1)));
  const diff = Math.max(1, toSafeInt(options.diff, toSafeInt(trekData.diff, 1)));
  const cfg = getDestinationConfig(id, diff);
  const firstKey = `${id}:${diff}`;
  info.firstRewardRecords = ensureObject(info.firstRewardRecords);
  const firstRows = info.firstRewardRecords[firstKey] ? [] : ensureArray(cfg.firstRewards);
  const rewardRows = normalizeItemRows([...ensureArray(cfg.fixRewards), ...firstRows]);
  info.firstRewardRecords[firstKey] = 1;
  info.totalDistance += Math.max(0, toSafeInt(cfg.distance, 0));
  const rewards = oldTrekRewardInfo(player, rewardRows);
  const settlement = {
    id,
    diff,
    lv: info.lv,
    exp: info.exp,
    roundScore: Math.max(0, toSafeInt(cfg.baseSettleScore, toSafeInt(trekData.roundScore, 0))),
    cabin: sailInfo.cabin.slice(),
    rewards,
  };
  info.lastEndCache = {
    ...settlement,
    cache: { rewards: rewards.items.slice() },
    first: normalizeItemRows(firstRows),
  };
  info.endCache = false;
  info.sailing = false;
  sailInfo.trekData = null;
  sailInfo.currentEvent = null;
  sailInfo.cabin = [];
  sailInfo.eventLogs = [];
  sailInfo.effects = [];
  return settlement;
}

function buildRankPlayer(player, score, rank, dbid, name) {
  return {
    ...buildBattlePlayer(player, dbid, name),
    score: Math.max(0, toSafeInt(score, 0)),
    rank: Math.max(1, toSafeInt(rank, 1)),
    sailPower: Math.max(0, toSafeInt(player && player.power, 0)),
    kungfuId: Math.max(0, toSafeInt(player && player.kungfuId, 0)),
  };
}

function getArenaScore(player) {
  return Math.max(0, toSafeInt(player && (player.oldTrekArenaScore || player.arenaScore), 1000));
}

function arenaGradeForScore(score) {
  const table = ensureObject(configService.get('OldTrekArenaScoreConfig'));
  let grade = 1;
  Object.keys(table).forEach((key) => {
    const row = ensureObject(table[key]);
    const left = Math.max(0, toSafeInt(row.scoreLeft, 0));
    const right = toSafeInt(row.scoreRight, -1);
    if (score >= left && (right < 0 || score < right)) grade = Math.max(1, toSafeInt(row.id, grade));
  });
  return grade;
}

async function handleOldTrekAction(tag, params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag, msgUid, data: { result: -1 } };
  const info = ensureOldTrekInfo(player);
  const p = ensureObject(params);
  let data = { result: 0 };
  const pushPackets = [];
  switch (tag) {
    case 7001: {
      const sailInfo = ensureSailInfo(info);
      if (!sailInfo.trekData) startSailing(info, 1, 1);
      const multi = Math.max(1, Math.min(100, toSafeInt(p.multi, 1)));
      const base = ensureObject(configService.get('OldTrekBaseConfig'));
      const accelerateCost = ensureObject(base.baseAccelerateCosts);
      const costs = toSafeInt(accelerateCost.id, 0) > 0
        ? [{ id: accelerateCost.id, count: Math.max(1, toSafeInt(accelerateCost.count, 1)) * multi }]
        : [];
      const paid = consumeItems(player, costs);
      const trekData = ensureSailInfo(info).trekData;
      if (paid && trekData) {
        const cfg = getDestinationConfig(trekData.id, trekData.diff);
        trekData.dist = Math.min(
          Math.max(0, Number(cfg.distance) || Number.MAX_SAFE_INTEGER),
          Math.max(0, Number(trekData.dist) || 0) + Math.max(1, toSafeInt(base.equalDis, 200)) * multi
        );
        trekData.lastUpdateTime = Date.now();
      }
      data = {
        result: paid ? 0 : 1,
        critical: 0,
        event: null,
        updateData: buildTrekUpdate(trekData),
      };
      break;
    }
    case 7002: {
      const sailInfo = ensureSailInfo(info);
      const previousEvent = sailInfo.currentEvent;
      const rewardRows = rewardRowsFromEvent(previousEvent);
      const itemUpdate = normalizeCabinUpdates(previousEvent && previousEvent.itemUpdate, sailInfo);
      const taskUpdate = ensureObject(previousEvent && previousEvent.taskUpdate);
      const effects = ensureArray(previousEvent && previousEvent.effects);
      const check = ensureArray(previousEvent && previousEvent.check);
      const lastLog = buildOldTrekEventLog(previousEvent, p);
      Object.keys(taskUpdate).forEach((key) => {
        info.taskRecord[key] = taskUpdate[key];
      });
      const rewardInfo = oldTrekRewardInfo(player, rewardRows);
      if (lastLog) sailInfo.eventLogs.push(lastLog);
      effects.forEach((effect) => {
        const uid = toSafeInt(effect && effect.uid, 0);
        const index = sailInfo.effects.findIndex((row) => toSafeInt(row && row.uid, 0) === uid);
        if (uid > 0 && index >= 0) sailInfo.effects[index] = ensureObject(effect);
        else sailInfo.effects.push(ensureObject(effect));
      });
      sailInfo.currentEvent = null;
      data = { result: 0, rewards: rewardInfo, itemUpdate };
      pushPackets.push({
        tag: 7002,
        msgUid: 0,
        data: {
          rewards: rewardInfo,
          itemUpdate,
        },
      });
      pushPackets.push({
        tag: 7006,
        msgUid: 0,
        data: buildEventUpdatePush(info, player, {
          event: null,
          itemUpdate,
          lastLog,
          rewardInfo,
          effects,
          check,
        }),
      });
      // Keep the full-trek update shape stable for clients that subscribe to
      // the aggregate update stream while processing an event reward.
      pushPackets.push({
        tag: 7014,
        msgUid: 0,
        data: buildTrekUpdatePush(info, player, { itemUpdate }),
      });
      break;
    }
    case 7003: {
      const sailInfo = ensureSailInfo(info);
      const itemUid = toSafeInt(p.itemUid, 0);
      const item = sailInfo.cabin.find((row) => toSafeInt(row.uid, 0) === itemUid);
      const itemUpdate = [];
      if (item) {
        item.state = toSafeInt(p.state, toSafeInt(item.state, 0));
        item.targetUid = toSafeInt(p.targetUid, -1);
        itemUpdate.push({ ...item });
      }
      data = { itemUpdate };
      // Destination task progress is delivered on the push channel.  Send a
      // complete object because the client merges it with taskRecord.
      pushPackets.push({
        tag: 7003,
        msgUid: 0,
        data: { taskUpdate: { ...info.taskRecord } },
      });
      break;
    }
    case 7004: {
      const sailInfo = ensureSailInfo(info);
      const trekData = sailInfo.trekData;
      const base = ensureObject(configService.get('OldTrekBaseConfig'));
      const paid = !!trekData && consumeItems(player, [ensureObject(base.stableFixCosts)]);
      if (paid) {
        trekData.stable = Math.max(1, toSafeInt(trekData.stableMax, toSafeInt(base.baseStable, 100)));
        trekData.lastUpdateTime = Date.now();
      }
      data = { result: paid ? 0 : 1, updateData: buildTrekUpdate(trekData) };
      break;
    }
    case 7005: {
      const sailInfo = ensureSailInfo(info);
      const requestedUid = Math.max(0, toSafeInt(p.uid, 0));
      if (!sailInfo.trekData || (requestedUid > 0 && requestedUid !== toSafeInt(sailInfo.trekData.uid, 0))) {
        data = { result: 1 };
        break;
      }
      const settlement = buildOldTrekSettlement(info, player);
      data = { result: 0 };
      pushPackets.push({ tag: 7010, msgUid: 0, data: settlement });
      break;
    }
    case 7007:
      data = { logs: ensureArray(info.battleLogs) };
      break;
    case 7008: {
      const sailInfo = ensureSailInfo(info);
      data = {
        trekData: sailInfo.trekData,
        currentEvent: sailInfo.currentEvent,
        cabin: sailInfo.cabin,
        eventLogs: sailInfo.eventLogs,
        effects: sailInfo.effects,
        multi: sailInfo.multi,
        offlineCache: sailInfo.offlineCache,
      };
      break;
    }
    case 7009: {
      const destId = Math.max(1, toSafeInt(p.id, 1));
      const diff = Math.max(1, toSafeInt(p.diff, 1));
      const cfg = getDestinationConfig(destId, diff);
      const base = ensureObject(configService.get('OldTrekBaseConfig'));
      const costs = [...ensureArray(cfg.costs)];
      if (toSafeInt(cfg.sweepCost, 0) > 0 && toSafeInt(base.baseAccelerateCosts && base.baseAccelerateCosts.id, 0) > 0) {
        costs.push({ id: base.baseAccelerateCosts.id, count: cfg.sweepCost });
      }
      if (toSafeInt(cfg.id, 0) <= 0 || !consumeItems(player, costs)) {
        data = { result: 1 };
        break;
      }
      startSailing(info, destId, diff);
      const settlement = buildOldTrekSettlement(info, player, { id: destId, diff });
      const log = {
        logTime: Date.now(),
        id: destId,
        diff,
        result: 0,
        win: 1,
      };
      info.battleLogs.push(log);
      if (info.battleLogs.length > 100) info.battleLogs.splice(0, info.battleLogs.length - 100);
      info.battleLogUid = log.logTime;
      data = { result: 0 };
      pushPackets.push({ tag: 7009, msgUid: 0, data: log });
      pushPackets.push({ tag: 7010, msgUid: 0, data: settlement });
      break;
    }
    case 7010: {
      const id = Math.max(0, toSafeInt(p.id, 0));
      const cfg = getConfigRow('OldTrekTechSkillConfig', id);
      const costs = [];
      if (toSafeInt(cfg.pointCost, 0) > 0) costs.push({ id: 323, count: cfg.pointCost });
      if (cfg.cost && typeof cfg.cost === 'object') costs.push(cfg.cost);
      if (toSafeInt(cfg.id, 0) <= 0 || info.unlockTechs.includes(id) || info.unlocking.some((row) => toSafeInt(row.id, 0) === id) || !consumeItems(player, costs)) {
        data = { result: 1, data: { id, finishTime: Date.now() } };
        break;
      }
      const unlocking = { id, finishTime: Date.now() + Math.max(0, toSafeInt(cfg.unlockTime, 0)) * 1000 };
      info.unlocking.push(unlocking);
      data = { result: 0, data: unlocking };
      break;
    }
    case 7011:
      info.job = Math.max(0, toSafeInt(p.job, info.job));
      data = { result: 0 };
      break;
    case 7012: {
      const id = Math.max(0, toSafeInt(p.id, 0));
      const unlocking = info.unlocking.find((row) => toSafeInt(row.id, 0) === id);
      if (!unlocking) {
        data = { result: 1, data: { id, finishTime: Date.now() } };
        break;
      }
      const count = Math.max(1, toSafeInt(p.count, 1));
      const ad = toSafeInt(p.ad, 0) === 1;
      if (!ad && !consumeItems(player, [{ id: 1, count }])) {
        data = { result: 1, data: { ...unlocking } };
        break;
      }
      unlocking.finishTime = Math.max(Date.now(), toSafeInt(unlocking.finishTime, Date.now()) - count * 60 * 1000);
      data = { data: { ...unlocking }, result: 0 };
      break;
    }
    case 7022: {
      const setId = Math.max(0, toSafeInt(p.set, info.sailSetId));
      const lineIds = Array.isArray(p.line) ? p.line : [p.line];
      const slotIds = Array.isArray(p.slot) ? p.slot : [p.slot];
      const sailorIds = Array.isArray(p.id) ? p.id : [p.id];
      const setLines = ensureSetLines(info, setId);
      const touched = [];
      lineIds.forEach((lineValue, index) => {
        const lineId = Math.max(0, toSafeInt(lineValue, 0));
        const slotId = toSafeInt(slotIds[index], 0);
        const sailorId = Math.max(0, toSafeInt(sailorIds[index], 0));
        const line = setLines.find((row) => row.id === lineId);
        if (!line) return;
        if (slotId < 0) {
          const currentIndex = line.slots.indexOf(sailorId);
          if (currentIndex >= 0) line.slots[currentIndex] = 0;
        } else {
          const safeSlot = Math.max(0, Math.min(3, slotId));
          setLines.forEach((row) => {
            row.slots = row.slots.map((id, candidateIndex) => (
              id === sailorId && (row.id !== lineId || candidateIndex !== safeSlot) ? 0 : id
            ));
          });
          line.slots[safeSlot] = sailorId;
        }
        if (line.leader > 0 && !line.slots.includes(line.leader)) {
          line.leader = line.slots.find((id) => id > 0) || -1;
        }
        if (!touched.includes(lineId)) touched.push(lineId);
      });
      syncLegacySetInfo(info);
      data = { lineData: touched.map((lineId) => oldTrekLine(info, setId, lineId)), set: setId };
      break;
    }
    case 7023: {
      const id = Math.max(0, toSafeInt(p.id, 0));
      const sailor = info.sailorList.find((row) => row.id === id);
      const refund = [];
      if (sailor) {
        for (let star = 1; star <= sailor.star; star += 1) refund.push(...getSailorStarCost(id, star));
        info.sailorList = info.sailorList.filter((row) => row.id !== id);
        info.sailorSlotList.forEach((row) => { if (row.sailorId === id) row.sailorId = 0; });
        Object.keys(info.setMap).forEach((key) => {
          info.setMap[key].forEach((line) => {
            line.slots = line.slots.map((sailorId) => sailorId === id ? 0 : sailorId);
            if (line.leader === id) line.leader = line.slots.find((sailorId) => sailorId > 0) || -1;
          });
        });
      }
      data = { result: sailor ? 0 : 1, id, rewardInfo: oldTrekRewardInfo(player, refund) };
      break;
    }
    case 7024: {
      const slotId = Math.max(0, toSafeInt(p.slot, 0));
      const slot = info.sailorSlotList.find((row) => toSafeInt(row.slot, -1) === slotId);
      const currentLevel = slot ? Math.max(1, toSafeInt(slot.level, 1)) : 1;
      const cfg = getConfigRow('OldTrekSailorLevelUpConfig', currentLevel);
      const targetLevel = Math.max(currentLevel + 1, toSafeInt(p.level, currentLevel + 1));
      const paid = !!slot && targetLevel === currentLevel + 1 && consumeItems(player, ensureArray(cfg.levelCosts));
      if (paid) slot.level = targetLevel;
      data = { result: paid ? 0 : 1, slot: slot || { slot: slotId, sailorId: 0, level: currentLevel } };
      break;
    }
    case 7025: {
      const id = Math.max(0, toSafeInt(p.id, 0));
      const sailor = info.sailorList.find((row) => row.id === id);
      const targetStar = sailor ? Math.max(0, toSafeInt(p.star, sailor.star + 1)) : 0;
      const nextCfg = sailor ? getSailorStarConfig(id, targetStar) : {};
      const paid = !!sailor
        && targetStar === sailor.star + 1
        && toSafeInt(nextCfg.star, -1) === targetStar
        && consumeItems(player, getSailorStarCost(id, targetStar));
      if (paid) sailor.star = targetStar;
      data = { result: paid ? 0 : 1, sailor: sailor || buildSailor(id) };
      break;
    }
    case 7027: {
      const sailor = info.sailorList.find((row) => row.id === toSafeInt(p.id, 0));
      const resetCfg = sailor ? getSailorStarConfig(sailor.id, sailor.star) : {};
      const resetCost = resetCfg.sailorResetCost ? [resetCfg.sailorResetCost] : [];
      const refund = [];
      if (sailor) {
        for (let star = 1; star <= sailor.star; star += 1) refund.push(...getSailorStarCost(sailor.id, star));
      }
      const paid = !!sailor && sailor.star > 0 && consumeItems(player, resetCost);
      if (paid) sailor.star = Math.max(0, toSafeInt(getSailorConfig(sailor.id).minStar, 0));
      data = {
        result: paid ? 0 : 1,
        rewardInfo: paid ? oldTrekRewardInfo(player, refund) : buildRewardInfo(),
        sailor: sailor || buildSailor(p.id),
      };
      break;
    }
    case 7028: {
      const sailLevel = getConfigRow('OldTrekSailLevelConfig', info.lv);
      const maxLevel = Math.max(1, toSafeInt(sailLevel.sailorMaxLevel, 300));
      let changed = false;
      for (let pass = 0; pass < 1000; pass += 1) {
        let passChanged = false;
        for (const slot of info.sailorSlotList) {
          const level = Math.max(1, toSafeInt(slot.level, 1));
          if (level >= maxLevel) continue;
          const cfg = getConfigRow('OldTrekSailorLevelUpConfig', level);
          if (consumeItems(player, ensureArray(cfg.levelCosts))) {
            slot.level = level + 1;
            passChanged = true;
            changed = true;
          }
        }
        if (!passChanged) break;
      }
      data = { result: changed ? 0 : 1, slots: info.sailorSlotList };
      break;
    }
    case 7029: {
      const setId = Math.max(0, toSafeInt(p.set, info.sailSetId));
      const lineId = Math.max(0, toSafeInt(p.line, 0));
      const lineData = oldTrekLine(info, setId, lineId);
      lineData.leader = toSafeInt(p.id, -1);
      syncLegacySetInfo(info);
      data = { lineData, set: setId };
      break;
    }
    case 7030: {
      const sailorId = Math.max(0, toSafeInt(p.sailorId, 0));
      const targetSlotId = Math.max(0, toSafeInt(p.slotId, 0));
      const sourceSlot = info.sailorSlotList.find((row) => row.sailorId === sailorId);
      const targetSlot = info.sailorSlotList.find((row) => row.slot === targetSlotId);
      if (targetSlot) {
        const displacedId = targetSlot.sailorId;
        targetSlot.sailorId = sailorId;
        if (sourceSlot && sourceSlot !== targetSlot) sourceSlot.sailorId = displacedId;
      }
      data = { result: targetSlot ? 0 : 1, slot: targetSlot || { slot: targetSlotId, sailorId, level: 1 } };
      break;
    }
    case 7031: {
      const rewards = oldTrekRewardInfo(player, rewardRowsFromCache(info.rewardCache));
      info.rewardCache = [];
      info.cacheCount = 0;
      data = { rewardInfo: rewards };
      break;
    }
    case 7032: {
      const rewards = [];
      Object.keys(info.sailorAtlas).forEach((key) => {
        const id = Math.max(0, toSafeInt(key, 0));
        if (id <= 0 || toSafeInt(info.sailorAtlas[key], -1) !== 0) return;
        rewards.push(...ensureArray(getSailorConfig(id).atlasReward));
        info.sailorAtlas[key] = 1;
      });
      data = { result: 0, rewards: oldTrekRewardInfo(player, rewards), sailorAtlas: info.sailorAtlas };
      break;
    }
    case 7033: {
      const skillId = Math.max(0, toSafeInt(p.skillId, 0));
      const currentLevel = Math.max(0, toSafeInt(info.moraleSkill[skillId], 0));
      const targetLevel = Math.max(1, toSafeInt(p.level, currentLevel + 1));
      const table = getConfigRow('OldTrekSailorMoraleSkillConfig', skillId);
      const cfg = ensureObject(table[targetLevel] || table[String(targetLevel)]);
      const paid = targetLevel === currentLevel + 1 && toSafeInt(cfg.level, -1) === targetLevel
        && consumeItems(player, ensureArray(cfg.costs));
      if (paid) info.moraleSkill[skillId] = targetLevel;
      data = { result: paid ? 0 : 1, level: Math.max(0, toSafeInt(info.moraleSkill[skillId], 0)), skillId };
      break;
    }
    case 7034: {
      const setId = Math.max(0, toSafeInt(p.set, info.sailSetId));
      const lineId = Math.max(0, toSafeInt(p.line, 0));
      const line = oldTrekLine(info, setId, lineId);
      line.skill = toSafeInt(p.skillId, -1);
      syncLegacySetInfo(info);
      data = { line, set: setId };
      break;
    }
    case 7035: {
      const id = Math.max(0, toSafeInt(p.id, 0));
      const sailorPackage = info.sailorPackages.find((row) => row.id === id) || { id, expire: 0, freeClaim: 0 };
      sailorPackage.freeClaim = Math.max(0, toSafeInt(sailorPackage.freeClaim, 0)) | 1;
      if (!info.sailorPackages.some((row) => row.id === id) && id > 0) info.sailorPackages.push(sailorPackage);
      data = { rewardInfo: buildRewardInfo(), sailorPackage };
      if (id > 0) pushPackets.push({ tag: 7011, msgUid: 0, data: { ...sailorPackage } });
      break;
    }
    case 7036: {
      const arena = !!p.arena;
      const currentSetId = arena ? info.arenaSetId : info.sailSetId;
      const setId = Math.max(0, toSafeInt(p.set, currentSetId));
      ensureSetLines(info, setId);
      if (arena) info.arenaSetId = setId;
      else info.sailSetId = setId;
      syncLegacySetInfo(info);
      data = { arena, set: setId };
      break;
    }
    case 7037: {
      const id = Math.max(0, toSafeInt(p.id, 0));
      const cfg = getSailorConfig(id);
      const base = ensureObject(configService.get('OldTrekBaseConfig'));
      const recallTable = ensureObject(base.recallCost);
      const recallCosts = ensureArray(recallTable[cfg.quality] || recallTable[String(cfg.quality)]);
      const alreadyOwned = info.sailorList.some((row) => row.id === id);
      const paid = toSafeInt(cfg.id, 0) > 0 && !alreadyOwned && consumeItems(player, recallCosts);
      const sailor = paid ? buildSailor(id) : null;
      let slot = null;
      if (sailor) {
        info.sailorList.push(sailor);
        if (info.sailorAtlas[id] == null) info.sailorAtlas[id] = 0;
        slot = info.sailorSlotList.find((row) => row.sailorId <= 0) || null;
        if (slot) slot.sailorId = id;
      }
      data = { result: paid ? 0 : 1, rewardInfo: buildRewardInfo(), sailor, slot };
      break;
    }
    case 7038: {
      const setId = Math.max(0, toSafeInt(p.set, info.sailSetId));
      info.setMap[String(setId)] = normalizeSetLines(p.lineData);
      syncLegacySetInfo(info);
      data = { lineData: info.setMap[String(setId)], set: setId };
      break;
    }
    case 7040: {
      const destId = Math.max(1, toSafeInt(p.id, 1));
      const dest = ensureDestRecord(info, destId);
      taskRowsForDestination(destId).forEach((taskRow) => {
        const taskId = Math.max(0, toSafeInt(taskRow.id, 0));
        if (taskId > 0
          && taskRecordValue(info, taskRow) >= Math.max(0, toSafeInt(taskRow.taskValue1, 0))
          && !dest.taskClaimed.includes(taskId)) {
          dest.taskClaimed.push(taskId);
        }
      });
      dest.taskClaimed.sort((left, right) => left - right);
      data = { claimed: dest.taskClaimed.slice() };
      break;
    }
    case 7041: {
      const destId = Math.max(1, toSafeInt(p.id, 1));
      const dest = ensureDestRecord(info, destId);
      const taskTable = ensureObject(configService.get('OldTrekTaskConfig'));
      const rewardTable = getConfigRow('OldTrekTaskRewardConfig', destId);
      const score = calculateDestinationScore(dest, taskTable);
      const rewardRows = [];
      Object.keys(rewardTable).forEach((key) => {
        const row = ensureObject(rewardTable[key]);
        const subId = Math.max(0, toSafeInt(row.subId, toSafeInt(key, 0)));
        if (subId > 0 && score >= Math.max(0, toSafeInt(row.needScore, 0)) && !dest.rewardClaimed.includes(subId)) {
          dest.rewardClaimed.push(subId);
          rewardRows.push(...ensureArray(row.rewards));
        }
      });
      dest.rewardClaimed.sort((left, right) => left - right);
      data = {
        result: rewardRows.length > 0 ? 0 : 1,
        rewardClaimed: dest.rewardClaimed.slice(),
        rewards: rewardRows.length > 0 ? oldTrekRewardInfo(player, rewardRows) : buildRewardInfo(),
      };
      break;
    }
    case 7042: {
      const skin = Math.max(1, toSafeInt(p.id, info.skin));
      const canChange = info.shipSkins.includes(skin) && toSafeInt(getConfigRow('OldTrekShipDressConfig', skin).id, 0) === skin;
      if (canChange) info.skin = skin;
      data = { result: canChange ? 0 : 1, skin: info.skin };
      break;
    }
    case 7043: {
      const destId = Math.max(1, toSafeInt(p.id, 1));
      let dest = info.dest.find((row) => row.id === destId) || null;
      const cfg = getDestinationConfig(destId, 1);
      let unlocked = !!dest;
      if (!dest && toSafeInt(cfg.id, 0) > 0) {
        const costs = cfg.unlockItem ? [cfg.unlockItem] : [];
        if (consumeItems(player, costs)) {
          dest = ensureDestRecord(info, destId);
          unlocked = true;
        }
      }
      data = { result: unlocked ? 0 : 1, dest: dest || { id: destId, taskClaimed: [], rewardClaimed: [] } };
      break;
    }
    case 7044: {
      const id = Math.max(1, toSafeInt(p.id, 1));
      let passRecord = info.passRecords.find((row) => row.id === id);
      if (!passRecord) {
        passRecord = { id, buyRecord: 1, claimRecord: {} };
        info.passRecords.push(passRecord);
      }
      passRecord.claimRecord = ensureObject(passRecord.claimRecord);
      const passTable = getConfigRow('OldTrekPassConfig', id);
      const rewardRows = [];
      Object.keys(passTable).forEach((key) => {
        const row = ensureObject(passTable[key]);
        const level = Math.max(1, toSafeInt(row.level, toSafeInt(key, 1)));
        if (info.totalDistance < Math.max(0, toSafeInt(row.mileage, 0))) return;
        const oldClaim = Math.max(0, toSafeInt(passRecord.claimRecord[level], 0));
        let nextClaim = oldClaim;
        if ((oldClaim & 1) === 0) {
          rewardRows.push(...ensureArray(row.rewards));
          nextClaim |= 1;
        }
        if ((passRecord.buyRecord & 2) !== 0 && (oldClaim & 2) === 0) {
          rewardRows.push(...ensureArray(row.eRewards1));
          nextClaim |= 2;
        }
        if ((passRecord.buyRecord & 4) !== 0 && (oldClaim & 4) === 0) {
          rewardRows.push(...ensureArray(row.eRewards2));
          nextClaim |= 4;
        }
        passRecord.claimRecord[level] = nextClaim;
      });
      data = { passRecord, result: 0, rewards: oldTrekRewardInfo(player, rewardRows) };
      break;
    }
    case 7045: {
      const content = String(p.content || '').slice(0, 200);
      const chat = {
        dbid: normalizePlayerDbid(player.playerId || session.userId, '1'),
        name: String(player.name || 'Player'),
        content,
        reply: ensureObject(p.reply),
        time: Date.now(),
      };
      if (content) {
        info.chatList.push(chat);
        if (info.chatList.length > 100) info.chatList.splice(0, info.chatList.length - 100);
        pushPackets.push({ tag: 7008, msgUid: 0, data: chat });
      }
      data = { result: content ? 0 : 1 };
      break;
    }
    case 7046: {
      const score = Math.max(0, info.totalDistance);
      data = {
        list: [buildRankPlayer(player, score, 1, player.playerId || session.userId, player.name || 'Player')],
        rank: 1,
        score,
      };
      break;
    }
    case 7047:
      info.name = String(p.name || info.name).slice(0, 32);
      data = { name: info.name, result: 0 };
      break;
    case 7048:
      info.privilegeEffect[String(toSafeInt(p.privilege, 0))] = Date.now() + 3600000;
      data = {
        effectTime: info.privilegeEffect[String(toSafeInt(p.privilege, 0))],
        enemy: ensureSailInfo(info).currentEvent && ensureSailInfo(info).currentEvent.enemy || null,
      };
      break;
    case 7049: {
      const arena = toSafeInt(p.arena, 0);
      const score = arena ? getArenaScore(player) : info.totalDistance;
      data = {
        ...buildRankPlayer({}, score, 1, p.dbid, '灵舟道友'),
        arena,
      };
      break;
    }
    case 7050: {
      const enemyScore = Math.max(0, getArenaScore(player) - 10);
      const enemy = buildRankPlayer({}, enemyScore, 2, '000000000000000000000002', '灵舟对手');
      info.arenaEnemy = enemy;
      data = { enemy };
      break;
    }
    case 7051: {
      const enemy = p.enemy && typeof p.enemy === 'object' ? p.enemy : { dbid: p.enemy, name: '灵舟对手' };
      const battleResult = oldTrekBattleResult(session, enemy);
      const oldScore = getArenaScore(player);
      const scoreChange = 10;
      const score = oldScore + scoreChange;
      player.oldTrekArenaScore = score;
      player.oldTrekArenaRank = 1;
      const enemyScore = Math.max(0, toSafeInt(enemy.score, oldScore - 10));
      const rewardInfo = oldTrekRewardInfo(player, ensureArray(ensureObject(configService.get('OldTrekBaseConfig')).arenaReward));
      const recordId = String(Date.now());
      info.battleRecords[recordId] = battleResult;
      const log = { logTime: Date.now(), recordId, dbid: enemy.dbid || '', win: 1, revenge: 0 };
      info.arenaBattleLogs.push(log);
      info.arenaLogUid = log.logTime;
      data = { battleResult, enemyScore, enemyScoreChange: -scoreChange, rank: 1, rewardInfo, score, scoreChange };
      break;
    }
    case 7052: {
      const score = getArenaScore(player);
      data = {
        list: [buildRankPlayer(player, score, 1, player.playerId || session.userId, player.name || 'Player')],
        rank: 1,
        score,
      };
      break;
    }
    case 7053: {
      const grade = arenaGradeForScore(getArenaScore(player));
      const gradeTable = ensureObject(configService.get('OldTrekArenaScoreConfig'));
      const rewardRows = [];
      for (let current = 1; current <= grade; current += 1) {
        const bit = 1 << (current - 1);
        if ((info.arenaGradeReward & bit) === 0) {
          rewardRows.push(...ensureArray(ensureObject(gradeTable[current] || gradeTable[String(current)]).firstRewards));
          info.arenaGradeReward |= bit;
        }
      }
      data = { record: info.arenaGradeReward, rewardInfo: oldTrekRewardInfo(player, rewardRows) };
      break;
    }
    case 7054:
      data = { logs: ensureArray(info.arenaBattleLogs) };
      break;
    case 7060: {
      const enemy = p.enemy && typeof p.enemy === 'object' ? p.enemy : { dbid: p.enemy, name: '灵舟道友' };
      const battleResult = oldTrekBattleResult(session, enemy);
      const recordId = String(Date.now());
      info.battleRecords[recordId] = battleResult;
      data = { battleResult, recordId };
      break;
    }
    case 7061:
      data = { result: 0 };
      break;
    case 7062: {
      const recordId = String(p.recordId || '');
      const battleResult = info.battleRecords[recordId] || oldTrekBattleResult(session);
      data = { battleResult, result: 0 };
      break;
    }
    case 7063:
      data = { items: ensureArray(info.monumentItems) };
      break;
    case 7064: {
      const today = new Date().toISOString().slice(0, 10);
      if (info.prayDate !== today) {
        info.pray = 0;
        info.prayDate = today;
      }
      if (info.pray > 0) {
        data = { result: 1, pray: info.pray, rewards: buildRewardInfo() };
        break;
      }
      info.pray = 1;
      const base = ensureObject(configService.get('OldTrekBaseConfig'));
      data = { result: 0, pray: info.pray, rewards: oldTrekRewardInfo(player, [ensureObject(base.monumentRewards)]) };
      break;
    }
    case 7065: {
      const cached = ensureObject(info.lastEndCache);
      data = {
        cabin: ensureArray(cached.cabin),
        cache: { rewards: ensureArray(cached.cache && cached.cache.rewards) },
        diff: Math.max(0, toSafeInt(cached.diff, 0)),
        exp: Math.max(0, toSafeInt(cached.exp, info.exp)),
        first: ensureArray(cached.first),
        id: Math.max(0, toSafeInt(cached.id, 0)),
        lv: Math.max(1, toSafeInt(cached.lv, info.lv)),
        roundScore: Math.max(0, toSafeInt(cached.roundScore, 0)),
      };
      info.endCache = false;
      break;
    }
    default:
      break;
  }
  await playerService.savePlayer(session.userId, player);
  const response = { tag, msgUid, data };
  return pushPackets.length > 0 ? [response, ...pushPackets] : response;
}

module.exports = {
  ensureOldTrekInfo,
  buildBlessGiftUpdate,
  buildEventUpdatePush,
  handleOldTrekInfo,
  handleOldTrekRefreshSailor,
  handleOldTrekHireSailor,
  handleOldTrekAction,
};
