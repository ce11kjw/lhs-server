/**
 * Activity handlers
 * tags: 1700, 1750, 1760, 1770, 1780, 1785~1791
 */

const playerService = require('../services/PlayerService');
const configService = require('../services/ConfigService');
const { addRewardToPlayer } = require('./raid');
const { buildRewardItemSync } = require('../services/RewardSync');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensureObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function ensureArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

const MS_PER_DAY = 86400000;
const LOCAL_NEWYEAR_ACTIVITY_IDS = [43001, 44001];

function normalizeActivityIdList(raw) {
  return Array.from(
    new Set(
      ensureArray(raw)
        .map((v) => Math.max(0, toSafeInt(v, 0)))
        .filter((v) => v > 0)
    )
  ).sort((a, b) => a - b);
}

function getActivityConfigEntry(activityId) {
  const id = Math.max(0, toSafeInt(activityId, 0));
  if (id <= 0) return null;
  const cfg = configService.get('ActivityConfig') || {};
  return cfg[id] || cfg[String(id)] || null;
}

function getActivityTypeById(activityId) {
  const meta = getActivityConfigEntry(activityId);
  return meta ? toSafeInt(meta.activityType, 0) : 0;
}

function getDefaultActivityTimeWindow(now = Date.now()) {
  return {
    startTime: now - MS_PER_DAY,
    endTime: now + (13 * MS_PER_DAY),
  };
}

function isActivityWindowOpen(row, now = Date.now()) {
  const src = ensureObject(row);
  const startTime = toSafeInt(src.startTime, 0);
  const endTime = toSafeInt(src.endTime, 0);
  return startTime > 0 && endTime > startTime && startTime <= now && now < endTime;
}

function buildDefaultRecordsForActivityType(activityType) {
  const type = toSafeInt(activityType, 0);
  if (type === 43) {
    return { 1: 1, 3: 0, 10: 0, 11: 0 };
  }
  if (type === 44) {
    return { 1: 0 };
  }
  return {};
}

function normalizeRecordsMap(raw, activityType = 0) {
  const defaults = buildDefaultRecordsForActivityType(activityType);
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...defaults };
  Object.keys(src).forEach((key) => {
    out[key] = Math.max(0, toSafeInt(src[key], toSafeInt(defaults[key], 0)));
  });
  return out;
}

function normalizeBuyRecordsMap(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  Object.keys(src).forEach((key) => {
    out[key] = Math.max(0, toSafeInt(src[key], 0));
  });
  return out;
}

function normalizeActivityDataRow(row, activityType = 0) {
  const src = ensureObject(row);
  const id = Math.max(0, toSafeInt(src.id, 0));
  let type = toSafeInt(activityType, 0);
  if (!type && id > 0) {
    type = getActivityTypeById(id);
  }

  const fallbackWindow = getDefaultActivityTimeWindow();
  const hasWindow = toSafeInt(src.startTime, 0) > 0 || toSafeInt(src.endTime, 0) > 0;
  const score = Math.max(type === 44 ? 1 : 0, toSafeInt(src.score, type === 44 ? 1 : 0));

  return {
    id,
    module: Math.max(0, toSafeInt(src.module, 0)),
    index: Math.max(0, toSafeInt(src.index, 0)),
    param: toSafeInt(src.param, 0),
    record: Math.max(0, toSafeInt(src.record, 0)),
    status: Math.max(0, toSafeInt(src.status, 0)),
    startTime: hasWindow ? Math.max(0, toSafeInt(src.startTime, 0)) : fallbackWindow.startTime,
    endTime: hasWindow ? Math.max(0, toSafeInt(src.endTime, 0)) : fallbackWindow.endTime,
    score,
    recordList: Array.from(
      new Set(
        ensureArray(src.recordList)
          .map((v) => Math.max(0, toSafeInt(v, 0)))
          .filter((v) => v > 0)
      )
    ),
    records: normalizeRecordsMap(src.records, type),
    buyRecords: normalizeBuyRecordsMap(src.buyRecords),
    extra: ensureObject(src.extra),
  };
}

function createDefaultActivityRow(activityId) {
  const id = Math.max(0, toSafeInt(activityId, 0));
  const activityType = getActivityTypeById(id);
  const window = getDefaultActivityTimeWindow();
  return normalizeActivityDataRow({
    id,
    startTime: window.startTime,
    endTime: window.endTime,
    score: activityType === 44 ? 1 : 0,
    record: 0,
    recordList: [],
    records: buildDefaultRecordsForActivityType(activityType),
    buyRecords: {},
  }, activityType);
}

function seedOpenActivityDatas(info = {}) {
  const byId = new Map();
  const disabledIds = new Set(normalizeActivityIdList(info.disabledEntryIds));
  ensureArray(info.datas).forEach((row) => {
    const id = toSafeInt(row && row.id, 0);
    if (id > 0 && !disabledIds.has(id)) byId.set(id, row);
  });

  LOCAL_NEWYEAR_ACTIVITY_IDS.forEach((activityId) => {
    if (disabledIds.has(activityId)) return;
    const meta = getActivityConfigEntry(activityId);
    if (!meta) return;
    const activityType = toSafeInt(meta.activityType, 0);
    if (activityType !== 43 && activityType !== 44) return;

    const defaults = createDefaultActivityRow(activityId);
    const existing = byId.get(activityId);
    byId.set(activityId, normalizeActivityDataRow({
      ...defaults,
      ...ensureObject(existing),
      id: activityId,
      records: normalizeRecordsMap(
        existing && existing.records,
        activityType,
      ),
      buyRecords: normalizeBuyRecordsMap(existing && existing.buyRecords),
    }, activityType));
  });

  info.datas = Array.from(byId.values())
    .map((row) => normalizeActivityDataRow(row, getActivityTypeById(row.id)))
    .filter((row) => !disabledIds.has(row.id))
    .sort((a, b) => a.id - b.id);
  return info;
}

function isActivationPassAvailable(player = {}, meta = {}) {
  const conditions = ensureArray(meta.conditions);
  return conditions.every((condition) => {
    const type = toSafeInt(condition && condition.type, 0);
    const target = toSafeInt(condition && condition.value, 0);
    const cond = toSafeInt(condition && condition.cond, 0);
    if (type !== 3) return false;
    const current = Math.max(1, toSafeInt(player.level, 1));
    if (cond === 0) return current === target;
    if (cond === 1) return current < target;
    if (cond === 2) return current <= target;
    if (cond === 3) return current > target;
    if (cond === 4) return current >= target;
    return false;
  });
}

function syncActivationPassActivity(info = {}, player = {}) {
  const activityCfg = ensureObject(configService.get('ActivityConfig'));
  const candidates = Object.keys(activityCfg)
    .map((key) => activityCfg[key])
    .filter((row) => row && toSafeInt(row.activityType, 0) === 7);
  if (candidates.length <= 0) return info;

  const area = Math.max(1, toSafeInt(player.rechargeInfo && player.rechargeInfo.area, 1));
  const selected = candidates.find((row) => toSafeInt(row.area, 0) === area)
    || candidates.find((row) => toSafeInt(row.area, 0) === 1)
    || candidates[0];
  const selectedId = Math.max(0, toSafeInt(selected && selected.id, 0));
  const candidateIds = new Set(candidates.map((row) => Math.max(0, toSafeInt(row.id, 0))));

  info.datas = ensureArray(info.datas).filter((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    return !candidateIds.has(id) || (id === selectedId && isActivationPassAvailable(player, selected));
  });
  if (selectedId <= 0 || !isActivationPassAvailable(player, selected)) return info;

  let row = info.datas.find((item) => toSafeInt(item && item.id, 0) === selectedId);
  if (!row) {
    row = createDefaultActivityRow(selectedId);
    info.datas.push(row);
  } else if (!isActivityWindowOpen(row)) {
    const window = getDefaultActivityTimeWindow();
    row.startTime = window.startTime;
    row.endTime = window.endTime;
  }
  row.score = Math.max(
    0,
    toSafeInt(row.score, 0),
    toSafeInt(player.items && player.items[19], 0),
  );
  return info;
}

function setActivityEntryEnabled(info = {}, activityId, enabled = true) {
  const id = Math.max(0, toSafeInt(activityId, 0));
  if (id <= 0) return null;

  info.datas = ensureArray(info.datas);
  const disabledIds = new Set(normalizeActivityIdList(info.disabledEntryIds));
  if (enabled) {
    disabledIds.delete(id);
    const existing = info.datas.find((row) => toSafeInt(row && row.id, 0) === id);
    if (!existing) info.datas.push(createDefaultActivityRow(id));
  } else {
    disabledIds.add(id);
    info.datas = info.datas.filter((row) => toSafeInt(row && row.id, 0) !== id);
  }
  info.disabledEntryIds = Array.from(disabledIds).sort((a, b) => a - b);
  seedOpenActivityDatas(info);
  return ensureArray(info.datas).find((row) => toSafeInt(row && row.id, 0) === id) || null;
}

function buildActivityUpdatePacket(row, rewardInfo = null) {
  const data = {
    data: normalizeActivityDataRow(row, getActivityTypeById(row.id)),
  };
  if (rewardInfo && typeof rewardInfo === 'object') {
    data.rewardInfo = rewardInfo;
  }
  return {
    tag: 1701,
    msgUid: 0,
    data,
  };
}

function buildActivityAlchemyRewardPacket(
  row,
  activityType,
  rewardInfo = buildRewardInfo([]),
  count = 0,
  rewards = {}
) {
  const type = toSafeInt(activityType, 0);
  if (type !== 34 && type !== 37) return null;

  const src = ensureObject(rewards);
  const data = {
    data: normalizeActivityDataRow(row, type),
    rewardInfo: rewardInfo && typeof rewardInfo === 'object'
      ? rewardInfo
      : buildRewardInfo([]),
    count: Math.max(0, toSafeInt(count, 0)),
  };

  if (type === 34) {
    data.extraRewards = buildRewardInfo(src.extraRewards);
  } else {
    data.alchemyRewards = normalizeRewardRows(src.alchemyRewards);
    data.extraRewards = normalizeRewardRows(src.extraRewards);
    data.returnRewards = normalizeRewardRows(src.returnRewards);
  }

  if (type === 34) {
    return { tag: 120010, msgUid: 0, data };
  }
  return { tag: 120020, msgUid: 0, data };
}

function buildFestivalDrawPacket(row, rewards = []) {
  const normalized = normalizeActivityDataRow(row, 43);
  return {
    tag: 1796,
    msgUid: 0,
    data: {
      id: normalized.id,
      score: normalized.score,
      record: normalized.record,
      records: { ...normalized.records },
      rewards: ensureArray(rewards),
    },
  };
}

function buildActivity44RankRow(player = {}, row = {}) {
  const roleInfo = ensureObject(player.roleInfo);
  const score = Math.max(0, toSafeInt(ensureObject(row.records)[1], 0));
  return {
    dbid: String(player.playerId || player.userId || player._id || ''),
    name: String(player.name || ''),
    serverId: Math.max(0, toSafeInt(player.serverId, toSafeInt(process.env.SERVER_ID, 1))),
    serverName: String(player.serverName || process.env.SERVER_NAME || ''),
    level: Math.max(1, toSafeInt(player.level, 1)),
    avatar: Math.max(0, toSafeInt(player.avatar, toSafeInt(roleInfo.avatar, 0))),
    avatarUrl: String(player.avatarUrl || roleInfo.avatarUrl || ''),
    avatarFrame: Math.max(0, toSafeInt(player.avatarFrame, toSafeInt(roleInfo.avatarFrame, 0))),
    title: Math.max(0, toSafeInt(player.title, toSafeInt(roleInfo.title, 0))),
    kungfuId: Math.max(0, toSafeInt(roleInfo.kungfuId, 0)),
    power: Math.max(0, toSafeInt(player.power, 0)),
    score,
  };
}

function buildActivity44RankPacket(player = {}, row = {}) {
  const selfRow = buildActivity44RankRow(player, row);
  const ranklist = selfRow.dbid ? [selfRow] : [];
  return {
    tag: 1703,
    msgUid: 0,
    data: {
      id: 44001,
      rank: ranklist.length > 0 ? 1 : 0,
      myRank: ranklist.length > 0 ? 1 : 0,
      ranklist,
      toplist: ranklist.slice(0, 3),
    },
  };
}

function getActivityPushState(info = {}, activityId) {
  info.pushStates = ensureObject(info.pushStates);
  const key = String(Math.max(0, toSafeInt(activityId, 0)));
  info.pushStates[key] = ensureObject(info.pushStates[key]);
  return info.pushStates[key];
}

function getActivityTypeConfig(tableName, activityId) {
  const table = configService.get(tableName) || {};
  return table[activityId] || table[String(activityId)] || null;
}

function pickWeightedRow(rows = [], weightKey = 'weight') {
  const list = ensureArray(rows).filter((row) => row && typeof row === 'object');
  if (list.length <= 0) return null;
  const total = list.reduce((sum, row) => sum + Math.max(0, toSafeInt(row[weightKey], 0)), 0);
  if (total <= 0) return list[0];
  let roll = Math.random() * total;
  for (const row of list) {
    roll -= Math.max(0, toSafeInt(row[weightKey], 0));
    if (roll < 0) return row;
  }
  return list[list.length - 1];
}

function flattenObjectRows(raw) {
  const out = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value.id != null || value.type != null || value.activityId != null) out.push(value);
    else Object.keys(value).forEach((key) => visit(value[key]));
  };
  visit(raw);
  return out;
}

function consumeActivityItem(player = {}, itemId, count = 1) {
  const id = Math.max(0, toSafeInt(itemId, 0));
  const amount = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || amount <= 0) return null;
  player.items = ensureObject(player.items);
  const before = Math.max(0, toSafeInt(player.items[id], 0));
  if (before < amount) return null;
  const left = before - amount;
  if (left > 0) player.items[id] = left;
  else delete player.items[id];
  return { id, count: amount, left };
}

function getActivityItemCount(player = {}, itemId) {
  const id = Math.max(0, toSafeInt(itemId, 0));
  const items = ensureObject(player.items);
  const currencies = ensureObject(player.currencies);
  if (id === 1) return Math.max(0, toSafeInt(currencies.diamond, toSafeInt(items[id], 0)));
  if (id === 2) return Math.max(0, toSafeInt(currencies.silver, toSafeInt(items[id], 0)));
  if (id === 6) return Math.max(0, toSafeInt(currencies.gold, toSafeInt(items[id], 0)));
  return Math.max(0, toSafeInt(items[id], 0));
}

function setActivityItemCount(player = {}, itemId, count = 0) {
  const id = Math.max(0, toSafeInt(itemId, 0));
  const value = Math.max(0, toSafeInt(count, 0));
  if (id <= 0) return;
  player.items = ensureObject(player.items);
  if (value > 0) player.items[id] = value;
  else delete player.items[id];

  if (id === 1 || id === 2 || id === 6) {
    player.currencies = ensureObject(player.currencies);
    const key = id === 1 ? 'diamond' : (id === 2 ? 'silver' : 'gold');
    player.currencies[key] = value;
  }
}

function consumeActivityCosts(player = {}, rows = [], multiplier = 1) {
  const scale = Math.max(0, toSafeInt(multiplier, 0));
  if (scale <= 0) return null;

  const costsById = new Map();
  ensureArray(rows).forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0)) * scale;
    if (id > 0 && count > 0) costsById.set(id, (costsById.get(id) || 0) + count);
  });
  if (costsById.size <= 0) return null;

  for (const [id, count] of costsById) {
    if (getActivityItemCount(player, id) < count) return null;
  }

  const consumed = [];
  costsById.forEach((count, id) => {
    const left = getActivityItemCount(player, id) - count;
    setActivityItemCount(player, id, left);
    consumed.push({ id, count, left });
  });
  return consumed;
}

function buildActivityDropPacket(row, rewardInfo) {
  return {
    tag: 1702,
    msgUid: 0,
    data: {
      id: Math.max(0, toSafeInt(row && row.id, 0)),
      rewardInfo: rewardInfo || buildRewardInfo([]),
    },
  };
}

function buildActivityClosePacket(activityId) {
  return {
    tag: 1704,
    msgUid: 0,
    data: { id: Math.max(0, toSafeInt(activityId, 0)) },
  };
}

function buildActivityMonopolyFatePacket(row) {
  const normalized = normalizeActivityDataRow(row, 21);
  return {
    tag: 1751,
    msgUid: 0,
    data: { id: normalized.id, record: normalized.record, records: { ...normalized.records } },
  };
}

function buildActivityMonopolyMovePacket(row) {
  const normalized = normalizeActivityDataRow(row, 21);
  return {
    tag: 1750,
    msgUid: 0,
    data: {
      id: normalized.id,
      score: normalized.score,
      record: normalized.record,
      records: { ...normalized.records },
    },
  };
}

function buildActivityMultiGiftPacket(row, rewardInfo, multi = 1, addRecord = 0) {
  return {
    tag: 1770,
    msgUid: 0,
    data: {
      data: normalizeActivityDataRow(row, getActivityTypeById(row && row.id)),
      rewardInfo: rewardInfo || buildRewardInfo([]),
      multi: Math.max(1, toSafeInt(multi, 1)),
      addRecord: Math.max(0, toSafeInt(addRecord, 0)),
    },
  };
}

function buildActivityGrassTastePacket(row) {
  return {
    tag: 12000,
    msgUid: 0,
    data: { data: normalizeActivityDataRow(row, 35) },
  };
}

function buildActivityBoxDrawPacket(row, rewardInfo) {
  return {
    tag: 12010,
    msgUid: 0,
    data: {
      data: normalizeActivityDataRow(row, 49),
      rewardInfo: rewardInfo || buildRewardInfo([]),
    },
  };
}

function buildSecretTreasureState(player, row, pushState = {}) {
  const profile = buildActivity44RankRow(player, row);
  const numCount = {};
  const countsByDay = {};
  const rankMap = {};
  Object.keys(ensureObject(row.records)).forEach((key) => {
    const encoded = Math.max(0, toSafeInt(key, 0));
    const day = Math.floor(encoded / 100);
    const taskId = encoded % 100;
    const value = Math.max(0, toSafeInt(row.records[key], 0));
    if (day <= 0 || taskId <= 0 || value <= 0) return;
    const countKey = String((100 * value) + taskId);
    numCount[countKey] = Math.max(0, toSafeInt(numCount[countKey], 0)) + 1;
    countsByDay[day] = ensureObject(countsByDay[day]);
    countsByDay[day][value] = Math.max(0, toSafeInt(countsByDay[day][value], 0)) + 1;
    rankMap[day] = ensureArray(rankMap[day]);
    rankMap[day].push({ ...profile, score: value });
  });

  const rankRecord = {};
  Object.keys(countsByDay).forEach((day) => {
    rankRecord[day] = Object.keys(countsByDay[day])
      .map((value) => ({ value: Math.max(0, toSafeInt(value, 0)), count: countsByDay[day][value] }))
      .sort((a, b) => b.count - a.count || a.value - b.value);
  });

  return {
    numCount: { ...numCount, ...ensureObject(pushState.numCount) },
    rankRecord: { ...rankRecord, ...ensureObject(pushState.rankRecord) },
    rankMap: { ...rankMap, ...ensureObject(pushState.rankMap) },
    forecastLists: ensureObject(pushState.forecastLists),
    winner: pushState.winner && typeof pushState.winner === 'object' ? pushState.winner : null,
  };
}

function buildSecretTreasurePackets(player, row, pushState, module, index) {
  const state = buildSecretTreasureState(player, row, ensureObject(pushState.secretTreasure));
  const id = Math.max(0, toSafeInt(row && row.id, 0));
  if (module === -1) {
    return [{ tag: 1760, msgUid: 0, data: { id, numCount: state.numCount, rankRecord: state.rankRecord } }];
  }
  if (module === 1) {
    const key = String(Math.max(0, toSafeInt(index, 0)));
    let list = ensureArray(state.forecastLists[key]);
    if (list.length <= 0 && Math.max(0, toSafeInt(row.records[key], 0)) > 0) {
      list = [{ ...buildActivity44RankRow(player, row), score: Math.max(0, toSafeInt(row.records[key], 0)) }];
    }
    return [{ tag: 1761, msgUid: 0, data: { id, list } }];
  }
  if (module === 2) return [{ tag: 1762, msgUid: 0, data: { id, rankMap: state.rankMap } }];
  if (module === 3) return [{ tag: 1763, msgUid: 0, data: { id, winner: state.winner } }];
  return [];
}

function normalizeKnifeState(row, pushState, cfg) {
  const state = ensureObject(pushState.knife);
  state.winners = ensureArray(state.winners);
  state.pool = Math.max(0, toSafeInt(state.pool, toSafeInt(cfg && cfg.count, 0)));
  state.value = Math.max(0, toSafeInt(state.value, toSafeInt(row && row.record, 0)));
  pushState.knife = state;
  return state;
}

function buildKnifeDrawInfoPacket(state) {
  return {
    tag: 1755,
    msgUid: 0,
    data: { winners: ensureArray(state.winners), pool: state.pool, value: state.value },
  };
}

function buildKnifeDrawWinPacket(count) {
  return { tag: 1756, msgUid: 0, data: { count: Math.max(1, toSafeInt(count, 1)) } };
}

function buildFishKingRankPacket(player, row) {
  const self = buildActivity44RankRow(player, row);
  self.score = Math.max(0, toSafeInt(row && row.score, self.score));
  const ranklist = self.dbid ? [self] : [];
  return {
    tag: 120100,
    msgUid: 0,
    data: {
      rank: ranklist.length > 0 ? 1 : 0,
      score: self.score,
      ranklist,
      toplist: ranklist.slice(0, 3),
    },
  };
}

function buildFishSceneSalvagePacket(data = {}) {
  const src = ensureObject(data);
  return {
    tag: 1781,
    msgUid: 0,
    data: {
      type: Math.max(1, Math.min(4, toSafeInt(src.type, 4))),
      ...(src.bottle && typeof src.bottle === 'object' ? { bottle: src.bottle } : {}),
      ...(src.reward && typeof src.reward === 'object' ? { reward: src.reward } : {}),
    },
  };
}

function buildFishSceneBottleContentPacket(bottle = {}) {
  const src = ensureObject(bottle);
  return {
    tag: 1782,
    msgUid: 0,
    data: {
      title: String(src.title || ''),
      content: String(src.content || ''),
      textId: Math.max(0, toSafeInt(src.textId, 0)),
      score: Math.max(0, toSafeInt(src.score, 0)),
      titles: ensureArray(src.titles).map((v) => String(v)),
      contents: ensureArray(src.contents).map((v) => String(v)),
    },
  };
}

function buildFuluColorCount(type) {
  const patterns = {
    1: [1, 1, 1, 1, 1],
    2: [1, 1, 1, 1, 2],
    3: [1, 2, 3, 4, 5],
    4: [1, 1, 1, 2, 2],
    5: [1, 1, 1, 2, 3],
    6: [1, 1, 2, 2, 3],
    7: [1, 1, 2, 3, 4],
  };
  const colors = patterns[Math.max(1, Math.min(7, toSafeInt(type, 7)))] || patterns[7];
  return colors.reduce((map, color) => {
    map[color] = Math.max(0, toSafeInt(map[color], 0)) + 1;
    return map;
  }, {});
}

function buildFuluDrawPacket(row, rewards, colorCount, special = 0) {
  return {
    tag: 1775,
    msgUid: 0,
    data: {
      rewards: normalizeRewardRows(rewards),
      colorCount: ensureObject(colorCount),
      score: Math.max(0, toSafeInt(row && row.score, 0)),
      special: Math.max(0, toSafeInt(special, 0)),
      records: { ...normalizeRecordsMap(row && row.records, 52) },
    },
  };
}

function operateMonopoly(player, row, params = {}) {
  const tileConfig = getActivityTypeConfig('Activity21Config', row.id) || {};
  const steps = Math.max(1, toSafeInt(params.param, toSafeInt(params.index, 1)));
  const tileCount = Math.max(1, Object.keys(tileConfig).length || 21);
  row.record = ((Math.max(0, toSafeInt(row.record, 0)) + steps - 1) % tileCount) + 1;
  const levelRows = ensureObject(tileConfig[row.record] || tileConfig[String(row.record)]);
  const level = Math.max(1, toSafeInt(row.score, 1));
  const tile = ensureObject(levelRows[level] || levelRows[String(level)] || levelRows[Object.keys(levelRows)[0]]);
  let rewardInfo = buildRewardInfo([]);
  let fate = false;

  if (toSafeInt(tile.type, 0) === 1 && toSafeInt(tile.reward, 0) > 0) {
    const rewardCfg = configService.get('Activity21RewardConfig') || {};
    const rewardRow = ensureObject(rewardCfg[tile.reward] || rewardCfg[String(tile.reward)]);
    const reward = rewardRow.reward;
    rewardInfo = grantRewardRows(player, reward ? [reward] : []);
  } else if (toSafeInt(tile.type, 0) === 2) {
    row.score = Math.max(0, toSafeInt(row.score, 0)) + Math.max(0, toSafeInt(tile.score, 0));
  } else if (toSafeInt(tile.type, 0) === 3) {
    const fateId = Math.max(0, toSafeInt(tile.subType, 0));
    if (fateId > 0) {
      row.records[fateId] = Math.max(0, toSafeInt(row.records[fateId], 0)) + 1;
      fate = true;
    }
  }

  return {
    result: 0,
    row,
    rewardInfo,
    packets: [
      buildActivityMonopolyMovePacket(row),
      ...(fate ? [buildActivityMonopolyFatePacket(row)] : []),
    ],
  };
}

function resolveKnifeRewardConfig(activityId, level, index) {
  const root = getActivityTypeConfig('Activity27RewardConfig', activityId) || {};
  const levelMap = ensureObject(
    root[Math.max(1, toSafeInt(level, 1))]
      || root[String(Math.max(1, toSafeInt(level, 1)))]
      || root[Object.keys(root)[0]]
  );
  return ensureObject(
    levelMap[Math.max(0, toSafeInt(index, 0))]
      || levelMap[String(Math.max(0, toSafeInt(index, 0)))]
      || levelMap[Object.keys(levelMap)[0]]
  );
}

function operateKnifeReward(player, row, pushState, params = {}) {
  const cfg = ensureObject(getActivityTypeConfig('Activity27Config', row.id));
  const state = normalizeKnifeState(row, pushState, cfg);
  const module = toSafeInt(params.module, 0);
  if (module === 1) {
    return { result: 0, row, rewardInfo: buildRewardInfo([]), packets: [buildKnifeDrawInfoPacket(state)] };
  }

  const consumed = consumeActivityItem(player, cfg.shopId, 1);
  if (!consumed) {
    return { result: 1, row, rewardInfo: buildRewardInfo([]), packets: [buildKnifeDrawInfoPacket(state)] };
  }

  const index = Math.max(0, toSafeInt(params.index, 0));
  const rewardCfg = resolveKnifeRewardConfig(row.id, Math.max(1, row.score), index);
  const reward = pickWeightedRow(flattenObjectRows(rewardCfg.rewards));
  const rewardInfo = grantRewardRows(player, reward ? [reward] : []);
  row.records[index] = Math.max(0, toSafeInt(row.records[index], 0)) + 1;
  row.record = Math.max(0, toSafeInt(row.record, 0)) + 1;
  const add = Math.max(0, toSafeInt(cfg.diamondAward, 0));
  state.pool += add;
  state.value += add;

  const packets = [buildKnifeDrawInfoPacket(state)];
  if (index > 0 && index === Math.max(0, toSafeInt(cfg.bossId, 0))) {
    row.score = Math.max(0, toSafeInt(row.score, 0)) + 1;
    state.winners.unshift({ ...buildActivity44RankRow(player, row), score: row.score });
    state.winners = state.winners.slice(0, 20);
    packets.push(buildKnifeDrawWinPacket(row.score));
  }

  return { result: 0, row, rewardInfo, consumed, packets };
}

function resolveBoxRewardConfig(activityId, index) {
  const root = ensureObject(getActivityTypeConfig('Activity49RewardConfig', activityId));
  const requested = Math.max(0, toSafeInt(index, 0));
  if (root[requested] || root[String(requested)]) return ensureObject(root[requested] || root[String(requested)]);
  const key = Object.keys(root).find((value) => Math.floor(toSafeInt(value, 0) / 100) === requested);
  return ensureObject(root[key || Object.keys(root)[0]]);
}

function operateBoxDraw(player, row, params = {}) {
  const drawCfg = resolveBoxRewardConfig(row.id, params.index);
  const cost = ensureObject(drawCfg.cost);
  const consumed = consumeActivityItem(player, cost.id, cost.count);
  if (!consumed) {
    return { result: 1, row, rewardInfo: buildRewardInfo([]), packets: [] };
  }
  const reward = pickWeightedRow(ensureArray(drawCfg.rewards));
  const rewards = reward ? [{ id: reward.id, count: reward.count }] : [];
  const rewardInfo = grantRewardRows(player, rewards);
  const type = Math.max(0, toSafeInt(drawCfg.type, toSafeInt(params.index, 0)));
  row.records[type] = Math.max(0, toSafeInt(row.records[type], 0)) + 1;
  row.extra = ensureObject(row.extra);
  row.extra.index = type;
  row.extra.list = ensureArray(row.extra.list);
  row.extra.list.push(type);
  row.extra.list = row.extra.list.slice(-20);
  return {
    result: 0,
    row,
    rewardInfo,
    consumed,
    packets: [buildActivityBoxDrawPacket(row, rewardInfo)],
  };
}

function flattenFuluArrangements(activityId) {
  const root = ensureObject(getActivityTypeConfig('Activity52ArrangeConfig', activityId));
  return flattenObjectRows(root).filter((row) => toSafeInt(row.type, 0) > 0);
}

function operateFulu(player, row, params = {}) {
  const cfg = ensureObject(getActivityTypeConfig('Activity52Config', row.id));
  const module = toSafeInt(params.module, 0);
  if (module === 0) {
    row.record = Math.max(1, Math.min(5, toSafeInt(params.index, row.record || 1)));
    return { result: 0, row, rewardInfo: buildRewardInfo([]), packets: [] };
  }

  if (module === 2) {
    const records = normalizeRecordsMap(row.records, 52);
    const completed = Math.max(0, toSafeInt(records[2], 0));
    const threshold = Math.max(1, toSafeInt(cfg.times, toSafeInt(cfg.guaranteedTimes, 1))) * (completed + 1);
    if (Math.max(0, toSafeInt(records[1], 0)) < threshold) {
      return { result: 1, row, rewardInfo: buildRewardInfo([]), packets: [] };
    }
    records[2] = completed + 1;
    row.records = records;
    const rewardInfo = grantRewardRows(player, normalizeRewardRows(cfg.rewards));
    return { result: 0, row, rewardInfo, packets: [] };
  }

  const multi = Math.max(1, Math.min(Math.max(1, toSafeInt(cfg.maxMultiple, 1)), toSafeInt(params.index, 1)));
  const consumed = consumeActivityItem(player, cfg.consume, multi);
  if (!consumed) return { result: 1, row, rewardInfo: buildRewardInfo([]), packets: [] };
  const arrangement = pickWeightedRow(flattenFuluArrangements(row.id), 'showRate');
  if (!arrangement) return { result: 2, row, rewardInfo: buildRewardInfo([]), consumed, packets: [] };
  const reward = pickWeightedRow(ensureArray(arrangement.rewards));
  const rewards = reward ? [{ id: reward.id, count: Math.max(1, toSafeInt(reward.count, 1)) * multi }] : [];
  const rewardInfo = grantRewardRows(player, rewards);
  const records = normalizeRecordsMap(row.records, 52);
  records[1] = Math.max(0, toSafeInt(records[1], 0)) + multi;
  row.records = records;
  row.score = Math.max(0, toSafeInt(row.score, 0)) + multi;
  row.extra = { ...ensureObject(row.extra), currentMultiple: multi };
  return {
    result: 0,
    row,
    rewardInfo,
    consumed,
    packets: [buildFuluDrawPacket(row, rewards, buildFuluColorCount(arrangement.type), 0)],
  };
}

function getActivity33BottleConfig(activityId) {
  return ensureObject(getActivityTypeConfig('Activity33BottleConfig', activityId));
}

function operateFishSceneActivity(player, row, pushState, params = {}) {
  const module = toSafeInt(params.module, 0);
  const state = ensureObject(pushState.fishScene);
  state.bottle = state.bottle && typeof state.bottle === 'object' ? state.bottle : null;
  pushState.fishScene = state;
  if (module === 2) {
    return { result: 0, row, rewardInfo: buildRewardInfo([]), packets: [buildFishKingRankPacket(player, row)] };
  }
  if (module === 10) {
    const consumed = consumeActivityItem(player, 214, 1);
    if (!consumed) return { result: 1, row, rewardInfo: buildRewardInfo([]), packets: [] };
    state.bottle = {
      title: String(player.name || ''),
      content: String(params.content || '').slice(0, 100),
      textId: 0,
      score: 0,
      titles: [],
      contents: [],
    };
    row.extra = { ...state.bottle, hit: 0 };
    return { result: 0, row, rewardInfo: buildRewardInfo([]), consumed, packets: [] };
  }
  if (module === 11) {
    const consumed = consumeActivityItem(player, 215, 1);
    if (!consumed) return { result: 1, row, rewardInfo: buildRewardInfo([]), packets: [] };
    const salvage = state.bottle ? { type: 1, bottle: state.bottle } : { type: 4 };
    state.lastSalvage = salvage;
    return {
      result: 0,
      row,
      rewardInfo: buildRewardInfo([]),
      consumed,
      packets: [buildFishSceneSalvagePacket(salvage)],
    };
  }
  if (module === 12 && state.bottle) {
    state.bottle.titles = ensureArray(state.bottle.titles);
    state.bottle.contents = ensureArray(state.bottle.contents);
    state.bottle.titles.push(String(player.name || ''));
    state.bottle.contents.push(String(params.content || '').slice(0, 100));
    row.extra = { ...ensureObject(row.extra), ...state.bottle };
  } else if (module === 13 && state.bottle) {
    state.bottle.score = Math.max(0, toSafeInt(state.bottle.score, 0)) + 1;
    row.extra = { ...ensureObject(row.extra), ...state.bottle, hit: toSafeInt(row.extra && row.extra.hit, 0) | 1 };
  } else if (module === 14 && state.bottle) {
    const cfg = getActivity33BottleConfig(row.id);
    const range = ensureArray(cfg.bottleRewards);
    const count = Math.max(0, toSafeInt(range[0], 0));
    const rewards = count > 0 ? [{ id: 216, count }] : [];
    const rewardInfo = grantRewardRows(player, rewards);
    state.bottle = null;
    row.extra = {};
    return { result: 0, row, rewardInfo, packets: [] };
  } else if (module === 15 && state.bottle) {
    return {
      result: 0,
      row,
      rewardInfo: buildRewardInfo([]),
      packets: [buildFishSceneBottleContentPacket(state.bottle)],
    };
  }
  return { result: 0, row, rewardInfo: buildRewardInfo([]), packets: [] };
}

function findActivityRow(info, activityId) {
  const id = Math.max(0, toSafeInt(activityId, 0));
  if (id <= 0) return null;

  let row = ensureArray(info.datas).find((it) => toSafeInt(it.id, 0) === id);
  if (!row && LOCAL_NEWYEAR_ACTIVITY_IDS.includes(id)) {
    row = createDefaultActivityRow(id);
    info.datas.push(row);
  }
  if (!row) return null;

  const normalized = normalizeActivityDataRow(row, getActivityTypeById(id));
  const index = ensureArray(info.datas).findIndex((it) => toSafeInt(it.id, 0) === id);
  if (index >= 0) info.datas[index] = normalized;
  return normalized;
}

function pickDrawRewards(activityId, drawTimes = 1) {
  const cfg = configService.get('Activity43Config') || {};
  const rowCfg = cfg[activityId] || cfg[String(activityId)] || null;
  const pool = rowCfg && Array.isArray(rowCfg.rewardPoolShow) ? rowCfg.rewardPoolShow : [];
  if (!pool.length) {
    return [{ id: 4, count: 88 * Math.max(1, drawTimes) }];
  }

  const picks = [];
  const times = Math.max(1, toSafeInt(drawTimes, 1));
  for (let i = 0; i < times; i += 1) {
    const entry = pool[Math.floor(Math.random() * pool.length)];
    if (!entry) continue;
    picks.push({
      id: Math.max(0, toSafeInt(entry.id, 0)),
      count: Math.max(1, toSafeInt(entry.count, 1)),
    });
  }
  return picks.filter((row) => row.id > 0 && row.count > 0);
}

function normalizeRewardRows(raw = []) {
  return ensureArray(raw).map((row) => ({
    id: Math.max(0, toSafeInt(row && row.id, 0)),
    count: Math.max(1, toSafeInt(row && row.count, 1)),
  })).filter((row) => row.id > 0 && row.count > 0);
}

const ACTIVITY_37_QI_BY_PILL = Object.freeze({
  118001: 2,
  118002: 4,
  118003: 6,
  118004: 10,
  118005: 15,
});

function grantUnmergedRewardRows(player, rows = []) {
  const items = normalizeRewardRows(rows);
  items.forEach((row) => addRewardToPlayer(player, row.id, row.count));
  return { items, equips: [], heros: [] };
}

function operateActivity34Generate(player, row, params = {}) {
  const count = Math.max(0, toSafeInt(params.param, 0));
  const recipeId = Math.max(0, toSafeInt(params.index, 0));
  const rewardRoot = ensureObject(getActivityTypeConfig('Activity34RewardConfig', row.id));
  const cfg = ensureObject(rewardRoot[recipeId] || rewardRoot[String(recipeId)]);
  const limitRoot = ensureObject(getActivityTypeConfig('Activity34Config', row.id));
  const isEligible = (entry) => {
    const id = Math.max(0, toSafeInt(entry && entry.id, 0));
    const limitCfg = ensureObject(limitRoot[id] || limitRoot[String(id)]);
    const limit = Math.max(0, toSafeInt(limitCfg.count, 0));
    return id > 0 && (limit <= 0 || Math.max(0, toSafeInt(row.buyRecords[id], 0)) < limit);
  };
  const eligibleAtStart = ensureArray(cfg.qualityWeights).filter(isEligible);
  if (count <= 0 || recipeId <= 0 || eligibleAtStart.length <= 0) {
    return {
      result: 1,
      row,
      count: 0,
      rewardInfo: buildRewardInfo([]),
      extraRewards: buildRewardInfo([]),
      consumed: [],
    };
  }

  const consumed = consumeActivityCosts(player, cfg.consumes, count);
  if (!consumed) {
    return {
      result: 1,
      row,
      count: 0,
      rewardInfo: buildRewardInfo([]),
      extraRewards: buildRewardInfo([]),
      consumed: [],
    };
  }

  row.buyRecords = normalizeBuyRecordsMap(row.buyRecords);
  row.records = normalizeRecordsMap(row.records, 34);
  const succeed = Math.max(0, Math.min(10000, toSafeInt(cfg.succeed, 0)));
  const mainRewards = [];
  for (let i = 0; i < count; i += 1) {
    if ((Math.random() * 10000) >= succeed) continue;
    const eligible = ensureArray(cfg.qualityWeights).filter(isEligible);
    if (eligible.length <= 0) continue;
    const reward = pickWeightedRow(eligible);
    const id = Math.max(0, toSafeInt(reward && reward.id, 0));
    if (id <= 0) continue;
    mainRewards.push({ id, count: 1 });
    row.buyRecords[id] = Math.max(0, toSafeInt(row.buyRecords[id], 0)) + 1;
  }

  const extraRows = [];
  const baseCfg = ensureObject(getActivityTypeConfig('Activity34BaseConfig', row.id));
  ensureArray(baseCfg.dropItems).forEach((drop) => {
    const id = Math.max(0, toSafeInt(drop && drop.id, 0));
    const itemCount = Math.max(1, toSafeInt(drop && drop.count, 1));
    const maxNum = Math.max(0, toSafeInt(drop && drop.maxNum, 0));
    const weight = Math.max(0, toSafeInt(drop && drop.weight, 0));
    for (let i = 0; i < count; i += 1) {
      const received = Math.max(0, toSafeInt(row.records[id], 0));
      if (id <= 0 || (maxNum > 0 && received >= maxNum)) break;
      if ((Math.random() * 10000) >= weight) continue;
      const granted = maxNum > 0 ? Math.min(itemCount, maxNum - received) : itemCount;
      if (granted <= 0) continue;
      extraRows.push({ id, count: granted });
      row.records[id] = received + granted;
    }
  });
  const title = ensureObject(baseCfg.dropTitle);
  const titleId = Math.max(0, toSafeInt(title.id, 0));
  let titleHit = false;
  for (let i = 0; i < count && !titleHit; i += 1) {
    titleHit = (Math.random() * 10000) < Math.max(0, toSafeInt(title.weight, 0));
  }
  if (
    titleId > 0
    && Math.max(0, toSafeInt(row.records[titleId], 0)) <= 0
    && titleHit
  ) {
    const titleCount = Math.max(1, toSafeInt(title.count, 1));
    extraRows.push({ id: titleId, count: titleCount });
    row.records[titleId] = titleCount;
  }

  const rewardRows = [...mainRewards, { id: 41, count }];
  return {
    result: 0,
    row,
    count,
    rewardInfo: grantUnmergedRewardRows(player, rewardRows),
    extraRewards: grantRewardRows(player, extraRows),
    consumed,
  };
}

function operateActivity37Generate(player, row, params = {}) {
  const count = Math.max(0, toSafeInt(params.param, 0));
  const cfg = ensureObject(getActivityTypeConfig('Activity37RewardConfig', row.id));
  const costs = consumeActivityCosts(player, cfg.consumes, count);
  if (count <= 0 || !costs) {
    return {
      result: 1,
      row,
      count: 0,
      rewardInfo: buildRewardInfo([]),
      alchemyRewards: [],
      extraRewards: [],
      returnRewards: [],
      consumed: [],
    };
  }

  const succeed = Math.max(0, Math.min(10000, toSafeInt(cfg.succeed, 0)));
  const weights = ensureArray(cfg.qualityWeights);
  const alchemyRewards = [];
  let qi = 0;
  for (let i = 0; i < count; i += 1) {
    if ((Math.random() * 10000) >= succeed) continue;
    const reward = pickWeightedRow(weights);
    const id = Math.max(0, toSafeInt(reward && reward.id, 0));
    if (id <= 0) continue;
    alchemyRewards.push({ id, count: 1 });
    qi += Math.max(0, toSafeInt(ACTIVITY_37_QI_BY_PILL[id], 0));
  }

  const rewardInfo = qi > 0
    ? grantRewardRows(player, [{ id: 154, count: qi }])
    : buildRewardInfo([]);
  return {
    result: 0,
    row,
    count,
    rewardInfo,
    alchemyRewards,
    extraRewards: [],
    returnRewards: [],
    consumed: costs,
  };
}

function operateActivity37Draw(player, row, params = {}) {
  const param = Math.max(0, Math.min(1, toSafeInt(params.param, 0)));
  const cfg = ensureObject(getActivityTypeConfig('Activity37BaseConfig', row.id));
  const costs = ensureArray(cfg.costs);
  const cost = ensureObject(costs[param]);
  const drawCount = param === 1 ? 10 : 1;
  const consumed = consumeActivityCosts(player, [cost], 1);
  if (!consumed) {
    return { result: 1, row, rewardInfo: buildRewardInfo([]), consumed: [] };
  }

  const rewards = [];
  for (let i = 0; i < drawCount; i += 1) {
    const reward = pickWeightedRow(cfg.rewards);
    if (reward) rewards.push(reward);
  }
  const title = ensureObject(cfg.dropTitle);
  const titleWeight = Math.max(0, toSafeInt(title.weight, 0));
  if (toSafeInt(title.id, 0) > 0 && titleWeight > 0) {
    let titleHit = false;
    for (let i = 0; i < drawCount && !titleHit; i += 1) {
      titleHit = (Math.random() * 10000) < titleWeight;
    }
    if (titleHit) rewards.push(title);
  }

  row.score = Math.max(0, toSafeInt(row.score, 0)) + drawCount;
  return {
    result: 0,
    row,
    rewardInfo: grantRewardRows(player, rewards),
    consumed,
  };
}

function resolveActivity37ScoreReward(activityId, target) {
  const root = ensureObject(getActivityTypeConfig('ActivityScoreConfig', activityId));
  const fixedRows = Object.values(ensureObject(root[1] || root['1']))
    .map(ensureObject)
    .filter((row) => toSafeInt(row.score, 0) > 0)
    .sort((a, b) => toSafeInt(a.score, 0) - toSafeInt(b.score, 0));
  const direct = fixedRows.find((row) => toSafeInt(row.score, 0) === target);
  if (direct) return direct;

  const cycleRows = Object.values(ensureObject(root[2] || root['2']))
    .map(ensureObject)
    .filter((row) => toSafeInt(row.score, 0) > 0)
    .sort((a, b) => toSafeInt(a.score, 0) - toSafeInt(b.score, 0));
  if (fixedRows.length <= 0 || cycleRows.length <= 0) return null;
  const fixedMax = toSafeInt(fixedRows[fixedRows.length - 1].score, 0);
  const cycleSpan = toSafeInt(cycleRows[cycleRows.length - 1].score, 0);
  if (target <= fixedMax || cycleSpan <= 0) return null;
  return cycleRows.find((row) => {
    const base = fixedMax + toSafeInt(row.score, 0);
    return target >= base && (target - base) % cycleSpan === 0;
  }) || null;
}

function operateActivity37ScoreReward(player, row, params = {}) {
  const target = Math.max(0, toSafeInt(params.index, 0));
  const cfg = resolveActivity37ScoreReward(row.id, target);
  if (!cfg || row.score < target) {
    return { result: 1, row, rewardInfo: buildRewardInfo([]), consumed: [] };
  }
  if (ensureArray(row.recordList).includes(target)) {
    return { result: 2, row, rewardInfo: buildRewardInfo([]), consumed: [] };
  }

  row.recordList = [...ensureArray(row.recordList), target].sort((a, b) => a - b);
  return {
    result: 0,
    row,
    rewardInfo: grantRewardRows(player, cfg.rewards),
    consumed: [],
  };
}

function pickSpecialDrawReward(rowCfg = null, fallbackReward = null) {
  const candidates = [
    rowCfg && rowCfg.specialReward,
    rowCfg && rowCfg.bigReward,
    rowCfg && rowCfg.mustReward,
    rowCfg && rowCfg.guaranteeReward,
    rowCfg && rowCfg.superReward,
    rowCfg && rowCfg.topReward,
    rowCfg && rowCfg.reward,
  ];
  for (const candidate of candidates) {
    const rows = Array.isArray(candidate) ? normalizeRewardRows(candidate) : normalizeRewardRows([candidate]);
    if (rows.length > 0) return rows[0];
  }
  const pool = rowCfg && Array.isArray(rowCfg.rewardPoolShow) ? rowCfg.rewardPoolShow : [];
  const normalizedPool = normalizeRewardRows(pool);
  if (normalizedPool.length > 0) return normalizedPool[normalizedPool.length - 1];
  return fallbackReward || { id: 4, count: 88 };
}

function resolveDrawTimes(param = 0, cost = {}, rowCfg = null) {
  const directCount = Math.max(0, toSafeInt(cost.drawTimes, toSafeInt(cost.times, toSafeInt(cost.num, 0))));
  if (directCount > 0) return directCount;
  const cfgTimes = rowCfg && Array.isArray(rowCfg.drawTimes) ? rowCfg.drawTimes : [];
  const fromCfg = Math.max(0, toSafeInt(cfgTimes[Math.max(0, toSafeInt(param, 0))], 0));
  if (fromCfg > 0) return fromCfg;
  return Math.max(0, toSafeInt(param, 0)) > 0 ? 10 : 1;
}

function handleNewYearDrawOperate(player, row, param = 0) {
  const cfg = configService.get('Activity43Config') || {};
  const rowCfg = cfg[row.id] || cfg[String(row.id)] || null;
  const costs = rowCfg && Array.isArray(rowCfg.cost) ? rowCfg.cost : [{ id: 178, count: 1 }, { id: 178, count: 10 }];
  const costIndex = Math.max(0, toSafeInt(param, 0));
  const cost = costs[costIndex] || costs[0] || { id: 178, count: 1 };
  const drawTimes = resolveDrawTimes(param, cost, rowCfg);
  const costId = Math.max(0, toSafeInt(cost.id, 0));
  const costCount = Math.max(1, toSafeInt(cost.count, drawTimes));

  player.items = player.items || {};
  if (costId <= 0 || (Number(player.items[costId]) || 0) < costCount) {
    return {
      result: 1,
      row,
      rewardInfo: buildRewardInfo([]),
      festival: null,
      consumed: null,
    };
  }

  player.items[costId] = Math.max(0, (Number(player.items[costId]) || 0) - costCount);
  const costLeft = player.items[costId];
  if (player.items[costId] <= 0) delete player.items[costId];

  const records = normalizeRecordsMap(row.records, 43);
  const prevSp = toSafeInt(records[3], 0);
  records[1] = Math.max(1, toSafeInt(records[1], 1)) + drawTimes;
  const poolMax = rowCfg ? Math.max(1, toSafeInt(rowCfg.rewardPoolCount, 40)) : 40;
  const reachedGuarantee = records[1] > poolMax;
  if (reachedGuarantee) records[1] = 1;
  const specialHit = reachedGuarantee || Math.random() < 0.08;
  if (specialHit) records[3] = prevSp + 1;

  row.records = records;
  row.score = Math.max(0, toSafeInt(row.score, 0)) + drawTimes;

  const rewards = pickDrawRewards(row.id, drawTimes);
  if (specialHit) {
    const specialReward = pickSpecialDrawReward(rowCfg, rewards[0]);
    if (rewards.length > 0) rewards[rewards.length - 1] = specialReward;
    else rewards.push(specialReward);
  }
  const rewardInfo = grantRewardRows(player, rewards);
  return {
    result: 0,
    row,
    rewardInfo,
    consumed: { id: costId, count: costCount, left: Math.max(0, costLeft) },
    festival: {
      id: row.id,
      score: row.score,
      record: row.record,
      records: { ...records },
      rewards,
    },
  };
}

function handleNewYearScoreRewardOperate(player, row, scoreTarget = 0) {
  const target = Math.max(0, toSafeInt(scoreTarget, 0));
  if (target <= 0 || row.score < target) {
    return { result: 1, row, rewardInfo: buildRewardInfo([]) };
  }
  if (row.recordList.includes(target)) {
    return { result: 2, row, rewardInfo: buildRewardInfo([]) };
  }

  row.recordList = [...row.recordList, target].sort((a, b) => a - b);
  const rewardInfo = grantRewardRows(player, [{ id: 3, count: 20 }]);
  return { result: 0, row, rewardInfo };
}

function normalizeSnowmanRecordRow(row) {
  const src = ensureObject(row);
  return {
    parts: ensureArray(src.parts).map((v) => Math.max(0, toSafeInt(v, 0))),
    count: Math.max(0, toSafeInt(src.count, 0)),
    updateTime: Math.max(0, toSafeInt(src.updateTime, 0)),
  };
}

function normalizeSnowmanDesignRow(row) {
  const src = ensureObject(row);
  return {
    dbid: src.dbid == null ? '' : String(src.dbid),
    name: src.name == null ? '' : String(src.name),
    design: ensureArray(src.design).map((v) => Math.max(0, toSafeInt(v, 0))),
    like: Math.max(0, toSafeInt(src.like, 0)),
    updateTime: Math.max(0, toSafeInt(src.updateTime, 0)),
  };
}

function ensureActivityInfo(player = {}) {
  player.activityInfo = ensureObject(player.activityInfo);
  const info = player.activityInfo;

  info.datas = ensureArray(info.datas).map((row) => (
    normalizeActivityDataRow(row, getActivityTypeById(row && row.id))
  ));
  info.disabledEntryIds = normalizeActivityIdList(info.disabledEntryIds);
  seedOpenActivityDatas(info);
  syncActivationPassActivity(info, player);
  const currentDayKey = (() => {
    const date = new Date();
    return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  })();
  if (Math.max(0, toSafeInt(info.dailyRewardDayKey, 0)) !== currentDayKey) {
    info.dailyRewardRecords = [];
    info.dailyRewardDayKey = currentDayKey;
  }
  info.dailyRewardRecords = Array.from(
    new Set(
      ensureArray(info.dailyRewardRecords)
        .map((v) => Math.max(0, toSafeInt(v, 0)))
        .filter((v) => v > 0)
    )
  );
  info.rebateValue = Math.max(0, toSafeInt(info.rebateValue, 0));
  info.giftCodeRecords = ensureObject(info.giftCodeRecords);
  info.operateRecords = ensureObject(info.operateRecords);
  info.mooncakeRecords = ensureObject(info.mooncakeRecords);
  info.petSoulProgress = ensureObject(info.petSoulProgress);
  info.pushStates = ensureObject(info.pushStates);
  info.snowman = ensureObject(info.snowman);
  info.snowman.records = ensureObject(info.snowman.records);
  info.snowman.designInfo = normalizeSnowmanDesignRow(info.snowman.designInfo);
  info.snowman.designList = ensureArray(info.snowman.designList).map(normalizeSnowmanDesignRow);
  info.snowman.likedPlayers = ensureObject(info.snowman.likedPlayers);
  info.updatedAt = Date.now();

  return info;
}

function buildActivityPayload(info = {}) {
  const disabledIds = new Set(normalizeActivityIdList(info.disabledEntryIds));
  return {
    datas: ensureArray(info.datas)
      .map((row) => normalizeActivityDataRow(row, getActivityTypeById(row && row.id)))
      .filter((row) => !disabledIds.has(row.id) && isActivityWindowOpen(row)),
  };
}

function buildRewardInfo(items = []) {
  const normalized = [];
  const map = new Map();
  ensureArray(items).forEach((row) => {
    const id = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    map.set(id, (map.get(id) || 0) + count);
  });
  map.forEach((count, id) => normalized.push({ id, count }));
  normalized.sort((a, b) => a.id - b.id);
  return { items: normalized, equips: [], heros: [] };
}

function grantRewardRows(player, rows = []) {
  const reward = buildRewardInfo(rows);
  reward.items.forEach((row) => addRewardToPlayer(player, row.id, row.count));
  return reward;
}

function hasRechargeRecord(player = {}, rechargeId = 0) {
  const id = Math.max(0, toSafeInt(rechargeId, 0));
  const records = ensureArray(player.rechargeInfo && player.rechargeInfo.records);
  return id > 0 && records.some((row) => (
    toSafeInt(row && row.id, 0) === id && toSafeInt(row && row.count, 0) > 0
  ));
}

function operateActivationPass(player = {}, row = {}) {
  const id = Math.max(0, toSafeInt(row.id, 0));
  const stage = Math.max(1, toSafeInt(row.record, 1));
  const cfgByActivity = ensureObject((configService.get('Activity7Config') || {})[id]);
  const cfgByStage = ensureObject(cfgByActivity[stage]);
  const typeByActivity = ensureObject((configService.get('Activity7TypeConfig') || {})[id]);
  const typeCfg = ensureObject(typeByActivity[stage]);
  const bought = hasRechargeRecord(player, typeCfg.rechargeId);
  row.records = normalizeRecordsMap(row.records, 7);
  row.score = Math.max(0, toSafeInt(row.score, 0), toSafeInt(player.items && player.items[19], 0));

  const thresholds = Object.keys(cfgByStage)
    .map((key) => cfgByStage[key])
    .filter((cfg) => cfg && typeof cfg === 'object')
    .sort((a, b) => toSafeInt(a.param, 0) - toSafeInt(b.param, 0));
  for (const cfg of thresholds) {
    const point = Math.max(0, toSafeInt(cfg.param, 0));
    if (point > row.score) continue;
    const received = Math.max(0, toSafeInt(row.records[point], 0));
    if (received < 1) {
      row.records[point] = 1;
      return { result: 0, row, rewardInfo: grantRewardRows(player, ensureArray(cfg.rewards)) };
    }
    if (bought && received < 3) {
      row.records[point] = 3;
      return { result: 0, row, rewardInfo: grantRewardRows(player, ensureArray(cfg.eRewards)) };
    }
  }
  return { result: 1, row, rewardInfo: buildRewardInfo([]) };
}

function upsertActivityRow(info, id, module, index) {
  const keyId = Math.max(0, toSafeInt(id, 0));
  const keyModule = Math.max(0, toSafeInt(module, 0));
  const keyIndex = Math.max(0, toSafeInt(index, 0));
  let row = ensureArray(info.datas).find((it) => (
    toSafeInt(it.id, 0) === keyId
    && toSafeInt(it.module, 0) === keyModule
    && toSafeInt(it.index, 0) === keyIndex
  ));
  if (!row) {
    row = createDefaultActivityRow(keyId);
    row.module = keyModule;
    row.index = keyIndex;
    info.datas.push(row);
  }
  return normalizeActivityDataRow(row, getActivityTypeById(keyId));
}

function upsertPetSoulProgress(info, id) {
  const key = String(Math.max(0, toSafeInt(id, 0)));
  info.petSoulProgress[key] = ensureObject(info.petSoulProgress[key]);
  const row = info.petSoulProgress[key];
  row.progress = Math.max(0, toSafeInt(row.progress, 0));
  row.recordList = Array.from(
    new Set(
      ensureArray(row.recordList)
        .map((v) => Math.max(0, toSafeInt(v, 0)))
        .filter((v) => v > 0)
    )
  );
  row.recordList.sort((a, b) => a - b);
  return row;
}

function upsertSnowmanRecord(info, index) {
  const key = String(Math.max(0, toSafeInt(index, 0)));
  info.snowman.records[key] = normalizeSnowmanRecordRow(info.snowman.records[key]);
  return info.snowman.records[key];
}

function buildGiftCodeBatchId(giftCode) {
  let sum = 0;
  for (let i = 0; i < giftCode.length; i++) {
    sum = (sum + giftCode.charCodeAt(i) * (i + 1)) % 90000;
  }
  return 10000 + sum;
}

function normalizeGiftCode(value) {
  return String(value == null ? '' : value).trim().toUpperCase().replace(/\s+/g, '');
}

function buildGiftCodeRewardsFromAdmin(row = {}) {
  const rewards = ensureObject(row.rewards);
  const items = rewards.items instanceof Map ? Object.fromEntries(rewards.items) : ensureObject(rewards.items);
  const rows = [];
  const push = (id, count) => {
    const safeId = Math.max(0, toSafeInt(id, 0));
    const safeCount = Math.max(0, toSafeInt(count, 0));
    if (safeId > 0 && safeCount > 0) rows.push({ id: safeId, count: safeCount });
  };
  push(1, rewards.diamond);
  push(6, rewards.gold);
  push(2, rewards.silver);
  Object.keys(items).forEach((id) => push(id, items[id]));
  return rows;
}

async function getAdminGiftCodeEntry(giftCode, player) {
  const normalizedCode = normalizeGiftCode(giftCode);
  if (!normalizedCode) return null;
  let RedemptionCode;
  try {
    RedemptionCode = require('../db/models/RedemptionCode');
  } catch (_e) {
    return null;
  }
  if (!RedemptionCode.db || RedemptionCode.db.readyState !== 1) return null;
  const row = await RedemptionCode.findOne({ code: normalizedCode });
  if (!row) return null;
  if (row.status === 'disabled') return { result: 3 };

  const now = Date.now();
  if (row.startsAt && new Date(row.startsAt).getTime() > now) return { result: 1 };
  if (row.expiresAt && new Date(row.expiresAt).getTime() < now) return { result: 1 };
  if (toSafeInt(row.maxUses, 0) > 0 && toSafeInt(row.usedCount, 0) >= toSafeInt(row.maxUses, 0)) {
    return { result: 4 };
  }

  const userId = String((player && player.userId) || '');
  const usedBy = ensureArray(row.usedBy);
  const usedTimes = usedBy.filter((it) => String(it && it.userId) === userId).length;
  if (usedTimes >= Math.max(1, toSafeInt(row.perUserLimit, 1))) return { result: 2 };

  const rewards = buildGiftCodeRewardsFromAdmin(row);
  if (rewards.length <= 0) return { result: 3 };
  return { row, rewards, batchId: buildGiftCodeBatchId(normalizedCode) };
}

/**
 * Validate a gift code against the configured valid codes.
 * GiftCodeConfig is a map of { code: { rewards: [{id, count}], maxUse: number } }
 * Falls back to env variable GIFT_CODE_LIST (comma-separated) with default rewards.
 */
function getValidGiftCodeEntry(giftCode) {
  // Check GiftCodeConfig from config service
  const cfg = configService.get('GiftCodeConfig');
  if (cfg && typeof cfg === 'object') {
    const entry = cfg[giftCode] || cfg[String(giftCode)] || null;
    if (entry) return entry;
    // If config exists but code not found, it's invalid
    return null;
  }

  // Fallback: check GIFT_CODE_LIST env variable (comma-separated valid codes)
  const envList = process.env.GIFT_CODE_LIST || '';
  if (envList.trim()) {
    const validCodes = envList.split(',').map((s) => s.trim()).filter(Boolean);
    if (validCodes.includes(giftCode)) {
      // Return default rewards
      return { rewards: [{ id: 1, count: 88 }, { id: 3, count: 888 }], maxUse: 1 };
    }
    return null;
  }

  // No validation config present — reject all codes to prevent exploitation
  return null;
}

function upsertSnowmanDesignSelf(info, player, parts) {
  const dbid = String((player && (player.playerId || player.userId)) || '');
  const name = player && player.name ? String(player.name) : '';
  const design = ensureArray(parts).map((v) => Math.max(0, toSafeInt(v, 0)));

  const row = {
    dbid,
    name,
    design,
    like: Math.max(0, toSafeInt(info.snowman.designInfo.like, 0)),
    updateTime: Date.now(),
  };
  info.snowman.designInfo = row;

  const list = ensureArray(info.snowman.designList);
  const idx = list.findIndex((it) => String(it && it.dbid) === dbid);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...row };
  } else {
    list.unshift(row);
  }
  info.snowman.designList = list.slice(0, 50).map(normalizeSnowmanDesignRow);
}

async function persistPlayer(session, player) {
  if (!session || !session.userId) return;
  const saved = await playerService.savePlayer(session.userId, player);
  if (saved && typeof saved === 'object') {
    session.player = saved;
  }
}

async function handleActivityOperate(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1700, msgUid, data: { result: -1, datas: [] } };
  }

  const info = ensureActivityInfo(player);
  const id = Math.max(0, toSafeInt(params.id, 0));
  const module = toSafeInt(params.module, 0);
  const index = Math.max(0, toSafeInt(params.index, 0));
  const param = toSafeInt(params.param, 0);
  const activityType = getActivityTypeById(id);
  const drawParam = activityType === 43 && module === 0 ? Math.max(0, param, index) : param;

  let row = findActivityRow(info, id);
  if (!row) {
    row = normalizeActivityDataRow(upsertActivityRow(info, id, module, index), activityType);
  }

  // Keep the entry visible and operable under one contract: expired/future
  // rows must not consume items, update records, or create reward packets.
  if (!isActivityWindowOpen(row)) {
    return {
      tag: 1700,
      msgUid,
      data: {
        result: 1,
        id,
        module,
        index,
        param,
        rewardInfo: buildRewardInfo([]),
        datas: buildActivityPayload(info).datas,
      },
    };
  }

  row.param = drawParam;
  row.status = 1;

  if (activityType === 44 && module === 1) {
    return [
      buildActivity44RankPacket(player, row),
      {
        tag: 1700,
        msgUid,
        data: {
          result: 0,
          id,
          module,
          index,
          param,
          rewardInfo: buildRewardInfo([]),
          datas: buildActivityPayload(info).datas,
        },
      },
    ];
  }

  const opKey = `${id}:${module}:${index}`;
  info.operateRecords[opKey] = Math.max(0, toSafeInt(info.operateRecords[opKey], 0)) + 1;

  let result = 0;
  let rewardInfo = buildRewardInfo([]);
  let festivalPacket = null;
  let consumedCost = null;
  let consumedCosts = [];
  let activity34Generate = null;
  let activity37Generate = null;
  let additionalSyncRewards = [];
  let activityPushPackets = [];
  const pushState = getActivityPushState(info, id);

  if (activityType === 7) {
    const outcome = operateActivationPass(player, row);
    result = outcome.result;
    row = outcome.row;
    rewardInfo = outcome.rewardInfo;
  } else if (activityType === 21) {
    const outcome = operateMonopoly(player, row, { ...params, module, index, param });
    result = outcome.result;
    row = outcome.row;
    rewardInfo = outcome.rewardInfo;
    activityPushPackets = outcome.packets;
  } else if (activityType === 27) {
    const outcome = operateKnifeReward(player, row, pushState, { ...params, module, index, param });
    result = outcome.result;
    row = outcome.row;
    rewardInfo = outcome.rewardInfo;
    consumedCost = outcome.consumed || null;
    activityPushPackets = outcome.packets;
  } else if (activityType === 30) {
    activityPushPackets = buildSecretTreasurePackets(player, row, pushState, module, index);
  } else if (activityType === 33) {
    const outcome = operateFishSceneActivity(player, row, pushState, { ...params, module, index, param });
    result = outcome.result;
    row = outcome.row;
    rewardInfo = outcome.rewardInfo;
    consumedCost = outcome.consumed || null;
    activityPushPackets = outcome.packets;
  } else if (activityType === 34) {
    const outcome = module === 0
      ? operateActivity34Generate(player, row, { ...params, module, index, param })
      : {
        result: 1,
        row,
        count: 0,
        rewardInfo: buildRewardInfo([]),
        extraRewards: buildRewardInfo([]),
        consumed: [],
      };
    result = outcome.result;
    row = outcome.row;
    rewardInfo = outcome.rewardInfo;
    consumedCosts = ensureArray(outcome.consumed);
    additionalSyncRewards = ensureArray(outcome.extraRewards && outcome.extraRewards.items);
    activity34Generate = outcome;
  } else if (activityType === 35) {
    row.record = Math.max(0, toSafeInt(row.record, 0)) + 1;
  } else if (activityType === 37) {
    let outcome;
    if (module === 1) {
      outcome = operateActivity37Generate(player, row, { ...params, module, index, param });
      activity37Generate = outcome;
    } else if (module === 2) {
      outcome = operateActivity37Draw(player, row, { ...params, module, index, param });
    } else if (module === 0) {
      outcome = operateActivity37ScoreReward(player, row, { ...params, module, index, param });
    } else {
      outcome = { result: 1, row, rewardInfo: buildRewardInfo([]), consumed: [] };
    }
    result = outcome.result;
    row = outcome.row;
    rewardInfo = outcome.rewardInfo;
    consumedCosts = ensureArray(outcome.consumed);
  } else if (activityType === 49) {
    const outcome = operateBoxDraw(player, row, { ...params, module, index, param });
    result = outcome.result;
    row = outcome.row;
    rewardInfo = outcome.rewardInfo;
    consumedCost = outcome.consumed || null;
    activityPushPackets = outcome.packets;
  } else if (activityType === 52) {
    const outcome = operateFulu(player, row, { ...params, module, index, param });
    result = outcome.result;
    row = outcome.row;
    rewardInfo = outcome.rewardInfo;
    consumedCost = outcome.consumed || null;
    activityPushPackets = outcome.packets;
  } else if (activityType === 43) {
    if (module === 0) {
      const drawResult = handleNewYearDrawOperate(player, row, drawParam);
      result = drawResult.result;
      row = drawResult.row;
      rewardInfo = drawResult.rewardInfo;
      consumedCost = drawResult.consumed;
      if (drawResult.festival) {
        festivalPacket = buildFestivalDrawPacket(row, drawResult.festival.rewards);
      }
    } else if (module === 3) {
      const scoreResult = handleNewYearScoreRewardOperate(player, row, index);
      result = scoreResult.result;
      row = scoreResult.row;
      rewardInfo = scoreResult.rewardInfo;
    } else if (module > 0) {
      row.record = Math.max(0, toSafeInt(row.record, 0)) + 1;
      rewardInfo = grantRewardRows(player, [{ id: 3, count: 10 }]);
    }
  } else if (activityType === 44 && module === 0) {
    const cfg = configService.get('Activity44Config') || {};
    const rowCfg = cfg[id] || cfg[String(id)] || null;
    const costs = rowCfg && Array.isArray(rowCfg.atkCost) ? rowCfg.atkCost : [{ id: 176, count: 1 }];
    const cost = costs[param] || costs[0] || { id: 176, count: 1 };
    const costId = Math.max(0, toSafeInt(cost.id, 0));
    const costCount = Math.max(1, toSafeInt(cost.count, 1));
    player.items = player.items || {};
    if (costId > 0 && (Number(player.items[costId]) || 0) >= costCount) {
      player.items[costId] = Math.max(0, (Number(player.items[costId]) || 0) - costCount);
      if (player.items[costId] <= 0) delete player.items[costId];
      const records = normalizeRecordsMap(row.records, 44);
      records[1] = Math.max(0, toSafeInt(records[1], 0)) + Math.max(100, Math.floor(costCount * 50));
      row.records = records;
      row.score = Math.min(
        rowCfg ? Math.max(1, toSafeInt(rowCfg.indexMax, 30)) : 30,
        Math.max(0, toSafeInt(row.score, 0)) + 1,
      );
      row.record = Math.max(0, toSafeInt(row.record, 0)) + costCount;
      rewardInfo = grantRewardRows(player, [{ id: 177, count: costCount }]);
    } else {
      result = 1;
    }
  } else {
    row.record = Math.max(0, toSafeInt(row.record, 0)) + 1;
    if (module > 0) {
      rewardInfo = grantRewardRows(player, [{ id: 3, count: 10 }]);
    }
  }

  const rowIndex = ensureArray(info.datas).findIndex((it) => toSafeInt(it.id, 0) === id);
  const normalizedRow = normalizeActivityDataRow(row, activityType);
  if (rowIndex >= 0) info.datas[rowIndex] = normalizedRow;
  else info.datas.push(normalizedRow);

  await persistPlayer(session, player);

  const isActivity34Generate = activityType === 34 && module === 0;
  const isActivity37Generate = activityType === 37 && module === 1;
  const isActivity37RewardUpdate = activityType === 37
    && result === 0
    && (module === 0 || module === 2);
  const packets = [];
  if (isActivity34Generate) {
    const outcome = activity34Generate || {};
    packets.push(buildActivityAlchemyRewardPacket(
      normalizedRow,
      activityType,
      rewardInfo,
      Math.max(0, toSafeInt(outcome.count, 0)),
      { extraRewards: ensureArray(outcome.extraRewards && outcome.extraRewards.items) }
    ));
  } else if (isActivity37Generate) {
    const outcome = activity37Generate || {};
    packets.push(buildActivityAlchemyRewardPacket(
      normalizedRow,
      activityType,
      rewardInfo,
      Math.max(0, toSafeInt(outcome.count, 0)),
      {
        alchemyRewards: outcome.alchemyRewards,
        extraRewards: outcome.extraRewards,
        returnRewards: outcome.returnRewards,
      }
    ));
  } else if (isActivity37RewardUpdate) {
    packets.push(buildActivityUpdatePacket(normalizedRow, rewardInfo));
  } else if (activityType !== 34 && activityType !== 37) {
    packets.push(buildActivityUpdatePacket(normalizedRow));
  }
  packets.push(...activityPushPackets);
  if (activityType === 35) packets.push(buildActivityGrassTastePacket(normalizedRow));
  if (festivalPacket) packets.push(festivalPacket);
  const allConsumedCosts = [
    ...consumedCosts,
    ...(consumedCost && consumedCost.id > 0 ? [consumedCost] : []),
  ];
  const syncRewardRows = [...ensureArray(rewardInfo.items), ...additionalSyncRewards];
  if (syncRewardRows.length > 0 || allConsumedCosts.length > 0) {
    if (rewardInfo.items.length > 0 && activityType !== 34 && activityType !== 37) {
      packets.push(buildActivityDropPacket(normalizedRow, rewardInfo));
      if (![21, 27, 33, 35, 43, 44, 49, 52].includes(activityType)) {
        packets.push(buildActivityMultiGiftPacket(normalizedRow, rewardInfo, 1, 0));
      }
    }
    const rewardSync = buildRewardItemSync(player, syncRewardRows);
    rewardSync.items = ensureArray(rewardSync.items);
    rewardSync.changed = ensureArray(rewardSync.changed);
    allConsumedCosts.forEach((cost) => {
      const id = Math.max(0, toSafeInt(cost && cost.id, 0));
      if (id <= 0) return;
      const item = { id, count: Math.max(0, toSafeInt(cost.left, 0)) };
      const itemIndex = rewardSync.items.findIndex((row) => toSafeInt(row && row.id, 0) === id);
      if (itemIndex >= 0) rewardSync.items[itemIndex] = item;
      else rewardSync.items.push(item);
      const changedIndex = rewardSync.changed.findIndex((row) => toSafeInt(row && row.id, 0) === id);
      if (changedIndex >= 0) rewardSync.changed[changedIndex] = item;
      else rewardSync.changed.push(item);
    });
    packets.push({
      tag: 1202,
      msgUid: 0,
      data: rewardSync,
    });
  }
  packets.push({
    tag: 1700,
    msgUid,
    data: {
      result,
      id,
      module,
      index,
      param: drawParam,
      rewardInfo,
      datas: buildActivityPayload(info).datas,
    },
  });
  return packets;
}

async function handleActivityGiftCode(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1750, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };
  }

  const info = ensureActivityInfo(player);
  const giftCode = normalizeGiftCode(params.giftCode);
  if (!giftCode) {
    return { tag: 1750, msgUid, data: { result: 1, rewardInfo: buildRewardInfo([]) } };
  }

  const adminCodeEntry = await getAdminGiftCodeEntry(giftCode, player);
  if (adminCodeEntry) {
    if (adminCodeEntry.result) {
      return { tag: 1750, msgUid, data: { result: adminCodeEntry.result, rewardInfo: buildRewardInfo([]) } };
    }

    const rewardInfo = grantRewardRows(player, adminCodeEntry.rewards);
    const rewardSync = buildRewardItemSync(player, adminCodeEntry.rewards);
    adminCodeEntry.row.usedCount = Math.max(0, toSafeInt(adminCodeEntry.row.usedCount, 0)) + 1;
    adminCodeEntry.row.usedBy = ensureArray(adminCodeEntry.row.usedBy);
    adminCodeEntry.row.usedBy.push({
      userId: String(player.userId || session.userId || ''),
      playerName: String(player.name || ''),
      usedAt: new Date(),
    });
    await adminCodeEntry.row.save();
    info.giftCodeRecords[giftCode] = Date.now();
    await persistPlayer(session, player);

    return [
      { tag: 1202, msgUid: 0, data: rewardSync },
      {
        tag: 1750,
        msgUid,
        data: {
          result: 0,
          batchId: adminCodeEntry.batchId,
          rewardInfo,
        },
      },
    ];
  }

  // Validate against known gift codes — reject unknown codes (result: 3)
  const codeEntry = getValidGiftCodeEntry(giftCode);
  if (!codeEntry) {
    return { tag: 1750, msgUid, data: { result: 3, rewardInfo: buildRewardInfo([]) } };
  }

  // Prevent duplicate redemption per account
  if (info.giftCodeRecords[giftCode]) {
    return { tag: 1750, msgUid, data: { result: 2, rewardInfo: buildRewardInfo([]) } };
  }

  info.giftCodeRecords[giftCode] = Date.now();
  const batchId = buildGiftCodeBatchId(giftCode);
  const rewardRows = Array.isArray(codeEntry.rewards) && codeEntry.rewards.length > 0
    ? codeEntry.rewards
    : [{ id: 1, count: 88 }, { id: 3, count: 888 }];
  const rewardInfo = grantRewardRows(player, rewardRows);
  const rewardSync = buildRewardItemSync(player, rewardRows);
  await persistPlayer(session, player);

  return [
    { tag: 1202, msgUid: 0, data: rewardSync },
    {
      tag: 1750,
      msgUid,
      data: {
        result: 0,
        batchId,
        rewardInfo,
      },
    },
  ];
}

async function handleActivityDailyReward(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1760, msgUid, data: { result: -1, ids: [], rewardInfo: buildRewardInfo([]) } };
  }

  const info = ensureActivityInfo(player);
  const requestedIds = Array.from(
    new Set(
      ensureArray(params.aps)
        .map((v) => Math.max(0, toSafeInt(v, 0)))
        .filter((v) => v > 0)
    )
  );

  const dailyRewardCfg = ensureObject(configService.get('ConstConfig')).dailyReward || {};
  const activityPoints = Math.max(0, toSafeInt(player.items && player.items[19], 0));
  const claimed = new Set(info.dailyRewardRecords);
  const ids = requestedIds.filter((point) => (
    !claimed.has(point)
    && point <= activityPoints
    && dailyRewardCfg[point]
    && toSafeInt(dailyRewardCfg[point].id, 0) > 0
    && toSafeInt(dailyRewardCfg[point].count, 0) > 0
  ));
  const rewardRows = ids.map((point) => ({
    id: toSafeInt(dailyRewardCfg[point].id, 0),
    count: Math.max(0, toSafeInt(dailyRewardCfg[point].count, 0)),
  }));
  const merged = new Set(claimed);
  ids.forEach((id) => merged.add(id));
  info.dailyRewardRecords = Array.from(merged).sort((a, b) => a - b);

  const rewardInfo = grantRewardRows(player, rewardRows);
  const rewardSync = buildRewardItemSync(player, rewardRows);
  await persistPlayer(session, player);

  const response = {
    tag: 1760,
    msgUid,
    data: {
      result: 0,
      ids,
      rewardInfo,
    },
  };
  if (ids.length <= 0 || rewardSync.items.length <= 0) return response;
  return [
    { tag: 1202, msgUid: 0, data: rewardSync },
    response,
  ];
}

async function handleActivityGetRebate(_params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1770, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };
  }

  const info = ensureActivityInfo(player);
  const rebate = Math.max(0, toSafeInt(info.rebateValue, 0));
  if (rebate <= 0) {
    return { tag: 1770, msgUid, data: { result: 1, rewardInfo: buildRewardInfo([]) } };
  }

  info.rebateValue = 0;
  const rewardInfo = grantRewardRows(player, [{ id: 1, count: rebate }]);
  await persistPlayer(session, player);
  return { tag: 1770, msgUid, data: { result: 0, rewardInfo } };
}

async function handleMooncakeMake(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1780, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };
  }

  const info = ensureActivityInfo(player);
  const index = Math.max(0, toSafeInt(params.index, 0));
  const count = Math.max(1, toSafeInt(params.count, 1));
  const key = String(index);
  info.mooncakeRecords[key] = Math.max(0, toSafeInt(info.mooncakeRecords[key], 0)) + count;

  const rewardInfo = grantRewardRows(player, [{ id: 3, count: count * 15 }]);
  await persistPlayer(session, player);
  return { tag: 1780, msgUid, data: { result: 0, rewardInfo } };
}

async function handleActivityPetSoulInfo(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1785, msgUid, data: { result: -1, progress: 0, recordList: [] } };
  }
  const info = ensureActivityInfo(player);
  const row = upsertPetSoulProgress(info, params.id);
  await persistPlayer(session, player);
  return {
    tag: 1785,
    msgUid,
    data: { result: 0, progress: row.progress, recordList: row.recordList },
  };
}

async function handleActivityPetSoulReward(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1786, msgUid, data: { result: -1, progress: 0, recordList: [], rewardInfo: buildRewardInfo([]) } };
  }

  const info = ensureActivityInfo(player);
  const row = upsertPetSoulProgress(info, params.id);
  row.progress += 1;
  if (!row.recordList.includes(row.progress)) {
    row.recordList.push(row.progress);
    row.recordList.sort((a, b) => a - b);
  }

  const rewardInfo = grantRewardRows(player, [{ id: 3, count: 25 + row.progress * 5 }]);
  await persistPlayer(session, player);
  return {
    tag: 1786,
    msgUid,
    data: {
      result: 0,
      progress: row.progress,
      recordList: row.recordList,
      rewardInfo,
    },
  };
}

async function handleActivitySnowmanMake(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 1787,
      msgUid,
      data: { result: -1, record: { parts: [], count: 0 }, star: 0, rewardInfo: buildRewardInfo([]) },
    };
  }

  const info = ensureActivityInfo(player);
  const index = Math.max(0, toSafeInt(params.index, 0));
  const parts = ensureArray(params.parts).map((v) => Math.max(0, toSafeInt(v, 0)));
  const row = upsertSnowmanRecord(info, index);
  row.parts = parts;
  row.count = Math.max(0, toSafeInt(row.count, 0)) + 1;
  row.updateTime = Date.now();

  const star = parts.reduce((sum, part) => sum + (part > 0 ? 1 : 0), 0);
  await persistPlayer(session, player);
  return {
    tag: 1787,
    msgUid,
    data: {
      result: 0,
      record: row,
      star,
      rewardInfo: buildRewardInfo([]),
    },
  };
}

async function handleActivitySnowmanUploadDesign(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1788, msgUid, data: { result: -1 } };
  }
  const info = ensureActivityInfo(player);
  upsertSnowmanDesignSelf(info, player, params.parts);
  await persistPlayer(session, player);
  return { tag: 1788, msgUid, data: { result: 0 } };
}

function handleActivitySnowmanDesignList(_params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1789, msgUid, data: { design: [] } };
  }
  const info = ensureActivityInfo(player);
  return { tag: 1789, msgUid, data: { design: ensureArray(info.snowman.designList) } };
}

async function handleActivitySnowmanLike(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1790, msgUid, data: { result: -1, playerId: '', like: 0, rewardInfo: buildRewardInfo([]) } };
  }
  const info = ensureActivityInfo(player);
  const playerId = params.playerId == null ? '' : String(params.playerId);
  if (!playerId) {
    return { tag: 1790, msgUid, data: { result: 1, playerId: '', like: 0, rewardInfo: buildRewardInfo([]) } };
  }
  if (info.snowman.likedPlayers[playerId]) {
    return { tag: 1790, msgUid, data: { result: 2, playerId, like: 0, rewardInfo: buildRewardInfo([]) } };
  }

  info.snowman.likedPlayers[playerId] = Date.now();
  const row = ensureArray(info.snowman.designList).find((it) => String(it && it.dbid) === playerId);
  if (row) row.like = Math.max(0, toSafeInt(row.like, 0)) + 1;
  if (String(info.snowman.designInfo.dbid) === playerId) {
    info.snowman.designInfo.like = Math.max(0, toSafeInt(info.snowman.designInfo.like, 0)) + 1;
  }
  const like = row
    ? Math.max(0, toSafeInt(row.like, 0))
    : (String(info.snowman.designInfo.dbid) === playerId
      ? Math.max(0, toSafeInt(info.snowman.designInfo.like, 0))
      : 1);

  const rewardInfo = grantRewardRows(player, [{ id: 3, count: 30 }]);
  await persistPlayer(session, player);
  return { tag: 1790, msgUid, data: { result: 0, playerId, like, rewardInfo } };
}

function handleActivitySnowmanDesignInfo(_params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 1791, msgUid, data: { design: [], like: 0, dbid: '', name: '', updateTime: 0 } };
  }
  const info = ensureActivityInfo(player);
  return { tag: 1791, msgUid, data: normalizeSnowmanDesignRow(info.snowman.designInfo) };
}

module.exports = {
  ensureActivityInfo,
  buildActivityPayload,
  isActivityWindowOpen,
  setActivityEntryEnabled,
  buildActivityDropPacket,
  buildActivityClosePacket,
  buildActivityMonopolyFatePacket,
  buildActivityMultiGiftPacket,
  buildActivityGrassTastePacket,
  buildActivityBoxDrawPacket,
  buildSecretTreasurePackets,
  buildKnifeDrawInfoPacket,
  buildKnifeDrawWinPacket,
  buildFishKingRankPacket,
  buildFishSceneSalvagePacket,
  buildFishSceneBottleContentPacket,
  buildFuluDrawPacket,
  handleActivityOperate,
  handleActivityGiftCode,
  handleActivityDailyReward,
  handleActivityGetRebate,
  handleMooncakeMake,
  handleActivityPetSoulInfo,
  handleActivityPetSoulReward,
  handleActivitySnowmanMake,
  handleActivitySnowmanUploadDesign,
  handleActivitySnowmanDesignList,
  handleActivitySnowmanLike,
  handleActivitySnowmanDesignInfo,
};
