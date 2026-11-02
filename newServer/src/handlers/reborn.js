/**
 * Reborn simulation handlers
 * tag: 5500~5509
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const { addRewardToPlayer } = require('./raid');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function normalizeObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function ensureArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function hasObjectData(raw) {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length > 0;
}

function pickBornEntryIds(count = 3, excluded = []) {
  const cfg = config.get('RebornSimBornEntryConfig') || {};
  const excludedSet = new Set(ensureArray(excluded).map((id) => toSafeInt(id, 0)));
  const pool = Object.keys(cfg)
    .map((key) => {
      const row = normalizeObject(cfg[key]);
      return {
        id: Math.max(0, toSafeInt(row.id, toSafeInt(key, 0))),
        weight: Math.max(1, toSafeInt(row.weight, 1)),
      };
    })
    .filter((row) => row.id > 0 && !excludedSet.has(row.id));
  const picked = [];
  const limit = Math.max(0, toSafeInt(count, 0));
  while (pool.length > 0 && picked.length < limit) {
    const totalWeight = pool.reduce((sum, row) => sum + row.weight, 0);
    let roll = Math.random() * totalWeight;
    let index = 0;
    for (; index < pool.length - 1; index += 1) {
      roll -= pool[index].weight;
      if (roll < 0) break;
    }
    picked.push(pool[index].id);
    pool.splice(index, 1);
  }
  return picked;
}

function getRebornLastNameIds() {
  const cfg = config.get('RebornSimNameConfig') || {};
  return Object.keys(cfg)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
}

function getRebornFirstNameIds() {
  const cfg = config.get('RebornSimFirstNameConfig') || {};
  return Object.keys(cfg)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => id > 0)
    .sort((a, b) => a - b);
}

function pickRandomId(ids = [], fallback = 1) {
  if (!Array.isArray(ids) || ids.length === 0) return Math.max(1, toSafeInt(fallback, 1));
  const index = Math.max(0, Math.min(ids.length - 1, Math.floor(Math.random() * ids.length)));
  return Math.max(1, toSafeInt(ids[index], Math.max(1, toSafeInt(fallback, 1))));
}

function ensureRebornNameFields(data = {}) {
  const target = normalizeObject(data);
  const lastNameIds = getRebornLastNameIds();
  const firstNameIds = getRebornFirstNameIds();
  target.name = Math.max(1, toSafeInt(target.name, pickRandomId(lastNameIds, 1)));
  target.firstName = Math.max(1, toSafeInt(target.firstName, pickRandomId(firstNameIds, 1)));
  return target;
}

function getPlayerRebornGender(player = {}) {
  const roleInfo = normalizeObject(player.roleInfo);
  return Math.max(0, Math.min(1, toSafeInt(roleInfo.gender, toSafeInt(player.gender, 0))));
}

function getDefaultRebornRace() {
  const baseCfg = config.get('RebornSimBaseConfig') || {};
  const raceWeight = ensureArray(baseCfg.raceWeight)
    .map((row) => ({
      value: Math.max(0, toSafeInt(row && row.value, 0)),
      count: Math.max(0, toSafeInt(row && (row.weight != null ? row.weight : row.count), 0)),
    }))
    .filter((row) => row.value > 0 && row.count > 0);
  if (raceWeight.length === 0) return 1;
  const pool = [];
  raceWeight.forEach((row) => {
    for (let i = 0; i < row.count; i += 1) pool.push(row.value);
  });
  return pickRandomId(pool, raceWeight[0].value);
}

function ensureRebornRoundDataShape(data = {}, player = {}) {
  const target = ensureRebornNameFields(normalizeObject(data));
  target.gender = Math.max(0, Math.min(1, toSafeInt(target.gender, getPlayerRebornGender(player))));
  target.race = Math.max(1, toSafeInt(target.race, getDefaultRebornRace()));
  target.bag = Math.max(0, toSafeInt(target.bag, 0));
  target.branch = Math.max(0, toSafeInt(target.branch, 0));
  target.year = Math.max(1, toSafeInt(target.year, 1));
  target.stage = Math.max(1, toSafeInt(target.stage, 1));
  target.attr = normalizeObject(target.attr);
  target.entryList = ensureArray(target.entryList);
  target.eventList = ensureArray(target.eventList);
  target.eventButtonMap = normalizeObject(target.eventButtonMap);
  target.adRevive = Math.max(0, toSafeInt(target.adRevive, 0));
  target.currentEvent = Math.max(0, toSafeInt(target.currentEvent, 101));
  target.roundState = Math.max(0, toSafeInt(target.roundState, 1));
  target.score = calculateRebornScore(target.attr);
  target.rebornTime = Math.max(0, toSafeInt(target.rebornTime, 0));
  target.isDead = Math.max(0, Math.min(1, toSafeInt(target.isDead, 0)));
  target.finish = Math.max(0, Math.min(1, toSafeInt(target.finish, 0)));
  return target;
}

function ensureRebornInitDataShape(data = {}, chapterFallback = 1, bagFallback = 0) {
  const target = normalizeObject(data);
  target.chapter = Math.max(1, toSafeInt(target.chapter, chapterFallback));
  target.bag = Math.max(0, toSafeInt(target.bag, bagFallback));
  target.entryPoolList = ensureArray(target.entryPoolList)
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .filter((id) => id > 0);
  target.selectedEntries = ensureArray(target.selectedEntries)
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .filter((id) => id > 0);
  target.attrMap = normalizeObject(target.attrMap);
  target.adRefresh = Math.max(0, toSafeInt(target.adRefresh, 0));
  target.adTalent = Math.max(0, toSafeInt(target.adTalent, 0));
  target.totalTalent = Math.max(0, toSafeInt(target.totalTalent, 0));
  target.entryChooseTime = Math.max(0, toSafeInt(target.entryChooseTime, 0));
  return target;
}

function calculateRebornScore(attrMap = {}) {
  const attrCfg = config.get('RebornSimAttrConfig') || {};
  return Object.keys(normalizeObject(attrMap)).reduce((sum, key) => {
    const row = normalizeObject(attrCfg[String(key)]);
    return sum + Math.max(0, toSafeInt(row.score, 0)) * toSafeInt(attrMap[key], 0);
  }, 0);
}

function getChapterCfg(chapter) {
  const chapterCfg = config.get('RebornSimChapterConfig') || {};
  return normalizeObject(chapterCfg[String(chapter)]);
}

function calcBagMax(clearChapter) {
  const baseCfg = config.get('RebornSimBaseConfig') || {};
  const rows = ensureArray(baseCfg.openBag)
    .map((row) => ({
      id: Math.max(0, toSafeInt(row && row.id, 0)),
      value: Math.max(1, toSafeInt(row && row.value, 1)),
    }))
    .sort((a, b) => a.id - b.id);

  let bagMax = 7;
  for (const row of rows) {
    if (clearChapter >= row.id) {
      bagMax = row.value;
    }
  }
  return bagMax;
}

function createInitData(chapter, bag) {
  const chapterCfg = getChapterCfg(chapter);
  const baseCfg = config.get('RebornSimBaseConfig') || {};
  const entryNum = Math.max(1, toSafeInt(baseCfg.entryNum, 3));
  return ensureRebornInitDataShape({
    chapter,
    bag,
    entryPoolList: pickBornEntryIds(entryNum),
    selectedEntries: [],
    attrMap: {},
    adRefresh: 0,
    adTalent: 0,
    totalTalent: Math.max(0, toSafeInt(chapterCfg.initialTalentPoint, 5)),
    entryChooseTime: Math.max(0, toSafeInt(chapterCfg.initialEntryChooseTime, 1)),
  }, chapter, bag);
}

function applyEntryAttr(attrMap, entryId) {
  const bornCfg = config.get('RebornSimBornEntryConfig') || {};
  const advCfg = config.get('RebornSimAdvEntryConfig') || {};
  const row = normalizeObject(bornCfg[String(entryId)] || advCfg[String(entryId)]);
  const changes = ensureArray(row.propertyChange);
  for (const change of changes) {
    const attrId = Math.max(0, toSafeInt(change && change.id, 0));
    if (attrId <= 0) continue;
    const count = toSafeInt(change && change.count, 0);
    const key = String(attrId);
    attrMap[key] = Math.max(0, toSafeInt(attrMap[key], 0) + count);
  }
}

function mergeTalentAttrMap(baseMap = {}, extraMap = {}) {
  const result = { ...normalizeObject(baseMap) };
  const extra = normalizeObject(extraMap);
  Object.keys(extra).forEach((key) => {
    const attrId = Math.max(0, toSafeInt(key, 0));
    if (attrId <= 0) return;
    result[String(attrId)] = Math.max(0, toSafeInt(result[String(attrId)], 0) + Math.max(0, toSafeInt(extra[key], 0)));
  });
  return result;
}

function createRoundData(initData, selectedAttr = 0, player = {}) {
  let attrMap = normalizeObject(initData.attrMap);
  if (selectedAttr && typeof selectedAttr === 'object' && !Array.isArray(selectedAttr)) {
    attrMap = mergeTalentAttrMap(attrMap, selectedAttr);
  } else {
    const selectedAttrId = Math.max(0, toSafeInt(selectedAttr, 0));
    if (selectedAttrId > 0) {
      const key = String(selectedAttrId);
      attrMap[key] = Math.max(0, toSafeInt(attrMap[key], 0) + 1);
    }
  }

  return ensureRebornRoundDataShape({
    chapter: Math.max(1, toSafeInt(initData.chapter, 1)),
    bag: Math.max(0, toSafeInt(initData.bag, 0)),
    year: 1,
    stage: 1,
    score: 0,
    currentEvent: 101,
    attr: attrMap,
    entryList: ensureArray(initData.selectedEntries),
    events: [],
    eventList: [],
    eventButtonMap: {},
    adRevive: 0,
    roundState: 1,
    rebornTime: 0,
    isDead: 0,
    finish: 0,
  }, player);
}

function buildRewardInfo(items = []) {
  return {
    items: ensureArray(items),
    equips: [],
    swords: [],
    pets: [],
    artifacts: [],
    gems: [],
    bloodline: [],
    valhalla: [],
  };
}

function ensureRebornInfo(player = {}) {
  player.other_attr_info = normalizeObject(player.other_attr_info);
  const holder = player.other_attr_info;
  holder.rebornSimInfo = normalizeObject(holder.rebornSimInfo);
  const info = holder.rebornSimInfo;

  info.open = toSafeInt(info.open, 1) > 0 ? 1 : 0;
  info.clearChapter = Math.max(0, toSafeInt(info.clearChapter, 0));
  info.rewardChapter = Math.max(0, toSafeInt(info.rewardChapter, 0));
  info.bagMax = Math.max(1, toSafeInt(info.bagMax, calcBagMax(info.clearChapter)));
  info.oldData = ensureArray(info.oldData).map((row) => ensureRebornRoundDataShape(normalizeObject(row), player));
  info.dailyChapterReward = normalizeObject(info.dailyChapterReward);
  info.currentInit = hasObjectData(info.currentInit)
    ? ensureRebornInitDataShape(info.currentInit)
    : null;
  info.currentData = hasObjectData(info.currentData)
    ? ensureRebornRoundDataShape(info.currentData, player)
    : null;

  return info;
}

function buildRebornPayload(info) {
  return {
    open: toSafeInt(info.open, 1) > 0 ? 1 : 0,
    clearChapter: Math.max(0, toSafeInt(info.clearChapter, 0)),
    rewardChapter: Math.max(0, toSafeInt(info.rewardChapter, 0)),
    bagMax: Math.max(1, toSafeInt(info.bagMax, 7)),
    oldData: ensureArray(info.oldData),
    dailyChapterReward: normalizeObject(info.dailyChapterReward),
    currentInit: hasObjectData(info.currentInit) ? ensureRebornInitDataShape(info.currentInit) : null,
    currentData: hasObjectData(info.currentData) ? ensureRebornRoundDataShape(info.currentData) : null,
  };
}

function buildEmptyRoundData(player = {}) {
  return ensureRebornRoundDataShape({
    chapter: 1,
    bag: 0,
    attr: {},
    entryList: [],
    eventList: [],
    eventButtonMap: {},
    currentEvent: 0,
    roundState: 0,
  }, player);
}

function getCurrentInitData(info, chapter = 1, bag = 0) {
  return hasObjectData(info.currentInit)
    ? ensureRebornInitDataShape(info.currentInit, chapter, bag)
    : createInitData(chapter, bag);
}

function getCurrentRoundData(info, player = {}) {
  if (hasObjectData(info.currentData)) return ensureRebornRoundDataShape(info.currentData, player);
  return createRoundData(getCurrentInitData(info, 1, 0), 0, player);
}

function applyRebornEventRewards(roundData, rawRewards = []) {
  const advCfg = config.get('RebornSimAdvEntryConfig') || {};
  for (const reward of ensureArray(rawRewards)) {
    const type = Math.max(0, toSafeInt(reward && reward[0], 0));
    const id = Math.max(0, toSafeInt(reward && reward[1], 0));
    const count = toSafeInt(reward && reward[2], 0);
    if (type === 1 && id > 0) {
      const key = String(id);
      roundData.attr[key] = Math.max(0, toSafeInt(roundData.attr[key], 0) + count);
    } else if (type === 3 && id > 0) {
      const row = normalizeObject(advCfg[String(id)]);
      if (!roundData.entryList.includes(id)) roundData.entryList.push(id);
      for (const change of ensureArray(row.propertyChange)) {
        const attrId = Math.max(0, toSafeInt(change && change.id, 0));
        if (attrId <= 0) continue;
        const key = String(attrId);
        roundData.attr[key] = Math.max(0, toSafeInt(roundData.attr[key], 0) + toSafeInt(change.count, 0));
      }
    }
  }
  roundData.score = calculateRebornScore(roundData.attr);
}

function pickNextRebornEvent(nextGroup, branch = 0) {
  const eventCfg = config.get('RebornSimEventConfig') || {};
  const group = toSafeInt(nextGroup, -1);
  if (group < 0) return null;
  let candidates = Object.values(eventCfg).filter((row) => toSafeInt(row && row.eventGroup, -1) === group);
  const safeBranch = Math.max(0, toSafeInt(branch, 0));
  if (safeBranch > 0) {
    const sameBranch = candidates.filter((row) => toSafeInt(row && row.eventBranch, 0) === safeBranch);
    if (sameBranch.length > 0) candidates = sameBranch;
  }
  if (candidates.length <= 0) return null;
  return normalizeObject(candidates[Math.floor(Math.random() * candidates.length)]);
}

function resolveRebornNextGroup(eventCfg = {}, buttonId = 0) {
  const relateButton = Math.max(0, toSafeInt(eventCfg.relateButton, 0));
  if (relateButton <= 0) return toSafeInt(eventCfg.nextGroup, -1);

  const buttonCfg = config.get('RebornSimEventButtonConfig') || {};
  const root = normalizeObject(buttonCfg[String(relateButton)]);
  const selectedId = Math.max(0, toSafeInt(buttonId, 0));
  if (!ensureArray(root.typeValue).map((id) => toSafeInt(id, 0)).includes(selectedId)) return null;
  const selected = normalizeObject(buttonCfg[String(selectedId)]);
  return Object.keys(selected).length > 0 ? toSafeInt(selected.nextGroup, -1) : null;
}

function buildRebornUpdateData(roundData = {}, player = {}) {
  return ensureRebornRoundDataShape(roundData, player);
}

function getChapterRewards(chapter) {
  const chapterCfg = getChapterCfg(chapter);
  return ensureArray(chapterCfg.rewards)
    .map((row) => ({
      id: Math.max(0, toSafeInt(row && row.id, 0)),
      count: Math.max(0, toSafeInt(row && row.count, 0)),
    }))
    .filter((row) => row.id > 0 && row.count > 0);
}

function normalizeItemRewards(raw = []) {
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

function getRebornResourceCount(player = {}, itemId = 0) {
  const id = Math.max(0, toSafeInt(itemId, 0));
  const currencyKey = getCurrencyKeyById(id);
  if (currencyKey) return Math.max(0, toSafeInt(player && player.currencies && player.currencies[currencyKey], 0));
  return Math.max(0, toSafeInt(player && player.items && player.items[id], 0));
}

function consumeRebornCosts(player = {}, rawCosts = []) {
  const costs = normalizeItemRewards(rawCosts);
  if (costs.some((row) => getRebornResourceCount(player, row.id) < row.count)) return false;
  for (const row of costs) {
    const currencyKey = getCurrencyKeyById(row.id);
    if (currencyKey) {
      player.currencies = normalizeObject(player.currencies);
      player.currencies[currencyKey] = Math.max(0, toSafeInt(player.currencies[currencyKey], 0) - row.count);
    } else {
      player.items = normalizeObject(player.items);
      player.items[String(row.id)] = Math.max(0, toSafeInt(player.items[String(row.id)], 0) - row.count);
    }
  }
  return true;
}

function getGmt8DayKey(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function persistPlayer(session, player) {
  if (!session || !session.userId) return;
  const saved = await playerService.savePlayer(session.userId, player);
  if (saved && typeof saved === 'object') {
    session.player = saved;
  }
}

async function handleRebornStart(params = {}, session = {}, msgUid) {
  const player = session.player;
  const chapter = Math.max(1, toSafeInt(params.chapter, 1));
  const bag = Math.max(0, toSafeInt(params.bag, 0));
  if (!player) {
    return { tag: 5500, msgUid, data: { result: -1, initData: createInitData(chapter, bag) } };
  }

  const info = ensureRebornInfo(player);
  const initData = createInitData(chapter, bag);

  info.currentInit = initData;
  info.currentData = null;
  await persistPlayer(session, player);

  return {
    tag: 5500,
    msgUid,
    data: {
      result: 0,
      initData,
    },
  };
}

async function handleRebornDeleteCharacter(params = {}, session = {}, msgUid) {
  const player = session.player;
  const bag = Math.max(0, toSafeInt(params.bag, 0));
  if (!player) return { tag: 5501, msgUid, data: { result: -1, bag } };

  const info = ensureRebornInfo(player);
  info.oldData = ensureArray(info.oldData).filter((row) => toSafeInt(row && row.bag, -1) !== bag);
  await persistPlayer(session, player);

  return {
    tag: 5501,
    msgUid,
    data: {
      result: 0,
      bag,
    },
  };
}

async function handleRebornSelectEntry(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) return { tag: 5502, msgUid, data: { result: -1, entryPoolList: [], selectedEntries: [], attr: {} } };

  const info = ensureRebornInfo(player);
  const initData = getCurrentInitData(info, 1, 0);

  const entry = Math.max(0, toSafeInt(params.entry, 0));
  initData.selectedEntries = ensureArray(initData.selectedEntries);
  initData.entryPoolList = ensureArray(initData.entryPoolList);
  const bornCfg = config.get('RebornSimBornEntryConfig') || {};
  const chapterCfg = getChapterCfg(initData.chapter);
  const chooseLimit = Math.max(0, toSafeInt(chapterCfg.initialEntryChooseTime, initData.entryChooseTime));
  const validEntry = entry > 0
    && !!bornCfg[String(entry)]
    && initData.entryPoolList.includes(entry)
    && !initData.selectedEntries.includes(entry)
    && (chooseLimit <= 0 || initData.selectedEntries.length < chooseLimit);
  if (validEntry) {
    initData.selectedEntries.push(entry);
    applyEntryAttr(initData.attrMap, entry);
  }
  if (validEntry) initData.entryPoolList = initData.entryPoolList.filter((entryId) => entryId !== entry);

  info.currentInit = initData;
  await persistPlayer(session, player);

  return {
    tag: 5502,
    msgUid,
    data: {
      result: validEntry ? 0 : 1,
      entryPoolList: ensureArray(initData.entryPoolList),
      selectedEntries: ensureArray(initData.selectedEntries),
      attr: normalizeObject(initData.attrMap),
    },
  };
}

async function handleRebornRefreshEntries(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) return { tag: 5503, msgUid, data: { result: -1, adRefresh: 0, entryPoolList: [] } };

  const info = ensureRebornInfo(player);
  const initData = getCurrentInitData(info, 1, 0);
  const ad = toSafeInt(params.ad, 0) > 0 ? 1 : 0;
  let result = 0;
  if (ad > 0) {
    if (Math.max(0, toSafeInt(initData.adRefresh, 0)) > 0) result = 1;
    else initData.adRefresh = 1;
  } else {
    const baseCfg = normalizeObject(config.get('RebornSimBaseConfig'));
    const freeLimit = Math.max(0, toSafeInt(baseCfg.freeEntryTime, 0));
    const freeUsed = Math.max(0, toSafeInt(initData.freeRefreshUsed, 0));
    if (freeUsed < freeLimit) initData.freeRefreshUsed = freeUsed + 1;
    else if (!consumeRebornCosts(player, baseCfg.entryRethrow)) result = 1;
  }

  if (result === 0) {
    const baseCfg = normalizeObject(config.get('RebornSimBaseConfig'));
    const entryNum = Math.max(1, toSafeInt(baseCfg.entryNum, 3));
    initData.entryPoolList = pickBornEntryIds(entryNum, initData.selectedEntries);
  }
  info.currentInit = initData;
  await persistPlayer(session, player);

  return {
    tag: 5503,
    msgUid,
    data: {
      result,
      adRefresh: Math.max(0, toSafeInt(initData.adRefresh, 0)),
      entryPoolList: ensureArray(initData.entryPoolList),
    },
  };
}

async function handleRebornAttrSelect(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) return { tag: 5504, msgUid, data: { result: -1, roundData: buildEmptyRoundData() } };

  const info = ensureRebornInfo(player);
  const initData = getCurrentInitData(info, 1, 0);

  const selectedAttr = params && params.attr;
  const selectedAttrMap = selectedAttr && typeof selectedAttr === 'object' && !Array.isArray(selectedAttr)
    ? mergeTalentAttrMap({}, selectedAttr)
    : null;
  if (selectedAttrMap) {
    initData.attrMap = mergeTalentAttrMap(initData.attrMap, selectedAttrMap);
  } else {
    const selectedAttrId = Math.max(0, toSafeInt(selectedAttr, 0));
    if (selectedAttrId > 0) {
      initData.attrMap = mergeTalentAttrMap(initData.attrMap, { [selectedAttrId]: 1 });
    }
  }
  const roundData = createRoundData(initData, 0, player);
  info.currentInit = null;
  info.currentData = roundData;
  await persistPlayer(session, player);

  return {
    tag: 5504,
    msgUid,
    data: {
      result: 0,
      roundData,
    },
  };
}

async function handleRebornAttrAdd(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) return { tag: 5505, msgUid, data: { result: -1, adTalent: 0, totalTalent: 0 } };

  const info = ensureRebornInfo(player);
  const initData = getCurrentInitData(info, 1, 0);

  const ad = toSafeInt(params.ad, 0) > 0 ? 1 : 0;
  let result = 0;
  if (ad > 0) {
    if (Math.max(0, toSafeInt(initData.adTalent, 0)) > 0) result = 1;
    else {
      initData.adTalent = 1;
      initData.totalTalent = Math.max(0, toSafeInt(initData.totalTalent, 0)) + 1;
    }
  }

  info.currentInit = initData;
  await persistPlayer(session, player);

  return {
    tag: 5505,
    msgUid,
    data: {
      result,
      adTalent: Math.max(0, toSafeInt(initData.adTalent, 0)),
      totalTalent: Math.max(0, toSafeInt(initData.totalTalent, 0)),
    },
  };
}

async function handleRebornHandleEvent(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 5506, msgUid, data: { result: -1, updateData: buildEmptyRoundData() } };
  }

  const info = ensureRebornInfo(player);
  const currentData = getCurrentRoundData(info, player);

  const eventId = Math.max(0, toSafeInt(params.eventId, 0));
  const buttonId = Math.max(0, toSafeInt(params.buttonId, 0));
  const eventCfgMap = config.get('RebornSimEventConfig') || {};
  const eventCfg = normalizeObject(eventCfgMap[String(eventId)]);
  const currentEvent = Math.max(0, toSafeInt(currentData.currentEvent, 0));
  const nextGroup = resolveRebornNextGroup(eventCfg, buttonId);

  if (Object.keys(eventCfg).length <= 0 || (currentEvent > 0 && currentEvent !== eventId) || nextGroup == null) {
    return {
      tag: 5506,
      msgUid,
      data: { result: 1, updateData: buildRebornUpdateData(currentData, player) },
    };
  }

  currentData.eventList = ensureArray(currentData.eventList);
  currentData.eventList.push({ eventId, success: 1 });
  currentData.eventButtonMap = normalizeObject(currentData.eventButtonMap);
  if (buttonId > 0) currentData.eventButtonMap[String(eventId)] = buttonId;
  applyRebornEventRewards(currentData, eventCfg.rewards);

  const nextEvent = pickNextRebornEvent(nextGroup, currentData.branch);
  if (nextEvent) {
    const nextBranch = Math.max(0, toSafeInt(nextEvent.eventBranch, 0));
    if (Math.max(0, toSafeInt(currentData.branch, 0)) <= 0 && nextBranch > 0) currentData.branch = nextBranch;
    currentData.year = Math.max(1, toSafeInt(currentData.year, 1)
      + (Math.max(0, toSafeInt(nextEvent.year, 0)) > 0 ? 1 : 0));
    currentData.currentEvent = Math.max(0, toSafeInt(nextEvent.eventId, 0));
    currentData.roundState = toSafeInt(nextEvent.eventSort, 0) === 9 ? 2 : 1;
    currentData.isDead = currentData.roundState === 2 ? 1 : 0;
  } else {
    currentData.currentEvent = 0;
    currentData.roundState = 3;
    currentData.finish = 1;
  }

  if (toSafeInt(eventCfg.eventSort, 0) === 3 && currentData.roundState !== 2) {
    currentData.stage = Math.max(1, toSafeInt(currentData.stage, 1) + 1);
  }
  const updateData = buildRebornUpdateData(currentData, player);
  info.currentData = currentData;
  await persistPlayer(session, player);

  return {
    tag: 5506,
    msgUid,
    data: {
      result: 0,
      updateData,
    },
  };
}

async function handleRebornRoundEnd(_params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 5507,
      msgUid,
      data: {
        result: -1,
        success: false,
        bagMax: 7,
        dailyChapterReward: {},
        rewardChapter: 0,
        roundData: buildEmptyRoundData(),
        rewardInfo: buildRewardInfo([]),
      },
    };
  }

  const info = ensureRebornInfo(player);
  const roundData = getCurrentRoundData(info, player);

  roundData.finish = 1;
  roundData.rebornTime = Date.now();
  roundData.score = calculateRebornScore(roundData.attr);

  const chapter = Math.max(1, toSafeInt(roundData.chapter, 1));
  const chapterCfg = getChapterCfg(chapter);
  const victoryScore = Math.max(0, toSafeInt(chapterCfg.victoryScore, 0));
  const success = victoryScore <= 0 || toSafeInt(roundData.score, 0) >= victoryScore;
  if (success) {
    info.clearChapter = Math.max(info.clearChapter, chapter);
  }

  const bag = Math.max(0, toSafeInt(roundData.bag, 0));
  const record = ensureRebornRoundDataShape(JSON.parse(JSON.stringify(roundData)), player);
  info.oldData = ensureArray(info.oldData).filter((row) => toSafeInt(row && row.bag, -1) !== bag);
  info.oldData.push(record);

  info.bagMax = calcBagMax(info.clearChapter);
  const today = getGmt8DayKey();
  if (String(info.dailyRewardDay || '') !== today) {
    info.dailyRewardDay = today;
    info.dailyChapterReward = {};
  }
  info.dailyChapterReward = normalizeObject(info.dailyChapterReward);
  const baseCfg = normalizeObject(config.get('RebornSimBaseConfig'));
  const dailyLimit = Math.max(0, toSafeInt(baseCfg.dailyRewardCount, 0));
  const claimedCount = Math.max(0, toSafeInt(info.dailyChapterReward[String(chapter)], 0));
  const rewards = claimedCount < dailyLimit ? normalizeItemRewards(baseCfg.dailyRewards) : [];
  if (rewards.length > 0) {
    rewards.forEach((reward) => addRewardToPlayer(player, reward.id, reward.count));
    info.dailyChapterReward[String(chapter)] = claimedCount + 1;
  }
  info.currentInit = null;
  info.currentData = null;
  await persistPlayer(session, player);

  return {
    tag: 5507,
    msgUid,
    data: {
      result: 0,
      success,
      bagMax: info.bagMax,
      dailyChapterReward: info.dailyChapterReward,
      rewardChapter: info.rewardChapter,
      roundData,
      rewardInfo: buildRewardInfo(rewards),
    },
  };
}

async function handleRebornRevive(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 5508, msgUid, data: { result: -1, updateData: buildEmptyRoundData() } };
  }

  const info = ensureRebornInfo(player);
  const currentData = getCurrentRoundData(info, player);
  currentData.isDead = 0;
  currentData.finish = 0;
  currentData.adRevive = Math.max(1, toSafeInt(currentData.adRevive, 0));
  currentData.currentEvent = 1;
  currentData.roundState = 1;
  currentData.rebornTime = Date.now();
  const updateData = buildRebornUpdateData(currentData, player);
  info.currentData = currentData;
  await persistPlayer(session, player);

  return {
    tag: 5508,
    msgUid,
    data: {
      result: 0,
      updateData,
    },
  };
}

async function handleRebornClaimChapterReward(_params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 5509,
      msgUid,
      data: { result: -1, rewardChapter: 0, rewardInfo: buildRewardInfo([]) },
    };
  }

  const info = ensureRebornInfo(player);
  let nextChapter = Math.max(0, toSafeInt(info.rewardChapter, 0)) + 1;
  if (nextChapter > Math.max(0, toSafeInt(info.clearChapter, 0))) {
    nextChapter = Math.max(0, toSafeInt(info.rewardChapter, 0));
    return {
      tag: 5509,
      msgUid,
      data: {
        result: -1,
        rewardChapter: nextChapter,
        rewardInfo: buildRewardInfo([]),
      },
    };
  }

  const rewards = getChapterRewards(nextChapter);
  for (const reward of rewards) {
    addRewardToPlayer(player, reward.id, reward.count);
  }

  info.rewardChapter = nextChapter;
  await persistPlayer(session, player);

  return {
    tag: 5509,
    msgUid,
    data: {
      result: 0,
      rewardChapter: info.rewardChapter,
      rewardInfo: buildRewardInfo(rewards),
    },
  };
}

module.exports = {
  ensureRebornInfo,
  buildRebornPayload,
  handleRebornStart,
  handleRebornDeleteCharacter,
  handleRebornSelectEntry,
  handleRebornRefreshEntries,
  handleRebornAttrSelect,
  handleRebornAttrAdd,
  handleRebornHandleEvent,
  handleRebornRoundEnd,
  handleRebornRevive,
  handleRebornClaimChapterReward,
};
