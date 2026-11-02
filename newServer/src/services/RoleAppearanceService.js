const configService = require('./ConfigService');

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.floor(num) : fallback;
}

function ensurePlainObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function getRoleGenderConfig() {
  return ensurePlainObject(configService.get('RoleGenderConfig'));
}

function getFashionConfig() {
  return ensurePlainObject(configService.get('FashionConfig'));
}

function getAssetsConfig() {
  return ensurePlainObject(configService.get('AssetsConfig'));
}

function normalizeRoleSelection(roleInfo = {}) {
  const roleGenderCfg = getRoleGenderConfig();

  let kungfuId = Math.max(0, toSafeInt(roleInfo.kungfuId, 4));
  let kungfuCfg = ensurePlainObject(roleGenderCfg[String(kungfuId)]);
  if (Object.keys(kungfuCfg).length <= 0) {
    const fallbackKey = Object.keys(roleGenderCfg).find((key) => {
      const row = roleGenderCfg[key];
      return row && typeof row === 'object' && !Array.isArray(row);
    });
    if (fallbackKey != null) {
      kungfuId = Math.max(0, toSafeInt(fallbackKey, 4));
      kungfuCfg = ensurePlainObject(roleGenderCfg[String(kungfuId)]);
    }
  }

  const availableSubJobs = Object.keys(kungfuCfg)
    .map((key) => Math.max(0, toSafeInt(key, -1)))
    .filter((key) => key >= 0)
    .sort((a, b) => a - b);

  let subJob = Math.max(0, toSafeInt(roleInfo.subJob, 0));
  if (!availableSubJobs.includes(subJob)) {
    subJob = availableSubJobs.includes(0)
      ? 0
      : (availableSubJobs.length > 0 ? availableSubJobs[0] : 0);
  }

  return { kungfuId, subJob };
}

function getRoleGenderRow(roleInfo = {}) {
  const roleGenderCfg = getRoleGenderConfig();
  const normalized = normalizeRoleSelection(roleInfo);
  const kungfuCfg = ensurePlainObject(roleGenderCfg[String(normalized.kungfuId)]);
  const row = ensurePlainObject(kungfuCfg[String(normalized.subJob)]);
  return {
    kungfuId: normalized.kungfuId,
    subJob: normalized.subJob,
    row,
  };
}

function buildDefaultFashionMap(roleInfo = {}) {
  const { row } = getRoleGenderRow(roleInfo);
  const fashionCfg = getFashionConfig();
  const fashionMap = {};
  ensureArray(row.initShows).forEach((showIdRaw) => {
    const showId = Math.max(0, toSafeInt(showIdRaw, 0));
    if (showId <= 0) return;
    const showCfg = fashionCfg[String(showId)] || fashionCfg[showId];
    const type = Math.max(0, toSafeInt(showCfg && showCfg.type, 0));
    if (type <= 0) return;
    fashionMap[String(type)] = showId;
  });
  return fashionMap;
}

function normalizeFashionMap(raw = {}, defaults = {}) {
  const fashionCfg = getFashionConfig();
  const normalized = {};
  Object.keys(ensurePlainObject(raw)).forEach((typeKey) => {
    const type = Math.max(0, toSafeInt(typeKey, 0));
    const id = Math.max(0, toSafeInt(raw[typeKey], 0));
    const row = ensurePlainObject(fashionCfg[String(id)] || fashionCfg[id]);
    if (type > 0 && id > 0 && toSafeInt(row.type, 0) === type) {
      normalized[String(type)] = id;
    }
  });
  Object.keys(ensurePlainObject(defaults)).forEach((typeKey) => {
    const type = Math.max(0, toSafeInt(typeKey, 0));
    const id = Math.max(0, toSafeInt(defaults[typeKey], 0));
    const row = ensurePlainObject(fashionCfg[String(id)] || fashionCfg[id]);
    if (type > 0 && id > 0 && toSafeInt(row.type, 0) === type && normalized[String(type)] == null) {
      normalized[String(type)] = id;
    }
  });
  return normalized;
}

function ensureFashionOwnershipState(player = {}) {
  if (!player || typeof player !== 'object') return {};
  if (!player.fashionInfo || typeof player.fashionInfo !== 'object' || Array.isArray(player.fashionInfo)) {
    player.fashionInfo = {};
  }

  const fashionInfo = player.fashionInfo;
  if (!fashionInfo.curFashion || typeof fashionInfo.curFashion !== 'object' || Array.isArray(fashionInfo.curFashion)) {
    fashionInfo.curFashion = {};
  }
  if (!fashionInfo.fashion || typeof fashionInfo.fashion !== 'object' || Array.isArray(fashionInfo.fashion)) {
    fashionInfo.fashion = {};
  }
  if (!fashionInfo.fashionMap || typeof fashionInfo.fashionMap !== 'object' || Array.isArray(fashionInfo.fashionMap)) {
    fashionInfo.fashionMap = {};
  }
  if (!fashionInfo.fashions || typeof fashionInfo.fashions !== 'object' || Array.isArray(fashionInfo.fashions)) {
    fashionInfo.fashions = {};
  }
  if (!Array.isArray(fashionInfo.activateFashion)) {
    fashionInfo.activateFashion = [];
  }

  return fashionInfo;
}

function ensureRoleAppearance(player = {}) {
  if (!player || typeof player !== 'object') return false;

  player.roleInfo = ensurePlainObject(player.roleInfo);
  player.fashionInfo = ensurePlainObject(player.fashionInfo);

  const roleInfo = player.roleInfo;
  const fashionInfo = ensureFashionOwnershipState(player);
  const normalized = getRoleGenderRow(roleInfo);
  let changed = false;

  if (toSafeInt(roleInfo.kungfuId, -1) !== normalized.kungfuId) {
    roleInfo.kungfuId = normalized.kungfuId;
    changed = true;
  }
  if (toSafeInt(roleInfo.subJob, -1) !== normalized.subJob) {
    roleInfo.subJob = normalized.subJob;
    changed = true;
  }
  if (roleInfo.gender == null && normalized.row && normalized.row.gender != null) {
    roleInfo.gender = Math.max(0, toSafeInt(normalized.row.gender, 0));
    changed = true;
  }

  if (!fashionInfo.curFashion || typeof fashionInfo.curFashion !== 'object' || Array.isArray(fashionInfo.curFashion)) {
    fashionInfo.curFashion = {};
    changed = true;
  }
  if (!fashionInfo.fashion || typeof fashionInfo.fashion !== 'object' || Array.isArray(fashionInfo.fashion)) {
    fashionInfo.fashion = {};
    changed = true;
  }
  if (!fashionInfo.fashionMap || typeof fashionInfo.fashionMap !== 'object' || Array.isArray(fashionInfo.fashionMap)) {
    fashionInfo.fashionMap = {};
    changed = true;
  }
  if (!fashionInfo.fashions || typeof fashionInfo.fashions !== 'object' || Array.isArray(fashionInfo.fashions)) {
    fashionInfo.fashions = {};
    changed = true;
  }
  if (!Array.isArray(fashionInfo.activateFashion)) {
    fashionInfo.activateFashion = [];
    changed = true;
  }

  const defaultFashionMap = buildDefaultFashionMap(roleInfo);
  const normalizedCurrentFashion = normalizeFashionMap(fashionInfo.curFashion, defaultFashionMap);
  if (JSON.stringify(fashionInfo.curFashion) !== JSON.stringify(normalizedCurrentFashion)) {
    fashionInfo.curFashion = normalizedCurrentFashion;
    changed = true;
  }
  if (JSON.stringify(fashionInfo.fashion) !== JSON.stringify(normalizedCurrentFashion)) {
    fashionInfo.fashion = { ...normalizedCurrentFashion };
    changed = true;
  }
  if (JSON.stringify(fashionInfo.fashionMap) !== JSON.stringify(normalizedCurrentFashion)) {
    fashionInfo.fashionMap = { ...normalizedCurrentFashion };
    changed = true;
  }

  const fashionCfg = getFashionConfig();
  const normalizedOwnedMap = {};
  Object.keys(fashionInfo.fashions).forEach((idKey) => {
    const id = Math.max(0, toSafeInt(idKey, 0));
    if (id > 0 && (fashionCfg[String(id)] || fashionCfg[id])) {
      normalizedOwnedMap[String(id)] = Math.max(1, toSafeInt(fashionInfo.fashions[idKey], 1));
    }
  });
  if (JSON.stringify(fashionInfo.fashions) !== JSON.stringify(normalizedOwnedMap)) {
    fashionInfo.fashions = normalizedOwnedMap;
    changed = true;
  }
  const normalizedActivated = Array.from(new Set(
    ensureArray(fashionInfo.activateFashion)
      .map((id) => Math.max(0, toSafeInt(id, 0)))
      .filter((id) => id > 0 && (fashionCfg[String(id)] || fashionCfg[id]))
  )).sort((a, b) => a - b);
  if (JSON.stringify(fashionInfo.activateFashion) !== JSON.stringify(normalizedActivated)) {
    fashionInfo.activateFashion = normalizedActivated;
    changed = true;
  }

  Object.keys(defaultFashionMap).forEach((typeKey) => {
    const defaultId = Math.max(0, toSafeInt(defaultFashionMap[typeKey], 0));
    if (defaultId <= 0) return;

    if (toSafeInt(fashionInfo.curFashion[typeKey], 0) <= 0) {
      fashionInfo.curFashion[typeKey] = defaultId;
      changed = true;
    }
    if (toSafeInt(fashionInfo.fashion[typeKey], 0) <= 0) {
      fashionInfo.fashion[typeKey] = Math.max(0, toSafeInt(fashionInfo.curFashion[typeKey], defaultId));
      changed = true;
    }
    if (toSafeInt(fashionInfo.fashionMap[typeKey], 0) <= 0) {
      fashionInfo.fashionMap[typeKey] = Math.max(0, toSafeInt(fashionInfo.curFashion[typeKey], defaultId));
      changed = true;
    }

    const ownedKey = String(defaultId);
    if (toSafeInt(fashionInfo.fashions[ownedKey], 0) <= 0) {
      fashionInfo.fashions[ownedKey] = 1;
      changed = true;
    }
    if (!fashionInfo.activateFashion.includes(defaultId)) {
      fashionInfo.activateFashion.push(defaultId);
      changed = true;
    }
  });

  fashionInfo.activateFashion = Array.from(
    new Set(
      ensureArray(fashionInfo.activateFashion)
        .map((id) => Math.max(0, toSafeInt(id, 0)))
        .filter((id) => id > 0)
    )
  ).sort((a, b) => a - b);

  Object.keys(fashionInfo.curFashion).forEach((typeKey) => {
    const currentId = Math.max(0, toSafeInt(fashionInfo.curFashion[typeKey], 0));
    if (currentId <= 0) return;
    if (toSafeInt(fashionInfo.fashion[typeKey], 0) !== currentId) {
      fashionInfo.fashion[typeKey] = currentId;
      changed = true;
    }
    if (toSafeInt(fashionInfo.fashionMap[typeKey], 0) !== currentId) {
      fashionInfo.fashionMap[typeKey] = currentId;
      changed = true;
    }
    const ownedKey = String(currentId);
    if (toSafeInt(fashionInfo.fashions[ownedKey], 0) <= 0) {
      fashionInfo.fashions[ownedKey] = 1;
      changed = true;
    }
    if (!fashionInfo.activateFashion.includes(currentId)) {
      fashionInfo.activateFashion.push(currentId);
      changed = true;
    }
  });

  const rewardAvatar = ensureArray(normalized.row && normalized.row.rewards)
    .map((reward) => Math.max(0, toSafeInt(reward && reward.id, 0)))
    .find((id) => id > 0) || 0;
  if (rewardAvatar > 0 && toSafeInt(player.avatar, 0) <= 0) {
    player.avatar = rewardAvatar;
    changed = true;
  }
  if (rewardAvatar > 0 && toSafeInt(roleInfo.avatar, 0) <= 0) {
    roleInfo.avatar = rewardAvatar;
    changed = true;
  }

  const equipList = ensureArray(ensurePlainObject(player.equipInfo).equipList);
  equipList.forEach((equip) => {
    if (unlockEquipAppearance(player, equip)) {
      changed = true;
    }
  });

  return changed;
}

function resolveEquipFashionIds(equipOrItemId) {
  const itemId = Math.max(0, toSafeInt(
    equipOrItemId && typeof equipOrItemId === 'object' ? equipOrItemId.id : equipOrItemId,
    0
  ));
  if (itemId <= 0) return [];

  const fashionCfg = getFashionConfig();
  const assetsCfg = getAssetsConfig();
  const assetRow = ensurePlainObject(assetsCfg[String(itemId)] || assetsCfg[itemId]);
  const candidateIds = [itemId, toSafeInt(assetRow.param, 0)];

  return Array.from(new Set(candidateIds))
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .filter((id) => id > 0)
    .filter((id) => {
      const row = fashionCfg[String(id)] || fashionCfg[id];
      return row && typeof row === 'object' && !Array.isArray(row);
    });
}

function unlockFashionOwnership(player = {}, fashionId) {
  const safeFashionId = Math.max(0, toSafeInt(fashionId, 0));
  if (safeFashionId <= 0) return false;

  const fashionCfg = getFashionConfig();
  const fashionRow = ensurePlainObject(fashionCfg[String(safeFashionId)] || fashionCfg[safeFashionId]);
  const type = Math.max(0, toSafeInt(fashionRow.type, 0));
  if (type <= 0) return false;

  const fashionInfo = ensureFashionOwnershipState(player);
  let changed = false;

  if (toSafeInt(fashionInfo.fashions[String(safeFashionId)], 0) <= 0) {
    fashionInfo.fashions[String(safeFashionId)] = 1;
    changed = true;
  }

  if (!ensureArray(fashionInfo.activateFashion).includes(safeFashionId)) {
    fashionInfo.activateFashion.push(safeFashionId);
    fashionInfo.activateFashion = Array.from(new Set(fashionInfo.activateFashion
      .map((id) => Math.max(0, toSafeInt(id, 0)))
      .filter((id) => id > 0))).sort((a, b) => a - b);
    changed = true;
  }

  if (toSafeInt(fashionInfo.curFashion[String(type)], 0) <= 0) {
    fashionInfo.curFashion[String(type)] = safeFashionId;
    changed = true;
  }
  if (toSafeInt(fashionInfo.fashion[String(type)], 0) <= 0) {
    fashionInfo.fashion[String(type)] = Math.max(0, toSafeInt(fashionInfo.curFashion[String(type)], safeFashionId));
    changed = true;
  }
  if (toSafeInt(fashionInfo.fashionMap[String(type)], 0) <= 0) {
    fashionInfo.fashionMap[String(type)] = Math.max(0, toSafeInt(fashionInfo.curFashion[String(type)], safeFashionId));
    changed = true;
  }

  return changed;
}

function unlockEquipAppearance(player = {}, equipOrItemId) {
  const fashionIds = resolveEquipFashionIds(equipOrItemId);
  let changed = false;
  fashionIds.forEach((fashionId) => {
    if (unlockFashionOwnership(player, fashionId)) {
      changed = true;
    }
  });
  return changed;
}

function getPlayerFashionMap(player = {}) {
  ensureRoleAppearance(player);
  const fashionInfo = ensurePlainObject(player && player.fashionInfo);
  const raw = Object.keys(ensurePlainObject(fashionInfo.fashionMap)).length > 0
    ? fashionInfo.fashionMap
    : fashionInfo.curFashion;
  const map = {};
  Object.keys(ensurePlainObject(raw)).forEach((typeKey) => {
    const id = Math.max(0, toSafeInt(raw[typeKey], 0));
    if (id > 0) map[String(typeKey)] = id;
  });
  return map;
}

function getPrimaryBattlePetId(player = {}) {
  const pets = getBattlePets(player);
  return pets.length > 0 ? pets[0].id : 0;
}

function getBattlePets(player = {}) {
  const petInfo = ensurePlainObject(player && player.petInfo);
  const pets = ensureArray(petInfo.pets)
    .filter((pet) => pet && typeof pet === 'object')
    .map((pet) => ({
      ...pet,
      id: Math.max(0, toSafeInt(pet.id, 0)),
      slot: toSafeInt(pet.slot, -1),
    }))
    .filter((pet) => pet.id > 0);

  const activePets = pets
    .filter((pet) => pet.slot < 0)
    .sort((a, b) => Math.abs(a.slot) - Math.abs(b.slot))
    .slice(0, 3);
  return activePets;
}

function applyPrimaryBattlePetParts(entity = {}, player = {}) {
  if (!entity || typeof entity !== 'object') return entity;

  const battlePets = getBattlePets(player);
  const primaryPetId = Math.max(0, toSafeInt(battlePets[0] && battlePets[0].id, 0));
  const parts = ensurePlainObject(entity.parts);

  entity.parts = parts;
  if (!entity.partValues || typeof entity.partValues !== 'object' || Array.isArray(entity.partValues)) {
    entity.partValues = {};
  }

  [10100, 10101, 10102].forEach((partId) => {
    if (partId === 10100 && primaryPetId > 0) parts[partId] = primaryPetId;
    else if (parts[partId] != null) delete parts[partId];
  });

  if (primaryPetId > 0) {
    entity.battlePetIds = [primaryPetId];
  } else if (entity.battlePetIds != null) {
    delete entity.battlePetIds;
  }

  if (entity.showInfo && typeof entity.showInfo === 'object' && !Array.isArray(entity.showInfo)) {
    entity.showInfo.petId = primaryPetId > 0 ? primaryPetId : Math.max(0, toSafeInt(entity.showInfo.petId, 0));
  }

  return entity;
}

module.exports = {
  ensureRoleAppearance,
  getPlayerFashionMap,
  getBattlePets,
  getPrimaryBattlePetId,
  applyPrimaryBattlePetParts,
  buildDefaultFashionMap,
  normalizeFashionMap,
  getRoleGenderRow,
  normalizeRoleSelection,
  unlockEquipAppearance,
};
