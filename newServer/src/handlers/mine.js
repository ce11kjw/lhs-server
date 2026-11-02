const configService = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const battleService = require('../services/BattleService');
const { addRewardToPlayer } = require('./raid');

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function clonePlain(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

function getMineBaseConfig() {
  return configService.get('MineBaseConfig') || {};
}

function getMineBlockConfig() {
  return configService.get('MineBlockConfig') || {};
}

function isRenderableBlockId(id) {
  const cfg = getMineBlockConfig()[id] || getMineBlockConfig()[String(id)];
  return !!(cfg && Array.isArray(cfg.picTimeRes) && cfg.picTimeRes.length > 0);
}

function getRenderableBlockIds() {
  const blockCfg = getMineBlockConfig();
  return Object.keys(blockCfg)
    .map((id) => toSafeInt(id, 0))
    .filter((id) => id > 0 && isRenderableBlockId(id));
}

function buildEmptyRewardInfo(items = []) {
  return {
    items: Array.isArray(items) ? items : [],
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

function createBlock(uid, id, meter, col) {
  return {
    uid,
    id,
    status: 0,
    meter,
    col,
    digCount: 0,
    eventId: 0,
  };
}

function createDefaultMineLevel(levelId = 0) {
  const rows = levelId > 0 ? 7 : 10;
  const validBlockIds = getRenderableBlockIds();
  const fallbackId = validBlockIds[0] || 1;
  const ids = validBlockIds.length > 0 ? validBlockIds : [fallbackId];
  const colPatterns = [
    [0, 1, 3, 5, 7],
    [0, 2, 3, 5],
    [0, 1, 3, 5, 6],
    [0, 2, 3, 5],
    [0, 2, 4, 5, 6],
  ];

  const blocks = [];
  let uid = 1;
  for (let meter = 0; meter < rows; meter += 1) {
    const rowMeter = 7 + meter * 2;
    const cols = colPatterns[meter % colPatterns.length];
    for (const col of cols) {
      const id = ids[(meter + col) % ids.length];
      const block = createBlock(uid, id, rowMeter, col);
      if (id === 4 && uid % 3 === 0) block.eventId = 20001;
      else if (id === 4 && uid % 2 === 0) block.eventId = 10001;
      blocks.push(block);
      uid += 1;
    }
  }

  return {
    levelId,
    meter: 6,
    playerMeter: 3,
    playerCol: 3,
    blocks,
    events: [],
    shopGoods: {},
    finish: false,
    boxCounter: 0,
    boxRewardCount: 0,
  };
}

function normalizeMineBlock(block, fallbackId = 1) {
  const row = block && typeof block === 'object' && !Array.isArray(block) ? block : {};
  const id = toSafeInt(row.id, fallbackId);
  return {
    uid: Math.max(1, toSafeInt(row.uid, 1)),
    id: isRenderableBlockId(id) ? id : fallbackId,
    status: Math.max(0, toSafeInt(row.status, 0)),
    meter: Math.max(0, toSafeInt(row.meter, 0)),
    col: Math.max(0, toSafeInt(row.col, 0)),
    digCount: Math.max(0, toSafeInt(row.digCount, 0)),
    eventId: Math.max(0, toSafeInt(row.eventId, 0)),
  };
}

function normalizeMineEvent(event, uid) {
  const row = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  return {
    uid: Math.max(1, toSafeInt(row.uid, uid)),
    id: Math.max(0, toSafeInt(row.id, 10001)),
    useTime: Math.max(0, toSafeInt(row.useTime, toSafeInt(row.status, 0))),
  };
}

function normalizeMineLevel(level) {
  const source = level && typeof level === 'object' && !Array.isArray(level)
    ? level
    : createDefaultMineLevel(0);
  const validBlockIds = getRenderableBlockIds();
  const fallbackId = validBlockIds[0] || 1;
  if (!Array.isArray(source.blocks) || source.blocks.length <= 0) {
    source.blocks = createDefaultMineLevel(toSafeInt(source.levelId, 0)).blocks;
  }
  source.blocks = source.blocks.map((block, index) => {
    const normalized = normalizeMineBlock(block, fallbackId);
    if (!normalized.uid) normalized.uid = index + 1;
    return normalized;
  });
  source.events = (Array.isArray(source.events) ? source.events : [])
    .map((event, index) => normalizeMineEvent(event, index + 1));
  source.shopGoods = source.shopGoods && typeof source.shopGoods === 'object' && !Array.isArray(source.shopGoods)
    ? source.shopGoods
    : {};
  source.levelId = Math.max(0, toSafeInt(source.levelId, 0));
  source.meter = Math.max(0, toSafeInt(source.meter, 0));
  source.playerMeter = Math.max(0, toSafeInt(source.playerMeter, 0));
  source.playerCol = Math.max(0, toSafeInt(source.playerCol, 0));
  source.boxCounter = Math.max(0, toSafeInt(source.boxCounter, 0));
  source.boxRewardCount = Math.max(0, toSafeInt(source.boxRewardCount, 0));
  source.finish = !!source.finish;
  return source;
}

function ensureMineInfo(player = {}) {
  if (!player.mineInfo || typeof player.mineInfo !== 'object' || Array.isArray(player.mineInfo)) {
    player.mineInfo = {};
  }
  const mine = player.mineInfo;
  mine.levelId = toSafeInt(mine.levelId, -1);
  mine.circleId = toSafeInt(mine.circleId, 0);
  mine.cycle = Math.max(1, toSafeInt(mine.cycle, 1));
  mine.meter = toSafeInt(mine.meter, 0);
  mine.boxCounter = toSafeInt(mine.boxCounter, 0);
  mine.boxRewardCount = toSafeInt(mine.boxRewardCount, 0);
  mine.events = (Array.isArray(mine.events) ? mine.events : [])
    .map((event, index) => normalizeMineEvent(event, index + 1));
  mine.currentLevel = mine.currentLevel && typeof mine.currentLevel === 'object' ? mine.currentLevel : null;
  return mine;
}

function buildMineInfoData(player = {}) {
  const mine = ensureMineInfo(player);
  return {
    levelId: mine.levelId,
    circleId: mine.circleId,
    cycle: mine.cycle,
    meter: mine.meter,
    boxCounter: mine.boxCounter,
    boxRewardCount: mine.boxRewardCount,
    events: clonePlain(mine.events),
  };
}

function buildLevelPayload(mine) {
  const level = normalizeMineLevel(mine.currentLevel || createDefaultMineLevel(Math.max(0, mine.levelId)));
  mine.currentLevel = level;
  return {
    result: 0,
    levelId: level.levelId,
    meter: level.meter,
    playerMeter: level.playerMeter,
    playerCol: level.playerCol,
    events: clonePlain(level.events),
    blocks: clonePlain(level.blocks),
    shopGoods: clonePlain(level.shopGoods),
    finish: !!level.finish,
    cycle: mine.cycle,
    circleId: mine.circleId,
    boxCounter: mine.boxCounter,
    boxRewardCount: mine.boxRewardCount,
  };
}

async function savePlayer(session, player) {
  if (!session || !session.userId || !player) return;
  const saved = await playerService.savePlayer(session.userId, player);
  if (saved && typeof saved === 'object' && (saved.playerId || saved.userId || saved.mineInfo)) {
    session.player = saved;
  }
}

function normalizeRewardInfo(rewards) {
  return buildEmptyRewardInfo(rewards);
}

function getNextEventUid(level) {
  const used = (Array.isArray(level.events) ? level.events : [])
    .map((event) => toSafeInt(event && event.uid, 0));
  return Math.max(0, ...used) + 1;
}

function findOrCreateBlock(level, meter, col) {
  const existing = level.blocks.find((item) => item.meter === meter && item.col === col);
  if (existing) return existing;
  const validBlockIds = getRenderableBlockIds();
  const fallbackId = validBlockIds[0] || 1;
  const uid = Math.max(0, ...level.blocks.map((item) => toSafeInt(item.uid, 0))) + 1;
  const id = validBlockIds.length > 0 ? validBlockIds[(meter + col) % validBlockIds.length] : fallbackId;
  const block = createBlock(uid, id, meter, col);
  level.blocks.push(block);
  return block;
}

function appendFutureRow(level, meter) {
  const cols = [0, 2, 4, 6, 7];
  const updates = [];
  for (const col of cols) {
    const before = level.blocks.find((item) => item.meter === meter && item.col === col);
    const block = findOrCreateBlock(level, meter, col);
    if (!before) updates.push(clonePlain(block));
  }
  return updates;
}

function getItemCount(player, itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return 0;
  if (id === 1) return Math.max(0, toSafeInt(player && player.currencies && player.currencies.diamond, 0));
  if (id === 2) return Math.max(0, toSafeInt(player && player.currencies && player.currencies.silver, 0));
  if (id === 6) return Math.max(0, toSafeInt(player && player.currencies && player.currencies.gold, 0));
  return Math.max(0, toSafeInt(player && player.items && player.items[id], 0));
}

function consumeItem(player, itemId, count = 1) {
  const id = toSafeInt(itemId, 0);
  const safeCount = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || safeCount <= 0 || getItemCount(player, id) < safeCount) return null;
  player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
  player.items = player.items || {};
  if (id === 1) player.currencies.diamond -= safeCount;
  else if (id === 2) player.currencies.silver -= safeCount;
  else if (id === 6) player.currencies.gold -= safeCount;
  else {
    player.items[id] = Math.max(0, toSafeInt(player.items[id], 0) - safeCount);
    if (player.items[id] <= 0) delete player.items[id];
  }
  return { id, count: -safeCount };
}

function parseMineBoxRewards() {
  const base = getMineBaseConfig();
  const rewards = Array.isArray(base.boxRewards) ? base.boxRewards : [];
  return rewards
    .map((row) => ({ id: toSafeInt(row.id, 0), count: Math.max(1, toSafeInt(row.count, 1)) }))
    .filter((row) => row.id > 0 && row.count > 0);
}

function maybeCreateEvent(level, block) {
  if (!level || level.finish || !block || toSafeInt(block.eventId, 0) <= 0) return [];
  const existing = level.events.find((event) => event.id === block.eventId && event.useTime <= 0);
  if (existing) return [];
  const uid = getNextEventUid(level);
  const event = {
    uid,
    id: block.eventId,
    useTime: 0,
  };
  level.events.push(event);
  return [event];
}

function normalizeRewardRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({ id: toSafeInt(row && row.id, 0), count: Math.max(0, toSafeInt(row && row.count, 0)) }))
    .filter((row) => row.id > 0 && row.count > 0);
}

function getMineEventConfig(eventId) {
  const cfg = configService.get('MineEventConfig') || {};
  const id = toSafeInt(eventId, 0);
  return cfg[id] || cfg[String(id)] || null;
}

function getMineEventRewards(eventCfg, useTime, choice = 0) {
  const groups = Array.isArray(eventCfg && eventCfg.rewards) ? eventCfg.rewards : [];
  const groupIndex = toSafeInt(eventCfg && eventCfg.type, 0) === 5
    ? Math.max(0, toSafeInt(choice, 0))
    : Math.max(0, toSafeInt(useTime, 0));
  return normalizeRewardRows(groups[groupIndex] || []);
}

function getMineEventCost(eventCfg, useTime, choice) {
  const index = Math.max(0, toSafeInt(useTime, 0));
  const type = toSafeInt(eventCfg && eventCfg.type, 0);
  const useKey = type === 5 && toSafeInt(choice, 0) === 1;
  const rows = useKey
    ? (Array.isArray(eventCfg && eventCfg.keyUse) ? eventCfg.keyUse : [])
    : (Array.isArray(eventCfg && eventCfg.energyUse) ? eventCfg.energyUse : []);
  const row = rows[index] || null;
  return row ? { id: toSafeInt(row.id, 0), count: Math.max(0, toSafeInt(row.count, 0)) } : null;
}

function buildMineFightResult(player, eventCfg, useTime) {
  try {
    const playerAttrs = battleService.calcPlayerPower(player);
    const difficulty = Array.isArray(eventCfg && eventCfg.difficulty)
      ? Math.max(0, toSafeInt(eventCfg.difficulty[useTime], 0))
      : 0;
    const scaledDifficulty = Math.max(0, Math.floor(difficulty / 1000));
    const enemyAttrs = battleService.generateOpponentAttrs(Math.max(1, toSafeInt(player && player.level, 1)), scaledDifficulty);
    return battleService.simulateBattle(playerAttrs, enemyAttrs);
  } catch (_err) {
    return { win: true, star: 3, rounds: [], totalRounds: 0 };
  }
}

async function handleMineStartLevel(_params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2800, msgUid, data: { result: -1 } };
  const mine = ensureMineInfo(player);

  if (!mine.currentLevel || mine.currentLevel.finish) {
    mine.levelId = Math.max(0, toSafeInt(mine.levelId, -1) + 1);
    mine.currentLevel = createDefaultMineLevel(mine.levelId);
    mine.currentLevel.boxCounter = mine.boxCounter;
    mine.currentLevel.boxRewardCount = mine.boxRewardCount;
    mine.meter = mine.currentLevel.meter;
    mine.events = mine.currentLevel.events;
  }
  mine.currentLevel = normalizeMineLevel(mine.currentLevel);

  await savePlayer(session, player);
  return { tag: 2800, msgUid, data: buildLevelPayload(mine) };
}

async function handleMineDigBlock(params, session, msgUid) {
  const player = session && session.player;
  if (!player) {
    return {
      tag: 2801,
      msgUid,
      data: { result: -1, meter: 0, playerMeter: 0, playerCol: 0, events: [], blockMap: [], shopGoods: {}, finish: false, rewardInfo: buildEmptyRewardInfo() },
    };
  }
  const mine = ensureMineInfo(player);
  if (!mine.currentLevel) {
    mine.currentLevel = createDefaultMineLevel(Math.max(0, mine.levelId));
  }
  mine.currentLevel = normalizeMineLevel(mine.currentLevel);
  const level = mine.currentLevel;

  const requestedItemId = toSafeInt(params && params.itemId, -1);
  const costItemId = requestedItemId > 0 ? requestedItemId : 55;
  if (getItemCount(player, costItemId) < 1) {
    return {
      tag: 2801,
      msgUid,
      data: {
        result: -1,
        meter: level.meter,
        playerMeter: level.playerMeter,
        playerCol: level.playerCol,
        events: [],
        blockMap: [],
        shopGoods: clonePlain(level.shopGoods),
        finish: !!level.finish,
        rewardInfo: buildEmptyRewardInfo(),
      },
    };
  }

  const meter = toSafeInt(params && params.meter, -1);
  const col = toSafeInt(params && params.col, -1);
  const target = findOrCreateBlock(level, meter, col);

  const updates = [];
  const path = Array.isArray(params && params.path) ? params.path : [];
  for (const step of path) {
    const stepMeter = toSafeInt(step && step.meter, -1);
    const stepCol = toSafeInt(step && step.col, -1);
    if (stepMeter < 0 || stepCol < 0) continue;
    const pathBlock = findOrCreateBlock(level, stepMeter, stepCol);
    if (pathBlock.status <= 0) {
      pathBlock.status = 1;
      pathBlock.digCount = Math.max(1, toSafeInt(pathBlock.digCount, 0));
      updates.push(clonePlain(pathBlock));
    }
  }

  if (target.status <= 0) {
    target.status = 1;
    target.digCount = Math.max(1, toSafeInt(target.digCount, 0) + 1);
    level.playerMeter = Math.max(0, meter - 2);
    level.playerCol = col;
    updates.push(clonePlain(target));
  }

  level.meter = Math.max(toSafeInt(level.meter, 0), toSafeInt(level.playerMeter, 0));
  const eventUpdates = maybeCreateEvent(level, target).map(clonePlain);
  const futureMeter = level.meter + 14;
  if (futureMeter % 2 === 1) updates.push(...appendFutureRow(level, futureMeter));

  const packets = [];
  const itemDelta = consumeItem(player, costItemId, 1);
  if (itemDelta) {
    packets.push({ tag: 1202, msgUid: 0, data: { items: [itemDelta] } });
  }

  level.finish = level.blocks.every((item) => toSafeInt(item.status, 0) > 0);
  mine.meter = level.meter;
  mine.events = level.events;
  await savePlayer(session, player);

  packets.push({
    tag: 2801,
    msgUid,
    data: {
      result: 0,
      meter: level.meter,
      playerMeter: level.playerMeter,
      playerCol: level.playerCol,
      events: eventUpdates,
      blockMap: updates,
      shopGoods: clonePlain(level.shopGoods),
      finish: !!level.finish,
      boxCounter: mine.boxCounter,
      boxRewardCount: mine.boxRewardCount,
      rewardInfo: buildEmptyRewardInfo(),
    },
  });
  return packets;
}

async function handleMineDealEvent(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2802, msgUid, data: { result: -1 } };
  const mine = ensureMineInfo(player);
  if (!mine.currentLevel) {
    mine.currentLevel = createDefaultMineLevel(Math.max(0, mine.levelId));
  }
  mine.currentLevel = normalizeMineLevel(mine.currentLevel);
  const level = mine.currentLevel;

  const uids = Array.isArray(params && params.uids) ? params.uids.map((id) => toSafeInt(id, 0)) : [];
  const choices = Array.isArray(params && params.choices) ? params.choices : [];
  const dealResult = [];
  const triggerNum = Math.max(1, toSafeInt(getMineBaseConfig().triggerNum, 20));

  const plans = [];
  const reservedCosts = new Map();
  uids.forEach((uid, requestIndex) => {
    const event = level.events.find((row) => toSafeInt(row.uid, 0) === uid);
    if (!event) return;
    const eventCfg = getMineEventConfig(event.id);
    if (!eventCfg) return;
    const useTime = Math.max(0, toSafeInt(event.useTime, 0));
    const challengeTimes = toSafeInt(eventCfg.challengeTimes, 1);
    if (challengeTimes >= 0 && useTime >= challengeTimes) return;
    const choice = toSafeInt(choices[requestIndex], 0);
    const cost = getMineEventCost(eventCfg, useTime, choice);
    if (cost) {
      const reserved = reservedCosts.get(cost.id) || 0;
      if (cost.id <= 0 || cost.count <= 0 || getItemCount(player, cost.id) - reserved < cost.count) return;
      reservedCosts.set(cost.id, reserved + cost.count);
    }
    plans.push({ event, eventCfg, useTime, choice, cost });
  });

  const packets = [];
  plans.forEach(({ event, eventCfg, useTime, choice, cost }) => {
    const costDelta = cost ? consumeItem(player, cost.id, cost.count) : null;
    if (costDelta) packets.push({ tag: 1202, msgUid: 0, data: { items: [costDelta] } });
    const fightResult = toSafeInt(eventCfg.type, 0) === 7
      ? buildMineFightResult(player, eventCfg, useTime)
      : null;
    const won = !fightResult || !!fightResult.win;
    const rewardRows = won ? getMineEventRewards(eventCfg, useTime, choice) : [];
    const rewards = normalizeRewardInfo(rewardRows);
    rewards.items.forEach((item) => addRewardToPlayer(player, item.id, item.count));
    if (rewards.items.length > 0) packets.push({ tag: 1202, msgUid: 0, data: { items: rewards.items } });
    if (won) event.useTime = useTime + 1;
    dealResult.push({
      event: clonePlain(event),
      rewards,
      result: 0,
      ...(fightResult ? { fightResult } : {}),
    });
    if (won) {
      mine.boxCounter += 1;
      if (mine.boxCounter >= triggerNum) {
        mine.boxCounter = 0;
        mine.boxRewardCount += 1;
      }
    }
  });

  level.boxCounter = mine.boxCounter;
  level.boxRewardCount = mine.boxRewardCount;
  await savePlayer(session, player);

  packets.push({
    tag: 2802,
    msgUid,
    data: {
      result: 0,
      boxCounter: mine.boxCounter,
      boxRewardCount: mine.boxRewardCount,
      dealResult,
    },
  });
  return packets;
}

async function handleMineLevelFinish(_params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2803, msgUid, data: { result: -1 } };
  const mine = ensureMineInfo(player);
  if (!mine.currentLevel) {
    mine.currentLevel = createDefaultMineLevel(Math.max(0, mine.levelId));
  }
  mine.currentLevel.finish = true;

  const levelCfg = configService.get('MineLevelConfig') || {};
  const cycleCfg = levelCfg[mine.cycle] || levelCfg[String(mine.cycle)] || {};
  const row = cycleCfg[mine.levelId] || cycleCfg[String(mine.levelId)] || null;
  const configuredRewards = normalizeRewardRows(
    row && (row.rewards || row.reward || row.finishRewards)
      ? (row.rewards || row.reward || row.finishRewards)
      : []
  );
  const rewardInfo = normalizeRewardInfo(configuredRewards);
  rewardInfo.items.forEach((item) => addRewardToPlayer(player, item.id, item.count));
  await savePlayer(session, player);

  return [
    { tag: 1202, msgUid: 0, data: { items: rewardInfo.items } },
    {
      tag: 2803,
      msgUid,
      data: {
        result: 0,
        rewardInfo,
      },
    },
  ];
}

async function handleMineClaimBoxReward(_params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 2804, msgUid, data: { result: -1 } };
  const mine = ensureMineInfo(player);

  if (mine.boxRewardCount <= 0) {
    return {
      tag: 2804,
      msgUid,
      data: {
        result: 1,
        boxCounter: mine.boxCounter,
        boxRewardCount: mine.boxRewardCount,
        rewards: normalizeRewardInfo([]),
      },
    };
  }

  mine.boxRewardCount -= 1;
  const rewards = parseMineBoxRewards();
  rewards.forEach((item) => addRewardToPlayer(player, item.id, item.count));
  if (mine.currentLevel) {
    mine.currentLevel.boxCounter = mine.boxCounter;
    mine.currentLevel.boxRewardCount = mine.boxRewardCount;
  }
  await savePlayer(session, player);

  return {
    tag: 2804,
    msgUid,
    data: {
      result: 0,
      boxCounter: mine.boxCounter,
      boxRewardCount: mine.boxRewardCount,
      rewards: normalizeRewardInfo(rewards),
    },
  };
}

module.exports = {
  ensureMineInfo,
  buildMineInfoData,
  handleMineStartLevel,
  handleMineDigBlock,
  handleMineDealEvent,
  handleMineLevelFinish,
  handleMineClaimBoxReward,
};
