const Mail = require('../db/models/Mail');
const playerService = require('../services/PlayerService');
const messageService = require('../services/MessageService');
const logger = require('../logger');
const { grantRewardInfo } = require('./raid');
const { buildItemSyncPayload } = require('../services/PlayerGrantService');
const rewardGrant = require('../services/RewardGrantService');

function toSafeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n);
}

function toSafeId(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function toClientSender(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.floor(value));
  const text = String(value).trim();
  return /^-?\d+$/.test(text) ? text : '';
}

function parseMailIds(params = {}) {
  if (Array.isArray(params.ids)) {
    return params.ids.map(toSafeId).filter(Boolean);
  }
  if (Array.isArray(params.handles)) {
    return params.handles.map(toSafeId).filter(Boolean);
  }
  const single = params.id || params.mailId || params.uid || params.handle;
  const id = toSafeId(single);
  return id ? [id] : [];
}

function buildMailUpdateData(ids = [], read = 1, receive = 0) {
  return ids.map((id) => ({
    id,
    handle: id,
    read,
    receive,
  }));
}

function normalizeAttachments(val) {
  if (Array.isArray(val)) {
    return val
      .map((item) => ({
        id: toSafeInt(item && item.id),
        count: toSafeInt(item && item.count),
      }))
      .filter((item) => item.id > 0 && item.count > 0);
  }

  if (val && typeof val === 'object') {
    return Object.keys(val)
      .map((id) => ({
        id: toSafeInt(id),
        count: toSafeInt(val[id]),
      }))
      .filter((item) => item.id > 0 && item.count > 0);
  }

  return [];
}

function scheduleMailPlayerSave(session, player, reason = 'mail') {
  const userId = session && session.userId;
  if (!userId || !player) return;
  if (session._mailSaveScheduled) return;
  session._mailSaveScheduled = true;
  Promise.resolve().then(async () => {
    try {
      await playerService.savePlayer(userId, player);
    } catch (err) {
      logger.warn(`[Mail] async save failed ${reason} user=${userId}: ${err.message}`);
    } finally {
      session._mailSaveScheduled = false;
    }
  });
}

function toClientMail(row = {}) {
  const attachments = normalizeAttachments(row.attachments || row.rewardData);
  const mailId = toSafeId(row._id || row.id || row.handle);
  const text = row.text || row.content || '';
  return {
    id: mailId,
    handle: mailId,
    templateId: Math.max(0, toSafeInt(row.templateId, 0)),
    params: Array.isArray(row.params) ? row.params.map((value) => String(value)) : [],
    title: row.title || '',
    text,
    content: text,
    // MailData converts non-template senders with Number(sender); never send
    // localized text here or the client will call ConvertLanguageToText(NaN).
    sender: toClientSender(row.sender),
    attachments,
    rewardData: attachments,
    minClaimLevel: Math.max(0, toSafeInt(row.minClaimLevel, 0)),
    read: row.read ? 1 : 0,
    receive: row.claimed ? 1 : 0,
    claimed: row.claimed ? 1 : 0,
    sendtime: row.createdAt ? Math.floor(new Date(row.createdAt).getTime() / 1000) : 0,
    createdAt: row.createdAt ? new Date(row.createdAt).getTime() : 0,
    expireAt: row.expireAt ? new Date(row.expireAt).getTime() : 0,
    adCount: Math.max(0, toSafeInt(row.adCount, 0)),
  };
}

function buildEmptyRewardInfo() {
  return rewardGrant.buildEmptyRewardInfo();
}

function mergeRewardItem(map, id, count) {
  const safeId = toSafeInt(id);
  const safeCount = toSafeInt(count);
  if (safeId <= 0 || safeCount <= 0) return;
  map.set(safeId, (map.get(safeId) || 0) + safeCount);
}

function hasRewardInfoContent(rewardInfo = {}) {
  return ['items', 'equips', 'swords', 'pets', 'artifacts', 'gems', 'valhalla', 'bloodline', 'fashion', 'elves', 'sailor']
    .some((key) => Array.isArray(rewardInfo[key]) && rewardInfo[key].length > 0);
}

function buildMailItemSyncPayload(player, rewardItems = []) {
  const payload = buildItemSyncPayload(player, rewardItems.map((row) => row.id));
  return {
    ...payload,
    // 1202.items is an item delta list on this client; absolute counts belong in changed.
    items: rewardItems.map((row) => ({ id: toSafeInt(row.id), count: toSafeInt(row.count) })),
  };
}

function buildMountInfoUpdate(player) {
  // Avoid a hard top-level dependency because RewardGrantService also loads mount handlers lazily.
  // eslint-disable-next-line global-require
  const mount = require('./mount');
  const info = player && player.swordInfo ? player.swordInfo : {};
  const buildInfo = mount && typeof mount.buildMountInfoUpdatePayload === 'function'
    ? mount.buildMountInfoUpdatePayload
    : (value) => value;
  return {
    result: 0,
    uid: toSafeInt(info.equippedUid, 0),
    info: buildInfo(info),
  };
}

async function handleMailInit(_params, session, msgUid) {
  const userId = session && session.userId;
  if (!userId) {
    return { tag: 1100, msgUid, data: { result: -1, mailData: [], unreadCount: 0 } };
  }

  const rows = await Mail.find({ userId }).sort({ createdAt: -1 }).lean();
  const mailData = (rows || []).map(toClientMail);
  return {
    tag: 1100,
    msgUid,
    data: {
      result: 0,
      mailData,
      unreadCount: mailData.filter((mail) => !mail.read).length,
    },
  };
}

async function handleMailRead(params, session, msgUid) {
  const userId = session && session.userId;
  if (!userId) {
    return { tag: 1101, msgUid, data: { result: -1, ids: [], handles: [], updateData: [], items: [] } };
  }

  const ids = parseMailIds(params);
  if (ids.length === 0) {
    return { tag: 1101, msgUid, data: { result: -1, ids: [], handles: [], updateData: [], items: [] } };
  }

  await Mail.updateMany(
    { userId, _id: { $in: ids } },
    { $set: { read: true } }
  );

  return {
    tag: 1101,
    msgUid,
    data: {
      result: 0,
      ids,
      handles: ids,
      updateData: buildMailUpdateData(ids, 1, 0),
      items: [],
    },
  };
}

async function handleMailClaim(params, session, msgUid) {
  const userId = session && session.userId;
  const player = session && session.player;
  if (!userId || !player) {
    return {
      tag: 1103,
      msgUid,
      data: { result: -1, ids: [], handles: [], updateData: [], rewardInfo: buildEmptyRewardInfo() },
    };
  }

  const ids = parseMailIds(params);
  if (ids.length === 0) {
    return {
      tag: 1103,
      msgUid,
      data: { result: -1, ids: [], handles: [], updateData: [], rewardInfo: buildEmptyRewardInfo() },
    };
  }

  const rows = await Mail.find({ userId, _id: { $in: ids } }).lean();
  const rewardInfoMap = new Map();
  const rewardEquips = [];
  const rewardSwords = [];
  const rewardPets = [];
  const rewardPetSouls = [];
  const blockedMail = (rows || []).find((mail) => !mail.claimed && toSafeInt(mail.minClaimLevel, 0) > toSafeInt(player.level, 1));
  if (blockedMail) {
    const needLevel = toSafeInt(blockedMail.minClaimLevel, 0);
    return {
      tag: 1103,
      msgUid,
      data: {
        result: -2,
        msg: `角色达到${needLevel}级后可领取`,
        minClaimLevel: needLevel,
        ids,
        handles: ids,
        updateData: [],
        rewardInfo: buildEmptyRewardInfo(),
      },
    };
  }

  (rows || []).forEach((mail) => {
    if (!mail || mail.claimed) return;
    const attachments = normalizeAttachments(mail.attachments || mail.rewardData);
    attachments.forEach((item) => {
      const kind = rewardGrant.getRewardKind(item.id);
      if (kind === 'sword' || kind === 'pet' || kind === 'petSoul') {
        const grantResult = rewardGrant.grantRewardRow(player, item, 1);
        rewardSwords.push(...grantResult.rewardSwords);
        rewardPets.push(...grantResult.rewardPets);
        rewardPetSouls.push(...grantResult.rewardPetSouls);
        return;
      }
      const grantResult = grantRewardInfo(player, [item]);
      (grantResult.rewardInfo.items || []).forEach((rewardItem) => {
        mergeRewardItem(rewardInfoMap, rewardItem.id, rewardItem.count);
      });
      rewardEquips.push(...(grantResult.rewardInfo.equips || []));
    });
  });

  const rewardItems = Array.from(rewardInfoMap.entries())
    .map(([id, count]) => ({ id: toSafeInt(id), count: toSafeInt(count) }))
    .sort((a, b) => a.id - b.id);

  await Mail.updateMany(
    { userId, _id: { $in: ids } },
    { $set: { claimed: true, read: true } }
  );

  if (rewardItems.length > 0) {
    messageService.pushPlayerNotice(player, {
      type: 'mail',
      title: '邮件奖励',
      content: `领取了${ids.length}封邮件奖励`,
    });
  }

  scheduleMailPlayerSave(session, player, '1103');

  const rewardInfo = {
    ...buildEmptyRewardInfo(),
    items: rewardItems,
    equips: rewardEquips,
    swords: rewardSwords,
    pets: rewardPets,
  };
  const updateData = buildMailUpdateData(ids, 1, 1);
  const pushUpdate = {
    tag: 1103,
    msgUid: 0,
    data: {
      result: 0,
      ids,
      handles: ids,
      updateData,
      rewardInfo,
    },
  };
  const response = {
    tag: 1103,
    msgUid,
    data: {
      result: 0,
      ids,
      handles: ids,
      updateData,
      rewardInfo: hasRewardInfoContent(rewardInfo) ? rewardInfo : buildEmptyRewardInfo(),
    },
  };
  const packets = [];
  if (rewardItems.length > 0) {
    packets.push({
      tag: 1202,
      msgUid: 0,
      data: buildMailItemSyncPayload(player, rewardItems),
    });
  }
  if (rewardSwords.length > 0) {
    packets.push({ tag: 3201, msgUid: 0, data: { result: 0, data: rewardSwords } });
    packets.push({ tag: 3200, msgUid: 0, data: buildMountInfoUpdate(player) });
  }
  if (rewardPets.length > 0) {
    packets.push({ tag: 3300, msgUid: 0, data: { result: 0, data: rewardPets } });
  }
  rewardPetSouls.forEach((soul) => {
    packets.push({ tag: 6901, msgUid: 0, data: { result: 0, data: soul } });
  });
  // MailModel only opens reward animation from regNetMsg(1103), not from the RPC callback.
  packets.push(pushUpdate);
  packets.push(response);
  return packets.length === 1 ? response : packets;
}

async function handleMailDelete(params, session, msgUid) {
  const userId = session && session.userId;
  if (!userId) {
    return { tag: 1102, msgUid, data: { result: -1, ids: [], handles: [], updateData: [], rewardInfo: { items: [], equips: [] } } };
  }

  const ids = parseMailIds(params);
  if (ids.length === 0) {
    return { tag: 1102, msgUid, data: { result: -1, ids: [], handles: [], updateData: [], rewardInfo: { items: [], equips: [] } } };
  }

  await Mail.deleteMany({ userId, _id: { $in: ids } });
  return {
    tag: 1102,
    msgUid,
    data: {
      result: 0,
      ids,
      handles: ids,
      updateData: [],
      rewardInfo: { items: [], equips: [] },
    },
  };
}

module.exports = {
  handleMailInit,
  handleMailRead,
  handleMailClaim,
  handleMailDelete,
  parseMailIds,
  normalizeAttachments,
  toClientMail,
};
