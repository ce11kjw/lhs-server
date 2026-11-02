const TASK_SYNC_META_KEY = '__taskSyncMeta';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function buildMeta(meta = {}) {
  return {
    revision: Math.max(0, Number(meta.revision) || 0),
    dirty: meta.dirty === true,
    taskIds: Array.from(new Set(
      (Array.isArray(meta.taskIds) ? meta.taskIds : [])
        .map((taskId) => Math.max(0, Math.floor(Number(taskId) || 0)))
        .filter((taskId) => taskId > 0),
    )),
  };
}

function ensureTaskSyncMeta(player, seedMeta = null) {
  if (!isPlainObject(player)) return null;

  const current = player[TASK_SYNC_META_KEY];
  if (isPlainObject(current)) {
    current.revision = Math.max(0, Number(current.revision) || 0);
    current.dirty = current.dirty === true;
    current.taskIds = buildMeta(current).taskIds;
    return current;
  }

  const value = buildMeta(seedMeta || {});
  Object.defineProperty(player, TASK_SYNC_META_KEY, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return value;
}

function getTaskSyncMeta(player) {
  if (!isPlainObject(player)) return null;
  const meta = player[TASK_SYNC_META_KEY];
  return isPlainObject(meta) ? buildMeta(meta) : null;
}

function attachTaskSyncMeta(player, meta) {
  if (!isPlainObject(player) || !isPlainObject(meta)) return player;
  ensureTaskSyncMeta(player, meta);
  return player;
}

function getTaskRevision(player) {
  const meta = ensureTaskSyncMeta(player);
  return meta ? meta.revision : 0;
}

function markTaskDirty(player, taskIds = []) {
  const meta = ensureTaskSyncMeta(player);
  if (!meta) return 0;
  meta.revision += 1;
  meta.dirty = true;
  const nextIds = buildMeta({ taskIds: [...meta.taskIds, ...taskIds] }).taskIds;
  meta.taskIds = nextIds;
  return meta.revision;
}

function hasTaskDirty(player) {
  const meta = ensureTaskSyncMeta(player);
  return !!(meta && meta.dirty === true);
}

function consumeTaskDirty(player) {
  const meta = ensureTaskSyncMeta(player);
  if (!meta) return false;
  const dirty = meta.dirty === true;
  meta.dirty = false;
  meta.taskIds = [];
  return dirty;
}

function getTaskDirtyIds(player) {
  const meta = ensureTaskSyncMeta(player);
  return meta ? [...meta.taskIds] : [];
}

module.exports = {
  attachTaskSyncMeta,
  consumeTaskDirty,
  getTaskRevision,
  getTaskDirtyIds,
  getTaskSyncMeta,
  hasTaskDirty,
  markTaskDirty,
};
