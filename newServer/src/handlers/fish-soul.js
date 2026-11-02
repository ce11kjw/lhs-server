/** Fishing skill and fish-soul protocol (4030/4031/4060-4063/4070). */

const playerService = require('../services/PlayerService');
const configService = require('../services/ConfigService');
const { addRewardToPlayer } = require('./raid');
const { ensureFishInfo } = require('./fish');

const FISH_SOUL_BAIT_ITEM_ID = 65;

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

function configMap(name) {
  const value = configService.get(name);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstConfigId(name, fallback) {
  const ids = Object.keys(configMap(name)).map((key) => int(key, 0)).filter((id) => id > 0).sort((a, b) => a - b);
  return ids[0] || fallback;
}

function normalizeSkillMap(value) {
  const source = obj(value);
  const out = {};
  Object.keys(source).forEach((key) => {
    const index = Math.max(0, int(key, 0));
    const skillId = Math.max(0, int(source[key], 0));
    if (skillId > 0) out[index] = skillId;
  });
  return out;
}

function ensureFishSlot(info, type, uid = 0) {
  const key = String(Math.max(1, int(type, 1)));
  let row = obj(info.slots[key]);
  if (Object.keys(row).length === 0) {
    const fishId = firstConfigId('FishConfig', 5011);
    info.fishUidSeq = Math.max(1001, int(info.fishUidSeq, 1001) + 1);
    row = {
      uid: Math.max(1, int(uid, info.fishUidSeq)),
      id: fishId,
      type: Math.max(1, int(type, 1)),
      quality: 1,
      multi: 10000,
      attrs: [],
      skills: [],
      tempSkills: {},
      lock: 0,
      dead: 0,
    };
  }
  row.skills = arr(row.skills).map((v) => int(v, 0));
  row.tempSkills = normalizeSkillMap(row.tempSkills);
  info.slots[key] = row;
  return row;
}

function normalizeFishSoul(info, raw = {}) {
  const source = obj(raw);
  const soulConfig = configMap('FishSoulConfig');
  const requestedId = Math.max(0, int(source.id, 0));
  const id = soulConfig[requestedId] || soulConfig[String(requestedId)]
    ? requestedId
    : firstConfigId('FishSoulConfig', 1);
  const cfg = obj(soulConfig[id] || soulConfig[String(id)]);
  const asset = obj(configMap('AssetsConfig')[id] || configMap('AssetsConfig')[String(id)]);
  const type = Math.max(1, int(source.type, int(cfg.type, 1)));
  const slotIndex = Math.max(0, int(source.slotIndex, cfg.isUnusual ? int(cfg.index, 1) : 0));
  info.fishUidSeq = Math.max(1001, int(info.fishUidSeq, 1001) + 1);
  return {
    uid: Math.max(1, int(source.uid, info.fishUidSeq)),
    id,
    type,
    slotIndex,
    quality: Math.max(1, int(source.quality, int(asset.quality, 1))),
    multi: Math.max(1, int(source.multi, 10000)),
    minAddRate: arr(source.minAddRate || cfg.minAddRate),
    lock: int(source.lock, 0) ? 1 : 0,
    dead: int(source.dead, 0) ? 1 : 0,
    time: Math.max(0, int(source.time, Date.now())),
  };
}

function consumeItem(player, itemId, count) {
  const id = Math.max(1, int(itemId, 1));
  const need = Math.max(0, int(count, 0));
  if (need <= 0) return true;
  player.items = obj(player.items);
  const have = Math.max(0, int(player.items[id], 0));
  if (have < need) return false;
  player.items[id] = have - need;
  return true;
}

function buildItemSyncPacket(player, itemId, count) {
  const id = Math.max(1, int(itemId, 1));
  const used = Math.max(0, int(count, 0));
  return {
    tag: 1202,
    msgUid: 0,
    data: {
      result: 0,
      items: used > 0 ? [{ id, count: -used }] : [],
      changed: [{ id, count: Math.max(0, int(player && player.items && player.items[id], 0)) }],
    },
  };
}

function normalizeCatchResult(value) {
  const source = obj(value);
  return {
    ...source,
    time: Math.max(0, int(source.time, 0)),
    infos: arr(source.infos),
    escapes: arr(source.escapes),
    items: arr(source.items),
    sailItems: obj(source.sailItems),
  };
}

function buildFishSoulCatchResultPush(value) {
  return {
    tag: 4070,
    msgUid: 0,
    data: { catchResult: normalizeCatchResult(value) },
  };
}

function addFishingExp(info, amount) {
  info.exp = Math.max(0, int(info.exp, 0) + Math.max(0, int(amount, 0)));
  info.level = Math.max(1, int(info.level, 1));
  const levelConfig = configMap('FishLevelConfig');
  while (true) {
    const row = obj(levelConfig[info.level] || levelConfig[String(info.level)]);
    const need = Math.max(0, int(row.exp, 0));
    const next = levelConfig[info.level + 1] || levelConfig[String(info.level + 1)];
    if (need <= 0 || !next || info.exp < need) break;
    info.exp -= need;
    info.level += 1;
  }
}

function buildRewardInfo(player, rows = []) {
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

async function save(session) {
  if (session && session.userId && session.player) await playerService.savePlayer(session.userId, session.player);
}

async function handleRefreshSkill(params, session, msgUid) {
  const info = ensureFishInfo(session.player);
  const type = Math.max(1, int(params && params.type, 1));
  const slot = ensureFishSlot(info, type, params && params.uid);
  const index = Math.max(0, int(params && params.index, 0));
  const skillId = Math.max(1, int(params && params.skillId, firstConfigId('FishSkillConfig', 1)));
  slot.tempSkills[index] = skillId;
  await save(session);
  return { tag: 4030, msgUid, data: { result: 0, fishInfo: slot } };
}

async function handleReplaceSkill(params, session, msgUid) {
  const info = ensureFishInfo(session.player);
  const type = Math.max(1, int(params && params.type, 1));
  const slot = ensureFishSlot(info, type, params && params.uid);
  const index = Math.max(0, int(params && params.index, 0));
  const replacement = Math.max(0, int(params && params.skillId, slot.tempSkills[index] || 0));
  while (slot.skills.length <= index) slot.skills.push(0);
  if (int(params && params.replace, 1) !== 0 && replacement > 0) slot.skills[index] = replacement;
  delete slot.tempSkills[index];
  await save(session);
  return { tag: 4031, msgUid, data: { result: 0, fishInfo: slot } };
}

async function handleFishSoulFishing(params, session, msgUid) {
  if (!session || !session.player) {
    return {
      tag: 4060,
      msgUid,
      data: {
        result: -1,
        catchResult: { time: 0, infos: [], escapes: [], items: [], sailItems: {} },
        escape: 0,
        exp: 0,
        level: 1,
        isMe: true,
        isSpeed: false,
      },
    };
  }
  const info = ensureFishInfo(session.player);
  const count = Math.max(1, Math.min(10, int(params && params.count, 1)));
  const baitCost = Math.max(1, int(configMap('FishSoulBaseConfig').cost, 3)) * count;
  if (!consumeItem(session.player, FISH_SOUL_BAIT_ITEM_ID, baitCost)) {
    return {
      tag: 4060,
      msgUid,
      data: {
        result: 1,
        catchResult: { time: 0, infos: [], escapes: [], items: [], sailItems: {} },
        escape: 0,
        exp: info.exp,
        level: info.level,
        isMe: true,
        isSpeed: false,
      },
    };
  }
  const soulConfig = configMap('FishSoulConfig');
  const soulIds = Object.keys(soulConfig)
    .map((key) => int(key, 0))
    .filter((id) => id > 0 && Math.max(1, int(soulConfig[id] && soulConfig[id].levelShow, 1)) <= info.level)
    .sort((a, b) => a - b);
  const fallback = firstConfigId('FishSoulConfig', 1);
  const infos = [];
  let gainedExp = 0;
  for (let index = 0; index < count; index += 1) {
    const id = soulIds[index % Math.max(1, soulIds.length)] || fallback;
    const cfg = obj(soulConfig[id] || soulConfig[String(id)]);
    const maxMulti = Math.max(10000, int(cfg.maxKgValue, 10000));
    const multi = Math.min(maxMulti, 10000 + index * 100);
    infos.push(normalizeFishSoul(info, { id, multi }));
    gainedExp += Math.max(0, int(cfg.exp, 0));
  }
  addFishingExp(info, gainedExp);
  info.catchResult = {
    time: Date.now() + 800,
    infos,
    escapes: [],
    items: [],
    sailItems: {},
  };
  await save(session);
  return [
    buildItemSyncPacket(session.player, FISH_SOUL_BAIT_ITEM_ID, baitCost),
    { tag: 4060, msgUid, data: { result: 0, catchResult: info.catchResult, escape: 0, exp: info.exp, level: info.level, isMe: true, isSpeed: false } },
  ];
}

async function handleFishSoulDeal(_params, session, msgUid) {
  const info = ensureFishInfo(session.player);
  const caught = arr(info.catchResult && info.catchResult.infos).map((row) => normalizeFishSoul(info, row));
  const equipped = [];
  caught.forEach((row) => {
    const key = String(row.type);
    const slots = arr(info.fishSoulSlots[key]);
    const index = slots.findIndex((item) => int(item && item.slotIndex, 0) === row.slotIndex);
    if (index >= 0) slots[index] = row;
    else slots.push(row);
    info.fishSoulSlots[key] = slots;
    const pic = obj(info.fishSoulPic[row.id]);
    info.fishSoulPic[row.id] = { id: row.id, multi: Math.max(int(pic.multi, 0), row.multi), reward: int(pic.reward, 0), time: Date.now() };
    equipped.push(row);
  });
  info.catchResult = normalizeCatchResult(info.catchResult);
  info.catchResult.time = 0;
  info.catchResult.infos = [];
  await save(session);
  return [
    { tag: 4061, msgUid, data: { infos: equipped, rewards: [] } },
    buildFishSoulCatchResultPush(info.catchResult),
  ];
}

async function handleFishSoulIllus(_params, session, msgUid) {
  const info = ensureFishInfo(session.player);
  const soulConfig = configMap('FishSoulConfig');
  const ids = Object.keys(obj(info.fishSoulPic)).map((key) => int(key, 0)).filter((id) => (
    id > 0
    && !!(soulConfig[id] || soulConfig[String(id)])
    && int(info.fishSoulPic[id].reward, 0) === 0
  ));
  ids.forEach((id) => { info.fishSoulPic[id].reward = 1; });
  const rewardMap = new Map();
  ids.forEach((id) => {
    const row = obj(soulConfig[id] || soulConfig[String(id)]);
    arr(row.atlasReward).forEach((reward) => {
      const rewardId = Math.max(0, int(reward && reward.id, 0));
      const count = Math.max(0, int(reward && reward.count, 0));
      if (rewardId <= 0 || count <= 0) return;
      rewardMap.set(rewardId, (rewardMap.get(rewardId) || 0) + count);
    });
  });
  const reward = Array.from(rewardMap.entries()).map(([id, count]) => ({ id, count }));
  const rewardInfo = buildRewardInfo(session.player, reward);
  await save(session);
  return { tag: 4062, msgUid, data: { ids, rewards: rewardInfo.items } };
}

async function handleFishSoulOpenBox(params, session, msgUid) {
  const count = Math.max(1, Math.min(100, int(params && params.count, 1)));
  const reward = buildRewardInfo(session.player, [{ id: 2, count: count * 10 }]);
  await save(session);
  return { tag: 4063, msgUid, data: { result: 0, rewardInfo: reward } };
}

module.exports = {
  buildFishSoulCatchResultPush,
  handleRefreshSkill,
  handleReplaceSkill,
  handleFishSoulFishing,
  handleFishSoulDeal,
  handleFishSoulIllus,
  handleFishSoulOpenBox,
};
