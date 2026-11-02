/**
 * EquipService
 * Normalize equip structures and provide open-list replace/sale helpers.
 */

const configService = require('./ConfigService');
const { syncCurrencyItems } = require('./CurrencySync');
const { unlockEquipAppearance } = require('./RoleAppearanceService');

const EQUIP_SPECIAL_ATTR_IDS = [101, 102, 103, 104, 105, 106];

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAttrs(attrs) {
  if (!isPlainObject(attrs)) return {};
  const out = {};
  Object.keys(attrs).forEach((key) => {
    const val = Number(attrs[key]);
    if (Number.isFinite(val)) out[String(key)] = val;
  });
  return out;
}

function normalizeEquip(raw) {
  if (!isPlainObject(raw)) return null;
  const uid = toSafeInt(raw.uid, 0);
  const id = toSafeInt(raw.id, 0);
  if (uid <= 0 || id <= 0) return null;

  const assets = getAssetsConfig();
  const asset = getAssetRow(id, assets);
  if (Object.keys(assets).length > 0 && (!asset || toSafeInt(asset.type, 0) !== 3)) {
    return null;
  }
  const type = Math.max(0, toSafeInt(asset && asset.subType, toSafeInt(raw.type, 0)));
  if (type <= 0) return null;
  const quality = Math.max(1, toSafeInt(asset && asset.quality, toSafeInt(raw.quailty, 1)));

  return {
    ...raw,
    uid,
    id,
    type,
    quailty: quality,
    lv: Math.max(1, toSafeInt(raw.lv, 1)),
    attrs: normalizeAttrs(raw.attrs),
  };
}

function ensurePlanObject(map, planId) {
  const key = String(toSafeInt(planId, 0));
  if (!isPlainObject(map[key])) {
    map[key] = {};
  }
  return map[key];
}

function cloneObject(value) {
  return isPlainObject(value) ? { ...value } : {};
}

function getInitialFormationId() {
  const formationCfg = configService.get('FormationConfig');
  const formationMap = isPlainObject(formationCfg) ? formationCfg : {};
  const baseCfg = configService.get('FormationBaseConfig');
  const configured = Math.max(1, toSafeInt(baseCfg && baseCfg.formationInitialId, 21001));
  if (formationMap[configured] || formationMap[String(configured)]) return configured;
  return Object.keys(formationMap)
    .map((key) => Math.max(0, toSafeInt(key, 0)))
    .find((id) => id > 0 && (formationMap[id] || formationMap[String(id)])) || configured;
}

function normalizeFormationId(value, fallback) {
  const formationCfg = configService.get('FormationConfig');
  const formationMap = isPlainObject(formationCfg) ? formationCfg : {};
  const id = Math.max(0, toSafeInt(value, 0));
  if (id > 0 && (formationMap[id] || formationMap[String(id)])) return id;
  return Math.max(1, toSafeInt(fallback, getInitialFormationId()));
}

function buildPresetDefaults(player = {}) {
  const otherAttr = isPlainObject(player.other_attr_info) ? player.other_attr_info : {};
  const artifactInfo = isPlainObject(player.artifactInfo) ? player.artifactInfo : {};
  const orbInfo = isPlainObject(artifactInfo.orbInfo) ? artifactInfo.orbInfo : {};
  const orb = {};
  (Array.isArray(orbInfo.slotData) ? orbInfo.slotData : []).forEach((row) => {
    const index = toSafeInt(row && row.index, -1);
    const orbId = Math.max(0, toSafeInt(row && row.orbId, 0));
    if (index >= 0 && orbId > 0) orb[String(index)] = orbId;
  });

  const formationInfo = isPlainObject(player.formationInfo) ? player.formationInfo : {};
  const swordInfo = isPlainObject(player.swordInfo) ? player.swordInfo : {};
  const spiritInfo = isPlainObject(player.spiritInfo) ? player.spiritInfo : {};
  const valhallaInfo = isPlainObject(otherAttr.valhallaInfo) ? otherAttr.valhallaInfo : {};
  const bloodlineInfo = isPlainObject(otherAttr.bloodlineInfo) ? otherAttr.bloodlineInfo : {};
  const elfInfo = isPlainObject(otherAttr.elfInfo) ? otherAttr.elfInfo : {};
  const fateInfo = isPlainObject(player.fateInfo) ? player.fateInfo : {};

  return {
    formation: normalizeFormationId(
      formationInfo.equippedId != null ? formationInfo.equippedId : formationInfo.id,
      getInitialFormationId()
    ),
    sword: Math.max(0, toSafeInt(swordInfo.equippedUid, 0)),
    spirit: Math.max(0, toSafeInt(spiritInfo.id != null ? spiritInfo.id : spiritInfo.equippedId, 0)),
    artifact: cloneObject(artifactInfo.equipMap),
    valhalla: Math.max(0, toSafeInt(valhallaInfo.plan, 0)),
    bloodline: Math.max(0, toSafeInt(bloodlineInfo.wearUid, 0)),
    orb,
    elf: cloneObject(elfInfo.setMap),
    elfPlan: Math.max(0, toSafeInt(elfInfo.fightPlan, 0)),
    fate: Math.max(1, toSafeInt(fateInfo.id, 1)),
  };
}

function ensureSetInfoPlan(map, planId, defaults = {}) {
  const plan = ensurePlanObject(map, planId);
  if (typeof plan.name !== 'string') {
    plan.name = '';
  }
  plan.formation = normalizeFormationId(plan.formation, defaults.formation);
  plan.sword = Math.max(0, toSafeInt(plan.sword, toSafeInt(defaults.sword, 0)));
  plan.spirit = Math.max(0, toSafeInt(plan.spirit, toSafeInt(defaults.spirit, 0)));
  if (!isPlainObject(plan.artifact)) {
    plan.artifact = cloneObject(defaults.artifact);
  }
  plan.valhalla = Math.max(0, toSafeInt(plan.valhalla, toSafeInt(defaults.valhalla, 0)));
  plan.bloodline = Math.max(0, toSafeInt(plan.bloodline, toSafeInt(defaults.bloodline, 0)));
  if (!isPlainObject(plan.orb)) {
    plan.orb = cloneObject(defaults.orb);
  }
  if (!isPlainObject(plan.elf)) {
    plan.elf = cloneObject(defaults.elf);
  }
  plan.elfPlan = Math.max(0, toSafeInt(plan.elfPlan, toSafeInt(defaults.elfPlan, 0)));
  plan.fate = Math.max(1, toSafeInt(plan.fate, toSafeInt(defaults.fate, 1)));
  return plan;
}

function ensureOpenListArray(openListMap, listId) {
  const key = String(toSafeInt(listId, 0));
  if (!Array.isArray(openListMap[key])) {
    openListMap[key] = [];
  }
  return openListMap[key];
}

function getAssetsConfig() {
  const cfg = configService.get('AssetsConfig');
  return isPlainObject(cfg) ? cfg : {};
}

function getAssetRow(itemId, assetsCfg = null) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return null;
  const assets = assetsCfg || getAssetsConfig();
  return assets[id] || assets[String(id)] || null;
}

function isEquipTemplateItem(itemId) {
  const id = toSafeInt(itemId, 0);
  if (id <= 0) return false;

  const row = getAssetRow(id);
  if (row) {
    return toSafeInt(row.type, 0) === 3;
  }
  return id >= 30000 && id < 100000;
}

function pickEquipSpecialAttrId(itemId, equipUid, type, quality, level) {
  const seed = Math.abs(
    toSafeInt(itemId, 0)
      + toSafeInt(equipUid, 0)
      + toSafeInt(type, 0) * 17
      + toSafeInt(quality, 0) * 31
      + toSafeInt(level, 0) * 13
  );
  return EQUIP_SPECIAL_ATTR_IDS[seed % EQUIP_SPECIAL_ATTR_IDS.length] || 101;
}

function getEquipVariancePercent(itemId, equipUid, type, quality, level, attrId) {
  const seed = Math.abs(
    toSafeInt(itemId, 0) * 31
      + toSafeInt(equipUid, 0) * 17
      + toSafeInt(type, 0) * 13
      + toSafeInt(quality, 0) * 7
      + toSafeInt(level, 0) * 5
      + toSafeInt(attrId, 0) * 3
  );
  return 95 + (seed % 11);
}

function applyEquipVariance(value, itemId, equipUid, type, quality, level, attrId) {
  const baseValue = Math.max(1, toSafeInt(value, 1));
  return Math.max(1, Math.floor(baseValue * getEquipVariancePercent(itemId, equipUid, type, quality, level, attrId) / 100));
}

function nextGeneratedEquipUid(player = {}) {
  ensureEquipInfo(player);
  const equipList = Array.isArray(player.equipInfo && player.equipInfo.equipList)
    ? player.equipInfo.equipList
    : [];
  let maxUid = 0;
  equipList.forEach((equip) => {
    maxUid = Math.max(maxUid, toSafeInt(equip && equip.uid, 0));
  });
  return Math.max(maxUid + 1, Date.now() % 1000000000);
}

function createEquipFromTemplateId(itemId, playerLevel, player = {}) {
  const id = toSafeInt(itemId, 32101);
  const level = Math.max(1, toSafeInt(playerLevel, 1));
  const equipUid = nextGeneratedEquipUid(player);
  const row = getAssetRow(id);
  const quality = Math.max(
    1,
    toSafeInt(
      row && toSafeInt(row.type, 0) === 3 ? row.quality : Math.floor((id - 30000) / 1000),
      2
    )
  );
  const type = Math.max(
    1,
    Math.min(
      12,
      toSafeInt(
        row && toSafeInt(row.type, 0) === 3 ? row.subType : (id % 100 || 1),
        1
      )
    )
  );

  const qualityMultiplier = 1 + (quality - 1) * 0.3;
  const specialAttrId = pickEquipSpecialAttrId(id, equipUid, type, quality, level);
  const rawAttrs = {
    1: Math.floor((150 + level * 25) * qualityMultiplier),
    2: Math.floor((20 + level * 8) * qualityMultiplier),
    3: Math.floor((10 + level * 3) * qualityMultiplier),
    4: Math.floor((5 + level * 2) * qualityMultiplier),
  };
  rawAttrs[specialAttrId] = Math.floor((30 + level * 4) * qualityMultiplier);
  const attrs = {};
  Object.keys(rawAttrs).forEach((attrId) => {
    attrs[attrId] = applyEquipVariance(rawAttrs[attrId], id, equipUid, type, quality, level, attrId);
  });

  return {
    uid: equipUid,
    id,
    type,
    quailty: quality,
    lv: level,
    attrs,
  };
}

function syncEquipList(equipInfo) {
  if (!isPlainObject(equipInfo)) return;
  const merged = new Map();

  if (isPlainObject(equipInfo.openListMap)) {
    Object.keys(equipInfo.openListMap).forEach((listKey) => {
      const list = Array.isArray(equipInfo.openListMap[listKey]) ? equipInfo.openListMap[listKey] : [];
      list.forEach((raw) => {
        const equip = normalizeEquip(raw);
        if (equip) merged.set(String(equip.uid), equip);
      });
    });
  }

  if (isPlainObject(equipInfo.equipSetMap)) {
    Object.keys(equipInfo.equipSetMap).forEach((planKey) => {
      const plan = isPlainObject(equipInfo.equipSetMap[planKey]) ? equipInfo.equipSetMap[planKey] : {};
      Object.keys(plan).forEach((slotKey) => {
        const equip = normalizeEquip(plan[slotKey]);
        if (equip) merged.set(String(equip.uid), equip);
      });
    });
  }

  equipInfo.equipList = Array.from(merged.values());
}

/**
 * Ensure player.equipInfo has a stable shape and remove malformed entries.
 * @returns {boolean} true if mutated
 */
function ensureEquipInfo(player = {}) {
  let changed = false;
  if (!isPlainObject(player)) return false;

  if (!isPlainObject(player.equipInfo)) {
    player.equipInfo = {};
    changed = true;
  }
  const info = player.equipInfo;
  const presetDefaults = buildPresetDefaults(player);

  const curIndex = toSafeInt(info.curIndex, 0);
  if (info.curIndex !== curIndex) {
    info.curIndex = curIndex;
    changed = true;
  }

  if (!isPlainObject(info.openListMap)) {
    info.openListMap = {};
    changed = true;
  }
  if (!isPlainObject(info.equipSetMap)) {
    info.equipSetMap = {};
    changed = true;
  }
  if (!isPlainObject(info.setInfoMap)) {
    info.setInfoMap = {};
    changed = true;
  }
  if (!isPlainObject(info.raidSetMap)) {
    info.raidSetMap = {};
    changed = true;
  }
  if (!Array.isArray(info.equipList)) {
    info.equipList = [];
    changed = true;
  }

  Object.keys(info.openListMap).forEach((listKey) => {
    const src = Array.isArray(info.openListMap[listKey]) ? info.openListMap[listKey] : [];
    if (!Array.isArray(info.openListMap[listKey])) changed = true;
    const normalized = [];
    const seen = new Set();
    src.forEach((raw) => {
      const equip = normalizeEquip(raw);
      if (!equip) {
        changed = true;
        return;
      }
      const uidKey = String(equip.uid);
      if (seen.has(uidKey)) {
        changed = true;
        return;
      }
      seen.add(uidKey);
      if (JSON.stringify(raw) !== JSON.stringify(equip)) changed = true;
      normalized.push(equip);
    });
    info.openListMap[listKey] = normalized;
  });

  Object.keys(info.equipSetMap).forEach((planKey) => {
    const rawPlan = isPlainObject(info.equipSetMap[planKey]) ? info.equipSetMap[planKey] : {};
    if (!isPlainObject(info.equipSetMap[planKey])) changed = true;

    const normalizedPlan = {};
    Object.keys(rawPlan).forEach((slotKey) => {
      const equip = normalizeEquip(rawPlan[slotKey]);
      if (!equip) {
        changed = true;
        return;
      }
      normalizedPlan[String(equip.type)] = equip;
      if (String(equip.type) !== String(slotKey) || JSON.stringify(rawPlan[slotKey]) !== JSON.stringify(equip)) {
        changed = true;
      }
    });
    info.equipSetMap[planKey] = normalizedPlan;
  });

  Object.keys(info.setInfoMap).forEach((planKey) => {
    const rawPlan = isPlainObject(info.setInfoMap[planKey]) ? info.setInfoMap[planKey] : {};
    if (!isPlainObject(info.setInfoMap[planKey])) changed = true;
    info.setInfoMap[planKey] = rawPlan;
    const before = JSON.stringify(rawPlan);
    ensureSetInfoPlan(info.setInfoMap, planKey, presetDefaults);
    const normalizedPlan = info.setInfoMap[planKey];
    if (before !== JSON.stringify(normalizedPlan)) {
      changed = true;
    }
  });

  ensurePlanObject(info.equipSetMap, info.curIndex);
  const currentSetInfoBefore = JSON.stringify(info.setInfoMap[String(info.curIndex)] || null);
  ensureSetInfoPlan(info.setInfoMap, info.curIndex, presetDefaults);
  if (currentSetInfoBefore !== JSON.stringify(info.setInfoMap[String(info.curIndex)])) changed = true;
  ensureOpenListArray(info.openListMap, info.curIndex);

  const beforeEquipList = JSON.stringify(info.equipList);
  syncEquipList(info);
  if (JSON.stringify(info.equipList) !== beforeEquipList) {
    changed = true;
  }

  return changed;
}

function getPresetSetInfo(player = {}, planId = null) {
  ensureEquipInfo(player);
  const info = player.equipInfo;
  const targetPlanId = planId == null ? getPresetIdx(info) : toSafeInt(planId, getPresetIdx(info));
  return ensureSetInfoPlan(info.setInfoMap, targetPlanId, buildPresetDefaults(player));
}

function getPresetIdx(equipInfo = {}) {
  return toSafeInt(equipInfo.curIndex, 0);
}

function getOpenList(equipInfo = {}, listId = getPresetIdx(equipInfo)) {
  if (!isPlainObject(equipInfo.openListMap)) {
    equipInfo.openListMap = {};
  }
  return ensureOpenListArray(equipInfo.openListMap, listId);
}

function addOpenEquip(player = {}, rawEquip, listId = null) {
  if (!player.equipInfo) ensureEquipInfo(player);
  const equip = normalizeEquip(rawEquip);
  if (!equip) return null;

  const info = player.equipInfo;
  const targetListId = listId == null ? getPresetIdx(info) : toSafeInt(listId, getPresetIdx(info));
  const list = getOpenList(info, targetListId);
  if (list.some((it) => toSafeInt(it && it.uid, 0) === equip.uid)) {
    return equip;
  }
  list.push(equip);
  unlockEquipAppearance(player, equip);
  syncEquipList(info);
  return equip;
}

function findOpenEquip(info = {}, uid, preferredListId = null) {
  const safeUid = toSafeInt(uid, 0);
  if (safeUid <= 0 || !isPlainObject(info.openListMap)) return null;

  const candidateLists = [];
  if (preferredListId != null) {
    candidateLists.push(String(toSafeInt(preferredListId, 0)));
  }
  Object.keys(info.openListMap).forEach((key) => {
    if (!candidateLists.includes(key)) candidateLists.push(key);
  });

  for (const listKey of candidateLists) {
    const list = Array.isArray(info.openListMap[listKey]) ? info.openListMap[listKey] : [];
    for (let i = 0; i < list.length; i += 1) {
      if (toSafeInt(list[i] && list[i].uid, 0) === safeUid) {
        return { equip: normalizeEquip(list[i]), listId: toSafeInt(listKey, 0), index: i };
      }
    }
  }
  return null;
}

function removeOpenEquip(info = {}, uid, preferredListId = null) {
  const found = findOpenEquip(info, uid, preferredListId);
  if (!found) return null;
  const key = String(found.listId);
  info.openListMap[key].splice(found.index, 1);
  return found;
}

function getEquipMap(info = {}, mapId = null) {
  if (!isPlainObject(info.equipSetMap)) info.equipSetMap = {};
  const targetMapId = mapId == null ? getPresetIdx(info) : toSafeInt(mapId, getPresetIdx(info));
  return ensurePlanObject(info.equipSetMap, targetMapId);
}

function replaceOpenEquipToPlan(player = {}, params = {}) {
  ensureEquipInfo(player);
  const info = player.equipInfo;

  const uid = toSafeInt(params.uid, 0);
  if (uid <= 0) {
    return { result: 1, desc: 'invalid uid' };
  }

  const listId = params.listId == null ? null : toSafeInt(params.listId, getPresetIdx(info));
  const mapId = params.mapId == null ? getPresetIdx(info) : toSafeInt(params.mapId, getPresetIdx(info));

  const removed = removeOpenEquip(info, uid, listId);
  if (!removed || !removed.equip) {
    return { result: 1, desc: 'equip not found in open list' };
  }

  const equip = removed.equip;
  const equipMap = getEquipMap(info, mapId);
  const slotKey = String(toSafeInt(equip.type, 0));
  const oldEquip = normalizeEquip(equipMap[slotKey]);
  equipMap[slotKey] = equip;

  if (oldEquip) {
    addOpenEquip(player, oldEquip, removed.listId);
  }

  syncEquipList(info);
  return { result: 0, usedListId: removed.listId, mapId, equip, oldEquip };
}

function calcEquipSaleSilver(equip = {}) {
  const quality = Math.max(1, toSafeInt(equip.quailty, 1));
  const level = Math.max(1, toSafeInt(equip.lv, 1));
  return Math.max(20, quality * 25 + level * 5);
}

function saleOpenEquips(player = {}, rawUids = []) {
  ensureEquipInfo(player);
  const info = player.equipInfo;

  const uidSet = new Set();
  if (Array.isArray(rawUids)) {
    rawUids.forEach((uid) => {
      const safe = toSafeInt(uid, 0);
      if (safe > 0) uidSet.add(safe);
    });
  }

  const soldUids = [];
  let silverGain = 0;
  uidSet.forEach((uid) => {
    const removed = removeOpenEquip(info, uid);
    if (!removed || !removed.equip) return;
    soldUids.push(uid);
    silverGain += calcEquipSaleSilver(removed.equip);
  });

  if (!isPlainObject(player.currencies)) {
    player.currencies = { gold: 0, diamond: 0, silver: 0 };
  }
  player.currencies.silver = Math.max(0, toSafeInt(player.currencies.silver, 0)) + silverGain;
  syncCurrencyItems(player);
  syncEquipList(info);

  const items = [];
  if (silverGain > 0) {
    items.push({ id: 2, count: silverGain });
  }

  return {
    result: 0,
    uids: soldUids,
    rewardInfo: {
      items,
      equips: [],
      swords: [],
      pets: [],
      artifacts: [],
      gems: [],
      valhalla: [],
      bloodline: [],
      fashion: [],
      elves: [],
      extraReward: {},
    },
  };
}

module.exports = {
  ensureEquipInfo,
  getPresetSetInfo,
  addOpenEquip,
  replaceOpenEquipToPlan,
  saleOpenEquips,
  isEquipTemplateItem,
  createEquipFromTemplateId,
};
