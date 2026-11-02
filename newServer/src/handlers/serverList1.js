const logger = require('../logger');
const accountService = require('../services/AccountService');
const authSessionService = require('../services/AuthSessionService');
const configService = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const serverConfigService = require('../services/ServerConfigService');

const DEFAULT_REGISTER_PATH = '/register.html';
const DAZHUZAI_LINKAGE = Object.freeze({
  index: 7,
  start: 1784044800000,
  end: 1788278400000,
});

async function listAllServers() {
  return serverConfigService.listAllServers();
}

async function buildServerData(serverIdInput, req, now = Date.now(), roleSummary = null) {
  const serverId = Number(serverIdInput) || Number(process.env.DEFAULT_SERVER_ID) || 1001;
  const serverCfg = (await serverConfigService.findServerConfig(serverId)) || {};
  const endpoint = buildWsEndpoint(req);
  const isNew = !!serverCfg.isNew;

  const data = {
    serverId,
    pageId: Number(serverCfg.pageId) || Math.floor(serverId / 1000) || 1,
    pageName: String(serverCfg.pageName || ''),
    serverName: String(serverCfg.serverName || `大区${serverId}`),
    url: endpoint.url,
    host: endpoint.host,
    port: endpoint.port,
    status: normalizeServerStatus(serverCfg.status, 1),
    state: isNew ? 1 : 2,
    running: serverCfg.running !== false ? 1 : 0,
    openTime: Number(serverCfg.openTime) || (now - 86400000 * (isNew ? 3 : 30)),
    rechargeArea: Number(serverCfg.rechargeArea) || 1,
    isNew: isNew ? 1 : 0,
    isRecommend: serverCfg.isRecommend ? 1 : 0,
  };

  if (roleSummary) {
    data.roleId = roleSummary.roleId;
    data.userId = roleSummary.userId;
    data.playerId = roleSummary.playerId;
    data.roleName = roleSummary.name;
    data.name = roleSummary.name;
    data.level = roleSummary.level;
    data.exp = roleSummary.exp;
    data.lastLoginTime = roleSummary.lastLoginTime;
    data.createTime = roleSummary.createTime;
    data.role = roleSummary;
  }

  return data;
}

function buildRoleCreateOptions() {
  const roleGenderCfg = configService.get('RoleGenderConfig') || {};
  const options = [];
  const seen = new Set();

  Object.keys(roleGenderCfg).forEach((kungfuKey) => {
    const group = roleGenderCfg[kungfuKey];
    if (!group || typeof group !== 'object' || Array.isArray(group)) return;

    Object.keys(group).forEach((subJobKey) => {
      const row = group[subJobKey];
      if (!row || Number(row.ifShow) !== 1) return;

      const kungfuId = Number(row.id) || Number(kungfuKey) || 4;
      const subJob = Number(row.gender);
      const safeSubJob = Number.isFinite(subJob) ? subJob : (Number(subJobKey) || 0);
      const optionKey = `${kungfuId}_${safeSubJob}`;
      if (seen.has(optionKey)) return;
      seen.add(optionKey);

      options.push({
        key: optionKey,
        kungfuId,
        subJob: safeSubJob,
        label: `角色${kungfuId}${safeSubJob === 1 ? '·女' : '·男'}`,
      });
    });
  });

  options.sort((a, b) => {
    if (a.kungfuId === b.kungfuId) return a.subJob - b.subJob;
    return a.kungfuId - b.kungfuId;
  });

  if (options.length > 0) return options;
  return [
    {
      key: '4_0',
      kungfuId: 4,
      subJob: 0,
      label: '默认角色',
    },
  ];
}

function firstHeaderValue(v) {
  if (!v) return '';
  if (Array.isArray(v)) return String(v[0] || '').trim();
  return String(v).split(',')[0].trim();
}

function normalizeHost(rawHost) {
  let host = String(rawHost || '').trim();
  if (!host) return '';
  host = host.replace(/^https?:\/\//i, '');
  host = host.split('/')[0];
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end !== -1) {
      host = host.slice(1, end);
    }
  } else if (host.includes(':')) {
    host = host.split(':')[0];
  }
  if (host === 'localhost' || host === '::1') {
    return '127.0.0.1';
  }
  return host;
}

function resolvePublicHost(req) {
  const byEnv = normalizeHost(process.env.SERVER_PUBLIC_HOST);
  if (byEnv) return byEnv;

  const forwardedHost = normalizeHost(firstHeaderValue(req && req.headers && req.headers['x-forwarded-host']));
  if (forwardedHost) return forwardedHost;

  const reqHost = normalizeHost((req && req.hostname) || (req && req.headers && req.headers.host));
  if (reqHost) return reqHost;

  const byServerHost = normalizeHost(process.env.SERVER_HOST);
  if (byServerHost) return byServerHost;

  return '127.0.0.1';
}

function resolvePublicWsPort() {
  const wsPublicPort = Number.parseInt(process.env.WS_PUBLIC_PORT || '', 10);
  if (Number.isFinite(wsPublicPort) && wsPublicPort > 0) return wsPublicPort;

  const wsPort = Number.parseInt(process.env.WS_PORT || '', 10);
  if (Number.isFinite(wsPort) && wsPort > 0) return wsPort;

  return 9200;
}

function buildWsEndpoint(req) {
  const host = resolvePublicHost(req);
  const port = resolvePublicWsPort();
  return {
    host,
    port,
    url: `${host}:${port}`,
  };
}

function readTextParam(params = {}, keys = []) {
  for (const key of keys) {
    if (!(key in params)) continue;
    const value = String(params[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function parseServerId(params = {}) {
  return Number(params.serverId) || Number(params.serverid) || Number(process.env.DEFAULT_SERVER_ID) || 1001;
}

function normalizeServerStatus(value, fallback = 1) {
  const status = Number(value);
  if (Number.isFinite(status) && status >= 0) return Math.floor(status);
  const safeFallback = Number(fallback);
  return Number.isFinite(safeFallback) && safeFallback >= 0 ? Math.floor(safeFallback) : 1;
}

function isUserClientValidationEnabled() {
  return String(process.env.USER_CLIENT_VALIDATION_ENABLED || '0') === '1';
}

function isInviteRegistrationRequired() {
  return String(process.env.REQUIRE_INVITE_REGISTER || '1') === '1';
}

function getRegisterUrl(req) {
  const configured = String(process.env.REGISTER_URL || '').trim();
  if (configured) return configured;

  const host = resolvePublicHost(req);
  const safeHost = host.includes(':') ? `[${host}]` : host;
  const port = Number.parseInt(process.env.REGISTER_PUBLIC_PORT || '', 10) || 18081;
  return `http://${safeHost}:${port}${DEFAULT_REGISTER_PATH}`;
}

function buildRoleSummary(role = {}) {
  const player = role && role.__player && typeof role.__player === 'object'
    ? role.__player
    : {};
  return {
    roleId: String(role.roleId || ''),
    userId: String(role.userId || ''),
    playerId: String(player.playerId || role.playerId || ''),
    serverId: Number(role.serverId) || 0,
    serverName: String(player.serverName || role.serverName || ''),
    name: String(player.name || role.name || ''),
    level: Math.max(0, Number(player.level) || Number(role.level) || 0),
    exp: Math.max(0, Number(player.exp) || Number(role.exp) || 0),
    createTime: Number(role.createTime) || Number(player.createTime) || 0,
    lastLoginTime: Number(role.lastLoginTime) || 0,
    roleInfo: player.roleInfo && typeof player.roleInfo === 'object' ? player.roleInfo : {},
  };
}

function buildRolesPayload(roles = [], serverId) {
  const sid = Number(serverId) || 0;
  const list = Array.isArray(roles) ? roles : [];
  const filtered = sid > 0
    ? list.filter((r) => Number(r && r.serverId) === sid)
    : list;
  return filtered.map((role, idx) => {
    const summary = buildRoleSummary(role);
    return {
      ...summary,
      serverId: summary.serverId || sid || 0,
      roleIndex: idx,
    };
  });
}

function attachPlayerToRole(role = {}, player = {}) {
  const enriched = { ...(role && typeof role === 'object' ? role : {}) };
  Object.defineProperty(enriched, '__player', {
    value: player,
    enumerable: false,
    configurable: true,
  });
  return enriched;
}

async function resolvePlayableRoles(accountInput, serverId) {
  const account = accountInput && accountInput.toObject
    ? accountInput.toObject()
    : (accountInput || {});
  const sid = Number(serverId) || 0;
  const roles = Array.isArray(account.roles) ? account.roles : [];
  const sameServerRoles = sid > 0
    ? roles.filter((role) => Number(role && role.serverId) === sid)
    : roles.slice();

  if (sameServerRoles.length <= 0) {
    return {
      playableRoles: [],
      staleRoles: [],
    };
  }

  const probes = await Promise.all(sameServerRoles.map(async (role) => {
    const userId = String(role && role.userId || '').trim();
    const player = userId ? await playerService.loadPlayer(userId) : null;
    return {
      role: player ? attachPlayerToRole(role, player) : role,
      playable: !!player,
    };
  }));

  const playableRoles = [];
  const staleRoles = [];
  probes.forEach((entry) => {
    if (entry.playable) playableRoles.push(entry.role);
    else staleRoles.push(entry.role);
  });

  return {
    playableRoles,
    staleRoles,
  };
}

async function reloadAccountRoleState(accountId) {
  const refreshedAccount = accountId ? await accountService.findAccount(accountId) : null;
  const roleState = await resolvePlayableRoles(refreshedAccount, 0);
  return {
    account: refreshedAccount,
    ...roleState,
  };
}

async function buildRecentLoginServers(roles = [], req, now = Date.now()) {
  const byServer = new Map();
  (Array.isArray(roles) ? roles : []).forEach((role) => {
    const summary = buildRoleSummary(role);
    const serverId = Number(summary.serverId) || 0;
    if (serverId <= 0) return;
    const prev = byServer.get(serverId);
    const prevTime = prev ? Math.max(Number(prev.lastLoginTime) || 0, Number(prev.createTime) || 0) : -1;
    const nextTime = Math.max(Number(summary.lastLoginTime) || 0, Number(summary.createTime) || 0);
    if (!prev || nextTime >= prevTime) byServer.set(serverId, summary);
  });

  const summaries = Array.from(byServer.values()).sort((a, b) => {
    const bTime = Math.max(Number(b.lastLoginTime) || 0, Number(b.createTime) || 0);
    const aTime = Math.max(Number(a.lastLoginTime) || 0, Number(a.createTime) || 0);
    return bTime - aTime;
  });

  return Promise.all(summaries.map((summary) => buildServerData(summary.serverId, req, now, summary)));
}

function uniqueTextList(values = []) {
  const set = new Set();
  const result = [];
  for (const raw of values) {
    const text = String(raw || '').trim();
    if (!text || text === '0' || set.has(text)) continue;
    set.add(text);
    result.push(text);
  }
  return result;
}

function buildLegacyBindCandidates(params = {}, accountId = '', accountInput = {}) {
  const normalizedAccountId = String(accountId || '').trim();
  const account = accountInput && accountInput.toObject
    ? accountInput.toObject()
    : (accountInput || {});
  const hasExistingRoles = Array.isArray(account.roles) && account.roles.length > 0;
  const explicitCandidates = uniqueTextList([
    params.legacyUserId,
    params.bindUserId,
  ]);
  if (hasExistingRoles) return explicitCandidates;

  // Passive platformuid binding can accidentally attach an old archive to a new
  // server selection. Keep it opt-in; explicit legacy/bind ids still work.
  if (String(process.env.ALLOW_PASSIVE_LEGACY_ROLE_BIND || '0') !== '1') {
    return explicitCandidates;
  }

  const passiveCandidates = uniqueTextList([
    params.platformuid,
    params.userId,
  ]).filter((candidate) => candidate !== normalizedAccountId);

  return uniqueTextList([
    ...explicitCandidates,
    ...passiveCandidates,
  ]);
}

async function handleGetServerPages() {
  return {
    ret: 0,
    serverTime: Date.now(),
    pages: await serverConfigService.listServerPages(),
  };
}

async function handleGetServerDetail(params = {}, req) {
  const now = Date.now();
  const pageId = Number(params.pageId) || 1;
  if (pageId === -1) {
    const accountId = readTextParam(params, ['uid', 'strAccount', 'account', 'openId', 'userName', 'username']);
    const password = readTextParam(params, ['token', 'strPassword', 'password', 'pwd', 'pass']);
    let account = accountId && password ? await accountService.authAccount(accountId, password) : null;
    if (!account && accountId && String(process.env.SDK_AUTH_PASSWORD_STRICT || '0') !== '1') {
      account = await accountService.findAccount(accountId);
    }
    if (!account) {
      return {
        ret: 0,
        serverTime: now,
        servers: [],
      };
    }

    const { playableRoles } = await resolvePlayableRoles(account, 0);
    return {
      ret: 0,
      serverTime: now,
      servers: await buildRecentLoginServers(playableRoles, req, now),
    };
  }

  const serverConfigs = await serverConfigService.listServersByPage(pageId);
  const endpoint = buildWsEndpoint(req);

  const servers = serverConfigs.map((s) => ({
    serverId: s.serverId,
    pageId: s.pageId,
    pageName: s.pageName,
    serverName: s.serverName,
    url: endpoint.url,
    host: endpoint.host,
    port: endpoint.port,
    status: normalizeServerStatus(s.status, 1),
    state: s.isNew ? 1 : 2,
    running: s.running !== false ? 1 : 0,
    openTime: Number(s.openTime) || (now - 86400000 * 30),
    rechargeArea: Number(s.rechargeArea) || 1,
    isNew: s.isNew ? 1 : 0,
    isRecommend: s.isRecommend ? 1 : 0,
  }));

  return {
    ret: 0,
    serverTime: now,
    servers,
  };
}

async function handleSDKAuth(params = {}, req) {
  try {
    const now = Date.now();
    const userClientValidationEnabled = isUserClientValidationEnabled();
    const allowAutoRegister = String(
      process.env.ALLOW_AUTO_REGISTER || (userClientValidationEnabled ? '0' : '1')
    ) === '1';
    const strictSdkPassword = String(
      process.env.SDK_AUTH_PASSWORD_STRICT || (userClientValidationEnabled ? '1' : '0')
    ) === '1';
    const serverId = parseServerId(params);

    const requestedAccountId = readTextParam(params, ['uid', 'strAccount', 'account', 'openId', 'userName']);
    const requestedPassword = readTextParam(params, ['token', 'strPassword', 'password', 'pwd', 'pass']);
    const requestedInviteCode = readTextParam(params, ['inviteCode', 'invite_code', 'invite', 'code']);
    let accountId = requestedAccountId;
    let password = requestedPassword;
    let issuedCredentials = null;

    if ((!accountId || !password) && allowAutoRegister) {
      if (isInviteRegistrationRequired()) {
        return {
          ret: -1,
          serverTime: now,
          code: 'INVITE_REGISTER_REQUIRED',
          registerUrl: getRegisterUrl(req),
          errInfo: 'please register from agent invite link',
        };
      }
      const random = await accountService.createRandomAccount();
      accountId = random.accountId;
      password = random.password;
      issuedCredentials = { accountId, password };
    }

    if (!accountId || !password) {
      return {
        ret: -1,
        serverTime: now,
        errInfo: 'account or password is empty',
      };
    }

    const loginState = await accountService.ensureAccountForLogin(accountId, password, {
      allowAutoRegister,
      inviteCode: requestedInviteCode,
    });
    let account = loginState.account;
    if (!account && allowAutoRegister && !strictSdkPassword) {
      // SDK token may rotate frequently; keep local account playable by uid.
      account = await accountService.findAccount(accountId);
    }
    if (!account) {
      return {
        ret: -1,
        serverTime: now,
        errInfo: 'auth failed',
      };
    }

    const legacyCandidates = buildLegacyBindCandidates(params, accountId, account);
    for (const userIdCandidate of legacyCandidates) {
      await accountService.bindLegacyPlayerRole(accountId, {
        password,
        serverId,
        userId: userIdCandidate,
        name: params.firstName,
      });
    }

    account = await accountService.findAccount(accountId);
    let allRoleState = await resolvePlayableRoles(account, 0);
    let playableRoles = allRoleState.playableRoles.filter((role) => Number(role && role.serverId) === serverId);
    const staleRoles = allRoleState.staleRoles.filter((role) => Number(role && role.serverId) === serverId);
    if (staleRoles.length > 0) {
      const staleSummary = staleRoles
        .map((role) => `${String(role && role.roleId || '')}:${String(role && role.userId || '')}`)
        .join(',');
      logger.warn(`[ServerList] skip stale role metadata during sdk auth account=${accountId} serverId=${serverId} stale=${staleSummary}`);
    }

    let selectedRole = accountService.pickRole({
      ...(account && account.toObject ? account.toObject() : (account || {})),
      roles: playableRoles,
    }, {
      serverId,
      roleId: params.roleId,
      roleIndex: params.roleIndex,
      sameServerOnly: true,
    });
    if (!selectedRole) {
      const created = await accountService.createRole(accountId, {
        password,
        serverId,
        name: params.firstName,
        firstName: params.firstName,
        inviteCode: requestedInviteCode,
        reuseExisting: false,
        deferRoleSelection: true,
      }) || {};
      const createdRoleId = created.role && created.role.roleId;
      const refreshed = await reloadAccountRoleState(accountId);
      account = refreshed.account;
      allRoleState = {
        playableRoles: refreshed.playableRoles,
        staleRoles: refreshed.staleRoles,
      };
      playableRoles = allRoleState.playableRoles.filter((role) => Number(role && role.serverId) === serverId);
      selectedRole = playableRoles.find((role) => String(role && role.roleId) === String(createdRoleId))
        || accountService.pickRole({
          ...(account && account.toObject ? account.toObject() : (account || {})),
          roles: playableRoles,
        }, {
          serverId,
          sameServerOnly: true,
        });
    }

    let userId = '';
    let userToken = '';
    let activeRoleId = '';
    if (selectedRole) {
      const tokenPack = await authSessionService.create({
        accountId,
        roleId: selectedRole.roleId,
        userId: selectedRole.userId,
        serverId,
        serverName: selectedRole.serverName || '',
        serverSwitched: false,
        loginTime: now,
      }) || {};
      await accountService.markRoleLogin(accountId, selectedRole.roleId, serverId);
      const refreshed = await reloadAccountRoleState(accountId);
      account = refreshed.account;
      allRoleState = {
        playableRoles: refreshed.playableRoles,
        staleRoles: refreshed.staleRoles,
      };
      playableRoles = allRoleState.playableRoles.filter((role) => Number(role && role.serverId) === serverId);
      selectedRole = accountService.pickRole({
        ...(account && account.toObject ? account.toObject() : (account || {})),
        roles: playableRoles,
      }, {
        serverId,
        roleId: params.roleId,
        roleIndex: params.roleIndex,
        sameServerOnly: true,
      }) || selectedRole;

      userId = selectedRole.userId;
      userToken = tokenPack.token || '';
      activeRoleId = selectedRole.roleId;
    }

    const selectedServerData = await buildServerData(serverId, req, now, selectedRole ? buildRoleSummary(selectedRole) : null);
    const roles = buildRolesPayload(playableRoles, serverId);
    const allRoles = buildRolesPayload(allRoleState.playableRoles, 0);
    const recentLoginServers = await buildRecentLoginServers(allRoleState.playableRoles, req, now);
    const recentServerData = recentLoginServers[0] || selectedServerData;

    return {
      ret: 0,
      serverTime: now,
      userId,
      userToken,
      userID: userId,
      uid: accountId,
      strAccount: issuedCredentials ? issuedCredentials.accountId : '',
      strPassword: issuedCredentials ? issuedCredentials.password : '',
      unionId: '',
      age: 25,
      onlineTime: 0,
      dayOnlineTime: 0,
      totalInfullNum: 0,
      monthInfullNum: 0,
      cancellation: 0,
      regDate: '2025-01-01',
      activeDate: new Date().toISOString().slice(0, 10),
      newReg: loginState.newlyCreated ? 1 : 0,
      newServerName: selectedServerData.serverName,
      isGM: 0,
      zfbShortcut: 0,
      channelId: 1,
      clueToken: '',
      bindPhone: 0,
      exGameAds: '',
      isStreamer: 0,
      defaultServerData: selectedServerData,
      newServerData: recentServerData,
      roles,
      allRoles,
      recentLoginServers,
      recentServers: recentLoginServers,
      activeRoleId,
      needCreateRole: selectedRole ? 0 : 1,
      roleCreateOptions: buildRoleCreateOptions(),
      canPlayToday: 1,
      canPlayBeginTime: 0,
      canPlayEndTime: 0,
      noInfull: 0,
      errInfo: '',
    };
  } catch (err) {
    logger.error(`[ServerList] handleSDKAuth failed: ${err && err.stack ? err.stack : (err && err.message ? err.message : err)}`);
    return {
      ret: -1,
      serverTime: Date.now(),
      errInfo: 'server busy',
    };
  }
}

function handleReqParams(params = {}) {
  const keyList = Array.isArray(params.keyList) ? params.keyList.map(String) : [];
  const param = {};

  if (keyList.length === 0 || keyList.includes('linkage')) {
    param.linkage = JSON.stringify(DAZHUZAI_LINKAGE);
  }

  return {
    ret: 0,
    serverTime: Date.now(),
    param,
    // Kept for older local clients that used the plural response field.
    params: param,
  };
}

async function handleRegisterAccount(params = {}, req) {
  const now = Date.now();
  const accountId = readTextParam(params, ['strAccount', 'account', 'uid', 'openId', 'userName', 'username']);
  const password = readTextParam(params, ['strPassword', 'password', 'pwd', 'token', 'pass']);
  const confirmPassword = readTextParam(params, ['confirmPassword', 'passwordConfirm', 'rePassword', 'repass']);
  const inviteCode = readTextParam(params, ['inviteCode', 'invite_code', 'invite', 'code']);

  if (isInviteRegistrationRequired() && !inviteCode) {
    return {
      ret: -1,
      result: -1,
      serverTime: now,
      code: 'INVITE_CODE_REQUIRED',
      registerUrl: getRegisterUrl(req),
      errInfo: '请通过代理邀请链接注册',
    };
  }

  try {
    const account = inviteCode
      ? await accountService.createRegisteredAccount(
        accountId,
        password,
        confirmPassword || password,
        { inviteCode }
      )
      : await accountService.createRegisteredAccount(
        accountId,
        password,
        confirmPassword || password
      );
    return {
      ret: 0,
      result: 0,
      serverTime: now,
      uid: account.accountId,
      strAccount: account.accountId,
      inviteCode: account.inviteCode || '',
      needCreateRole: 1,
      roleCreateOptions: buildRoleCreateOptions(),
      errInfo: '',
    };
  } catch (err) {
    const code = err && (err.code || err.message);
    const isExists = String(code) === 'ACCOUNT_EXISTS';
    return {
      ret: -1,
      result: -1,
      serverTime: now,
      code: isExists ? 'ACCOUNT_EXISTS' : String(code || 'REGISTER_FAILED'),
      errInfo: isExists ? '账号已存在' : (err.message || '注册失败'),
    };
  }
}

async function handleGetRandomAccount(_params = {}, req) {
  const now = Date.now();
  if (isInviteRegistrationRequired()) {
    return {
      ret: -1,
      serverTime: now,
      code: 'RANDOM_REGISTER_DISABLED',
      registerUrl: getRegisterUrl(req),
      errInfo: '随机注册已关闭，请通过代理邀请链接注册',
    };
  }
  const { accountId, password } = await accountService.createRandomAccount();
  return {
    ret: 0,
    serverTime: now,
    strAccount: accountId,
    strPassword: password,
    errInfo: '',
  };
}

async function handleCreateRoleByAccount(params = {}) {
  const now = Date.now();
  const accountId = readTextParam(params, ['strAccount', 'account', 'uid', 'openId', 'userName']);
  const password = readTextParam(params, ['strPassword', 'password', 'pwd', 'token', 'pass']);
  const serverId = parseServerId(params);
  const roleName = readTextParam(params, ['roleName', 'name', 'firstName']);
  const inviteCode = readTextParam(params, ['inviteCode', 'invite_code', 'invite', 'code']);
  const kungfuId = Number(params.kungfuId);
  const subJob = Number(params.subJob);

  if (!accountId || !password) {
    return {
      ret: -1,
      serverTime: now,
      errInfo: 'account or password is empty',
    };
  }

  try {
    const result = await accountService.createRole(accountId, {
      password,
      serverId,
      name: roleName,
      firstName: params.firstName,
      kungfuId,
      subJob,
      inviteCode,
      resetExisting: true,
    });
    return {
      ret: 0,
      serverTime: now,
      result: 0,
      roles: buildRolesPayload(result.roles, serverId),
      activeRoleId: result.role.roleId,
      errInfo: '',
    };
  } catch (err) {
    return {
      ret: -1,
      serverTime: now,
      result: -1,
      roles: [],
      errInfo: err.message || 'create role failed',
    };
  }
}

async function handleManageRoleByAccount(params = {}) {
  const now = Date.now();
  const accountId = readTextParam(params, ['strAccount', 'account', 'uid', 'openId', 'userName']);
  const password = readTextParam(params, ['strPassword', 'password', 'pwd', 'token', 'pass']);
  const serverId = parseServerId(params);
  const roleId = readTextParam(params, ['roleId', 'rid']);
  const roleIndex = Number(params.roleIndex);
  const action = String(params.action || params.op || params.type || '').trim().toLowerCase();
  const deleteRequested = action === 'delete'
    || action === 'remove'
    || action === 'del'
    || action === '1'
    || Number(params.delete) === 1
    || Number(params.del) === 1;

  if (!accountId || !password) {
    return {
      ret: -1,
      serverTime: now,
      result: -1,
      errInfo: 'account or password is empty',
    };
  }

  try {
    if (deleteRequested) {
      const result = await accountService.deleteRole(accountId, {
        password,
        serverId,
        roleId,
        roleIndex,
      });
      return {
        ret: 0,
        serverTime: now,
        result: 0,
        action: 'delete',
        deletedRoleId: result.deletedRoleId,
        roles: buildRolesPayload(result.roles, serverId),
        errInfo: '',
      };
    }

    const result = await accountService.setActiveRole(accountId, {
      password,
      serverId,
      roleId,
      roleIndex,
    });
    return {
      ret: 0,
      serverTime: now,
      result: 0,
      action: 'active',
      activeRoleId: result.activeRoleId,
      roles: buildRolesPayload(result.roles, serverId),
      errInfo: '',
    };
  } catch (err) {
    return {
      ret: -1,
      serverTime: now,
      result: -1,
      roles: [],
      errInfo: err.message || 'role operation failed',
    };
  }
}

function register(httpServer) {
  httpServer.registerHttpHandlers({
    3073: handleGetServerPages,
    3074: handleGetServerDetail,
    2820: handleSDKAuth,
    2565: handleReqParams,
    2566: () => ({ ret: 0, serverTime: Date.now() }),
    2817: handleGetRandomAccount,
    2818: handleCreateRoleByAccount,
    2819: handleManageRoleByAccount,
    2821: handleRegisterAccount,
    2827: () => ({ ret: 0, serverTime: Date.now() }),
    2945: () => ({ ret: 0, serverTime: Date.now() }),
  });
  logger.info('[ServerList] HTTP handlers registered (2820/3073/3074/2565/2566/2817/2818/2819/2827/2945)');
}

module.exports = {
  register,
  SERVER_PAGES: serverConfigService.DEFAULT_SERVER_PAGES,
  SERVERS_BY_PAGE: serverConfigService.DEFAULT_SERVERS_BY_PAGE,
  resolvePublicHost,
  resolvePublicWsPort,
  buildWsEndpoint,
  listAllServers,
  handleGetServerPages,
  handleGetServerDetail,
  handleSDKAuth,
  handleReqParams,
  handleGetRandomAccount,
  handleRegisterAccount,
  handleCreateRoleByAccount,
  handleManageRoleByAccount,
};
