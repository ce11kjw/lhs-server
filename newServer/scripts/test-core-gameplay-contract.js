'use strict';

const assert = require('assert/strict');
const Module = require('module');

// This is a pure contract probe. Stub infrastructure-only dependencies so it
// can run from a source bundle before npm dependencies or MongoDB are present.
const originalLoad = Module._load;
const loggerStub = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
class SchemaStub {
  constructor() {
    this.statics = {};
    this.methods = {};
  }
  index() {}
  pre() {}
}
SchemaStub.Types = { Mixed: class MixedStub {} };
Module._load = function loadContractDependency(request, parent, isMain) {
  if (request === 'mongoose') {
    return { Schema: SchemaStub, model: () => ({}) };
  }
  if (request === 'ioredis') {
    return class RedisStub {};
  }
  if (request === '../logger' || request === './logger' || /[\\/]logger(?:\.js)?$/.test(request)) {
    return loggerStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const config = require('../src/services/ConfigService');
const {
  ensureFormationInfo,
  getFormationConfig,
} = require('../src/services/FormationService');
const {
  ensureEquipInfo,
  getPresetSetInfo,
} = require('../src/services/EquipService');
const { buildPlayer500Data } = require('../src/handlers/playerPayload');
const basic = require('../src/handlers/basic');
const raid = require('../src/handlers/raid');
const upgrade = require('../src/handlers/upgrade');
const mount = require('../src/handlers/mount');
const tower = require('../src/handlers/tower');
const specSpirit = require('../src/handlers/spec-spirit');
const roleAppearance = require('../src/services/RoleAppearanceService');
const playerService = require('../src/services/PlayerService');
const runtimeBus = require('../src/services/RuntimeBus');
const box = require('../src/handlers/box');
const task = require('../src/handlers/task');
const { getTaskDirtyIds } = require('../src/services/TaskDirtyService');

function firstConfigRow(map, predicate = () => true) {
  return Object.keys(map || {})
    .map((key) => map[key])
    .find((row) => row && typeof row === 'object' && predicate(row));
}

function collectEvents(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectEvents(entry, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  if (value.typ != null) output.push(value);
  if (value.es != null) collectEvents(value.es, output);
  return output;
}

async function run() {
  const tables = config.loadAllTables();
  assert.ok(Object.keys(tables).length > 0, 'client config tables must load');

  const formationCfg = getFormationConfig();
  const roleKungfuCfg = config.get('RoleKungFuConfig') || {};
  const skillCfg = config.get('SkillConfig') || {};
  const behaviorCfg = config.get('SkillBehaviorConfig') || {};
  const mapCfg = config.get('MapConfig') || {};
  const assetsCfg = config.get('AssetsConfig') || {};
  const swordCfg = config.get('SwordConfig') || {};
  const swordLevelCfg = config.get('SwordLevelConfig') || {};
  const swordStarCfg = config.get('SwordStarLevelConfig') || {};
  const passiveSkillCfg = config.get('SwordPassiveSkillConfig') || {};
  const towerAttrCfg = config.get('TowerAttrConfig') || {};
  const fashionCfg = config.get('FashionConfig') || {};
  const specSpiritCfg = config.get('SpecSpiritConfig') || {};
  const specSpiritEntryCfg = config.get('SpecSpiritEntryConfig') || {};
  const specSpiritLevelCfg = config.get('SpecSpiritLevelConfig') || {};
  const specSpiritStarCfg = config.get('SpecSpiritStarConfig') || {};
  const specSpiritSuitCfg = config.get('SpecSpiritSuitConfig') || {};
  assert.ok(Object.keys(formationCfg).length > 0, 'FormationConfig must exist');
  assert.ok(Object.keys(roleKungfuCfg).length > 0, 'RoleKungFuConfig must exist');
  assert.ok(Object.keys(skillCfg).length > 0, 'SkillConfig must exist');
  assert.ok(Object.keys(behaviorCfg).length > 0, 'SkillBehaviorConfig must exist');
  assert.ok(Object.keys(mapCfg).length > 0, 'MapConfig must exist');
  assert.ok(Object.keys(swordCfg).length > 0, 'SwordConfig must exist');
  assert.ok(Object.keys(towerAttrCfg).length > 0, 'TowerAttrConfig must exist');
  assert.ok(Object.keys(specSpiritCfg).length > 0, 'SpecSpiritConfig must exist');
  const equipAsset = firstConfigRow(assetsCfg, (row) => Number(row.id) > 0 && Number(row.type) === 3 && Number(row.subType) > 0);
  assert.ok(equipAsset, 'at least one equipment asset must exist');
  const swordRow = firstConfigRow(swordCfg, (row) => Number(row.id) > 0 && Number(row.quality) > 0 && assetsCfg[row.id]);
  assert.ok(swordRow, 'at least one config-backed sword must exist');
  const towerSkillRows = Object.keys(towerAttrCfg)
    .map((key) => towerAttrCfg[key])
    .filter((row) => row && Number(row.id) > 0 && row.attrs && Object.keys(row.attrs).length > 0);
  assert.ok(towerSkillRows.length >= 2, 'at least two tower attr skills must exist');

  const kungfu = firstConfigRow(roleKungfuCfg, (row) => Number(row.id) > 0 && Number(row.atkId) > 0);
  assert.ok(kungfu, 'at least one kungfu with atkId must exist');
  assert.ok(skillCfg[kungfu.atkId] || skillCfg[String(kungfu.atkId)], 'kungfu atkId must exist in SkillConfig');
  const kungfuSkillPairs = Object.keys(roleKungfuCfg)
    .map((key) => roleKungfuCfg[key])
    .filter((row) => row && Number(row.id) > 0 && Number(row.atkId) > 0)
    .map((row) => ({ kungfuId: Number(row.id), skillId: Number(row.atkId) }));
  kungfuSkillPairs.forEach((pair) => {
    const resolved = raid.resolvePlayerBattleSkill({ roleInfo: { kungfuId: pair.kungfuId } });
    assert.equal(resolved.skillId, pair.skillId, `kungfu ${pair.kungfuId} must use its own atkId`);
    assert.ok(behaviorCfg[resolved.behaviorId] || behaviorCfg[String(resolved.behaviorId)], `kungfu ${pair.kungfuId} behavior must exist`);
  });

  const player = {
    playerId: 'core_contract_player',
    userId: 'core_contract_user',
    name: 'CoreContract',
    level: 100,
    roleInfo: {
      kungfuId: Number(kungfu.id),
      subJob: 0,
      stage: 1,
      kungfuInfos: [{
        id: Number(kungfu.id),
        kungfuId: Number(kungfu.id),
        skillLevel: [1, 1, 1, 1, 1],
        sequence: [0, 0, 0, 0, 0],
      }],
    },
    formationInfo: { equippedId: 999999999, owns: [999999999] },
    equipInfo: {
      curIndex: 0,
      equipSetMap: { 0: {} },
      openListMap: { 0: [
        { uid: 1, id: 999999999, type: 1, quailty: 1, lv: 1, attrs: {} },
        { uid: 2, id: Number(equipAsset.id), type: 999, quailty: 999, lv: 1, attrs: { 1: 10 } },
      ] },
      setInfoMap: { 0: { formation: 0 } },
      raidSetMap: {},
    },
    swordInfo: { data: [], equippedUid: 0 },
    spiritInfo: { id: -1 },
    artifactInfo: { equipMap: {}, orbInfo: { slotData: [] } },
    fateInfo: { id: 1, planInfoMap: { 1: { skills: [] } } },
    other_attr_info: {},
    currencies: { gold: 0, diamond: 0, silver: 10000 },
    items: { 4: 100 },
  };

  const formationInfo = ensureFormationInfo(player);
  assert.ok(formationCfg[formationInfo.equippedId] || formationCfg[String(formationInfo.equippedId)], 'invalid equipped formation must migrate');
  assert.ok(!formationInfo.owns.includes(999999999), 'invalid owned formation must be removed');

  assert.equal(ensureEquipInfo(player), true, 'malformed equip/preset state must report a migration');
  assert.equal(player.equipInfo.openListMap['0'].length, 1, 'invalid equip template must be removed without deleting a valid equip');
  assert.equal(player.equipInfo.openListMap['0'][0].type, Number(equipAsset.subType), 'equip slot type must come from AssetsConfig');
  assert.equal(player.equipInfo.openListMap['0'][0].quailty, Number(equipAsset.quality), 'equip quality must come from AssetsConfig');
  const preset = getPresetSetInfo(player, 0);
  assert.ok(formationCfg[preset.formation] || formationCfg[String(preset.formation)], 'preset formation must be config-backed');
  assert.ok(preset.elf && typeof preset.elf === 'object' && !Array.isArray(preset.elf), 'preset elf map must exist');
  assert.ok(preset.orb && typeof preset.orb === 'object' && !Array.isArray(preset.orb), 'preset orb map must exist');
  assert.ok(Number(preset.fate) > 0, 'preset fate plan must be positive');
  assert.ok(Number.isFinite(Number(preset.elfPlan)), 'preset elfPlan must be numeric');

  player.swordInfo = {
    data: [{
      uid: 901,
      id: 999999999,
      quality: 999,
      level: 999,
      star: 999,
      skills: [{ id: 999999999, quality: 999, level: 999 }],
    }],
    optionalSwords: [{ uid: 902, id: 999999999, quality: 999, level: 999, star: 999 }],
    equippedUid: 123456,
    wishId: 999999999,
    skinId: 999999999,
  };
  const mountInfo = mount.ensureMountInfo(player);
  const normalizedMount = mountInfo.data[0];
  assert.ok(swordCfg[normalizedMount.id] || swordCfg[String(normalizedMount.id)], 'mount id must be config-backed');
  assert.equal(normalizedMount.quality, Number(swordCfg[normalizedMount.id].quality), 'mount quality must come from SwordConfig');
  assert.ok(swordLevelCfg[normalizedMount.quality][normalizedMount.level], 'mount level must exist in SwordLevelConfig');
  assert.ok(swordStarCfg[normalizedMount.quality][normalizedMount.star], 'mount star must exist in SwordStarLevelConfig');
  normalizedMount.skills.forEach((skill) => {
    assert.ok(passiveSkillCfg[skill.id] || passiveSkillCfg[String(skill.id)], 'mount passive skill id must exist');
  });
  assert.equal(mountInfo.equippedUid, normalizedMount.uid, 'dangling equipped mount uid must migrate to an owned mount');
  assert.equal(mountInfo.wishId, 0, 'invalid mount wish id must be cleared');
  assert.equal(mountInfo.skinId, 0, 'invalid mount skin id must be cleared');
  const mountPayload = mount.buildMountInfoUpdatePayload(mountInfo);
  assert.ok(mountPayload.data.every((row) => swordCfg[row.id] || swordCfg[String(row.id)]), 'mount payload data must only contain valid swords');

  const towerFirst = Number(towerSkillRows[0].id);
  const towerSecond = Number(towerSkillRows[1].id);
  player.swordInfo.skills = [999999999, towerSecond];
  player.swordInfo.slotlist = [999999999, { id: towerFirst, lv: 2 }];
  player.swordInfo.skillCount = 1;
  player.swordInfo.autoPriority = [999999999, towerAttrCfg[towerFirst].priority, towerAttrCfg[towerSecond].priority];
  const towerInfo = tower.ensureTowerInfo(player);
  assert.deepEqual(towerInfo.slotlist, [{ id: towerFirst, lv: 2 }], 'tower slots must be {id, lv} objects backed by TowerAttrConfig');
  assert.deepEqual(towerInfo.skills, [towerSecond], 'tower optional skills must be valid TowerAttrConfig ids and exclude equipped slots');
  assert.ok(towerInfo.autoPriority.every((id) => id === 0 || Number.isFinite(Number(id))), 'tower auto priority must be normalized');
  tower.grantTowerSkillChoice(towerInfo, 1);
  assert.equal(towerInfo.skillCount, 1, 'tower win must grant one pending skill choice');
  assert.ok(towerInfo.skills.length > 0, 'tower win must provide selectable skill candidates');
  towerInfo.skills.forEach((id) => assert.ok(towerAttrCfg[id] || towerAttrCfg[String(id)], 'tower generated skill must exist'));
  playerService.savePlayer = async (_userId, state) => state;
  const towerSelectResponse = await tower.handleTowerSelectSkill({ select: 0, replace: 0 }, { player, userId: player.userId }, 82);
  assert.equal(towerSelectResponse.data.result, 0, 'tower skill selection must succeed');
  assert.ok(towerSelectResponse.data.slotlist[0] && towerSelectResponse.data.slotlist[0].id > 0, 'tower selection response must keep slot objects');
  assert.equal(towerSelectResponse.data.skillCount, 0, 'tower selection must consume the pending choice');
  assert.deepEqual(towerSelectResponse.data.skills, [], 'tower selection must clear candidates after the choice is consumed');

  const defaultFashionMap = roleAppearance.buildDefaultFashionMap(player.roleInfo);
  const defaultFashionTypes = Object.keys(defaultFashionMap);
  assert.ok(defaultFashionTypes.length > 0, 'selected role must have config-backed default fashion');
  const firstFashionType = defaultFashionTypes[0];
  const mismatchedFashion = firstConfigRow(
    fashionCfg,
    (row) => Number(row.id) > 0 && Number(row.type) > 0 && Number(row.type) !== Number(firstFashionType)
  );
  player.fashionInfo = {
    curFashion: {
      [firstFashionType]: Number(mismatchedFashion.id),
      999999: 999999,
    },
    fashion: {},
    fashionMap: {},
    fashions: { 999999: 1 },
    activateFashion: [999999],
  };
  assert.equal(roleAppearance.ensureRoleAppearance(player), true, 'invalid role appearance must report a migration');
  const normalizedFashionMap = roleAppearance.getPlayerFashionMap(player);
  Object.keys(normalizedFashionMap).forEach((typeKey) => {
    const id = normalizedFashionMap[typeKey];
    const row = fashionCfg[id] || fashionCfg[String(id)];
    assert.ok(row, `fashion ${id} must exist`);
    assert.equal(Number(row.type), Number(typeKey), `fashion ${id} must match slot ${typeKey}`);
  });
  assert.equal(normalizedFashionMap[firstFashionType], Number(defaultFashionMap[firstFashionType]), 'mismatched role fashion must fall back to the selected role default');
  assert.equal(player.fashionInfo.fashions['999999'], undefined, 'unknown owned fashion must be removed');
  assert.ok(!player.fashionInfo.activateFashion.includes(999999), 'unknown activated fashion must be removed');

  const spiritRow = firstConfigRow(specSpiritCfg, (row) => Number(row.id) > 0 && Number(row.stage) > 0);
  const entryRow = firstConfigRow(specSpiritEntryCfg, (row) => Number(row.id) > 0 && Number(row.type) !== 8 && Number(row.attrId) > 0);
  assert.ok(spiritRow && entryRow, 'special spirit and entry configs must exist');
  player.other_attr_info.specSpiritInfo = {
    list: [{
      uid: 501,
      id: Number(spiritRow.id),
      star: 999999,
      suit: 999999,
      entrys: [
        { id: 999999, type: 999999, value: 1 },
        { id: Number(entryRow.id), type: 999999, value: 10 },
      ],
    }],
    slots: { 101: 501, 102: 999999 },
    slotLv: { 101: 999999 },
  };
  const normalizedSpiritInfo = specSpirit.ensureSpecSpiritInfo(player);
  const normalizedSpirit = normalizedSpiritInfo.list[0];
  const normalizedSpiritCfg = specSpiritCfg[normalizedSpirit.id] || specSpiritCfg[String(normalizedSpirit.id)];
  const normalizedStageCfg = specSpiritStarCfg[normalizedSpiritCfg.stage] || specSpiritStarCfg[String(normalizedSpiritCfg.stage)];
  assert.equal(normalizedSpiritInfo.slots['102'], undefined, 'dangling special-spirit slot UID must be removed');
  assert.equal(normalizedSpiritInfo.slots['101'], 501, 'valid special-spirit slot UID must remain');
  assert.ok(normalizedStageCfg[normalizedSpirit.star] || normalizedStageCfg[String(normalizedSpirit.star)], 'special-spirit star must exist for its stage');
  assert.equal(normalizedSpirit.suit, 0, 'unknown special-spirit suit must be removed');
  assert.equal(normalizedSpirit.entrys.length, 1, 'unknown special-spirit entry must be removed');
  assert.equal(normalizedSpirit.entrys[0].type, Number(entryRow.attrId), 'special-spirit entry attr type must come from config');
  assert.ok(specSpiritLevelCfg[normalizedSpiritInfo.slotLv['101']] || specSpiritLevelCfg[String(normalizedSpiritInfo.slotLv['101'])], 'special-spirit slot level must exist');
  assert.ok(!specSpiritSuitCfg[999999] && !specSpiritSuitCfg['999999'], 'special-spirit suit fixture must be invalid');

  const payload = buildPlayer500Data(player);
  const kungfuInfo = payload.roleInfo.kungfuInfos.find((row) => Number(row.kungfuId) === Number(kungfu.id));
  assert.ok(kungfuInfo, 'active kungfu info must exist');
  assert.equal(new Set(kungfuInfo.sequence).size, kungfuInfo.sequence.length, 'kungfu sequence must not contain duplicates');
  assert.deepEqual(
    kungfuInfo.sequence.slice().sort((a, b) => a - b),
    Array.from({ length: kungfuInfo.sequence.length }, (_row, index) => index),
    'kungfu sequence must be a complete slot permutation'
  );

  const upgradeInfo = { kungfuInfos: [{ kungfuId: Number(kungfu.id), sequence: [0, 0], skillLevel: [] }] };
  const normalizedUpgradeInfo = upgrade.ensureKungfuInfo(upgradeInfo, Number(kungfu.id));
  assert.equal(new Set(normalizedUpgradeInfo.sequence).size, normalizedUpgradeInfo.sequence.length, 'upgrade path must preserve a valid sequence');
  assert.equal(upgrade.resolveKungfuSkillId(Number(kungfu.id), 0), Number(kungfu.atkId), 'slot zero must resolve to RoleKungFuConfig.atkId');
  const session = { player, userId: player.userId };
  playerService.savePlayer = async (_userId, state) => state;
  const skillUpgradeResponse = await upgrade.handleSkillUpgrade({ index: 0 }, session, 78);
  assert.equal(skillUpgradeResponse.data.result, 0, 'config-backed skill upgrade must succeed with enough currency');
  assert.equal(skillUpgradeResponse.data.index, 0, 'skill upgrade response must echo index');
  assert.equal(skillUpgradeResponse.data.skillId, Number(kungfu.atkId), 'skill upgrade must persist the configured skill id');
  assert.ok(Number(skillUpgradeResponse.data.level) > 0, 'skill upgrade response must contain the new level');

  const mapPackets = basic.handleEnterMap({ mapId: 999999999, line: 2 }, session, 77);
  const mapPush = mapPackets.find((packet) => packet.tag === 1400 && packet.msgUid === 0);
  const mapAck = mapPackets.find((packet) => packet.tag === 1400 && packet.msgUid === 77);
  assert.ok(mapCfg[mapPush.data.mapId] || mapCfg[String(mapPush.data.mapId)], 'map push must reference MapConfig');
  assert.equal(mapPush.data.line, 2, 'map line must be present');
  assert.equal(mapAck.data.result, 0, 'map RPC acknowledgement must contain result=0');
  assert.ok(mapPush.data.selfInfo.showInfo && typeof mapPush.data.selfInfo.showInfo === 'object', 'map selfInfo.showInfo must exist');

  const playerSkill = raid.resolvePlayerBattleSkill(player);
  assert.equal(playerSkill.skillId, Number(kungfu.atkId), 'battle playback must use the active kungfu attack skill');
  assert.ok(behaviorCfg[playerSkill.behaviorId] || behaviorCfg[String(playerSkill.behaviorId)], 'battle behavior must exist in SkillBehaviorConfig');

  const playerAttrs = { 1: 1000, 2: 100, 3: 10, 4: 100 };
  const monsterAttrs = { 1: 500, 2: 50, 3: 5, 4: 90 };
  const events = raid.buildChapterFightEvents(
    { monsterId: 1 },
    {},
    playerAttrs,
    monsterAttrs,
    {
      rounds: [{
        round: 1,
        actions: [{ kind: 'attack', caster: 'player', target: 'monster', damage: 500, targetHp: 0 }],
      }],
      battlePets: [],
    },
    { player }
  );
  const eventList = collectEvents(events);
  const skillEvent = eventList.find((event) => event.typ === 1 && event.c === 1);
  const behaviorEvent = eventList.find((event) => event.typ === 2 && event.c === 1);
  assert.equal(skillEvent.i, Number(kungfu.atkId), 'player skill event must carry the config-backed atkId');
  assert.equal(behaviorEvent.i, playerSkill.behaviorId, 'skill event must carry a config-backed behavior id');

  const levelCfg = config.get('LevelConfig') || {};
  const levelRow = firstConfigRow(levelCfg, (row) => Number(row.id) > 0 && Number(row.monsterId) > 0);
  assert.ok(levelRow, 'at least one mainline level must exist');
  player.raidInfo = {
    chapter: 1,
    level: Number(levelRow.id),
    hangUpChapter: 1,
    hangUpTime: Date.now(),
    chapterInfo: { id: Number(levelRow.id), rewardChapter: 0 },
  };
  player.items[4] = 100;
  const fightSession = { player, userId: player.userId };
  const fightPackets = await raid.handleStartFight({ type: 1, levelId: Number(levelRow.id) }, fightSession, 79);
  const fightResponse = (Array.isArray(fightPackets) ? fightPackets : [fightPackets])
    .find((packet) => packet.tag === 2300 && packet.msgUid === 79);
  assert.ok(fightResponse && fightResponse.data && fightResponse.data.fightResult, 'tag 2300 must return fightResult');
  assert.equal(fightResponse.data.id, Number(levelRow.id), 'tag 2300 must return the started level id');
  assert.equal(fightResponse.data.fightResult.win, 1, 'high-power contract player must clear the first mainline fight');
  assert.ok(Array.isArray(fightResponse.data.fightResult.entitys) && fightResponse.data.fightResult.entitys.length >= 2, 'fightResult.entitys must contain both sides');
  assert.ok(Array.isArray(fightResponse.data.fightResult.events) && fightResponse.data.fightResult.events.length > 1, 'fightResult.events must contain playable actions');
  const liveFightEvents = collectEvents(fightResponse.data.fightResult.events);
  liveFightEvents.filter((event) => event.typ === 1).forEach((event) => {
    assert.ok(skillCfg[event.i] || skillCfg[String(event.i)], `fight skill ${event.i} must exist`);
  });
  liveFightEvents.filter((event) => event.typ === 2).forEach((event) => {
    assert.ok(behaviorCfg[event.i] || behaviorCfg[String(event.i)], `fight behavior ${event.i} must exist`);
  });
  const claimPackets = await raid.handleClaimFightReward({ type: 1 }, fightSession, 80);
  const claimResponse = (Array.isArray(claimPackets) ? claimPackets : [claimPackets])
    .find((packet) => packet.tag === 2301 && packet.msgUid === 80);
  assert.ok(claimResponse && claimResponse.data.result === 0, 'tag 2301 must claim a won mainline battle');
  assert.ok(claimResponse.data.rewardInfo && Array.isArray(claimResponse.data.rewardInfo.items), 'tag 2301 rewardInfo.items must exist');
  assert.ok(Number(claimResponse.data.id) > Number(levelRow.id), 'tag 2301 must return the next mainline level id');

  const towerFightPackets = await raid.handleStartFight({ type: 9, levelId: 1 }, fightSession, 81);
  const towerFightResponse = (Array.isArray(towerFightPackets) ? towerFightPackets : [towerFightPackets])
    .find((packet) => packet.tag === 2300 && packet.msgUid === 81);
  assert.ok(towerFightResponse && towerFightResponse.data.result === 0, 'tag 2300 type=9 tower fight must succeed');
  assert.ok(towerFightResponse.data.updateInfo, 'tower fight must return updateInfo');
  assert.equal(towerFightResponse.data.updateInfo.skillCount, 1, 'tower fight must grant one pending skill choice');
  assert.ok(Array.isArray(towerFightResponse.data.updateInfo.skills) && towerFightResponse.data.updateInfo.skills.length > 0, 'tower fight must return selectable skills');
  towerFightResponse.data.updateInfo.skills.forEach((id) => {
    assert.ok(towerAttrCfg[id] || towerAttrCfg[String(id)], 'tower fight skill candidates must exist in TowerAttrConfig');
  });
  towerFightResponse.data.updateInfo.slotlist.forEach((slot) => {
    assert.ok(slot && towerAttrCfg[slot.id], 'tower fight slotlist entries must be {id, lv}');
  });

  const roleStageCfg = config.get('RoleStageConfig') || {};
  const taskCfg = config.get('TaskConfig') || {};
  const stageTwo = roleStageCfg[2] || roleStageCfg['2'];
  const realmBagelTaskId = (stageTwo.taskGroup || []).find((taskId) => {
    const row = taskCfg[taskId] || taskCfg[String(taskId)] || {};
    return Number(row.activeId) === 13;
  });
  const realmBagelTask = taskCfg[realmBagelTaskId] || taskCfg[String(realmBagelTaskId)];
  assert.ok(realmBagelTask, 'stage-two realm bagel task must exist');

  const boxTaskPlayer = {
    userId: 'contract-box-user',
    playerId: 'contract-box-player',
    level: 6,
    exp: 0,
    items: { 4: 1 },
    roleInfo: { stage: 2, stageId: 2, kungfuId: Number(kungfu.id) },
    raidInfo: { level: 1 },
    taskInfo: { tasks: {}, tasksMap: {} },
    other_attr_info: {
      realmTaskProgress: { bagelConsume: Number(realmBagelTask.taskValue1) - 1 },
      mainTaskProgress: {},
    },
  };
  playerService.savePlayerDeferred = async (_userId, state) => state;
  runtimeBus.setWsServer({
    broadcastExceptUser() {},
  });
  const boxPackets = await box.handleOpenBox({ count: 1 }, {
    player: boxTaskPlayer,
    userId: boxTaskPlayer.userId,
  }, 82);
  runtimeBus.setWsServer(null);

  assert.equal(boxPackets[0].tag, 2000, 'box action acknowledgement must remain first');
  const dirtyTaskIds = getTaskDirtyIds(boxTaskPlayer);
  assert.ok(dirtyTaskIds.includes(Number(realmBagelTaskId)), 'box consumption must mark the changed realm task dirty');
  const taskPushes = task.buildTaskUpdatePacketsByIds(boxTaskPlayer, dirtyTaskIds);
  const realmTaskPush = taskPushes.find((packet) => (
    packet.tag === 1000
    && packet.data
    && packet.data.task
    && Number(packet.data.task.id) === Number(realmBagelTaskId)
  ));
  assert.ok(realmTaskPush, 'box consumption must push the changed realm task');
  assert.equal(realmTaskPush.data.task.type, 4, 'realm task push must preserve type=4');
  assert.equal(realmTaskPush.data.task.status, 20, 'completed realm task must push status=20');
  assert.equal(realmTaskPush.data.task.progress, Number(realmBagelTask.taskValue1), 'realm task push must carry target progress');

  console.log(JSON.stringify({
    result: 'ok',
    tables: Object.keys(tables).length,
    formationId: formationInfo.equippedId,
    mapId: mapPush.data.mapId,
    kungfuId: Number(kungfu.id),
    skillId: playerSkill.skillId,
    behaviorId: playerSkill.behaviorId,
    sequence: kungfuInfo.sequence,
    specSpiritId: normalizedSpirit.id,
    specSpiritStar: normalizedSpirit.star,
    specSpiritSlotLevel: normalizedSpiritInfo.slotLv['101'],
    fashionParts: Object.keys(normalizedFashionMap).length,
    kungfuSkillPairs,
    mainlineLevelId: Number(levelRow.id),
    nextMainlineLevelId: Number(claimResponse.data.id),
    mainlineEvents: fightResponse.data.fightResult.events.length,
    towerSkillChoices: towerFightResponse.data.updateInfo.skills.length,
    realmBagelTaskId: Number(realmBagelTaskId),
  }));
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
