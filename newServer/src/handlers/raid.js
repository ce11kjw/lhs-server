/**
 * Main raid/map progression handlers.
 * tag: 2300 start fight, 2301 claim reward, 2302 hangup reward,
 *      2303 chapter reward, 2304 skip battle.
 */

const config = require('../services/ConfigService');
const battle = require('../services/BattleService');
const playerService = require('../services/PlayerService');
const logger = require('../logger');
const { syncExpItem } = require('../services/CurrencySync');
const { buildRewardItemSync } = require('../services/RewardSync');
const { addBagelConsume, refreshRealmStageTasks } = require('../services/RealmTaskProgressService');
const {
  addBagelConsume: addMainTaskBagelConsume,
  addCrossRivalChallengeCount,
  addMainlineChallengeCount,
  addDungeonBossChallengeCount,
  addTempleChallengeCount,
  refreshMainTaskProgress,
} = require('../services/MainTaskProgressService');
const {
  ensureRoleAppearance,
  getPlayerFashionMap,
  getBattlePets,
  getPrimaryBattlePetId,
  applyPrimaryBattlePetParts,
} = require('../services/RoleAppearanceService');
const { addOpenEquip, createEquipFromTemplateId, isEquipTemplateItem } = require('../services/EquipService');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function scheduleRaidPlayerSave(session, player, reason = 'raid') {
  if (!session || !session.userId || !player) return;
  if (session._raidSaveScheduled) return;
  session._raidSaveScheduled = true;
  Promise.resolve().then(async () => {
    try {
      await playerService.savePlayer(session.userId, player);
    } catch (err) {
      logger.warn(`[Raid] async save failed ${reason} user=${session.userId}: ${err.message}`);
    } finally {
      session._raidSaveScheduled = false;
    }
  });
}

function getAttrValue(attrs, attrId, aliases = [], fallback = 0) {
  if (!attrs || typeof attrs !== 'object') return fallback;

  if (attrs[attrId] != null) {
    return toSafeInt(attrs[attrId], fallback);
  }

  const keys = Array.isArray(aliases) ? aliases : [aliases];
  for (const key of keys) {
    if (key && attrs[key] != null) {
      return toSafeInt(attrs[key], fallback);
    }
  }

  return fallback;
}

function buildRewardInfo(items = []) {
  return {
    items: Array.isArray(items) ? items.slice() : [],
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

function grantRewardInfo(player, rewards = []) {
  const rewardInfo = buildRewardInfo([]);
  const syncRewards = [];

  (Array.isArray(rewards) ? rewards : []).forEach((row) => {
    const itemId = Math.max(0, toSafeInt(row && row.id, 0));
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (itemId <= 0 || count <= 0) return;

    if (isEquipTemplateItem(itemId)) {
      for (let index = 0; index < count; index += 1) {
        const equip = createEquipFromTemplateId(itemId, player && player.level, player);
        addOpenEquip(player, equip);
        rewardInfo.equips.push(equip);
      }
      return;
    }

    addRewardToPlayer(player, itemId, count);
    rewardInfo.items.push({ id: itemId, count });
    syncRewards.push({ id: itemId, count });
  });

  return { rewardInfo, syncRewards };
}

function clonePlayerSnapshot(player = {}) {
  if (!player || typeof player !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(player));
  } catch (_err) {
    return { ...player };
  }
}

function clonePlain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeTaskInfoSafe(taskInfo = {}, roleInfo = {}) {
  try {
    // Lazy require avoids the playerPayload -> artifact -> raid -> playerPayload cycle
    // from capturing a half-initialized module export during handler bootstrap.
    // eslint-disable-next-line global-require
    const mod = require('./playerPayload');
    if (mod && typeof mod.normalizeTaskInfo === 'function') {
      return mod.normalizeTaskInfo(taskInfo, roleInfo);
    }
  } catch (_err) {}
  return taskInfo;
}

function buildTaskSyncPackets(player = {}) {
  try {
    // Keep raid task sync behavior aligned with the shared task handler.
    // This preserves active-task ordering and also keeps claimed state updates.
    // eslint-disable-next-line global-require
    const task = require('./task');
    if (task && typeof task.buildActiveTaskUpdatePackets === 'function') {
      return task.buildActiveTaskUpdatePackets(player, 0);
    }
  } catch (_err) {}

  const taskInfo = normalizeTaskInfoSafe(player.taskInfo || {}, player.roleInfo || {});
  const tasksMap = taskInfo && typeof taskInfo.tasksMap === 'object' && !Array.isArray(taskInfo.tasksMap)
    ? taskInfo.tasksMap
    : {};
  const packets = [];

  Object.keys(tasksMap).forEach((typeKey) => {
    const list = Array.isArray(tasksMap[typeKey]) ? tasksMap[typeKey] : [];
    list.forEach((taskState) => {
      const taskId = Math.max(0, toSafeInt(taskState && taskState.id, 0));
      if (taskId <= 0) return;
      packets.push({
        tag: 1000,
        msgUid: 0,
        data: {
          task: clonePlain(taskState),
          index: String(taskId),
        },
      });
    });
  });

  return packets.sort((a, b) => {
    const aTask = a && a.data && a.data.task ? a.data.task : {};
    const bTask = b && b.data && b.data.task ? b.data.task : {};
    const aStatus = toSafeInt(aTask.status, 0);
    const bStatus = toSafeInt(bTask.status, 0);
    const aPriority = (aStatus === 10 || aStatus === 20) ? 0 : 1;
    const bPriority = (bStatus === 10 || bStatus === 20) ? 0 : 1;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return toSafeInt(aTask.id, 0) - toSafeInt(bTask.id, 0);
  });
}

function buildMainlineClearActivityPacket(player = {}) {
  const activityInfo = player && player.activityInfo && typeof player.activityInfo === 'object' && !Array.isArray(player.activityInfo)
    ? player.activityInfo
    : null;
  if (!activityInfo) return null;

  const datas = Array.isArray(activityInfo.datas) ? activityInfo.datas : null;
  if (!datas) return null;

  const rowIndex = datas.findIndex((row) => toSafeInt(row && row.id, 0) === 14001);
  if (rowIndex < 0) return null;

  const src = datas[rowIndex] && typeof datas[rowIndex] === 'object' && !Array.isArray(datas[rowIndex])
    ? datas[rowIndex]
    : { id: 14001 };
  const nextRecord = Math.max(
    Math.max(0, toSafeInt(src.record, 0)),
    Math.max(0, toSafeInt(player && player.raidInfo && player.raidInfo.level, 0)),
  );

  if (nextRecord === Math.max(0, toSafeInt(src.record, 0))) {
    return null;
  }

  const nextRow = {
    ...src,
    id: 14001,
    startTime: Math.max(0, toSafeInt(src.startTime, 0)),
    endTime: Math.max(0, toSafeInt(src.endTime, 0)),
    score: Math.max(0, toSafeInt(src.score, 0)),
    record: nextRecord,
    recordList: Array.isArray(src.recordList) ? clonePlain(src.recordList) : [],
    records: src.records && typeof src.records === 'object' && !Array.isArray(src.records)
      ? clonePlain(src.records)
      : {},
    buyRecords: src.buyRecords && typeof src.buyRecords === 'object' && !Array.isArray(src.buyRecords)
      ? clonePlain(src.buyRecords)
      : {},
  };

  datas[rowIndex] = nextRow;
  return {
    tag: 1701,
    msgUid: 0,
    data: {
      data: clonePlain(nextRow),
    },
  };
}

function buildRaidPlayerShowInfo(player = {}, power = 0) {
  player = clonePlayerSnapshot(player);
  ensureRoleAppearance(player);
  const roleInfo = player.roleInfo || {};
  const playerId = String(player.playerId || player.userId || 'raid_self');

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
    petId: getPrimaryBattlePetId(player),
    petSoulId: -1,
    artifactId: 0,
    fate: 0,
    foreverCard: 0,
    equipMap: {},
    fashionMap: getPlayerFashionMap(player),
    playerInfo: {
      dbid: playerId,
      level: Math.max(1, toSafeInt(player.level, 1)),
      avatar: Math.max(0, toSafeInt(roleInfo.avatar, toSafeInt(player.avatar, 0))),
      avatarUrl: player.avatarUrl ? String(player.avatarUrl) : '',
      avatarFrame: Math.max(0, toSafeInt(roleInfo.avatarFrame, toSafeInt(player.avatarFrame, 0))),
      title: Math.max(0, toSafeInt(roleInfo.title, toSafeInt(player.title, 0))),
    },
  };
}

const DEFAULT_PLAYER_SKILL_ID = 1002;
const DEFAULT_PLAYER_BEHAVIOR_ID = 10020;
const DEFAULT_MONSTER_SKILL_ID = 9009;
const DEFAULT_MONSTER_BEHAVIOR_ID = 90090;
const PET_BATTLE_POS = 10100;
const MAINLINE_PLAYBACK_ROUNDS = 15;
const DEMON_INVASION_FIGHT_TYPE = 5;
const PLAYER_DUEL_FIGHT_TYPE = 100;
const DEMON_INVASION_MONSTER_ID = 200101;
const DEFAULT_DEMON_INVASION_REWARDS = [
  { id: 1, count: 6 },
  { id: 4, count: 8 },
  { id: 20, count: 1200 },
  { id: 21, count: 8 },
];

function getConfigRow(map, id) {
  if (!map || id == null) return null;
  return map[id] || map[String(id)] || null;
}

function resolveBattleActionIds(skillId, fallbackSkillId, fallbackBehaviorId) {
  const skillCfgMap = config.get('SkillConfig') || {};
  const behaviorCfgMap = config.get('SkillBehaviorConfig') || {};
  const safeFallbackSkillId = Math.max(1, toSafeInt(fallbackSkillId, DEFAULT_PLAYER_SKILL_ID));
  const safeFallbackBehaviorId = Math.max(1, toSafeInt(fallbackBehaviorId, DEFAULT_PLAYER_BEHAVIOR_ID));

  const preferredSkillCfg = getConfigRow(skillCfgMap, skillId);
  const fallbackSkillCfg = getConfigRow(skillCfgMap, safeFallbackSkillId);
  const firstUsableSkillCfg = Object.keys(skillCfgMap)
    .map((key) => skillCfgMap[key])
    .find((row) => row && typeof row === 'object' && toSafeInt(row.id, 0) > 0);
  const skillCfg = preferredSkillCfg || fallbackSkillCfg || firstUsableSkillCfg;
  const resolvedSkillId = Math.max(
    1,
    toSafeInt(skillCfg && skillCfg.id, toSafeInt(skillId, safeFallbackSkillId) || safeFallbackSkillId),
  );

  const actionIds = Array.isArray(skillCfg && skillCfg.actions) ? skillCfg.actions : [];
  let behaviorId = actionIds
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .find((id) => id > 0 && getConfigRow(behaviorCfgMap, id)) || 0;

  if (behaviorId <= 0 && getConfigRow(behaviorCfgMap, resolvedSkillId)) {
    behaviorId = resolvedSkillId;
  }

  if (behaviorId <= 0 && getConfigRow(behaviorCfgMap, safeFallbackBehaviorId)) {
    behaviorId = safeFallbackBehaviorId;
  }
  if (behaviorId <= 0) {
    behaviorId = Object.keys(behaviorCfgMap)
      .map((key) => Math.max(0, toSafeInt(key, 0)))
      .find((id) => id > 0 && getConfigRow(behaviorCfgMap, id)) || safeFallbackBehaviorId;
  }

  return {
    skillId: resolvedSkillId,
    behaviorId,
  };
}

function resolvePlayerBattleSkill(player = {}) {
  const roleInfo = player && player.roleInfo && typeof player.roleInfo === 'object'
    ? player.roleInfo
    : {};
  const kungfuId = Math.max(0, toSafeInt(roleInfo.kungfuId, 0));
  const kungfuCfgMap = config.get('RoleKungFuConfig') || {};
  const kungfuCfg = kungfuCfgMap[kungfuId] || kungfuCfgMap[String(kungfuId)] || null;
  const attackSkillId = Math.max(0, toSafeInt(kungfuCfg && kungfuCfg.atkId, 0));
  return resolveBattleActionIds(
    attackSkillId || DEFAULT_PLAYER_SKILL_ID,
    DEFAULT_PLAYER_SKILL_ID,
    DEFAULT_PLAYER_BEHAVIOR_ID,
  );
}

function buildFightVars(hpValue = 0) {
  const hp = Math.max(0, toSafeInt(hpValue, 0));
  return {
    1: hp,
    2: 0,
    3: 0,
    '-1': hp,
  };
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
    action.es = [[{
      typ: 6,
      i: 0,
      c: casterPos,
      t: targetPos,
    }]];
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

function getPrimaryBattlePet(player = {}) {
  return getBattlePetList(player)[0] || null;
}

function getBattlePetList(player = {}) {
  return getBattlePets(player)
    .map((pet) => ({
      ...pet,
      id: Math.max(0, toSafeInt(pet.id, 0)),
      level: Math.max(1, toSafeInt(pet.level, 1)),
    }))
    .filter((pet) => pet.id > 0)
    .slice(0, 3);
}

function resolvePetBattleSkill(pet = null) {
  if (!pet || toSafeInt(pet.id, 0) <= 0) return null;
  const petSkillCfg = config.get('PetSkillConfig') || {};
  const rows = petSkillCfg[pet.id] || petSkillCfg[String(pet.id)] || null;
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return null;
  const petLevel = Math.max(1, toSafeInt(pet.level, 1));
  const picked = Object.keys(rows)
    .map((key) => rows[key])
    .filter((row) => row && typeof row === 'object')
    .sort((a, b) => Math.max(1, toSafeInt(a.petLevel, 1)) - Math.max(1, toSafeInt(b.petLevel, 1)))
    .reduce((best, row) => (
      Math.max(1, toSafeInt(row.petLevel, 1)) <= petLevel ? row : best
    ), null);
  if (!picked) return null;
  return resolveBattleActionIds(
    Math.max(1, toSafeInt(picked.skill, 0)),
    DEFAULT_PLAYER_SKILL_ID,
    DEFAULT_PLAYER_BEHAVIOR_ID,
  );
}

function buildHealEvent(casterPos, targetPos, value) {
  const healValue = Math.max(0, toSafeInt(value, 0));
  if (healValue <= 0) return null;
  return {
    typ: 7,
    i: 0,
    c: casterPos,
    t: targetPos,
    as: [11],
    vs: { 1: healValue },
  };
}

function buildRecoverValueEvent(casterPos, targetPos, value) {
  const healValue = Math.max(0, toSafeInt(value, 0));
  if (healValue <= 0) return null;
  return {
    typ: 9,
    i: 0,
    c: casterPos,
    t: targetPos,
    as: [0],
    vs: { 1: healValue },
  };
}

function buildBuffHintEvent(targetPos, buffType, stack = 1) {
  const safeType = Math.max(0, toSafeInt(buffType, 0));
  if (safeType <= 0) return null;
  return {
    typ: 4,
    i: 1060041,
    c: targetPos,
    t: targetPos,
    as: [safeType, Math.max(1, toSafeInt(stack, 1))],
  };
}

function buildChapterFightEvents(level, monster, playerAttrs, monsterAttrs, result, options = {}) {
  const rounds = Array.isArray(result && result.rounds) ? result.rounds : [];
  if (rounds.length <= 0) return [];

  const playerSkill = resolvePlayerBattleSkill(options && options.player);
  const battlePetSkills = (Array.isArray(result && result.battlePets) ? result.battlePets.slice(0, 1) : [])
    .map((pet, index) => ({
      pos: PET_BATTLE_POS + index,
      skill: resolvePetBattleSkill(pet),
    }))
    .filter((row) => row.skill);
  const monsterSkillSeed = options && options.enemyAsPlayer
    ? DEFAULT_PLAYER_SKILL_ID
    : (Array.isArray(monster && monster.fightSkill) ? monster.fightSkill : [])
    .map((id) => Math.max(0, toSafeInt(id, 0)))
    .find((id) => id > 0)
    || Math.max(0, toSafeInt(monster && monster.monsterShow, DEFAULT_MONSTER_SKILL_ID))
    || DEFAULT_MONSTER_SKILL_ID;
  const monsterSkill = options && options.enemyAsPlayer
    ? resolvePlayerBattleSkill(options.enemyPlayer)
    : resolveBattleActionIds(
      monsterSkillSeed,
      DEFAULT_MONSTER_SKILL_ID,
      DEFAULT_MONSTER_BEHAVIOR_ID,
    );
  const playerFirst = getAttrValue(playerAttrs, 4, ['spd'], 100) >= getAttrValue(monsterAttrs, 4, ['spd'], 100);
  let livePlayerHp = Math.max(1, getAttrValue(playerAttrs, 1, ['hp', 'maxHp'], 100));
  let liveMonsterHp = Math.max(1, getAttrValue(monsterAttrs, 1, ['hp', 'maxHp'], 100));

  const events = [{
    typ: 0,
    i: 0,
    c: 0,
    t: 0,
    es: [],
  }];

  rounds.forEach((round, index) => {
    const turnEvent = {
      typ: 0,
      i: Math.max(1, toSafeInt(round && round.round, index + 1)),
      c: 0,
      t: 0,
      es: [],
    };

    const roundActions = Array.isArray(round && round.actions) ? round.actions : [];
    const fallbackActions = [];
    if (roundActions.length <= 0) {
      if (playerFirst) {
        fallbackActions.push({ kind: 'attack', caster: 'player', target: 'monster', damage: round && round.playerDmg, crit: round && round.playerCrit, targetHp: round && round.monsterHP });
        fallbackActions.push({ kind: 'attack', caster: 'monster', target: 'player', damage: round && round.monsterDmg, crit: round && round.monsterCrit, targetHp: round && round.playerHP });
      } else {
        fallbackActions.push({ kind: 'attack', caster: 'monster', target: 'player', damage: round && round.monsterDmg, crit: round && round.monsterCrit, targetHp: round && round.playerHP });
        fallbackActions.push({ kind: 'attack', caster: 'player', target: 'monster', damage: round && round.playerDmg, crit: round && round.playerCrit, targetHp: round && round.monsterHP });
      }
    }

    const actionList = roundActions.length > 0 ? roundActions : fallbackActions;
    actionList.forEach((battleAction) => {
      if (!battleAction || typeof battleAction !== 'object') return;
      if (battleAction.kind === 'skip') {
        const stunEvent = buildBuffHintEvent(battleAction.caster === 'player' ? 1 : -1, 1, 1);
        if (stunEvent) turnEvent.es.push([stunEvent]);
        return;
      }
      if (battleAction.kind === 'evade') {
        const evadeEvent = buildBuffHintEvent(battleAction.caster === 'player' ? 1 : -1, 20, 1);
        if (evadeEvent) turnEvent.es.push([evadeEvent]);
        return;
      }

      const isPlayerCaster = battleAction.caster === 'player';
      const casterPos = isPlayerCaster ? 1 : -1;
      const targetPos = battleAction.target === 'player' ? 1 : -1;
      const skillDef = isPlayerCaster ? playerSkill : monsterSkill;

      if (battleAction.kind === 'heal') {
        const healEvent = buildHealEvent(casterPos, targetPos, battleAction.value);
        const valueEvent = buildRecoverValueEvent(casterPos, targetPos, battleAction.value);
        if (targetPos === 1) livePlayerHp += Math.max(0, toSafeInt(battleAction.value, 0));
        if (targetPos === -1) liveMonsterHp += Math.max(0, toSafeInt(battleAction.value, 0));
        const eventGroup = [];
        if (healEvent) eventGroup.push(healEvent);
        if (valueEvent) eventGroup.push(valueEvent);
        if (eventGroup.length > 0) turnEvent.es.push(eventGroup);
        return;
      }

      if (battleAction.kind === 'attack' || battleAction.kind === 'counter') {
        const targetLiveHp = targetPos === 1 ? livePlayerHp : liveMonsterHp;
        if (targetLiveHp <= 0) return;
        const desiredTargetHp = Math.max(0, toSafeInt(battleAction.targetHp, targetLiveHp));
        if (isPlayerCaster && battleAction.kind === 'attack' && battlePetSkills.length > 0) {
          const petDamage = Math.max(1, Math.floor(Math.max(1, toSafeInt(battleAction.damage, 1)) * 0.25));
          battlePetSkills.forEach((petSkill) => {
            const currentPetTargetHp = targetPos === 1 ? livePlayerHp : liveMonsterHp;
            if (currentPetTargetHp <= 0) return;
            const petAction = buildSkillEvent(
              petSkill.skill.skillId,
              petSkill.skill.behaviorId,
              petSkill.pos,
              targetPos,
              petDamage,
              Math.max(1, currentPetTargetHp - petDamage),
            );
            if (petAction) turnEvent.es.push([petAction]);
          });
        }
        const currentTargetHp = targetPos === 1 ? livePlayerHp : liveMonsterHp;
        if (currentTargetHp <= 0) return;
        const effectiveDamage = Math.max(1, currentTargetHp - desiredTargetHp, toSafeInt(battleAction.damage, 1));
        const targetHpAfterHit = desiredTargetHp;
        if (targetPos === 1) livePlayerHp = targetHpAfterHit;
        if (targetPos === -1) liveMonsterHp = targetHpAfterHit;
        const action = buildSkillEvent(
          skillDef.skillId,
          skillDef.behaviorId,
          casterPos,
          targetPos,
          effectiveDamage,
          targetHpAfterHit,
        );
        if (!action) return;
        const damageAction = action.es && action.es[0] && action.es[0][0] && action.es[0][0].es && action.es[0][0].es[0] && action.es[0][0].es[0][0]
          ? action.es[0][0].es[0][0]
          : null;
        if (damageAction) {
          damageAction.as = [battleAction.crit ? 1 : 0];
        }
        const extraEvents = [];
        if (battleAction.kind === 'counter') {
          const counterEvent = buildBuffHintEvent(casterPos, 44, 1);
          if (counterEvent) extraEvents.push(counterEvent);
        }
        if (battleAction.stun) {
          const stunEvent = buildBuffHintEvent(targetPos, 1, 1);
          if (stunEvent) extraEvents.push(stunEvent);
        }
        if (battleAction.kind === 'attack' && battleAction.combo) {
          const comboEvent = buildBuffHintEvent(casterPos, 10, 1);
          if (comboEvent) extraEvents.push(comboEvent);
        }
        turnEvent.es.push([action]);
        if (extraEvents.length > 0) {
          turnEvent.es.push(extraEvents);
        }
        return;
      }

      if (battleAction.kind === 'stun') {
        const stunEvent = buildBuffHintEvent(targetPos, 1, 1);
        if (stunEvent) turnEvent.es.push([stunEvent]);
      }
    });

    if (turnEvent.es.length > 0) {
      events.push(turnEvent);
    }
  });

  return events;
}

async function loadDuelTargetPlayer(targetId) {
  const playerId = String(targetId || '').trim();
  if (!playerId) return null;
  if (typeof playerService.findByDbidOrPlayerId === 'function') {
    const found = await playerService.findByDbidOrPlayerId(playerId);
    if (found) return found;
  }
  if (typeof playerService.findByPlayerId === 'function') {
    return playerService.findByPlayerId(playerId);
  }
  return null;
}

function sumRoundDamage(rounds = [], key) {
  return (Array.isArray(rounds) ? rounds : []).reduce((sum, round) => (
    sum + Math.max(0, toSafeInt(round && round[key], 0))
  ), 0);
}

async function handlePlayerDuelFight(params, session, msgUid) {
  const player = session && session.player;
  const targetId = String((params && (params.enemyid || params.targetId || params.playerId)) || '').trim();
  if (!player || !targetId) {
    return { tag: 2300, msgUid, data: { result: -1, enemyid: targetId } };
  }

  const targetPlayer = await loadDuelTargetPlayer(targetId);
  if (!targetPlayer) {
    return { tag: 2300, msgUid, data: { result: -1, enemyid: targetId } };
  }

  const playerAttrs = battle.calcPlayerPower(player);
  const targetAttrs = battle.calcPlayerPower(targetPlayer);
  const result = battle.simulateBattle(playerAttrs, targetAttrs, { isPvp: true });
  const playerHpMax = Math.max(1, getAttrValue(playerAttrs, 1, ['hp', 'maxHp'], 100));
  const targetHpMax = Math.max(1, getAttrValue(targetAttrs, 1, ['hp', 'maxHp'], 100));
  const playerShowInfo = buildRaidPlayerShowInfo(player, battle.calcPowerScore ? battle.calcPowerScore(playerAttrs || {}) : 0);
  const targetShowInfo = buildRaidPlayerShowInfo(targetPlayer, battle.calcPowerScore ? battle.calcPowerScore(targetAttrs || {}) : 0);
  const targetDbid = String(targetPlayer.playerId || targetPlayer._id || targetId);

  const fightResult = {
    type: PLAYER_DUEL_FIGHT_TYPE,
    win: result && result.win ? 1 : 0,
    mustChangeTurn: 0,
    notChangeTurn: 1,
    atkAttr: playerAttrs || {},
    defAttr: targetAttrs || {},
    damage: {
      1: sumRoundDamage(result && result.rounds, 'playerDmg'),
      '-1': sumRoundDamage(result && result.rounds, 'monsterDmg'),
    },
    isBackFight: false,
    events: buildChapterFightEvents(null, null, playerAttrs, targetAttrs, result, {
      player,
      enemyPlayer: targetPlayer,
      enemyAsPlayer: true,
    }),
    entitys: [
      applyPrimaryBattlePetParts({
        id: Math.max(1, toSafeInt(playerShowInfo.kungfuId, 4)),
        dbid: String(player.playerId || player.userId || 'duel_self'),
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
        showInfo: playerShowInfo,
        parts: {},
        partValues: {},
      }, player),
      applyPrimaryBattlePetParts({
        id: Math.max(1, toSafeInt(targetShowInfo.kungfuId, 4)),
        dbid: targetDbid,
        name: String(targetPlayer.name || 'Player'),
        type: 1,
        side: 2,
        camp: 2,
        pos: -1,
        posIndex: -1,
        hp: targetHpMax,
        maxhp: targetHpMax,
        maxHp: targetHpMax,
        vars: buildFightVars(targetHpMax),
        showInfo: targetShowInfo,
        parts: {},
        partValues: {},
      }, targetPlayer),
    ],
    guildBossAllDamage: 0,
    bloodlineOffset: 0,
  };

  session.lastBattle = { levelId: 0, result, level: null, fightResult, type: PLAYER_DUEL_FIGHT_TYPE };
  return {
    tag: 2300,
    msgUid,
    data: {
      result: 0,
      enemyid: targetDbid,
      fightResult,
      win: result && result.win ? 1 : 0,
      rounds: result && result.totalRounds,
      battleLog: Array.isArray(result && result.rounds) ? result.rounds : [],
    },
  };
}

function buildFixedMainlinePlaybackResult(playerAttrs = {}, monsterAttrs = {}, result = {}) {
  const maxPlaybackRounds = MAINLINE_PLAYBACK_ROUNDS;
  const playerMaxHP = Math.max(1, getAttrValue(playerAttrs, 1, ['hp', 'maxHp'], 100));
  const monsterMaxHP = Math.max(1, getAttrValue(monsterAttrs, 1, ['hp', 'maxHp'], 100));
  const playerAtk = Math.max(1, getAttrValue(playerAttrs, 2, ['atk'], 10));
  const monsterAtk = Math.max(1, getAttrValue(monsterAttrs, 2, ['atk'], 8));
  const playerFirst = getAttrValue(playerAttrs, 4, ['spd'], 100) >= getAttrValue(monsterAttrs, 4, ['spd'], 100);
  const sourceRounds = Array.isArray(result && result.rounds) ? result.rounds : [];
  const minPlayerMonsterDamage = battle && typeof battle.calcPowerScore === 'function'
    && battle.calcPowerScore(playerAttrs || {}) > battle.calcPowerScore(monsterAttrs || {})
    ? Math.max(1, Math.ceil(monsterMaxHP * 0.07))
    : 0;
  const win = result && result.win !== false;
  const winnerMaxHP = win ? playerMaxHP : monsterMaxHP;
  const requestedWinnerLeft = Math.max(0, toSafeInt(win ? result.playerHPLeft : result.monsterHPLeft, 0));
  const fallbackWinnerLeft = Math.max(1, Math.floor(winnerMaxHP * 0.55));
  const winnerFinalHP = Math.max(
    1,
    Math.min(winnerMaxHP - 1, requestedWinnerLeft > 0 ? requestedWinnerLeft : fallbackWinnerLeft)
  );
  let playerHP = playerMaxHP;
  let monsterHP = monsterMaxHP;
  const rounds = [];
  const actualRoundCount = Math.max(
    0,
    sourceRounds.length > 0
      ? sourceRounds.length
      : toSafeInt(result && result.totalRounds, 0)
  );
  const endedByHpZero = toSafeInt(result && result.playerHPLeft, playerMaxHP) <= 0
    || toSafeInt(result && result.monsterHPLeft, monsterMaxHP) <= 0;
  const estimatedPlayerDamage = Math.max(
    1,
    minPlayerMonsterDamage,
    Math.floor(playerAtk * 0.15),
    sourceRounds.length > 0 ? Math.ceil(sumRoundDamage(sourceRounds, 'playerDmg') / sourceRounds.length) : 0,
  );
  const estimatedMonsterDamage = Math.max(
    1,
    Math.floor(monsterAtk * 0.15),
    sourceRounds.length > 0 ? Math.ceil(sumRoundDamage(sourceRounds, 'monsterDmg') / sourceRounds.length) : 0,
  );
  const estimatedRoundCount = win
    ? Math.ceil(monsterMaxHP / estimatedPlayerDamage)
    : Math.ceil(playerMaxHP / estimatedMonsterDamage);
  const targetRounds = Math.max(
    1,
    Math.min(
      maxPlaybackRounds,
      endedByHpZero && actualRoundCount > 0 ? actualRoundCount : estimatedRoundCount,
    )
  );

  const makeAttack = (caster, damage, targetHp) => ({
    kind: 'attack',
    caster,
    target: caster === 'player' ? 'monster' : 'player',
    damage: Math.max(0, toSafeInt(damage, 0)),
    crit: false,
    combo: false,
    targetHp: Math.max(0, toSafeInt(targetHp, 0)),
  });

  const applyPlayerAttack = (round, isFinal = false) => {
    const scheduledTargetHp = isFinal && win
      ? 0
      : Math.max(
        win ? 1 : winnerFinalHP,
        Math.ceil(monsterMaxHP - ((monsterMaxHP - (win ? 0 : winnerFinalHP)) * round) / targetRounds)
      );
    const minTargetHp = isFinal && win ? 0 : (win ? 1 : winnerFinalHP);
    const desiredDamage = Math.max(
      1,
      monsterHP - scheduledTargetHp,
      Math.floor(playerAtk * 0.15),
      minPlayerMonsterDamage,
    );
    const damage = desiredDamage;
    monsterHP = Math.max(minTargetHp, monsterHP - damage);
    return makeAttack('player', damage, monsterHP);
  };

  const applyMonsterAttack = (round, isFinal = false) => {
    const targetHp = isFinal && !win
      ? 0
      : Math.max(
        win ? winnerFinalHP : 1,
        Math.ceil(playerMaxHP - ((playerMaxHP - (win ? winnerFinalHP : 0)) * round) / targetRounds)
      );
    const damage = Math.max(1, playerHP - targetHp, Math.floor(monsterAtk * 0.15));
    playerHP = Math.max(targetHp, playerHP - damage);
    return makeAttack('monster', damage, playerHP);
  };

  for (let round = 1; round <= targetRounds; round += 1) {
    const isFinal = round === targetRounds;
    const actions = [];

    if (isFinal) {
      if (win) {
        actions.push(applyMonsterAttack(round, false));
        actions.push(applyPlayerAttack(round, true));
      } else {
        actions.push(applyPlayerAttack(round, false));
        actions.push(applyMonsterAttack(round, true));
      }
    } else if (playerFirst) {
      actions.push(applyPlayerAttack(round, false));
      actions.push(applyMonsterAttack(round, false));
    } else {
      actions.push(applyMonsterAttack(round, false));
      actions.push(applyPlayerAttack(round, false));
    }

    rounds.push({
      round,
      playerHP: Math.max(0, Math.floor(playerHP)),
      monsterHP: Math.max(0, Math.floor(monsterHP)),
      playerDmg: actions.filter((action) => action.caster === 'player').reduce((sum, action) => sum + action.damage, 0),
      monsterDmg: actions.filter((action) => action.caster === 'monster').reduce((sum, action) => sum + action.damage, 0),
      playerCrit: false,
      monsterCrit: false,
      playerEvade: false,
      monsterEvade: false,
      playerCombo: false,
      monsterCombo: false,
      playerCounter: false,
      monsterCounter: false,
      playerHeal: 0,
      monsterHeal: 0,
      playerStun: false,
      monsterStun: false,
      actions,
    });

    if (playerHP <= 0 || monsterHP <= 0) {
      break;
    }
  }

  return {
    ...(result || {}),
    win,
    star: win ? Math.max(1, toSafeInt(result && result.star, 3)) : 0,
    rounds,
    totalRounds: rounds.length,
    playerHPLeft: Math.max(0, Math.floor(playerHP)),
    monsterHPLeft: Math.max(0, Math.floor(monsterHP)),
  };
}

function enforceMainlinePowerAdvantage(playerAttrs = {}, monsterAttrs = {}, result = {}) {
  if (!result || result.win) return result;
  if (battle && typeof battle.enforcePvePowerAdvantage === 'function') {
    return battle.enforcePvePowerAdvantage(playerAttrs, monsterAttrs, result);
  }
  if (!battle || typeof battle.calcPowerScore !== 'function') return result;

  const playerPower = Math.max(0, toSafeInt(battle.calcPowerScore(playerAttrs || {}), 0));
  const monsterPower = Math.max(0, toSafeInt(battle.calcPowerScore(monsterAttrs || {}), 0));
  if (playerPower <= 0) return result;

  // Mainline UI is power-gated; lower-power monsters should not beat the player.
  if (monsterPower > 0 && playerPower < monsterPower) return result;

  return {
    ...result,
    win: true,
    star: Math.max(1, toSafeInt(result.star, 1)),
    playerHPLeft: Math.max(
      1,
      toSafeInt(result.playerHPLeft, 0),
      Math.floor(Math.max(1, getAttrValue(playerAttrs, 1, ['hp', 'maxHp'], 100)) * 0.35)
    ),
    monsterHPLeft: 0,
    powerScore: playerPower,
  };
}

function shouldApplyPvePowerAdvantage(fightType) {
  return [1, 4, 6, 9].includes(Math.max(1, toSafeInt(fightType, 1)));
}

function buildPveProgressFightResult(playerAttrs = {}, monsterAttrs = {}, simulatedResult = {}, fightType = 1) {
  const guardedResult = shouldApplyPvePowerAdvantage(fightType)
    ? enforceMainlinePowerAdvantage(playerAttrs, monsterAttrs, simulatedResult)
    : simulatedResult;
  return buildFixedMainlinePlaybackResult(playerAttrs, monsterAttrs, guardedResult);
}

function buildChapterFightResult(player, level, playerAttrs, monsterAttrs, result, fightType = 1) {
  const monsterCfg = config.get('MonsterConfig');
  const monster = monsterCfg
    ? (monsterCfg[level.monsterId] || monsterCfg[String(level.monsterId)] || null)
    : null;
  const playerId = String(player.playerId || player.userId || 'raid_self');
  const playerHpMax = Math.max(1, getAttrValue(playerAttrs, 1, ['hp', 'maxHp'], 100));
  const monsterHpMax = Math.max(1, getAttrValue(monsterAttrs, 1, ['hp', 'maxHp'], 100));
  const playerHpLeft = Math.max(0, toSafeInt(result && result.playerHPLeft, playerHpMax));
  const monsterHpLeft = Math.max(0, toSafeInt(result && result.monsterHPLeft, monsterHpMax));
  const playerPower = Math.max(0, toSafeInt(result && result.powerScore, 0));
  const battlePets = getBattlePetList(player);
  const primaryPet = battlePets[0] || getPrimaryBattlePet(player);
  const primaryPetId = Math.max(0, toSafeInt(primaryPet && primaryPet.id, toSafeInt(getPrimaryBattlePetId(player), 0)));
  if (result && typeof result === 'object') {
    result.primaryPetId = primaryPetId;
    result.primaryPet = primaryPet;
    result.battlePets = battlePets;
  }

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
    showInfo: buildRaidPlayerShowInfo(player, playerPower),
    parts: {},
    partValues: {},
  }, player);

  return {
    type: Math.max(1, toSafeInt(fightType, 1)),
    win: result && result.win ? 1 : 0,
    atkAttr: playerAttrs || {},
    defAttr: monsterAttrs || {},
    damage: {
      1: Math.max(0, monsterHpMax - monsterHpLeft),
      '-1': Math.max(0, playerHpMax - playerHpLeft),
    },
    isBackFight: false,
    events: buildChapterFightEvents(level, monster, playerAttrs, monsterAttrs, result, { player }),
    entitys: [
      selfEntity,
      {
        id: Math.max(1, toSafeInt(level && level.monsterId, 1)),
        dbid: `monster_${Math.max(1, toSafeInt(level && level.monsterId, 1))}`,
        name: String((monster && monster.monsterName) || level.name || 'Monster'),
        type: 2,
        side: 2,
        camp: 2,
        pos: -1,
        posIndex: -1,
        hp: monsterHpMax,
        maxhp: monsterHpMax,
        maxHp: monsterHpMax,
        vars: buildFightVars(monsterHpMax),
        parts: {},
        partValues: {},
      },
    ],
    guildBossAllDamage: 0,
    bloodlineOffset: 0,
  };
}

function getDemonInvasionRewards() {
  return DEFAULT_DEMON_INVASION_REWARDS.map((row) => ({ ...row }));
}

function buildDemonInvasionLevel(params = {}) {
  const requestedId = Math.max(0, toSafeInt(
    params && (params.enemyid != null ? params.enemyid : params.enemyId),
    0
  ));
  const monsterId = requestedId > 0 ? requestedId : DEMON_INVASION_MONSTER_ID;
  return {
    id: monsterId,
    name: 'demon_invasion',
    monsterId,
    reward: getDemonInvasionRewards(),
    fightType: DEMON_INVASION_FIGHT_TYPE,
  };
}

function buildDemonInvasionMonsterAttrs(playerAttrs = {}) {
  const playerHp = Math.max(1, getAttrValue(playerAttrs, 1, ['hp', 'maxHp'], 1000));
  const playerAtk = Math.max(1, getAttrValue(playerAttrs, 2, ['atk'], 200));
  return {
    1: Math.max(1000000, playerHp * 200),
    2: Math.max(1, Math.floor(playerHp * 0.1)),
    3: Math.max(0, Math.floor(playerAtk * 0.6)),
    4: Math.max(1, getAttrValue(playerAttrs, 4, ['spd'], 100) + 1),
  };
}

async function handleDemonInvasionFight(params, session, msgUid) {
  const player = session.player;
  const level = buildDemonInvasionLevel(params);
  const playerAttrs = battle.calcPlayerPower(player);
  const monsterAttrs = buildDemonInvasionMonsterAttrs(playerAttrs);
  const result = battle.simulateBattle(playerAttrs, monsterAttrs, { enforcePlayerMonsterMinDamage: true });
  const fightResult = buildChapterFightResult(
    player,
    level,
    playerAttrs,
    monsterAttrs,
    result,
    DEMON_INVASION_FIGHT_TYPE
  );
  const { rewardInfo, syncRewards } = grantRewardInfo(player, level.reward);
  const taskChanged = !!addCrossRivalChallengeCount(player, 1);
  session.lastBattle = null;

  if (session.userId) {
    await playerService.savePlayer(session.userId, player);
  }

  const packets = [
    {
      tag: 1202,
      msgUid: 0,
      data: {
        items: syncRewards.map((row) => ({
          id: Math.max(0, toSafeInt(row && row.id, 0)),
          count: Math.max(0, toSafeInt(row && row.count, 0)),
        })).filter((row) => row.id > 0 && row.count > 0),
      },
    },
  ];
  if (taskChanged) {
    packets.push(...buildTaskSyncPackets(player));
  }
  packets.push({
    tag: 2300,
    msgUid,
    data: {
      rewardInfo,
      fightResult,
    },
  });
  return packets;
}

async function handleTowerStartFight(params, session, msgUid) {
  const player = session.player;
  // eslint-disable-next-line global-require
  const tower = require('./tower');
  const towerInfo = tower.ensureTowerInfo(player);
  const towerCfg = config.get('TowerConfig') || {};
  const requestedLevel = Math.max(0, toSafeInt(params && params.levelId, 0));
  const floor = requestedLevel > 0 ? requestedLevel : towerInfo.curlayer + 1;
  const row = towerCfg[floor] || towerCfg[String(floor)] || null;
  if (!row) return { tag: 2300, msgUid, data: { result: -1, msg: 'invalid tower layer' } };

  const monsterId = Math.max(1, toSafeInt(row.monsterId, 300001));
  const level = {
    id: floor,
    name: `tower_${floor}`,
    monsterId,
    reward: Array.isArray(row.rewards) ? row.rewards : [],
  };
  const playerAttrs = battle.calcPlayerPower(player);
  const monsterAttrs = battle.getMonsterAttrs(monsterId);
  const simulatedResult = battle.simulateBattle(playerAttrs, monsterAttrs, { enforcePlayerMonsterMinDamage: true });
  const result = buildPveProgressFightResult(playerAttrs, monsterAttrs, simulatedResult, 9);
  const fightResult = buildChapterFightResult(player, level, playerAttrs, monsterAttrs, result, 9);

  const rewards = [];
  if (result.win) {
    towerInfo.curlayer = Math.max(towerInfo.curlayer, floor);
    if (floor > towerInfo.maxlayer) {
      towerInfo.maxlayer = floor;
      if (Array.isArray(row.firstRewards)) rewards.push(...row.firstRewards.map((reward) => ({ ...reward })));
    }
    if (Array.isArray(row.rewards)) rewards.push(...row.rewards.map((reward) => ({ ...reward })));
    towerInfo.score = Math.max(0, toSafeInt(towerInfo.score, 0)) + floor * 10;
    towerInfo.dailyCount = Math.max(0, toSafeInt(towerInfo.dailyCount, 0)) + 1;
    if (typeof tower.grantTowerSkillChoice === 'function') {
      tower.grantTowerSkillChoice(towerInfo, floor);
    }
  }

  const { rewardInfo, syncRewards } = grantRewardInfo(player, rewards);
  const updateInfo = {
    maxlayer: towerInfo.maxlayer,
    curlayer: towerInfo.curlayer,
    skills: towerInfo.skills,
    skillCount: towerInfo.skillCount,
    slotlist: towerInfo.slotlist,
  };
  const taskChanged = result.win ? !!addTempleChallengeCount(player, 1) : false;
  session.lastBattle = null;
  if (session.userId) await playerService.savePlayer(session.userId, player);

  const packets = [];
  if (syncRewards.length > 0) {
    packets.push({ tag: 1202, msgUid: 0, data: buildRewardItemSync(player, syncRewards) });
  }
  if (taskChanged) packets.push(...buildTaskSyncPackets(player));
  packets.push({
    tag: 2300,
    msgUid,
    data: {
      result: 0,
      id: floor,
      rewards,
      rewardInfo,
      updateInfo,
      fightResult,
    },
  });
  return packets;
}

// ========== reward helpers ==========

/**
 * Add role exp and immediately reconcile level-up.
 */
function addExpToPlayer(player, count) {
  const delta = Math.max(0, toSafeInt(count, 0));
  if (delta <= 0) return;
  player.exp = Math.max(0, toSafeInt(player.exp, 0)) + delta;
  checkLevelUp(player);
}

/**
 * Add reward by item id mapping.
 * 1=yuanbao(diamond), 2=silver, 3=exp, 4=baozi, 6=speed-token(gold), others=item bag.
 */
function addRewardToPlayer(player, itemId, count) {
  const safeCount = Math.max(0, toSafeInt(count, 0));
  const safeItemId = toSafeInt(itemId, 0);
  if (safeCount <= 0 || safeItemId <= 0) return;

  if (isEquipTemplateItem(safeItemId)) {
    for (let i = 0; i < safeCount; i += 1) {
      const equip = createEquipFromTemplateId(safeItemId, player && player.level, player);
      addOpenEquip(player, equip);
    }
    return;
  }

  player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
  player.items = player.items || {};

  switch (safeItemId) {
    case 1:
      player.currencies.diamond = Math.max(0, toSafeInt(player.currencies.diamond, 0)) + safeCount;
      break;
    case 2:
      player.currencies.silver = Math.max(0, toSafeInt(player.currencies.silver, 0)) + safeCount;
      break;
    case 3:
      addExpToPlayer(player, safeCount);
      break;
    case 4:
      player.items[4] = Math.max(0, toSafeInt(player.items[4], 0)) + safeCount;
      refreshRealmStageTasks(player);
      refreshMainTaskProgress(player);
      break;
    case 6:
      player.currencies.gold = Math.max(0, toSafeInt(player.currencies.gold, 0)) + safeCount;
      break;
    default:
      player.items[safeItemId] = Math.max(0, toSafeInt(player.items[safeItemId], 0)) + safeCount;
      break;
  }
}

function resolveStageIdForLevel(level, stageCfg = {}) {
  const safeLevel = Math.max(1, toSafeInt(level, 1));
  let pickedId = 1;
  let pickedMax = Number.MAX_SAFE_INTEGER;

  Object.keys(stageCfg).forEach((key) => {
    const row = stageCfg[key] || stageCfg[String(key)] || null;
    const max = Math.max(0, toSafeInt(row && row.levelMax, 0));
    if (max < safeLevel || max >= pickedMax) return;
    pickedMax = max;
    pickedId = Math.max(1, toSafeInt(key, 1));
  });

  return pickedId;
}

/**
 * Repair legacy rows whose level is already above the recorded stage cap.
 * Normal progression must never advance stage here; tag=3103 owns breakthroughs.
 */
function normalizeRoleStageForLevel(player) {
  player.roleInfo = player.roleInfo || {};
  const level = Math.max(1, toSafeInt(player.level, 1));
  const stageCfg = config.get('RoleStageConfig') || {};
  const stageId = Math.max(1, toSafeInt(player.roleInfo.stageId || player.roleInfo.stage, 1));
  const stageRow = stageCfg[stageId] || stageCfg[String(stageId)] || null;
  const currentMax = Math.max(0, toSafeInt(stageRow && stageRow.levelMax, 0));
  if (currentMax >= level) return false;

  const nextStageId = resolveStageIdForLevel(level, stageCfg);
  player.roleInfo.stageId = nextStageId;
  player.roleInfo.stage = nextStageId;
  return true;
}

/**
 * Reconcile level-up with stage cap (RoleStageConfig.levelMax).
 */
function checkLevelUp(player) {
  player.level = Math.max(1, toSafeInt(player.level, 1));
  player.exp = Math.max(0, toSafeInt(player.exp, 0));
  player.roleInfo = player.roleInfo || {};
  if (player.roleInfo.stage == null) {
    player.roleInfo.stage = toSafeInt(player.roleInfo.stageId, 1) || 1;
  }
  if (player.roleInfo.stageId == null) {
    player.roleInfo.stageId = toSafeInt(player.roleInfo.stage, 1) || 1;
  }
  if (player.roleInfo.stageFailedTime == null) {
    player.roleInfo.stageFailedTime = 0;
  }

  syncExpItem(player);
  normalizeRoleStageForLevel(player);

  const roleLevelCfg = config.get('RoleLevelConfig');
  if (!roleLevelCfg) return;

  const stageCfg = config.get('RoleStageConfig');

  let guard = 0;
  while (guard < 5000) {
    guard += 1;
    const level = Math.max(1, toSafeInt(player.level, 1));
    const cur = roleLevelCfg[level] || roleLevelCfg[String(level)];
    const needExp = Math.max(0, toSafeInt(cur && cur.exp, 0));
    if (needExp <= 0) break;

    const stageId = Math.max(1, toSafeInt(player.roleInfo.stageId || player.roleInfo.stage, 1));
    const stage = stageCfg ? (stageCfg[stageId] || stageCfg[String(stageId)]) : null;
    const maxLevel = stage ? toSafeInt(stage.levelMax, 9999) : 9999;

    if (level < maxLevel) {
      const curExp = toSafeInt(player.exp, 0);
      if (curExp < needExp) break;
      player.level = level + 1;
      player.exp = 0;
      if (player.items && typeof player.items === 'object' && !Array.isArray(player.items)) {
        delete player.items[3];
      }
      normalizeRoleStageForLevel(player);
      continue;
    }

    // Hold the exact required EXP at the stage cap. The client needs this
    // state to enable RealmView's breakthrough button.
    player.exp = Math.min(toSafeInt(player.exp, 0), needExp);
    break;
  }

  syncExpItem(player);
  refreshMainTaskProgress(player);
  refreshRealmStageTasks(player);
}

function consumeFightBagel(player) {
  const cost = Math.max(0, toSafeInt(process.env.RAID_BAOZI_COST, 1));
  if (cost <= 0) return { ok: true, cost: 0 };

  player.items = player.items || {};
  const own = Math.max(0, toSafeInt(player.items[4], 0));
  if (own < cost) {
    return { ok: false, cost, own };
  }

  const left = own - cost;
  if (left > 0) player.items[4] = left;
  else delete player.items[4];
  addBagelConsume(player, cost);
  const taskChanged = !!addMainTaskBagelConsume(player, cost);
  return { ok: true, cost, own, left, taskChanged };
}

function getFallbackFightExp(levelId) {
  return Math.max(0, 50 + Math.max(1, toSafeInt(levelId, 1)) * 5);
}

/**
 * Advance chapter/level progression by ChapterConfig.levelList.
 */
function advanceLevel(player, clearedLevelId) {
  const chapterCfg = config.get('ChapterConfig');
  if (!chapterCfg) {
    player.raidInfo.level = clearedLevelId + 1;
    refreshMainTaskProgress(player);
    return;
  }

  const chapter = chapterCfg[player.raidInfo.chapter];
  if (!chapter) return;

  const levelList = chapter.levelList || [];
  const levelIdx = levelList.indexOf(clearedLevelId);

  if (levelIdx >= 0 && levelIdx === levelList.length - 1) {
    const maxChapter = Object.keys(chapterCfg).length;
    player.raidInfo.chapter = Math.min(player.raidInfo.chapter + 1, maxChapter);
    const nextChapter = chapterCfg[player.raidInfo.chapter];
    player.raidInfo.level = nextChapter ? nextChapter.levelList[0] : clearedLevelId + 1;
    // 挂机章节由玩家/客户端独立选择，不跟随主线推进自动覆盖。
    // 仅在玩家从未设置过（非法值）时用当前章节兜底。
    const hangUpChapter = toSafeInt(player.raidInfo.hangUpChapter, 0);
    if (hangUpChapter <= 0 || hangUpChapter > maxChapter) {
      player.raidInfo.hangUpChapter = player.raidInfo.chapter;
    }
  } else if (levelIdx >= 0 && levelIdx < levelList.length - 1) {
    player.raidInfo.level = levelList[levelIdx + 1];
  } else {
    player.raidInfo.level = clearedLevelId + 1;
  }

  refreshMainTaskProgress(player);
}

// ========== handlers ==========

async function handleStartFight(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 2300, msgUid, data: { result: -1 } };

  player.raidInfo = player.raidInfo || { chapter: 1, level: 1, hangUpChapter: 1, hangUpTime: Date.now() };
  const fightType = Math.max(1, toSafeInt(params && params.type, 1));
  if ([2, 3, 16, 17].includes(fightType)) {
    // Arena and cross-arena challenges share tag 2300 and branch by fight type in the client.
    // eslint-disable-next-line global-require
    const arena = require('./arena');
    return arena.handleArenaFight2300(params, session, msgUid);
  }
  if (fightType === 10) {
    // TopCombat has its own rank state and response contract on tag 2300.
    // eslint-disable-next-line global-require
    const arena = require('./arena');
    return arena.handleTopCombatStartFight(params, session, msgUid);
  }
  if (fightType === PLAYER_DUEL_FIGHT_TYPE) {
    return handlePlayerDuelFight(params, session, msgUid);
  }
  if (fightType === DEMON_INVASION_FIGHT_TYPE) {
    return handleDemonInvasionFight(params, session, msgUid);
  }
  if (fightType === 9) {
    return handleTowerStartFight(params, session, msgUid);
  }
  let levelId = params.levelId || player.raidInfo.level || 1;
  let level = null;

  if (fightType === 4) {
    const demonBossCfg = config.get('DemonBossConfig') || {};
    const stage = Math.max(1, toSafeInt(player.raidInfo && player.raidInfo.demonBossInfo && player.raidInfo.demonBossInfo.stage, 1)) + 1;
    const bossRow = demonBossCfg[stage] || demonBossCfg[String(stage)] || null;
    if (!bossRow) {
      return { tag: 2300, msgUid, data: { result: -1, msg: 'invalid demon boss stage' } };
    }
    levelId = stage;
    level = {
      id: stage,
      name: `demon_boss_${stage}`,
      monsterId: bossRow.monsterId,
      reward: Array.isArray(bossRow.rewards) ? bossRow.rewards : [],
      demonBossStage: stage,
      fightType,
    };
  } else if (fightType === 6) {
    const levelCfg = config.get('LevelConfig') || {};
    const fallbackLevel = levelCfg[levelId] || levelCfg[String(levelId)] || Object.values(levelCfg)[0] || {};
    const monsterCfg = config.get('MonsterConfig') || {};
    const firstMonsterId = Object.keys(monsterCfg).map((key) => toSafeInt(key, 0)).filter((id) => id > 0).sort((a, b) => a - b)[0] || 100101;
    level = {
      id: levelId,
      name: 'guild_hunting_boss',
      monsterId: Math.max(1, toSafeInt(fallbackLevel.monsterId, firstMonsterId)),
      reward: Array.isArray(fallbackLevel.reward) ? fallbackLevel.reward : [],
      fightType,
    };
  } else {
    const levelCfg = config.get('LevelConfig');
    level = levelCfg ? levelCfg[levelId] : null;
  }

  if (!level) return { tag: 2300, msgUid, data: { result: -1, msg: 'invalid level' } };

  const bagelCost = consumeFightBagel(player);
  if (!bagelCost.ok) {
    return {
      tag: 2300,
      msgUid,
      data: {
        result: -1,
        msg: 'not enough baozi',
        need: bagelCost.cost,
        own: bagelCost.own,
      },
    };
  }

  const playerAttrs = battle.calcPlayerPower(player);
  const monsterAttrs = battle.getMonsterAttrs(level.monsterId);
  const simulatedResult = battle.simulateBattle(playerAttrs, monsterAttrs, { enforcePlayerMonsterMinDamage: true });
  const result = shouldApplyPvePowerAdvantage(fightType)
    ? buildPveProgressFightResult(playerAttrs, monsterAttrs, simulatedResult, fightType)
    : simulatedResult;
  const fightResult = buildChapterFightResult(player, level, playerAttrs, monsterAttrs, result, fightType);
  logger.info(
    `[Raid2300] start user=${session && session.userId ? session.userId : 'unknown'} `
    + `msgUid=${msgUid} levelId=${levelId} reqType=${fightType} `
    + `fightResultType=${toSafeInt(fightResult && fightResult.type, 0)} win=${!!(result && result.win)}`
  );
  if (fightType === 4) {
    logger.info(
      `[Raid2300] type=4 start user=${session && session.userId ? session.userId : 'unknown'} `
      + `msgUid=${msgUid} stage=${levelId} reqType=${fightType} fightResultType=${toSafeInt(fightResult && fightResult.type, 0)} `
      + `win=${!!(result && result.win)}`
    );
  }
  let taskChanged = !!bagelCost.taskChanged;
  if (fightType === 1) {
    taskChanged = !!addMainlineChallengeCount(player, 1) || taskChanged;
  } else if (fightType === 4) {
    taskChanged = !!addDungeonBossChallengeCount(player, 1) || taskChanged;
  } else if (fightType === 9) {
    taskChanged = !!addTempleChallengeCount(player, 1) || taskChanged;
  }

  session.lastBattle = { levelId, result, level, fightResult, type: fightType };
  logger.info(
    `[Raid2300] session user=${session && session.userId ? session.userId : 'unknown'} `
    + `msgUid=${msgUid} lastBattleType=${toSafeInt(session.lastBattle && session.lastBattle.type, 0)} `
    + `lastBattleFightType=${toSafeInt(session.lastBattle && session.lastBattle.fightResult && session.lastBattle.fightResult.type, 0)}`
  );
  if (fightType === 4) {
    logger.info(
      `[Raid2300] type=4 session user=${session && session.userId ? session.userId : 'unknown'} `
      + `msgUid=${msgUid} lastBattleType=${toSafeInt(session.lastBattle && session.lastBattle.type, 0)} `
      + `lastBattleFightType=${toSafeInt(session.lastBattle && session.lastBattle.fightResult && session.lastBattle.fightResult.type, 0)}`
    );
  }
  scheduleRaidPlayerSave(session, player, '2300');

  const packets = [];
  if (taskChanged) {
    packets.push(...buildTaskSyncPackets(player));
  }
  if (fightType === 6) {
    try {
      // eslint-disable-next-line global-require
      const guild = require('./guild');
      if (guild && typeof guild.recordGuildHuntingChallenge === 'function') {
        packets.push(guild.recordGuildHuntingChallenge(player, fightResult && fightResult.damage && fightResult.damage[1]));
        if (session.userId) await playerService.savePlayer(session.userId, player);
      }
    } catch (_err) {}
  }
  packets.push({
    tag: 2300,
    msgUid,
    data: {
      id: levelId,
      fightResult,
    },
  });
  return packets;
}

async function handleClaimFightReward(_params, session, msgUid) {
  const player = session.player;
  const lastBattle = session.lastBattle;
  const requestType = Math.max(0, toSafeInt(_params && _params.type, toSafeInt(lastBattle && lastBattle.type, 0)));
  logger.info(
    `[Raid2301] entry user=${session && session.userId ? session.userId : 'unknown'} `
    + `msgUid=${msgUid} reqType=${requestType} hasLastBattle=${!!lastBattle} `
    + `lastBattleType=${toSafeInt(lastBattle && lastBattle.type, 0)} `
    + `lastBattleFightType=${toSafeInt(lastBattle && lastBattle.fightResult && lastBattle.fightResult.type, 0)} `
    + `win=${!!(lastBattle && lastBattle.result && lastBattle.result.win)}`
  );
  if (requestType === 4) {
    logger.info(
      `[Raid2301] type=4 entry user=${session && session.userId ? session.userId : 'unknown'} `
      + `msgUid=${msgUid} reqType=${requestType} hasLastBattle=${!!lastBattle} `
      + `lastBattleType=${toSafeInt(lastBattle && lastBattle.type, 0)} `
      + `lastBattleFightType=${toSafeInt(lastBattle && lastBattle.fightResult && lastBattle.fightResult.type, 0)} `
      + `win=${!!(lastBattle && lastBattle.result && lastBattle.result.win)}`
    );
  }
  if (!player || !lastBattle || !lastBattle.result.win) {
    const currentLevel = Math.max(1, toSafeInt(player && player.raidInfo && player.raidInfo.level, 1));
    const rewardInfo = buildRewardInfo([]);
    if (requestType === 4) {
      logger.warn(
        `[Raid2301] type=4 claim rejected user=${session && session.userId ? session.userId : 'unknown'} `
        + `msgUid=${msgUid} hasPlayer=${!!player} hasLastBattle=${!!lastBattle} win=${!!(lastBattle && lastBattle.result && lastBattle.result.win)} `
        + `rewardItems=${Array.isArray(rewardInfo.items) ? rewardInfo.items.length : 'na'}`
      );
    }
    return {
      tag: 2301,
      msgUid,
      data: {
        result: -1,
        id: currentLevel,
        rewardInfo,
      },
    };
  }

  player.raidInfo = player.raidInfo || { chapter: 1, level: 1, hangUpChapter: 1, hangUpTime: Date.now() };
  const rewards = lastBattle.level.reward || [];
  const gained = [];

  rewards.forEach((r) => {
    gained.push({ id: r.id, count: r.count });
    addRewardToPlayer(player, r.id, r.count);
  });

  const hasExpReward = rewards.some((r) => toSafeInt(r && r.id, 0) === 3);
  if (!hasExpReward) {
    const expGain = getFallbackFightExp(lastBattle.levelId);
    if (expGain > 0) {
      gained.push({ id: 3, count: expGain });
      addRewardToPlayer(player, 3, expGain);
    }
  }

  if (toSafeInt(lastBattle.type, 1) === 4) {
    player.raidInfo.demonBossInfo = player.raidInfo.demonBossInfo || { stage: 2, cleanOutTime: 0 };
    player.raidInfo.demonBossInfo.stage = Math.max(
      Math.max(1, toSafeInt(player.raidInfo.demonBossInfo.stage, 1)),
      Math.max(1, toSafeInt(lastBattle.level && lastBattle.level.demonBossStage, lastBattle.levelId))
    );
  } else {
    advanceLevel(player, lastBattle.levelId);
    refreshRealmStageTasks(player);
  }
  const taskSyncPackets = buildTaskSyncPackets(player);
  const activityPacket = toSafeInt(lastBattle.type, 1) === 4 ? null : buildMainlineClearActivityPacket(player);
  const rewardInfo = buildRewardInfo(gained);
  if (toSafeInt(lastBattle.type, 1) === 4) {
    logger.info(
      `[Raid2301] type=4 claim user=${session && session.userId ? session.userId : 'unknown'} `
      + `msgUid=${msgUid} stage=${Math.max(1, toSafeInt(player.raidInfo.demonBossInfo && player.raidInfo.demonBossInfo.stage, lastBattle.levelId))} `
      + `gained=${JSON.stringify(gained)} rewardItems=${Array.isArray(rewardInfo.items) ? rewardInfo.items.length : 'na'}`
    );
  }
  scheduleRaidPlayerSave(session, player, '2301');
  session.lastBattle = null;

  return [
    {
      tag: 1202,
      msgUid: 0,
      data: {
        items: gained.map((row) => ({
          id: Math.max(0, toSafeInt(row && row.id, 0)),
          count: Math.max(0, toSafeInt(row && row.count, 0)),
        })).filter((row) => row.id > 0 && row.count > 0),
      },
    },
    ...taskSyncPackets,
    ...(activityPacket ? [activityPacket] : []),
    {
      tag: 2301,
      msgUid,
      data: {
        rewardInfo,
        id: toSafeInt(lastBattle.type, 1) === 4
          ? Math.max(1, toSafeInt(player.raidInfo.demonBossInfo && player.raidInfo.demonBossInfo.stage, lastBattle.levelId))
          : player.raidInfo.level,
        result: 0,
      },
    },
  ];
}

async function handleSkipBattle(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 2304, msgUid, data: { result: -1 } };

  player.raidInfo = player.raidInfo || { chapter: 1, level: 1, hangUpChapter: 1, hangUpTime: Date.now() };
  player.raidInfo.demonBossInfo = player.raidInfo.demonBossInfo || { stage: 1, cleanOutTime: 0 };
  const stage = Math.max(1, toSafeInt(
    params && (params.stage != null ? params.stage : (params.levelId != null ? params.levelId : (params.id != null ? params.id : params.mapId))),
    player.raidInfo && player.raidInfo.demonBossInfo && player.raidInfo.demonBossInfo.stage,
    1,
  ));
  const demonBossCfg = config.get('DemonBossConfig') || {};
  const level = demonBossCfg[stage] || demonBossCfg[String(stage)] || null;
  if (!level) return { tag: 2304, msgUid, data: { result: -1, stage, cleanOutTime: player.raidInfo.demonBossInfo.cleanOutTime || 0, rewards: buildRewardInfo([]), rewardInfo: buildRewardInfo([]) } };

  const cleanOutCount = Math.max(0, toSafeInt(player.raidInfo && player.raidInfo.demonBossInfo && player.raidInfo.demonBossInfo.cleanOutTime, 0));
  const cleanOutCostList = Array.isArray(level.cleanoutCost) ? level.cleanoutCost : [];
  const maxCleanOutNum = Math.max(0, toSafeInt((config.get('DemonBossBaseConfig') || {}).cleanoutNum, 0));
  if (maxCleanOutNum > 0 && cleanOutCount >= maxCleanOutNum) {
    return { tag: 2304, msgUid, data: { result: -1, msg: 'cleanout limit', stage, cleanOutTime: cleanOutCount, rewards: buildRewardInfo([]), rewardInfo: buildRewardInfo([]) } };
  }
  const costIndex = Math.min(cleanOutCount, Math.max(0, cleanOutCostList.length - 1));
  const diamondCost = Math.max(0, toSafeInt(cleanOutCostList[costIndex], 0));
  player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
  if (Math.max(0, toSafeInt(player.currencies.diamond, 0)) < diamondCost) {
    return { tag: 2304, msgUid, data: { result: -1, msg: 'not enough diamond', stage, cleanOutTime: cleanOutCount, rewards: buildRewardInfo([]), rewardInfo: buildRewardInfo([]) } };
  }
  player.currencies.diamond = Math.max(0, toSafeInt(player.currencies.diamond, 0) - diamondCost);

  const rewards = level.cleanoutRewards || [];
  const gained = [];
  rewards.forEach((r) => {
    gained.push({ id: r.id, count: r.count });
    addRewardToPlayer(player, r.id, r.count);
  });

  const hasExpReward = rewards.some((r) => toSafeInt(r && r.id, 0) === 3);
  if (!hasExpReward) {
    const expGain = getFallbackFightExp(stage);
    if (expGain > 0) {
      gained.push({ id: 3, count: expGain });
      addRewardToPlayer(player, 3, expGain);
    }
  }

  player.raidInfo.demonBossInfo = player.raidInfo.demonBossInfo || { stage, cleanOutTime: 0 };
  player.raidInfo.demonBossInfo.stage = Math.max(1, toSafeInt(stage, 1));
  player.raidInfo.demonBossInfo.cleanOutTime = cleanOutCount + 1;
  const rewardSync = buildRewardItemSync(player, gained);
  const rewardInfo = buildRewardInfo(gained);
  await playerService.savePlayer(session.userId, player);

  return [
    {
      tag: 1212,
      msgUid: 0,
      data: {
        type: 2,
        endTime: 0,
      },
    },
    {
      tag: 1202,
      msgUid: 0,
      data: {
        ...rewardSync,
        changed: [
          ...(Array.isArray(rewardSync.changed) ? rewardSync.changed : []),
          { id: 1, count: Math.max(0, toSafeInt(player.currencies.diamond, 0)) },
        ],
      },
    },
    {
      tag: 2304,
      msgUid,
      data: {
        result: 0,
        stage,
        id: stage,
        cleanOutTime: player.raidInfo.demonBossInfo.cleanOutTime,
        rewards: rewardInfo,
        rewardInfo,
        demonBossInfo: player.raidInfo.demonBossInfo,
      },
    },
  ];
}

async function handleClaimHangUpReward(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 2302, msgUid, data: { result: -1 } };

  player.raidInfo = player.raidInfo || { chapter: 1, level: 1, hangUpChapter: 1, hangUpTime: Date.now() };
  const now = Date.now();
  const elapsed = Math.min(now - (player.raidInfo.hangUpTime || now), 12 * 3600 * 1000);
  const minutes = Math.floor(elapsed / 60000);

  if (minutes < 1) return { tag: 2302, msgUid, data: { result: -1, msg: 'not enough time' } };

  const chapter = player.raidInfo.hangUpChapter || 1;
  const gold = Math.max(1, chapter * 5) * minutes;
  const exp = Math.max(1, chapter * 3) * minutes;
  const silver = Math.max(1, chapter * 2) * minutes;
  // Regenerate baozi over time so side-game consumables don't run out permanently.
  // Rate: 1 baozi per 5 minutes of hang-up time, scaled by chapter.
  const baoziRegen = Math.max(1, Math.floor(minutes / 5)) * Math.max(1, chapter);

  player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
  player.currencies.gold += gold;
  player.currencies.silver += silver;
  addExpToPlayer(player, exp);
  player.items = player.items || {};
  player.items[4] = Math.max(0, toSafeInt(player.items[4], 0)) + baoziRegen;
  player.raidInfo.hangUpTime = now;

  checkLevelUp(player);
  const rewardSync = buildRewardItemSync(player, [
    { id: 6, count: gold },
    { id: 3, count: exp },
    { id: 2, count: silver },
    { id: 4, count: baoziRegen },
  ]);
  await playerService.savePlayer(session.userId, player);

  return [
    { tag: 1202, msgUid: 0, data: rewardSync },
    {
      tag: 2302,
      msgUid,
      data: {
        result: 0,
        gold,
        exp,
        silver,
        baozi: baoziRegen,
        minutes,
        level: player.level,
        currencies: player.currencies,
      },
    },
  ];
}

async function handleClaimChapterReward(params, session, msgUid) {
  const player = session.player;
  // Convert chapterId to integer to prevent string/number comparison bugs
  const chapterId = toSafeInt(params.chapterId || params.id || 1, 1);
  const chapterCfg = config.get('ChapterConfig');

  if (!player || !chapterCfg || !chapterCfg[chapterId]) {
    return { tag: 2303, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };
  }

  player.raidInfo = player.raidInfo || { chapter: 1, level: 1, hangUpChapter: 1, hangUpTime: Date.now() };
  const currentChapter = toSafeInt(player.raidInfo.chapter, 1);
  if (chapterId >= currentChapter) {
    return { tag: 2303, msgUid, data: { result: -1, msg: 'chapter not cleared' } };
  }

  player.raidInfo.claimedChapters = player.raidInfo.claimedChapters || [];
  // Normalize to numbers for consistent includes() comparison
  player.raidInfo.claimedChapters = player.raidInfo.claimedChapters.map((id) => toSafeInt(id, 0));
  if (player.raidInfo.claimedChapters.includes(chapterId)) {
    return { tag: 2303, msgUid, data: { result: -1, msg: 'already claimed' } };
  }

  const rewards = chapterCfg[chapterId].reward || [];
  const { rewardInfo, syncRewards } = grantRewardInfo(player, rewards);
  player.raidInfo.claimedChapters.push(chapterId);
  player.raidInfo.rewardChapter = Math.max(
    Math.max(0, toSafeInt(player.raidInfo.rewardChapter, 0)),
    chapterId,
  );
  if (!player.raidInfo.chapterInfo || typeof player.raidInfo.chapterInfo !== 'object') {
    player.raidInfo.chapterInfo = { id: 1, rewardChapter: 0 };
  }
  player.raidInfo.chapterInfo.rewardChapter = player.raidInfo.rewardChapter;
  const rewardSync = buildRewardItemSync(player, syncRewards);
  await playerService.savePlayer(session.userId, player);

  const packets = [];
  if (rewardSync) {
    packets.push({ tag: 1202, msgUid: 0, data: rewardSync });
  }
  rewardInfo.equips.forEach((equip) => {
    packets.push({ tag: 2200, msgUid: 0, data: { equip } });
  });
  packets.push({ tag: 2303, msgUid, data: { result: 0, chapterId, rewards, rewardInfo } });
  return packets;
}

module.exports = {
  handleStartFight,
  handleClaimFightReward,
  handleClaimHangUpReward,
  handleClaimChapterReward,
  handleSkipBattle,
  grantRewardInfo,
  addRewardToPlayer,
  addExpToPlayer,
  checkLevelUp,
  normalizeRoleStageForLevel,
  resolveStageIdForLevel,
  advanceLevel,
  // Contract probes used by scripts/test-core-gameplay-contract.js.
  resolveBattleActionIds,
  resolvePlayerBattleSkill,
  buildChapterFightEvents,
  buildChapterFightResult,
};
