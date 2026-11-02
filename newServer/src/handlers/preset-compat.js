/**
 * Preset compatibility handlers.
 * tag: 2210/2211/2212
 */

const playerService = require('../services/PlayerService');
const { ensureEquipInfo, getPresetSetInfo } = require('../services/EquipService');
const { refreshMainTaskProgress } = require('../services/MainTaskProgressService');
const { syncSpiritInfoFromCurrentPreset } = require('./spirit');

function buildTaskUpdatePacketsSafe(player, msgUid = 0) {
  try {
    // eslint-disable-next-line global-require
    const task = require('./task');
    if (task && typeof task.buildActiveTaskUpdatePackets === 'function') {
      return task.buildActiveTaskUpdatePackets(player, msgUid);
    }
  } catch (_err) {}
  return [];
}

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensureObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

function normalizeSetInfo(raw = {}) {
  const info = ensureObject(raw);
  return {
    name: String(info.name || ''),
    formation: Math.max(0, toSafeInt(info.formation, 0)),
    sword: Math.max(0, toSafeInt(info.sword, 0)),
    spirit: Math.max(0, toSafeInt(info.spirit, 0)),
    artifact: ensureObject(info.artifact),
    valhalla: Math.max(0, toSafeInt(info.valhalla, 0)),
    bloodline: Math.max(0, toSafeInt(info.bloodline, 0)),
    orb: ensureObject(info.orb),
    elf: ensureObject(info.elf),
    elfPlan: Math.max(0, toSafeInt(info.elfPlan, 0)),
    fate: Math.max(1, toSafeInt(info.fate, 1)),
  };
}

function getSetInfoByIndex(player, index) {
  return getPresetSetInfo(player, Math.max(0, toSafeInt(index, 0)));
}

async function persistPlayer(session, player) {
  if (!session || !session.userId || !player) return;
  const saved = await playerService.savePlayer(session.userId, player);
  if (saved) session.player = saved;
}

async function handleChangeMainPlan(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 2210, msgUid, data: { result: -1, index: 0, setInfo: normalizeSetInfo({}) } };
  }

  ensureEquipInfo(player);
  const index = Math.max(0, toSafeInt(params.index, player.equipInfo.curIndex || 0));
  player.equipInfo.curIndex = index;
  syncSpiritInfoFromCurrentPreset(player);
  const taskChanged = !!refreshMainTaskProgress(player);
  const setInfo = getSetInfoByIndex(player, index);
  await persistPlayer(session, player);

  const response = {
    tag: 2210,
    msgUid,
    data: {
      result: 0,
      index,
      setInfo,
    },
  };
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

async function handlePlanRename(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 2211, msgUid, data: { result: -1, name: '' } };
  }

  ensureEquipInfo(player);
  const index = Math.max(0, toSafeInt(player.equipInfo.curIndex, 0));
  const setInfo = getSetInfoByIndex(player, index);
  const name = String(params.name || '').trim().slice(0, 24);
  setInfo.name = name;
  await persistPlayer(session, player);

  return {
    tag: 2211,
    msgUid,
    data: {
      result: 0,
      name,
    },
  };
}

async function handleChangeBattlePlan(params = {}, session = {}, msgUid) {
  const player = session.player;
  if (!player) {
    return { tag: 2212, msgUid, data: { result: -1, id: 0, preset: 0 } };
  }

  ensureEquipInfo(player);
  player.equipInfo.raidSetMap = ensureObject(player.equipInfo.raidSetMap);
  const raidId = Math.max(0, toSafeInt(params.id, 0));
  const preset = Math.max(0, toSafeInt(params.preset, player.equipInfo.curIndex || 0));
  player.equipInfo.raidSetMap[String(raidId)] = preset;
  await persistPlayer(session, player);

  return {
    tag: 2212,
    msgUid,
    data: {
      result: 0,
      id: raidId,
      preset,
    },
  };
}

module.exports = {
  handleChangeMainPlan,
  handlePlanRename,
  handleChangeBattlePlan,
};
