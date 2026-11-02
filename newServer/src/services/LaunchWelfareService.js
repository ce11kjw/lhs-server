const Mail = require('../db/models/Mail');

const LAUNCH_WELFARE_EVENT_KEY = 'launch_welfare_20260523_7001';
const LAUNCH_WELFARE_MIN_LEVEL = 3;
const LAUNCH_WELFARE_ATTACHMENTS_7001 = [
  
  { id: 1, count: 500000 },
	{ id: 2, count: 20000000 },
  { id: 4, count: 5000 },
  { id: 6, count: 1000 },
  { id: 22501, count: 1 },
	{ id: 1001, count: 300 },
	{ id: 1003, count: 300 },
	{ id: 1002, count: 300 },
];
const LAUNCH_WELFARE_CONTENT = '尊敬的玩家，您的上线福利已准备好。请记得领取到账哦！';

function ensurePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function ensureLaunchWelfareMail(player = {}, userId = '') {
  const safeUserId = String(userId || player.userId || '').trim();
  if (!safeUserId) return false;

  player.mailFlags = ensurePlainObject(player.mailFlags);
  if (player.mailFlags[LAUNCH_WELFARE_EVENT_KEY]) return false;

  const existing = await Mail.findOne({ userId: safeUserId, eventKey: LAUNCH_WELFARE_EVENT_KEY }).lean().catch(() => null);
  if (existing) {
    player.mailFlags[LAUNCH_WELFARE_EVENT_KEY] = true;
    return true;
  }

  await Mail.create({
    userId: safeUserId,
    eventKey: LAUNCH_WELFARE_EVENT_KEY,
    minClaimLevel: LAUNCH_WELFARE_MIN_LEVEL,
    title: '上线福利',
    sender: '系统',
    content: LAUNCH_WELFARE_CONTENT,
    text: LAUNCH_WELFARE_CONTENT,
    attachments: LAUNCH_WELFARE_ATTACHMENTS_7001,
  },);
  player.mailFlags[LAUNCH_WELFARE_EVENT_KEY] = true;
  return true;
}

module.exports = {
  LAUNCH_WELFARE_ATTACHMENTS_7001,
  LAUNCH_WELFARE_EVENT_KEY,
  LAUNCH_WELFARE_MIN_LEVEL,
  LAUNCH_WELFARE_CONTENT,
  ensureLaunchWelfareMail,
};
