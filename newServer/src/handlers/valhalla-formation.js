const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const { addRewardToPlayer } = require('./raid');
const { ensureValhallaInfo } = require('./valhalla');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueInts(values = []) {
  const seen = new Set();
  const out = [];
  values.forEach((v) => {
    const n = toSafeInt(v, 0);
    if (n <= 0 || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  });
  return out;
}

function ensureArrayValue(obj, key) {
  if (!Array.isArray(obj[key])) obj[key] = [];
  return obj[key];
}

function toDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return Number(`${y}${m}${day}`);
}

function weightedPick(rows = [], getWeight = (row) => row.weight || 0) {
  const normalized = rows
    .map((row) => ({ row, weight: Math.max(0, toSafeInt(getWeight(row), 0)) }))
    .filter((entry) => entry.weight > 0);
  if (normalized.length === 0) return null;

  const total = normalized.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < normalized.length; i++) {
    roll -= normalized[i].weight;
    if (roll <= 0) return normalized[i].row;
  }
  return normalized[normalized.length - 1].row;
}

function buildRewardInfo(rows = []) {
  return {
    items: (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        id: toSafeInt(row && row.id, 0),
        count: Math.max(0, toSafeInt(row && row.count, 0)),
      }))
      .filter((row) => row.id > 0 && row.count > 0),
    equips: [],
    heros: [],
  };
}

function grantRewards(player, rows = []) {
  const merged = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const id = toSafeInt(row && row.id, 0);
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    addRewardToPlayer(player, id, count);
    merged.set(id, (merged.get(id) || 0) + count);
  });
  return Array.from(merged.entries()).map(([id, count]) => ({ id, count }));
}

function getValhallaFormationBaseConfig() {
  return config.get('ValhallaFormationBaseConfig') || {};
}

function getValhallaFormationKnotConfig() {
  return config.get('ValhallaFormationKnotConfig') || {};
}

function getValhallaFormationKnotWashConfig() {
  return config.get('ValhallaFormationKnotWashConfig') || {};
}

function getValhallaFormationKnotEntryConfig() {
  return config.get('ValhallaFormationKnotEntryConfig') || {};
}

function getValhallaFormationEntryBuffConfig() {
  return config.get('ValhallaFormationEntryBuffConfig') || {};
}

function getValhallaFormationEntryEchoConfig() {
  return config.get('ValhallaFormationEntryEchoConfig') || {};
}

function getValhallaFormationConnectItemConfig() {
  return config.get('ValhallaFormationConnectItemConfig') || {};
}

function getValhallaFormationConnectConfig() {
  return config.get('ValhallaFormationConnectConfig') || {};
}

function getValhallaFormationConnectShapeConfig() {
  return config.get('ValhallaFormationConnectShapeConfig') || {};
}

function getValhallaFormationTaskConfig() {
  return config.get('ValhallaFormationTaskConfig') || {};
}

function getValhallaFormationTaskHeroRateConfig() {
  return config.get('ValhallaFormationTaskHeroRateConfig') || {};
}

function getValhallaConfig() {
  return config.get('ValhallaConfig') || {};
}

const FALLBACK_KNOT_ID = 1;
const FALLBACK_CONNECT_ID = 231;

function buildDefaultFormationRow(id) {
  return {
    id,
    element: 0,
    nodeMap: {},
    echoEffect: [0, 0, 0],
  };
}

function buildDefaultKnotRowsByFormationId(formationId) {
  const knotCfg = getValhallaFormationKnotConfig();
  const formationMap = knotCfg[formationId] || {};
  const initialKnot = getValhallaFormationBaseConfig().initialKnot || [2, 10000];
  const defaultQuality = Math.max(2, toSafeInt(initialKnot[0], 2));
  const defaultAdd = Math.max(10000, toSafeInt(initialKnot[1], 10000));

  const out = [];
  Object.keys(formationMap).forEach((key) => {
    const row = formationMap[key];
    if (!row || toSafeInt(row.type, 0) !== 3) return;
    out.push({
      mapId: toSafeInt(row.mapId, formationId),
      id: toSafeInt(row.id, 0),
      quality: defaultQuality,
      add: defaultAdd,
      extra: false,
      lock: false,
      entries: [],
    });
  });

  if (out.length === 0) {
    out.push({
      mapId: Math.max(1, toSafeInt(formationId, 1)),
      id: FALLBACK_KNOT_ID,
      quality: defaultQuality,
      add: defaultAdd,
      extra: false,
      lock: false,
      entries: [],
    });
  }

  out.sort((a, b) => a.id - b.id);
  return out;
}

function ensureDenseFormationRows(info) {
  const normalized = (Array.isArray(info.formation) ? info.formation : [])
    .map((row) => normalizeFormationRow(row))
    .filter((row) => row.id > 0);
  const byId = new Map();
  let maxId = 1;
  normalized.forEach((row) => {
    byId.set(row.id, row);
    maxId = Math.max(maxId, row.id);
  });
  for (let id = 1; id <= maxId; id++) {
    if (!byId.has(id)) byId.set(id, buildDefaultFormationRow(id));
  }
  info.formation = Array.from(byId.values()).sort((a, b) => a.id - b.id);
  return info.formation;
}

function normalizeFormationRow(row) {
  const src = row && typeof row === 'object' ? row : {};
  const id = Math.max(1, toSafeInt(src.id, 1));
  const nodeMap = {};
  const connectCfg = getValhallaFormationConnectItemConfig();
  const validateConnectId = Object.keys(connectCfg).length > 0;
  if (src.nodeMap && typeof src.nodeMap === 'object') {
    Object.keys(src.nodeMap).forEach((key) => {
      const knotId = toSafeInt(key, 0);
      const connectId = toSafeInt(src.nodeMap[key], 0);
      if (knotId <= 0 || connectId <= 0) return;
      if (validateConnectId && !connectCfg[connectId] && !connectCfg[String(connectId)]) return;
      nodeMap[knotId] = connectId;
    });
  }
  const echoEffectRaw = Array.isArray(src.echoEffect) ? src.echoEffect : [];
  const echoEffect = [
    toSafeInt(echoEffectRaw[0], 0),
    toSafeInt(echoEffectRaw[1], 0),
    toSafeInt(echoEffectRaw[2], 0),
  ];

  return {
    id,
    element: Math.max(0, toSafeInt(src.element, 0)),
    nodeMap,
    echoEffect,
  };
}

function normalizeKnotRow(row) {
  const src = row && typeof row === 'object' ? row : {};
  const entryCfg = getValhallaFormationKnotEntryConfig();
  const validateEntryId = Object.keys(entryCfg).length > 0;
  const entries = Array.isArray(src.entries)
    ? src.entries
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const id = toSafeInt(entry.id, 0);
        if (id <= 0) return null;
        if (validateEntryId && !entryCfg[id] && !entryCfg[String(id)]) return null;
        const param = Array.isArray(entry.param)
          ? entry.param
            .filter((part) => Array.isArray(part) && part.length > 0)
            .map((part) => part.map((v) => toSafeInt(v, 0)))
          : [];
        return { id, param };
      })
      .filter(Boolean)
    : [];

  return {
    mapId: Math.max(1, toSafeInt(src.mapId, 1)),
    id: Math.max(1, toSafeInt(src.id, 1)),
    quality: Math.max(2, Math.min(7, toSafeInt(src.quality, 2))),
    add: Math.max(10000, toSafeInt(src.add, 10000)),
    extra: !!src.extra,
    lock: !!src.lock,
    entries,
  };
}

function normalizeConnectList(connect = []) {
  const merged = new Map();
  const connectCfg = getValhallaFormationConnectItemConfig();
  const validateConnectId = Object.keys(connectCfg).length > 0;
  (Array.isArray(connect) ? connect : []).forEach((row) => {
    const id = toSafeInt(row && row.id, 0);
    const count = Math.max(0, toSafeInt(row && row.count, 0));
    if (id <= 0 || count <= 0) return;
    if (validateConnectId && !connectCfg[id] && !connectCfg[String(id)]) return;
    merged.set(id, (merged.get(id) || 0) + count);
  });
  return Array.from(merged.entries())
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => a.id - b.id);
}

function getDefaultConnectList() {
  const connectItemCfg = getValhallaFormationConnectItemConfig();
  const out = [];
  Object.keys(connectItemCfg).forEach((key) => {
    const row = connectItemCfg[key];
    if (!row) return;
    const id = toSafeInt(row.id, 0);
    const level = Math.max(0, toSafeInt(row.level, 0));
    if (id <= 0 || level !== 1) return;
    out.push({ id, count: 60 });
  });
  out.sort((a, b) => a.id - b.id);
  if (out.length === 0) return [{ id: FALLBACK_CONNECT_ID, count: 60 }];
  return out;
}

function getFormationEchoBuffCount(info, formationId, effectId) {
  const entryConfig = getValhallaFormationKnotEntryConfig();
  const buffConfig = getValhallaFormationEntryBuffConfig();
  const buffCounts = new Map();

  ensureArrayValue(info, 'knot').forEach((knot) => {
    if (toSafeInt(knot && knot.mapId, 0) !== formationId) return;
    (Array.isArray(knot.entries) ? knot.entries : []).forEach((entry) => {
      const row = entryConfig[toSafeInt(entry && entry.id, 0)] || {};
      (Array.isArray(row.buff) ? row.buff : []).forEach((buffId) => {
        const id = toSafeInt(buffId, 0);
        if (id > 0) buffCounts.set(id, (buffCounts.get(id) || 0) + 1);
      });
    });
  });

  let total = 0;
  buffCounts.forEach((count, buffId) => {
    const row = buffConfig[buffId] || buffConfig[String(buffId)] || {};
    const args = Array.isArray(row.args) ? row.args : [];
    if (toSafeInt(row.type, 0) === 3 && toSafeInt(args[0], 0) === effectId) {
      total += toSafeInt(args[1], 0) * count;
    }
  });
  return total;
}

function canUseFreeKnotWash(info, formationId) {
  const formation = ensureArrayValue(info, 'formation')
    .find((row) => toSafeInt(row && row.id, 0) === formationId);
  if (!formation) return false;
  if (!Array.isArray(formation.echoEffect)) formation.echoEffect = [0, 0, 0];
  while (formation.echoEffect.length < 3) formation.echoEffect.push(0);
  if (toSafeInt(formation.echoEffect[2], 0) > 0) return false;

  const echoConfig = getValhallaFormationEntryEchoConfig();
  const freeWash = echoConfig[2] || echoConfig['2'] || {};
  const trigger = Math.max(1, toSafeInt(freeWash.trigger, 1));
  return getFormationEchoBuffCount(info, formationId, 2) >= trigger;
}

function normalizeTaskRow(row) {
  const src = row && typeof row === 'object' ? row : {};
  return {
    pos: Math.max(0, toSafeInt(src.pos, 0)),
    id: Math.max(1, toSafeInt(src.id, 1)),
    success: toSafeInt(src.success, 0) > 0 ? 1 : 0,
    finishTime: Math.max(0, toSafeInt(src.finishTime, 0)),
    claimed: !!src.claimed,
    members: uniqueInts(Array.isArray(src.members) ? src.members : []),
  };
}

function pickTaskIdByStar(star = 1) {
  const taskCfg = getValhallaFormationTaskConfig();
  const rows = Object.keys(taskCfg)
    .map((key) => taskCfg[key])
    .filter((row) => row && toSafeInt(row.star, 0) === star);
  const selected = weightedPick(rows, (row) => toSafeInt(row.weight, 0));
  if (!selected) return -1;
  return toSafeInt(selected.id, -1);
}

function generateTaskByPos(pos = 0) {
  const baseCfg = getValhallaFormationBaseConfig();
  const taskCfg = getValhallaFormationTaskConfig();
  const firstTask = Array.isArray(baseCfg.firstTask) ? baseCfg.firstTask : [];

  let taskId = toSafeInt(firstTask[pos], -1);
  if (taskId <= 0 || !taskCfg[taskId]) {
    const starWeights = Array.isArray(baseCfg.taskStarWeight) ? baseCfg.taskStarWeight : [];
    const selectedStar = weightedPick(starWeights, (row) => toSafeInt(row && row.weight, 0));
    const star = Math.max(1, toSafeInt(selectedStar && selectedStar.id, 1));
    taskId = pickTaskIdByStar(star);
  }

  if (taskId <= 0 || !taskCfg[taskId]) {
    const fallbackId = Object.keys(taskCfg)
      .map((key) => toSafeInt(key, 0))
      .filter((id) => id > 0)
      .sort((a, b) => a - b)[0] || 1;
    taskId = fallbackId;
  }

  return {
    pos,
    id: taskId,
    success: 0,
    finishTime: 0,
    claimed: false,
    members: [],
  };
}

function getCurrencyKeyByItemId(itemId) {
  const id = toSafeInt(itemId, 0);
  if (id === 1) return 'diamond';
  if (id === 2) return 'silver';
  if (id === 6) return 'gold';
  return '';
}

function consumeItem(player, itemId, count) {
  const id = toSafeInt(itemId, 0);
  const need = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || need <= 0) return true;

  const currencyKey = getCurrencyKeyByItemId(id);
  if (currencyKey) {
    player.currencies = player.currencies && typeof player.currencies === 'object'
      ? player.currencies
      : {};
    if (Number.isFinite(Number(player.currencies[currencyKey]))) {
      const have = Math.max(0, toSafeInt(player.currencies[currencyKey], 0));
      if (have < need) return false;
      player.currencies[currencyKey] = have - need;
      return true;
    }
  }

  player.items = player.items || {};
  const have = Math.max(0, toSafeInt(player.items[id], 0));
  if (have < need) return false;
  player.items[id] = have - need;
  return true;
}

function hasEnoughItem(player, itemId, count) {
  const id = toSafeInt(itemId, 0);
  const need = Math.max(0, toSafeInt(count, 0));
  if (id <= 0 || need <= 0) return true;
  const currencyKey = getCurrencyKeyByItemId(id);
  if (currencyKey && Number.isFinite(Number(player && player.currencies && player.currencies[currencyKey]))) {
    return Math.max(0, toSafeInt(player.currencies[currencyKey], 0)) >= need;
  }
  const items = player && player.items && typeof player.items === 'object' ? player.items : {};
  return Math.max(0, toSafeInt(items[id], 0)) >= need;
}

function hasEnoughCosts(player, costs = [], multiplier = 1) {
  const times = Math.max(0, toSafeInt(multiplier, 0));
  return (Array.isArray(costs) ? costs : []).every((cost) => (
    hasEnoughItem(
      player,
      toSafeInt(cost && cost.id, 0),
      Math.max(0, toSafeInt(cost && cost.count, 0)) * times
    )
  ));
}

function consumeCosts(player, costs = [], multiplier = 1) {
  if (!hasEnoughCosts(player, costs, multiplier)) return false;
  const times = Math.max(0, toSafeInt(multiplier, 0));
  (Array.isArray(costs) ? costs : []).forEach((cost) => {
    consumeItem(
      player,
      toSafeInt(cost && cost.id, 0),
      Math.max(0, toSafeInt(cost && cost.count, 0)) * times
    );
  });
  return true;
}

function upsertConnect(info, id, delta) {
  const connectId = toSafeInt(id, 0);
  if (connectId <= 0) return;

  const amount = toSafeInt(delta, 0);
  if (amount === 0) return;

  if (!Array.isArray(info.connect)) info.connect = [];
  const idx = info.connect.findIndex((row) => toSafeInt(row && row.id, 0) === connectId);
  if (idx < 0) {
    if (amount > 0) info.connect.push({ id: connectId, count: amount });
    return;
  }

  const cur = Math.max(0, toSafeInt(info.connect[idx].count, 0));
  const next = cur + amount;
  if (next <= 0) {
    info.connect.splice(idx, 1);
    return;
  }
  info.connect[idx].count = next;
}

function getConnectCount(info, id) {
  const connectId = toSafeInt(id, 0);
  const row = ensureArrayValue(info, 'connect')
    .find((entry) => toSafeInt(entry && entry.id, 0) === connectId);
  return row ? Math.max(0, toSafeInt(row.count, 0)) : 0;
}

function buildConnectUpdateRows(info, ids = []) {
  return uniqueInts(ids)
    .sort((a, b) => a - b)
    .map((id) => ({ id, count: getConnectCount(info, id) }));
}

function getConnectMeta(id) {
  const itemCfg = getValhallaFormationConnectItemConfig();
  const shapeCfg = getValhallaFormationConnectShapeConfig();
  const row = itemCfg[toSafeInt(id, 0)] || {};
  const shape = toSafeInt(row.shape, 0);
  const shapeRow = shapeCfg[shape] || shapeCfg[String(shape)] || {};
  return {
    row,
    id: toSafeInt(row.id, 0),
    level: Math.max(0, toSafeInt(row.level, 0)),
    shape,
    dir: Math.max(0, toSafeInt(shapeRow.dir, 0)),
  };
}

function getConnectLevelConfig(level, dir) {
  const levelMap = getValhallaFormationConnectConfig()[level]
    || getValhallaFormationConnectConfig()[String(level)]
    || {};
  return levelMap[dir] || levelMap[String(dir)] || {};
}

function buildConnectMutationPackets(tag, msgUid, data, info, changedIds) {
  const connects = buildConnectUpdateRows(info, changedIds);
  if (connects.length === 0) return { tag, msgUid, data };
  return [
    { tag, msgUid, data },
    { tag: 6801, msgUid: 0, data: { connects } },
  ];
}

function buildNextKnotData(knot) {
  const source = normalizeKnotRow(knot);
  const qualityRoll = weightedPick([
    { id: 2, weight: 3400 },
    { id: 3, weight: 2500 },
    { id: 4, weight: 1800 },
    { id: 5, weight: 1200 },
    { id: 6, weight: 800 },
    { id: 7, weight: 300 },
  ]);
  const quality = qualityRoll ? toSafeInt(qualityRoll.id, source.quality) : source.quality;

  const washCfg = (config.get('ValhallaFormationKnotWashConfig') || {})[quality] || {};
  const addPick = weightedPick(
    Array.isArray(washCfg.hitWeight) ? washCfg.hitWeight : [],
    (row) => toSafeInt(Array.isArray(row) ? row[1] : 0, 0)
  );
  const add = Array.isArray(addPick) ? Math.max(10000, toSafeInt(addPick[0], source.add)) : source.add;

  const extraChance = Math.max(0, toSafeInt(washCfg.baseExtraP, 0));
  const extra = Math.random() * 10000 < extraChance;

  let entryCount = 0;
  const entryCountPick = weightedPick(Array.isArray(washCfg.entryP) ? washCfg.entryP : []);
  if (entryCountPick) entryCount = Math.max(0, toSafeInt(entryCountPick.id, 0));

  const showCfg = getValhallaFormationBaseConfig().entryShow || [1, 2];
  const maxEntry = Math.max(0, toSafeInt(showCfg[0], 0) + toSafeInt(showCfg[1], 0));
  entryCount = Math.max(0, Math.min(entryCount, maxEntry));

  const entryCfg = config.get('ValhallaFormationKnotEntryConfig') || {};
  const entryPool = Object.keys(entryCfg)
    .map((key) => entryCfg[key])
    .filter((row) => row && toSafeInt(row.id, 0) > 0);
  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const picked = weightedPick(entryPool, (row) => toSafeInt(row.weight, 0));
    if (!picked) break;
    entries.push({ id: toSafeInt(picked.id, 0), param: [] });
  }

  return {
    mapId: source.mapId,
    id: source.id,
    quality,
    add,
    extra,
    lock: source.lock,
    entries,
  };
}

function computeTaskSuccess(taskId, members = [], player) {
  const taskCfg = getValhallaFormationTaskConfig();
  const row = taskCfg[taskId] || {};
  const baseCfg = getValhallaFormationBaseConfig();
  let success = Math.max(0, toSafeInt(row.baseSuccess, 4500));

  const valhallaInfo = ensureValhallaInfo(player);
  const heroById = {};
  (Array.isArray(valhallaInfo.valhalla) ? valhallaInfo.valhalla : []).forEach((hero) => {
    const heroId = toSafeInt(hero && hero.id, 0);
    if (heroId <= 0) return;
    const cur = heroById[heroId];
    const level = Math.max(1, toSafeInt(hero && hero.level, 1));
    if (!cur || level > cur.level) {
      heroById[heroId] = { level, id: heroId };
    }
  });

  const valhallaCfg = getValhallaConfig();
  const heroRateCfg = getValhallaFormationTaskHeroRateConfig();

  uniqueInts(members).forEach((heroId) => {
    const hero = heroById[heroId];
    if (!hero) return;
    const heroCfg = valhallaCfg[heroId] || {};
    const quality = Math.max(0, toSafeInt(heroCfg.quality, 0));
    const rateRow = heroRateCfg[quality] || {};
    success += Math.max(0, toSafeInt(rateRow.baseSuccess, 0));
    success += Math.max(0, toSafeInt(rateRow.levelSuccess, 0)) * hero.level;
  });

  const minTaskSuccess = Math.max(0, toSafeInt(baseCfg.minTaskSuccess, 0));
  success = Math.max(minTaskSuccess, success);
  success = Math.max(0, Math.min(10000, success));
  return success;
}

function ensureValhallaFormationInfo(player) {
  player.other_attr_info = player.other_attr_info && typeof player.other_attr_info === 'object' && !Array.isArray(player.other_attr_info)
    ? player.other_attr_info
    : {};

  const holder = player.other_attr_info;
  holder.valhallaFormationInfo = holder.valhallaFormationInfo && typeof holder.valhallaFormationInfo === 'object' && !Array.isArray(holder.valhallaFormationInfo)
    ? holder.valhallaFormationInfo
    : {};

  const info = holder.valhallaFormationInfo;
  ensureArrayValue(info, 'formation');
  ensureArrayValue(info, 'knot');
  ensureArrayValue(info, 'knotWash');
  ensureArrayValue(info, 'connect');
  ensureArrayValue(info, 'task');

  ensureDenseFormationRows(info);

  const formationIdSet = new Set(info.formation.map((row) => row.id));

  const knotCfg = getValhallaFormationKnotConfig();
  const validateKnotId = Object.keys(knotCfg).length > 0;
  const normalizedKnots = info.knot
    .map((row) => normalizeKnotRow(row))
    .filter((row) => formationIdSet.has(row.mapId))
    .filter((row) => {
      if (!validateKnotId) return true;
      const formationCfg = knotCfg[row.mapId] || knotCfg[String(row.mapId)] || {};
      const configRow = formationCfg[row.id] || formationCfg[String(row.id)];
      return !!configRow && toSafeInt(configRow.type, 0) === 3;
    });
  const uniqueKnots = new Map();
  normalizedKnots.forEach((row) => {
    const key = `${row.mapId}:${row.id}`;
    if (!uniqueKnots.has(key)) uniqueKnots.set(key, row);
  });
  info.knot = Array.from(uniqueKnots.values());

  const knotMap = new Map(info.knot.map((row) => [`${row.mapId}:${row.id}`, row]));
  info.formation.forEach((formation) => {
    const defaults = buildDefaultKnotRowsByFormationId(formation.id);
    defaults.forEach((row) => {
      const key = `${row.mapId}:${row.id}`;
      if (knotMap.has(key)) return;
      info.knot.push(row);
      knotMap.set(key, row);
    });
  });

  info.knot.sort((a, b) => (a.mapId - b.mapId) || (a.id - b.id));

  const uniqueWash = new Map();
  info.knotWash
    .map((row) => normalizeKnotRow(row))
    .filter((row) => formationIdSet.has(row.mapId))
    .forEach((row) => {
      if (!uniqueWash.has(row.mapId)) uniqueWash.set(row.mapId, row);
    });
  info.knotWash = Array.from(uniqueWash.values())
    .sort((a, b) => a.mapId - b.mapId);

  info.connect = normalizeConnectList(info.connect);
  if (info.connect.length === 0) {
    info.connect = getDefaultConnectList();
  }

  info.task = info.task.map((row) => normalizeTaskRow(row));
  const dailyTaskNum = Math.max(1, toSafeInt(getValhallaFormationBaseConfig().dailyTaskNum, 4));
  const curDay = toDayKey();
  if (toSafeInt(info.taskDate, 0) !== curDay || info.task.length < dailyTaskNum) {
    const next = [];
    for (let pos = 0; pos < dailyTaskNum; pos++) {
      next.push(generateTaskByPos(pos));
    }
    info.task = next;
    info.taskDate = curDay;
  } else {
    const taskByPos = new Map();
    info.task
      .filter((task) => task.pos >= 0 && task.pos < dailyTaskNum)
      .forEach((task) => {
        if (!taskByPos.has(task.pos)) taskByPos.set(task.pos, task);
      });
    info.task = Array.from(taskByPos.values());
    for (let pos = 0; pos < dailyTaskNum; pos++) {
      if (!info.task.some((task) => task.pos === pos)) {
        info.task.push(generateTaskByPos(pos));
      }
    }
    info.task.sort((a, b) => a.pos - b.pos);
  }

  return info;
}

function buildValhallaFormationPayload(info) {
  return {
    formation: clonePlain(info.formation),
    knot: clonePlain(info.knot),
    knotWash: clonePlain(info.knotWash),
    connect: clonePlain(info.connect),
    task: clonePlain(info.task),
  };
}

function getFormationById(info, formationId) {
  const id = Math.max(1, toSafeInt(formationId, 1));
  let row = info.formation.find((formation) => formation.id === id);
  if (row) return row;

  row = buildDefaultFormationRow(id);
  info.formation.push(row);
  ensureDenseFormationRows(info);

  const defaults = buildDefaultKnotRowsByFormationId(id);
  const exists = new Set(info.knot.map((knot) => `${knot.mapId}:${knot.id}`));
  defaults.forEach((knot) => {
    const key = `${knot.mapId}:${knot.id}`;
    if (exists.has(key)) return;
    info.knot.push(knot);
  });
  info.knot.sort((a, b) => (a.mapId - b.mapId) || (a.id - b.id));
  return info.formation.find((formation) => formation.id === id) || row;
}

function getKnot(info, formationId, knotId) {
  const mapId = Math.max(1, toSafeInt(formationId, 1));
  const id = Math.max(1, toSafeInt(knotId, 1));
  return info.knot.find((knot) => knot.mapId === mapId && knot.id === id) || null;
}

function setKnot(info, knotData) {
  const knot = normalizeKnotRow(knotData);
  const idx = info.knot.findIndex((row) => row.mapId === knot.mapId && row.id === knot.id);
  if (idx >= 0) {
    info.knot[idx] = knot;
  } else {
    info.knot.push(knot);
    info.knot.sort((a, b) => (a.mapId - b.mapId) || (a.id - b.id));
  }
  return knot;
}

function setTempKnot(info, knotData) {
  const knot = normalizeKnotRow(knotData);
  const idx = info.knotWash.findIndex((row) => row.mapId === knot.mapId);
  if (idx >= 0) info.knotWash[idx] = knot;
  else info.knotWash.push(knot);
  return knot;
}

function getTempKnot(info, formationId) {
  const mapId = Math.max(1, toSafeInt(formationId, 1));
  return info.knotWash.find((row) => row.mapId === mapId) || null;
}

function clearTempKnot(info, formationId) {
  const mapId = Math.max(1, toSafeInt(formationId, 1));
  info.knotWash = info.knotWash.filter((row) => row.mapId !== mapId);
}

async function savePlayer(session) {
  if (!session || !session.userId || !session.player) return;
  await playerService.savePlayer(session.userId, session.player);
}

async function handleValhallaFormationSet(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6800, msgUid, data: { result: -1, formation: buildDefaultFormationRow(1) } };

  const info = ensureValhallaFormationInfo(player);
  const formationId = Math.max(1, toSafeInt(params && params.formation, 1));
  const formation = getFormationById(info, formationId);

  const knots = Array.isArray(params && params.knots) ? params.knots : [];
  const connects = Array.isArray(params && params.connects) ? params.connects : [];
  const len = Math.min(knots.length, connects.length);
  const requested = new Map();
  for (let i = 0; i < len; i++) {
    const knotId = Math.max(1, toSafeInt(knots[i], 1));
    const connectId = toSafeInt(connects[i], -1);
    requested.set(knotId, connectId > 0 ? connectId : 0);
  }

  const deltas = new Map();
  requested.forEach((connectId, knotId) => {
    const oldId = toSafeInt(formation.nodeMap[knotId], 0);
    if (oldId === connectId) return;
    if (oldId > 0) deltas.set(oldId, (deltas.get(oldId) || 0) + 1);
    if (connectId > 0) deltas.set(connectId, (deltas.get(connectId) || 0) - 1);
  });

  const hasAllConnects = Array.from(deltas.entries())
    .every(([id, delta]) => getConnectCount(info, id) + delta >= 0);
  if (!hasAllConnects) {
    return { tag: 6800, msgUid, data: { result: 1, formation: clonePlain(formation) } };
  }

  deltas.forEach((delta, id) => upsertConnect(info, id, delta));
  requested.forEach((connectId, knotId) => {
    if (connectId > 0) formation.nodeMap[knotId] = connectId;
    else delete formation.nodeMap[knotId];
  });

  await savePlayer(session);
  return buildConnectMutationPackets(
    6800,
    msgUid,
    { result: 0, formation: clonePlain(formation) },
    info,
    Array.from(deltas.keys())
  );
}

async function handleValhallaFormationSwitchElement(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6801, msgUid, data: { result: -1, formation: 1, element: 0 } };

  const info = ensureValhallaFormationInfo(player);
  const formationId = Math.max(1, toSafeInt(params && params.formation, 1));
  const element = Math.max(0, toSafeInt(params && params.element, 0));

  const formation = getFormationById(info, formationId);
  formation.element = element;

  await savePlayer(session);
  return { tag: 6801, msgUid, data: { result: 0, formation: formationId, element } };
}

async function handleValhallaFormationGetInfo(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6802, msgUid, data: { result: -1, formation: buildDefaultFormationRow(1) } };

  const info = ensureValhallaFormationInfo(player);
  const formationId = Math.max(1, toSafeInt(params && params.formation, 1));
  const formation = getFormationById(info, formationId);

  await savePlayer(session);
  return [
    { tag: 6802, msgUid, data: { result: 0, formation: clonePlain(formation) } },
    { tag: 6802, msgUid: 0, data: { tasks: clonePlain(info.task) } },
  ];
}

async function handleValhallaFormationKnotWash(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 6803,
      msgUid,
      data: { result: 1, data: normalizeKnotRow({}), free: 0 },
    };
  }

  const info = ensureValhallaFormationInfo(player);
  const formationId = Math.max(1, toSafeInt(params && params.formation, 1));
  const knotId = Math.max(1, toSafeInt(params && params.knot, 1));
  const itemId = toSafeInt(params && params.itemId, -1);

  const knot = getKnot(info, formationId, knotId);
  if (!knot) {
    return {
      tag: 6803,
      msgUid,
      data: { result: 1, data: normalizeKnotRow({ mapId: formationId, id: knotId }), free: 0 },
    };
  }

  const nextKnot = buildNextKnotData(knot);
  let tempId = null;
  let free = 0;
  if (itemId > 0) {
    if (!hasEnoughItem(player, itemId, 1)) {
      return { tag: 6803, msgUid, data: { result: 1, data: clonePlain(knot), free: 0 } };
    }
    consumeItem(player, itemId, 1);
    setTempKnot(info, nextKnot);
    tempId = formationId;
  } else {
    const formation = info.formation.find((row) => toSafeInt(row && row.id, 0) === formationId);
    if (canUseFreeKnotWash(info, formationId)) {
      free = 1;
      formation.echoEffect[2] = 1;
    } else {
      const washTable = getValhallaFormationKnotWashConfig();
      const washConfig = washTable[knot.quality] || washTable[String(knot.quality)] || {};
      const costs = Array.isArray(washConfig.washCosts) ? washConfig.washCosts : [];
      if (!costs.every((cost) => hasEnoughItem(player, cost.id, cost.count))) {
        return { tag: 6803, msgUid, data: { result: 1, data: clonePlain(knot), free: 0 } };
      }
      costs.forEach((cost) => consumeItem(player, cost.id, cost.count));
    }
    setKnot(info, nextKnot);
  }

  await savePlayer(session);

  const data = {
    result: 0,
    data: clonePlain(nextKnot),
    free,
  };
  if (tempId) data.tempId = tempId;
  return { tag: 6803, msgUid, data };
}

async function handleValhallaFormationKnotWashConfirm(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6804, msgUid, data: { result: -1, knot: null } };

  const info = ensureValhallaFormationInfo(player);
  const formationId = Math.max(1, toSafeInt(params && params.formation, 1));
  const knotId = Math.max(1, toSafeInt(params && params.knot, 1));
  const confirm = Math.max(0, toSafeInt(params && params.confirm, 0));

  const current = getKnot(info, formationId, knotId);
  const temp = getTempKnot(info, formationId);

  let resultKnot = current;
  if (temp && toSafeInt(temp.id, 0) === knotId && confirm === 0) {
    resultKnot = setKnot(info, temp);
  }
  clearTempKnot(info, formationId);

  await savePlayer(session);
  return { tag: 6804, msgUid, data: { result: 0, knot: clonePlain(resultKnot || current) } };
}

async function handleValhallaFormationConnectUpgrade(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6805, msgUid, data: { result: -1, rewardInfo: buildRewardInfo([]) } };

  const info = ensureValhallaFormationInfo(player);
  const id = toSafeInt(params && params.id, -1);
  const count = toSafeInt(params && params.count, -1);
  const targetLevel = Math.max(1, toSafeInt(params && params.level, 1));
  const connectItemCfg = getValhallaFormationConnectItemConfig();
  const changedIds = new Set();
  const rewardRows = [];

  if (id < 0 && count < 0) {
    for (let level = 1; level < targetLevel; level++) {
      const sourceRows = info.connect
        .filter((row) => getConnectMeta(row && row.id).level === level)
        .map((row) => ({ id: toSafeInt(row.id, 0) }));
      sourceRows.forEach((source) => {
        const meta = getConnectMeta(source.id);
        const nextId = toSafeInt(meta.row.nextlevelId, 0);
        if (nextId <= 0) return;
        const levelCfg = getConnectLevelConfig(meta.level, meta.dir);
        const costs = Math.max(1, toSafeInt(levelCfg.costs, 1));
        let composeCount = Math.floor(getConnectCount(info, source.id) / costs);
        const extraCost = Math.max(0, toSafeInt(levelCfg.extraCosts, 0));
        if (extraCost > 0) {
          const extraItemId = toSafeInt(getValhallaFormationBaseConfig().extraLevelItem, 0);
          const haveExtra = player.items && toSafeInt(player.items[extraItemId], 0);
          composeCount = Math.min(composeCount, Math.floor(haveExtra / extraCost));
          if (composeCount > 0) consumeItem(player, extraItemId, extraCost * composeCount);
        }
        if (composeCount <= 0) return;
        upsertConnect(info, source.id, -(costs * composeCount));
        upsertConnect(info, nextId, composeCount);
        changedIds.add(source.id);
        changedIds.add(nextId);
        rewardRows.push({ id: nextId, count: composeCount });
      });
    }
  } else {
    const curMeta = getConnectMeta(id);
    const nextId = toSafeInt(curMeta.row.nextlevelId, 0);
    const outputCount = Math.max(1, count);
    const levelCfg = getConnectLevelConfig(curMeta.level, curMeta.dir);
    const costs = Math.max(1, toSafeInt(levelCfg.costs, 1));
    const requiredCount = costs * outputCount;
    const extraCost = Math.max(0, toSafeInt(levelCfg.extraCosts, 0));
    const extraItemId = toSafeInt(getValhallaFormationBaseConfig().extraLevelItem, 0);
    const hasExtra = extraCost <= 0 || hasEnoughItem(player, extraItemId, extraCost * outputCount);
    if (!connectItemCfg[id] || nextId <= 0 || getConnectCount(info, id) < requiredCount || !hasExtra) {
      return { tag: 6805, msgUid, data: { result: 1, rewardInfo: buildRewardInfo([]) } };
    }
    if (extraCost > 0) consumeItem(player, extraItemId, extraCost * outputCount);
    upsertConnect(info, id, -requiredCount);
    upsertConnect(info, nextId, outputCount);
    changedIds.add(id);
    changedIds.add(nextId);
    rewardRows.push({ id: nextId, count: outputCount });
  }

  if (changedIds.size === 0) {
    return { tag: 6805, msgUid, data: { result: 1, rewardInfo: buildRewardInfo([]) } };
  }
  const rewardInfo = buildRewardInfo(rewardRows);

  await savePlayer(session);
  return buildConnectMutationPackets(
    6805,
    msgUid,
    { result: 0, rewardInfo },
    info,
    Array.from(changedIds)
  );
}

async function handleValhallaFormationConnectTransform(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 6806,
      msgUid,
      data: { result: -1, id: 0, shape: 0, newId: 0, rewardInfo: buildRewardInfo([]) },
    };
  }

  const info = ensureValhallaFormationInfo(player);
  const id = Math.max(1, toSafeInt(params && params.id, 1));
  const requestedShape = toSafeInt(params && params.shape, -1);

  const connectItemCfg = getValhallaFormationConnectItemConfig();
  const shapeCfg = getValhallaFormationConnectShapeConfig();
  const currentMeta = getConnectMeta(id);
  const level = currentMeta.level;
  if (!currentMeta.id || level <= 0 || getConnectCount(info, id) <= 0) {
    return {
      tag: 6806,
      msgUid,
      data: { result: 1, id, shape: requestedShape, newId: 0, rewardInfo: buildRewardInfo([]) },
    };
  }

  let targetShape = requestedShape;
  if (targetShape < 0) {
    const candidates = Object.keys(shapeCfg)
      .map((key) => shapeCfg[key])
      .filter((row) => row && toSafeInt(row.id, 0) !== currentMeta.shape)
      .filter((row) => Object.keys(connectItemCfg).some((key) => {
        const item = connectItemCfg[key];
        return item
          && toSafeInt(item.level, 0) === level
          && toSafeInt(item.shape, 0) === toSafeInt(row.id, 0);
      }));
    const selected = weightedPick(candidates, (row) => toSafeInt(row.weight, 1));
    targetShape = toSafeInt(selected && selected.id, 0);
  }

  let newId = 0;
  Object.keys(connectItemCfg).forEach((key) => {
    const row = connectItemCfg[key];
    if (!row) return;
    if (toSafeInt(row.level, 0) !== level) return;
    if (toSafeInt(row.shape, 0) !== targetShape) return;
    newId = toSafeInt(row.id, 0);
  });

  const levelCfg = getConnectLevelConfig(level, currentMeta.dir);
  const costs = requestedShape < 0 ? levelCfg.exchangeOnce : levelCfg.exchangeSpecify;
  if (newId <= 0 || newId === id || !hasEnoughCosts(player, costs, 1)) {
    return {
      tag: 6806,
      msgUid,
      data: { result: 1, id, shape: targetShape, newId, rewardInfo: buildRewardInfo([]) },
    };
  }

  consumeCosts(player, costs, 1);
  upsertConnect(info, id, -1);
  upsertConnect(info, newId, 1);
  const rewardInfo = buildRewardInfo([{ id: newId, count: 1 }]);

  await savePlayer(session);
  return buildConnectMutationPackets(
    6806,
    msgUid,
    { result: 0, id, shape: targetShape, newId, rewardInfo },
    info,
    [id, newId]
  );
}

async function handleValhallaFormationKnotLock(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6807, msgUid, data: { result: -1, data: null } };

  const info = ensureValhallaFormationInfo(player);
  const formationId = Math.max(1, toSafeInt(params && params.formation, 1));
  const knotId = Math.max(1, toSafeInt(params && params.knot, 1));
  const lock = !!(params && params.lock);

  const knot = getKnot(info, formationId, knotId);
  if (!knot) return { tag: 6807, msgUid, data: { result: -1, data: null } };

  knot.lock = lock;
  setKnot(info, knot);

  await savePlayer(session);
  return { tag: 6807, msgUid, data: { result: 0, data: clonePlain(knot) } };
}

async function handleValhallaFormationTaskStart(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6810, msgUid, data: { result: -1, taskData: null } };

  const info = ensureValhallaFormationInfo(player);
  const pos = Math.max(0, toSafeInt(params && params.pos, 0));
  const members = uniqueInts(Array.isArray(params && params.member) ? params.member : []);

  let task = info.task.find((row) => row.pos === pos);
  if (!task) {
    task = generateTaskByPos(pos);
    info.task.push(task);
    info.task.sort((a, b) => a.pos - b.pos);
  }

  const taskCfg = getValhallaFormationTaskConfig()[task.id] || {};
  const heroNum = Math.max(1, toSafeInt(taskCfg.heroNum, 1));
  task.members = members.slice(0, heroNum);
  task.claimed = false;
  const successRate = computeTaskSuccess(task.id, task.members, player);
  task.success = Math.random() * 10000 < successRate ? 1 : 0;
  task.finishTime = Date.now() + Math.max(1, toSafeInt(taskCfg.time, 3600)) * 1000;

  await savePlayer(session);
  return { tag: 6810, msgUid, data: { result: 0, taskData: clonePlain(task) } };
}

async function handleValhallaFormationTaskClaim(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6811, msgUid, data: { result: -1, taskList: [], rewardInfo: buildRewardInfo([]) } };

  const info = ensureValhallaFormationInfo(player);
  const rawPositions = Array.isArray(params && params.pos) ? params.pos : [params && params.pos];
  const positions = [];
  const seen = new Set();
  rawPositions.forEach((value) => {
    const pos = toSafeInt(value, -1);
    if (pos < 0 || seen.has(pos)) return;
    seen.add(pos);
    positions.push(pos);
  });
  const tasks = positions
    .map((pos) => info.task.find((row) => row.pos === pos))
    .filter(Boolean);
  if (tasks.length === 0) {
    return { tag: 6811, msgUid, data: { result: -1, taskList: [], rewardInfo: buildRewardInfo([]) } };
  }

  const now = Date.now();
  const rewardRows = [];
  tasks.forEach((task) => {
    if (task.claimed || task.finishTime <= 0 || now < task.finishTime) return;
    const taskCfg = getValhallaFormationTaskConfig()[task.id] || {};
    const rows = clonePlain(task.success
      ? (taskCfg.successRewards || [])
      : (taskCfg.failRewards || []));
    rewardRows.push(...rows);
    task.claimed = true;
    task.finishTime = 0;
    grantRewards(player, rows);
  });

  await savePlayer(session);
  return {
    tag: 6811,
    msgUid,
    data: {
      result: 0,
      taskList: clonePlain(tasks),
      rewardInfo: buildRewardInfo(rewardRows),
    },
  };
}

async function handleValhallaFormationTaskRefresh(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 6812, msgUid, data: { result: -1, taskData: null } };

  const info = ensureValhallaFormationInfo(player);
  const pos = Math.max(0, toSafeInt(params && params.pos, 0));

  const refreshCosts = Array.isArray(getValhallaFormationBaseConfig().taskRefreshCosts)
    ? getValhallaFormationBaseConfig().taskRefreshCosts
    : [];
  const currentTask = info.task.find((task) => task.pos === pos) || generateTaskByPos(pos);
  const canRefresh = refreshCosts.every((cost) => {
    const id = toSafeInt(cost && cost.id, 0);
    const count = Math.max(0, toSafeInt(cost && cost.count, 0));
    return hasEnoughItem(player, id, count);
  });
  if (!canRefresh) {
    return { tag: 6812, msgUid, data: { result: 1, taskData: clonePlain(currentTask) } };
  }
  refreshCosts.forEach((cost) => {
    const id = toSafeInt(cost && cost.id, 0);
    const count = Math.max(0, toSafeInt(cost && cost.count, 0));
    if (id <= 0 || count <= 0) return;
    consumeItem(player, id, count);
  });

  const next = generateTaskByPos(pos);
  const idx = info.task.findIndex((task) => task.pos === pos);
  if (idx >= 0) info.task[idx] = next;
  else info.task.push(next);
  info.task.sort((a, b) => a.pos - b.pos);

  await savePlayer(session);
  return { tag: 6812, msgUid, data: { result: 0, taskData: clonePlain(next) } };
}

module.exports = {
  ensureValhallaFormationInfo,
  buildValhallaFormationPayload,
  handleValhallaFormationSet,
  handleValhallaFormationSwitchElement,
  handleValhallaFormationGetInfo,
  handleValhallaFormationKnotWash,
  handleValhallaFormationKnotWashConfirm,
  handleValhallaFormationConnectUpgrade,
  handleValhallaFormationConnectTransform,
  handleValhallaFormationKnotLock,
  handleValhallaFormationTaskStart,
  handleValhallaFormationTaskClaim,
  handleValhallaFormationTaskRefresh,
};
