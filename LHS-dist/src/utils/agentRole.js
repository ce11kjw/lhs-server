const MAX_AGENT_LEVEL = 4;

const AGENT_ROLES = Object.freeze([
  { key: 'chief_promoter', level: 0, label: 'chief promoter', name: 'Chief Promoter' },
  { key: 'general_agent', level: 1, label: 'general agent', name: 'General Agent' },
  { key: 'level1_agent', level: 2, label: 'level 1 agent', name: 'Level 1 Agent' },
  { key: 'level2_agent', level: 3, label: 'level 2 agent', name: 'Level 2 Agent' },
  { key: 'level3_agent', level: 4, label: 'level 3 agent', name: 'Level 3 Agent' },
]);

const AGENT_ROLE_KEYS = Object.freeze(AGENT_ROLES.map((role) => role.key));

const DEFAULT_COMMISSION_RATE = Object.freeze({
  direct: 0.30,
  level1: 0.10,
  level2: 0.05,
  level3: 0.03,
  level4: 0.02,
  level5: 0,
});

const COMMISSION_RATE_KEYS = Object.freeze([
  'direct',
  'level1',
  'level2',
  'level3',
  'level4',
  'level5',
]);

function getAgentRoleByKey(key) {
  return AGENT_ROLES.find((role) => role.key === key) || null;
}

function getAgentRoleByLevel(level) {
  const numericLevel = Number(level);
  const boundedLevel = Number.isInteger(numericLevel)
    ? Math.max(0, Math.min(MAX_AGENT_LEVEL, numericLevel))
    : 0;
  return AGENT_ROLES[boundedLevel] || AGENT_ROLES[0];
}

function getNextAgentRole(parentRoleOrLevel) {
  const parentRole = typeof parentRoleOrLevel === 'string'
    ? getAgentRoleByKey(parentRoleOrLevel)
    : getAgentRoleByLevel(parentRoleOrLevel);
  if (!parentRole || parentRole.level >= MAX_AGENT_LEVEL) return null;
  return getAgentRoleByLevel(parentRole.level + 1);
}

function normalizeRate(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function normalizeCommissionRate(value = {}, fallback = DEFAULT_COMMISSION_RATE) {
  const source = value || {};
  const defaults = fallback || DEFAULT_COMMISSION_RATE;
  return COMMISSION_RATE_KEYS.reduce((result, key) => {
    result[key] = normalizeRate(source[key], normalizeRate(defaults[key], DEFAULT_COMMISSION_RATE[key] || 0));
    return result;
  }, {});
}

function getCommissionRateByDistance(agent, distance) {
  const key = COMMISSION_RATE_KEYS[Number(distance)];
  const rates = agent && agent.commissionRate;
  return key ? normalizeRate(rates && rates[key], DEFAULT_COMMISSION_RATE[key]) : 0;
}

function normalizePermissions(value = {}, roleKey) {
  const source = value || {};
  const role = getAgentRoleByKey(roleKey) || getAgentRoleByLevel(0);
  const defaults = {
    inviteAgent: true,
    viewTeam: true,
    viewCommission: true,
    withdraw: true,
    setSubCommission: role.level <= 1,
  };

  return Object.keys(defaults).reduce((result, key) => {
    result[key] = source[key] === undefined ? defaults[key] : Boolean(source[key]);
    return result;
  }, {});
}

module.exports = {
  AGENT_ROLES,
  AGENT_ROLE_KEYS,
  MAX_AGENT_LEVEL,
  DEFAULT_COMMISSION_RATE,
  COMMISSION_RATE_KEYS,
  getAgentRoleByKey,
  getAgentRoleByLevel,
  getNextAgentRole,
  getCommissionRateByDistance,
  normalizeCommissionRate,
  normalizePermissions,
};
