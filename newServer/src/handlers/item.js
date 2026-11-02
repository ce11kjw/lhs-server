/**
 * 物品/货币/装备/商店系统
 * tag: 1200 物品列表, 1201 兑换, 1202 批量购买,
 *      1300 使用物品, 1301 出售, 2200 装备替换, 1210 商店购买
 */

const config = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const logger = require('../logger');
const { addRewardToPlayer, addExpToPlayer } = require('./raid');
const { buildClientItemList } = require('../services/CurrencySync');
const { buildTempleLingyunTimeRecords } = require('./temple');
const {
  ensureEquipInfo,
  replaceOpenEquipToPlan,
  saleOpenEquips,
  isEquipTemplateItem,
  createEquipFromTemplateId,
  addOpenEquip,
} = require('../services/EquipService');
const {
  addEquipSaleProgress,
  addBagelConsume: addMainTaskBagelConsume,
  addMountRideCount,
  refreshMainTaskProgress,
} = require('../services/MainTaskProgressService');
const { addBagelConsume: addRealmBagelConsume } = require('../services/RealmTaskProgressService');
const rewardGrant = require('../services/RewardGrantService');
const { ensureFashionInfo } = require('./fashion');
const { buildPetTimeRecordPayload } = require('./pet');

const ITEM_LIST_CACHE_TTL_MS = 3000;
const ITEM_LIST_LEVEL_CHECK_TTL_MS = 1000;

function buildItemTimeRecords(player = {}) {
  return {
    ...buildTempleLingyunTimeRecords(player),
    ...buildPetTimeRecordPayload(player),
  };
}

function scheduleItemPlayerSave(session, player, reason = 'item') {
  if (!session || !session.userId || !player) return;
  if (session._itemSaveScheduled) return;
  session._itemSaveScheduled = true;
  playerService.savePlayerDeferred(session.userId, player).then(
    () => {
      session._itemSaveScheduled = false;
    },
    (err) => {
      logger.warn(`[Item] async save failed ${reason} user=${session.userId}: ${err.message}`);
      session._itemSaveScheduled = false;
    }
  );
}

function getMountHandlerSafe() {
  try {
    // eslint-disable-next-line global-require
    return require('./mount');
  } catch (_err) {
    return null;
  }
}

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function getGemHandlerSafe() {
  try {
    // eslint-disable-next-line global-require
    return require('./gem');
  } catch (_err) {
    return null;
  }
}

function getBloodlineHandlerSafe() {
  try {
    // eslint-disable-next-line global-require
    return require('./bloodline');
  } catch (_err) {
    return null;
  }
}

function getValhallaHandlerSafe() {
  try {
    // eslint-disable-next-line global-require
    return require('./valhalla');
  } catch (_err) {
    return null;
  }
}

const VALHALLA_FRAGMENT_COMPOSE = {
  100101: 100111,
  100102: 100112,
  100103: 100113,
  100104: 100114,
  100105: 100115,
};

function getValhallaFragmentComposeItemId(itemId) {
  return VALHALLA_FRAGMENT_COMPOSE[toSafeItemId(itemId)] || 0;
}

function getRandomValhallaPackQuality(itemId) {
  const id = toSafeItemId(itemId);
  if (id <= 0) return 0;
  const assetsCfg = config.get('AssetsConfig') || {};
  const row = assetsCfg[id] || assetsCfg[String(id)] || null;
  const icon = row && typeof row.icon === 'string' ? row.icon : '';
  if (!icon.startsWith('random_valhalla_')) return 0;
  return Math.max(0, toSafeInt(row && row.quality, 0));
}

function pickValhallaIdByQuality(quality) {
  const q = Math.max(0, toSafeInt(quality, 0));
  if (q <= 0) return 0;
  const cfg = config.get('ValhallaConfig') || {};
  const ids = Object.keys(cfg)
    .map((key) => toSafeItemId(key))
    .filter((id) => id > 0 && toSafeInt(cfg[id] && cfg[id].quality, 0) === q)
    .sort((a, b) => a - b);
  if (ids.length <= 0) return 0;
  const idx = Math.max(0, Math.min(ids.length - 1, Math.floor(Math.random() * ids.length)));
  return ids[idx];
}

function grantRandomValhallaPackRewards(player, packItemId, count) {
  const valhalla = getValhallaHandlerSafe();
  if (!valhalla || typeof valhalla.grantValhallaToPlayer !== 'function') return [];
  const quality = getRandomValhallaPackQuality(packItemId);
  if (quality <= 0) return [];
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const heroId = pickValhallaIdByQuality(quality);
    if (heroId <= 0) continue;
    const hero = valhalla.grantValhallaToPlayer(player, heroId);
    if (hero) rows.push(hero);
  }
  return rows;
}

function isGemRewardId(itemId) {
  const gemCfg = config.get('GemLevelConfig') || {};
  const id = Number(itemId) || 0;
  return !!(id > 0 && (gemCfg[id] || gemCfg[String(id)]));
}

function getGemPackLevel(itemId) {
  const id = Number(itemId) || 0;
  if (id <= 0) return 0;

  const assetsCfg = config.get('AssetsConfig') || {};
  const assetRow = assetsCfg[id] || assetsCfg[String(id)] || null;
  if (assetRow && Number(assetRow.type) === 99) {
    const icon = typeof assetRow.icon === 'string' ? assetRow.icon : '';
    if (icon.startsWith('random_valhalla_')) return 0;
    // Random soul-gem packs in AssetsConfig use quality 2-6 to represent gem levels 1-5.
    return Math.max(1, Math.floor(Number(assetRow.quality) || 0) - 1);
  }

  switch (id) {
    case 100090: return 1;
    case 100091: return 1;
    case 100092: return 2;
    default: return 0;
  }
}

function pickGemRewardIdByLevel(level) {
  const gemCfg = config.get('GemLevelConfig') || {};
  const targetLevel = Math.max(1, Number(level) || 1);
  const ids = Object.keys(gemCfg)
    .map((key) => Number(key) || 0)
    .filter((id) => id > 0 && (Number(gemCfg[id] && gemCfg[id].level) || 0) === targetLevel)
    .sort((a, b) => a - b);
  return ids.length > 0 ? ids[0] : 0;
}

function grantGemPackRewards(player, packItemId, count) {
  const level = getGemPackLevel(packItemId);
  const gemId = pickGemRewardIdByLevel(level);
  if (level <= 0 || gemId <= 0) return [];
  return grantGemRewards(player, gemId, count);
}

function grantGemRewards(player, gemId, count) {
  const gem = getGemHandlerSafe();
  if (!gem || typeof gem.ensureGemInfo !== 'function' || typeof gem.addGem !== 'function') {
    return [];
  }

  const info = gem.ensureGemInfo(player);
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(gem.addGem(info, gemId));
  }
  return rows;
}

function buildGemUpdatePackets(gems = []) {
  return (Array.isArray(gems) ? gems : [])
    .filter((row) => row && Number(row.uid) > 0 && Number(row.id) > 0)
    .map((row) => ({
      tag: 3901,
      msgUid: 0,
      data: {
        result: 0,
        uid: Number(row.uid) || 0,
        id: Number(row.id) || 0,
        shapeId: Number(row.shapeId) || 0,
      },
    }));
}

function buildGemInfoSyncPacket(player) {
  const gem = getGemHandlerSafe();
  if (!player || !gem || typeof gem.ensureGemInfo !== 'function') return null;
  const info = gem.ensureGemInfo(player);
  return {
    tag: 3900,
    msgUid: 0,
    data: {
      equippedId: 0,
      plan: info.plan,
      gems: info.gems,
      exchangeTimes: info.exchangeTimes,
      fieldCount: info.fieldCount,
    },
  };
}

function getFashionConfigRow(fashionId) {
  const id = Number(fashionId) || 0;
  if (id <= 0) return null;
  const fashionCfg = config.get('FashionConfig') || {};
  const row = fashionCfg[id] || fashionCfg[String(id)] || null;
  return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
}

function isFashionRewardId(fashionId) {
  return !!getFashionConfigRow(fashionId);
}

function grantFashionReward(player, fashionId) {
  const id = Number(fashionId) || 0;
  const row = getFashionConfigRow(id);
  if (!row) return null;

  const info = ensureFashionInfo(player);
  info.fashions[String(id)] = 1;
  if (!info.activateFashion.includes(id)) {
    info.activateFashion.push(id);
    info.activateFashion.sort((a, b) => Number(a) - Number(b));
  }

  return { id, type: Number(row.type) || 0 };
}

function getPurchaseResultPacket(result, msgUid) {
  if (!Array.isArray(result)) return result;
  return result.find((packet) => packet && packet.tag === 1202 && packet.msgUid === msgUid)
    || result.find((packet) => packet && packet.tag === 1202 && packet.msgUid !== 0)
    || result.find((packet) => packet && packet.tag === 1202)
    || null;
}

function mergeItemDeltaRows(rows = []) {
  const merged = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const id = Number(row && row.id) || 0;
    const count = Number(row && row.count) || 0;
    if (id <= 0 || count === 0) return;
    merged.set(id, (merged.get(id) || 0) + count);
  });
  return Array.from(merged.entries())
    .map(([id, count]) => ({ id, count }))
    .filter((row) => row.count !== 0)
    .sort((a, b) => a.id - b.id);
}

function getOptionalSaleTicketConfig() {
  const rawId = process.env.SALE_TICKET_ITEM_ID || process.env.SILVER_TICKET_ITEM_ID;
  if (rawId == null || rawId === '') {
    return { ticketItemId: 0, ticketRate: 0, enabled: false };
  }

  const ticketItemId = Number(rawId) || 0;
  const ticketRate = Number(process.env.SALE_TICKET_RATE || 1);
  return {
    ticketItemId,
    ticketRate: Number.isFinite(ticketRate) ? ticketRate : 1,
    enabled: ticketItemId > 0,
  };
}

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

function parsePositiveCount(value, fallback = 1) {
  if (value == null) return { valid: true, count: fallback };
  const count = Math.floor(Number(value));
  if (!Number.isFinite(count) || count <= 0) return { valid: false, count: fallback };
  return { valid: true, count };
}

function toSafeItemId(value) {
  const id = Math.floor(Number(value));
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function getOwnedItemOrCurrencyCount(player, itemId) {
  const id = toSafeItemId(itemId);
  if (!player || id <= 0) return 0;
  const currencies = player.currencies || {};
  if (id === 1) return Math.max(0, Math.floor(Number(currencies.diamond) || 0));
  if (id === 2) return Math.max(0, Math.floor(Number(currencies.silver) || 0));
  if (id === 3) return Math.max(0, Math.floor(Number(player.exp) || 0));
  if (id === 6) return Math.max(0, Math.floor(Number(currencies.gold) || 0));
  return Math.max(0, Math.floor(Number(player.items && player.items[id]) || 0));
}

function consumeBagItem(player, itemId, count) {
  const id = toSafeItemId(itemId);
  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  if (!player || id <= 0 || safeCount <= 0) return false;
  player.items = player.items || {};
  if ((Number(player.items[id]) || 0) < safeCount) return false;
  player.items[id] = Math.max(0, (Number(player.items[id]) || 0) - safeCount);
  if (player.items[id] <= 0) delete player.items[id];
  return true;
}

function buildRewardInfo(items = [], equips = [], gems = [], extra = {}) {
  const base = rewardGrant.buildEmptyRewardInfo();
  return {
    ...base,
    items: Array.isArray(items) ? items : [],
    equips: Array.isArray(equips) ? equips : [],
    gems: Array.isArray(gems) ? gems : [],
    swords: Array.isArray(extra.swords) ? extra.swords : [],
    pets: Array.isArray(extra.pets) ? extra.pets : [],
    ...extra,
  };
}

function ensureItemUseRecords(player) {
  if (!player || typeof player !== 'object') return {};
  if (!player.itemUseRecords || typeof player.itemUseRecords !== 'object' || Array.isArray(player.itemUseRecords)) {
    player.itemUseRecords = {};
  }
  return player.itemUseRecords;
}

function getItemUseRecordCount(player, itemId) {
  const records = ensureItemUseRecords(player);
  const key = String(toSafeItemId(itemId));
  return Math.max(0, toSafeInt(records[key], 0));
}

function addItemUseRecord(player, itemId, delta = 1) {
  const id = toSafeItemId(itemId);
  if (id <= 0) return 0;
  const records = ensureItemUseRecords(player);
  const key = String(id);
  records[key] = Math.max(0, toSafeInt(records[key], 0)) + Math.max(0, toSafeInt(delta, 0));
  return records[key];
}

function addOtherAttrRecord(player, itemId, delta = 1, minimum = 0) {
  const id = toSafeItemId(itemId);
  if (id <= 0 || !player || typeof player !== 'object') return 0;
  if (!player.other_attr_info || typeof player.other_attr_info !== 'object' || Array.isArray(player.other_attr_info)) {
    player.other_attr_info = {};
  }
  const holder = player.other_attr_info;
  if (!holder.record || typeof holder.record !== 'object' || Array.isArray(holder.record)) {
    holder.record = {};
  }
  const key = String(id);
  const next = Math.max(0, toSafeInt(holder.record[key], 0)) + Math.max(0, toSafeInt(delta, 0));
  holder.record[key] = Math.max(next, Math.max(0, toSafeInt(minimum, 0)));
  return holder.record[key];
}

function buildUseRecordsPayload(player) {
  const records = ensureItemUseRecords(player);
  return Object.keys(records)
    .map((key) => ({ id: toSafeInt(key, 0), count: Math.max(0, toSafeInt(records[key], 0)) }))
    .filter((row) => row.id > 0);
}

function canUseItemByLimit(player, itemId, count, useCfg = null) {
  const safeCount = Math.max(0, toSafeInt(count, 0));
  if (safeCount <= 0) return false;
  const cfg = useCfg || (config.get('AssetsUseConfig') || {})[itemId] || (config.get('AssetsUseConfig') || {})[String(itemId)] || null;
  if (!cfg) return true;

  const limit = Math.max(0, toSafeInt(cfg.limit, 0));
  if (limit <= 0) return true;
  return getItemUseRecordCount(player, itemId) + safeCount <= limit;
}

function addRewardRowsToPlayer(player, rewardRows = [], times = 1) {
  const itemDeltas = [];
  const changedMap = new Map();
  const rewardItems = [];
  const rewardEquips = [];
  const rewardGems = [];
  const rewardFashion = [];
  const rewardSwords = [];
  const rewardPets = [];
  const rewardPetSouls = [];
  const rewardBloodlines = [];
  const rewardValhalla = [];
  const safeTimes = Math.max(1, Math.floor(Number(times) || 1));
  const setChanged = (itemId) => {
    const id = toSafeItemId(itemId);
    if (id <= 0) return;
    changedMap.set(id, { id, count: getOwnedItemOrCurrencyCount(player, id) });
  };

  (Array.isArray(rewardRows) ? rewardRows : []).forEach((row) => {
    const rewardId = toSafeItemId(row && row.id);
    const rewardCount = Math.max(0, Math.floor(Number(row && row.count) || 0) * safeTimes);
    if (rewardId <= 0 || rewardCount <= 0) return;

    if (isEquipTemplateItem(rewardId)) {
      ensureEquipInfo(player);
      for (let i = 0; i < rewardCount; i += 1) {
        const equip = createEquipFromTemplateId(rewardId, player.level, player);
        addOpenEquip(player, equip);
        rewardEquips.push(equip);
      }
      return;
    }

    if (getRandomValhallaPackQuality(rewardId) > 0) {
      rewardValhalla.push(...grantRandomValhallaPackRewards(player, rewardId, rewardCount));
      return;
    }

    if (isGemRewardId(rewardId)) {
      rewardGems.push(...grantGemRewards(player, rewardId, rewardCount));
      return;
    }

    if (getGemPackLevel(rewardId) > 0) {
      rewardGems.push(...grantGemPackRewards(player, rewardId, rewardCount));
      return;
    }

    const grantResult = rewardGrant.grantRewardRow(player, row, safeTimes);
    if (grantResult.rewardSwords.length > 0) {
      rewardSwords.push(...grantResult.rewardSwords);
      return;
    }
    if (grantResult.rewardPets.length > 0) {
      rewardPets.push(...grantResult.rewardPets);
      return;
    }
    if (grantResult.rewardPetSouls.length > 0) {
      rewardPetSouls.push(...grantResult.rewardPetSouls);
      return;
    }
    if (grantResult.rewardBloodlines.length > 0) {
      rewardBloodlines.push(...grantResult.rewardBloodlines);
      return;
    }
    if ((grantResult.rewardValhalla || []).length > 0) {
      rewardValhalla.push(...grantResult.rewardValhalla);
      return;
    }

    addRewardToPlayer(player, rewardId, rewardCount);
    rewardItems.push({ id: rewardId, count: rewardCount });
    itemDeltas.push({ id: rewardId, count: rewardCount });
    setChanged(rewardId);
  });

  return {
    itemDeltas,
    changed: Array.from(changedMap.values()).sort((a, b) => a.id - b.id),
    rewardInfo: buildRewardInfo(rewardItems, rewardEquips, rewardGems, {
      swords: rewardSwords,
      pets: rewardPets,
      bloodline: rewardBloodlines,
      valhalla: rewardValhalla,
    }),
    rewardGems,
    rewardSwords,
    rewardPets,
    rewardPetSouls,
    rewardBloodlines,
    rewardValhalla,
  };
}

function selectUseRewardRows(useCfg, selects) {
  const rewards = Array.isArray(useCfg && useCfg.rewards) ? useCfg.rewards : [];
  if (!selects || typeof selects !== 'object' || Array.isArray(selects)) return rewards;
  const selectedRows = Object.keys(selects)
    .filter((key) => Number(selects[key]) > 0)
    .map((key) => rewards[Math.floor(Number(key))])
    .filter(Boolean);
  return selectedRows.length > 0 ? selectedRows : rewards;
}

const RED_PACKET_REWARD_POOLS = {
  94411: [{ id: 1, count: 988 }, { id: 1, count: 888 }, { id: 1, count: 388 }, { id: 1, count: 288 }, { id: 1, count: 188 }],
  94412: [{ id: 4, count: 888 }, { id: 4, count: 388 }, { id: 4, count: 288 }, { id: 4, count: 188 }, { id: 4, count: 166 }],
  94413: [{ id: 6, count: 66 }, { id: 6, count: 36 }, { id: 6, count: 26 }, { id: 6, count: 16 }, { id: 6, count: 6 }],
  94414: [{ id: 65, count: 188 }, { id: 65, count: 128 }, { id: 65, count: 99 }, { id: 65, count: 88 }, { id: 65, count: 38 }],
  94415: [
    { id: 1, count: 66 }, { id: 4, count: 66 }, { id: 2, count: 8888 }, { id: 65, count: 12 }, { id: 55, count: 10 },
    { id: 1, count: 36 }, { id: 4, count: 26 }, { id: 2, count: 888 }, { id: 65, count: 6 }, { id: 55, count: 5 },
  ],
  94417: [
    { id: 1, count: 66 }, { id: 4, count: 66 }, { id: 2, count: 8888 }, { id: 65, count: 12 }, { id: 55, count: 10 },
    { id: 1, count: 36 }, { id: 4, count: 26 }, { id: 2, count: 888 }, { id: 65, count: 6 }, { id: 55, count: 5 },
  ],
};

function pickRedPacketRewardRows(itemId, count = 1) {
  const pool = RED_PACKET_REWARD_POOLS[toSafeItemId(itemId)] || [];
  const times = Math.max(1, toSafeInt(count, 1));
  if (pool.length <= 0) return [];
  const merged = new Map();
  for (let i = 0; i < times; i += 1) {
    const idx = Math.max(0, Math.min(pool.length - 1, Math.floor(Math.random() * pool.length)));
    const row = pool[idx];
    merged.set(row.id, (merged.get(row.id) || 0) + row.count);
  }
  return Array.from(merged.entries()).map(([id, rewardCount]) => ({ id, count: rewardCount }));
}

async function handleLegacyShopBuy(params, session, msgUid) {
  const goodsId = Number(params && (params.goodsId || params.id)) || 0;
  const count = Math.max(1, Number(params && params.count) || 1);
  logger.info(`[Item] legacy shop buy goodsId=${goodsId} count=${count} user=${session && session.userId ? session.userId : 'unknown'}`);
  const result = await handleMultiBuyItem({ require: { [goodsId]: count } }, session, msgUid);
  const resultPacket = getPurchaseResultPacket(result, msgUid);
  if (!resultPacket || resultPacket.tag !== 1202) {
    logger.warn(`[Item] legacy shop buy missing result goodsId=${goodsId} count=${count} user=${session && session.userId ? session.userId : 'unknown'}`);
    return { tag: 1200, msgUid, data: { result: -1, rewardInfo: { items: [], equips: [], gems: [] } } };
  }
  logger.info(`[Item] legacy shop buy result goodsId=${goodsId} count=${count} result=${resultPacket.data && resultPacket.data.result} rewardItems=${JSON.stringify((resultPacket.data && resultPacket.data.rewardInfo && resultPacket.data.rewardInfo.items) || [])} rewardGems=${JSON.stringify((resultPacket.data && resultPacket.data.rewardInfo && resultPacket.data.rewardInfo.gems) || [])}`);

  const packets = Array.isArray(result) ? result.slice() : [result];
  packets.push({
    tag: 1200,
    msgUid,
    data: {
      result: resultPacket.data && resultPacket.data.result === 0 ? 0 : -1,
      id: goodsId,
      count,
      items: resultPacket.data && Array.isArray(resultPacket.data.items) ? resultPacket.data.items : [],
      changed: resultPacket.data && Array.isArray(resultPacket.data.changed) ? resultPacket.data.changed : [],
      timeRecords: resultPacket.data && resultPacket.data.timeRecords ? resultPacket.data.timeRecords : buildItemTimeRecords(session && session.player),
      rewards: resultPacket.data && resultPacket.data.rewardInfo
        ? resultPacket.data.rewardInfo
        : {
          items: [],
          equips: [],
          swords: [],
          pets: [],
          artifacts: [],
          gems: [],
          valhalla: [],
          bloodline: [],
          fashion: [],
          elves: [],
          extraReward: {},
        },
      rewardInfo: resultPacket.data && resultPacket.data.rewardInfo
        ? resultPacket.data.rewardInfo
        : {
          items: [],
          equips: [],
          swords: [],
          pets: [],
          artifacts: [],
          gems: [],
          valhalla: [],
          bloodline: [],
          fashion: [],
          elves: [],
          extraReward: {},
        },
    },
  });
  return packets;
}

// 物品列表 (tag:1200)
async function handleGetItems(params, session, msgUid) {
  if (params && (params.id != null || params.goodsId != null)) {
    return handleLegacyShopBuy(params, session, msgUid);
  }
  const player = session.player;
  const now = Date.now();
  if (session && session._itemListCache && session._itemListCache.expiresAt > now) {
    return { tag: 1200, msgUid, data: session._itemListCache.data };
  }
  if (player) {
    const { checkLevelUp } = require('./raid');
    if (!session._itemListLevelCheckAt || now - session._itemListLevelCheckAt >= ITEM_LIST_LEVEL_CHECK_TTL_MS) {
      session._itemListLevelCheckAt = now;
      const levelBefore = Math.max(1, toSafeInt(player.level, 1));
      const expBefore = Math.max(0, toSafeInt(player.exp, 0));
      checkLevelUp(player);
      if (
        Math.max(1, toSafeInt(player.level, 1)) !== levelBefore
        || Math.max(0, toSafeInt(player.exp, 0)) !== expBefore
      ) {
        scheduleItemPlayerSave(session, player, '1200-level-sync');
      }
    }
  }
  const items = player ? buildClientItemList(player) : [];
  const timeRecords = player ? buildItemTimeRecords(player) : {};
  const useRecords = player ? buildUseRecordsPayload(player) : [];
  const data = { items, useRecords, timeRecords };
  if (session) session._itemListCache = { data, expiresAt: now + ITEM_LIST_CACHE_TTL_MS };
  return { tag: 1200, msgUid, data };
}

// 兑换物品 (tag:1201)
async function handleExchangeItem(params, session, msgUid) {
  const player = session.player;
  const emptyRewards = buildRewardInfo();
  if (!player) return { tag: 1201, msgUid, data: { result: -1, rewards: emptyRewards } };

  const sourceItemId = toSafeItemId(params && params.id);
  const parsedCount = parsePositiveCount(params && params.count, 1);
  const exchangeCfgMap = config.get('AssetsExchangeConfig') || {};
  const exchangeCfg = exchangeCfgMap[sourceItemId] || exchangeCfgMap[String(sourceItemId)] || null;
  if (!parsedCount.valid || !exchangeCfg) {
    return { tag: 1201, msgUid, data: { result: -1, rewards: emptyRewards } };
  }

  const count = parsedCount.count;
  const rewardItemId = toSafeItemId(exchangeCfg.itemId);
  const rewardCount = Math.max(0, toSafeInt(exchangeCfg.count, 0));
  if (rewardItemId <= 0 || rewardCount <= 0 || !consumeBagItem(player, sourceItemId, count)) {
    return { tag: 1201, msgUid, data: { result: -1, rewards: emptyRewards } };
  }

  const rewardResult = addRewardRowsToPlayer(player, [{ id: rewardItemId, count: rewardCount }], count);
  await playerService.savePlayer(session.userId, player);
  const changedMap = new Map(rewardResult.changed.map((row) => [row.id, row]));
  changedMap.set(sourceItemId, {
    id: sourceItemId,
    count: getOwnedItemOrCurrencyCount(player, sourceItemId),
  });
  const rewards = rewardResult.rewardInfo;
  return [
    {
      tag: 1202,
      msgUid: 0,
      data: {
        result: 0,
        items: [{ id: sourceItemId, count: -count }, ...rewardResult.itemDeltas],
        changed: Array.from(changedMap.values()).sort((a, b) => a.id - b.id),
      },
    },
    {
      tag: 1201,
      msgUid,
      data: {
        result: 0,
        id: sourceItemId,
        count,
        rewards,
        rewardInfo: rewards,
      },
    },
  ];
}

// 批量购买 (tag:1202)
async function handleMultiBuyItem(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 1202, msgUid, data: { result: -1 } };

  const requireMap = params && typeof params.require === 'object' && !Array.isArray(params.require)
    ? params.require
    : {};
  const shopCfg = config.get('ShopConfig') || {};
  player.currencies = player.currencies || { gold: 0, diamond: 0, silver: 0 };
  player.items = player.items || {};
  player.rechargeInfo = player.rechargeInfo && typeof player.rechargeInfo === 'object' ? player.rechargeInfo : {};
  player.rechargeInfo.records = Array.isArray(player.rechargeInfo.records) ? player.rechargeInfo.records : [];
  player.shopInfo = player.shopInfo && typeof player.shopInfo === 'object' ? player.shopInfo : {};
  player.shopInfo.buyRecords = player.shopInfo.buyRecords && typeof player.shopInfo.buyRecords === 'object'
    ? player.shopInfo.buyRecords
    : {};

  const purchaseList = Object.keys(requireMap)
    .map((goodsIdKey) => ({
      goodsId: Number(goodsIdKey) || 0,
      count: Math.max(0, Number(requireMap[goodsIdKey]) || 0),
    }))
    .filter((row) => row.goodsId > 0 && row.count > 0);
  if (purchaseList.length <= 0) {
    return { tag: 1202, msgUid, data: { result: -1, msg: 'empty require' } };
  }

  const changedMap = new Map();
  const rewardItems = [];
  const rewardEquips = [];
  const rewardGems = [];
  const rewardFashion = [];
  const rewardSwords = [];
  const rewardPets = [];
  const rewardPetSouls = [];
  const rewardValhalla = [];
  const costDeltas = [];
  const boughtIds = [];
  const recordNow = Date.now();
  const addRechargeBuyRecord = (goodsId, addCount) => {
    const id = Number(goodsId) || 0;
    const count = Math.max(0, Number(addCount) || 0);
    if (id <= 0 || count <= 0) return;
    const records = player.rechargeInfo.records;
    for (let i = 0; i < records.length; i += 1) {
      if ((Number(records[i] && records[i].id) || 0) === id) {
        records[i].count = Math.max(0, (Number(records[i].count) || 0) + count);
        return;
      }
    }
    records.push({ id, count });
  };
  const setChanged = (itemId) => {
    const id = Number(itemId) || 0;
    if (id <= 0) return;
    let count = 0;
    if (id === 1) count = Number(player.currencies.diamond) || 0;
    else if (id === 2) count = Number(player.currencies.silver) || 0;
    else if (id === 6) count = Number(player.currencies.gold) || 0;
    else count = Number(player.items[id]) || 0;
    changedMap.set(id, { id, count: Math.max(0, count) });
  };
  const getOwnedCount = (itemId) => {
    const id = Number(itemId) || 0;
    if (id === 1) return Number(player.currencies.diamond) || 0;
    if (id === 2) return Number(player.currencies.silver) || 0;
    if (id === 6) return Number(player.currencies.gold) || 0;
    return Number(player.items[id]) || 0;
  };
  const reservedCostMap = new Map();
  const getReservedCost = (itemId) => reservedCostMap.get(itemId) || 0;
  const reserveCost = (itemId, count) => {
    const id = Number(itemId) || 0;
    const addCount = Math.max(0, Number(count) || 0);
    if (id <= 0 || addCount <= 0) return;
    reservedCostMap.set(id, getReservedCost(id) + addCount);
  };
  const consumeCostRow = (costRow, times) => {
    const itemId = Number(costRow && costRow.id) || 0;
    const costCount = Math.max(0, (Number(costRow && costRow.count) || 0) * times);
    if (itemId <= 0 || costCount <= 0) return;
    if (itemId === 1) player.currencies.diamond = Math.max(0, (Number(player.currencies.diamond) || 0) - costCount);
    else if (itemId === 2) player.currencies.silver = Math.max(0, (Number(player.currencies.silver) || 0) - costCount);
    else if (itemId === 6) player.currencies.gold = Math.max(0, (Number(player.currencies.gold) || 0) - costCount);
    else {
      player.items[itemId] = Math.max(0, (Number(player.items[itemId]) || 0) - costCount);
      if (player.items[itemId] <= 0) delete player.items[itemId];
    }
    costDeltas.push({ id: itemId, count: -costCount });
    setChanged(itemId);
  };

  for (const purchase of purchaseList) {
    const goods = shopCfg[purchase.goodsId] || shopCfg[String(purchase.goodsId)] || null;
    if (!goods) {
      logger.warn(`[Item] shop buy invalid goodsId=${purchase.goodsId} count=${purchase.count} user=${session && session.userId ? session.userId : 'unknown'}`);
      return { tag: 1202, msgUid, data: { result: -1, msg: 'invalid goods', id: purchase.goodsId } };
    }

    const boughtCount = Number(player.shopInfo.buyRecords[purchase.goodsId]) || 0;
    if (Number(goods.limit) > 0 && boughtCount + purchase.count > Number(goods.limit)) {
      return { tag: 1202, msgUid, data: { result: -1, msg: 'limit reached', id: purchase.goodsId } };
    }

    for (let step = 0; step < purchase.count; step += 1) {
      const totalBought = boughtCount + step;
      const costRows = Array.isArray(goods.costAgain) && goods.costAgain[totalBought] && goods.costAgain[totalBought].length > 0
        ? goods.costAgain[totalBought]
        : (Array.isArray(goods.cost) ? goods.cost : []);
      for (const costRow of costRows) {
        const itemId = Number(costRow && costRow.id) || 0;
        const need = Math.max(0, Number(costRow && costRow.count) || 0);
        if (getOwnedCount(itemId) - getReservedCost(itemId) < need) {
          return { tag: 1202, msgUid, data: { result: -1, msg: 'not enough currency', id: purchase.goodsId } };
        }
        reserveCost(itemId, need);
      }
    }
  }

  for (const purchase of purchaseList) {
    const goods = shopCfg[purchase.goodsId] || shopCfg[String(purchase.goodsId)] || null;
    const boughtCount = Number(player.shopInfo.buyRecords[purchase.goodsId]) || 0;
    for (let step = 0; step < purchase.count; step += 1) {
      const totalBought = boughtCount + step;
      const costRows = Array.isArray(goods.costAgain) && goods.costAgain[totalBought] && goods.costAgain[totalBought].length > 0
        ? goods.costAgain[totalBought]
        : (Array.isArray(goods.cost) ? goods.cost : []);
      costRows.forEach((costRow) => consumeCostRow(costRow, 1));

      const rewards = Array.isArray(goods.rewards) ? goods.rewards : [];
      rewards.forEach((reward) => {
        const rewardId = Number(reward && reward.id) || 0;
        const rewardCount = Math.max(0, Number(reward && reward.count) || 0);
        if (rewardId <= 0 || rewardCount <= 0) return;
        if (isFashionRewardId(rewardId)) {
          for (let i = 0; i < rewardCount; i += 1) {
            const fashionRow = grantFashionReward(player, rewardId);
            if (fashionRow && !rewardFashion.some((row) => row.id === fashionRow.id)) {
              rewardFashion.push(fashionRow);
            }
          }
        } else if (isEquipTemplateItem(rewardId)) {
          ensureEquipInfo(player);
          for (let i = 0; i < rewardCount; i += 1) {
            const equip = createEquipFromTemplateId(rewardId, player.level, player);
            addOpenEquip(player, equip);
            rewardEquips.push(equip);
          }
        } else if (getRandomValhallaPackQuality(rewardId) > 0) {
          rewardValhalla.push(...grantRandomValhallaPackRewards(player, rewardId, rewardCount));
        } else if (isGemRewardId(rewardId)) {
          rewardGems.push(...grantGemRewards(player, rewardId, rewardCount));
        } else if (getGemPackLevel(rewardId) > 0) {
          rewardGems.push(...grantGemPackRewards(player, rewardId, rewardCount));
        } else {
          const grantResult = rewardGrant.grantRewardRow(player, reward, 1);
          if (grantResult.rewardSwords.length > 0) {
            rewardSwords.push(...grantResult.rewardSwords);
            return;
          }
          if (grantResult.rewardPets.length > 0) {
            rewardPets.push(...grantResult.rewardPets);
            return;
          }
          if (grantResult.rewardPetSouls.length > 0) {
            rewardPetSouls.push(...grantResult.rewardPetSouls);
            return;
          }
          if ((grantResult.rewardValhalla || []).length > 0) {
            rewardValhalla.push(...grantResult.rewardValhalla);
            return;
          }
          addRewardToPlayer(player, rewardId, rewardCount);
          rewardItems.push({ id: rewardId, count: rewardCount });
          setChanged(rewardId);
        }
      });
    }

    player.shopInfo.buyRecords[purchase.goodsId] = boughtCount + purchase.count;
    player.shopInfo.buyRecords[String(purchase.goodsId)] = boughtCount + purchase.count;
    addRechargeBuyRecord(purchase.goodsId, purchase.count);
    boughtIds.push(purchase.goodsId);
  }

  player.shopInfo.lastBuyTime = recordNow;
  await playerService.savePlayer(session.userId, player);

  const payload = {
    tag: 1202,
    msgUid,
    data: {
      result: 0,
      ids: boughtIds,
      items: rewardItems,
      changed: Array.from(changedMap.values()).sort((a, b) => a.id - b.id),
      timeRecords: buildItemTimeRecords(player),
      rewardInfo: {
        items: rewardItems,
        equips: rewardEquips,
        swords: rewardSwords,
        pets: rewardPets,
        artifacts: [],
        gems: rewardGems,
        valhalla: rewardValhalla,
        bloodline: [],
        fashion: rewardFashion,
        elves: [],
        extraReward: {},
      },
    },
  };

  const packets = [
    {
      tag: 1202,
      msgUid: 0,
      data: {
        result: 0,
        items: mergeItemDeltaRows([...costDeltas, ...rewardItems]),
        changed: Array.from(changedMap.values()).sort((a, b) => a.id - b.id),
        timeRecords: buildItemTimeRecords(player),
      },
    },
    payload,
  ];
  if (rewardGems.length > 0) {
    const gemSyncPacket = buildGemInfoSyncPacket(player);
    if (gemSyncPacket) packets.push(gemSyncPacket);
    packets.push(...buildGemUpdatePackets(rewardGems));
  }
  if (rewardFashion.length > 0) {
    packets.push({
      tag: 1800,
      msgUid: 0,
      data: {
        result: 0,
        data: [],
        fashion: rewardFashion.map((row) => row.id),
      },
    });
  }
  if (rewardSwords.length > 0) {
    packets.push({ tag: 3201, msgUid: 0, data: { result: 0, data: rewardSwords } });
  }
  if (rewardSwords.length > 0) {
    const mount = getMountHandlerSafe();
    const info = mount && typeof mount.ensureMountInfo === 'function' ? mount.ensureMountInfo(player) : player.swordInfo;
    const buildInfo = mount && typeof mount.buildMountInfoUpdatePayload === 'function'
      ? mount.buildMountInfoUpdatePayload(info)
      : info;
    packets.push({ tag: 3200, msgUid: 0, data: { result: 0, uid: buildInfo && buildInfo.equippedUid, info: buildInfo } });
  }
  rewardPetSouls.forEach((soul) => {
    packets.push({ tag: 6901, msgUid: 0, data: { result: 0, data: soul } });
  });
  if (rewardValhalla.length > 0) {
    const valhalla = getValhallaHandlerSafe();
    if (valhalla && typeof valhalla.ensureValhallaInfo === 'function' && typeof valhalla.buildValhallaPayload === 'function') {
      const info = valhalla.ensureValhallaInfo(player);
      packets.push({ tag: 4100, msgUid: 0, data: { result: 0, ...valhalla.buildValhallaPayload(info) } });
    }
  }
  return packets;
}

// 使用物品 (tag:1300)
async function handleUseItem(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 1300, msgUid, data: { result: -1 } };

  const itemId = toSafeItemId(params && (params.itemId || params.id || params.index));
  const parsedCount = parsePositiveCount(params && params.count, 1);
  if (!parsedCount.valid) {
    return { tag: 1300, msgUid, data: { result: -1, msg: 'invalid count' } };
  }
  const count = parsedCount.count;

  if (itemId <= 0 || !player.items || !player.items[itemId] || player.items[itemId] < count) {
    return { tag: 1300, msgUid, data: { result: -1, msg: 'not enough' } };
  }

  const useCfg = (config.get('AssetsUseConfig') || {})[itemId] || (config.get('AssetsUseConfig') || {})[String(itemId)] || null;
  if (!canUseItemByLimit(player, itemId, count, useCfg)) {
    return { tag: 1300, msgUid, data: { result: -1, msg: 'limit reached' } };
  }

  consumeBagItem(player, itemId, count);

  let taskChanged = false;
  if (Number(itemId) === 4) {
    taskChanged = !!addMainTaskBagelConsume(player, count);
    addRealmBagelConsume(player, count);
  }

  let rewardResult = {
    itemDeltas: [],
    changed: [],
    rewardInfo: buildRewardInfo(),
    rewardGems: [],
    rewardSwords: [],
    rewardPets: [],
    rewardPetSouls: [],
    rewardBloodlines: [],
    rewardValhalla: [],
  };
  let permanentUseRecordCount = null;
  const valhallaComposeItemId = getValhallaFragmentComposeItemId(itemId);
  if (valhallaComposeItemId > 0) {
    rewardResult = addRewardRowsToPlayer(player, [{ id: valhallaComposeItemId, count: 1 }], count);
  } else if (getRandomValhallaPackQuality(itemId) > 0) {
    const rewardValhalla = grantRandomValhallaPackRewards(player, itemId, count);
    rewardResult = {
      itemDeltas: [],
      changed: [],
      rewardInfo: buildRewardInfo([], [], [], { valhalla: rewardValhalla }),
      rewardGems: [],
      rewardSwords: [],
      rewardPets: [],
      rewardPetSouls: [],
      rewardBloodlines: [],
      rewardValhalla,
    };
  } else if (useCfg) {
    const useType = Math.max(0, toSafeInt(useCfg.type, 0));
    if (useType === 103 || (useCfg.attrs && typeof useCfg.attrs === 'object' && !Array.isArray(useCfg.attrs))) {
      const useRecordCount = addItemUseRecord(player, itemId, count);
      permanentUseRecordCount = addOtherAttrRecord(player, itemId, count, useRecordCount);
    } else {
      const configuredRows = selectUseRewardRows(useCfg, params && params.selects);
      const rewardRows = useType === 102 && configuredRows.length <= 0
        ? pickRedPacketRewardRows(itemId, count)
        : configuredRows;
      rewardResult = addRewardRowsToPlayer(player, rewardRows, useType === 102 ? 1 : count);
    }
  } else if (getGemPackLevel(itemId) > 0) {
    const rewardGems = grantGemPackRewards(player, itemId, count);
    rewardResult = {
      itemDeltas: [],
      changed: [],
      rewardInfo: buildRewardInfo([], [], rewardGems),
      rewardGems,
      rewardSwords: [],
      rewardPets: [],
      rewardPetSouls: [],
      rewardBloodlines: [],
      rewardValhalla: [],
    };
  }

  const rewards = rewardResult.rewardInfo.items.slice();
  const rewardSwords = Array.isArray(rewardResult.rewardSwords) ? rewardResult.rewardSwords : [];
  const equippedSword = rewardSwords.length > 0 ? rewardSwords[rewardSwords.length - 1] : null;
  if (equippedSword && equippedSword.uid > 0) {
    player.swordInfo = player.swordInfo && typeof player.swordInfo === 'object' ? player.swordInfo : {};
    player.swordInfo.equippedUid = equippedSword.uid;
    taskChanged = !!addMountRideCount(player, 1) || taskChanged;
  }
  if (itemId >= 40001 && itemId < 50000) {
    const expGain = count * 100;
    addExpToPlayer(player, expGain);
    rewards.push({ id: 3, count: expGain });
    rewardResult.itemDeltas.push({ id: 3, count: expGain });
    rewardResult.changed.push({ id: 3, count: getOwnedItemOrCurrencyCount(player, 3) });
  }

  const changedMap = new Map(rewardResult.changed.map((row) => [row.id, row]));
  changedMap.set(itemId, { id: itemId, count: getOwnedItemOrCurrencyCount(player, itemId) });
  const itemDeltas = [{ id: itemId, count: -count }, ...rewardResult.itemDeltas];
  const itemSyncRows = Number(itemId) === 4 ? rewardResult.itemDeltas.slice() : itemDeltas;
  const changed = Array.from(changedMap.values()).sort((a, b) => a.id - b.id);
  const rewardInfo = {
    ...rewardResult.rewardInfo,
    items: rewards,
    swords: rewardSwords,
    pets: Array.isArray(rewardResult.rewardPets) ? rewardResult.rewardPets : [],
    bloodline: Array.isArray(rewardResult.rewardBloodlines) ? rewardResult.rewardBloodlines : [],
    valhalla: Array.isArray(rewardResult.rewardValhalla) ? rewardResult.rewardValhalla : [],
  };

  await playerService.savePlayer(session.userId, player);
  const packets = [];
  if (itemSyncRows.length > 0 || changed.length > 0) {
    packets.push({
      tag: 1202,
      msgUid: 0,
      data: {
        result: 0,
        items: itemSyncRows,
        changed,
      },
    });
  }
  if (rewardResult.rewardGems.length > 0) {
    const gemSyncPacket = buildGemInfoSyncPacket(player);
    if (gemSyncPacket) packets.push(gemSyncPacket);
    packets.push(...buildGemUpdatePackets(rewardResult.rewardGems));
  }
  if (rewardSwords.length > 0) {
    packets.push({ tag: 3201, msgUid: 0, data: { result: 0, data: rewardSwords } });
  }
  if (equippedSword && equippedSword.uid > 0) {
    const mount = getMountHandlerSafe();
    const info = mount && typeof mount.ensureMountInfo === 'function' ? mount.ensureMountInfo(player) : player.swordInfo;
    const buildInfo = mount && typeof mount.buildMountInfoUpdatePayload === 'function'
      ? mount.buildMountInfoUpdatePayload(info)
      : info;
    packets.push({ tag: 3200, msgUid: 0, data: { result: 0, uid: equippedSword.uid, info: buildInfo } });
  }
  (rewardResult.rewardPetSouls || []).forEach((soul) => {
    packets.push({ tag: 6901, msgUid: 0, data: { result: 0, data: soul } });
  });
  if ((rewardResult.rewardBloodlines || []).length > 0) {
    const bloodline = getBloodlineHandlerSafe();
    if (bloodline && typeof bloodline.ensureBloodlineInfo === 'function' && typeof bloodline.buildBloodlinePayload === 'function') {
      const info = bloodline.ensureBloodlineInfo(player);
      packets.push({ tag: 4701, msgUid: 0, data: { result: 0, ...bloodline.buildBloodlinePayload(info) } });
    }
  }
  if ((rewardResult.rewardValhalla || []).length > 0) {
    const valhalla = getValhallaHandlerSafe();
    if (valhalla && typeof valhalla.ensureValhallaInfo === 'function' && typeof valhalla.buildValhallaPayload === 'function') {
      const info = valhalla.ensureValhallaInfo(player);
      packets.push({ tag: 4100, msgUid: 0, data: { result: 0, ...valhalla.buildValhallaPayload(info) } });
    }
  }
  if (permanentUseRecordCount != null) {
    packets.push({
      tag: 1250,
      msgUid: 0,
      data: { id: itemId, count: permanentUseRecordCount },
    });
  }
  if (taskChanged) packets.push(...buildTaskUpdatePacketsSafe(player));
  packets.push({
    tag: 1300,
    msgUid,
    data: {
      result: 0,
      itemId,
      index: itemId,
      count,
      rewards: rewardInfo,
      rewardInfo,
      gems: rewardResult.rewardGems,
      useRecords: buildUseRecordsPayload(player),
    },
  });
  return packets.length === 1 ? packets[0] : packets;
}

// 出售物品 (tag:1301)
async function handleSaleItem(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 1301, msgUid, data: { result: -1 } };

  const itemId = toSafeItemId(params && (params.itemId || params.id || params.index));
  const countRaw = params && params.count;
  const count = Math.floor(Number(countRaw == null ? 1 : countRaw));

  if (!Number.isFinite(count) || count <= 0) {
    return { tag: 1301, msgUid, data: { result: -1, msg: 'invalid count' } };
  }

  if (itemId <= 0 || !player.items || !player.items[itemId] || player.items[itemId] < count) {
    return { tag: 1301, msgUid, data: { result: -1, msg: 'not enough' } };
  }

  const valhallaComposeItemId = getValhallaFragmentComposeItemId(itemId);
  if (valhallaComposeItemId > 0) {
    consumeBagItem(player, itemId, count);
    const rewardResult = addRewardRowsToPlayer(player, [{ id: valhallaComposeItemId, count: 1 }], count);
    await playerService.savePlayer(session.userId, player);
    const changedMap = new Map(rewardResult.changed.map((row) => [row.id, row]));
    changedMap.set(itemId, { id: itemId, count: getOwnedItemOrCurrencyCount(player, itemId) });
    const packets = [
      {
        tag: 1202,
        data: {
          items: [{ id: itemId, count: -count }, ...rewardResult.itemDeltas],
          changed: Array.from(changedMap.values()).sort((a, b) => a.id - b.id),
        },
      },
      {
        tag: 1301,
        msgUid,
        data: {
          result: 0,
          itemId,
          count,
          silver: 0,
          rewards: rewardResult.rewardInfo,
          rewardInfo: rewardResult.rewardInfo,
        },
      },
    ];
    if ((rewardResult.rewardValhalla || []).length > 0) {
      const valhalla = getValhallaHandlerSafe();
      if (valhalla && typeof valhalla.ensureValhallaInfo === 'function' && typeof valhalla.buildValhallaPayload === 'function') {
        const info = valhalla.ensureValhallaInfo(player);
        packets.splice(1, 0, { tag: 4100, msgUid: 0, data: { result: 0, ...valhalla.buildValhallaPayload(info) } });
      }
    }
    return packets;
  }

  const assetCfg = (config.get('AssetsConfig') || {})[itemId] || (config.get('AssetsConfig') || {})[String(itemId)] || null;
  const priceCfg = assetCfg && assetCfg.price && toSafeItemId(assetCfg.price.id) > 0
    ? { id: toSafeItemId(assetCfg.price.id), count: Math.max(0, Math.floor(Number(assetCfg.price.count) || 0)) }
    : { id: 2, count: 10 };
  const rewardRows = priceCfg.count > 0 ? [{ id: priceCfg.id, count: priceCfg.count }] : [];

  consumeBagItem(player, itemId, count);
  const rewardResult = addRewardRowsToPlayer(player, rewardRows, count);
  const silver = priceCfg.id === 2 ? priceCfg.count * count : 0;
  const { ticketItemId, ticketRate, enabled } = getOptionalSaleTicketConfig();
  const ticketCount = enabled ? Math.max(0, Math.floor(silver * ticketRate)) : 0;
  player.items = player.items || {};
  if (enabled && ticketCount > 0) {
    player.items[ticketItemId] = (Number(player.items[ticketItemId]) || 0) + ticketCount;
    rewardResult.itemDeltas.push({ id: ticketItemId, count: ticketCount });
    rewardResult.rewardInfo.items.push({ id: ticketItemId, count: ticketCount });
  }

  await playerService.savePlayer(session.userId, player);

  const soldLeft = Number(player.items[itemId]) || 0;
  const changedMap = new Map(rewardResult.changed.map((row) => [row.id, row]));
  changedMap.set(itemId, { id: itemId, count: soldLeft });
  if (enabled) {
    changedMap.set(ticketItemId, { id: ticketItemId, count: Number(player.items[ticketItemId]) || 0 });
  }
  const changed = Array.from(changedMap.values()).sort((a, b) => a.id - b.id);

  return [
    {
      tag: 1202,
      msgUid: 0,
      data: {
        result: 0,
        items: [{ id: itemId, count: -count }, ...rewardResult.itemDeltas],
        changed,
      },
    },
    {
      tag: 1301,
      msgUid,
      data: {
        result: 0,
        itemId,
          count,
          silver,
          rewards: rewardResult.rewardInfo,
          rewardInfo: rewardResult.rewardInfo,
          ...(enabled ? { ticketItemId, ticketCount } : {}),
        },
      },
  ];
}

// 装备替换 (tag:2200)
async function handleEquipReplace(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 2200, msgUid, data: { result: -1 } };

  ensureEquipInfo(player);
  const replaced = replaceOpenEquipToPlan(player, {
    uid: params && params.uid,
    listId: params && params.listId,
    mapId: params && params.mapId,
  });

  if (replaced.result === 1) {
    return {
      tag: 2200,
      msgUid,
      data: { result: 1, desc: replaced.desc || 'equip replace failed' },
    };
  }

  const taskChanged = !!refreshMainTaskProgress(player);
  playerService.savePlayerDeferred(session.userId, player).catch((err) => {
    logger.warn(`[Item] async equip replace save failed user=${session.userId}: ${err.message}`);
  });
  const response = {
    tag: 2200,
    msgUid,
    data: {
      result: 0,
      uid: replaced.equip && replaced.equip.uid,
      listId: replaced.usedListId,
      mapId: replaced.mapId,
    },
  };

  // Match online behavior: push the active task delta before the 2200 success ack.
  return taskChanged ? [...buildTaskUpdatePacketsSafe(player), response] : response;
}

// 鍑哄敭瑁呭 (tag:2201)
async function handleEquipSale(params, session, msgUid) {
  const player = session.player;
  if (!player) {
    return {
      tag: 2201,
      msgUid,
      data: { result: -1, uids: [], rewardInfo: { items: [] } },
    };
  }

  ensureEquipInfo(player);
  const result = saleOpenEquips(player, params && params.uids);

  const silverGain = Math.max(
    0,
    Number(
      (result.rewardInfo && Array.isArray(result.rewardInfo.items)
        ? result.rewardInfo.items.find((row) => Number(row && row.id) === 2)
        : null
      )?.count || 0
    )
  );
  const taskChanged = !!addEquipSaleProgress(
    player,
    Array.isArray(result.uids) ? result.uids.length : 0,
    silverGain,
  );

  // Persist through the per-player queue without blocking the protocol ACK.
  // PlayerService snapshots the object at enqueue time, and WSServer detects
  // the pending save so it will not issue a duplicate full save.
  playerService.savePlayerDeferred(session.userId, player).catch((err) => {
    logger.warn(`[Item] async equip sale save failed user=${session.userId}: ${err.message}`);
  });

  const rewardItems = Array.isArray(result.rewardInfo && result.rewardInfo.items)
    ? result.rewardInfo.items
        .map((row) => ({ id: Number(row && row.id) || 0, count: Number(row && row.count) || 0 }))
        .filter((row) => row.id > 0 && row.count > 0)
    : [];
  const rewardInfo = {
    items: rewardItems,
    equips: [],
    swords: [],
    pets: [],
    artifacts: [],
    gems: [],
    valhalla: [],
    bloodline: [],
    fashion: [],
    sailor: [],
    elves: [],
    extraReward: {},
  };

  const response = [
    {
      tag: 1212,
      data: { type: 38, endTime: 0 },
    },
    {
      tag: 1202,
      data: {
        items: rewardItems,
      },
    },
    {
      tag: 2201,
      msgUid,
      data: {
        uids: Array.isArray(result.uids) ? result.uids.slice() : [],
        rewardInfo,
      },
    },
  ];

  if (taskChanged) {
    response.splice(2, 0, ...buildTaskUpdatePacketsSafe(player));
  }
  return response;
}

// 商店购买 (tag:1210)
async function handleShopBuy(params, session, msgUid) {
  const goodsId = params.goodsId || params.id;
  const parsedCount = parsePositiveCount(params && params.count, 1);
  if (!parsedCount.valid) {
    return { tag: 1210, msgUid, data: { result: -1, msg: 'invalid count' } };
  }
  const count = parsedCount.count;
  const result = await handleMultiBuyItem({ require: { [goodsId]: count } }, session, msgUid);
  const resultPacket = getPurchaseResultPacket(result, msgUid);
  if (!resultPacket || resultPacket.tag !== 1202) {
    return { tag: 1210, msgUid, data: { result: -1 } };
  }
  const packets = Array.isArray(result) ? result.slice() : [result];
  packets.push(
    {
      tag: 1210,
      msgUid,
        data: {
          result: resultPacket.data && resultPacket.data.result === 0 ? 0 : -1,
          goodsId,
          count,
          items: resultPacket.data && Array.isArray(resultPacket.data.items) ? resultPacket.data.items : [],
          changed: resultPacket.data && Array.isArray(resultPacket.data.changed) ? resultPacket.data.changed : [],
          timeRecords: resultPacket.data && resultPacket.data.timeRecords ? resultPacket.data.timeRecords : buildItemTimeRecords(session && session.player),
          rewards: resultPacket.data && resultPacket.data.rewardInfo ? resultPacket.data.rewardInfo : { items: [], equips: [] },
          rewardInfo: resultPacket.data && resultPacket.data.rewardInfo ? resultPacket.data.rewardInfo : { items: [], equips: [] },
        },
    }
  );
  return packets;
}

module.exports = {
  handleGetItems, handleExchangeItem, handleMultiBuyItem,
  handleUseItem, handleSaleItem, handleEquipReplace, handleEquipSale, handleShopBuy,
  buildUseRecordsPayload,
};
