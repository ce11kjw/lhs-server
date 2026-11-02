const PERMISSION_TREE = Object.freeze([
  {
    key: 'admin',
    label: 'Administration',
    children: [
      { key: 'admin.roles', label: 'Roles' },
      { key: 'admin.agents', label: 'Agents' },
      { key: 'admin.commissions', label: 'Commissions' },
      { key: 'admin.withdrawals', label: 'Withdrawals' },
      { key: 'admin.logs', label: 'Operation logs' },
    ],
  },
  {
    key: 'agent',
    label: 'Agent portal',
    children: [
      { key: 'agent.team', label: 'Team' },
      { key: 'agent.commission', label: 'Commission' },
      { key: 'agent.withdrawal', label: 'Withdrawal' },
    ],
  },
]);

function flattenTree(nodes) {
  return nodes.reduce((keys, node) => {
    keys.push(node.key);
    if (node.children) keys.push(...flattenTree(node.children));
    return keys;
  }, []);
}

const ALL_PERMISSION_KEYS = Object.freeze(['root', ...flattenTree(PERMISSION_TREE)]);

const BUILTIN_ROLES = Object.freeze({
  root: {
    key: 'root',
    label: 'Root',
    permissions: ['root'],
  },
  admin: {
    key: 'admin',
    label: 'Admin',
    permissions: ['admin', 'admin.roles', 'admin.agents', 'admin.commissions', 'admin.withdrawals', 'admin.logs'],
  },
  agent: {
    key: 'agent',
    label: 'Agent',
    permissions: ['agent', 'agent.team', 'agent.commission', 'agent.withdrawal'],
  },
});

function uniquePermissions(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean))];
}

function hasPermission(agent, permission) {
  if (!agent || !permission) return false;
  const requested = String(permission);
  if (agent.role === 'root') return true;

  const explicit = uniquePermissions(agent.accessPermissions);
  if (explicit.includes('root')) return true;
  if (explicit.includes(requested)) return true;
  if (explicit.some((item) => requested.startsWith(`${item}.`))) return true;

  if (agent.role === 'admin' && (requested === 'admin' || requested.startsWith('admin.'))) {
    return true;
  }
  if (agent.role === 'agent' && (requested === 'agent' || requested.startsWith('agent.'))) {
    return true;
  }
  return false;
}

module.exports = {
  ALL_PERMISSION_KEYS,
  BUILTIN_ROLES,
  PERMISSION_TREE,
  hasPermission,
  uniquePermissions,
};
