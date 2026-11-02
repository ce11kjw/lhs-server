/**
 * Task/chat/rename handlers.
 * tag: 1000 claim/update task, 1601 chat, 21 rename.
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const { addRewardToPlayer, checkLevelUp } = require('./raid');
const { refreshSystemUnlockInfo } = require('./upgrade');
const { refreshRealmStageTasks } = require('../services/RealmTaskProgressService');
const { refreshMainTaskProgress, getMainTaskCurrentProgress } = require('../services/MainTaskProgressService');
const { buildRewardItemSync } = require('../services/RewardSync');
const chat = require('./chat');
const logger = require('../logger');
const { nowNs, recordTaskPushNs } = require('../services/TaskPerfService');

function getRenameCost() {
  const constCfg = config.get('ConstConfig') || {};
  const raw = constCfg.changeNameCost || {};
  return {
    id: Math.max(0, toSafeInt(raw.id, 0)),
    count: Math.max(0, toSafeInt(raw.count, 0)),
  };
}

function getItemCount(player, itemId) {
  return Math.max(0, toSafeInt(player && player.items && player.items[itemId], 0));
}

function normalizeTaskInfoSafe(taskInfo = {}, roleInfo = {}, player = {}) {
  try {
    // Lazy require avoids task -> playerPayload -> artifact/raid -> task cycles
    // leaving normalizeTaskInfo undefined during login bootstrap.
    // eslint-disable-next-line global-require
    const mod = require('./playerPayload');
    if (mod && typeof mod.normalizeTaskInfo === 'function') {
      return mod.normalizeTaskInfo(taskInfo, roleInfo, player);
    }
  } catch (_err) {}
  return taskInfo;
}

function normalizeRaidInfoSafe(player = {}) {
  try {
    // eslint-disable-next-line global-require
    const mod = require('./playerPayload');
    if (mod && typeof mod.ensureRaidInfo === 'function') {
      return mod.ensureRaidInfo(player);
    }
  } catch (_err) {}
  return player && player.raidInfo ? player.raidInfo : {};
}

function toSafeInt(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.floor(num) : fallback;
}

function getTaskCfgMap() {
  return config.get('TaskConfig') || {};
}

function getTaskCfg(taskId) {
  const taskCfg = getTaskCfgMap();
  return taskCfg[taskId] || taskCfg[String(taskId)] || null;
}

function buildRewardInfo(items = []) {
  return {
    items: items
      .map((row) => ({
        id: Math.max(0, toSafeInt(row && row.id, 0)),
        count: Math.max(0, toSafeInt(row && row.count, 0)),
      }))
      .filter((row) => row.id > 0 && row.count > 0),
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

function isMainTaskRewardContext(task = {}, taskState = null) {
  const taskType = toSafeInt(task && task.type, 0);
  const stateType = toSafeInt(taskState && taskState.type, 0);
  const taskId = toSafeInt(task && task.id, 0);
  return taskType === 1 || stateType === 1 || (taskId >= 10000 && taskId < 20000);
}

function shouldSkipTaskReward(task = {}, reward = {}, taskState = null) {
  const rewardId = toSafeInt(reward && reward.id, 0);
  return isMainTaskRewardContext(task, taskState) && rewardId === 3;
}

function buildTaskRewardSync(player = {}, items = []) {
  return buildRewardItemSync(player, buildRewardInfo(items).items);
}

function hasExpReward(items = []) {
  return Array.isArray(items) && items.some((row) => toSafeInt(row && row.id, 0) === 3 && toSafeInt(row && row.count, 0) > 0);
}

function ensureTaskInfo(taskInfo = {}) {
  if (!taskInfo.tasks || typeof taskInfo.tasks !== 'object' || Array.isArray(taskInfo.tasks)) {
    taskInfo.tasks = {};
  }
  if (!taskInfo.tasksMap || typeof taskInfo.tasksMap !== 'object' || Array.isArray(taskInfo.tasksMap)) {
    taskInfo.tasksMap = {};
  }
  return taskInfo;
}

function upsertTaskState(taskInfo, taskId, patch = {}) {
  const cfg = getTaskCfg(taskId);
  if (!cfg) return null;

  const info = ensureTaskInfo(taskInfo);
  const taskKey = String(taskId);
  const prev = info.tasks[taskKey] || {};
  const type = toSafeInt(
    patch.type != null ? patch.type : (prev.type != null ? prev.type : cfg.type),
    toSafeInt(cfg.type, 0),
  );
  const target = Math.max(0, toSafeInt(
    patch.target != null ? patch.target : (prev.target != null ? prev.target : cfg.taskValue1),
    0,
  ));
  let progress = Math.max(0, toSafeInt(
    patch.progress != null ? patch.progress : prev.progress,
    0,
  ));
  const status = toSafeInt(
    patch.status != null ? patch.status : prev.status,
    10,
  );
  if (status >= 20 && target > 0 && progress < target) {
    progress = target;
  }

  const nextState = {
    id: taskId,
    type,
    status,
    progress,
    target,
    ...((patch.progressBase != null || prev.progressBase != null)
      ? { progressBase: Math.max(0, toSafeInt(patch.progressBase != null ? patch.progressBase : prev.progressBase, 0)) }
      : {}),
  };
  info.tasks[taskKey] = nextState;

  const typeKey = String(type);
  const list = Array.isArray(info.tasksMap[typeKey]) ? info.tasksMap[typeKey] : [];
  const existingIndex = list.findIndex((row) => toSafeInt(row && row.id, 0) === taskId);
  if (existingIndex >= 0) {
    list[existingIndex] = nextState;
  } else {
    list.push(nextState);
  }
  list.sort((a, b) => toSafeInt(a && a.id, 0) - toSafeInt(b && b.id, 0));
  info.tasksMap[typeKey] = list;
  return nextState;
}

function buildInitialUnlockedTaskState(player, nextId, nextCfg) {
  const target = Math.max(0, toSafeInt(nextCfg && nextCfg.taskValue1, 0));
  const progressValue = nextCfg ? getMainTaskCurrentProgress(nextCfg, player || {}) : null;
  const activeId = toSafeInt(nextCfg && nextCfg.activeId, 0);
  const resetFromCurrent = activeId === 1 || activeId === 3 || activeId === 4;
  const progress = resetFromCurrent ? 0 : (progressValue == null
    ? 0
    : Math.max(0, toSafeInt(progressValue, 0)));

  return {
    id: nextId,
    type: nextCfg.type,
    status: target > 0 && progress >= target ? 20 : 10,
    progress,
    target,
    ...(resetFromCurrent ? { progressBase: Math.max(0, toSafeInt(progressValue, 0)) } : {}),
  };
}

function unlockNextTask(player, taskId) {
  const cfg = getTaskCfg(taskId);
  if (!cfg) return null;
  let nextId = toSafeInt(cfg.nextId, 0);
  let nextCfg = getTaskCfg(nextId);
  const SKIP_TASK_IDS = new Set();
  while (nextId > 0 && nextCfg && SKIP_TASK_IDS.has(nextId)) {
    nextId = toSafeInt(nextCfg.nextId, 0);
    nextCfg = getTaskCfg(nextId);
  }
  if (nextId <= 0 || !nextCfg) return null;

  const info = ensureTaskInfo(player && player.taskInfo ? player.taskInfo : player);
  if (info.tasks[String(nextId)]) {
    return info.tasks[String(nextId)];
  }
  return upsertTaskState(info, nextId, buildInitialUnlockedTaskState(player, nextId, nextCfg));
}

function claimTaskRewards(player, taskIds = []) {
  player.taskInfo = normalizeTaskInfoSafe(player.taskInfo || {}, player.roleInfo || {}, player);
  ensureTaskInfo(player.taskInfo);

  const claimedIds = [];
  const unlockedTaskIds = [];
  const rewardRows = [];
  const seen = new Set();
  let unlockedNextTask = false;

  taskIds.forEach((rawId) => {
    const taskId = toSafeInt(rawId, 0);
    if (taskId <= 0 || seen.has(taskId)) return;
    seen.add(taskId);

    const task = getTaskCfg(taskId);
    if (!task) return;

    const taskKey = String(taskId);
    const taskState = player.taskInfo.tasks[taskKey] || null;
    if (taskState && (taskState.status === 2 || taskState.status === 30)) {
      return;
    }

    const rewards = Array.isArray(task.reward) ? task.reward : [];
    rewards.forEach((row) => {
      const reward = {
        id: toSafeInt(row && row.id, 0),
        count: Math.max(0, toSafeInt(row && row.count, 0)),
      };
      if (shouldSkipTaskReward(task, reward, taskState)) return;
      if (reward.id <= 0 || reward.count <= 0) return;
      addRewardToPlayer(player, reward.id, reward.count);
      rewardRows.push(reward);
    });

    upsertTaskState(player.taskInfo, taskId, {
      id: taskId,
      type: task.type,
      status: 30,
      progress: task.taskValue1,
      target: task.taskValue1,
    });
    const nextTaskState = unlockNextTask(player, taskId);
    if (nextTaskState) unlockedNextTask = true;
    if (nextTaskState && toSafeInt(nextTaskState.id, 0) > 0) {
      unlockedTaskIds.push(toSafeInt(nextTaskState.id, 0));
    }
    claimedIds.push(taskId);
  });

  refreshMainTaskProgress(player);
  player.taskInfo = normalizeTaskInfoSafe(player.taskInfo, player.roleInfo || {}, player);
  return { claimedIds, unlockedTaskIds, rewardRows, unlockedNextTask };
}

// Legacy task list compatibility. Current client uses tag:1000 task updates;
// tag:1800 belongs to fashion data and must not carry task payloads.
async function handleGetTasks(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 1000, msgUid, data: { result: -1 } };

  player.taskInfo = normalizeTaskInfoSafe(player.taskInfo || {}, player.roleInfo || {}, player);
  const mainTaskChanged = !!refreshMainTaskProgress(player);
  const realmTaskChanged = !!refreshRealmStageTasks(player);
  if ((mainTaskChanged || realmTaskChanged) && session.userId) {
    const saved = await playerService.savePlayer(session.userId, player);
    if (saved && typeof saved === 'object') {
      session.player = saved;
    }
  }
  const packets = buildActiveTaskUpdatePackets(player, msgUid, { includeAllTypes: true });
  if (packets.length > 0) return packets;
  return { tag: 1000, msgUid, data: { result: 0 } };
}

function buildTaskSyncResponse(player, msgUid = 0) {
  const normalizedTaskInfo = normalizeTaskInfoSafe(
    (player && player.taskInfo) || {},
    (player && player.roleInfo) || {},
    player || {}
  );
  return {
    tag: 1000,
    msgUid,
    data: {
      ...normalizedTaskInfo,
      raidInfo: normalizeRaidInfoSafe(player || {}),
    },
  };
}

function buildActiveTaskUpdatePackets(player, msgUid = 0, options = {}) {
  const perfStartNs = nowNs();
  const normalizedTaskInfo = normalizeTaskInfoSafe(
    (player && player.taskInfo) || {},
    (player && player.roleInfo) || {},
    player || {}
  );
  const tasksMap = normalizedTaskInfo && typeof normalizedTaskInfo.tasksMap === 'object' && !Array.isArray(normalizedTaskInfo.tasksMap)
    ? normalizedTaskInfo.tasksMap
    : {};
  const packets = [];
  const includeTaskTypes = Array.isArray(options.includeTaskTypes)
    ? new Set(options.includeTaskTypes.map((type) => toSafeInt(type, 0)).filter((type) => type > 0))
    : null;

  const queued = [];

  Object.keys(tasksMap).forEach((typeKey) => {
    const list = Array.isArray(tasksMap[typeKey]) ? tasksMap[typeKey] : [];
    list.forEach((task) => {
      const taskId = Math.max(0, toSafeInt(task && task.id, 0));
      if (taskId <= 0) return;
      const status = toSafeInt(task && task.status, 0);
      if (status !== 10 && status !== 20) return;
      const taskType = toSafeInt(task && task.type, 0);
      if (!options.includeAllTypes && includeTaskTypes && !includeTaskTypes.has(taskType)) return;
      if (!options.includeAllTypes && !includeTaskTypes && taskType !== 1) return;
      const priority = (status === 10 || status === 20) ? 0 : 1;
      queued.push({
        priority,
        taskId,
        tag: 1000,
        msgUid,
        data: {
          task: { ...(task || {}) },
        },
      });
    });
  });

  queued
    .sort((a, b) => (a.priority - b.priority) || (a.taskId - b.taskId))
    .forEach((packet) => packets.push({ tag: packet.tag, msgUid: packet.msgUid, data: packet.data }));

  recordTaskPushNs(nowNs() - perfStartNs, 'active', packets.length);
  return packets;
}

function buildTaskUpdatePacketsByIds(player, taskIds = [], msgUid = 0) {
  const perfStartNs = nowNs();
  const normalizedTaskInfo = normalizeTaskInfoSafe(
    (player && player.taskInfo) || {},
    (player && player.roleInfo) || {},
    player || {}
  );
  const tasks = normalizedTaskInfo && typeof normalizedTaskInfo.tasks === 'object' && !Array.isArray(normalizedTaskInfo.tasks)
    ? normalizedTaskInfo.tasks
    : {};
  const seen = new Set();

  const packets = taskIds.reduce((packets, rawId) => {
    const taskId = Math.max(0, toSafeInt(rawId, 0));
    if (taskId <= 0 || seen.has(taskId)) return packets;
    seen.add(taskId);

    const task = tasks[String(taskId)] || tasks[taskId];
    if (!task || typeof task !== 'object') return packets;
    packets.push({
      tag: 1000,
      msgUid,
      data: {
        task: { ...task },
      },
    });
    return packets;
  }, []);

  recordTaskPushNs(nowNs() - perfStartNs, 'byIds', packets.length);
  return packets;
}

function buildClaimTaskUpdatePackets(player, claimedIds = [], unlockedTaskIds = [], msgUid = 0) {
  return [
    ...buildTaskUpdatePacketsByIds(player, claimedIds, msgUid),
    ...buildTaskUpdatePacketsByIds(player, unlockedTaskIds, msgUid),
  ];
}

function buildTaskSnapshot(player) {
  const taskSync = buildTaskSyncResponse(player);
  return taskSync && taskSync.data ? taskSync.data : { tasks: {}, tasksMap: {}, raidInfo: {} };
}

// claim task reward (client expects tag:1000 response)
async function handleClaimTaskReward(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 1000, msgUid, data: { result: -1, ids: [], rewardInfo: buildRewardInfo([]) } };

  const taskId = Number(params.taskId || params.id || 0);
  const task = getTaskCfg(taskId);
  if (!taskId || !task) return { tag: 1000, msgUid, data: { result: -1, ids: [], rewardInfo: buildRewardInfo([]), msg: 'invalid task' } };

  const { claimedIds, unlockedTaskIds, rewardRows, unlockedNextTask } = claimTaskRewards(player, [taskId]);
  if (unlockedNextTask) {
    await refreshSystemUnlockInfo(player);
  }
  if (claimedIds.length <= 0) {
    return { tag: 1000, msgUid, data: { result: -1, ids: [], rewardInfo: buildRewardInfo([]), msg: 'already claimed' } };
  }

  if (hasExpReward(rewardRows)) {
    checkLevelUp(player);
  }
  refreshMainTaskProgress(player);
  refreshRealmStageTasks(player);
  playerService.savePlayer(session.userId, player).catch((err) => {
    logger.warn(`[Task] async claim save failed user=${session.userId}: ${err.message}`);
  });

  const currentPlayer = session.player || player;
  const rewardSync = buildTaskRewardSync(currentPlayer, rewardRows);
  const taskUpdates = buildClaimTaskUpdatePackets(currentPlayer, claimedIds, unlockedTaskIds);
  const response = {
    tag: 1000,
    msgUid,
    data: {
      result: 0,
      type: toSafeInt(task.type, 0),
      ids: claimedIds,
      rewardInfo: buildRewardInfo(rewardRows),
    },
  };
  if (rewardSync.items.length <= 0) return [...taskUpdates, response];

  return [
    ...taskUpdates,
    { tag: 1202, msgUid: 0, data: rewardSync },
    response,
  ];
}

// old-client claim task reward (tag:1000)
async function handleClaimTaskRewardCompat(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 1000,
      msgUid,
      data: { result: -1, ids: [], rewardInfo: buildRewardInfo([]) },
    };
  }

  const ids = Array.isArray(params.ids)
    ? params.ids.map((id) => toSafeInt(id, 0)).filter((id) => id > 0)
    : [toSafeInt(params.id != null ? params.id : params.taskId, 0)].filter((id) => id > 0);
  if (ids.length <= 0) {
    return {
      tag: 1000,
      msgUid,
      data: { result: -1, ids: [], rewardInfo: buildRewardInfo([]) },
    };
  }

  const { claimedIds, unlockedTaskIds, rewardRows, unlockedNextTask } = claimTaskRewards(player, ids);
  if (unlockedNextTask) {
    await refreshSystemUnlockInfo(player);
  }
  if (claimedIds.length <= 0) {
    return {
      tag: 1000,
      msgUid,
      data: { result: -1, ids: [], rewardInfo: buildRewardInfo([]) },
    };
  }

  if (hasExpReward(rewardRows)) {
    checkLevelUp(player);
  }
  refreshMainTaskProgress(player);
  refreshRealmStageTasks(player);
  // Task rewards are already applied to the in-memory session.  Queue a
  // snapshot for Mongo without delaying the tag=1000 ACK and later messages.
  playerService.savePlayer(session.userId, player).catch((err) => {
    logger.warn(`[Task] async compat claim save failed user=${session.userId}: ${err.message}`);
  });

  const currentPlayer = player;
  const rewardSync = buildTaskRewardSync(currentPlayer, rewardRows);
  const taskUpdates = buildClaimTaskUpdatePackets(currentPlayer, claimedIds, unlockedTaskIds);
  const response = {
    tag: 1000,
    msgUid,
    data: {
      result: 0,
      type: toSafeInt(params.type, 0) || 1,
      ids: claimedIds,
      rewardInfo: buildRewardInfo(rewardRows),
      taskInfo: buildTaskSnapshot(currentPlayer),
    },
  };
  if (rewardSync.items.length <= 0) return [...taskUpdates, response];

  return [
    ...taskUpdates,
    { tag: 1202, msgUid: 0, data: rewardSync },
    response,
  ];
}

// chat send (tag:1601)
function handleChatSend(params, session, msgUid) {
  const player = session && session.player ? session.player : {};
  const entry = chat.buildChatEntry(params, player, {
    msgType: 0,
    sys: false,
  });
  return chat.buildWorldChatPushPacket(params && params.channel, entry, msgUid);
}

// rename (tag:21)
async function handleRename(params, session, msgUid) {
  const player = session && session.player;
  if (!player) return { tag: 21, msgUid, data: { result: 1 } };

  const newName = String((params && (params.name || params.newName)) || '').trim();
  if (!newName || newName.length < 1 || newName.length > 16) {
    return { tag: 21, msgUid, data: { result: 1 } };
  }
  if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]+$/.test(newName)) {
    return { tag: 21, msgUid, data: { result: 1 } };
  }

  const cost = getRenameCost();
  if (cost.id <= 0 || cost.count <= 0 || getItemCount(player, cost.id) < cost.count) {
    return { tag: 21, msgUid, data: { result: 1 } };
  }

  const oldName = player.name;
  const oldChangeName = Math.max(0, toSafeInt(player.changeName, 0));
  const oldItemCount = getItemCount(player, cost.id);
  player.items = player.items || {};
  player.items[cost.id] = oldItemCount - cost.count;
  if (player.items[cost.id] <= 0) delete player.items[cost.id];
  player.name = newName;
  player.changeName = oldChangeName + 1;

  try {
    await playerService.savePlayer(session.userId, player);
  } catch (err) {
    player.name = oldName;
    player.changeName = oldChangeName;
    player.items[cost.id] = oldItemCount;
    logger.warn(`[Rename] save failed user=${session.userId || 'unknown'}: ${err.message}`);
    return { tag: 21, msgUid, data: { result: 1 } };
  }

  return [
    { tag: 21, msgUid, data: { result: 0, name: player.name } },
    {
      tag: 1202,
      msgUid: 0,
      data: {
        result: 0,
        items: [{ id: cost.id, count: -cost.count }],
        changed: [{ id: cost.id, count: getItemCount(player, cost.id) }],
      },
    },
  ];
}

module.exports = {
  handleGetTasks,
  handleClaimTaskReward,
  handleClaimTaskRewardCompat,
  buildActiveTaskUpdatePackets,
  buildTaskUpdatePacketsByIds,
  handleChatSend,
  handleRename,
};
