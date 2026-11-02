const crypto = require('crypto');
const bcrypt = require('bcrypt');
const Account = require('../db/models/Account');
const Player = require('../db/models/Player');
const playerService = require('./PlayerService');
const serverConfigService = require('./ServerConfigService');
const { ensureRoleAppearance } = require('./RoleAppearanceService');
const distClient = require('./DistClient');

const BCRYPT_PREFIX = '$2';
const BCRYPT_ROUNDS = 10;
const ACCOUNT_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{3,19}$/;
const INVITE_CODE_PATTERN = /^[A-Za-z0-9]{6}$/;
const WEAK_USER_PASSWORDS = new Set([
  '12345678',
  '123456789',
  'password',
  'password123',
  'qwerty123',
  'abc123456',
]);

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function normalizeAccountId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePassword(value) {
  return String(value || '');
}

function normalizeInviteCode(value) {
  return String(value || '').trim().toUpperCase();
}

function validateAccountId(accountIdInput) {
  const accountId = normalizeAccountId(accountIdInput);
  if (!accountId) {
    return { ok: false, code: 'ACCOUNT_REQUIRED', message: '请输入账号' };
  }
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    return {
      ok: false,
      code: 'ACCOUNT_FORMAT_INVALID',
      message: '账号需为4-20位字母、数字或下划线，且必须以字母开头',
    };
  }
  return { ok: true, accountId };
}

function validateUserPassword(passwordInput, accountIdInput = '') {
  const password = normalizePassword(passwordInput);
  const lowerPassword = password.toLowerCase();
  const accountId = normalizeAccountId(accountIdInput);
  if (!password) {
    return { ok: false, code: 'PASSWORD_REQUIRED', message: '请输入密码' };
  }
  if (password.length < 8 || password.length > 32) {
    return { ok: false, code: 'PASSWORD_LENGTH_INVALID', message: '密码需为8-32位' };
  }
  if (/\s/.test(password)) {
    return { ok: false, code: 'PASSWORD_SPACE_INVALID', message: '密码不能包含空格' };
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return { ok: false, code: 'PASSWORD_COMPLEXITY_INVALID', message: '密码需同时包含字母和数字' };
  }
  if (WEAK_USER_PASSWORDS.has(lowerPassword)) {
    return { ok: false, code: 'PASSWORD_TOO_WEAK', message: '密码过于简单，请更换' };
  }
  if (accountId && lowerPassword.includes(accountId)) {
    return { ok: false, code: 'PASSWORD_CONTAINS_ACCOUNT', message: '密码不能包含账号' };
  }
  return { ok: true, password };
}

function validateInviteCode(inviteCodeInput) {
  const inviteCode = normalizeInviteCode(inviteCodeInput);
  if (!inviteCode) return { ok: true, inviteCode: '' };
  if (!INVITE_CODE_PATTERN.test(inviteCode)) {
    return { ok: false, code: 'INVITE_CODE_INVALID', message: '代理邀请码必须为6位字母或数字' };
  }
  return { ok: true, inviteCode };
}

function validateRegisterInput(accountIdInput, passwordInput, confirmPasswordInput) {
  const accountValidation = validateAccountId(accountIdInput);
  if (!accountValidation.ok) return accountValidation;

  const passwordValidation = validateUserPassword(passwordInput, accountValidation.accountId);
  if (!passwordValidation.ok) return passwordValidation;

  if (confirmPasswordInput !== undefined && normalizePassword(confirmPasswordInput) !== passwordValidation.password) {
    return { ok: false, code: 'PASSWORD_CONFIRM_MISMATCH', message: '两次输入的密码不一致' };
  }

  return {
    ok: true,
    accountId: accountValidation.accountId,
    password: passwordValidation.password,
  };
}

function hashLegacyPassword(password) {
  return crypto.createHash('sha256').update(normalizePassword(password), 'utf8').digest('hex');
}

function isBcryptHash(value) {
  return String(value || '').startsWith(BCRYPT_PREFIX);
}

async function hashPassword(password) {
  return bcrypt.hash(normalizePassword(password), BCRYPT_ROUNDS);
}

async function verifyPassword(password, passwordHash) {
  const normalizedHash = String(passwordHash || '');
  if (!normalizedHash) return { matched: false, needsUpgrade: false };
  if (isBcryptHash(normalizedHash)) {
    return { matched: await bcrypt.compare(normalizePassword(password), normalizedHash), needsUpgrade: false };
  }
  return {
    matched: hashLegacyPassword(password) === normalizedHash,
    needsUpgrade: true,
  };
}

function buildRandomText(len = 6) {
  return crypto.randomBytes(Math.max(4, len)).toString('hex').slice(0, len);
}

function getDefaultServerId() {
  return toSafeInt(process.env.DEFAULT_SERVER_ID, 1001) || 1001;
}

function normalizeRoleName(name, fallbackPrefix = 'wk_') {
  const trimmed = String(name || '').trim();
  if (trimmed) return trimmed.slice(0, 24);
  return `${fallbackPrefix}${buildRandomText(6)}`;
}

function sortRoles(roles = []) {
  return roles.slice().sort((a, b) => toSafeInt(a.createTime, 0) - toSafeInt(b.createTime, 0));
}

function patchAccountRole(account, roleId, patch = {}) {
  if (!account || !Array.isArray(account.roles)) return null;
  const target = account.roles.find((role) => String(role && role.roleId) === String(roleId));
  if (!target) return null;
  Object.assign(target, patch);
  if (typeof account.markModified === 'function') account.markModified('roles');
  return target;
}

function normalizeRoleSelection(options = {}) {
  if (options.deferRoleSelection === true || options.preserveUnselectedRole === true) {
    return { kungfuId: 0, subJob: 0 };
  }
  const kungfuId = Math.max(1, toSafeInt(options.kungfuId, 4));
  const subJob = Math.max(0, toSafeInt(options.subJob, 0));
  return { kungfuId, subJob };
}

function buildRoleIds(accountId, serverId) {
  const now = Date.now();
  const short = buildRandomText(6);
  return {
    roleId: `r_Wk_${serverId}_${short}_${now}`,
    userId: `u_Wk_${serverId}_${short}_${now}`,
  };
}

async function resolveServerName(serverId) {
  const safeServerId = toSafeInt(serverId, getDefaultServerId());
  try {
    const row = await serverConfigService.findServerConfig(safeServerId);
    return String(row && row.serverName ? row.serverName : '').trim();
  } catch (_err) {
    return '';
  }
}

async function applyInviteToPlayer(player, inviteCodeInput) {
  const inviteCode = normalizeInviteCode(inviteCodeInput);
  if (!player || !inviteCode) return player;

  const nextPlayerState = { inviteCode };
  if (player.playerId) {
    try {
      const bindResult = await distClient.bindInvite(player.playerId, inviteCode);
      const agentId = bindResult
        && bindResult.data
        && (bindResult.data.agentId || (bindResult.data.data && bindResult.data.data.agentId));
      if (agentId) nextPlayerState.agentId = String(agentId);
      if (bindResult && bindResult.pendingCompensation) {
        nextPlayerState.distSync = {
          ...(player.distSync && typeof player.distSync === 'object' ? player.distSync : {}),
          bindInvite: {
            status: 'pending',
            lastError: bindResult.error || '',
            updatedAt: Date.now(),
          },
        };
      }
    } catch (err) {
      nextPlayerState.distSync = {
        ...(player.distSync && typeof player.distSync === 'object' ? player.distSync : {}),
        bindInvite: {
          status: 'pending',
          lastError: err && err.message ? err.message : 'bind invite failed',
          updatedAt: Date.now(),
        },
      };
    }
  }

  return {
    ...player,
    ...nextPlayerState,
  };
}

async function createAccount(accountIdInput, passwordInput, options = {}) {
  const accountId = normalizeAccountId(accountIdInput);
  const password = normalizePassword(passwordInput);
  if (!accountId || !password) {
    throw new Error('INVALID_ACCOUNT_OR_PASSWORD');
  }

  const inviteValidation = validateInviteCode(options.inviteCode);
  if (!inviteValidation.ok) {
    const error = new Error(inviteValidation.message);
    error.code = inviteValidation.code;
    throw error;
  }

  const existing = await Account.findOne({ accountId }).lean();
  if (existing) {
    throw new Error('ACCOUNT_EXISTS');
  }

  const account = await Account.create({
    accountId,
    passwordHash: await hashPassword(password),
    inviteCode: inviteValidation.inviteCode || null,
    agentId: options.agentId ? String(options.agentId) : null,
    roles: [],
    activeRoleByServer: {},
    lastLoginTime: 0,
    status: 1,
  });
  return account.toObject();
}

async function createRegisteredAccount(accountIdInput, passwordInput, confirmPasswordInput, options = {}) {
  const validation = validateRegisterInput(accountIdInput, passwordInput, confirmPasswordInput);
  if (!validation.ok) {
    const error = new Error(validation.message);
    error.code = validation.code;
    throw error;
  }

  const inviteValidation = validateInviteCode(options.inviteCode);
  if (!inviteValidation.ok) {
    const error = new Error(inviteValidation.message);
    error.code = inviteValidation.code;
    throw error;
  }

  return createAccount(validation.accountId, validation.password, {
    ...options,
    inviteCode: inviteValidation.inviteCode,
  });
}

async function createRandomAccount() {
  for (let i = 0; i < 20; i += 1) {
    const now = Date.now();
    const accountId = `guest_${String(now).slice(-6)}${buildRandomText(4)}`;
    const password = `pwd${buildRandomText(8)}`;
    try {
      const account = await createAccount(accountId, password);
      return { account, accountId, password };
    } catch (err) {
      if (String(err && err.message) === 'ACCOUNT_EXISTS') continue;
      throw err;
    }
  }
  throw new Error('CREATE_RANDOM_ACCOUNT_FAILED');
}

async function findAccount(accountIdInput) {
  const accountId = normalizeAccountId(accountIdInput);
  if (!accountId) return null;
  return Account.findOne({ accountId });
}

async function authAccount(accountIdInput, passwordInput) {
  const account = await findAccount(accountIdInput);
  if (!account || toSafeInt(account.status, 1) <= 0) return null;
  const verification = await verifyPassword(passwordInput, account.passwordHash);
  if (!verification.matched) return null;
  if (verification.needsUpgrade) {
    const nextHash = await hashPassword(passwordInput);
    await Account.updateOne(
      { _id: account._id, passwordHash: account.passwordHash },
      { $set: { passwordHash: nextHash } }
    );
    account.passwordHash = nextHash;
  }
  return account;
}

async function ensureAccountForLogin(accountIdInput, passwordInput, options = {}) {
  const accountId = normalizeAccountId(accountIdInput);
  const password = normalizePassword(passwordInput);
  if (!accountId || !password) return { account: null, newlyCreated: false };

  let account = await authAccount(accountId, password);
  if (account) return { account, newlyCreated: false };

  const allowAutoRegister = options.allowAutoRegister === true;
  if (!allowAutoRegister) return { account: null, newlyCreated: false };

  try {
    await createAccount(accountId, password, { inviteCode: options.inviteCode });
    account = await authAccount(accountId, password);
    return { account, newlyCreated: !!account };
  } catch (_err) {
    account = await authAccount(accountId, password);
    return { account, newlyCreated: false };
  }
}

async function createRole(accountIdInput, options = {}) {
  let account = await authAccount(accountIdInput, options.password);
  if (!account) {
    // Fallback: SDK may rotate tokens so the client-held password may no longer
    // match the stored hash.  If the account exists, allow role creation anyway
    // (same behaviour as SDKAuth's non-strict path).
    account = await findAccount(accountIdInput);
  }
  if (!account) throw new Error('AUTH_FAILED');

  const inviteValidation = validateInviteCode(options.inviteCode || account.inviteCode);
  if (!inviteValidation.ok) {
    const error = new Error(inviteValidation.message);
    error.code = inviteValidation.code;
    throw error;
  }
  const inviteCode = inviteValidation.inviteCode;
  if (inviteCode && !account.inviteCode) {
    account.inviteCode = inviteCode;
  }

  const serverId = toSafeInt(options.serverId, getDefaultServerId());
  const serverName = await resolveServerName(serverId);
  const existingRole = options.reuseExisting === false
    ? null
    : pickRole(account, { serverId, sameServerOnly: true });
  const switchedServer = toSafeInt(account.lastSelectedServerId, 0) > 0
    && toSafeInt(account.lastSelectedServerId, 0) !== serverId;
  const roleSelection = normalizeRoleSelection(options);
  const deferRoleSelection = options.deferRoleSelection === true || options.preserveUnselectedRole === true;
  if (existingRole) {
    patchAccountRole(account, existingRole.roleId, { serverName });
    if (options.resetExisting === true && switchedServer && existingRole.userId) {
      let resetPlayer = await playerService.resetPlayerForServerSwitch(existingRole.userId, {
        resetRoleSelection: deferRoleSelection,
      });
      if (resetPlayer && typeof resetPlayer === 'object') {
        resetPlayer.roleInfo = {
          ...(resetPlayer.roleInfo && typeof resetPlayer.roleInfo === 'object'
            ? resetPlayer.roleInfo
            : {}),
          ...roleSelection,
        };
        resetPlayer.serverId = serverId;
        resetPlayer.serverName = serverName;
        if (!deferRoleSelection) ensureRoleAppearance(resetPlayer);
        const savedPlayer = await playerService.savePlayer(existingRole.userId, resetPlayer);
        if (savedPlayer) resetPlayer = savedPlayer;
      }
    }
    account.activeRoleByServer = account.activeRoleByServer || {};
    account.activeRoleByServer[String(serverId)] = existingRole.roleId;
    account.lastSelectedServerId = serverId;
    account.markModified('activeRoleByServer');
    await account.save();
    return {
      role: existingRole,
      roles: sortRoles(Array.isArray(account.roles) ? account.roles : []),
    };
  }

  const roleNameBase = normalizeRoleName(options.name || options.firstName || options.roleName);
  let roleMeta = null;
  let createdPlayer = null;

  for (let i = 0; i < 10; i += 1) {
    const ids = buildRoleIds(account.accountId, serverId);
    const roleName = i === 0 ? roleNameBase : `${roleNameBase}_${i + 1}`;
    try {
      createdPlayer = await playerService.createPlayer(ids.userId, roleName, {
        accountId: account.accountId,
        roleId: ids.roleId,
        serverId,
        serverName,
        level: 1,
        exp: 0,
        equipInfo: {},
        ...(inviteCode ? { inviteCode } : {}),
      });
      if (createdPlayer && typeof createdPlayer === 'object') {
        createdPlayer.roleInfo = {
          ...(createdPlayer.roleInfo && typeof createdPlayer.roleInfo === 'object'
            ? createdPlayer.roleInfo
            : {}),
          ...roleSelection,
        };
        if (!deferRoleSelection) ensureRoleAppearance(createdPlayer);
        const savedPlayer = await playerService.savePlayer(ids.userId, createdPlayer);
        if (savedPlayer) {
          createdPlayer = savedPlayer;
        }
      }
      if (inviteCode) {
        createdPlayer = await applyInviteToPlayer(createdPlayer, inviteCode);
        const savedPlayer = await playerService.savePlayer(ids.userId, createdPlayer);
        if (savedPlayer) {
          createdPlayer = savedPlayer;
        }
        if (createdPlayer.agentId && !account.agentId) {
          account.agentId = String(createdPlayer.agentId);
        }
      }
      roleMeta = {
        roleId: ids.roleId,
        userId: ids.userId,
        serverId,
        serverName,
        name: createdPlayer.name || roleName,
        createTime: Date.now(),
        lastLoginTime: 0,
        status: 1,
      };
      break;
    } catch (err) {
      if (err && err.code === 11000) continue;
      throw err;
    }
  }

  if (!roleMeta || !createdPlayer) {
    throw new Error('CREATE_ROLE_FAILED');
  }

  account.roles = Array.isArray(account.roles) ? account.roles : [];
  account.roles.push(roleMeta);
  account.activeRoleByServer = account.activeRoleByServer || {};
  account.activeRoleByServer[String(serverId)] = roleMeta.roleId;
  account.lastSelectedServerId = serverId;
  account.markModified('roles');
  account.markModified('activeRoleByServer');
  await account.save();

  return {
    role: roleMeta,
    roles: sortRoles(account.roles),
  };
}

function pickRole(accountInput, options = {}) {
  if (!accountInput) return null;
  const account = accountInput.toObject ? accountInput.toObject() : accountInput;
  const allRoles = sortRoles(Array.isArray(account.roles) ? account.roles : []);
  if (allRoles.length <= 0) return null;

  const requestedServerId = toSafeInt(options.serverId, getDefaultServerId());
  const sameServerRoles = allRoles.filter((r) => toSafeInt(r.serverId, requestedServerId) === requestedServerId);
  const sameServerOnly = options.sameServerOnly === true;
  if (sameServerOnly && sameServerRoles.length <= 0) {
    return null;
  }
  const rolePool = sameServerOnly
    ? sameServerRoles
    : (sameServerRoles.length > 0 ? sameServerRoles : allRoles);

  const roleId = String(options.roleId || '').trim();
  if (roleId) {
    const byId = rolePool.find((r) => String(r.roleId) === roleId) || allRoles.find((r) => String(r.roleId) === roleId);
    if (byId) return byId;
  }

  const roleIndex = toSafeInt(options.roleIndex, -1);
  if (roleIndex >= 0 && roleIndex < rolePool.length) {
    return rolePool[roleIndex];
  }

  const activeMap = (account.activeRoleByServer && typeof account.activeRoleByServer === 'object')
    ? account.activeRoleByServer
    : {};
  const activeRoleId = String(activeMap[String(requestedServerId)] || '').trim();
  if (activeRoleId) {
    const activeRole = rolePool.find((r) => String(r.roleId) === activeRoleId);
    if (activeRole) return activeRole;
  }

  return rolePool[0] || allRoles[0];
}

async function setActiveRole(accountIdInput, options = {}) {
  let account = await authAccount(accountIdInput, options.password);
  if (!account) account = await findAccount(accountIdInput);
  if (!account) throw new Error('AUTH_FAILED');

  const serverId = toSafeInt(options.serverId, getDefaultServerId());
  const serverName = await resolveServerName(serverId);
  const switchedServer = toSafeInt(account.lastSelectedServerId, 0) > 0 && toSafeInt(account.lastSelectedServerId, 0) !== serverId;
  const role = pickRole(account, options);
  if (!role) throw new Error('ROLE_NOT_FOUND');

  if (switchedServer && role.userId) {
    const resetPlayer = await playerService.resetPlayerForServerSwitch(role.userId, { resetRoleSelection: true });
    if (resetPlayer && typeof resetPlayer === 'object') {
      resetPlayer.serverId = serverId;
      resetPlayer.serverName = serverName;
      await playerService.savePlayer(role.userId, resetPlayer);
    }
  }

  patchAccountRole(account, role.roleId, { serverName });

  account.activeRoleByServer = account.activeRoleByServer || {};
  account.activeRoleByServer[String(serverId)] = role.roleId;
  account.lastSelectedServerId = serverId;
  account.markModified('activeRoleByServer');
  await account.save();

  return {
    activeRoleId: role.roleId,
    roles: sortRoles(account.roles),
  };
}

async function deleteRole(accountIdInput, options = {}) {
  let account = await authAccount(accountIdInput, options.password);
  if (!account) account = await findAccount(accountIdInput);
  if (!account) throw new Error('AUTH_FAILED');

  const currentRoles = sortRoles(Array.isArray(account.roles) ? account.roles : []);
  if (currentRoles.length <= 1) {
    throw new Error('ROLE_MIN_KEEP');
  }

  const target = pickRole({ ...account.toObject(), roles: currentRoles }, options);
  if (!target) throw new Error('ROLE_NOT_FOUND');

  account.roles = currentRoles.filter((r) => String(r.roleId) !== String(target.roleId));
  account.markModified('roles');

  const serverId = toSafeInt(options.serverId, getDefaultServerId());
  const nextSameServer = account.roles.find((r) => toSafeInt(r.serverId, -1) === serverId);
  account.activeRoleByServer = account.activeRoleByServer || {};
  if (nextSameServer) account.activeRoleByServer[String(serverId)] = nextSameServer.roleId;
  else delete account.activeRoleByServer[String(serverId)];
  account.markModified('activeRoleByServer');
  await account.save();

  const purge = String(process.env.ROLE_DELETE_PURGE || '0') === '1';
  if (purge) {
    await Player.deleteOne({ userId: target.userId });
  }

  return {
    deletedRoleId: target.roleId,
    roles: sortRoles(account.roles),
  };
}

async function upsertLegacyRole(accountIdInput, options = {}) {
  const accountId = normalizeAccountId(accountIdInput);
  if (!accountId) throw new Error('INVALID_ACCOUNT');
  const userId = String(options.userId || '').trim();
  if (!userId) throw new Error('INVALID_USER_ID');
  const serverId = toSafeInt(options.serverId, getDefaultServerId());

  let account = await Account.findOne({ accountId });
  if (!account) {
    const password = normalizePassword(options.password || buildRandomText(10));
    account = await Account.create({
      accountId,
      passwordHash: await hashPassword(password),
      roles: [],
      activeRoleByServer: {},
      status: 1,
    });
  }

  account.roles = Array.isArray(account.roles) ? account.roles : [];
  const existed = account.roles.find((r) => String(r.userId) === userId);
  if (existed) return account.toObject();

  const roleId = options.roleId || `legacy_${buildRandomText(8)}`;
  account.roles.push({
    roleId: String(roleId),
    userId,
    serverId,
    name: normalizeRoleName(options.name || `legacy_${userId.slice(-6)}`),
    createTime: Date.now(),
    lastLoginTime: 0,
    status: 1,
  });
  account.activeRoleByServer = account.activeRoleByServer || {};
  if (!account.activeRoleByServer[String(serverId)]) {
    account.activeRoleByServer[String(serverId)] = String(roleId);
  }
  account.markModified('roles');
  account.markModified('activeRoleByServer');
  await account.save();
  return account.toObject();
}

async function bindLegacyPlayerRole(accountIdInput, options = {}) {
  const userId = String(options.userId || '').trim();
  if (!userId) return null;
  const legacyPlayer = await Player.findOne({ userId }).lean();
  if (!legacyPlayer) return null;

  const account = await upsertLegacyRole(accountIdInput, {
    serverId: options.serverId,
    userId: legacyPlayer.userId,
    roleId: options.roleId || `legacy_${legacyPlayer.userId}`,
    name: options.name || legacyPlayer.name,
    password: options.password,
  });
  const roles = sortRoles(account.roles || []);
  return roles.find((r) => String(r.userId) === legacyPlayer.userId) || null;
}

async function markRoleLogin(accountIdInput, roleIdInput, serverIdInput) {
  const accountId = normalizeAccountId(accountIdInput);
  if (!accountId) return null;
  const roleId = String(roleIdInput || '').trim();
  const serverId = toSafeInt(serverIdInput, getDefaultServerId());
  const now = Date.now();

  const setFields = {
    lastLoginTime: now,
    lastSelectedServerId: serverId,
  };
  if (roleId) {
    setFields[`activeRoleByServer.${serverId}`] = roleId;
    setFields['roles.$[target].lastLoginTime'] = now;
  }

  const updateOptions = roleId
    ? { arrayFilters: [{ 'target.roleId': roleId }] }
    : undefined;
  const result = await Account.updateOne(
    { accountId },
    { $set: setFields },
    updateOptions
  );
  if (!result || result.matchedCount <= 0) return null;
  return findAccount(accountId);
}

module.exports = {
  normalizeAccountId,
  hashPassword,
  createAccount,
  createRegisteredAccount,
  createRandomAccount,
  findAccount,
  authAccount,
  ensureAccountForLogin,
  validateAccountId,
  validateRegisterInput,
  validateUserPassword,
  validateInviteCode,
  normalizeInviteCode,
  createRole,
  setActiveRole,
  deleteRole,
  pickRole,
  upsertLegacyRole,
  bindLegacyPlayerRole,
  markRoleLogin,
};
