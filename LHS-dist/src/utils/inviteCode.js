/**
 * 生成6位大写字母+数字的邀请码
 */
function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * 生成唯一邀请码（检查数据库唯一性）
 * @param {number} maxRetries - 最大重试次数
 * @returns {Promise<string>} 唯一邀请码
 */
async function generateUniqueInviteCode(maxRetries = 10) {
  const Agent = require('../models/Agent');
  for (let i = 0; i < maxRetries; i++) {
    const code = generateCode();
    const exists = await Agent.findOne({ inviteCode: code });
    if (!exists) {
      return code;
    }
  }
  throw new Error('生成唯一邀请码失败，请稍后重试');
}

module.exports = { generateCode, generateUniqueInviteCode };
