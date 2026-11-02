const config = require('./ConfigService');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function getAssetsConfig() {
  return config.get('AssetsConfig') || {};
}

function getAssetRow(itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return null;
  const assetsCfg = getAssetsConfig();
  return assetsCfg[id] || assetsCfg[String(id)] || null;
}

function isSwordId(itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return false;
  const swordCfg = config.get('SwordConfig') || {};
  return !!(swordCfg[id] || swordCfg[String(id)]);
}

function isPetId(itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return false;
  const petCfg = config.get('PetConfig') || {};
  return !!(petCfg[id] || petCfg[String(id)]);
}

function isPetSoulId(itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return false;
  const petSoulCfg = config.get('PetSoulConfig') || {};
  return !!(petSoulCfg[id] || petSoulCfg[String(id)]);
}

function isBloodlineId(itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return false;
  const bloodlineCfg = config.get('BloodlineConfig') || {};
  return !!(bloodlineCfg[id] || bloodlineCfg[String(id)]);
}

function isValhallaId(itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return false;
  const valhallaCfg = config.get('ValhallaConfig') || {};
  return !!(valhallaCfg[id] || valhallaCfg[String(id)]);
}

function resolveMountGrantId(itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return 0;
  if (isSwordId(id)) return id;

  const specialCfg = config.get('SpecialSwordConfig') || {};
  const specialRow = specialCfg[id] || specialCfg[String(id)] || null;
  const showId = toSafeInt(specialRow && specialRow.showId, 0);
  if (showId > 0) return showId;

  const assetRow = getAssetRow(id);
  const paramId = toSafeInt(assetRow && assetRow.param, 0);
  if (paramId > 0 && isSwordId(paramId)) return paramId;
  return id;
}

function getRewardKind(itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return 'item';

  if (isSwordId(id)) return 'sword';
  if (isPetId(id)) return 'pet';
  if (isPetSoulId(id)) return 'petSoul';
  if (isBloodlineId(id)) return 'bloodline';
  if (isValhallaId(id)) return 'valhalla';

  const assetRow = getAssetRow(id);
  const assetType = toSafeInt(assetRow && assetRow.type, 0);
  if (assetType === 5 || assetType === 94) return 'sword';
  if (assetType === 6) return 'pet';
  if (assetType === 40) return 'petSoul';
  if (assetType === 22) return 'bloodline';

  const specialCfg = config.get('SpecialSwordConfig') || {};
  if (specialCfg[id] || specialCfg[String(id)]) return 'sword';

  return 'item';
}

function buildEmptyRewardInfo() {
  return {
    items: [],
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

function grantMountToPlayer(player, swordId) {
  // eslint-disable-next-line global-require
  const mount = require('../handlers/mount');
  if (!mount || typeof mount.ensureMountInfo !== 'function' || typeof mount.grantMountToPlayer !== 'function') {
    return null;
  }
  return mount.grantMountToPlayer(player, swordId);
}

function grantPetToPlayer(player, petId) {
  // eslint-disable-next-line global-require
  const pet = require('../handlers/pet');
  if (!pet || typeof pet.grantPetToPlayer !== 'function') {
    return null;
  }
  return pet.grantPetToPlayer(player, petId);
}

function grantPetSoulToPlayer(player, soulId) {
  // eslint-disable-next-line global-require
  const petSoul = require('../handlers/pet-soul');
  if (!petSoul || typeof petSoul.grantPetSoulToPlayer !== 'function') {
    return null;
  }
  return petSoul.grantPetSoulToPlayer(player, soulId);
}

function grantBloodlineToPlayer(player, bloodlineId) {
  // eslint-disable-next-line global-require
  const bloodline = require('../handlers/bloodline');
  if (!bloodline || typeof bloodline.grantBloodlineToPlayer !== 'function') {
    return null;
  }
  return bloodline.grantBloodlineToPlayer(player, bloodlineId);
}

function grantValhallaToPlayer(player, heroId) {
  // eslint-disable-next-line global-require
  const valhalla = require('../handlers/valhalla');
  if (!valhalla || typeof valhalla.grantValhallaToPlayer !== 'function') {
    return null;
  }
  return valhalla.grantValhallaToPlayer(player, heroId);
}

function grantRewardRow(player, row = {}, times = 1) {
  const rewardId = toSafeInt(row && row.id, 0);
  const rewardCount = Math.max(0, toSafeInt(row && row.count, 0) * Math.max(1, toSafeInt(times, 1)));
  if (rewardId <= 0 || rewardCount <= 0) {
    return {
      kind: 'item', itemDeltas: [], rewardItems: [], rewardEquips: [], rewardGems: [], rewardSwords: [], rewardPets: [], rewardPetSouls: [], rewardBloodlines: [], rewardValhalla: [],
    };
  }

  const kind = getRewardKind(rewardId);
  const itemDeltas = [];
  const rewardItems = [];
  const rewardEquips = [];
  const rewardGems = [];
  const rewardSwords = [];
  const rewardPets = [];
  const rewardPetSouls = [];
  const rewardBloodlines = [];
  const rewardValhalla = [];

  if (kind === 'sword') {
    const swordId = resolveMountGrantId(rewardId);
    for (let i = 0; i < rewardCount; i += 1) {
      const mount = grantMountToPlayer(player, swordId);
      if (mount) rewardSwords.push(mount);
    }
    return { kind, itemDeltas, rewardItems, rewardEquips, rewardGems, rewardSwords, rewardPets, rewardPetSouls, rewardBloodlines, rewardValhalla };
  }

  if (kind === 'pet') {
    for (let i = 0; i < rewardCount; i += 1) {
      const pet = grantPetToPlayer(player, rewardId);
      if (pet) rewardPets.push(pet);
    }
    return { kind, itemDeltas, rewardItems, rewardEquips, rewardGems, rewardSwords, rewardPets, rewardPetSouls, rewardBloodlines, rewardValhalla };
  }

  if (kind === 'petSoul') {
    for (let i = 0; i < rewardCount; i += 1) {
      const soul = grantPetSoulToPlayer(player, rewardId);
      if (soul) rewardPetSouls.push(soul);
    }
    return { kind, itemDeltas, rewardItems, rewardEquips, rewardGems, rewardSwords, rewardPets, rewardPetSouls, rewardBloodlines, rewardValhalla };
  }

  if (kind === 'bloodline') {
    for (let i = 0; i < rewardCount; i += 1) {
      const bloodline = grantBloodlineToPlayer(player, rewardId);
      if (bloodline) rewardBloodlines.push(bloodline);
    }
    return { kind, itemDeltas, rewardItems, rewardEquips, rewardGems, rewardSwords, rewardPets, rewardPetSouls, rewardBloodlines, rewardValhalla };
  }

  if (kind === 'valhalla') {
    for (let i = 0; i < rewardCount; i += 1) {
      const hero = grantValhallaToPlayer(player, rewardId);
      if (hero) rewardValhalla.push(hero);
    }
    return { kind, itemDeltas, rewardItems, rewardEquips, rewardGems, rewardSwords, rewardPets, rewardPetSouls, rewardBloodlines, rewardValhalla };
  }

  return {
    kind: 'item',
    itemDeltas,
    rewardItems: [{ id: rewardId, count: rewardCount }],
    rewardEquips,
    rewardGems,
    rewardSwords,
    rewardPets,
    rewardPetSouls,
    rewardBloodlines,
    rewardValhalla,
    deferBagGrant: false,
  };
}

module.exports = {
  buildEmptyRewardInfo,
  getRewardKind,
  grantRewardRow,
  grantMountToPlayer,
  grantPetToPlayer,
  grantPetSoulToPlayer,
  grantBloodlineToPlayer,
  grantValhallaToPlayer,
};
