'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// Keep this probe runnable from a source-only deployment. Top-combat protocol
// logic does not need MongoDB, Redis, or the real logger.
const originalLoad = Module._load;
const loggerStub = { debug() {}, info() {}, warn() {}, error() {} };
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
  if (request === '../services/ServerConfigService') {
    return { findServerConfig: async () => ({ openTime: Date.now() }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const config = require('../src/services/ConfigService');
const upgrade = require('../src/handlers/upgrade');
const arena = require('../src/handlers/arena');
const playerService = require('../src/services/PlayerService');

function buildPlayer() {
  return {
    userId: 'top_combat_contract_user',
    playerId: 'top_combat_contract_player',
    name: 'TopCombatContract',
    level: 1,
    roleInfo: { kungfuId: 4, subJob: 0, stage: 1, stageId: 1 },
    boxInfo: { level: 1 },
    systemUnlockInfo: {
      unlockedSystem: [315],
      rewardedSystem: [315],
      settings: { seenNewFeatures: [315] },
      guideStep: 0,
    },
    equipInfo: { curIndex: 0, equipSetMap: { 0: {} } },
    fashionInfo: {},
    petInfo: { pets: [] },
    items: { 88: 3 },
    currencies: {},
  };
}

async function run() {
  const systemConfig = config.get('SystemConfig') || {};
  const system315 = systemConfig[315] || systemConfig['315'];
  assert.ok(system315, 'SystemConfig[315] must exist');
  assert.deepEqual(
    system315.conditions,
    [
      { type: 3, value: 9999, cond: 4 },
      { type: 5, value: 9999, cond: 4 },
    ],
    'the latest client intentionally keeps top combat behind placeholder gates'
  );

  const player = buildPlayer();
  process.env.DISABLED_SYSTEM_IDS = '315';
  process.env.FORCE_UNLOCK_SYSTEM_IDS = '';
  await upgrade.refreshSystemUnlockInfo(player);
  assert.ok(
    !player.systemUnlockInfo.unlockedSystem.includes(315),
    'closed top combat must revoke a stale system 315 unlock'
  );

  process.env.DISABLED_SYSTEM_IDS = '';
  process.env.FORCE_UNLOCK_SYSTEM_IDS = '315';
  await upgrade.refreshSystemUnlockInfo(player);
  assert.ok(player.systemUnlockInfo.unlockedSystem.includes(315), 'explicit opening must unlock system 315');

  playerService.savePlayer = async (_userId, state) => state;
  const response = await arena.handleTopCombatChallengeInfo(
    {},
    { userId: player.userId, player },
    460001
  );
  assert.equal(response.tag, 4600, 'top-combat challenge response tag must be 4600');
  assert.equal(response.msgUid, 460001, 'top-combat response must preserve msgUid');
  assert.equal(response.data.result, 0, 'top-combat challenge query must succeed');
  assert.ok(response.data.maxRank > 0, 'tag 4600 must initialize model maxRank');
  assert.ok(Array.isArray(response.data.records), 'tag 4600 records must be an array');
  assert.ok(Array.isArray(response.data.loglist), 'tag 4600 loglist must be an array');
  assert.ok(response.data.challengeInfo, 'tag 4600 challengeInfo must exist');
  assert.ok(Array.isArray(response.data.challengeInfo.challengeList), 'challengeList must be an array');
  assert.ok(
    response.data.challengeInfo.infoMap
      && typeof response.data.challengeInfo.infoMap === 'object'
      && !Array.isArray(response.data.challengeInfo.infoMap),
    'challenge infoMap must be an object'
  );

  const clientRoot = path.join(__dirname, '..', '..');
  const indexHtml = fs.readFileSync(path.join(clientRoot, 'index.html'), 'utf8');
  const guardStart = indexHtml.indexOf('prototype.sendUpdateChallengeInfo = function');
  const infoHydration = indexHtml.indexOf('self.info = {', guardStart);
  const challengeUpdate = indexHtml.indexOf('self.updateChallengeInfo(', guardStart);
  assert.ok(guardStart >= 0, 'top-combat runtime protocol guard must be installed');
  assert.ok(
    infoHydration > guardStart && challengeUpdate > infoHydration,
    'the client must hydrate TopCombatModel.info before updateChallengeInfo'
  );

  const mainJs = fs.readFileSync(path.join(clientRoot, 'js', 'main.min_a6195824.js'), 'utf8');
  assert.ok(
    mainJs.includes('isSystemUnlock(315)') && mainJs.includes('C.sendUpdateChallengeInfo=function'),
    'latest client top-combat open and RPC chains must be present'
  );

  console.log('top-combat contract: ok');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
