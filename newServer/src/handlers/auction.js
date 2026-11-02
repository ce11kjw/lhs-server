/**
 * Auction handlers
 * tag:5100 enter, 5101 on-shelf RPC, 5102 offer, 5103 off shelf, 5105 bulk on-shelf push
 */

const playerService = require('../services/PlayerService');

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensurePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureAuctionInfo(player) {
  if (!player || typeof player !== 'object') {
    return {
      records: [],
      auctions: [],
      deals: [],
      nextAuctionUid: 1,
      nextRecordUid: 1,
    };
  }

  player.auctionInfo = ensurePlainObject(player.auctionInfo);
  const info = player.auctionInfo;
  info.records = ensureArray(info.records);
  info.auctions = ensureArray(info.auctions);
  info.deals = ensureArray(info.deals);
  info.nextAuctionUid = Math.max(1, toSafeInt(info.nextAuctionUid, info.auctions.length + 1));
  info.nextRecordUid = Math.max(1, toSafeInt(info.nextRecordUid, info.records.length + 1));
  return info;
}

function buildAuctionPayload(info) {
  return {
    records: info.records,
    auctions: info.auctions,
    deals: info.deals,
  };
}

function nextAuctionUid(info) {
  const id = Math.max(1, toSafeInt(info.nextAuctionUid, 1));
  info.nextAuctionUid = id + 1;
  return id;
}

function nextRecordUid(info) {
  const id = Math.max(1, toSafeInt(info.nextRecordUid, 1));
  info.nextRecordUid = id + 1;
  return id;
}

function getPlayerItemCount(player, itemId) {
  if (!player || !player.items || typeof player.items !== 'object') return null;
  const value = Number(player.items[itemId]);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function setPlayerItemCount(player, itemId, count) {
  if (!player || !player.items || typeof player.items !== 'object') return;
  player.items[itemId] = Math.max(0, toSafeInt(count, 0));
}

function ensureCurrencies(player) {
  if (!player || typeof player !== 'object') return { gold: 0, diamond: 0, silver: 0 };
  player.currencies = ensurePlainObject(player.currencies);
  player.currencies.gold = Math.max(0, toSafeInt(player.currencies.gold, 0));
  player.currencies.diamond = Math.max(0, toSafeInt(player.currencies.diamond, 0));
  player.currencies.silver = Math.max(0, toSafeInt(player.currencies.silver, 0));
  return player.currencies;
}

function buildRewardInfo(items) {
  return {
    items: Array.isArray(items) ? items : [],
    equips: [],
    bloodline: [],
  };
}

function addGold(player, count) {
  const currencies = ensureCurrencies(player);
  currencies.gold += Math.max(0, toSafeInt(count, 0));
}

async function handleAuctionEnter(_params, session, msgUid) {
  const info = ensureAuctionInfo(session.player);
  return {
    tag: 5100,
    msgUid,
    data: buildAuctionPayload(info),
  };
}

async function handleAuctionOnShelf(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 5101, msgUid, data: { result: -1 } };

  const info = ensureAuctionInfo(player);
  const itemId = Math.max(0, toSafeInt(params && params.id, 0));
  const count = Math.max(1, toSafeInt(params && params.count, 1));
  const price = Math.max(0, toSafeInt(params && params.price, 0));

  if (!itemId) {
    return { tag: 5101, msgUid, data: { result: 1 } };
  }

  const currentCount = getPlayerItemCount(player, itemId);
  if (currentCount !== null && currentCount < count) {
    return { tag: 5101, msgUid, data: { result: 2 } };
  }

  const item = {
    id: nextAuctionUid(info),
    type: Math.max(0, toSafeInt(params && params.type, 0)),
    itemId,
    item: { id: itemId, count },
    count,
    price,
    playerId: player.playerId || '',
    playerName: player.name || '',
    bidderId: '',
    bidderName: '',
    status: 1,
    time: Math.floor(Date.now() / 1000) + 3600,
    hidename: 0,
    hasOffer: 0,
  };

  if (currentCount !== null) {
    setPlayerItemCount(player, itemId, currentCount - count);
  }

  info.auctions.push(item);
  await playerService.savePlayer(session.userId, player);

  return [
    { tag: 5101, msgUid, data: { result: 0 } },
    { tag: 5105, msgUid: 0, data: { items: [item] } },
  ];
}

async function handleAuctionOffer(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 5102, msgUid, data: { result: -1 } };

  const info = ensureAuctionInfo(player);
  const auctionId = Math.max(0, toSafeInt(params && params.id, 0));
  const offerPrice = Math.max(0, toSafeInt(params && params.price, 0));
  const hideName = Math.max(0, Math.min(1, toSafeInt(params && params.hidename, 0)));

  const item = info.auctions.find((row) => toSafeInt(row.id, 0) === auctionId);
  if (!item) {
    return { tag: 5102, msgUid, data: { result: 1 } };
  }
  if (item.playerId && item.playerId === player.playerId) {
    return { tag: 5102, msgUid, data: { result: 1 } };
  }
  if (offerPrice <= toSafeInt(item.price, 0)) {
    return { tag: 5102, msgUid, data: { result: 2 } };
  }

  item.price = offerPrice;
  item.bidderId = player.playerId || '';
  item.bidderName = hideName ? '' : (player.name || '');
  item.hidename = hideName;
  item.hasOffer = 1;
  item.time = Math.floor(Date.now() / 1000) + 1800;

  const record = {
    uid: nextRecordUid(info),
    type: 0,
    receive: 0,
    auctionId: item.id,
    price: item.price,
    time: Math.floor(Date.now() / 1000),
  };
  info.records.push(record);

  await playerService.savePlayer(session.userId, player);

  return {
    tag: 5102,
    msgUid,
    data: {
      result: 0,
      id: item.id,
      price: item.price,
      bidderId: item.bidderId,
      bidderName: item.bidderName,
      hidename: item.hidename,
      item,
      record,
    },
  };
}

async function handleAuctionOffShelf(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 5103, msgUid, data: { result: -1 } };

  const info = ensureAuctionInfo(player);
  const auctionId = Math.max(0, toSafeInt(params && params.id, 0));

  const idx = info.auctions.findIndex((row) => toSafeInt(row.id, 0) === auctionId);
  if (idx < 0) {
    return { tag: 5103, msgUid, data: { result: 1, id: auctionId } };
  }

  const item = info.auctions[idx];
  if (item.playerId && item.playerId !== player.playerId) {
    return { tag: 5103, msgUid, data: { result: 2, id: auctionId } };
  }
  if (item.bidderId) {
    return { tag: 5103, msgUid, data: { result: 3, id: auctionId } };
  }

  info.auctions.splice(idx, 1);

  const currentCount = getPlayerItemCount(player, item.itemId);
  if (currentCount !== null) {
    setPlayerItemCount(player, item.itemId, currentCount + Math.max(1, toSafeInt(item.count, 1)));
  }

  await playerService.savePlayer(session.userId, player);

  return {
    tag: 5103,
    msgUid,
    data: {
      result: 0,
      id: auctionId,
    },
  };
}

async function handleAuctionRecordReward(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 5110, msgUid, data: { result: -1 } };

  const info = ensureAuctionInfo(player);
  const uid = Math.max(0, toSafeInt(params && params.uid, 0));
  const record = info.records.find((row) => toSafeInt(row.uid, 0) === uid);
  if (!record) {
    return { tag: 5110, msgUid, data: { result: 1, uid } };
  }
  if (toSafeInt(record.receive, 0) > 0) {
    return { tag: 5110, msgUid, data: { result: 2, uid } };
  }

  const rewardCount = Math.max(1, Math.floor(Math.max(1, toSafeInt(record.price, 100)) * 0.1));
  const rewardInfo = buildRewardInfo([{ id: 3, count: rewardCount }]);
  record.receive = 1;
  addGold(player, rewardCount);
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 5110,
    msgUid,
    data: {
      result: 0,
      uid,
      rewardInfo,
    },
  };
}

async function handleAuctionRecycleItem(params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 5111, msgUid, data: { result: -1 } };

  const itemId = Math.max(0, toSafeInt(params && params.id, 0));
  const count = Math.max(1, toSafeInt(params && params.count, 1));
  const price = Math.max(1, toSafeInt(params && params.price, 100));
  if (!itemId) {
    return { tag: 5111, msgUid, data: { result: 1 } };
  }

  const currentCount = getPlayerItemCount(player, itemId);
  if (currentCount !== null && currentCount < count) {
    return { tag: 5111, msgUid, data: { result: 2 } };
  }
  if (currentCount !== null) {
    setPlayerItemCount(player, itemId, currentCount - count);
  }

  const rewardCount = Math.max(1, Math.floor((price * count) / 10));
  const rewardInfo = buildRewardInfo([{ id: 3, count: rewardCount }]);
  addGold(player, rewardCount);
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 5111,
    msgUid,
    data: {
      result: 0,
      rewardInfo,
    },
  };
}

async function handleAuctionRecordRewardAll(_params, session, msgUid) {
  const player = session.player;
  if (!player) return { tag: 5113, msgUid, data: { result: -1 } };

  const info = ensureAuctionInfo(player);
  const claimable = info.records.filter((row) => toSafeInt(row.receive, 0) <= 0);
  if (claimable.length <= 0) {
    return {
      tag: 5113,
      msgUid,
      data: {
        result: 0,
        uids: [],
        rewardInfo: buildRewardInfo([]),
      },
    };
  }

  let total = 0;
  const uids = [];
  for (const record of claimable) {
    record.receive = 1;
    uids.push(toSafeInt(record.uid, 0));
    total += Math.max(1, Math.floor(Math.max(1, toSafeInt(record.price, 100)) * 0.1));
  }
  const rewardInfo = buildRewardInfo([{ id: 3, count: total }]);
  addGold(player, total);
  await playerService.savePlayer(session.userId, player);

  return {
    tag: 5113,
    msgUid,
    data: {
      result: 0,
      uids,
      rewardInfo,
    },
  };
}

module.exports = {
  ensureAuctionInfo,
  buildAuctionPayload,
  handleAuctionEnter,
  handleAuctionOnShelf,
  handleAuctionOffer,
  handleAuctionOffShelf,
  handleAuctionRecordReward,
  handleAuctionRecycleItem,
  handleAuctionRecordRewardAll,
};
