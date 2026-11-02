/**
 * 宠物系统
 * tag: 3300 开蛋, 3301 改变槽位, 3302 合成, 3304 升级, 3305 锁定被动技能
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const {
  addPetComposeCount,
  addPetWashCount,
  refreshMainTaskProgress,
} = require('../services/MainTaskProgressService');
const { addRewardToPlayer } = require('./raid');

const FREE_PET_EGG_ITEM_ID = 24;
const FREE_PET_EGG_RECOVER_MS = 6 * 60 * 60 * 1000;
const FREE_PET_EGG_MAX = 5;
const PET_SWAP_PILL_ITEM_ID = 162;

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function getCurrencyKeyById(itemId) {
  switch (toSafeInt(itemId, 0)) {
    case 1: return 'diamond';
    case 2: return 'silver';
    case 6: return 'gold';
    default: return null;
  }
}

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

function isPetComposeFailOpenEnabled() {
  return parseBool(
    process.env.PET_COMPOSE_FAIL_OPEN,
    true
  );
}

function hasEnoughItemOrCurrency(player, itemId, count) {
  const id = toSafeInt(itemId, 0);
  const need = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || need <= 0) return true;

  const currKey = getCurrencyKeyById(id);
  if (currKey) {
    player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
    return toSafeInt(player.currencies[currKey], 0) >= need;
  }

  player.items = player.items || {};
  return toSafeInt(player.items[id], 0) >= need;
}

function consumeItemOrCurrency(player, itemId, count) {
  if (!hasEnoughItemOrCurrency(player, itemId, count)) return false;
  const id = toSafeInt(itemId, 0);
  const need = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || need <= 0) return true;

  const currKey = getCurrencyKeyById(id);
  if (currKey) {
    player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
    player.currencies[currKey] = Math.max(0, toSafeInt(player.currencies[currKey], 0) - need);
    return true;
  }

  player.items = player.items || {};
  player.items[id] = Math.max(0, toSafeInt(player.items[id], 0) - need);
  return true;
}

function getItemOrCurrencyCount(player, itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return 0;

  const currKey = getCurrencyKeyById(id);
  if (currKey) {
    return Math.max(0, toSafeInt(player && player.currencies && player.currencies[currKey], 0));
  }
  return Math.max(0, toSafeInt(player && player.items && player.items[id], 0));
}

function buildPetCostSync(player, beforeCostMap = {}, afterCostMap = {}) {
  const items = [];
  const changed = [];
  const itemIds = new Set([
    ...Object.keys(beforeCostMap || {}).map((key) => toSafeInt(key, 0)),
    ...Object.keys(afterCostMap || {}).map((key) => toSafeInt(key, 0)),
  ]);

  itemIds.forEach((itemId) => {
    if (itemId <= 0) return;
    const before = Math.max(0, toSafeInt(beforeCostMap[itemId], 0));
    const after = Math.max(0, toSafeInt(afterCostMap[itemId], 0));
    if (before === after) return;
    items.push({ id: itemId, count: after - before });
    changed.push({ id: itemId, count: after });
  });

  if (changed.length === 0) return null;
  return {
    tag: 1202,
    msgUid: 0,
    data: {
      result: 0,
      items,
      changed,
    },
  };
}

function buildPetRewardPayload(rewards = []) {
  const items = Array.isArray(rewards) ? rewards : [];
  return {
    items,
    equips: [],
    heros: [],
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

function randomPickWeighted(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const valid = entries.filter((row) => row && row.weight > 0);
  if (valid.length === 0) return entries[0] || null;
  const total = valid.reduce((sum, row) => sum + row.weight, 0);
  let roll = Math.random() * total;
  for (const row of valid) {
    roll -= row.weight;
    if (roll <= 0) return row;
  }
  return valid[valid.length - 1];
}

function getPetCfgMap() {
  return config.get('PetConfig') || {};
}

function getPetCfgById(petId) {
  return getPetCfgMap()[toSafeInt(petId, 0)] || null;
}

function getFallbackPetId() {
  const petCfg = getPetCfgMap();
  const ids = Object.keys(petCfg).map((k) => toSafeInt(k, 0)).filter((id) => id > 0);
  return ids.length > 0 ? ids[0] : 82001;
}

function getPetQuality(petId) {
  const row = getPetCfgById(petId);
  return Math.max(2, toSafeInt(row && row.quality, 2));
}

function getPetType(petId) {
  const row = getPetCfgById(petId);
  return Math.max(0, toSafeInt(row && row.type, 0));
}

function getPetTag(petId) {
  const row = getPetCfgById(petId);
  return Math.max(0, toSafeInt(row && row.tag, 0));
}

function getMaxPetQuality() {
  const qualityCfg = config.get('PetQualityConfig') || {};
  const keys = Object.keys(qualityCfg).map((k) => toSafeInt(k, 0)).filter((v) => v > 0);
  if (keys.length === 0) return 9;
  return Math.max(...keys);
}

function getPetLevelMax() {
  return Math.max(1, toSafeInt((config.get('PetBaseConfig') || {}).levelMax, 200));
}

function pickPassiveSkills(petId, quality) {
  const qualityCfg = (config.get('PetQualityConfig') || {})[quality] || {};
  const skillCount = Math.max(0, toSafeInt(qualityCfg.passiveSkillCount, 0));
  if (skillCount <= 0) return [];

  const petType = getPetType(petId);
  const skillCfg = config.get('PetPassiveSkillConfig') || {};
  const candidates = Object.keys(skillCfg)
    .map((k) => toSafeInt(k, 0))
    .filter((id) => {
      const row = skillCfg[id];
      if (!row) return false;
      const skillQuality = Math.max(1, toSafeInt(row.quality, 1));
      const type = Math.max(0, toSafeInt(row.type, 0));
      return skillQuality <= quality && (type === 0 || type === petType);
    });

  if (candidates.length === 0) return [];

  const picked = [];
  const used = new Set();
  while (picked.length < skillCount && used.size < candidates.length) {
    const id = candidates[Math.floor(Math.random() * candidates.length)];
    if (used.has(id)) continue;
    used.add(id);
    picked.push(id);
  }
  return picked;
}

function normalizePet(rawPet, info) {
  const pet = rawPet && typeof rawPet === 'object' ? rawPet : {};
  const id = toSafeInt(pet.id, getFallbackPetId());
  const quality = getPetQuality(id);
  const level = Math.max(1, toSafeInt(pet.level, 1));
  const uid = toSafeInt(pet.uid, 0) > 0 ? toSafeInt(pet.uid, 0) : toSafeInt(info.nextUid, 100001);
  if (uid >= toSafeInt(info.nextUid, 100001)) info.nextUid = uid + 1;

  const passiveSkills = Array.isArray(pet.passiveSkills) && pet.passiveSkills.length > 0
    ? pet.passiveSkills.map((v) => toSafeInt(v, 0)).filter((v) => v > 0)
    : pickPassiveSkills(id, quality);
  const lockSkills = (Array.isArray(pet.lockSkills) ? pet.lockSkills : [])
    .map((v) => toSafeInt(v, -1))
    .filter((v, idx, arr) => v >= 0 && v < passiveSkills.length && arr.indexOf(v) === idx);
  const locked = toSafeInt(pet.locked, toSafeInt(pet.lock, 0)) > 0 ? 1 : 0;

  return {
    ...pet,
    uid,
    id,
    level,
    slot: toSafeInt(pet.slot, -1),
    exp: Math.max(0, toSafeInt(pet.exp, 0)),
    locked,
    lock: locked,
    passiveSkills,
    lockSkills,
  };
}

function ensurePetInfo(player) {
  const baseCfg = config.get('PetBaseConfig') || {};

  player.petInfo = player.petInfo && typeof player.petInfo === 'object' && !Array.isArray(player.petInfo)
    ? player.petInfo
    : {};

  const info = player.petInfo;
  if (!Array.isArray(info.pets)) info.pets = [];
  if (!Array.isArray(info.unlockAtlas)) info.unlockAtlas = [];
  if (!Array.isArray(info.rewardedAtlas)) info.rewardedAtlas = [];
  if (!info.wishMap || typeof info.wishMap !== 'object' || Array.isArray(info.wishMap)) info.wishMap = {};
  if (info.field == null) info.field = Math.max(1, toSafeInt(baseCfg.initialField, 8));
  info.field = Math.max(1, toSafeInt(info.field, Math.max(1, toSafeInt(baseCfg.initialField, 8))));
  if (info.skillWashLevel == null || toSafeInt(info.skillWashLevel, 0) <= 0) info.skillWashLevel = 1;
  if (info.skillWashExp == null) info.skillWashExp = 0;
  if (!info.timeRecords || typeof info.timeRecords !== 'object' || Array.isArray(info.timeRecords)) info.timeRecords = {};

  const maxUid = info.pets.reduce((m, row) => Math.max(m, toSafeInt(row && row.uid, 0)), 100000);
  if (!Number.isFinite(Number(info.nextUid)) || toSafeInt(info.nextUid, 0) <= maxUid) {
    info.nextUid = maxUid + 1;
  }

  info.pets = info.pets.map((pet) => normalizePet(pet, info));
  info.unlockAtlas = info.unlockAtlas
    .map((v) => toSafeInt(v, 0))
    .filter((v, idx, arr) => v > 0 && arr.indexOf(v) === idx);
  info.rewardedAtlas = info.rewardedAtlas
    .map((v) => toSafeInt(v, 0))
    .filter((v, idx, arr) => v > 0 && arr.indexOf(v) === idx);

  return info;
}

function getPetTimeRecordStart(info, itemId) {
  const safeInfo = info && typeof info === 'object' ? info : {};
  const records = safeInfo.timeRecords && typeof safeInfo.timeRecords === 'object' && !Array.isArray(safeInfo.timeRecords)
    ? safeInfo.timeRecords
    : {};
  return Math.max(0, toSafeInt(records[itemId], 0));
}

function setPetTimeRecordStart(info, itemId, startTime) {
  if (!info || typeof info !== 'object') return;
  if (!info.timeRecords || typeof info.timeRecords !== 'object' || Array.isArray(info.timeRecords)) {
    info.timeRecords = {};
  }
  const safeTime = Math.max(0, toSafeInt(startTime, 0));
  if (safeTime > 0) info.timeRecords[itemId] = safeTime;
  else delete info.timeRecords[itemId];
}

function settleFreePetEgg(player) {
  if (!player || typeof player !== 'object') return false;
  const info = ensurePetInfo(player);
  player.items = player.items && typeof player.items === 'object' && !Array.isArray(player.items) ? player.items : {};

  let count = Math.max(0, toSafeInt(player.items[FREE_PET_EGG_ITEM_ID], 0));
  let startTime = getPetTimeRecordStart(info, FREE_PET_EGG_ITEM_ID);
  const now = Date.now();
  let changed = false;

  if (count >= FREE_PET_EGG_MAX) {
    if (count > FREE_PET_EGG_MAX) {
      count = FREE_PET_EGG_MAX;
      changed = true;
    }
    if (startTime !== 0) {
      startTime = 0;
      changed = true;
    }
  } else if (startTime <= 0) {
    startTime = now;
    changed = true;
  } else {
    const elapsed = now - startTime;
    if (elapsed >= FREE_PET_EGG_RECOVER_MS) {
      const gained = Math.floor(elapsed / FREE_PET_EGG_RECOVER_MS);
      if (gained > 0) {
        count = Math.min(FREE_PET_EGG_MAX, count + gained);
        changed = true;
        if (count >= FREE_PET_EGG_MAX) startTime = 0;
        else startTime += gained * FREE_PET_EGG_RECOVER_MS;
      }
    }
  }

  player.items[FREE_PET_EGG_ITEM_ID] = count;
  if (count <= 0) delete player.items[FREE_PET_EGG_ITEM_ID];
  setPetTimeRecordStart(info, FREE_PET_EGG_ITEM_ID, startTime);
  return changed;
}

function buildPetTimeRecordPayload(player) {
  const info = ensurePetInfo(player);
  settleFreePetEgg(player);
  return {
    [FREE_PET_EGG_ITEM_ID]: getPetTimeRecordStart(info, FREE_PET_EGG_ITEM_ID),
  };
}

function buildPetDataUpdatePacket(pets = [], msgUid = 0) {
  const data = (Array.isArray(pets) ? pets : [pets])
    .filter((pet) => pet && typeof pet === 'object');
  if (data.length <= 0) return null;
  return { tag: 3301, msgUid, data: { data } };
}

function addUnlockAtlas(info, petId) {
  const id = toSafeInt(petId, 0);
  if (id <= 0) return;
  if (!info.unlockAtlas.includes(id)) info.unlockAtlas.push(id);
}

function findPetByUid(info, uid) {
  const targetUid = toSafeInt(uid, 0);
  return info.pets.find((row) => toSafeInt(row && row.uid, 0) === targetUid) || null;
}

function findFirstEmptyComposeSlot(info) {
  const occupied = new Set(
    info.pets
      .map((row) => toSafeInt(row && row.slot, -1))
      .filter((slot) => slot >= 0)
  );
  for (let i = 0; i < Math.max(1, toSafeInt(info.field, 8)); i++) {
    if (!occupied.has(i)) return i;
  }
  return -1;
}

function createPet(info, petId, slot) {
  const id = toSafeInt(petId, getFallbackPetId());
  const quality = getPetQuality(id);
  return normalizePet({
    uid: info.nextUid++,
    id,
    level: 1,
    slot: toSafeInt(slot, -1),
    exp: 0,
    locked: 0,
    lock: 0,
    passiveSkills: pickPassiveSkills(id, quality),
    lockSkills: [],
  }, info);
}

function grantPetToPlayer(player, petId) {
  const info = ensurePetInfo(player);
  const id = toSafeInt(petId, 0);
  if (id <= 0) return null;
  const slot = findFirstEmptyComposeSlot(info);
  const pet = createPet(info, id, slot);
  info.pets.push(pet);
  addUnlockAtlas(info, pet.id);
  return pet;
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

function pickSkillByWashRate(petType, targetQuality) {
  const quality = Math.max(1, toSafeInt(targetQuality, 1));
  const skillCfg = config.get('PetPassiveSkillConfig') || {};
  const candidates = Object.keys(skillCfg)
    .map((k) => toSafeInt(k, 0))
    .filter((id) => {
      const row = skillCfg[id];
      if (!row) return false;
      const skillQuality = Math.max(1, toSafeInt(row.quality, 1));
      const type = Math.max(0, toSafeInt(row.type, 0));
      return skillQuality === quality && (type === 0 || type === petType);
    });
  if (candidates.length === 0) {
    const fallback = pickPassiveSkills(getFallbackPetId(), quality);
    return fallback.length > 0 ? fallback[0] : 800001;
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function rollSkillQualityByWashLevel(washLevel) {
  const washCfg = (config.get('PetPassiveSkillWashConfig') || {})[Math.max(1, toSafeInt(washLevel, 1))] || {};
  const rates = Array.isArray(washCfg.rate) ? washCfg.rate : [];
  const entries = rates
    .map((row) => ({ id: toSafeInt(row && row.id, 0), weight: Math.max(0, toSafeInt(row && row.weight, 0)) }))
    .filter((row) => row.id > 0 && row.weight > 0);
  const picked = randomPickWeighted(entries);
  return picked ? picked.id : 1;
}

function pickPetIdByQualityRange(minQuality, maxQuality, preferredType = -1) {
  const petCfg = getPetCfgMap();
  const candidates = Object.keys(petCfg)
    .map((k) => toSafeInt(k, 0))
    .filter((id) => {
      const row = petCfg[id];
      if (!row) return false;
      const quality = toSafeInt(row.quality, 0);
      const type = toSafeInt(row.type, 0);
      if (quality < minQuality || quality > maxQuality) return false;
      if (preferredType >= 0 && type !== preferredType) return false;
      return true;
    });

  if (candidates.length === 0) return null;
  const entries = candidates.map((id) => ({
    id,
    weight: Math.max(1, toSafeInt((petCfg[id] && petCfg[id].composeWeight), 100)),
  }));
  const picked = randomPickWeighted(entries);
  return picked ? picked.id : candidates[0];
}

function getEggQualityRange(eggId) {
  const id = toSafeInt(eggId, 24);
  if (id === 24) return [2, 4];
  if (id === 25) return [3, 6];
  if (id === 26) return [4, getMaxPetQuality()];
  return [2, 4];
}

function pickPetIdByEgg(eggId) {
  const eggCfg = (config.get('PetEggConfig') || {})[toSafeInt(eggId, 24)] || {};
  const pools = Array.isArray(eggCfg.pools) ? eggCfg.pools : [];
  const poolEntries = pools
    .map((row) => ({ id: toSafeInt(row && row.id, 0), weight: Math.max(0, toSafeInt(row && row.weight, 0)) }))
    .filter((row) => row.id > 0 && row.weight > 0);

  let minQuality = 2;
  let maxQuality = 4;
  const pickedPool = randomPickWeighted(poolEntries);
  if (pickedPool) {
    if (pickedPool.id === 1001) [minQuality, maxQuality] = [2, 4];
    else if (pickedPool.id === 1002) [minQuality, maxQuality] = [3, 6];
    else if (pickedPool.id === 1003) [minQuality, maxQuality] = [4, getMaxPetQuality()];
    else [minQuality, maxQuality] = getEggQualityRange(eggId);
  } else {
    [minQuality, maxQuality] = getEggQualityRange(eggId);
  }

  return pickPetIdByQualityRange(minQuality, maxQuality) || getFallbackPetId();
}

function countPetsByQuality(info, quality) {
  const targetQuality = toSafeInt(quality, 0);
  if (!info || !Array.isArray(info.pets) || targetQuality <= 0) return 0;
  return info.pets.reduce((count, pet) => (
    getPetQuality(pet && pet.id) === targetQuality ? count + 1 : count
  ), 0);
}

function pickPetIdForEgg(info, eggId) {
  const id = toSafeInt(eggId, 24);
  if (id === 24 && countPetsByQuality(info, 2) < 2) {
    return pickPetIdByQualityRange(2, 2) || pickPetIdByEgg(id);
  }
  return pickPetIdByEgg(id);
}

function pickComposeResultId(matPet, targetPet) {
  const source = targetPet || matPet;
  const sourceType = source ? getPetType(source.id) : -1;
  const baseQuality = Math.max(
    getPetQuality(matPet && matPet.id),
    getPetQuality(targetPet && targetPet.id)
  );
  const resultQuality = Math.min(getMaxPetQuality(), Math.max(2, baseQuality + 1));
  return pickPetIdByQualityRange(resultQuality, resultQuality, sourceType)
    || pickPetIdByQualityRange(resultQuality, resultQuality)
    || getFallbackPetId();
}

function pickComposeExpPetId(sourcePet) {
  const quality = getPetQuality(sourcePet && sourcePet.id);
  return pickPetIdByQualityRange(quality, quality, 0)
    || pickPetIdByQualityRange(quality, quality)
    || getFallbackPetId();
}

function canPetCompose(matPet, targetPet) {
  if (!matPet || !targetPet || matPet.uid === targetPet.uid) return false;
  if (toSafeInt(matPet.locked, toSafeInt(matPet.lock, 0)) > 0) return false;
  if (toSafeInt(targetPet.locked, toSafeInt(targetPet.lock, 0)) > 0) return false;
  if (getPetQuality(matPet.id) !== getPetQuality(targetPet.id)) return false;
  if (getPetQuality(targetPet.id) >= getMaxPetQuality()) return false;
  const matCfg = getPetCfgById(matPet.id) || {};
  const targetCfg = getPetCfgById(targetPet.id) || {};
  return toSafeInt(matCfg.tag, 1) !== 2 && toSafeInt(targetCfg.tag, 1) !== 2;
}

function canPetEat(matPet, targetPet) {
  if (!matPet || !targetPet || matPet.uid === targetPet.uid) return false;
  if (toSafeInt(targetPet.id, 0) <= 0) return false;
  if (toSafeInt(matPet.locked, toSafeInt(matPet.lock, 0)) > 0) return false;
  return getPetTag(matPet.id) === 2;
}

function isBattleSlot(slot) {
  const safeSlot = toSafeInt(slot, 0);
  return safeSlot <= -1 && safeSlot >= -3;
}

function isSwapBlockedPet(petId) {
  const quality = getPetQuality(petId);
  if (quality < Math.max(1, toSafeInt((config.get('PetBaseConfig') || {}).swapQuality, 7))) return true;
  if (quality >= getMaxPetQuality()) return true;
  return getPetTag(petId) === 2;
}

function isValidWishPetId(quality, petId) {
  const id = toSafeInt(petId, 0);
  if (id <= 0) return false;
  if (getPetQuality(id) !== Math.max(1, toSafeInt(quality, 1))) return false;
  return !isSwapBlockedPet(id);
}

function getPetSwapItemCost(targetPet) {
  const cfg = getPetCfgById(targetPet && targetPet.id) || {};
  const row = cfg.swapCostItem && typeof cfg.swapCostItem === 'object'
    ? cfg.swapCostItem
    : { id: PET_SWAP_PILL_ITEM_ID, count: Math.max(1, toSafeInt(cfg.swapCostCount, 1)) };
  return {
    id: Math.max(0, toSafeInt(row.id, PET_SWAP_PILL_ITEM_ID)),
    count: Math.max(0, toSafeInt(row.count, 0)),
  };
}

function getPetSwapMaterialQuality(targetPet) {
  const cfg = getPetCfgById(targetPet && targetPet.id) || {};
  return Math.max(0, toSafeInt(cfg.swapCost, getPetQuality(targetPet && targetPet.id) - 1));
}

function canUsePetAsSwapMaterial(pet, requiredQuality, targetUid) {
  if (!pet) return false;
  if (toSafeInt(pet.uid, 0) === toSafeInt(targetUid, 0)) return false;
  if (toSafeInt(pet.locked, toSafeInt(pet.lock, 0)) > 0) return false;
  if (isBattleSlot(pet.slot)) return false;
  if (getPetTag(pet.id) === 2) return false;
  return getPetQuality(pet.id) === Math.max(0, toSafeInt(requiredQuality, 0));
}

function pickSwapResultId(info, targetPet, excludedIds = []) {
  const quality = getPetQuality(targetPet && targetPet.id);
  const excluded = new Set((Array.isArray(excludedIds) ? excludedIds : []).map((id) => toSafeInt(id, 0)).filter((id) => id > 0));
  excluded.add(toSafeInt(targetPet && targetPet.id, 0));
  const wishedId = toSafeInt(info && info.wishMap && info.wishMap[String(quality)], 0);
  if (isValidWishPetId(quality, wishedId) && !excluded.has(wishedId) && Math.random() < 0.5) {
    return wishedId;
  }

  const petCfg = getPetCfgMap();
  const candidates = Object.keys(petCfg)
    .map((key) => toSafeInt(key, 0))
    .filter((id) => {
      if (id <= 0 || excluded.has(id)) return false;
      const row = petCfg[id];
      if (!row) return false;
      if (toSafeInt(row.quality, 0) !== quality) return false;
      return toSafeInt(row.tag, 0) !== 2;
    });
  if (candidates.length <= 0) return toSafeInt(targetPet && targetPet.id, 0);
  const weighted = candidates.map((id) => ({ id, weight: Math.max(1, toSafeInt((petCfg[id] && petCfg[id].composeWeight), 100)) }));
  const picked = randomPickWeighted(weighted);
  return picked ? picked.id : candidates[0];
}

function buildPetSwapFail(msgUid, targetPet = null) {
  return { tag: 3312, msgUid, data: { result: -1, costUid: [], data: targetPet || null } };
}

function getPetUpgradeCostRow(pet, levelOffset = 0) {
  const quality = getPetQuality(pet && pet.id);
  const qualityCfg = (config.get('PetQualityConfig') || {})[quality] || {};
  const baseCost = Array.isArray(qualityCfg.consumes) ? qualityCfg.consumes[0] : null;
  const addCost = Array.isArray(qualityCfg.addConsumes) ? qualityCfg.addConsumes[0] : null;
  const costId = toSafeInt(baseCost && baseCost.id, 0);
  if (costId <= 0) return null;

  const currentLevel = Math.max(1, toSafeInt(pet && pet.level, 1)) + Math.max(0, toSafeInt(levelOffset, 0));
  const baseCount = Math.max(0, toSafeInt(baseCost && baseCost.count, 0));
  const addCount = Math.max(0, toSafeInt(addCost && addCost.count, 0));
  return { id: costId, count: baseCount + addCount * Math.max(0, currentLevel - 1) };
}

function buildPetUpgradeCostMap(pet, addLv) {
  const costMap = {};
  for (let i = 0; i < Math.max(0, toSafeInt(addLv, 0)); i += 1) {
    const cost = getPetUpgradeCostRow(pet, i);
    if (!cost || cost.count <= 0) continue;
    costMap[cost.id] = Math.max(0, toSafeInt(costMap[cost.id], 0)) + cost.count;
  }
  return costMap;
}

function hasEnoughCostMap(player, costMap = {}) {
  return Object.keys(costMap).every((itemId) => hasEnoughItemOrCurrency(player, itemId, costMap[itemId]));
}

function consumeCostMap(player, costMap = {}) {
  Object.keys(costMap).forEach((itemId) => {
    consumeItemOrCurrency(player, itemId, costMap[itemId]);
  });
}

// 开蛋 (tag:3300)
async function handlePetUseEgg(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3300, msgUid, data: { result: -1, data: [] } };

  const info = ensurePetInfo(player);
  settleFreePetEgg(player);
  const eggId = toSafeInt(params && params.eggId, 24);
  const trackedCostIds = [eggId];
  const beforeCostMap = Object.fromEntries(
    trackedCostIds.map((itemId) => [itemId, getItemOrCurrencyCount(player, itemId)])
  );

  const enoughEgg = hasEnoughItemOrCurrency(player, eggId, 1);
  if (!enoughEgg) {
    return { tag: 3300, msgUid, data: { result: -1, data: [] } };
  }

  consumeItemOrCurrency(player, eggId, 1);

  const petId = pickPetIdForEgg(info, eggId);
  const slot = findFirstEmptyComposeSlot(info);
  const pet = createPet(info, petId, slot);
  info.pets.push(pet);
  addUnlockAtlas(info, pet.id);

  const taskChanged = !!refreshMainTaskProgress(player);
  await playerService.savePlayer(session.userId, player);
  const afterCostMap = Object.fromEntries(
    trackedCostIds.map((itemId) => [itemId, getItemOrCurrencyCount(player, itemId)])
  );
  const costSyncPacket = buildPetCostSync(player, beforeCostMap, afterCostMap);
  const response = { tag: 3300, msgUid, data: { result: 0, data: [pet] } };
  if (costSyncPacket) {
    costSyncPacket.data.timeRecords = buildPetTimeRecordPayload(player);
  }
  if (costSyncPacket || taskChanged) {
    return [
      response,
      ...(costSyncPacket ? [costSyncPacket] : []),
      ...buildTaskUpdatePacketsSafe(player),
    ];
  }
  return response;
}

function rollComposeSuccess(quality) {
  const qualityCfg = (config.get('PetQualityConfig') || {})[Math.max(1, toSafeInt(quality, 1))] || {};
  const rate = Math.max(0, Math.min(10000, toSafeInt(qualityCfg.composeSuccessRate, 0)));
  if (rate >= 10000) return true;
  if (rate <= 0) return false;
  return Math.random() * 10000 < rate;
}

// 槽位变更 (tag:3301)
async function handlePetChangeSlot(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3301, msgUid, data: { result: -1, data: [] } };

  const info = ensurePetInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const slot = toSafeInt(params && params.slot, -1);
  const pet = findPetByUid(info, uid);
  if (!pet) return { tag: 3301, msgUid, data: { result: -1, data: [] } };
  if (slot < -3) return { tag: 3301, msgUid, data: { result: -1, data: [] } };
  if (slot >= Math.max(1, toSafeInt(info.field, 8))) return { tag: 3301, msgUid, data: { result: -1, data: [] } };

  const prevSlot = toSafeInt(pet.slot, -1);
  const swapped = info.pets.find((row) => toSafeInt(row && row.uid, 0) !== uid && toSafeInt(row && row.slot, -2) === slot) || null;
  if (swapped) swapped.slot = prevSlot;
  pet.slot = slot;

  const taskChanged = !!refreshMainTaskProgress(player);
  await playerService.savePlayer(session.userId, player);
  const changed = [pet];
  if (swapped) changed.push(swapped);
  const response = { tag: 3301, msgUid, data: { result: 0, data: changed } };
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

// 合成 (tag:3302)
async function handlePetCompose(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3302, msgUid, data: { result: -1, data: null, rewards: buildPetRewardPayload() } };

  const info = ensurePetInfo(player);
  const matUid = toSafeInt(params && params.uid, 0);
  const targetUid = toSafeInt(params && params.targetUid, 0);
  const matPet = findPetByUid(info, matUid);
  const targetPet = findPetByUid(info, targetUid);
  if (!canPetCompose(matPet, targetPet)) {
    return { tag: 3302, msgUid, data: { result: -1, data: null, rewards: buildPetRewardPayload() } };
  }

  const composeQuality = getPetQuality(targetPet.id);
  const qualityCfg = (config.get('PetQualityConfig') || {})[composeQuality] || {};
  const consumes = Array.isArray(qualityCfg.consumes) ? qualityCfg.consumes : [];
  const trackedCostIds = consumes
    .map((cost) => toSafeInt(cost && cost.id, 0))
    .filter((itemId, idx, arr) => itemId > 0 && arr.indexOf(itemId) === idx);
  const beforeCostMap = Object.fromEntries(
    trackedCostIds.map((itemId) => [itemId, getItemOrCurrencyCount(player, itemId)])
  );
  consumes.forEach((cost) => consumeItemOrCurrency(player, cost.id, cost.count));

  const sameSeries = getPetType(matPet.id) === getPetType(targetPet.id);
  const success = rollComposeSuccess(composeQuality) || isPetComposeFailOpenEnabled();
  const resultId = success
    ? (sameSeries ? pickComposeResultId(matPet, targetPet) : pickComposeExpPetId(targetPet))
    : pickComposeExpPetId(targetPet);
  const resultPet = createPet(info, resultId, toSafeInt(targetPet.slot, -1));
  resultPet.level = Math.max(1, toSafeInt(targetPet.level, 1));
  info.pets = info.pets.filter((row) => {
    const uid = toSafeInt(row && row.uid, 0);
    return uid !== matPet.uid && uid !== targetPet.uid;
  });
  info.pets.push(resultPet);
  addUnlockAtlas(info, resultPet.id);

  const taskChanged = !!addPetComposeCount(player, 1);
  await playerService.savePlayer(session.userId, player);
  const afterCostMap = Object.fromEntries(
    trackedCostIds.map((itemId) => [itemId, getItemOrCurrencyCount(player, itemId)])
  );
  const costSyncPacket = buildPetCostSync(player, beforeCostMap, afterCostMap);
  const dataUpdatePacket = buildPetDataUpdatePacket(resultPet);
  const response = { tag: 3302, msgUid, data: { result: 0, data: resultPet, rewards: buildPetRewardPayload(), rewardInfo: buildPetRewardPayload() } };
  return (dataUpdatePacket || costSyncPacket || taskChanged)
    ? [
      response,
      ...(dataUpdatePacket ? [dataUpdatePacket] : []),
      ...(costSyncPacket ? [costSyncPacket] : []),
      ...(taskChanged ? buildTaskUpdatePacketsSafe(player) : []),
    ]
    : response;
}

// 升级 (tag:3304)
async function handlePetUpgrade(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3304, msgUid, data: { result: -1, data: null } };

  const info = ensurePetInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const addLv = Math.max(1, toSafeInt(params && params.lv, 1));
  const pet = findPetByUid(info, uid);
  if (!pet) return { tag: 3304, msgUid, data: { result: -1, data: null } };

  const levelMax = Math.max(1, toSafeInt((config.get('PetBaseConfig') || {}).levelMax, 200));
  const oldLevel = Math.max(1, toSafeInt(pet.level, 1));
  const actualAddLv = Math.min(addLv, Math.max(0, levelMax - oldLevel));
  if (actualAddLv <= 0) return { tag: 3304, msgUid, data: { result: -1, data: pet } };

  const costMap = buildPetUpgradeCostMap(pet, actualAddLv);
  if (!hasEnoughCostMap(player, costMap)) {
    return { tag: 3304, msgUid, data: { result: -1, data: pet } };
  }

  const trackedCostIds = Object.keys(costMap).map((itemId) => toSafeInt(itemId, 0)).filter((itemId) => itemId > 0);
  const beforeCostMap = Object.fromEntries(
    trackedCostIds.map((itemId) => [itemId, getItemOrCurrencyCount(player, itemId)])
  );

  consumeCostMap(player, costMap);
  pet.level = Math.min(levelMax, oldLevel + actualAddLv);

  await playerService.savePlayer(session.userId, player);
  const afterCostMap = Object.fromEntries(
    trackedCostIds.map((itemId) => [itemId, getItemOrCurrencyCount(player, itemId)])
  );
  const costSyncPacket = buildPetCostSync(player, beforeCostMap, afterCostMap);
  const response = { tag: 3304, msgUid, data: { result: 0, data: pet } };
  return costSyncPacket ? [response, costSyncPacket] : response;
}

// 锁定被动技能 (tag:3305)
async function handlePetLockSkill(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3305, msgUid, data: { result: -1, data: null } };

  const info = ensurePetInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const pet = findPetByUid(info, uid);
  if (!pet) return { tag: 3305, msgUid, data: { result: -1, data: null } };

  const lock = toSafeInt(params && params.lock, 0) > 0;
  const skillIndex = Math.max(0, toSafeInt(params && params.skillIndex, 0));
  if (!Array.isArray(pet.lockSkills)) pet.lockSkills = [];
  const idx = pet.lockSkills.indexOf(skillIndex);
  if (lock && idx < 0) pet.lockSkills.push(skillIndex);
  if (!lock && idx >= 0) pet.lockSkills.splice(idx, 1);
  pet.lockSkills = pet.lockSkills
    .map((v) => toSafeInt(v, -1))
    .filter((v, pos, arr) => v >= 0 && v < (Array.isArray(pet.passiveSkills) ? pet.passiveSkills.length : 0) && arr.indexOf(v) === pos);

  await playerService.savePlayer(session.userId, player);
  return { tag: 3305, msgUid, data: { result: 0, data: pet } };
}

// 洗练被动技能 (tag:3306)
async function handlePetWashSkill(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 3306, msgUid, data: { result: -1, level: 1, exp: 0, data: null } };
  }

  const info = ensurePetInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const pet = findPetByUid(info, uid);
  if (!pet) {
    return {
      tag: 3306,
      msgUid,
      data: { result: -1, level: toSafeInt(info.skillWashLevel, 1), exp: toSafeInt(info.skillWashExp, 0), data: null },
    };
  }

  const baseCfg = config.get('PetBaseConfig') || {};
  const consumeList = Array.isArray(baseCfg.pSkillWashConsume) ? baseCfg.pSkillWashConsume : [];
  const level = Math.max(1, toSafeInt(info.skillWashLevel, 1));
  const costRow = consumeList[Math.min(Math.max(level - 1, 0), Math.max(consumeList.length - 1, 0))]
    || { id: 37, count: 10 };
  const costId = toSafeInt(costRow && costRow.id, 0);
  const costCount = Math.max(0, toSafeInt(costRow && costRow.count, 0));
  if (costId > 0 && costCount > 0 && !hasEnoughItemOrCurrency(player, costId, costCount)) {
    return {
      tag: 3306,
      msgUid,
      data: { result: -1, level: toSafeInt(info.skillWashLevel, 1), exp: toSafeInt(info.skillWashExp, 0), data: pet },
    };
  }
  const beforeCostMap = costId > 0 ? { [costId]: getItemOrCurrencyCount(player, costId) } : {};
  if (costId > 0 && costCount > 0) consumeItemOrCurrency(player, costId, costCount);

  const lockSet = new Set((Array.isArray(pet.lockSkills) ? pet.lockSkills : []).map((v) => toSafeInt(v, -1)));
  const currentSkills = Array.isArray(pet.passiveSkills) ? pet.passiveSkills.slice() : [];
  const nextSkills = [];
  const petType = getPetType(pet.id);
  for (let i = 0; i < currentSkills.length; i++) {
    if (lockSet.has(i) && toSafeInt(currentSkills[i], 0) > 0) {
      nextSkills.push(toSafeInt(currentSkills[i], 0));
      continue;
    }
    const targetQuality = rollSkillQualityByWashLevel(level);
    nextSkills.push(pickSkillByWashRate(petType, targetQuality));
  }
  pet.passiveSkills = nextSkills;
  pet.lockSkills = Array.from(lockSet).filter((idx) => idx >= 0 && idx < pet.passiveSkills.length);

  const washCfg = (config.get('PetPassiveSkillWashConfig') || {})[level] || {};
  const needExp = Math.max(1, toSafeInt(washCfg.exp, 1));
  info.skillWashExp = Math.max(0, toSafeInt(info.skillWashExp, 0) + 1);
  while (info.skillWashExp >= needExp && needExp > 0) {
    info.skillWashExp -= needExp;
    info.skillWashLevel = Math.max(1, toSafeInt(info.skillWashLevel, 1) + 1);
    const nextCfg = (config.get('PetPassiveSkillWashConfig') || {})[toSafeInt(info.skillWashLevel, 1)];
    if (!nextCfg) break;
  }

  const taskChanged = !!addPetWashCount(player, 1);
  await playerService.savePlayer(session.userId, player);
  const afterCostMap = costId > 0 ? { [costId]: getItemOrCurrencyCount(player, costId) } : {};
  const costSyncPacket = buildPetCostSync(player, beforeCostMap, afterCostMap);
  const response = {
    tag: 3306,
    msgUid,
    data: {
      result: 0,
      level: toSafeInt(info.skillWashLevel, 1),
      exp: toSafeInt(info.skillWashExp, 0),
      data: pet,
    },
  };
  return (costSyncPacket || taskChanged)
    ? [
      ...(costSyncPacket ? [costSyncPacket] : []),
      ...(taskChanged ? buildTaskUpdatePacketsSafe(player) : []),
      response,
    ]
    : response;
}

// 重置 (tag:3307)
async function handlePetReset(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3307, msgUid, data: { result: -1, data: null, rewards: [] } };

  const info = ensurePetInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const pet = findPetByUid(info, uid);
  if (!pet) return { tag: 3307, msgUid, data: { result: -1, data: null, rewards: [] } };

  const baseCfg = config.get('PetBaseConfig') || {};
  const resetConsume = Array.isArray(baseCfg.resetConsume) ? baseCfg.resetConsume : [];
  let canReset = true;
  for (const cost of resetConsume) {
    if (!hasEnoughItemOrCurrency(player, cost.id, cost.count)) {
      canReset = false;
      break;
    }
  }
  if (canReset) {
    resetConsume.forEach((cost) => consumeItemOrCurrency(player, cost.id, cost.count));
  }

  const oldLevel = Math.max(1, toSafeInt(pet.level, 1));
  if (canReset) pet.level = 1;
  const returnRate = Math.max(0, toSafeInt(baseCfg.returnRate, 10000));
  const returnCount = Math.max(0, Math.floor(Math.max(0, oldLevel - 1) * returnRate / 10000));
  const rewards = returnCount > 0 ? [{ id: 37, count: returnCount }] : [];
  rewards.forEach((reward) => addRewardToPlayer(player, reward.id, reward.count));

  await playerService.savePlayer(session.userId, player);
  return { tag: 3307, msgUid, data: { result: canReset ? 0 : -1, data: pet, rewards } };
}

// 购买宠物栏位 (tag:3308)
async function handlePetBuyField(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3308, msgUid, data: { result: -1, field: 0 } };

  const info = ensurePetInfo(player);
  const baseCfg = config.get('PetBaseConfig') || {};
  const initial = Math.max(1, toSafeInt(baseCfg.initialField, 8));
  const fieldConsume = Array.isArray(baseCfg.fieldConsume) ? baseCfg.fieldConsume : [];
  const currentField = Math.max(initial, toSafeInt(info.field, initial));
  const idx = Math.max(0, currentField - initial);
  const diamondCost = Math.max(0, toSafeInt(fieldConsume[idx], 0));
  if (diamondCost > 0 && hasEnoughItemOrCurrency(player, 1, diamondCost)) {
    consumeItemOrCurrency(player, 1, diamondCost);
  }

  // Client callback unconditionally increments local field on any response;
  // keep server state in sync by always increasing one slot per successful RPC.
  info.field = currentField + 1;
  await playerService.savePlayer(session.userId, player);
  return { tag: 3308, msgUid, data: { result: 0, field: info.field } };
}

// 图鉴奖励 (tag:3309)
async function handlePetAtlasReward(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    const emptyReward = buildPetRewardPayload();
    return { tag: 3309, msgUid, data: { result: -1, rewardedAtlas: [], rewards: emptyReward, rewardInfo: emptyReward } };
  }

  const info = ensurePetInfo(player);
  let atlasId = toSafeInt(params && params.id, 0);
  const rewardedAtlas = [];
  const rewards = [];
  const trackedRewardIds = new Set();
  let beforeRewardMap = {};

  if (atlasId <= 0) {
    atlasId = info.unlockAtlas.find((id) => !info.rewardedAtlas.includes(id)) || 0;
  }

  if (
    atlasId > 0
    && info.unlockAtlas.includes(atlasId)
    && !info.rewardedAtlas.includes(atlasId)
  ) {
    info.rewardedAtlas.push(atlasId);
    rewardedAtlas.push(atlasId);
    const petCfg = getPetCfgById(atlasId) || {};
    const reward = petCfg.atlasReward || null;
    if (reward && toSafeInt(reward.id, 0) > 0 && toSafeInt(reward.count, 0) > 0) {
      const rewardId = toSafeInt(reward.id, 0);
      const rewardCount = toSafeInt(reward.count, 0);
      trackedRewardIds.add(rewardId);
      beforeRewardMap = { [rewardId]: getItemOrCurrencyCount(player, rewardId) };
      rewards.push({ id: rewardId, count: rewardCount });
      addRewardToPlayer(player, rewardId, rewardCount);
    }
  }

  await playerService.savePlayer(session.userId, player);
  const rewardInfo = buildPetRewardPayload(rewards);
  const afterRewardMap = Object.fromEntries(
    Array.from(trackedRewardIds).map((itemId) => [itemId, getItemOrCurrencyCount(player, itemId)])
  );
  const rewardSyncPacket = buildPetCostSync(player, beforeRewardMap, afterRewardMap);
  const response = { tag: 3309, msgUid, data: { result: 0, rewardedAtlas, rewards: rewardInfo, rewardInfo } };
  if (rewardSyncPacket) {
    const emptyReward = buildPetRewardPayload([]);
    rewardSyncPacket.data.rewardedAtlas = [];
    rewardSyncPacket.data.rewards = emptyReward;
    rewardSyncPacket.data.rewardInfo = emptyReward;
  }
  return rewardSyncPacket ? [response, rewardSyncPacket] : response;
}

// 锁定宠物 (tag:3310)
async function handlePetLock(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3310, msgUid, data: { result: -1, data: null } };

  const info = ensurePetInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const pet = findPetByUid(info, uid);
  if (!pet) return { tag: 3310, msgUid, data: { result: -1, data: null } };

  const locked = toSafeInt(params && params.lock, 0) > 0 ? 1 : 0;
  pet.locked = locked;
  pet.lock = locked;

  await playerService.savePlayer(session.userId, player);
  return { tag: 3310, msgUid, data: { result: 0, data: pet } };
}

// 吞噬 (tag:3311)
async function handlePetEat(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3311, msgUid, data: { result: -1, data: null, rewards: buildPetRewardPayload() } };

  const info = ensurePetInfo(player);
  const matUid = toSafeInt(params && params.matUid, 0);
  const targetUid = toSafeInt(params && params.targetUid, 0);
  const matPet = findPetByUid(info, matUid);
  const targetPet = findPetByUid(info, targetUid);
  if (!canPetEat(matPet, targetPet)) {
    return { tag: 3311, msgUid, data: { result: -1, data: null, rewards: buildPetRewardPayload() } };
  }

  const levelMax = Math.max(1, toSafeInt((config.get('PetBaseConfig') || {}).levelMax, 200));
  const gainLevel = Math.max(1, Math.max(1, toSafeInt(matPet.level, 1)));
  targetPet.level = Math.min(levelMax, Math.max(1, toSafeInt(targetPet.level, 1) + gainLevel));

  info.pets = info.pets.filter((row) => toSafeInt(row && row.uid, 0) !== matPet.uid);
  const rewards = [];

  await playerService.savePlayer(session.userId, player);
  return { tag: 3311, msgUid, data: { result: 0, data: targetPet, rewards: buildPetRewardPayload(rewards), rewardInfo: buildPetRewardPayload(rewards) } };
}

// 替换 (tag:3312)
async function handlePetSwap(params, session, msgUid) {
  const player = session.player;
  if (!player) return buildPetSwapFail(msgUid);

  const info = ensurePetInfo(player);
  const uid = toSafeInt(params && params.uid, 0);
  const targetPet = findPetByUid(info, uid);
  if (!targetPet) return buildPetSwapFail(msgUid);
  if (isSwapBlockedPet(targetPet.id)) return buildPetSwapFail(msgUid, targetPet);

  const swapType = Math.max(1, toSafeInt(params && params.type, 1));
  const costUidRaw = Array.isArray(params && params.costUid) ? params.costUid : [];
  const requestedCostUid = costUidRaw
    .map((v) => toSafeInt(v, 0))
    .filter((v, idx, arr) => v > 0 && v !== uid && arr.indexOf(v) === idx);
  const trackedCostIds = [];
  const beforeCostMap = {};
  const quality = getPetQuality(targetPet.id);
  const preserveLevel = Math.max(1, toSafeInt(targetPet.level, 1));
  const preserveSkills = Array.isArray(targetPet.passiveSkills) ? targetPet.passiveSkills.slice() : [];
  const preserveLockSkills = Array.isArray(targetPet.lockSkills) ? targetPet.lockSkills.slice() : [];
  const excludedIds = [targetPet.id];
  let costUid = [];

  if (swapType === 2) {
    const needQuality = getPetSwapMaterialQuality(targetPet);
    if (needQuality <= 0) {
      return buildPetSwapFail(msgUid, targetPet);
    }
    const materialPets = requestedCostUid
      .map((petUid) => findPetByUid(info, petUid))
      .filter((pet) => canUsePetAsSwapMaterial(pet, needQuality, uid));
    if (materialPets.length <= 0) {
      return buildPetSwapFail(msgUid, targetPet);
    }
    costUid = materialPets.map((pet) => pet.uid);
    materialPets.forEach((pet) => excludedIds.push(pet.id));
    info.pets = info.pets.filter((row) => !costUid.includes(toSafeInt(row && row.uid, 0)));
  } else {
    const itemCost = getPetSwapItemCost(targetPet);
    if (itemCost.id <= 0 || itemCost.count <= 0 || !hasEnoughItemOrCurrency(player, itemCost.id, itemCost.count)) {
      return buildPetSwapFail(msgUid, targetPet);
    }
    trackedCostIds.push(itemCost.id);
    beforeCostMap[itemCost.id] = getItemOrCurrencyCount(player, itemCost.id);
    consumeItemOrCurrency(player, itemCost.id, itemCost.count);
  }

  const nextId = pickSwapResultId(info, targetPet, excludedIds);
  targetPet.id = nextId;
  targetPet.level = preserveLevel;
  targetPet.passiveSkills = preserveSkills;
  targetPet.lockSkills = preserveLockSkills.filter((index) => index >= 0 && index < targetPet.passiveSkills.length);
  addUnlockAtlas(info, targetPet.id);

  await playerService.savePlayer(session.userId, player);
  const afterCostMap = Object.fromEntries(
    trackedCostIds.map((itemId) => [itemId, getItemOrCurrencyCount(player, itemId)])
  );
  const costSyncPacket = buildPetCostSync(player, beforeCostMap, afterCostMap);
  const response = { tag: 3312, msgUid, data: { result: 0, costUid, data: targetPet } };
  return costSyncPacket ? [response, costSyncPacket] : response;
}

// 设置心愿 (tag:3313)
async function handlePetSetWish(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3313, msgUid, data: { result: -1, quality: 0, id: 0 } };

  const info = ensurePetInfo(player);
  const quality = Math.max(1, toSafeInt(params && params.quality, 1));
  const petId = toSafeInt(params && params.id, 0);
  if (petId > 0 && isValidWishPetId(quality, petId)) info.wishMap[String(quality)] = petId;
  else if (petId <= 0) delete info.wishMap[String(quality)];

  await playerService.savePlayer(session.userId, player);
  return { tag: 3313, msgUid, data: { result: 0, quality, id: toSafeInt(info.wishMap[String(quality)], 0) } };
}

// 自动合成 (tag:3314)
async function handlePetAutoCompose(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 3314, msgUid, data: { result: -1, pets: [], unlockAtlas: [] } };

  const info = ensurePetInfo(player);
  const maxAutoQuality = Math.max(2, toSafeInt(params && params.quality, 4));
  const unlockAtlas = [];
  const maxQuality = getMaxPetQuality();

  let composeCount = 0;
  let changed = true;
  let guard = 0;
  while (changed && guard < 128) {
    guard += 1;
    changed = false;

    const composePets = info.pets.filter((pet) => {
      if (toSafeInt(pet && pet.slot, -1) < 0) return false;
      if (toSafeInt(pet && pet.locked, 0) > 0) return false;
      if (toSafeInt(pet && pet.level, 1) > 1) return false;
      const petCfg = getPetCfgById(pet && pet.id) || {};
      const quality = getPetQuality(pet && pet.id);
      return toSafeInt(petCfg.tag, 1) !== 2 && quality < maxAutoQuality && quality < maxQuality;
    });

    const groupMap = new Map();
    composePets.forEach((pet) => {
      const quality = getPetQuality(pet.id);
      const key = `${quality}`;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(pet);
    });

    let pair = null;
    for (const pets of groupMap.values()) {
      if (pets.length >= 2) {
        pair = [pets[0], pets[1]];
        break;
      }
    }
    if (!pair) break;

    const [a, b] = pair;
    const quality = getPetQuality(a.id);
    const success = rollComposeSuccess(quality);
    const nextId = success && getPetType(a.id) === getPetType(b.id)
      ? pickComposeResultId(a, b)
      : pickComposeExpPetId(a);
    const composed = createPet(info, nextId, toSafeInt(a.slot, -1));
    composed.level = 1;
    composed.locked = 0;
    composed.lock = 0;
    composed.passiveSkills = pickPassiveSkills(composed.id, getPetQuality(composed.id));
    composed.lockSkills = [];

    info.pets = info.pets.filter((pet) => {
      const uid = toSafeInt(pet && pet.uid, 0);
      return uid !== a.uid && uid !== b.uid;
    });
    info.pets.push(composed);
    if (!info.unlockAtlas.includes(composed.id)) {
      info.unlockAtlas.push(composed.id);
      unlockAtlas.push(composed.id);
    }
    composeCount += 1;
    changed = true;
  }

  const taskChanged = composeCount > 0 ? !!addPetComposeCount(player, composeCount) : false;
  await playerService.savePlayer(session.userId, player);
  const response = { tag: 3314, msgUid, data: { result: 0, pets: info.pets, unlockAtlas } };
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

module.exports = {
  ensurePetInfo,
  grantPetToPlayer,
  settleFreePetEgg,
  buildPetTimeRecordPayload,
  handlePetUseEgg,
  handlePetChangeSlot,
  handlePetCompose,
  handlePetUpgrade,
  handlePetLockSkill,
  handlePetWashSkill,
  handlePetReset,
  handlePetBuyField,
  handlePetAtlasReward,
  handlePetLock,
  handlePetEat,
  handlePetSwap,
  handlePetSetWish,
  handlePetAutoCompose,
};
