/** Special spirit refining/equipment protocol (3610-3617). */

const playerService = require('../services/PlayerService');
const configService = require('../services/ConfigService');
const { addRewardToPlayer } = require('./raid');

const SLOT_TAGS = [101, 102, 103, 201, 202, 203];

function int(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rewardInfo(player, rows = []) {
  const items = [];
  arr(rows).forEach((row) => {
    const id = Math.max(0, int(row && row.id, 0));
    const count = Math.max(0, int(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    addRewardToPlayer(player, id, count);
    items.push({ id, count });
  });
  return { items, equips: [], heros: [] };
}

function getConfig() {
  const raw = configService.get('SpecSpiritConfig');
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function getConfigMap(name) {
  const raw = configService.get(name);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function getConfigRow(map, id) {
  const safeId = int(id, -1);
  if (safeId < 0) return null;
  return map[safeId] || map[String(safeId)] || null;
}

function pickConfigId(map, requested, fallback = 0) {
  const wanted = int(requested, fallback);
  if (getConfigRow(map, wanted)) return wanted;
  const ids = Object.keys(map)
    .map((key) => int(key, -1))
    .filter((id) => id >= 0 && getConfigRow(map, id))
    .sort((a, b) => a - b);
  if (ids.length <= 0) return fallback;
  const notAbove = ids.filter((id) => id <= wanted);
  return notAbove.length > 0 ? notAbove[notAbove.length - 1] : ids[0];
}

function pickSpiritId(tag = 0, requested = 0) {
  const cfg = getConfig();
  const wanted = int(requested, 0);
  if (wanted > 0 && (cfg[wanted] || cfg[String(wanted)])) return wanted;
  const ids = Object.keys(cfg).map((key) => int(key, 0)).filter((id) => id > 0);
  const match = ids.find((id) => {
    const row = obj(cfg[id] || cfg[String(id)]);
    return int(row.tag, int(row.type, 0)) === int(tag, 0);
  });
  return match || ids[0] || Math.max(1, wanted || 1);
}

function ensureInfo(player) {
  player.other_attr_info = obj(player.other_attr_info);
  const raw = obj(player.other_attr_info.specSpiritInfo);
  const info = player.other_attr_info.specSpiritInfo = raw;
  info.lv = Math.max(1, int(info.lv, 1));
  info.exp = Math.max(0, int(info.exp, 0));
  info.score = Math.max(0, int(info.score, 0));
  info.privilegeCount = Math.max(0, int(info.privilegeCount, 0));
  info.lastPrivilegeCheckTime = Math.max(0, int(info.lastPrivilegeCheckTime, 0));
  info.rewardCount = Math.max(0, int(info.rewardCount, 0));
  info.list = arr(info.list)
    .map((row) => normalizeSpirit(row))
    .filter((row, index, rows) => rows.findIndex((candidate) => candidate.uid === row.uid) === index);
  const spiritUidSet = new Set(info.list.map((row) => row.uid));
  const normalizedSlots = {};
  Object.keys(obj(info.slots)).forEach((key) => {
    const tag = Math.max(0, int(key, 0));
    const uid = Math.max(0, int(info.slots[key], 0));
    // The client iterates every slots entry and dereferences the UID without a null check.
    if (SLOT_TAGS.includes(tag) && uid > 0 && spiritUidSet.has(uid)) normalizedSlots[tag] = uid;
  });
  info.slots = normalizedSlots;
  const sourceSlotLv = obj(info.slotLv);
  info.slotLv = {};
  const levelCfg = getConfigMap('SpecSpiritLevelConfig');
  SLOT_TAGS.forEach((tag) => {
    info.slotLv[tag] = Math.max(1, pickConfigId(levelCfg, sourceSlotLv[tag], 1));
  });
  info.refineList = arr(info.refineList).map((v) => int(v, 0)).filter((v) => v > 0);
  const maxUid = info.list.reduce((max, row) => Math.max(max, row.uid), 0);
  info.uidSeq = Math.max(1, maxUid, int(info.uidSeq, Date.now() % 100000000));
  return info;
}

function normalizeSpirit(row = {}) {
  const source = obj(row);
  const id = pickSpiritId(0, source.id);
  const spiritCfg = obj(getConfigRow(getConfig(), id));
  const stage = Math.max(1, int(spiritCfg.stage, 1));
  const starCfg = obj(getConfigRow(getConfigMap('SpecSpiritStarConfig'), stage));
  const entryCfg = getConfigMap('SpecSpiritEntryConfig');
  const suitCfg = getConfigMap('SpecSpiritSuitConfig');
  const requestedSuit = Math.max(0, int(source.suit, 0));
  return {
    uid: Math.max(1, int(source.uid, 1)),
    id,
    star: Math.max(0, pickConfigId(starCfg, source.star, 0)),
    suit: requestedSuit > 0 && getConfigRow(suitCfg, requestedSuit) ? requestedSuit : 0,
    exp: Math.max(0, int(source.exp, 0)),
    lock: int(source.lock, 0) ? 1 : 0,
    entrys: arr(source.entrys || source.entries)
      .map((entry) => {
        const rawEntry = obj(entry);
        const idValue = Math.max(0, int(rawEntry.id, 0));
        const cfg = obj(getConfigRow(entryCfg, idValue));
        if (!cfg.id) return null;
        return {
          id: idValue,
          type: Math.max(0, int(cfg.attrId, int(rawEntry.type, 0))),
          value: Number.isFinite(Number(rawEntry.value)) ? Number(rawEntry.value) : 0,
        };
      })
      .filter(Boolean),
    time: Math.max(0, int(source.time, Date.now())),
  };
}

function payload(info) {
  return {
    ...clone(info),
    list: clone(info.list),
    slots: clone(info.slots),
    slotLv: clone(info.slotLv),
    refineList: clone(info.refineList),
  };
}

async function save(session) {
  if (session && session.userId && session.player) await playerService.savePlayer(session.userId, session.player);
}

async function handleSpecSpiritRefine(params, session, msgUid) {
  const info = ensureInfo(session.player);
  const count = Math.max(1, Math.min(20, int(params && params.count, 1)));
  const tag = Math.max(0, int(params && params.tag, 0));
  const id = pickSpiritId(tag, params && params.id);
  const infos = [];
  let suc = 0;
  for (let i = 0; i < count; i += 1) {
    info.uidSeq += 1;
    const spirit = normalizeSpirit({ uid: info.uidSeq, id, star: 0, exp: 0, lock: 0 });
    info.list.push(spirit);
    infos.push(spirit);
    suc += 1;
  }
  info.score += suc;
  info.exp += suc;
  const rewards = rewardInfo(session.player, []);
  await save(session);
  return { tag: 3610, msgUid, data: { ...payload(info), infos, decomposeIds: [], doubleScore: 0, fail: 0, suc, refund: 0, rewards: rewards.items } };
}

async function handleSpecSpiritEquip(params, session, msgUid) {
  const info = ensureInfo(session.player);
  const uid = Math.max(0, int(params && params.uid, 0));
  const spirit = info.list.find((row) => row.uid === uid);
  if (!spirit) return { tag: 3611, msgUid, data: { result: 1, id: 0, tag: 0 } };
  const cfg = obj(getConfig()[spirit.id] || getConfig()[String(spirit.id)]);
  const tag = Math.max(1, int(cfg.tag, int(cfg.type, 1)));
  Object.keys(info.slots).forEach((slotTag) => {
    if (info.slots[slotTag] === uid) delete info.slots[slotTag];
  });
  info.slots[tag] = uid;
  await save(session);
  return { tag: 3611, msgUid, data: { result: 0, id: uid, tag } };
}

async function handleSpecSpiritLevel(params, session, msgUid) {
  const info = ensureInfo(session.player);
  const tag = Math.max(1, int(params && params.tag, 1));
  const requested = Math.max(1, int(params && params.lv, int(info.slotLv[tag], 1) + 1));
  info.slotLv[tag] = Math.max(int(info.slotLv[tag], 1), requested);
  await save(session);
  return { tag: 3612, msgUid, data: { result: 0 } };
}

async function handleSpecSpiritStar(params, session, msgUid) {
  const info = ensureInfo(session.player);
  const uid = Math.max(0, int(params && params.uid, 0));
  const spirit = info.list.find((row) => row.uid === uid);
  if (!spirit) return { tag: 3613, msgUid, data: { uid, list: [], star: 0, exp: 0 } };
  const equippedUids = new Set(Object.values(info.slots).map((v) => int(v, 0)));
  const consumed = arr(params && params.list)
    .map((v) => int(v, 0))
    .filter((v) => v > 0 && v !== uid && !equippedUids.has(v));
  info.list = info.list.filter((row) => !consumed.includes(row.uid));
  spirit.star += Math.max(1, int(params && params.itemCount, 1));
  spirit.exp = 0;
  await save(session);
  return { tag: 3613, msgUid, data: { uid, list: consumed, star: spirit.star, exp: spirit.exp } };
}

async function handleSpecSpiritDecompose(params, session, msgUid) {
  const info = ensureInfo(session.player);
  const equippedUids = new Set(Object.values(info.slots).map((v) => int(v, 0)));
  const list = arr(params && params.list)
    .map((v) => int(v, 0))
    .filter((v) => v > 0 && !equippedUids.has(v));
  const removed = info.list.filter((row) => list.includes(row.uid));
  info.list = info.list.filter((row) => !list.includes(row.uid));
  const rewards = rewardInfo(session.player, [{ id: 2, count: removed.length * 10 }]);
  await save(session);
  return { tag: 3614, msgUid, data: { list: removed.map((row) => row.uid), rewards: rewards.items, uid: removed.map((row) => row.uid) } };
}

async function handleSpecSpiritUnlock(params, session, msgUid) {
  const info = ensureInfo(session.player);
  const tag = Math.max(1, int(params && params.tag, 1));
  if (!info.refineList.includes(tag)) info.refineList.push(tag);
  await save(session);
  return { tag: 3615, msgUid, data: { result: 0 } };
}

async function handleSpecSpiritReset(params, session, msgUid) {
  const info = ensureInfo(session.player);
  const uid = Math.max(0, int(params && params.uid, 0));
  const spirit = info.list.find((row) => row.uid === uid);
  if (!spirit) return { tag: 3616, msgUid, data: { rewards: [], spiritInfo: normalizeSpirit({ uid }) } };
  spirit.star = 0;
  spirit.exp = 0;
  const rewards = rewardInfo(session.player, [{ id: 2, count: 20 }]);
  await save(session);
  return { tag: 3616, msgUid, data: { rewards: rewards.items, spiritInfo: spirit } };
}

async function handleSpecSpiritLock(params, session, msgUid) {
  const info = ensureInfo(session.player);
  const uid = Math.max(0, int(params && params.uid, 0));
  const spirit = info.list.find((row) => row.uid === uid);
  if (!spirit) return { tag: 3617, msgUid, data: { result: 1 } };
  spirit.lock = int(params && params.lock, 0) ? 1 : 0;
  await save(session);
  return { tag: 3617, msgUid, data: { result: 0 } };
}

function buildSpecSpiritPayload(player) {
  return payload(ensureInfo(player));
}

module.exports = {
  ensureSpecSpiritInfo: ensureInfo,
  buildSpecSpiritPayload,
  handleSpecSpiritRefine,
  handleSpecSpiritEquip,
  handleSpecSpiritLevel,
  handleSpecSpiritStar,
  handleSpecSpiritDecompose,
  handleSpecSpiritUnlock,
  handleSpecSpiritReset,
  handleSpecSpiritLock,
};
