const Agent = require('../models/Agent');
const config = require('../config');
const { generateUniqueInviteCode } = require('../utils/inviteCode');
const { isReservedUsername } = require('../utils/reservedUsername');

async function ensureDefaultAdmin(defaultAdmin = config.defaultAdmin) {
  if (!defaultAdmin || !defaultAdmin.enabled) {
    return { action: 'disabled' };
  }

  const username = String(defaultAdmin.username || '').trim();
  const password = String(defaultAdmin.password || '');
  const phone = String(defaultAdmin.phone || '').trim();

  if (!username || !password || !phone) {
    return { action: 'skipped', reason: 'missing_config' };
  }
  if (isReservedUsername(username)) {
    return { action: 'skipped', reason: 'reserved_username', username };
  }
  if (!config.isStrongPassword(password, username)) {
    return { action: 'skipped', reason: 'weak_password', username };
  }

  const existingByUsername = await Agent.findOne({ username });
  if (existingByUsername) {
    let changed = false;
    if (existingByUsername.role === 'admin') {
      existingByUsername.role = 'root';
      existingByUsername.accessPermissions = ['root'];
      changed = true;
    }

    if (defaultAdmin.syncPassword && ['root', 'admin'].includes(existingByUsername.role)) {
      const matches = typeof existingByUsername.comparePassword === 'function'
        ? await existingByUsername.comparePassword(password)
        : false;
      if (!matches) {
        existingByUsername.password = password;
        changed = true;
      }
    }

    if (changed) {
      await existingByUsername.save();
      return { action: 'updated_access', username, isAdmin: true, isRoot: existingByUsername.role === 'root' };
    }

    return {
      action: 'exists',
      username,
      isAdmin: ['root', 'admin'].includes(existingByUsername.role),
      isRoot: existingByUsername.role === 'root',
    };
  }

  const existingByPhone = await Agent.findOne({ phone });
  if (existingByPhone) {
    return { action: 'skipped', reason: 'phone_exists', username };
  }

  const inviteCode = await generateUniqueInviteCode();
  const admin = new Agent({
    username,
    password,
    phone,
    inviteCode,
    level: 0,
    role: 'root',
    accessPermissions: ['root'],
    status: 'active',
    commissionRate: config.defaultCommissionRate,
  });

  await admin.save();
  return { action: 'created', username, inviteCode, isRoot: true };
}

module.exports = { ensureDefaultAdmin };
