/**
 * Tower system
 * tag: 2350 fight, 2700 rank, 3700 skill select, 3701 rank compat,
 *      3702 auto select, 3703 auto priority
 */

const config = require('../services/ConfigService');
const battle = require('../services/BattleService');
const playerService = require('../services/PlayerService');
const rank = require('../services/RankService');
const { addRewardToPlayer } = require('./raid');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function getConfigTable(name) {
  const table = config.get(name);
  return table && typeof table === 'object' && !Array.isArray(table) ? table : {};
}

function getConfigRow(table, id) {
  const safeId = toSafeInt(id, 0);
  if (safeId <= 0) return null;
  return table[safeId] || table[String(safeId)] || null;
}

function getTowerAttrConfig() {
  return getConfigTable('TowerAttrConfig');
}

function isTowerSkillId(id) {
  const row = getConfigRow(getTowerAttrConfig(), id);
  return !!(row && typeof row === 'object' && row.attrs && typeof row.attrs === 'object');
}

function getTowerSlotLimit() {
  const baseCfg = getConfigTable('TowerBaseConfig');
  const attrCount = Math.max(0, toSafeInt(baseCfg.attrCount, 0));
  if (attrCount > 0) return attrCount;
  return Array.isArray(baseCfg.attrCond) && baseCfg.attrCond.length > 0 ? baseCfg.attrCond.length : 5;
}

function normalizeTowerSkillId(value) {
  const id = Math.max(0, toSafeInt(value && typeof value === 'object' ? value.id : value, 0));
  return id > 0 && isTowerSkillId(id) ? id : 0;
}

function normalizeTowerSlot(value) {
  if (value == null) return null;
  const id = normalizeTowerSkillId(value);
  if (id <= 0) return null;
  const lv = Math.max(1, toSafeInt(value && typeof value === 'object' ? value.lv || value.level : 1, 1));
  return { id, lv };
}

function normalizeTowerSlotlist(list) {
  if (!Array.isArray(list)) return [];
  const limit = getTowerSlotLimit();
  const used = new Set();
  const normalized = [];
  for (const row of list) {
    const slot = normalizeTowerSlot(row);
    if (!slot || used.has(slot.id)) continue;
    used.add(slot.id);
    normalized.push(slot);
    if (normalized.length >= limit) break;
  }
  return normalized;
}

function normalizeTowerOptionalSkills(list, slotlist = []) {
  if (!Array.isArray(list)) return [];
  const equipped = new Set(slotlist.map((row) => normalizeTowerSkillId(row)).filter((id) => id > 0));
  const used = new Set();
  const normalized = [];
  for (const row of list) {
    const id = normalizeTowerSkillId(row);
    if (id <= 0 || equipped.has(id) || used.has(id)) continue;
    used.add(id);
    normalized.push(id);
  }
  return normalized;
}

function getAllowedPriorityIds() {
  const baseCfg = getConfigTable('TowerBaseConfig');
  const attrCfg = getConfigTable('AttrConfig');
  const selectAttr = Array.isArray(baseCfg.selectAttr) ? baseCfg.selectAttr : [];
  const ids = selectAttr
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .filter((id, index, arr) => id > 0 && arr.indexOf(id) === index && getConfigRow(attrCfg, id));
  if (ids.length > 0) return new Set(ids);
  return new Set(Object.keys(attrCfg).map((key) => Math.max(0, toSafeInt(key, 0))).filter((id) => id > 0));
}

function normalizeTowerAutoPriority(priority) {
  const allowed = getAllowedPriorityIds();
  const raw = Array.isArray(priority) ? priority : [];
  const used = new Set();
  return Array.from({ length: 5 }, (_row, index) => {
    const id = Math.max(0, toSafeInt(raw[index], 0));
    if (id <= 0 || used.has(id) || !allowed.has(id)) return 0;
    used.add(id);
    return id;
  });
}

function listTowerSkillIds() {
  return Object.keys(getTowerAttrConfig())
    .map((key) => Math.max(0, toSafeInt(key, 0)))
    .filter((id, index, arr) => id > 0 && arr.indexOf(id) === index && isTowerSkillId(id))
    .sort((a, b) => {
      const rowA = getConfigRow(getTowerAttrConfig(), a) || {};
      const rowB = getConfigRow(getTowerAttrConfig(), b) || {};
      return toSafeInt(rowA.priority, 0) - toSafeInt(rowB.priority, 0)
        || toSafeInt(rowA.quality, 0) - toSafeInt(rowB.quality, 0)
        || a - b;
    });
}

function getTowerQualityWeights(floor) {
  const baseCfg = getConfigTable('TowerBaseConfig');
  const weights = baseCfg.attrQualityWeight && typeof baseCfg.attrQualityWeight === 'object'
    ? baseCfg.attrQualityWeight
    : {};
  const threshold = Object.keys(weights)
    .map((key) => toSafeInt(key, 0))
    .filter((key) => key <= Math.max(1, toSafeInt(floor, 1)))
    .sort((a, b) => b - a)[0];
  return Array.isArray(weights[threshold]) ? weights[threshold] : [];
}

function pickTowerQuality(floor) {
  const entries = getTowerQualityWeights(floor)
    .map((row) => ({ id: toSafeInt(row && row.id, 0), weight: Math.max(0, toSafeInt(row && row.weight, 0)) }))
    .filter((row) => row.id > 0 && row.weight > 0);
  if (entries.length <= 0) return 2;
  const total = entries.reduce((sum, row) => sum + row.weight, 0);
  let roll = Math.random() * total;
  for (const row of entries) {
    roll -= row.weight;
    if (roll <= 0) return row.id;
  }
  return entries[entries.length - 1].id;
}

function buildTowerSkillChoices(floor = 1, exclude = []) {
  const baseCfg = getConfigTable('TowerBaseConfig');
  const count = Math.max(1, toSafeInt(baseCfg.attrCount, 3));
  const excluded = new Set(exclude.map((id) => toSafeInt(id, 0)).filter((id) => id > 0));
  const allIds = listTowerSkillIds().filter((id) => !excluded.has(id));
  if (allIds.length <= count) return allIds;

  const selectAttrs = Array.isArray(baseCfg.selectAttr)
    ? baseCfg.selectAttr.map((id) => toSafeInt(id, 0)).filter((id) => id > 0)
    : [];
  const choices = [];
  let guard = 0;
  while (choices.length < count && guard < allIds.length * 4) {
    guard += 1;
    const quality = pickTowerQuality(floor);
    const priority = selectAttrs.length > 0 ? selectAttrs[Math.floor(Math.random() * selectAttrs.length)] : 0;
    const pool = allIds.filter((id) => {
      const row = getConfigRow(getTowerAttrConfig(), id) || {};
      return toSafeInt(row.quality, 0) === quality
        && (priority <= 0 || toSafeInt(row.priority, 0) === priority);
    });
    const source = pool.length > 0 ? pool : allIds;
    const picked = source[Math.floor(Math.random() * source.length)];
    if (picked > 0 && !choices.includes(picked)) choices.push(picked);
  }
  allIds.forEach((id) => {
    if (choices.length < count && !choices.includes(id)) choices.push(id);
  });
  return choices;
}

function grantTowerSkillChoice(info, floor = 1) {
  if (!info || typeof info !== 'object') return info;
  const slotlist = normalizeTowerSlotlist(info.slotlist);
  const equipped = slotlist.map((slot) => normalizeTowerSkillId(slot)).filter((id) => id > 0);
  const choices = buildTowerSkillChoices(floor, equipped);
  info.slotlist = slotlist;
  info.skills = choices;
  info.skillCount = choices.length > 0 ? 1 : 0;
  return info;
}

function buildTowerInfoPayload(info, extra = {}) {
  return {
    result: 0,
    maxlayer: Math.max(0, toSafeInt(info.maxlayer, 0)),
    curlayer: Math.max(0, toSafeInt(info.curlayer, 0)),
    skillCount: Math.max(0, toSafeInt(info.skillCount, 0)),
    skills: Array.isArray(info.skills) ? info.skills.slice() : [],
    slotlist: Array.isArray(info.slotlist) ? info.slotlist.map((row) => ({ ...row })) : [],
    autoSelect: toSafeInt(info.autoSelect, 0) > 0 ? 1 : 0,
    autoPriority: Array.isArray(info.autoPriority) ? info.autoPriority.slice() : [],
    ...extra,
  };
}

function ensureTowerInfo(player) {
  player.swordInfo = player.swordInfo && typeof player.swordInfo === 'object' && !Array.isArray(player.swordInfo)
    ? player.swordInfo
    : {};

  const info = player.swordInfo;
  if (info.curlayer == null) info.curlayer = 0;
  if (info.maxlayer == null) info.maxlayer = 0;
  if (info.score == null) info.score = 0;
  if (info.dailyCount == null) info.dailyCount = 0;
  if (!Array.isArray(info.skills)) info.skills = [];
  if (!Array.isArray(info.slotlist)) info.slotlist = [];
  if (info.skillCount == null) info.skillCount = 0;
  if (info.autoSelect == null) info.autoSelect = 0;
  if (!Array.isArray(info.autoPriority)) info.autoPriority = [];

  info.curlayer = Math.max(0, toSafeInt(info.curlayer, 0));
  info.maxlayer = Math.max(0, toSafeInt(info.maxlayer, 0));
  info.score = Math.max(0, toSafeInt(info.score, 0));
  info.dailyCount = Math.max(0, toSafeInt(info.dailyCount, 0));
  info.skillCount = Math.max(0, toSafeInt(info.skillCount, 0));
  info.autoSelect = toSafeInt(info.autoSelect, 0) > 0 ? 1 : 0;
  info.slotlist = normalizeTowerSlotlist(info.slotlist);
  info.skills = normalizeTowerOptionalSkills(info.skills, info.slotlist);
  info.autoPriority = normalizeTowerAutoPriority(info.autoPriority);

  return info;
}

// Tower fight (tag:2350)
async function handleTowerFight(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 2350, msgUid, data: { result: -1 } };

  const swordInfo = ensureTowerInfo(player);
  const floor = (swordInfo.curlayer || 0) + 1;
  const towerCfg = config.get('TowerConfig');
  const tower = towerCfg ? towerCfg[floor] : null;

  const monsterId = tower ? tower.monsterId : 300001;
  const playerAttrs = battle.calcPlayerPower(player);
  const monsterAttrs = battle.getMonsterAttrs(monsterId);
  const simulatedResult = battle.simulateBattle(playerAttrs, monsterAttrs, { enforcePlayerMonsterMinDamage: true });
  const result = typeof battle.enforcePvePowerAdvantage === 'function'
    ? battle.enforcePvePowerAdvantage(playerAttrs, monsterAttrs, simulatedResult)
    : simulatedResult;

  const rewards = [];
  if (result.win) {
    swordInfo.curlayer = floor;
    if (floor > (swordInfo.maxlayer || 0)) {
      swordInfo.maxlayer = floor;
      if (tower && tower.firstRewards) {
        tower.firstRewards.forEach((r) => {
          rewards.push({ ...r });
          addRewardToPlayer(player, r.id, r.count);
        });
      }
    }
    if (tower && tower.rewards) {
      tower.rewards.forEach((r) => {
        rewards.push({ ...r });
        addRewardToPlayer(player, r.id, r.count);
      });
    }

    const towerRewardCfg = config.get('TowerRewardConfig');
    if (towerRewardCfg && towerRewardCfg[floor]) {
      const milestone = towerRewardCfg[floor];
      if (milestone.rewards) {
        milestone.rewards.forEach((r) => {
          rewards.push({ ...r, milestone: true });
          addRewardToPlayer(player, r.id, r.count);
        });
      }
    }

    swordInfo.score = (swordInfo.score || 0) + floor * 10;
    swordInfo.dailyCount = (swordInfo.dailyCount || 0) + 1;
    grantTowerSkillChoice(swordInfo, floor);
    await playerService.savePlayer(session.userId, player);
    await rank.updateScore('tower', player.playerId, swordInfo.maxlayer);
  }

  return {
    tag: 2350,
    msgUid,
    data: {
      result: 0,
      win: result.win,
      star: result.star,
      floor,
      maxFloor: swordInfo.maxlayer,
      score: swordInfo.score,
      rewards,
      rounds: result.totalRounds,
      battleLog: result.rounds,
      playerAttrs,
      monsterAttrs,
      powerScore: result.powerScore,
    },
  };
}

// Tower rank (tag:2700)
async function handleSwordRankInfo(_params, session, msgUid) {
  const player = session.player;
  const swordInfo = player ? ensureTowerInfo(player) : {};
  const playerId = player ? player.playerId : '';

  const myRank = playerId ? await rank.getRank('tower', playerId) : -1;
  const topList = await rank.getTopN('tower', 50);

  const playerService2 = require('../services/PlayerService');
  const rankList = [];
  for (const entry of topList) {
    const p = await playerService2.findByPlayerId(entry.playerId);
    rankList.push({
      rank: entry.rank,
      dbid: entry.playerId,
      playerId: entry.playerId,
      name: p ? p.name : 'unknown',
      level: p ? p.level : 1,
      kungfuId: Math.max(1, toSafeInt(p && p.roleInfo && p.roleInfo.kungfuId, 4)),
      power: Math.max(0, toSafeInt(p && p.power, 0)),
      avatar: 0,
      avatarUrl: '',
      avatarFrame: 0,
      title: 0,
      layer: Math.max(0, toSafeInt(entry.score, 0)),
      score: Math.max(0, toSafeInt(entry.score, 0)),
      floor: Math.max(0, toSafeInt(entry.score, 0)),
    });
  }

  const layer = Math.max(0, toSafeInt(swordInfo.maxlayer, 0));
  return {
    tag: 2700,
    msgUid,
    data: {
      rank: myRank > 0 ? myRank : 999,
      layer,
      ranklist: rankList,
      toplist: rankList.slice(0, 3),
      myRank: myRank > 0 ? myRank : 999,
      myScore: Math.max(0, toSafeInt(swordInfo.score, 0)),
      myFloor: layer,
      dailyCount: Math.max(0, toSafeInt(swordInfo.dailyCount, 0)),
      rankList,
    },
  };
}

// Select tower skill (tag:3700)
async function handleTowerSelectSkill(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 3700,
      msgUid,
      data: { result: -1, skillCount: 0, skills: [], slotlist: [], autoSelect: 0, autoPriority: [] },
    };
  }

  const swordInfo = ensureTowerInfo(player);
  const selectIndex = toSafeInt(params && params.select, -1);
  const replaceIndex = toSafeInt(params && params.replace, -1);
  const selectedSkill = selectIndex >= 0 ? normalizeTowerSkillId(swordInfo.skills[selectIndex]) : 0;

  if (selectIndex < 0 && replaceIndex < 0) {
    swordInfo.skills = [];
    swordInfo.skillCount = 0;
  } else if (selectedSkill <= 0) {
    return {
      tag: 3700,
      msgUid,
      data: buildTowerInfoPayload(swordInfo, { result: -1, msg: 'invalid_tower_skill' }),
    };
  } else {
    const limit = getTowerSlotLimit();
    const targetIndex = replaceIndex >= 0 && replaceIndex < swordInfo.slotlist.length
      ? replaceIndex
      : swordInfo.slotlist.length;
    if (targetIndex >= limit) {
      return {
        tag: 3700,
        msgUid,
        data: buildTowerInfoPayload(swordInfo, { result: -1, msg: 'tower_slot_locked' }),
      };
    }

    const oldSlot = swordInfo.slotlist[targetIndex] || null;
    const nextLevel = oldSlot && oldSlot.id === selectedSkill ? toSafeInt(oldSlot.lv, 1) + 1 : 1;
    swordInfo.slotlist[targetIndex] = { id: selectedSkill, lv: nextLevel };
    swordInfo.skills.splice(selectIndex, 1);
    swordInfo.skillCount = Math.max(0, toSafeInt(swordInfo.skillCount, 0) - 1);
    if (swordInfo.skillCount <= 0) swordInfo.skills = [];
  }

  swordInfo.slotlist = normalizeTowerSlotlist(swordInfo.slotlist);
  swordInfo.skills = normalizeTowerOptionalSkills(swordInfo.skills, swordInfo.slotlist);

  await playerService.savePlayer(session.userId, player);
  return {
    tag: 3700,
    msgUid,
    data: buildTowerInfoPayload(swordInfo),
  };
}

// Tower rank compatibility endpoint (tag:3701)
async function handleTowerRankInfoCompat(params, session, msgUid) {
  const rankInfo = await handleSwordRankInfo(params, session, msgUid);
  return { tag: 3701, msgUid, data: rankInfo.data };
}

// Toggle auto skill select (tag:3702)
async function handleTowerSetAutoSelect(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3702, msgUid, data: { result: -1, autoSelect: 0 } };

  const swordInfo = ensureTowerInfo(player);
  swordInfo.autoSelect = toSafeInt(params && params.autoSelect, 0) > 0 ? 1 : 0;

  await playerService.savePlayer(session.userId, player);
  return { tag: 3702, msgUid, data: buildTowerInfoPayload(swordInfo) };
}

// Set auto skill priority (tag:3703)
async function handleTowerSetAutoPriority(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3703, msgUid, data: { result: -1, priority: [] } };

  const swordInfo = ensureTowerInfo(player);
  const priority = Array.isArray(params && params.priority) ? params.priority : [];
  swordInfo.autoPriority = normalizeTowerAutoPriority(priority);

  await playerService.savePlayer(session.userId, player);
  return { tag: 3703, msgUid, data: buildTowerInfoPayload(swordInfo, { priority: swordInfo.autoPriority }) };
}

module.exports = {
  ensureTowerInfo,
  normalizeTowerAutoPriority,
  normalizeTowerOptionalSkills,
  normalizeTowerSlotlist,
  buildTowerSkillChoices,
  grantTowerSkillChoice,
  handleTowerFight,
  handleSwordRankInfo,
  handleTowerSelectSkill,
  handleTowerRankInfoCompat,
  handleTowerSetAutoSelect,
  handleTowerSetAutoPriority,
};
