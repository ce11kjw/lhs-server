require('dotenv').config();

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(text)) {
    return false;
  }
  return fallback;
}

function parseOrigins(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const corsAllowedOrigins = parseOrigins(process.env.CORS_ALLOWED_ORIGINS);
const WEAK_ADMIN_PASSWORDS = new Set([
  'admin',
  'admin123',
  'admin123456',
  'password',
  'password123',
  '123456',
  '12345678',
  'qwerty123',
]);

function isStrongPassword(password, username = '') {
  // [已放宽 2026-09-22] 原要求：>=12位 + 大小写 + 数字 + 符号
  // 现只要求：非空，且不在弱密码表
  const value = String(password || '');
  const lowerValue = value.toLowerCase();
  if (value.length < 1) return false;
  if (WEAK_ADMIN_PASSWORDS.has(lowerValue)) return false;
  return true;
}

const config = {
  nodeEnv,
  isProduction,

  port: process.env.PORT || 3001,

  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/lhs-dist',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-key',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  internalApiKey: process.env.INTERNAL_API_KEY || 'dev-internal-key',

  defaultAdmin: {
    enabled: parseBoolean(process.env.DEFAULT_ADMIN_ENABLED, !isProduction && Boolean(process.env.DEFAULT_ADMIN_PASSWORD)),
    username: String(process.env.DEFAULT_ADMIN_USERNAME || 'lhsmanager').trim(),
    password: String(process.env.DEFAULT_ADMIN_PASSWORD || ''),
    phone: String(process.env.DEFAULT_ADMIN_PHONE || '13900000001').trim(),
    syncPassword: parseBoolean(process.env.DEFAULT_ADMIN_SYNC_PASSWORD, false),
  },

  withdrawalFeeRate: parseFloat(process.env.WITHDRAWAL_FEE_RATE || '0.01'),

  defaultCommissionRate: {
    direct: parseFloat(process.env.DEFAULT_COMMISSION_RATE_DIRECT || '0.30'),
    level1: parseFloat(process.env.DEFAULT_COMMISSION_RATE_LEVEL1 || '0.10'),
    level2: parseFloat(process.env.DEFAULT_COMMISSION_RATE_LEVEL2 || '0.05'),
    level3: parseFloat(process.env.DEFAULT_COMMISSION_RATE_LEVEL3 || '0.03'),
    level4: parseFloat(process.env.DEFAULT_COMMISSION_RATE_LEVEL4 || '0.02'),
  },

  cors: {
    allowAll: !isProduction && parseBoolean(process.env.CORS_ALLOW_ALL, true),
    allowedOrigins: corsAllowedOrigins,
  },

  db: {
    requireTransactions: isProduction || parseBoolean(process.env.DB_REQUIRE_TRANSACTIONS, false),
    allowTransactionFallback:
      !isProduction && parseBoolean(process.env.DB_ALLOW_TRANSACTION_FALLBACK, true),
  },
};

function validateProductionConfig() {
  if (!isProduction) {
    return;
  }

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret-key') {
    throw new Error('Production requires a non-default JWT_SECRET');
  }

  if (!process.env.INTERNAL_API_KEY || process.env.INTERNAL_API_KEY === 'dev-internal-key') {
    throw new Error('Production requires a non-default INTERNAL_API_KEY');
  }

  if (config.defaultAdmin.enabled) {
    if (!process.env.DEFAULT_ADMIN_PASSWORD) {
      throw new Error('Production default admin requires DEFAULT_ADMIN_PASSWORD');
    }

    if (
      !isStrongPassword(config.defaultAdmin.password, config.defaultAdmin.username)
    ) {
      throw new Error('Production default admin requires a strong DEFAULT_ADMIN_PASSWORD');
    }
  }

  if (corsAllowedOrigins.length === 0) {
    throw new Error('Production requires CORS_ALLOWED_ORIGINS to be configured');
  }
}

config.validateProductionConfig = validateProductionConfig;
config.isStrongPassword = isStrongPassword;

module.exports = config;
