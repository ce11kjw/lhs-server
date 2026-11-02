const CURRENT_SCHEMA_VERSION = 2;

function ensurePlainObject(val, fallback = {}) {
  if (val && typeof val === 'object' && !Array.isArray(val)) return val;
  return fallback;
}

function migrateToV2(player) {
  let changed = false;

  const schemaVersion = Number(player.schemaVersion || 0);
  if (!Number.isFinite(schemaVersion) || schemaVersion < 2) {
    player.schemaVersion = 2;
    changed = true;
  }

  if (!player.farmInfo || typeof player.farmInfo !== 'object' || Array.isArray(player.farmInfo)) {
    player.farmInfo = {
      blockInfo: [],
      lv: 1,
      buildLv: {},
      buildUpgrade: {},
      roblist: [],
      loglist: [],
      fightLoglist: [],
      neighbors: {},
      enemys: {},
      cookInfo: {},
      ratSkin: 0,
      offlineReward: false,
      cookFinishTime: 0,
      cookTime: 0,
      cookReward: 0,
      cacheOffline: [],
      cacheRecover: [],
    };
    changed = true;
  }

  if (!player.mineInfo || typeof player.mineInfo !== 'object' || Array.isArray(player.mineInfo)) {
    player.mineInfo = {
      levelId: -1,
      circleId: 0,
      cycle: 0,
      meter: 0,
      boxCounter: 0,
      boxRewardCount: 0,
      events: [],
    };
    changed = true;
  }

  if (!player.guildInfo || typeof player.guildInfo !== 'object' || Array.isArray(player.guildInfo)) {
    player.guildInfo = {
      guildId: 0,
      guildName: '',
      identity: 0,
      joinTime: 0,
      donateCount: 0,
      dailyReward: [],
      leaveTime: 0,
      blessCount: 0,
      blessRecord: 0,
      blessDailyClaimTime: 0,
      bossAssist: 0,
      bossCount: 0,
      bossReward: [],
      bossGuildId: 0,
    };
    changed = true;
  } else {
    if (!Array.isArray(player.guildInfo.dailyReward)) {
      player.guildInfo.dailyReward = [];
      changed = true;
    }
    if (!Array.isArray(player.guildInfo.bossReward)) {
      player.guildInfo.bossReward = [];
      changed = true;
    }
    if (!Number.isFinite(Number(player.guildInfo.blessDailyClaimTime))) {
      player.guildInfo.blessDailyClaimTime = 0;
      changed = true;
    }
  }

  if (!player.inviteInfo || typeof player.inviteInfo !== 'object' || Array.isArray(player.inviteInfo)) {
    player.inviteInfo = {
      totalInvite: {
        totalCount: 0,
        dayCount: 0,
        record: [],
        total: 0,
        daily: 0,
        reward: 0,
      },
      rebateData: {
        maxWelfare: 500000,
        rebateRate: 1000,
        rebateValue: 0,
        total: 0,
        claimed: 0,
      },
      first: false,
      dailyReward: false,
      shareCount: 0,
      totalShareCount: 0,
      shareRewardRecords: [],
      totalShareRewardRecords: [],
    };
    changed = true;
  } else {
    if (!player.inviteInfo.totalInvite || typeof player.inviteInfo.totalInvite !== 'object') {
      player.inviteInfo.totalInvite = {
        totalCount: 0,
        dayCount: 0,
        record: [],
        total: 0,
        daily: 0,
        reward: 0,
      };
      changed = true;
    }
    if (!player.inviteInfo.rebateData || typeof player.inviteInfo.rebateData !== 'object') {
      player.inviteInfo.rebateData = {
        maxWelfare: 500000,
        rebateRate: 1000,
        rebateValue: 0,
        total: 0,
        claimed: 0,
      };
      changed = true;
    }
    if (!Array.isArray(player.inviteInfo.totalInvite.record)) {
      player.inviteInfo.totalInvite.record = [];
      changed = true;
    }
    if (!Array.isArray(player.inviteInfo.shareRewardRecords)) {
      player.inviteInfo.shareRewardRecords = [];
      changed = true;
    }
    if (!Array.isArray(player.inviteInfo.totalShareRewardRecords)) {
      player.inviteInfo.totalShareRewardRecords = [];
      changed = true;
    }
  }

  if (!player.subscribeInfo || typeof player.subscribeInfo !== 'object' || Array.isArray(player.subscribeInfo)) {
    player.subscribeInfo = {
      switches: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1 },
    };
    changed = true;
  } else if (!player.subscribeInfo.switches || typeof player.subscribeInfo.switches !== 'object') {
    player.subscribeInfo.switches = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1 };
    changed = true;
  }

  player.systemUnlockInfo = ensurePlainObject(player.systemUnlockInfo);
  if (!Array.isArray(player.systemUnlockInfo.unlockedSystem)) {
    player.systemUnlockInfo.unlockedSystem = [];
    changed = true;
  }
  if (!Array.isArray(player.systemUnlockInfo.rewardedSystem)) {
    player.systemUnlockInfo.rewardedSystem = [];
    changed = true;
  }
  if (!player.systemUnlockInfo.settings || typeof player.systemUnlockInfo.settings !== 'object') {
    player.systemUnlockInfo.settings = {};
    changed = true;
  }

  return changed;
}

function migratePlayerData(player) {
  if (!player || typeof player !== 'object') return false;
  return migrateToV2(player);
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  migratePlayerData,
};
