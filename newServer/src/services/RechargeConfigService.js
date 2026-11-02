const configService = require('./ConfigService');
const RechargeProductConfig = require('../db/models/RechargeProductConfig');

function toSafeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeText(value, maxLength = 0) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return maxLength > 0 ? text.slice(0, maxLength) : text;
}

function normalizeProductId(value) {
  return normalizeText(value, 64);
}

function normalizeRewardItems(input) {
  if (Array.isArray(input)) {
    return input
      .map((row) => ({
        id: Math.max(0, Math.floor(toSafeNumber(row && row.id, 0))),
        count: Math.max(0, Math.floor(toSafeNumber(row && row.count, 0))),
      }))
      .filter((row) => row.id > 0 && row.count > 0)
      .sort((a, b) => a.id - b.id);
  }

  if (input && typeof input === 'object') {
    return Object.keys(input)
      .map((id) => ({
        id: Math.max(0, Math.floor(toSafeNumber(id, 0))),
        count: Math.max(0, Math.floor(toSafeNumber(input[id], 0))),
      }))
      .filter((row) => row.id > 0 && row.count > 0)
      .sort((a, b) => a.id - b.id);
  }

  return [];
}

function buildFallbackName(productId) {
  return productId ? `充值档位#${productId}` : '未命名充值项';
}

function buildBuiltinRow(productId, row = {}) {
  const id = normalizeProductId(productId);
  if (!id) return null;
  const amount = toSafeNumber(
    row.priceR ?? row.price ?? row.money ?? row.amount ?? row.rmb ?? row.value,
    0
  );
  const diamond = Math.max(
    0,
    toSafeNumber(row.diamond ?? row.count ?? row.itemCount ?? row.rewardDiamond, 0)
  );
  const firstBonus = Math.max(
    0,
    toSafeNumber(row.firstBonus ?? row.firstReward ?? row.firstDiamond ?? row.doubleDiamond, 0)
  );

  return {
    productId: id,
    name: normalizeText(row.name, 64) || buildFallbackName(id),
    amount: Math.max(0, amount),
    diamond,
    firstBonus,
    payType: normalizeText(row.payType ?? row.type, 32),
    attachments: [],
    mailTitle: '',
    mailContent: '',
    enabled: true,
    sort: toSafeNumber(row.sort ?? row.index ?? row.order ?? productId, 0),
    note: '',
    source: 'builtin',
  };
}

function sanitizeDbRow(row = {}) {
  const productId = normalizeProductId(row.productId);
  return {
    productId,
    name: normalizeText(row.name, 64) || buildFallbackName(productId),
    amount: Math.max(0, toSafeNumber(row.amount, 0)),
    diamond: Math.max(0, Math.floor(toSafeNumber(row.diamond, 0))),
    firstBonus: Math.max(0, Math.floor(toSafeNumber(row.firstBonus, 0))),
    payType: normalizeText(row.payType, 32),
    attachments: normalizeRewardItems(row.attachments),
    mailTitle: normalizeText(row.mailTitle, 120),
    mailContent: normalizeText(row.mailContent, 1000),
    enabled: row.enabled !== false,
    sort: Math.floor(toSafeNumber(row.sort, 0)),
    note: normalizeText(row.note, 200),
    createdBy: normalizeText(row.createdBy, 64),
    updatedBy: normalizeText(row.updatedBy, 64),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    source: 'custom',
  };
}

async function listCustomRows() {
  const rows = await RechargeProductConfig.find({}).sort({ sort: 1, productId: 1 }).lean();
  return rows.map(sanitizeDbRow);
}

function listBuiltinRows() {
  const payCfg = configService.get('PayConfig') || {};
  return Object.keys(payCfg)
    .map((productId) => buildBuiltinRow(productId, payCfg[productId]))
    .filter(Boolean)
    .sort((a, b) => a.sort - b.sort || a.productId.localeCompare(b.productId));
}

async function listMergedRows() {
  const builtinRows = listBuiltinRows();
  const customRows = await listCustomRows();
  const map = new Map();

  builtinRows.forEach((row) => map.set(row.productId, row));
  customRows.forEach((row) => {
    const base = map.get(row.productId) || {};
    map.set(row.productId, {
      ...base,
      ...row,
      productId: row.productId,
      source: base.productId ? 'builtin+custom' : 'custom',
    });
  });

  return Array.from(map.values()).sort((a, b) => a.sort - b.sort || a.productId.localeCompare(b.productId));
}

async function getResolvedRow(productId) {
  const normalized = normalizeProductId(productId);
  if (!normalized) return null;

  const custom = await RechargeProductConfig.findOne({ productId: normalized }).lean();
  if (custom) {
    const base = buildBuiltinRow(normalized, (configService.get('PayConfig') || {})[normalized] || {});
    return {
      ...(base || {}),
      ...sanitizeDbRow(custom),
      productId: normalized,
      source: base ? 'builtin+custom' : 'custom',
    };
  }

  return buildBuiltinRow(normalized, (configService.get('PayConfig') || {})[normalized] || {}) || null;
}

async function saveRow(input = {}, actor = '') {
  const productId = normalizeProductId(input.productId);
  if (!productId) {
    const error = new Error('INVALID_PRODUCT_ID');
    error.status = 400;
    throw error;
  }

  const payload = {
    productId,
    name: normalizeText(input.name, 64) || buildFallbackName(productId),
    amount: Math.max(0, toSafeNumber(input.amount, 0)),
    diamond: Math.max(0, Math.floor(toSafeNumber(input.diamond, 0))),
    firstBonus: Math.max(0, Math.floor(toSafeNumber(input.firstBonus, 0))),
    payType: normalizeText(input.payType, 32),
    attachments: normalizeRewardItems(input.attachments),
    mailTitle: normalizeText(input.mailTitle, 120),
    mailContent: normalizeText(input.mailContent, 1000),
    enabled: input.enabled !== false,
    sort: Math.floor(toSafeNumber(input.sort, 0)),
    note: normalizeText(input.note, 200),
    updatedBy: normalizeText(actor, 64),
  };

  if (!(payload.amount > 0)) {
    const error = new Error('INVALID_RECHARGE_AMOUNT');
    error.status = 400;
    throw error;
  }

  const existing = await RechargeProductConfig.findOne({ productId });
  if (existing) {
    Object.assign(existing, payload);
    await existing.save();
    return getResolvedRow(productId);
  }

  const created = await RechargeProductConfig.create({
    ...payload,
    createdBy: normalizeText(actor, 64),
  });
  return getResolvedRow(created.productId);
}

async function deleteRow(productId) {
  const normalized = normalizeProductId(productId);
  if (!normalized) {
    const error = new Error('INVALID_PRODUCT_ID');
    error.status = 400;
    throw error;
  }
  const deleted = await RechargeProductConfig.findOneAndDelete({ productId: normalized }).lean();
  return !!deleted;
}

module.exports = {
  deleteRow,
  getResolvedRow,
  listBuiltinRows,
  listMergedRows,
  normalizeRewardItems,
  normalizeProductId,
  saveRow,
};
