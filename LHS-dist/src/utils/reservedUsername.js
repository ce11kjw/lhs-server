const RESERVED_USERNAME_PARTS = ['root', 'admin'];

function normalizeUsername(value) {
  return String(value || '').trim();
}

function findReservedUsernamePart(username) {
  const normalized = normalizeUsername(username).toLowerCase();
  return RESERVED_USERNAME_PARTS.find((part) => normalized.includes(part)) || null;
}

function isReservedUsername(username) {
  return Boolean(findReservedUsernamePart(username));
}

function createReservedUsernameError() {
  const error = new Error('用户名不能使用或包含 root/admin');
  error.status = 400;
  return error;
}

function assertAllowedUsername(username) {
  if (isReservedUsername(username)) {
    throw createReservedUsernameError();
  }
}

function validateAllowedUsername(value, helpers) {
  if (isReservedUsername(value)) {
    return helpers.message('用户名不能使用或包含 root/admin');
  }
  return value;
}

module.exports = {
  RESERVED_USERNAME_PARTS,
  normalizeUsername,
  findReservedUsernamePart,
  isReservedUsername,
  assertAllowedUsername,
  validateAllowedUsername,
};
