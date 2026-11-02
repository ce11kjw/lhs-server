const playerService = require('../services/PlayerService');
const { addRewardToPlayer } = require('./raid');

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function createDefaultInviteInfo() {
  return {
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
}

function createDefaultSubscribeInfo() {
  return {
    subscribes: {},
    switches: {
      1: 1,
      2: 1,
      3: 1,
      4: 1,
      5: 1,
      6: 1,
      7: 1,
      8: 1,
      9: 1,
    },
  };
}

function toSortedUniquePositiveInts(arr) {
  return Array.from(
    new Set(
      (Array.isArray(arr) ? arr : [])
        .map((v) => toSafeInt(v, 0))
        .filter((v) => v > 0)
    )
  ).sort((a, b) => a - b);
}

function ensureInviteInfo(player = {}) {
  if (!player.inviteInfo || typeof player.inviteInfo !== 'object' || Array.isArray(player.inviteInfo)) {
    player.inviteInfo = createDefaultInviteInfo();
    return player.inviteInfo;
  }

  const info = player.inviteInfo;
  const defaults = createDefaultInviteInfo();
  Object.keys(defaults).forEach((key) => {
    if (info[key] === undefined || info[key] === null) {
      info[key] = defaults[key];
    }
  });

  if (!info.totalInvite || typeof info.totalInvite !== 'object' || Array.isArray(info.totalInvite)) {
    info.totalInvite = { ...defaults.totalInvite };
  }
  if (!info.rebateData || typeof info.rebateData !== 'object' || Array.isArray(info.rebateData)) {
    info.rebateData = { ...defaults.rebateData };
  }

  info.totalInvite.totalCount = toSafeInt(
    info.totalInvite.totalCount !== undefined ? info.totalInvite.totalCount : info.totalInvite.total,
    0
  );
  info.totalInvite.dayCount = toSafeInt(
    info.totalInvite.dayCount !== undefined ? info.totalInvite.dayCount : info.totalInvite.daily,
    0
  );
  info.totalInvite.record = toSortedUniquePositiveInts(
    Array.isArray(info.totalInvite.record) ? info.totalInvite.record : []
  );
  info.totalInvite.total = info.totalInvite.totalCount;
  info.totalInvite.daily = info.totalInvite.dayCount;
  info.totalInvite.reward = info.totalInvite.record.length;

  info.rebateData.maxWelfare = toSafeInt(info.rebateData.maxWelfare, defaults.rebateData.maxWelfare);
  info.rebateData.rebateRate = toSafeInt(info.rebateData.rebateRate, defaults.rebateData.rebateRate);
  info.rebateData.rebateValue = toSafeInt(
    info.rebateData.rebateValue !== undefined ? info.rebateData.rebateValue : info.rebateData.total,
    0
  );
  info.rebateData.claimed = toSafeInt(info.rebateData.claimed, 0);
  info.rebateData.total = info.rebateData.rebateValue;

  info.first = Boolean(info.first);
  info.dailyReward = Boolean(info.dailyReward);
  info.shareCount = toSafeInt(info.shareCount, 0);
  info.totalShareCount = toSafeInt(
    info.totalShareCount !== undefined ? info.totalShareCount : info.totalInvite.totalCount,
    info.totalInvite.totalCount
  );
  info.shareRewardRecords = toSortedUniquePositiveInts(info.shareRewardRecords);
  info.totalShareRewardRecords = toSortedUniquePositiveInts(info.totalShareRewardRecords);

  return info;
}

function ensureSubscribeInfo(player = {}) {
  if (!player.subscribeInfo || typeof player.subscribeInfo !== 'object' || Array.isArray(player.subscribeInfo)) {
    player.subscribeInfo = createDefaultSubscribeInfo();
    return player.subscribeInfo;
  }

  const info = player.subscribeInfo;
  if (!info.subscribes || typeof info.subscribes !== 'object' || Array.isArray(info.subscribes)) {
    info.subscribes = {};
  }
  if (!info.switches || typeof info.switches !== 'object' || Array.isArray(info.switches)) {
    info.switches = { ...createDefaultSubscribeInfo().switches };
  }

  const defaults = createDefaultSubscribeInfo().switches;
  Object.keys(defaults).forEach((key) => {
    if (info.switches[key] === undefined || info.switches[key] === null) {
      info.switches[key] = defaults[key];
    }
    info.switches[key] = toSafeInt(info.switches[key], 0) > 0 ? 1 : 0;
  });

  return info;
}

function buildInviteInfoData(player = {}) {
  const info = ensureInviteInfo(player);
  const inviteRewardStatus = {};
  Object.keys(INVITE_REWARD_CONFIG).forEach((key) => {
    const id = toSafeInt(key, 0);
    if (id > 0) inviteRewardStatus[String(id)] = info.totalInvite.record.includes(id) ? 1 : 0;
  });
  return {
    inviteCount: info.totalInvite.totalCount,
    inviteRewardStatus,
    inviteRebateList: [],
    totalInvite: {
      totalCount: info.totalInvite.totalCount,
      dayCount: info.totalInvite.dayCount,
      record: info.totalInvite.record.slice(),
      total: info.totalInvite.total,
      daily: info.totalInvite.daily,
      reward: info.totalInvite.reward,
    },
    rebateData: {
      maxWelfare: info.rebateData.maxWelfare,
      rebateRate: info.rebateData.rebateRate,
      rebateValue: info.rebateData.rebateValue,
      total: info.rebateData.total,
      claimed: info.rebateData.claimed,
    },
    first: info.first,
    dailyReward: info.dailyReward,
  };
}

async function handleInviteInit(_params = {}, session, msgUid) {
  const player = session && session.player;
  return {
    tag: 11000,
    msgUid,
    data: {
      result: 0,
      ...buildInviteInfoData(player || {}),
    },
  };
}

function withRewards(data, items) {
  const rewards = { items: Array.isArray(items) ? items : [], equips: [] };
  return {
    ...data,
    rewards,
    rewardInfo: rewards,
  };
}

function buildSubscribeInfoData(player = {}) {
  const info = ensureSubscribeInfo(player);
  return {
    subscribes: { ...info.subscribes },
    switches: { ...info.switches },
  };
}

async function saveSessionPlayer(session) {
  const userId = session && session.userId;
  const player = session && session.player;
  if (!userId || !player) return;
  const saved = await playerService.savePlayer(userId, player);
  if (saved) session.player = saved;
}

function grantRewards(player, rewards = []) {
  const list = (Array.isArray(rewards) ? rewards : [])
    .map((r) => ({
      id: toSafeInt(r && r.id, 0),
      count: toSafeInt(r && r.count, 0),
    }))
    .filter((r) => r.id > 0 && r.count > 0);

  list.forEach((reward) => addRewardToPlayer(player, reward.id, reward.count));
  return list;
}

const FIRST_REWARD = [{ id: 1, count: 100 }];
const DAILY_REWARD = [{ id: 1, count: 30 }];
const INVITE_REWARD_CONFIG = {
  1: { need: 1, rewards: [{ id: 1, count: 50 }] },
  2: { need: 3, rewards: [{ id: 1, count: 120 }] },
  3: { need: 5, rewards: [{ id: 1, count: 220 }] },
  4: { need: 10, rewards: [{ id: 1, count: 500 }] },
};
const SHARE_REWARD_CONFIG = {
  1: { need: 1, rewards: [{ id: 2, count: 10000 }] },
};
const TOTAL_SHARE_REWARD_CONFIG = {
  1: { need: 5, rewards: [{ id: 1, count: 80 }] },
  2: { need: 20, rewards: [{ id: 1, count: 300 }] },
  3: { need: 50, rewards: [{ id: 1, count: 1000 }] },
};

function toRewardId(params = {}, fallback = 1) {
  return toSafeInt(params.rewardId !== undefined ? params.rewardId : params.id, fallback);
}

async function handleInviteFirstReward(_params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 11001, msgUid, data: { result: -1 } };

  const info = ensureInviteInfo(player);
  if (info.first) {
    return { tag: 11001, msgUid, data: { result: -2, ...buildInviteInfoData(player) } };
  }

  info.first = true;
  const items = grantRewards(player, FIRST_REWARD);
  await saveSessionPlayer(session);

  return {
    tag: 11001,
    msgUid,
    data: withRewards({
      result: 0,
      ...buildInviteInfoData(player),
    }, items),
  };
}

async function handleInviteDailyReward(_params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 11002, msgUid, data: { result: -1 } };

  const info = ensureInviteInfo(player);
  if (info.dailyReward) {
    return { tag: 11002, msgUid, data: { result: -2, ...buildInviteInfoData(player) } };
  }
  if (info.totalInvite.dayCount <= 0) {
    return { tag: 11002, msgUid, data: { result: -3, ...buildInviteInfoData(player) } };
  }

  info.dailyReward = true;
  const items = grantRewards(player, DAILY_REWARD);
  await saveSessionPlayer(session);

  return {
    tag: 11002,
    msgUid,
    data: withRewards({
      result: 0,
      ...buildInviteInfoData(player),
    }, items),
  };
}

async function handleInviteReward(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 11003, msgUid, data: { result: -1 } };

  const info = ensureInviteInfo(player);
  const rewardId = toRewardId(params, 1);
  const cfg = INVITE_REWARD_CONFIG[rewardId];
  if (!cfg) {
    return { tag: 11003, msgUid, data: { result: -1, rewardId, ...buildInviteInfoData(player) } };
  }
  if (info.totalInvite.totalCount < cfg.need) {
    return { tag: 11003, msgUid, data: { result: -3, rewardId, ...buildInviteInfoData(player) } };
  }
  if (info.totalInvite.record.includes(rewardId)) {
    return { tag: 11003, msgUid, data: { result: -2, rewardId, ...buildInviteInfoData(player) } };
  }

  info.totalInvite.record.push(rewardId);
  info.totalInvite.record = toSortedUniquePositiveInts(info.totalInvite.record);
  info.totalInvite.reward = info.totalInvite.record.length;
  const items = grantRewards(player, cfg.rewards);
  await saveSessionPlayer(session);

  return {
    tag: 11003,
    msgUid,
    data: withRewards({
      result: 0,
      rewardId,
      ...buildInviteInfoData(player),
    }, items),
  };
}

async function handleShareSuccess(_params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 11005, msgUid, data: { result: -1 } };

  const info = ensureInviteInfo(player);
  info.totalInvite.totalCount += 1;
  info.totalInvite.dayCount += 1;
  info.totalInvite.total = info.totalInvite.totalCount;
  info.totalInvite.daily = info.totalInvite.dayCount;
  info.shareCount += 1;
  info.totalShareCount += 1;
  info.dailyReward = false;

  await saveSessionPlayer(session);
  return {
    tag: 11005,
    msgUid,
    data: {
      result: 0,
      totalCount: info.totalInvite.totalCount,
      dayCount: info.totalInvite.dayCount,
      ...buildInviteInfoData(player),
    },
  };
}

async function handleShareReward(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 11006, msgUid, data: { result: -1 } };

  const info = ensureInviteInfo(player);
  const rewardId = toRewardId(params, 1);
  const cfg = SHARE_REWARD_CONFIG[rewardId];
  if (!cfg) {
    return { tag: 11006, msgUid, data: { result: -1, rewardId, ...buildInviteInfoData(player) } };
  }
  if (info.shareCount < cfg.need) {
    return { tag: 11006, msgUid, data: { result: -3, rewardId, ...buildInviteInfoData(player) } };
  }
  if (info.shareRewardRecords.includes(rewardId)) {
    return { tag: 11006, msgUid, data: { result: -2, rewardId, ...buildInviteInfoData(player) } };
  }

  info.shareRewardRecords.push(rewardId);
  info.shareRewardRecords = toSortedUniquePositiveInts(info.shareRewardRecords);
  const items = grantRewards(player, cfg.rewards);
  await saveSessionPlayer(session);

  return {
    tag: 11006,
    msgUid,
    data: withRewards({
      result: 0,
      rewardId,
      ...buildInviteInfoData(player),
    }, items),
  };
}

async function handleTotalShareReward(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 11007, msgUid, data: { result: -1 } };

  const info = ensureInviteInfo(player);
  const rewardId = toRewardId(params, 1);
  const cfg = TOTAL_SHARE_REWARD_CONFIG[rewardId];
  if (!cfg) {
    return { tag: 11007, msgUid, data: { result: -1, rewardId, ...buildInviteInfoData(player) } };
  }
  if (info.totalShareCount < cfg.need) {
    return { tag: 11007, msgUid, data: { result: -3, rewardId, ...buildInviteInfoData(player) } };
  }
  if (info.totalShareRewardRecords.includes(rewardId)) {
    return { tag: 11007, msgUid, data: { result: -2, rewardId, ...buildInviteInfoData(player) } };
  }

  info.totalShareRewardRecords.push(rewardId);
  info.totalShareRewardRecords = toSortedUniquePositiveInts(info.totalShareRewardRecords);
  const items = grantRewards(player, cfg.rewards);
  await saveSessionPlayer(session);

  return {
    tag: 11007,
    msgUid,
    data: withRewards({
      result: 0,
      rewardId,
      record: info.totalShareRewardRecords.slice(),
      ...buildInviteInfoData(player),
    }, items),
  };
}

async function handleInviteRebate(_params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 11008, msgUid, data: { result: -1 } };

  const info = ensureInviteInfo(player);
  const rebateData = info.rebateData;
  const maxWelfare = toSafeInt(rebateData.maxWelfare, 0);
  const total = Math.min(maxWelfare > 0 ? maxWelfare : Number.MAX_SAFE_INTEGER, toSafeInt(rebateData.rebateValue, 0));
  const claimed = toSafeInt(rebateData.claimed, 0);
  const available = Math.max(0, total - claimed);

  if (available <= 0) {
    return { tag: 11008, msgUid, data: { result: -2, ...buildInviteInfoData(player) } };
  }

  rebateData.claimed = claimed + available;
  rebateData.total = total;
  const items = grantRewards(player, [{ id: 1, count: available }]);
  await saveSessionPlayer(session);

  return {
    tag: 11008,
    msgUid,
    data: withRewards({
      result: 0,
      getValue: available,
      ...buildInviteInfoData(player),
    }, items),
  };
}

async function handleSubscribeInfo(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 11100, msgUid, data: { result: -1, subscribes: {}, switches: {} } };

  const info = ensureSubscribeInfo(player);
  toSortedUniquePositiveInts(params.types).forEach((type) => {
    info.subscribes[String(type)] = 1;
  });
  await saveSessionPlayer(session);
  const data = buildSubscribeInfoData(player);
  return [
    { tag: 11100, msgUid: 0, data },
    { tag: 11100, msgUid, data: { result: 0, ...data } },
  ];
}

async function handleSubscribeSwitchRequest(params = {}, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 11101, msgUid, data: { result: -1, switches: {} } };

  const info = ensureSubscribeInfo(player);
  if (params.switches && typeof params.switches === 'object') {
    Object.keys(params.switches).forEach((key) => {
      info.switches[String(key)] = toSafeInt(params.switches[key], 0) > 0 ? 1 : 0;
    });
  } else {
    const id = toSafeInt(params.id !== undefined ? params.id : (params.type !== undefined ? params.type : params.key), 0);
    const valueRaw = params.value !== undefined
      ? params.value
      : (params.state !== undefined ? params.state : params.open);
    const value = toSafeInt(valueRaw, 0) > 0 ? 1 : 0;
    if (id > 0) {
      info.switches[String(id)] = value;
    }
  }

  await saveSessionPlayer(session);
  return {
    tag: 11101,
    msgUid,
    data: {
      result: 0,
      ...buildSubscribeInfoData(player),
    },
  };
}

module.exports = {
  createDefaultInviteInfo,
  createDefaultSubscribeInfo,
  ensureInviteInfo,
  ensureSubscribeInfo,
  buildInviteInfoData,
  buildSubscribeInfoData,
  handleInviteInit,
  handleInviteFirstReward,
  handleInviteDailyReward,
  handleInviteReward,
  handleShareSuccess,
  handleShareReward,
  handleTotalShareReward,
  handleInviteRebate,
  handleSubscribeInfo,
  handleSubscribeSwitchRequest,
};
