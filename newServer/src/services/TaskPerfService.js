const { AsyncLocalStorage } = require('async_hooks');

const perfStorage = new AsyncLocalStorage();

function nowNs() {
  return process.hrtime.bigint();
}

function nsToMs(ns) {
  return Number(ns) / 1e6;
}

function roundMs(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function buildStore(meta = {}) {
  return {
    meta: { ...meta },
    startedAtNs: nowNs(),
    taskNormalizeMs: 0,
    taskNormalizeCount: 0,
    taskPushMs: 0,
    taskPushCount: 0,
    taskPushPackets: 0,
    taskPushKinds: {},
  };
}

function getStore() {
  return perfStorage.getStore() || null;
}

async function runWithTaskPerfScope(meta = {}, fn) {
  return perfStorage.run(buildStore(meta), fn);
}

function recordTaskNormalizeNs(durationNs) {
  const store = getStore();
  if (!store) return;
  store.taskNormalizeMs += nsToMs(durationNs);
  store.taskNormalizeCount += 1;
}

function recordTaskPushNs(durationNs, kind = 'unknown', packetCount = 0) {
  const store = getStore();
  if (!store) return;
  const safeKind = String(kind || 'unknown');
  store.taskPushMs += nsToMs(durationNs);
  store.taskPushCount += 1;
  store.taskPushPackets += Math.max(0, Number(packetCount) || 0);
  store.taskPushKinds[safeKind] = (store.taskPushKinds[safeKind] || 0) + 1;
}

function getTaskPerfSnapshot() {
  const store = getStore();
  if (!store) return null;
  return {
    meta: { ...store.meta },
    totalMs: roundMs(nsToMs(nowNs() - store.startedAtNs)),
    taskNormalizeMs: roundMs(store.taskNormalizeMs),
    taskNormalizeCount: store.taskNormalizeCount,
    taskPushMs: roundMs(store.taskPushMs),
    taskPushCount: store.taskPushCount,
    taskPushPackets: store.taskPushPackets,
    taskPushKinds: { ...store.taskPushKinds },
  };
}

module.exports = {
  getTaskPerfSnapshot,
  nowNs,
  recordTaskNormalizeNs,
  recordTaskPushNs,
  runWithTaskPerfScope,
};
