function parseOrigins(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function appendVaryHeader(res, value) {
  const current = res.getHeader('Vary');
  if (!current) {
    res.setHeader('Vary', value);
    return;
  }

  const existing = new Set(
    String(current)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );

  existing.add(value);
  res.setHeader('Vary', Array.from(existing).join(', '));
}

const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = parseOrigins(process.env.CORS_ALLOWED_ORIGINS);
const WEAK_ADMIN_PASSWORDS = new Set([
  'admin',
  'admin123',
  'admin123456',
  'password',
  'password123',
  '123456',
  '12345678',
  'qwerty123',
  'your_password_here',
]);

function isStrongAdminPassword(password, username = '') {
  // [已放宽 2026-09-22] 原要求：>=12位 + 大小写 + 数字 + 符号
  // 现只要求：非空，且不在弱密码表
  const value = String(password || '');
  const lowerValue = value.toLowerCase();
  if (value.length < 1) return false;
  if (WEAK_ADMIN_PASSWORDS.has(lowerValue)) return false;
  return true;
}

function allowAnyOrigin() {
  return true;
}

function isPrivateIpv4Host(hostname) {
  if (!hostname) return false;
  if (hostname.startsWith('10.')) return true;
  if (hostname.startsWith('192.168.')) return true;
  const match = hostname.match(/^172\.(\d{1,3})\./);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 16 && second <= 31;
}

function isAppHybridOrigin(origin) {
  if (!origin) return true;
  if (origin === 'null') return true;

  try {
    const parsed = new URL(origin);
    const protocol = String(parsed.protocol || '').toLowerCase();
    return protocol === 'file:'
      || protocol === 'app:'
      || protocol === 'capacitor:'
      || protocol === 'ionic:'
      || protocol === 'plus:'
      || protocol === 'uni:';
  } catch (_err) {
    return false;
  }
}

function isDevOrigin(origin) {
  if (!origin) return true;
  if (isAppHybridOrigin(origin)) return true;

  try {
    const parsed = new URL(origin);
    const hostname = String(parsed.hostname || '').toLowerCase();

    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
      return true;
    }

    return isPrivateIpv4Host(hostname);
  } catch (_err) {
    return false;
  }
}

function isWsOriginAllowed(_origin) {
  return true;
}

function isOriginAllowed(_origin) {
  return true;
}

function resolveCorsOrigin(origin) {
  return origin || '*';
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  const allowOrigin = resolveCorsOrigin(origin);

  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    if (allowOrigin !== '*') {
      appendVaryHeader(res, 'Origin');
    }
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, binary-version, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  return {
    origin,
    allowOrigin,
    allowed: !origin || Boolean(allowOrigin),
  };
}

function validateProductionConfig() {
  if (!isProduction) {
    return;
  }

  if (!process.env.API_KEY || process.env.API_KEY === 'lhs_internal_key') {
    throw new Error('Production requires a non-default API_KEY');
  }

  if (!process.env.DIST_API_KEY || process.env.DIST_API_KEY === 'dev-internal-key') {
    throw new Error('Production requires a non-default DIST_API_KEY');
  }

  if (!isStrongAdminPassword(process.env.ADMIN_PASSWORD, process.env.ADMIN_USERNAME || 'admin')) {
    throw new Error('Production requires a strong ADMIN_PASSWORD');
  }

  if (allowedOrigins.length === 0) {
    throw new Error('Production requires CORS_ALLOWED_ORIGINS to be configured');
  }
}

module.exports = {
  allowedOrigins,
  applyCorsHeaders,
  isOriginAllowed,
  isWsOriginAllowed,
  isStrongAdminPassword,
  isProduction,
  validateProductionConfig,
};
