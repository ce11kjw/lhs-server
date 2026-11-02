/**
 * BattleService
 * Attribute IDs follow AttrConfig:
 * 1=HP, 2=ATK, 3=DEF, 4=SPD,
 * 101=lifesteal, 102=counter, 103=combo, 104=evade, 105=crit, 106=stun,
 * 151~156 are corresponding resistances.
 * 171~175/181~185 are supported as element damage/resist pairs.
 * 243~246 are PvE/PvP damage increase/reduction rates.
 */

const config = require('./ConfigService');

const PLAYER_MONSTER_MIN_DAMAGE_RATE = 0.07;
const ELEMENT_ATTR_PAIRS = [
  [171, 181], [172, 182], [173, 183], [174, 184], [175, 185],
];

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function addAttrs(target, attrs = {}, multiplier = 1) {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return;
  Object.keys(attrs).forEach((key) => {
    const attrId = toSafeInt(key, 0);
    const value = toSafeInt(attrs[key], 0);
    if (attrId > 0 && value !== 0) {
      target[attrId] = Math.max(0, toSafeInt(target[attrId], 0)) + Math.floor(value * multiplier);
      addDefinedLinkedAttrs(target, attrId, Math.floor(value * multiplier));
    }
  });
}

function getConfigRow(tableName, id) {
  const table = config.get(tableName) || {};
  return table[toSafeInt(id, 0)] || table[String(toSafeInt(id, 0))] || null;
}

function addDefinedLinkedAttrs(target, attrId, value) {
  const attrCfg = config.get('AttrConfig') || {};
  const row = attrCfg[toSafeInt(attrId, 0)] || attrCfg[String(toSafeInt(attrId, 0))] || null;
  const links = row && row.defineLinkId && typeof row.defineLinkId === 'object' && !Array.isArray(row.defineLinkId)
    ? row.defineLinkId
    : null;
  if (!links) return;
  Object.keys(links).forEach((key) => {
    const linkedId = toSafeInt(key, 0);
    const ratio = Number(links[key]);
    if (linkedId <= 0 || !Number.isFinite(ratio) || ratio === 0) return;
    target[linkedId] = Math.max(0, toSafeInt(target[linkedId], 0)) + Math.floor(value * ratio);
  });
}

function applyPercentLinkedAttrs(base) {
  const attrCfg = config.get('AttrConfig') || {};
  Object.keys(base).forEach((key) => {
    const attrId = toSafeInt(key, 0);
    const value = toSafeInt(base[key], 0);
    if (attrId <= 0 || value === 0) return;
    const row = attrCfg[attrId] || attrCfg[String(attrId)] || null;
    const linkIds = Array.isArray(row && row.linkId) ? row.linkId : [];
    linkIds.forEach((linkedIdRaw) => {
      const linkedId = toSafeInt(linkedIdRaw, 0);
      if (linkedId <= 0 || !base[linkedId]) return;
      base[linkedId] = Math.max(0, toSafeInt(base[linkedId], 0)) + Math.floor(toSafeInt(base[linkedId], 0) * value / 10000);
    });
  });
}

function addAttrList(base, rows = [], multiplier = 1) {
  if (!Array.isArray(rows)) return;
  rows.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    if (row.id != null && row.count != null) addAttrs(base, { [row.id]: row.count }, multiplier);
    else if (row.type != null && row.value != null) addAttrs(base, { [row.type]: row.value }, multiplier);
    else addAttrs(base, row, multiplier);
  });
}

function addSpiritAttrs(base, player = {}) {
  const spiritInfo = player.spiritInfo && typeof player.spiritInfo === 'object' ? player.spiritInfo : null;
  if (!spiritInfo || toSafeInt(spiritInfo.id, 0) <= 0) return;
  const spiritCfg = config.get('SpiritConfig') || {};
  const gradeCfg = config.get('SpiritGradeConfig') || {};
  const spiritRow = spiritCfg[spiritInfo.id] || spiritCfg[String(spiritInfo.id)] || null;
  const rank = Math.max(1, toSafeInt(spiritInfo.rank, 1));
  const gradeRow = gradeCfg[rank] || gradeCfg[String(rank)] || null;
  if (spiritRow) {
    addAttrs(base, spiritRow.attrs);
    addAttrs(base, spiritRow.gradeAttrs, rank - 1);
  }
  if (gradeRow) addAttrs(base, gradeRow.fullAttrs);
  addAttrs(base, spiritInfo.attrs);
}

function addGemAttrs(base, player = {}) {
  const gemInfo = player.other_attr_info && player.other_attr_info.gemInfo;
  if (!gemInfo || typeof gemInfo !== 'object') return;
  const positions = Array.isArray(gemInfo.plan && gemInfo.plan.positions) ? gemInfo.plan.positions : [];
  const gems = Array.isArray(gemInfo.gems) ? gemInfo.gems : [];
  if (positions.length <= 0 || gems.length <= 0) return;
  const levelCfg = config.get('GemLevelConfig') || {};
  const echoCfg = config.get('GemEchoConfig') || {};
  const gemByUid = new Map(gems.map((gem) => [toSafeInt(gem && gem.uid, 0), gem]));
  let totalScore = 0;
  positions.forEach((pos) => {
    const gem = gemByUid.get(toSafeInt(pos && pos.uid, 0));
    if (!gem) return;
    const row = levelCfg[gem.id] || levelCfg[String(gem.id)] || null;
    if (!row) return;
    addAttrs(base, row.baseAttrs);
    addAttrs(base, row.extraAttrs);
    totalScore += Math.max(0, toSafeInt(row.score, 0));
  });

  let echoLevel = 0;
  Object.keys(echoCfg).forEach((key) => {
    const row = echoCfg[key];
    if (!row || totalScore < Math.max(0, toSafeInt(row.count, 0))) return;
    echoLevel = Math.max(echoLevel, Math.max(0, toSafeInt(row.level, 0)));
  });
  const echoRow = echoCfg[echoLevel] || echoCfg[String(echoLevel)] || null;
  if (echoRow) addAttrs(base, echoRow.attributeType);
}

function addFormationProgressionAttrs(base, player = {}) {
  const info = player && player.formationInfo && typeof player.formationInfo === 'object' ? player.formationInfo : null;
  if (!info) return;

  const gradeCfg = config.get('FormationGradeConfig') || {};
  const formationCfg = config.get('FormationConfig') || {};
  const baseCfg = config.get('FormationBaseConfig') || {};
  const grade = Math.max(1, toSafeInt(info.grade, 1));
  const level = Math.max(1, toSafeInt(info.level, 1));

  for (let currentGrade = 1; currentGrade <= grade; currentGrade += 1) {
    const row = gradeCfg[currentGrade] || gradeCfg[String(currentGrade)] || null;
    if (!row) continue;
    const levelCount = currentGrade === grade
      ? level - 1
      : Math.max(0, toSafeInt(row.level, 0));
    addAttrs(base, row.levelUpAttrs, levelCount);
  }

  addAttrs(base, baseCfg.formationGlobalAttrsAdd, grade - 1);

  const equippedId = Math.max(0, toSafeInt(info.equippedId || info.curFormation || info.id, 0));
  const formationRow = formationCfg[equippedId] || formationCfg[String(equippedId)] || null;
  if (formationRow) {
    const spAttrs = formationRow.spAttrs && typeof formationRow.spAttrs === 'object' ? formationRow.spAttrs : {};
    const spAttrGrades = formationRow.spAttrGrades && typeof formationRow.spAttrGrades === 'object' ? formationRow.spAttrGrades : {};
    Object.keys(spAttrs).forEach((key) => {
      const attrId = toSafeInt(key, 0);
      if (attrId <= 0) return;
      addAttrs(base, { [attrId]: toSafeInt(spAttrs[key], 0) + toSafeInt(spAttrGrades[key], 0) * (grade - 1) });
    });
  }

  const enchantTypes = Array.isArray(baseCfg.formationEnchantType) ? baseCfg.formationEnchantType : [];
  const enchantCfg = config.get('FormationEnchantConfig') || {};
  const enchants = Array.isArray(info.enchant) ? info.enchant : [];
  enchantTypes.forEach((attrIdRaw, index) => {
    const attrId = toSafeInt(attrIdRaw, 0);
    const enchantId = toSafeInt(enchants[index], 0);
    const row = enchantCfg[enchantId] || enchantCfg[String(enchantId)] || null;
    const value = Math.max(0, toSafeInt(row && row.attributeParam, 0));
    if (attrId > 0 && value > 0) addAttrs(base, { [attrId]: value });
  });
}

function addMountAttrs(base, player = {}) {
  const swordInfo = player && player.swordInfo && typeof player.swordInfo === 'object' ? player.swordInfo : null;
  if (!swordInfo || !Array.isArray(swordInfo.data)) return;
  const passiveCfg = config.get('SwordPassiveSkillConfig') || {};
  const bondCfg = config.get('SwordBondConfig') || {};
  const swordBaseCfg = config.get('SwordBaseConfig') || {};
  const passiveLimit = Math.max(0, toSafeInt(swordBaseCfg.passiveSkillUseCount, 0));
  const equippedUid = toSafeInt(swordInfo.equippedUid, 0);
  const mount = swordInfo.data.find((row) => toSafeInt(row && row.uid, 0) === equippedUid)
    || swordInfo.data[0]
    || null;
  if (!mount) return;
  addAttrs(base, mount.attrs);

  if (passiveLimit > 0) {
    const skills = Array.isArray(mount.skills) ? mount.skills : [];
    const grouped = new Map();
    skills.forEach((skill) => {
      const skillId = toSafeInt(skill && skill.id, 0);
      if (skillId <= 0) return;
      if (!grouped.has(skillId)) grouped.set(skillId, []);
      grouped.get(skillId).push(skill);
    });

    grouped.forEach((rows) => {
      rows.sort((left, right) => {
        const leftRow = (((passiveCfg[toSafeInt(left && left.id, 0)] || passiveCfg[String(toSafeInt(left && left.id, 0))] || {})[toSafeInt(left && left.quality, 0)] || {})[toSafeInt(left && left.level, 0)])
          || ((((passiveCfg[toSafeInt(left && left.id, 0)] || passiveCfg[String(toSafeInt(left && left.id, 0))] || {})[String(toSafeInt(left && left.quality, 0))] || {})[String(toSafeInt(left && left.level, 0))]))
          || null;
        const rightRow = (((passiveCfg[toSafeInt(right && right.id, 0)] || passiveCfg[String(toSafeInt(right && right.id, 0))] || {})[toSafeInt(right && right.quality, 0)] || {})[toSafeInt(right && right.level, 0)])
          || ((((passiveCfg[toSafeInt(right && right.id, 0)] || passiveCfg[String(toSafeInt(right && right.id, 0))] || {})[String(toSafeInt(right && right.quality, 0))] || {})[String(toSafeInt(right && right.level, 0))]))
          || null;
        return calcPowerScore(rightRow && rightRow.attrs ? rightRow.attrs : {})
          - calcPowerScore(leftRow && leftRow.attrs ? leftRow.attrs : {});
      });

      rows.slice(0, passiveLimit).forEach((skill) => {
        const quality = toSafeInt(skill && skill.quality, 0);
        const level = toSafeInt(skill && skill.level, 0);
        const skillMap = passiveCfg[toSafeInt(skill && skill.id, 0)] || passiveCfg[String(toSafeInt(skill && skill.id, 0))] || {};
        const row = ((skillMap[quality] || skillMap[String(quality)] || {})[level])
          || ((skillMap[quality] || skillMap[String(quality)] || {})[String(level)])
          || null;
        if (row) addAttrs(base, row.attrs);
      });
    });
  }

  const swordBonds = Array.isArray(swordInfo.swordBond) ? swordInfo.swordBond : [];
  swordBonds.forEach((bondId) => {
    const row = bondCfg[toSafeInt(bondId, 0)] || bondCfg[String(toSafeInt(bondId, 0))] || null;
    if (row) addAttrs(base, row.addAttrs);
  });
}

function addItemRecordAttrs(base, player = {}) {
  const holder = player && player.other_attr_info && typeof player.other_attr_info === 'object' ? player.other_attr_info : null;
  const records = holder && holder.record && typeof holder.record === 'object' && !Array.isArray(holder.record)
    ? holder.record
    : null;
  if (!records) return;
  const useCfg = config.get('AssetsUseConfig') || {};
  Object.keys(records).forEach((itemIdKey) => {
    const count = Math.max(0, toSafeInt(records[itemIdKey], 0));
    if (count <= 0) return;
    const row = useCfg[toSafeInt(itemIdKey, 0)] || useCfg[String(toSafeInt(itemIdKey, 0))] || null;
    if (row) addAttrs(base, row.attrs, count);
  });
}

function addFashionAttrs(base, player = {}) {
  const info = player && player.fashionInfo && typeof player.fashionInfo === 'object' ? player.fashionInfo : null;
  if (!info) return;

  const fashionCfg = config.get('FashionConfig') || {};
  const dressCfg = config.get('FashionDressConfig') || {};
  const dressLevelCfg = config.get('FashionDressLevelConfig') || {};
  const colorAttrCfg = config.get('FashionColorAttrConfig') || {};
  const activeFashion = new Set((Array.isArray(info.activateFashion) ? info.activateFashion : []).map((id) => toSafeInt(id, 0)).filter((id) => id > 0));
  const starUp = info.starUp && typeof info.starUp === 'object' && !Array.isArray(info.starUp) ? info.starUp : {};

  Object.keys(fashionCfg).forEach((key) => {
    const row = fashionCfg[key];
    const id = Math.max(0, toSafeInt(row && row.id, toSafeInt(key, 0)));
    if (id <= 0 || !activeFashion.has(id)) return;
    addAttrs(base, row && row.attrs);
  });

  let totalSuitStars = 0;
  Object.keys(dressCfg).forEach((key) => {
    const row = dressCfg[key];
    if (!row) return;
    const dressId = Math.max(0, toSafeInt(row.id, toSafeInt(key, 0)));
    if (dressId <= 0) return;

    if (toSafeInt(row.isSuit, 0) === 3) {
      const level = Math.max(0, toSafeInt(starUp[dressId], 0));
      const levelRow = ((dressLevelCfg[dressId] || dressLevelCfg[String(dressId)] || {})[level])
        || ((dressLevelCfg[dressId] || dressLevelCfg[String(dressId)] || {})[String(level)])
        || null;
      if (!levelRow) return;
      addAttrs(base, levelRow.attrs);
      totalSuitStars += Math.max(0, toSafeInt(levelRow.star, 0));
      return;
    }

    if (dressId === 1001) return;
    addAttrs(base, row.attrs);
  });

  const suitStarRow = colorAttrCfg[Math.max(0, totalSuitStars)] || colorAttrCfg[String(Math.max(0, totalSuitStars))] || null;
  if (suitStarRow) addAttrs(base, suitStarRow.attrs);
}

function addFateAttrs(base, player = {}) {
  const info = player && player.fateInfo && typeof player.fateInfo === 'object' ? player.fateInfo : null;
  if (!info || !info.planInfoMap || typeof info.planInfoMap !== 'object') return;
  const planId = Math.max(1, toSafeInt(info.id, 1));
  const plan = info.planInfoMap[planId] || info.planInfoMap[String(planId)] || null;
  if (!plan || !Array.isArray(plan.skills)) return;
  const skillCfg = config.get('FateSkillConfig') || {};
  const kungfuSkillCfg = config.get('FateKungfuSkillConfig') || {};
  const kungfuId = Math.max(0, toSafeInt(player && player.roleInfo && player.roleInfo.kungfuId, 0));

  plan.skills.forEach((skillIdRaw) => {
    const skillId = Math.max(0, toSafeInt(skillIdRaw, 0));
    if (skillId <= 0) return;
    const row = skillCfg[skillId] || skillCfg[String(skillId)] || null;
    if (!row) return;
    if (toSafeInt(row.kungfuId, 0) > 0) {
      const kungfuMap = kungfuSkillCfg[skillId] || kungfuSkillCfg[String(skillId)] || {};
      const kungfuRow = kungfuMap[kungfuId] || kungfuMap[String(kungfuId)] || null;
      if (kungfuRow) addAttrs(base, kungfuRow.skillAttrs);
      return;
    }
    addAttrs(base, row.skillAttrs);
  });
}

function addFishingAttrs(base, player = {}) {
  const info = player && player.fishInfo && typeof player.fishInfo === 'object' ? player.fishInfo : null;
  if (!info) return;
  const slots = info.slots && typeof info.slots === 'object' && !Array.isArray(info.slots) ? info.slots : {};
  const level = Math.max(0, toSafeInt(info.level, 0));
  Object.keys(slots).forEach((slotKey) => {
    const fish = slots[slotKey];
    if (!fish || typeof fish !== 'object') return;
    const attrs = Array.isArray(fish.attrs) ? fish.attrs : [];
    attrs.forEach((row) => {
      const unlockLevel = Math.max(0, toSafeInt(row && row.level, 0));
      if (unlockLevel > level) return;
      addAttrs(base, { [toSafeInt(row && row.type, 0)]: Math.max(0, toSafeInt(row && row.value, 0)) });
    });
  });

  const fetterCfg = config.get('FishFetterConfig') || {};
  const activeFetters = new Set((Array.isArray(info.fetters) ? info.fetters : []).map((id) => toSafeInt(id, 0)).filter((id) => id > 0));
  activeFetters.forEach((fetterId) => {
    const row = fetterCfg[fetterId] || fetterCfg[String(fetterId)] || null;
    if (row) addAttrs(base, row.attrs);
  });

  const rodCfg = ((config.get('FishRodGradeConfig') || {})[toSafeInt(info.rodRank, 0)])
    || ((config.get('FishRodGradeConfig') || {})[String(toSafeInt(info.rodRank, 0))])
    || null;
  if (rodCfg) {
    addAttrs(base, rodCfg.fullLevelAttrs);
    addAttrs(base, rodCfg.levelUpAttrs, Math.max(0, toSafeInt(info.rodLevel, 0)));
  }

  const raftCfg = ((config.get('FishRaftGradeConfig') || {})[toSafeInt(info.raftRank, 0)])
    || ((config.get('FishRaftGradeConfig') || {})[String(toSafeInt(info.raftRank, 0))])
    || null;
  if (raftCfg) {
    addAttrs(base, raftCfg.fullLevelAttrs);
    addAttrs(base, raftCfg.levelUpAttrs, Math.max(0, toSafeInt(info.raftLevel, 0)));
  }
}

function addBloodlineAttrs(base, player = {}) {
  const holder = player && player.other_attr_info && typeof player.other_attr_info === 'object' ? player.other_attr_info : null;
  const info = holder && holder.bloodlineInfo && typeof holder.bloodlineInfo === 'object' ? holder.bloodlineInfo : null;
  if (!info) return;

  const echoCfg = config.get('BloodlineEchoConfig') || {};
  const gradeCfg = config.get('BloodlineGradeConfig') || {};
  const echoRow = echoCfg[toSafeInt(info.maxTier, 0)] || echoCfg[String(toSafeInt(info.maxTier, 0))] || null;
  if (echoRow) addAttrs(base, echoRow.attributeType);

  const wearUid = Math.max(0, toSafeInt(info.wearUid, 0));
  const worn = (Array.isArray(info.dataList) ? info.dataList : []).find((row) => Math.max(0, toSafeInt(row && row.uid, 0)) === wearUid) || null;
  if (!worn) return;

  const quality = Math.max(0, toSafeInt(worn.quality != null ? worn.quality : worn.tier, 0));
  const tierLv = Math.max(0, toSafeInt(worn.tierLv != null ? worn.tierLv : worn.tier, 0));
  const qualityCfg = gradeCfg[quality] || gradeCfg[String(quality)] || {};
  const tierRow = qualityCfg[tierLv] || qualityCfg[String(tierLv)] || null;
  if (tierRow) addAttrs(base, tierRow.attrs);
  (Array.isArray(worn.refineList) ? worn.refineList : []).forEach((row) => addAttrs(base, row && row.attrs));
}

function addHomelandAttrs(base, player = {}) {
  const info = player && player.homelandInfo && typeof player.homelandInfo === 'object' ? player.homelandInfo : null;
  if (!info) return;
  const levelCfg = config.get('HomelandLevelConfig') || {};
  const buildingCfg = config.get('HomelandBuildingConfig') || {};

  const levelRow = levelCfg[toSafeInt(info.lv, 0)] || levelCfg[String(toSafeInt(info.lv, 0))] || null;
  if (levelRow) addAttrs(base, levelRow.attrs);

  const buildingLv = info.buildingLv && typeof info.buildingLv === 'object' && !Array.isArray(info.buildingLv) ? info.buildingLv : {};
  Object.keys(buildingLv).forEach((buildingIdKey) => {
    const row = buildingCfg[toSafeInt(buildingIdKey, 0)] || buildingCfg[String(toSafeInt(buildingIdKey, 0))] || null;
    if (!row) return;
    const lv = Math.max(0, toSafeInt(buildingLv[buildingIdKey], 0));
    addAttrs(base, row.attrs);
    addAttrs(base, row.attrsUp, lv);
  });
}

function addOldTrekAttrs(base, player = {}) {
  const holder = player && player.other_attr_info && typeof player.other_attr_info === 'object' ? player.other_attr_info : null;
  const info = holder && holder.oldTrekInfo && typeof holder.oldTrekInfo === 'object' ? holder.oldTrekInfo : null;
  if (!info || !Array.isArray(info.shipSkins)) return;
  const dressCfg = config.get('OldTrekShipDressConfig') || {};
  info.shipSkins.forEach((skinIdRaw) => {
    const skinId = Math.max(0, toSafeInt(skinIdRaw, 0));
    if (skinId <= 0) return;
    const row = dressCfg[skinId] || dressCfg[String(skinId)] || null;
    if (row) addAttrs(base, row.attrsExternal);
  });
}

function addArtifactAttrs(base, player = {}) {
  const info = player && player.artifactInfo && typeof player.artifactInfo === 'object' ? player.artifactInfo : null;
  if (!info) return;
  const artifacts = Array.isArray(info.artifacts)
    ? info.artifacts
    : Object.values(info.artifactMap && typeof info.artifactMap === 'object' ? info.artifactMap : {})
      .flatMap((rows) => (Array.isArray(rows) ? rows : []));
  if (artifacts.length <= 0) return;
  const artifactByUid = new Map(artifacts.map((row) => [toSafeInt(row && row.uid, 0), row]));
  const equipMap = info.equipMap && typeof info.equipMap === 'object' && !Array.isArray(info.equipMap) ? info.equipMap : {};

  Object.keys(equipMap).forEach((typeKey) => {
    const artifact = artifactByUid.get(toSafeInt(equipMap[typeKey], 0));
    if (!artifact) return;
    const attr = artifact.attr && typeof artifact.attr === 'object' ? artifact.attr : {};
    const attrId = toSafeInt(attr.type, 0);
    const value = Math.max(0, toSafeInt(attr.value, 0));
    if (attrId > 0 && value > 0) addAttrs(base, { [attrId]: value });
    addAttrList(base, artifact.extraAttrs);
    const quenchRow = getConfigRow('ArtifactQuenchConfig', artifact.quenchLv);
    if (quenchRow) addAttrs(base, quenchRow.attrs);
  });
}

function addValhallaAttrs(base, player = {}) {
  const holder = player && player.other_attr_info && typeof player.other_attr_info === 'object'
    ? player.other_attr_info
    : null;
  const info = holder && holder.valhallaInfo && typeof holder.valhallaInfo === 'object'
    ? holder.valhallaInfo
    : null;
  if (!info) return;

  const heroes = Array.isArray(info.valhalla) ? info.valhalla : [];
  const plans = Array.isArray(info.planInfo) ? info.planInfo : [];
  const planId = Math.max(0, toSafeInt(info.plan, 0));
  const plan = plans.find((row) => toSafeInt(row && row.id, -1) === planId) || plans[0] || null;
  if (!plan || !plan.equippedMap || typeof plan.equippedMap !== 'object') return;

  const heroByUid = new Map(heroes.map((hero) => [toSafeInt(hero && hero.uid, -1), hero]));
  Object.keys(plan.equippedMap).forEach((slotKey) => {
    const hero = heroByUid.get(toSafeInt(plan.equippedMap[slotKey], -1));
    if (!hero) return;
    const row = getConfigRow('ValhallaConfig', hero.id);
    if (!row) return;
    (Array.isArray(row.attrs) ? row.attrs : []).forEach((attrRow) => {
      const attrId = toSafeInt(attrRow && attrRow.id, 0);
      const value = Math.max(0, toSafeInt(attrRow && attrRow.value, 0));
      if (attrId > 0 && value > 0) addAttrs(base, { [attrId]: value });
    });
    const levelUpAttrs = Array.isArray(row.levelUpAttrs) ? row.levelUpAttrs : [];
    const upgrades = Array.isArray(hero.attrUpgrades) ? hero.attrUpgrades : [];
    levelUpAttrs.forEach((attrRow, idx) => {
      const count = Math.max(0, toSafeInt(upgrades[idx], 0));
      if (count <= 0) return;
      if (attrRow && attrRow.id != null && attrRow.value != null) {
        addAttrs(base, { [attrRow.id]: attrRow.value }, count);
      }
    });
  });
}

function getOrbBaseLevelRate(star) {
  const baseCfg = config.get('OrbBaseConfig') || {};
  const rateCfg = baseCfg.levelRate || baseCfg[2] || {};
  const raw = rateCfg[toSafeInt(star, 0)] || rateCfg[String(toSafeInt(star, 0))];
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}

function addOrbAttrs(base, player = {}) {
  const artifactInfo = player && player.artifactInfo && typeof player.artifactInfo === 'object' ? player.artifactInfo : null;
  const orbInfo = artifactInfo && artifactInfo.orbInfo && typeof artifactInfo.orbInfo === 'object' ? artifactInfo.orbInfo : null;
  if (!orbInfo || !Array.isArray(orbInfo.slotData)) return;
  const orbDataMap = orbInfo.orbDataMap && typeof orbInfo.orbDataMap === 'object' && !Array.isArray(orbInfo.orbDataMap)
    ? orbInfo.orbDataMap
    : {};
  const orbDataList = Array.isArray(orbInfo.orbData) ? orbInfo.orbData : [];
  const orbById = new Map(orbDataList.map((row) => [toSafeInt(row && row.id, 0), row]));

  orbInfo.slotData.forEach((slot) => {
    const orbId = toSafeInt(slot && slot.orbId, 0);
    if (orbId <= 0) return;
    const row = getConfigRow('OrbConfig', orbId);
    if (!row) return;
    const data = orbDataMap[String(orbId)] || orbDataMap[orbId] || orbById.get(orbId) || {};
    const level = Math.max(1, toSafeInt(data.level, 1));
    const star = Math.max(0, toSafeInt(data.star, 0));
    const slotLevel = Math.max(1, toSafeInt(slot.level, 1));
    const multiplier = getOrbBaseLevelRate(star) * (1 + (level - 1) * 0.1 + (slotLevel - 1) * 0.02);
    addAttrs(base, row.attrs, multiplier);
    const specialCount = Math.min(star, Array.isArray(row.specialAttrs) ? row.specialAttrs.length : 0);
    addAttrList(base, Array.isArray(row.specialAttrs) ? row.specialAttrs.slice(0, specialCount) : [], multiplier);
  });
}

function addPetAttrs(base, player = {}) {
  const info = player && player.petInfo && typeof player.petInfo === 'object' ? player.petInfo : null;
  if (!info || !Array.isArray(info.pets)) return;
  const activePets = info.pets.filter((pet) => {
    const slot = toSafeInt(pet && pet.slot, 0);
    return slot >= 0;
  });
  activePets.forEach((pet) => {
    const row = getConfigRow('PetConfig', pet.id);
    if (!row) return;
    const level = Math.max(1, toSafeInt(pet.level, 1));
    addAttrs(base, row.attrs);
    addAttrs(base, row.attrsUp, level - 1);
    const passiveSkills = Array.isArray(pet.passiveSkills) ? pet.passiveSkills : [];
    passiveSkills.forEach((skillId) => {
      const skill = getConfigRow('PetPassiveSkillConfig', skillId);
      const quality = Math.max(1, toSafeInt(skill && skill.quality, 1));
      const petType = Math.max(0, toSafeInt(skill && skill.type, 0));
      const attrId = [101, 102, 103, 104, 105, 106][Math.max(0, (petType || 1) - 1)] || 101;
      addAttrs(base, { [attrId]: quality * 12 });
    });
  });
}

function addPetSoulAttrs(base, player = {}) {
  const holder = player && player.other_attr_info && typeof player.other_attr_info === 'object' ? player.other_attr_info : {};
  const info = holder.petSoulInfo && typeof holder.petSoulInfo === 'object' ? holder.petSoulInfo : null;
  if (!info || !Array.isArray(info.petSouls)) return;
  const activeIds = new Set();
  if (info.dispatch && typeof info.dispatch === 'object' && !Array.isArray(info.dispatch)) {
    Object.keys(info.dispatch).forEach((key) => activeIds.add(toSafeInt(info.dispatch[key], 0)));
  }
  info.petSouls.forEach((soul) => {
    if (activeIds.size > 0 && !activeIds.has(toSafeInt(soul && soul.id, 0))) return;
    const row = getConfigRow('PetSoulConfig', soul.id);
    if (!row) return;
    const quality = Math.max(3, toSafeInt(row.quality, 3));
    const star = Math.max(0, toSafeInt(soul.star, 0));
    const starRow = ((config.get('PetSoulUpgradeConfig') || {})[quality] || {})[star] || {};
    const attrRate = Math.max(0, toSafeInt(starRow.attrRate, 0));
    const attrRatio = soul.attrRatio && typeof soul.attrRatio === 'object' ? soul.attrRatio : {};
    Object.keys(row.maxAttr || {}).forEach((attrId) => {
      const maxValue = Math.max(0, toSafeInt(row.maxAttr[attrId], 0));
      const ratio = Math.max(0, toSafeInt(attrRatio[attrId], 3000)) + attrRate;
      addAttrs(base, { [attrId]: Math.floor(maxValue * ratio / 10000) });
    });
    addAttrs(base, starRow.attrs);
  });
}

function addElfAttrs(base, player = {}) {
  const holder = player && player.other_attr_info && typeof player.other_attr_info === 'object' ? player.other_attr_info : {};
  const info = holder.elfInfo && typeof holder.elfInfo === 'object' ? holder.elfInfo : null;
  if (!info || !Array.isArray(info.elfData)) return;

  const starCfg = config.get('ElfStarUpConfig') || {};
  const weaponCfg = config.get('ElfWeaponConfig') || {};

  info.elfData.forEach((elf) => {
    const elfId = toSafeInt(elf && elf.id, 0);
    if (elfId <= 0) return;

    const star = Math.max(0, toSafeInt(elf && elf.star, 0));
    const starRow = ((starCfg[elfId] || starCfg[String(elfId)] || {})[star])
      || ((starCfg[elfId] || starCfg[String(elfId)] || {})[String(star)])
      || null;
    if (starRow) addAttrs(base, starRow.attrs);

    const weaponMap = elf && elf.weapon && typeof elf.weapon === 'object' && !Array.isArray(elf.weapon)
      ? elf.weapon
      : {};
    const weaponCfgMap = weaponCfg[elfId] || weaponCfg[String(elfId)] || {};
    Object.keys(weaponMap).forEach((slotKey) => {
      const slot = Math.max(1, toSafeInt(slotKey, 0));
      const level = Math.max(0, toSafeInt(weaponMap[slotKey], 0));
      if (level <= 0) return;
      const row = weaponCfgMap[slot] || weaponCfgMap[String(slot)] || null;
      if (!row || toSafeInt(row.type, 0) !== 1) return;
      addAttrs(base, row.attr, level);
    });
  });
}

/**
 * Calculate the player's effective attributes for battle and UI display.
 */
function calcPlayerPower(player) {
  const formBase = config.get('FormationBaseConfig');
  const base = formBase && formBase.formationBasicAttribute
    ? { ...formBase.formationBasicAttribute }
    : { 1: 2000, 2: 240, 3: 40 };

  if (!base[4]) base[4] = 100;

  const level = Math.max(1, toSafeInt(player && player.level, 1));
  base[1] += level * 800;
  base[2] += level * 200;
  base[3] += level * 30;
  base[4] += level * 5;
  base[101] = toSafeInt(base[101], 0) + level * 4;
  base[102] = toSafeInt(base[102], 0) + level * 3;
  base[103] = toSafeInt(base[103], 0) + level * 3;
  base[104] = toSafeInt(base[104], 0) + level * 5;
  base[105] = toSafeInt(base[105], 0) + level * 4;
  base[106] = toSafeInt(base[106], 0) + level * 3;
  base[151] = toSafeInt(base[151], 0) + level * 2;
  base[152] = toSafeInt(base[152], 0) + level * 2;
  base[153] = toSafeInt(base[153], 0) + level * 2;
  base[154] = toSafeInt(base[154], 0) + level * 2;
  base[155] = toSafeInt(base[155], 0) + level * 3;
  base[156] = toSafeInt(base[156], 0) + level * 2;

  const stageId = Math.max(1, toSafeInt(
    player && player.roleInfo && (player.roleInfo.stageId != null ? player.roleInfo.stageId : player.roleInfo.stage),
    1
  ));
  if (stageId > 0) {
    const stageCfg = config.get('RoleStageConfig');
    const row = stageCfg && (stageCfg[stageId] || stageCfg[String(stageId)]);
    const attrs = row && row.attr && typeof row.attr === 'object' ? row.attr : {};
    Object.keys(attrs).forEach((key) => {
      base[key] = Math.max(0, toSafeInt(base[key], 0)) + Math.max(0, toSafeInt(attrs[key], 0));
    });
  }

  addFormationProgressionAttrs(base, player || {});

  const boxLv = Math.max(1, toSafeInt(player && player.boxInfo && player.boxInfo.level, 1));
  if (boxLv > 1) {
    const boxMult = 1 + (boxLv - 1) * 0.01;
    base[1] = Math.floor(base[1] * boxMult);
    base[2] = Math.floor(base[2] * boxMult);
  }

  const equipInfo = player && player.equipInfo ? player.equipInfo : {};
  const equipSetMap = equipInfo.equipSetMap && typeof equipInfo.equipSetMap === 'object'
    ? equipInfo.equipSetMap
    : {};
  const curPreset = String(Math.max(0, toSafeInt(equipInfo.curIndex, 0)));
  const plan = equipSetMap[curPreset] || {};
  const equips = Object.values(plan).filter((equip) => equip && equip.attrs);
  equips.forEach((equip) => {
    addAttrs(base, equip.attrs);
  });

  addSpiritAttrs(base, player || {});
  addValhallaAttrs(base, player || {});
  addGemAttrs(base, player || {});
  addMountAttrs(base, player || {});
  addArtifactAttrs(base, player || {});
  addItemRecordAttrs(base, player || {});
  addFashionAttrs(base, player || {});
  addFateAttrs(base, player || {});
  addFishingAttrs(base, player || {});
  addBloodlineAttrs(base, player || {});
  addHomelandAttrs(base, player || {});
  addOldTrekAttrs(base, player || {});
  addOrbAttrs(base, player || {});
  addPetAttrs(base, player || {});
  addPetSoulAttrs(base, player || {});
  addElfAttrs(base, player || {});
  applyPercentLinkedAttrs(base);

  return base;
}

/**
 * Calculate power score for display.
 */
function calcPowerScore(attrs) {
  const explicitPower = Math.max(
    0,
    toSafeInt(attrs && attrs.powerScore, 0),
    toSafeInt(attrs && attrs[999], 0)
  );
  if (explicitPower > 0) return explicitPower;

  const attrCfg = config.get('AttrConfig');
  let score = 0;
  Object.keys(attrs).forEach((key) => {
    const id = Number(key);
    const val = attrs[key];
    if (attrCfg && attrCfg[id] && Number(attrCfg[id].power) > 0) {
      score += val * attrCfg[id].power;
    } else {
      if (id === 1) score += val * 2;
      else if (id === 2) score += val * 10;
      else if (id === 3) score += val * 8;
      else if (id === 4) score += val * 3;
    }
  });
  return Math.floor(score / 100);
}

function enforcePvePowerAdvantage(playerAttrs = {}, enemyAttrs = {}, result = {}) {
  if (!result || result.win) return result;
  const playerPower = Math.max(0, toSafeInt(calcPowerScore(playerAttrs || {}), 0));
  const enemyPower = Math.max(0, toSafeInt(calcPowerScore(enemyAttrs || {}), 0));
  if (playerPower <= 0) return result;
  if (enemyPower > 0 && playerPower < enemyPower) return result;

  const playerMaxHp = Math.max(1, toSafeInt(playerAttrs && playerAttrs[1], 1));
  return {
    ...result,
    win: true,
    star: Math.max(1, toSafeInt(result.star, 1)),
    playerHPLeft: Math.max(
      1,
      toSafeInt(result.playerHPLeft, 0),
      Math.floor(playerMaxHp * 0.35)
    ),
    monsterHPLeft: 0,
    powerScore: playerPower,
  };
}

function calcElementDamage(attackerAttrs = {}, defenderAttrs = {}) {
  return ELEMENT_ATTR_PAIRS.reduce((sum, pair) => {
    const atkValue = Math.max(0, toSafeInt(attackerAttrs && attackerAttrs[pair[0]], 0));
    const defValue = Math.max(0, toSafeInt(defenderAttrs && defenderAttrs[pair[1]], 0));
    return sum + Math.max(0, atkValue - defValue);
  }, 0);
}

function applyBattleDamageRates(damage, attackerAttrs = {}, defenderAttrs = {}, isPvp = false) {
  const incAttrId = isPvp ? 245 : 243;
  const decAttrId = isPvp ? 246 : 244;
  const increase = Math.max(0, toSafeInt(attackerAttrs && attackerAttrs[incAttrId], 0));
  const reduction = Math.max(0, toSafeInt(defenderAttrs && defenderAttrs[decAttrId], 0));
  const rate = Math.max(1000, 10000 + increase - reduction);
  return Math.max(1, Math.floor(Math.max(1, damage) * rate / 10000));
}

/**
 * Get monster attrs from config.
 */
function getMonsterAttrs(monsterId) {
  const monsterCfg = config.get('MonsterConfig');
  if (!monsterCfg || !monsterCfg[monsterId]) {
    const fallbackHP = 2400 + (monsterId % 1000) * 100;
    return {
      1: fallbackHP,
      2: Math.floor(fallbackHP * 0.55),
      3: Math.floor(fallbackHP * 0.05),
      4: 114,
    };
  }
  const attrs = { ...monsterCfg[monsterId].monsterAttrs };
  const safeMonsterId = Math.max(0, toSafeInt(monsterId, 0));
  if (safeMonsterId >= 200000 && safeMonsterId < 300000) {
    const stage = Math.max(1, safeMonsterId - 200000);
    attrs[1] = Math.max(12000, Math.floor(14000 + stage * 4200));
    attrs[2] = Math.max(800, Math.floor(2200 + stage * 520));
    attrs[3] = Math.max(120, Math.floor(320 + stage * 70));
    attrs[4] = Math.max(110, Math.floor(150 + stage * 6));
    attrs[101] = Math.max(0, Math.floor(600 + stage * 60));
    attrs[102] = Math.max(0, Math.floor(500 + stage * 40));
    attrs[103] = Math.max(0, Math.floor(500 + stage * 40));
    attrs[104] = Math.max(0, Math.floor(400 + stage * 30));
    attrs[105] = Math.max(0, Math.floor(900 + stage * 60));
    attrs[106] = Math.max(0, Math.floor(500 + stage * 35));
    attrs[151] = Math.max(0, Math.floor(200 + stage * 20));
    attrs[152] = Math.max(0, Math.floor(200 + stage * 20));
    attrs[153] = Math.max(0, Math.floor(200 + stage * 20));
    attrs[154] = Math.max(0, Math.floor(200 + stage * 20));
    attrs[155] = Math.max(0, Math.floor(300 + stage * 25));
    attrs[156] = Math.max(0, Math.floor(200 + stage * 20));
  }
  return attrs;
}

/**
 * Simulate a full auto battle.
 */
function simulateBattle(playerAttrs, monsterAttrs, options = {}) {
  const constCfg = config.get('ConstConfig');
  const maxRounds = (constCfg && constCfg.fightMaxRound) || 30;

  let pHP = playerAttrs[1] || 3000;
  const pMaxHP = pHP;
  let mHP = monsterAttrs[1] || 2400;
  const mMaxHP = mHP;
  
  const rounds = [];
  let round = 0;
  const playerFirst = (playerAttrs[4] || 100) >= (monsterAttrs[4] || 114);
  const playerMonsterMinDamage = options && options.enforcePlayerMonsterMinDamage
    && calcPowerScore(playerAttrs || {}) > calcPowerScore(monsterAttrs || {})
    ? Math.max(1, Math.ceil(mMaxHP * PLAYER_MONSTER_MIN_DAMAGE_RATE))
    : 0;
  let playerStunRounds = 0;
  let monsterStunRounds = 0;

  const getAttr = (attrs, attrId, fallback = 0) => Math.max(0, toSafeInt(attrs && attrs[attrId], fallback));
  const getChance = (value, resistValue) => Math.max(0, getAttr(value, 0, 0));
  const rollRate = (rate) => Math.random() < Math.max(0, rate) / 10000;
  const getProcRate = (atkAttrs, atkAttrId, defAttrs, resistAttrId) => Math.max(
    0,
    getAttr(atkAttrs, atkAttrId, 0) - getAttr(defAttrs, resistAttrId, 0),
  );
  const isPvp = !!(options && options.isPvp);
  const calcBaseDamage = (atk, def, attackerAttrs = {}, defenderAttrs = {}) => {
    let dmg = (Math.max(1, atk) * Math.max(1, atk)) / Math.max(1, Math.max(1, atk) + Math.max(0, def));
    dmg *= 0.95 + Math.random() * 0.1;
    dmg += calcElementDamage(attackerAttrs, defenderAttrs);
    return applyBattleDamageRates(Math.floor(dmg), attackerAttrs, defenderAttrs, isPvp);
  };
  const calcCritDamageMultiplier = (attrs) => 1 + Math.max(0, getAttr(attrs, 205, 5000)) / 10000;
  const makeAction = (kind, payload = {}) => ({ kind, ...payload });

  const resolveAttackSequence = ({
    attackerKey,
    defenderKey,
    attackerAttrs,
    defenderAttrs,
    attackerHP,
    defenderHP,
    attackerMaxHP,
    defenderMaxHP,
  }) => {
    const actions = [];
    const evadeRate = getProcRate(defenderAttrs, 104, attackerAttrs, 154);
    if (rollRate(evadeRate)) {
      actions.push(makeAction('evade', { caster: defenderKey, target: attackerKey }));
      return { actions, attackerHP, defenderHP, stunApplied: false };
    }

    const critRate = getProcRate(attackerAttrs, 105, defenderAttrs, 155);
    const comboRate = getProcRate(attackerAttrs, 103, defenderAttrs, 153);
    const lifestealRate = getProcRate(attackerAttrs, 101, defenderAttrs, 151);
    const stunRate = getProcRate(attackerAttrs, 106, defenderAttrs, 156);
    const comboTriggered = rollRate(comboRate);
    const attackTimes = comboTriggered ? 2 : 1;
    const counterRate = getProcRate(defenderAttrs, 102, attackerAttrs, 152);
    let counterTriggered = false;
    let stunApplied = false;

    for (let attackIndex = 0; attackIndex < attackTimes; attackIndex += 1) {
      if (defenderHP <= 0) break;
      const isCrit = rollRate(critRate);
      let damage = calcBaseDamage(getAttr(attackerAttrs, 2, 1), getAttr(defenderAttrs, 3, 0), attackerAttrs, defenderAttrs);
      if (isCrit) {
        damage = Math.max(1, Math.floor(damage * calcCritDamageMultiplier(attackerAttrs)));
      }
      if (attackerKey === 'player' && defenderKey === 'monster' && playerMonsterMinDamage > 0) {
        damage = Math.max(damage, playerMonsterMinDamage);
      }
      defenderHP = Math.max(0, defenderHP - damage);
      actions.push(makeAction('attack', {
        caster: attackerKey,
        target: defenderKey,
        damage,
        crit: isCrit,
        combo: comboTriggered && attackIndex === 1,
        targetHp: defenderHP,
      }));

      if (rollRate(lifestealRate)) {
        const heal = Math.max(1, Math.min(damage, attackerMaxHP - attackerHP));
        if (heal > 0) {
          attackerHP = Math.min(attackerMaxHP, attackerHP + heal);
          actions.push(makeAction('heal', { caster: attackerKey, target: attackerKey, value: heal, targetHp: attackerHP }));
        }
      }

      if (!stunApplied && defenderHP > 0 && rollRate(stunRate)) {
        stunApplied = true;
        actions.push(makeAction('stun', { caster: attackerKey, target: defenderKey }));
      }

      if (!counterTriggered && defenderHP > 0 && rollRate(counterRate)) {
        counterTriggered = true;
        const counterCritRate = getProcRate(defenderAttrs, 105, attackerAttrs, 155);
        const counterCrit = rollRate(counterCritRate);
        let counterDamage = calcBaseDamage(getAttr(defenderAttrs, 2, 1), getAttr(attackerAttrs, 3, 0), defenderAttrs, attackerAttrs);
        if (counterCrit) {
          counterDamage = Math.max(1, Math.floor(counterDamage * calcCritDamageMultiplier(defenderAttrs)));
        }
        attackerHP = Math.max(0, attackerHP - counterDamage);
        actions.push(makeAction('counter', {
          caster: defenderKey,
          target: attackerKey,
          damage: counterDamage,
          crit: counterCrit,
          targetHp: attackerHP,
        }));
      }
    }

    return { actions, attackerHP, defenderHP, stunApplied };
  };

  while (pHP > 0 && mHP > 0 && round < maxRounds) {
    round += 1;
    const turnActions = [];
    let pDmg = 0;
    let mDmg = 0;
    let pCrit = false;
    let mCrit = false;
    let playerEvade = false;
    let monsterEvade = false;
    let playerCombo = false;
    let monsterCombo = false;
    let playerCounter = false;
    let monsterCounter = false;
    let playerHeal = 0;
    let monsterHeal = 0;
    let playerStun = false;
    let monsterStun = false;

    const doPlayerTurn = () => {
      if (playerStunRounds > 0) {
        playerStunRounds -= 1;
        turnActions.push(makeAction('skip', { caster: 'player', reason: 'stun' }));
        return;
      }
      const result = resolveAttackSequence({
        attackerKey: 'player',
        defenderKey: 'monster',
        attackerAttrs: playerAttrs,
        defenderAttrs: monsterAttrs,
        attackerHP: pHP,
        defenderHP: mHP,
        attackerMaxHP: pMaxHP,
        defenderMaxHP: mMaxHP,
      });
      pHP = result.attackerHP;
      mHP = result.defenderHP;
      if (result.stunApplied) monsterStunRounds = Math.max(monsterStunRounds, 1);
      result.actions.forEach((action) => {
        turnActions.push(action);
        if (action.kind === 'evade' && action.caster === 'monster') monsterEvade = true;
        if (action.kind === 'attack' && action.caster === 'player') {
          pDmg += action.damage;
          pCrit = pCrit || !!action.crit;
          playerCombo = playerCombo || !!action.combo;
        }
        if (action.kind === 'counter' && action.caster === 'monster') {
          mDmg += action.damage;
          mCrit = mCrit || !!action.crit;
          monsterCounter = true;
        }
        if (action.kind === 'heal' && action.caster === 'player') playerHeal += action.value;
        if (action.kind === 'stun' && action.caster === 'player') monsterStun = true;
      });
    };

    const doMonsterTurn = () => {
      if (monsterStunRounds > 0) {
        monsterStunRounds -= 1;
        turnActions.push(makeAction('skip', { caster: 'monster', reason: 'stun' }));
        return;
      }
      const result = resolveAttackSequence({
        attackerKey: 'monster',
        defenderKey: 'player',
        attackerAttrs: monsterAttrs,
        defenderAttrs: playerAttrs,
        attackerHP: mHP,
        defenderHP: pHP,
        attackerMaxHP: mMaxHP,
        defenderMaxHP: pMaxHP,
      });
      mHP = result.attackerHP;
      pHP = result.defenderHP;
      if (result.stunApplied) playerStunRounds = Math.max(playerStunRounds, 1);
      result.actions.forEach((action) => {
        turnActions.push(action);
        if (action.kind === 'evade' && action.caster === 'player') playerEvade = true;
        if (action.kind === 'attack' && action.caster === 'monster') {
          mDmg += action.damage;
          mCrit = mCrit || !!action.crit;
          monsterCombo = monsterCombo || !!action.combo;
        }
        if (action.kind === 'counter' && action.caster === 'player') {
          pDmg += action.damage;
          pCrit = pCrit || !!action.crit;
          playerCounter = true;
        }
        if (action.kind === 'heal' && action.caster === 'monster') monsterHeal += action.value;
        if (action.kind === 'stun' && action.caster === 'monster') playerStun = true;
      });
    };

    if (playerFirst) {
      doPlayerTurn();
      if (mHP > 0) doMonsterTurn();
    } else {
      doMonsterTurn();
      if (pHP > 0) doPlayerTurn();
    }

    rounds.push({
      round,
      playerHP: Math.max(0, Math.floor(pHP)),
      monsterHP: Math.max(0, Math.floor(mHP)),
      playerDmg: pDmg,
      monsterDmg: mDmg,
      playerCrit: pCrit,
      monsterCrit: mCrit,
      playerEvade,
      monsterEvade,
      playerCombo,
      monsterCombo,
      playerCounter,
      monsterCounter,
      playerHeal,
      monsterHeal,
      playerStun,
      monsterStun,
      actions: turnActions,
    });
  }

  const win = mHP <= 0;
  let star = 0;
  if (win) {
    if (pHP > pMaxHP * 0.5) star = 3;
    else if (pHP > pMaxHP * 0.2) star = 2;
    else star = 1;
  }

  return {
    win,
    star,
    rounds,
    totalRounds: round,
    playerHPLeft: Math.max(0, Math.floor(pHP)),
    monsterHPLeft: Math.max(0, Math.floor(mHP)),
    powerScore: calcPowerScore(playerAttrs),
  };
}

/**
 * Generate arena opponent attrs.
 */
function generateOpponentAttrs(playerLevel, difficulty) {
  const adj = 1 + difficulty * 0.08;
  const level = Math.max(1, playerLevel + difficulty);
  return {
    1: Math.floor((2400 + level * 400) * adj),
    2: Math.floor((320 + level * 80) * adj),
    3: Math.floor((55 + level * 15) * adj),
    4: Math.floor((103 + level * 3) * adj),
    101: 300 + level * 10,
    102: 15000,
  };
}

module.exports = {
  calcPlayerPower,
  calcPowerScore,
  enforcePvePowerAdvantage,
  getMonsterAttrs,
  simulateBattle,
  generateOpponentAttrs,
};
