/**
 * Box handlers
 * tag:2000 open box, 2001 claim box reward, 2003 summon boss
 */

const playerService = require('../services/PlayerService');
const configService = require('../services/ConfigService');
const battle = require('../services/BattleService');
const {
  ensureEquipInfo,
  addOpenEquip,
  isEquipTemplateItem,
  createEquipFromTemplateId,
} = require('../services/EquipService');
const { addRewardToPlayer } = require('./raid');
const { addBagelConsume: addMainTaskBagelConsume } = require('../services/MainTaskProgressService');
const { addBagelConsume: addRealmBagelConsume } = require('../services/RealmTaskProgressService');
const { getPrimaryBattlePetId, applyPrimaryBattlePetParts } = require('../services/RoleAppearanceService');
const logger = require('../logger');
const runtimeBus = require('../services/RuntimeBus');

const DEFAULT_PLAYER_SKILL_ID = 1002;
const DEFAULT_PLAYER_BEHAVIOR_ID = 10020;
const DEFAULT_MONSTER_SKILL_ID = 9009;
const DEFAULT_MONSTER_BEHAVIOR_ID = 90090;

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

let _equipIndexCache = {
  assetsRef: null,
  byQuality: new Map(),
  byQualitySubType: new Map(),
  sortedQualities: [],
};

function getBoxConfig() {
  return configService.get('BoxConfig') || {};
}

function getAssetsConfig() {
  return configService.get('AssetsConfig') || {};
}

function getBoxConfigByLevel(level) {
  const cfg = getBoxConfig();
  return cfg[level] || cfg[String(level)] || {};
}

function getAssetRow(itemId, assetsCfg = null) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return null;
  const assets = assetsCfg || getAssetsConfig();
  return assets[id] || assets[String(id)] || null;
}

function rebuildEquipIndexIfNeeded(assetsCfg) {
  if (_equipIndexCache.assetsRef === assetsCfg) {
    return _equipIndexCache;
  }

  const byQuality = new Map();
  const byQualitySubType = new Map();

  Object.keys(assetsCfg || {}).forEach((key) => {
    const id = toSafeInt(key, 0);
    if (id < 30000 || id >= 100000) return;

    const row = assetsCfg[key];
    if (!row || toSafeInt(row.type, 0) !== 3) return;

    const quality = Math.max(1, toSafeInt(row.quality, Math.floor((id - 30000) / 1000)));
    const subType = Math.max(1, Math.min(12, toSafeInt(row.subType, id % 100 || 1)));

    if (!byQuality.has(quality)) {
      byQuality.set(quality, []);
    }
    byQuality.get(quality).push(id);

    const qstKey = `${quality}:${subType}`;
    if (!byQualitySubType.has(qstKey)) {
      byQualitySubType.set(qstKey, id);
    }
  });

  byQuality.forEach((list) => list.sort((a, b) => a - b));

  _equipIndexCache = {
    assetsRef: assetsCfg,
    byQuality,
    byQualitySubType,
    sortedQualities: Array.from(byQuality.keys()).sort((a, b) => a - b),
  };
  return _equipIndexCache;
}

function pickWeightedIndex(weights = []) {
  let total = 0;
  let lastPositive = -1;
  for (let i = 0; i < weights.length; i += 1) {
    const w = Math.max(0, toSafeInt(weights[i], 0));
    if (w <= 0) continue;
    total += w;
    lastPositive = i;
  }
  if (total <= 0) return -1;

  let roll = Math.random() * total;
  for (let i = 0; i < weights.length; i += 1) {
    const w = Math.max(0, toSafeInt(weights[i], 0));
    if (w <= 0) continue;
    roll -= w;
    if (roll < 0) return i;
  }
  return lastPositive;
}

function rollEquipQuality(boxCfg, qualityFloor = 1) {
  const weights = Array.isArray(boxCfg && boxCfg.equipQualityWeight) ? boxCfg.equipQualityWeight : [];
  const pickedIndex = pickWeightedIndex(weights);

  let quality = pickedIndex >= 0 ? pickedIndex + 1 : 0;
  if (quality <= 0) {
    quality = Math.max(1, toSafeInt(boxCfg && boxCfg.mapBossDropQuality, 2));
  }
  return Math.max(Math.max(1, toSafeInt(qualityFloor, 1)), quality);
}

function rollEquipSubType() {
  return 1 + Math.floor(Math.random() * 12);
}

function pickFallbackTemplateId(equipIndex, quality, subType) {
  const exact = equipIndex.byQualitySubType.get(`${quality}:${subType}`);
  if (exact) return exact;

  const sameQuality = equipIndex.byQuality.get(quality);
  if (sameQuality && sameQuality.length > 0) {
    const idx = Math.floor(Math.random() * sameQuality.length);
    return sameQuality[idx];
  }

  if (equipIndex.sortedQualities.length <= 0) {
    return 32101;
  }

  let nearest = equipIndex.sortedQualities[0];
  let bestDiff = Math.abs(nearest - quality);
  for (const q of equipIndex.sortedQualities) {
    const diff = Math.abs(q - quality);
    if (diff < bestDiff) {
      bestDiff = diff;
      nearest = q;
    }
  }
  const nearestList = equipIndex.byQuality.get(nearest) || [];
  if (nearestList.length <= 0) return 32101;
  return nearestList[Math.floor(Math.random() * nearestList.length)];
}

function buildEquipTemplateId(quality, subType, assetsCfg) {
  const q = Math.max(1, toSafeInt(quality, 1));
  const st = Math.max(1, Math.min(12, toSafeInt(subType, 1)));
  const directId = 30000 + q * 1000 + 100 + st;
  const row = getAssetRow(directId, assetsCfg);
  if (row && toSafeInt(row.type, 0) === 3) {
    return directId;
  }

  const equipIndex = rebuildEquipIndexIfNeeded(assetsCfg);
  return pickFallbackTemplateId(equipIndex, q, st);
}

function getAttrValue(attrs, attrId, aliases = [], fallback = 0) {
  if (!attrs || typeof attrs !== 'object') return fallback;
  if (attrs[attrId] != null) return toSafeInt(attrs[attrId], fallback);
  const keys = Array.isArray(aliases) ? aliases : [aliases];
  for (const key of keys) {
    if (key && attrs[key] != null) return toSafeInt(attrs[key], fallback);
  }
  return fallback;
}

function getConfigRow(map, id) {
  if (!map || id == null) return null;
  return map[id] || map[String(id)] || null;
}

function resolveBattleActionIds(skillId, fallbackSkillId, fallbackBehaviorId) {
  const skillCfgMap = configService.get('SkillConfig') || {};
  const behaviorCfgMap = configService.get('SkillBehaviorConfig') || {};
  const safeFallbackSkillId = Math.max(1, toSafeInt(fallbackSkillId, DEFAULT_PLAYER_SKILL_ID));
  const safeFallbackBehaviorId = Math.max(1, toSafeInt(fallbackBehaviorId, DEFAULT_PLAYER_BEHAVIOR_ID));
  const preferredSkillCfg = getConfigRow(skillCfgMap, skillId);
  const fallbackSkillCfg = getConfigRow(skillCfgMap, safeFallbackSkillId);
  const skillCfg = preferredSkillCfg || fallbackSkillCfg;
  const resolvedSkillId = Math.max(1, toSafeInt(skillCfg && skillCfg.id, toSafeInt(skillId, safeFallbackSkillId) || safeFallbackSkillId));
  const actionIds = Array.isArray(skillCfg && skillCfg.actions) ? skillCfg.actions : [];
  let behaviorId = actionIds.map((id) => Math.max(0, toSafeInt(id, 0))).find((id) => id > 0) || 0;
  if (behaviorId <= 0 && getConfigRow(behaviorCfgMap, resolvedSkillId)) {
    behaviorId = resolvedSkillId;
  }
  if (behaviorId <= 0) {
    behaviorId = safeFallbackBehaviorId;
  }
  return { skillId: resolvedSkillId, behaviorId };
}

function buildFightVars(hpValue = 0) {
  const hp = Math.max(0, toSafeInt(hpValue, 0));
  return { 1: hp, 2: 0, 3: 0, '-1': hp };
}

function buildDamageAction(casterPos, targetPos, damage, targetHpAfterHit) {
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

function buildSkillEvent(skillId, behaviorId, casterPos, targetPos, damage, targetHpAfterHit) {
  const damageAction = buildDamageAction(casterPos, targetPos, damage, targetHpAfterHit);
  if (!damageAction) return null;
  return {
    typ: 1,
    i: Math.max(1, toSafeInt(skillId, DEFAULT_PLAYER_SKILL_ID)),
    c: casterPos,
    t: 0,
    as: [0],
    es: [[{
      typ: 2,
      i: Math.max(1, toSafeInt(behaviorId, DEFAULT_PLAYER_BEHAVIOR_ID)),
      c: casterPos,
      t: 0,
      es: [[damageAction]],
    }]],
  };
}

function resolveSummonBossVisualId(boxCfg = {}) {
  const activityBaseCfg = configService.get('ActivityBaseConfig') || {};
  const activityMapId = Math.max(0, toSafeInt(activityBaseCfg.mapId, 0));
  const activityBossShow = Math.max(0, toSafeInt(activityBaseCfg.bossShow, 0));
  const boxMapId = Math.max(0, toSafeInt(boxCfg && boxCfg.mapId, 0));
  if (activityMapId > 0 && boxMapId === activityMapId && activityBossShow > 0) return activityBossShow;
  return Math.max(1, toSafeInt(boxCfg && boxCfg.mapBossShow, 201));
}

function buildSummonBossPlayerShowInfo(player = {}, power = 0) {
  const roleInfo = player && player.roleInfo && typeof player.roleInfo === 'object' ? player.roleInfo : {};
  const playerId = String(player.playerId || player.userId || 'boss_self');
  return {
    dbid: playerId,
    serverId: Number(process.env.SERVER_ID || 1),
    serverName: process.env.SERVER_NAME || '',
    kungfuId: Math.max(1, toSafeInt(roleInfo.kungfuId, 4)),
    subJob: Math.max(0, toSafeInt(roleInfo.subJob, 0)),
    level: Math.max(1, toSafeInt(player.level, 1)),
    name: String(player.name || 'Player'),
    power: Math.max(0, toSafeInt(power, 0)),
    stage: Math.max(1, toSafeInt(roleInfo.stage, toSafeInt(roleInfo.stageId, 1))),
    avatar: Math.max(0, toSafeInt(player.avatar, toSafeInt(roleInfo.avatar, 0))),
    avatarUrl: player.avatarUrl ? String(player.avatarUrl) : '',
    avatarFrame: Math.max(0, toSafeInt(player.avatarFrame, toSafeInt(roleInfo.avatarFrame, 0))),
    title: Math.max(0, toSafeInt(player.title, toSafeInt(roleInfo.title, 0))),
    petId: getPrimaryBattlePetId(player),
    playerInfo: {
      dbid: playerId,
      level: Math.max(1, toSafeInt(player.level, 1)),
      avatar: Math.max(0, toSafeInt(player.avatar, toSafeInt(roleInfo.avatar, 0))),
      avatarUrl: player.avatarUrl ? String(player.avatarUrl) : '',
      avatarFrame: Math.max(0, toSafeInt(player.avatarFrame, toSafeInt(roleInfo.avatarFrame, 0))),
      title: Math.max(0, toSafeInt(player.title, toSafeInt(roleInfo.title, 0))),
    },
  };
}

function buildSummonBossEnemyShowInfo(monster = {}, bossVisualId, power = 0) {
  return {
    dbid: `boss_${Math.max(1, toSafeInt(bossVisualId, 201))}`,
    serverId: 0,
    serverName: '',
    kungfuId: 0,
    subJob: 0,
    level: Math.max(1, toSafeInt(monster.level, 1)),
    name: String(monster.monsterName || '魔灵之龙'),
    power: Math.max(0, toSafeInt(power, 0)),
    stage: 1,
    avatar: 0,
    avatarUrl: '',
    avatarFrame: 0,
    title: 0,
    playerInfo: {
      dbid: `boss_${Math.max(1, toSafeInt(bossVisualId, 201))}`,
      level: Math.max(1, toSafeInt(monster.level, 1)),
      avatar: 0,
      avatarUrl: '',
      avatarFrame: 0,
      title: 0,
    },
  };
}

function buildSummonBossFightResult(player, boxCfg, rewardCount) {
  const playerAttrs = battle.calcPlayerPower(player);
  const bossVisualId = resolveSummonBossVisualId(boxCfg);
  const monsterCfgMap = configService.get('MonsterConfig') || {};
  const monster = getConfigRow(monsterCfgMap, bossVisualId) || {};
  const playerHpMax = Math.max(1, getAttrValue(playerAttrs, 1, ['hp', 'maxHp'], 100));
  const playerAtk = Math.max(1, getAttrValue(playerAttrs, 2, ['atk'], 50));
  const bossHpMax = Math.max(2000, playerAtk * Math.max(4, rewardCount));
  const bossAttrs = { 1: bossHpMax, 2: Math.max(1, Math.floor(playerAtk * 0.35)), 3: 0, 4: 1 };
  const playerPower = Math.max(0, toSafeInt(battle.calcPowerScore(playerAttrs), 0));
  const bossPower = Math.max(0, toSafeInt(battle.calcPowerScore(bossAttrs), 0));
  const bossSkillSeed = (Array.isArray(monster && monster.fightSkill) ? monster.fightSkill : [])
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .find((id) => id > 0)
    || Math.max(0, toSafeInt(monster && monster.monsterShow, DEFAULT_MONSTER_SKILL_ID))
    || DEFAULT_MONSTER_SKILL_ID;
  const playerSkill = resolveBattleActionIds(DEFAULT_PLAYER_SKILL_ID, DEFAULT_PLAYER_SKILL_ID, DEFAULT_PLAYER_BEHAVIOR_ID);
  const bossSkill = resolveBattleActionIds(bossSkillSeed, DEFAULT_MONSTER_SKILL_ID, DEFAULT_MONSTER_BEHAVIOR_ID);
  const roundCount = 4;
  const bossHit = Math.max(1, Math.floor(playerHpMax * 0.05));
  const playerHit = Math.max(1, Math.floor(bossHpMax / roundCount));
  let currentBossHp = bossHpMax;
  let currentPlayerHp = playerHpMax;
  const events = [{ typ: 0, i: 0, c: 0, t: 0, es: [] }];
  for (let roundIndex = 1; roundIndex <= roundCount; roundIndex += 1) {
    const round = { typ: 0, i: roundIndex, c: 0, t: 0, es: [] };
    const isFinalRound = roundIndex === roundCount;
    const playerDamage = isFinalRound ? currentBossHp : Math.max(1, Math.min(currentBossHp - 1, playerHit));
    currentBossHp = Math.max(0, currentBossHp - playerDamage);
    const playerEvent = buildSkillEvent(
      playerSkill.skillId,
      playerSkill.behaviorId,
      1,
      -1,
      playerDamage,
      currentBossHp,
    );
    if (playerEvent) round.es.push([playerEvent]);

    if (!isFinalRound) {
      currentPlayerHp = Math.max(1, currentPlayerHp - bossHit);
      const bossEvent = buildSkillEvent(
        bossSkill.skillId,
        bossSkill.behaviorId,
        -1,
        1,
        bossHit,
        currentPlayerHp,
      );
      if (bossEvent) round.es.push([bossEvent]);
    }

    if (round.es.length > 0) events.push(round);
  }
  const playerId = String(player.playerId || player.userId || 'boss_self');
  const selfEntity = applyPrimaryBattlePetParts({
    id: Math.max(1, toSafeInt(player.roleInfo && player.roleInfo.kungfuId, 4)),
    dbid: playerId,
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
    showInfo: buildSummonBossPlayerShowInfo(player, playerPower),
    parts: {},
    partValues: {},
  }, player);
  return {
    type: 1,
    win: 1,
    mustChangeTurn: 0,
    notChangeTurn: 1,
    atkAttr: playerAttrs || {},
    defAttr: bossAttrs,
    damage: { 1: bossHpMax, '-1': Math.max(0, playerHpMax - currentPlayerHp) },
    isBackFight: false,
    events,
    entitys: [
      selfEntity,
      {
        id: bossVisualId,
        dbid: `boss_${bossVisualId}`,
        name: String(monster.monsterName || '精英怪'),
        type: 2,
        side: 2,
        camp: 2,
        pos: -1,
        posIndex: -1,
        hp: bossHpMax,
        maxhp: bossHpMax,
        maxHp: bossHpMax,
        vars: buildFightVars(bossHpMax),
        showInfo: buildSummonBossEnemyShowInfo(monster, bossVisualId, bossPower),
        parts: {},
        partValues: {},
      },
    ],
    guildBossAllDamage: 0,
    bloodlineOffset: 0,
  };
}

function addItemCount(itemCountMap, itemId, count) {
  const id = toSafeInt(itemId, 0);
  const c = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || c <= 0) return;
  itemCountMap.set(id, (itemCountMap.get(id) || 0) + c);
}

function ensurePlayerBoxState(player = {}) {
  if (!player.items || typeof player.items !== 'object' || Array.isArray(player.items)) {
    player.items = {};
  }
  if (!player.boxInfo || typeof player.boxInfo !== 'object' || Array.isArray(player.boxInfo)) {
    player.boxInfo = {
      level: 1,
      exp: 0,
      upgradeFinishTime: 0,
      tier: 1,
      tierExp: 0,
      tierUpTime: 0,
      summonExp: 0,
      summonCount: 0,
      summonFreeCount: 0,
      summonFreeResetDay: 0,
    };
  }
  player.boxInfo.summonFreeResetDay = Math.max(0, toSafeInt(player.boxInfo.summonFreeResetDay, 0));
  ensureEquipInfo(player);
}

function getDayCode(nowMs = Date.now()) {
  const date = new Date(Math.max(0, toSafeInt(nowMs, Date.now())));
  return (date.getFullYear() * 10000) + ((date.getMonth() + 1) * 100) + date.getDate();
}

function refreshDailySummonFreeState(player = {}, nowMs = Date.now()) {
  ensurePlayerBoxState(player);
  const today = getDayCode(nowMs);
  const boxInfo = player.boxInfo;
  if (today <= 0) return false;
  if (toSafeInt(boxInfo.summonFreeResetDay, 0) === today) return false;

  boxInfo.summonFreeCount = 0;
  boxInfo.summonFreeResetDay = today;
  return true;
}

function getSummonFreeLimit(player = {}) {
  const constCfg = configService.get('ConstConfig') || {};
  return Math.max(1, toSafeInt(constCfg.mapBossFreeNum, 1));
}

function isSummonBossFailOpenEnabled() {
  const raw = process.env.SUMMON_BOSS_FAIL_OPEN;
  if (raw != null && raw !== '') return String(raw).trim() === '1';
  return process.env.NODE_ENV !== 'production';
}

function addSummonProgress(player = {}, count = 0) {
  ensurePlayerBoxState(player);
  const addCount = Math.max(0, toSafeInt(count, 0));
  if (addCount <= 0) return false;

  const constCfg = configService.get('ConstConfig') || {};
  const needExp = Math.max(1, toSafeInt(constCfg.mapBossCallCost, 1000));
  const maxCount = Math.max(1, toSafeInt(constCfg.mapBossMaxNum, 10));
  const boxInfo = player.boxInfo;
  let summonExp = Math.max(0, toSafeInt(boxInfo.summonExp, 0)) + addCount;
  let summonCount = Math.max(0, toSafeInt(boxInfo.summonCount, 0));

  while (summonExp >= needExp && summonCount < maxCount) {
    summonExp -= needExp;
    summonCount += 1;
  }

  if (summonCount >= maxCount) {
    summonExp = Math.min(summonExp, needExp - 1);
  }

  const changed = summonExp !== toSafeInt(boxInfo.summonExp, 0)
    || summonCount !== toSafeInt(boxInfo.summonCount, 0);
  boxInfo.summonExp = summonExp;
  boxInfo.summonCount = summonCount;
  return changed;
}

function buildOpenInfo(player, count, options = {}) {
  const safeCount = Math.max(1, toSafeInt(count, 1));
  const level = Math.max(1, toSafeInt(player.level, 1));
  const boxLevel = Math.max(1, toSafeInt(player.boxInfo && player.boxInfo.level, 1));
  const qualityFloor = Math.max(1, toSafeInt(options.qualityFloor, 1));
  const includeExp = options.includeExp !== false;

  const boxCfg = getBoxConfigByLevel(boxLevel);
  const assetsCfg = getAssetsConfig();
  const itemCountMap = new Map();

  // Keep default coin drop behavior.
  if (includeExp) {
    addItemCount(itemCountMap, 3, 10 * safeCount);
  }

  const forceQualities = Array.isArray(options.forceQualities) ? options.forceQualities : [];
  for (let i = 0; i < safeCount; i += 1) {
    const quality = Math.max(
      qualityFloor,
      toSafeInt(forceQualities[i], rollEquipQuality(boxCfg, qualityFloor))
    );
    const subType = rollEquipSubType();
    const equipTemplateId = buildEquipTemplateId(quality, subType, assetsCfg);
    addItemCount(itemCountMap, equipTemplateId, 1);
  }

  const items = [];
  const coinCount = itemCountMap.get(3) || 0;
  if (coinCount > 0) {
    items.push({ id: 3, count: coinCount });
  }

  Array.from(itemCountMap.entries())
    .filter(([id]) => id !== 3)
    .sort((a, b) => a[0] - b[0])
    .forEach(([id, itemCount]) => {
      items.push({ id, count: itemCount });
    });

  return {
    seed: Date.now(),
    count: safeCount,
    lv: level,
    items,
  };
}

function expandRewardItems(items = []) {
  const expanded = [];
  (Array.isArray(items) ? items : []).forEach((row) => {
    const itemId = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (itemId <= 0 || count <= 0) return;
    for (let index = 0; index < count; index += 1) {
      expanded.push({ id: itemId, count: 1 });
    }
  });
  return expanded;
}

async function handleOpenBox(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 2000,
      msgUid,
      data: { seed: Date.now(), count: 0, lv: 1, items: [] },
    };
  }

  ensurePlayerBoxState(player);

  const reqCount = Math.max(1, toSafeInt(params && params.count, 1));
  const baozi = Math.max(0, toSafeInt(player.items[4], 0));
  const openCount = Math.min(reqCount, baozi);

  if (openCount <= 0) {
    logger.info(`[Box] open denied user=${session.userId} reason=baozi_not_enough req=${reqCount} own=${baozi}`);
    return {
      tag: 2000,
      msgUid,
      data: { seed: Date.now(), count: 0, lv: Math.max(1, toSafeInt(player.level, 1)), items: [] },
    };
  }

  player.items[4] = baozi - openCount;
  if (player.items[4] <= 0) {
    delete player.items[4];
  }
  addMainTaskBagelConsume(player, openCount);
  addRealmBagelConsume(player, openCount);
  addSummonProgress(player, openCount);

  const openInfo = buildOpenInfo(player, openCount);
  session.pendingBoxReward = openInfo;

  playerService.savePlayerDeferred(session.userId, player).catch((err) => {
    logger.warn(`[Box] async open save failed user=${session.userId}: ${err.message}`);
  });

  const wsServer = runtimeBus.getWsServer();
  if (wsServer && typeof wsServer.broadcastExceptUser === 'function') {
    wsServer.broadcastExceptUser(session.userId, 2150, {
      id: String(player.playerId || session.userId || ''),
      index: toSafeInt(params && params.index, 0),
      speedUp: !!(params && params.speedUp),
      seed: openInfo.seed,
      count: openInfo.count,
      lv: openInfo.lv,
      items: openInfo.items,
    });
  }

  // The client enters its attack FSM inside the tag=2000 callback. Send that
  // ACK first so the selected local monster cannot disappear while unrelated
  // item/task pushes are being handled.
  const response = [{ tag: 2000, msgUid, data: openInfo }];
  response.push({ tag: 1202, data: { items: [{ id: 4, count: -openCount }] } });
  return response;
}

async function handleBoxReward(_params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 2001,
      msgUid,
      data: {
        rewardInfo: {
          items: [], equips: [], swords: [], pets: [], artifacts: [], gems: [],
          valhalla: [], bloodline: [], fashion: [], elves: [], extraReward: {},
        },
      },
    };
  }

  ensurePlayerBoxState(player);

  const openInfo = session.pendingBoxReward || {
    seed: Date.now(),
    count: 0,
    lv: Math.max(1, toSafeInt(player.level, 1)),
    items: [],
  };

  const rewardItems = [];
  const rewardEquips = [];

  for (const raw of openInfo.items || []) {
    const id = toSafeInt(raw && raw.id, 0);
    const count = Math.max(0, toSafeInt(raw && raw.count, 0));
    if (id <= 0 || count <= 0) continue;

    if (isEquipTemplateItem(id)) {
      for (let i = 0; i < count; i++) {
        const equip = createEquipFromTemplateId(id, openInfo.lv, player);
        rewardEquips.push(equip);
        addOpenEquip(player, equip);
      }
      continue;
    }

    rewardItems.push({ id, count });
    addRewardToPlayer(player, id, count);
  }

  session.pendingBoxReward = null;
  // The reward packet is deterministic and the PlayerService queue snapshots
  // the player at enqueue time, so Mongo persistence must not delay the ACK.
  playerService.savePlayerDeferred(session.userId, player).catch((err) => {
    logger.warn(`[Box] async reward save failed user=${session.userId}: ${err.message}`);
  });

  const rewardInfo = {
    items: rewardItems,
    equips: rewardEquips,
    swords: [],
    pets: [],
    artifacts: [],
    gems: [],
    valhalla: [],
    bloodline: [],
    fashion: [],
    elves: [],
    extraReward: {},
  };

  const messages = [];
  if (rewardItems.length > 0) {
    messages.push({ tag: 1202, data: { items: rewardItems } });
  }
  for (const equip of rewardEquips) {
    messages.push({ tag: 2200, data: { equip } });
  }
  messages.push({ tag: 2001, msgUid, data: { rewardInfo } });

  logger.info(
    `[Box] reward user=${session.userId || 'unknown'} msgUid=${msgUid} `
    + `itemCount=${rewardItems.length} equipCount=${rewardEquips.length} `
    + `equipIds=${rewardEquips.map((equip) => equip && equip.id).filter(Boolean).join(',')}`
  );

  return messages;
}

async function handleSummonBoss(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 2003,
      msgUid,
      data: { seed: Date.now(), count: 0, lv: 1, items: [], summonCount: 0, summonFreeCount: 0 },
    };
  }

  ensurePlayerBoxState(player);
  refreshDailySummonFreeState(player);

  let summonCount = Math.max(0, toSafeInt(player.boxInfo.summonCount, 0));
  let summonFreeCount = Math.max(0, toSafeInt(player.boxInfo.summonFreeCount, 0));
  const summonFreeLimit = getSummonFreeLimit(player);

  if (summonFreeCount < summonFreeLimit) {
    summonFreeCount += 1;
  } else if (summonCount > 0) {
    summonCount -= 1;
  } else if (isSummonBossFailOpenEnabled()) {
    logger.warn(
      `[Box] summon boss fail-open user=${session.userId || 'unknown'} msgUid=${msgUid} `
      + `summonCount=${summonCount} usedFree=${summonFreeCount} freeLimit=${summonFreeLimit}`
    );
  } else {
    logger.info(
      `[Box] summon boss denied user=${session.userId || 'unknown'} msgUid=${msgUid} `
      + `summonCount=${summonCount} usedFree=${summonFreeCount} freeLimit=${summonFreeLimit}`
    );
    return {
      tag: 2003,
      msgUid,
      data: {
        seed: Date.now(),
        count: 0,
        lv: Math.max(1, toSafeInt(player.level, 1)),
        items: [],
        summonCount,
        summonFreeCount,
      },
    };
  }

  player.boxInfo.summonCount = summonCount;
  player.boxInfo.summonFreeCount = summonFreeCount;

  const boxLevel = Math.max(1, toSafeInt(player.boxInfo && player.boxInfo.level, 1));
  const boxCfg = getBoxConfigByLevel(boxLevel);
  const qualityFloor = Math.max(1, toSafeInt(boxCfg.mapBossDropQuality, 1));
  const rewardCount = 15;
  const forceQualities = [6, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];
  const openInfo = buildOpenInfo(player, rewardCount, { qualityFloor, forceQualities, includeExp: true });
  openInfo.count = Math.max(rewardCount, boxLevel + 10);
  openInfo.lv = Math.max(1, toSafeInt(player.level, 1) + 5);
  openInfo.fightResult = buildSummonBossFightResult(player, boxCfg, rewardCount);
  openInfo.bossShow = resolveSummonBossVisualId(boxCfg);
  session.pendingBoxReward = openInfo;

  logger.info(
    `[Box] summon boss user=${session.userId || 'unknown'} msgUid=${msgUid} `
    + `bossShow=${openInfo.bossShow} dropCount=${openInfo.count} `
    + `summonCount=${summonCount} usedFree=${summonFreeCount}/${summonFreeLimit} `
    + `dropIds=${(openInfo.items || []).map((row) => row && row.id).filter(Boolean).join(',')}`
  );

  playerService.savePlayerDeferred(session.userId, player).catch((err) => {
    logger.warn(`[Box] async reward save failed user=${session.userId}: ${err.message}`);
  });

  return {
    tag: 2003,
    msgUid,
    data: {
      ...openInfo,
      summonCount,
      summonFreeCount,
    },
  };
}

module.exports = {
  handleOpenBox,
  handleBoxReward,
  handleSummonBoss,
};
