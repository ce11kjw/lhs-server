/**
 * DistClient - 分销系统 HTTP 客户端
 * 封装与分销系统的内部 API 调用
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const DistCallbackTask = require('../db/models/DistCallbackTask');
const { signInternalRequest } = require('../utils/internalAuth');
const logger = require('../logger');
const runtimeConfig = require('../runtimeConfig');

function parseBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function getDistConfig() {
  return {
    enabled: parseBool(process.env.DIST_ENABLED, true),
    baseUrl: String(process.env.DIST_BASE_URL || 'http://localhost:3001').trim(),
    timeoutMs: Math.max(1000, Number(process.env.DIST_REQUEST_TIMEOUT_MS || 5000) || 5000),
    rechargeAmountUnit: String(process.env.DIST_RECHARGE_AMOUNT_UNIT || 'yuan').trim().toLowerCase(),
  };
}

function getDistApiKey() {
  const apiKey = process.env.DIST_API_KEY || 'dev-internal-key';
  if (runtimeConfig.isProduction && apiKey === 'dev-internal-key') {
    throw new Error('Production requires DIST_API_KEY');
  }
  return apiKey;
}

function getRechargeAmountForDist(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = getDistConfig().rechargeAmountUnit;
  if (unit === 'cent' || unit === 'cents' || unit === 'fen') return Math.round(n);
  return Math.round(n * 100);
}

function buildTaskPayload(type, payload = {}) {
  const playerId = String(payload.playerId || '').trim();
  const orderId = String(payload.orderId || '').trim();
  const inviteCode = String(payload.inviteCode || '').trim();
  const dedupeKey = type === 'rechargeCallback'
    ? `${type}:${orderId}`
    : `${type}:${playerId}:${inviteCode}`;

  return {
    type,
    dedupeKey,
    playerId,
    orderId,
    inviteCode,
    payload,
  };
}

async function resolveTask(task) {
  await DistCallbackTask.markResolved(task.dedupeKey);
}

async function recordTaskFailure(task, err) {
  const message = String(err && err.message ? err.message : err || 'unknown error');
  await DistCallbackTask.recordFailure({
    ...task,
    lastError: message,
  });
  return message;
}

/**
 * 发送 POST 请求到分销系统
 * @param {string} path - API 路径
 * @param {Object} body - 请求体
 * @returns {Promise<Object>} 响应数据
 */
function post(path, body) {
  return new Promise((resolve, reject) => {
    const cfg = getDistConfig();
    if (!cfg.enabled) {
      resolve({ status: 0, data: null, disabled: true });
      return;
    }

    const url = new URL(path, cfg.baseUrl);
    const payload = JSON.stringify(body);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search || ''}`,
        method: 'POST',
        headers: (() => {
          const timestamp = Date.now();
          const nonce = crypto.randomBytes(16).toString('hex');
          const signature = signInternalRequest({
            secret: getDistApiKey(),
            method: 'POST',
            path: url.pathname,
            timestamp,
            nonce,
            body,
          });
          return {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'X-API-Key': getDistApiKey(),
            'X-Timestamp': String(timestamp),
            'X-Nonce': nonce,
            'X-Signature': signature,
          };
        })(),
        timeout: cfg.timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch (_e) {
            resolve({ status: res.statusCode, data });
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('分销系统请求超时'));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * 绑定邀请码
 * @param {string} playerId - 玩家 ID
 * @param {string} inviteCode - 邀请码
 * @returns {Promise<Object>}
 */
async function bindInvite(playerId, inviteCode) {
  const task = buildTaskPayload('bindInvite', { playerId, inviteCode });
  if (!getDistConfig().enabled) {
    logger.info('[Dist] 分销系统已禁用，跳过邀请码绑定同步');
    return { status: 0, data: null, pendingCompensation: false, disabled: true };
  }
  try {
    const result = await post('/internal/bind-invite', { playerId, inviteCode });
    await resolveTask(task);
    logger.info(`[Dist] 绑定邀请码: playerId=${playerId} code=${inviteCode} status=${result.status}`);
    return { ...result, pendingCompensation: false };
  } catch (err) {
    const message = await recordTaskFailure(task, err);
    logger.warn(`[Dist] 绑定邀请码失败: ${message}（已记录待补偿任务）`);
    return { status: 0, data: null, pendingCompensation: true, error: message };
  }
}

/**
 * 充值佣金回调
 * @param {Object} params
 * @param {string} params.playerId - 玩家 ID
 * @param {string} params.orderId - 订单 ID
 * @param {number} params.amount - 充值金额（分）
 * @param {string} params.inviteCode - 邀请码
 * @returns {Promise<Object>}
 */
async function rechargeCallback({ playerId, orderId, amount, inviteCode }) {
  const distAmount = getRechargeAmountForDist(amount);
  const task = buildTaskPayload('rechargeCallback', { playerId, orderId, amount: distAmount, inviteCode });
  if (!getDistConfig().enabled) {
    logger.info('[Dist] 分销系统已禁用，跳过充值佣金同步');
    return { status: 0, data: null, pendingCompensation: false, disabled: true };
  }
  try {
    const result = await post('/internal/recharge-callback', {
      playerId,
      orderId,
      amount: distAmount,
      inviteCode,
    });
    await resolveTask(task);
    logger.info(`[Dist] 充值回调: orderId=${orderId} amount=${distAmount} status=${result.status}`);
    return { ...result, pendingCompensation: false };
  } catch (err) {
    const message = await recordTaskFailure(task, err);
    logger.warn(`[Dist] 充值回调失败: ${message}（已记录待补偿任务）`);
    return { status: 0, data: null, pendingCompensation: true, error: message };
  }
}

module.exports = { post, bindInvite, rechargeCallback, getDistConfig, getRechargeAmountForDist };
