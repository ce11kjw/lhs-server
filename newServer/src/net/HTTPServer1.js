/**
 * HTTPServer - HTTP API 服务端。
 * 处理客户端 HTTP 请求（登录、SDK）和 internal API（分销系统）。
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const express = require('express');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { PacketManager } = require('../protocol');
const mongo = require('../db/mongo');
const redis = require('../db/redis');
const { verifyInternalRequest } = require('../utils/internalAuth');
const logger = require('../logger');
const runtimeConfig = require('../runtimeConfig');
const battleService = require('../services/BattleService');
const configService = require('../services/ConfigService');
const playerService = require('../services/PlayerService');
const accountService = require('../services/AccountService');
const authSessionService = require('../services/AuthSessionService');
const {
  applyGivePayloadToPlayer,
  buildItemSyncPayload,
  hasGivePayloadContent,
  sanitizeGivePayload,
} = require('../services/PlayerGrantService');
const { normalizeTaskInfo } = require('../handlers/playerPayload');
const { migratePlayerData } = require('../services/PlayerMigrationService');

const DEFAULT_REGISTER_PATH = '/register.html';

const ADMIN_LANGUAGE_CONFIG_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'LHS-file',
  'config',
  'LanguageConfig.json'
);
const ADMIN_CONFIG_MAP_PATH = path.join(__dirname, '..', '..', '..', 'configMap,json');

const COMPRESSIBLE_STATIC_EXTENSIONS = new Set(['.js', '.css', '.html', '.json', '.svg', '.xml', '.txt', '.bin']);

const ADMIN_CURRENCY_ITEM_LABELS = {
  1: '元宝',
  2: '银币',
  4: '包子',
  6: '加速符',
  7: '法相碎片',
  8: '法相精华',
  137: '灵韵',
  1001: '天衍令(小)',
  1002: '天衍令(中)',
  1003: '天衍令(大)',
  35: '灵田经验',
  102: '奶酪',
  7010: '代金券',
};

const ADMIN_FARM_SEED_ITEM_LABELS = {
  27: '肥料',
  28: '高级肥料',
  29: '种子',
  30: '高级种子',
  31: '特级种子',
  100: '奇异种子',
};

const INTERNAL_API_WINDOW_MS = 60 * 1000;
const INTERNAL_API_MAX_REQUESTS = Number(process.env.INTERNAL_API_RATE_LIMIT_MAX || 120);
const BCRYPT_PREFIX = '$2';
const BCRYPT_ROUNDS = 10;

let adminLanguageConfigCache = null;
let adminConfigMapCache = null;

function parseIntSafe(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function ensurePlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeText(value, maxLength = 0) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return maxLength > 0 ? text.slice(0, maxLength) : text;
}

function getRegisterUrl(req) {
  const configured = String(process.env.REGISTER_URL || '').trim();
  if (configured) return configured;

  let host = String(
    (req && req.headers && req.headers['x-forwarded-host'])
    || (req && req.hostname)
    || (req && req.headers && req.headers.host)
    || process.env.SERVER_PUBLIC_HOST
    || '127.0.0.1'
  ).split(',')[0].trim();
  host = host.replace(/^https?:\/\//i, '').split('/')[0];
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end >= 0 ? host.slice(1, end) : host;
  } else if (host.includes(':')) {
    host = host.split(':')[0];
  }
  const safeHost = host.includes(':') ? `[${host}]` : host;
  const port = Number.parseInt(process.env.REGISTER_PUBLIC_PORT || '', 10) || 18081;
  return `http://${safeHost}:${port}${DEFAULT_REGISTER_PATH}`;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function hashOperatorLegacyPassword(password) {
  return crypto.createHash('sha256').update(String(password || ''), 'utf8').digest('hex');
}

function isBcryptHash(value) {
  return String(value || '').startsWith(BCRYPT_PREFIX);
}

async function hashOperatorPassword(password) {
  return bcrypt.hash(String(password || ''), BCRYPT_ROUNDS);
}

async function verifyOperatorPassword(password, passwordHash) {
  const normalizedHash = String(passwordHash || '');
  if (!normalizedHash) return { matched: false, needsUpgrade: false };
  if (isBcryptHash(normalizedHash)) {
    return { matched: await bcrypt.compare(String(password || ''), normalizedHash), needsUpgrade: false };
  }
  return {
    matched: hashOperatorLegacyPassword(password) === normalizedHash,
    needsUpgrade: true,
  };
}

function sanitizeAgentPermissions(value) {
  const raw = ensurePlainObject(value);
  return {
    giveItems: parseBool(raw.giveItems, false),
    recharge: parseBool(raw.recharge, false),
  };
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((id) => Math.max(1, toSafeInt(id, 0)))
    .filter((id, index, arr) => id > 0 && arr.indexOf(id) === index)
    .sort((a, b) => a - b);
}

function normalizeRedemptionCode(value) {
  return normalizeText(value, 64).toUpperCase().replace(/\s+/g, '');
}

function parseAdminDate(value) {
  const text = normalizeText(value, 64);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time) : null;
}

function sanitizeAgentLimits(value) {
  const raw = ensurePlainObject(value);
  const currencyCandidates = Array.isArray(raw.giveCurrencyWhitelist)
    ? raw.giveCurrencyWhitelist
    : String(raw.giveCurrencyWhitelist || '').split(/[，,\s]+/);
  return {
    giveCurrencyWhitelist: currencyCandidates
      .map((key) => normalizeText(key, 32).toLowerCase())
      .filter((key, index, arr) => ['diamond', 'gold', 'silver'].includes(key) && arr.indexOf(key) === index),
    giveItemWhitelist: normalizeIdList(raw.giveItemWhitelist),
    rechargeSingleLimit: Math.max(0, Number(raw.rechargeSingleLimit || 0)) || 0,
    rechargeDailyLimit: Math.max(0, Number(raw.rechargeDailyLimit || 0)) || 0,
  };
}

function buildFullPermissions() {
  return {
    giveItems: true,
    recharge: true,
  };
}

function buildFullLimits() {
  return {
    giveCurrencyWhitelist: [],
    giveItemWhitelist: [],
    rechargeSingleLimit: 0,
    rechargeDailyLimit: 0,
  };
}

function getAdminAllSystemIds() {
  const systemCfg = ensurePlainObject(configService.get('SystemConfig'));
  return Object.keys(systemCfg)
    .map((id) => Math.max(1, toSafeInt(id, 1)))
    .filter((id, index, arr) => id > 0 && arr.indexOf(id) === index)
    .sort((a, b) => a - b);
}

function applyUnlockAllSystemsToPlayer(player) {
  const allSystemIds = getAdminAllSystemIds();
  player.systemUnlockInfo = ensurePlainObject(player.systemUnlockInfo);
  player.systemUnlockInfo.settings = ensurePlainObject(player.systemUnlockInfo.settings);
  player.systemUnlockInfo.unlockedSystem = allSystemIds.slice();
  player.systemUnlockInfo.rewardedSystem = allSystemIds.slice();
  player.systemUnlockInfo.guideStep = Math.max(
    toSafeInt(player.systemUnlockInfo.guideStep, 0),
    99999,
  );
  player.systemUnlockInfo.settings.seenNewFeatures = allSystemIds.slice();
  if (typeof player.markModified === 'function') {
    player.markModified('systemUnlockInfo');
  }
  return allSystemIds;
}

function getSystemConfigRow(systemId) {
  const systemCfg = ensurePlainObject(configService.get('SystemConfig'));
  return ensurePlainObject(systemCfg[systemId] || systemCfg[String(systemId)]);
}

function getSystemDisplayText(systemId) {
  const row = getSystemConfigRow(systemId);
  return [
    resolveAdminText(row.name),
    resolveAdminText(row.desc),
  ].filter(Boolean).join(' ');
}

function buildSystemInitializerContext() {
  const { ensureEquipInfo } = require('../services/EquipService');
  const { ensureFormationInfo } = require('../services/FormationService');
  const { ensureRoleAppearance } = require('../services/RoleAppearanceService');
  const { ensureSpiritInfo, ensureLegacySpiritInfo } = require('../handlers/spirit');
  const { ensureRoleInfo } = require('../handlers/upgrade');
  const { ensureFarmInfo } = require('../handlers/farm');
  const { ensureMineInfo } = require('../handlers/mine');
  const { ensureFateInfo } = require('../handlers/fate');
  const { ensureGemInfo } = require('../handlers/gem');
  const { ensureValhallaInfo } = require('../handlers/valhalla');
  const { ensureBloodlineInfo } = require('../handlers/bloodline');
  const { ensureDungeonRaidInfo } = require('../handlers/dungeon');
  const { ensureAuctionInfo } = require('../handlers/auction');
  const { ensureCuriosInfo } = require('../handlers/curios');
  const { ensureTempleInfo } = require('../handlers/temple');
  const { ensureRebornInfo } = require('../handlers/reborn');
  const { ensureInvestGameInfo } = require('../handlers/invest-game');
  const { ensureGloryInfo } = require('../handlers/glory');
  const { ensureActivityInfo } = require('../handlers/activity');
  const { ensureValhallaFormationInfo } = require('../handlers/valhalla-formation');
  const { ensurePetSoulInfo } = require('../handlers/pet-soul');
  const { ensureHorseRaceInfo } = require('../handlers/horse-race');
  const { ensureAlchemyInfo } = require('../handlers/alchemy');
  const { ensureFashionInfo } = require('../handlers/fashion');
  const { ensureArtifactInfo } = require('../handlers/artifact');
  const { ensureFishInfo } = require('../handlers/fish');
  const { ensurePetInfo } = require('../handlers/pet');
  const { ensureMountInfo } = require('../handlers/mount');
  const { ensureCrossRivalInfo } = require('../handlers/cross-rival');
  return {
    roleBase(player) {
      ensureRoleInfo(player);
      ensureEquipInfo(player);
      ensureFormationInfo(player);
      ensureRoleAppearance(player);
    },
    spirit(player) {
      ensureSpiritInfo(player);
      ensureLegacySpiritInfo(player);
    },
    farm: ensureFarmInfo,
    mine: ensureMineInfo,
    fate: ensureFateInfo,
    gem: ensureGemInfo,
    valhalla: ensureValhallaInfo,
    bloodline: ensureBloodlineInfo,
    dungeon: ensureDungeonRaidInfo,
    auction: ensureAuctionInfo,
    curios: ensureCuriosInfo,
    temple: ensureTempleInfo,
    reborn: ensureRebornInfo,
    investGame: ensureInvestGameInfo,
    glory: ensureGloryInfo,
    activity: ensureActivityInfo,
    valhallaFormation: ensureValhallaFormationInfo,
    petSoul: ensurePetSoulInfo,
    horseRace: ensureHorseRaceInfo,
    alchemy: ensureAlchemyInfo,
    fashion: ensureFashionInfo,
    artifact: ensureArtifactInfo,
    fish: ensureFishInfo,
    pet: ensurePetInfo,
    mount: ensureMountInfo,
    crossRival: ensureCrossRivalInfo,
  };
}

function getSystemInitializerKeys(systemId) {
  const text = getSystemDisplayText(systemId);
  const keys = new Set(['roleBase']);
  const rules = [
    { key: 'spirit', keywords: ['法相', '灵相'] },
    { key: 'farm', keywords: ['灵田', '田鼠', '偷菜'] },
    { key: 'mine', keywords: ['矿', '矿洞'] },
    { key: 'fate', keywords: ['命格', '天命'] },
    { key: 'gem', keywords: ['宝石'] },
    { key: 'valhalla', keywords: ['英灵殿', '圣堂'] },
    { key: 'bloodline', keywords: ['血脉', '法宝共鸣'] },
    { key: 'dungeon', keywords: ['妖王', '试炼', '副本', '秘境'] },
    { key: 'auction', keywords: ['拍卖'] },
    { key: 'curios', keywords: ['奇物', '珍宝'] },
    { key: 'temple', keywords: ['神殿', '小游戏', '灵韵'] },
    { key: 'reborn', keywords: ['轮回'] },
    { key: 'investGame', keywords: ['养成投资', '投资'] },
    { key: 'glory', keywords: ['荣耀', '光辉'] },
    { key: 'activity', keywords: ['活动', '福利', '签到'] },
    { key: 'valhallaFormation', keywords: ['英灵阵', '圣堂阵'] },
    { key: 'petSoul', keywords: ['宠物魂', '兽魂'] },
    { key: 'horseRace', keywords: ['赛马', '跑马'] },
    { key: 'alchemy', keywords: ['炼丹'] },
    { key: 'fashion', keywords: ['时装', '外观'] },
    { key: 'artifact', keywords: ['神器'] },
    { key: 'fish', keywords: ['钓鱼'] },
    { key: 'pet', keywords: ['宠物'] },
    { key: 'mount', keywords: ['坐骑'] },
    { key: 'crossRival', keywords: ['魔灵入侵', '入侵'] },
  ];
  rules.forEach((rule) => {
    if (rule.keywords.some((keyword) => text.includes(keyword))) {
      keys.add(rule.key);
    }
  });
  return Array.from(keys);
}

function initializeUnlockedSystemDataByMap(player, systemIds = []) {
  if (!player || typeof player !== 'object') return [];
  const context = buildSystemInitializerContext();
  const applied = new Set();
  (Array.isArray(systemIds) ? systemIds : []).forEach((systemId) => {
    getSystemInitializerKeys(systemId).forEach((key) => {
      if (applied.has(key)) return;
      const initializer = context[key];
      if (typeof initializer === 'function') {
        initializer(player);
        applied.add(key);
      }
    });
  });
  return Array.from(applied);
}

function initializeUnlockedSystemData(player) {
  if (!player || typeof player !== 'object') return;
  migratePlayerData(player);
  const systemIds = normalizeIdList(
    ensurePlainObject(player.systemUnlockInfo).unlockedSystem,
  );
  initializeUnlockedSystemDataByMap(player, systemIds);
  const context = buildSystemInitializerContext();
  Object.keys(context).forEach((key) => {
    const initializer = context[key];
    if (typeof initializer === 'function') initializer(player);
  });
}

function parseCmdIdSet(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  const ids = raw
    .split(',')
    .map((x) => Number.parseInt(String(x).trim(), 10))
    .filter((x) => Number.isFinite(x) && x > 0);
  return new Set(ids);
}

function loadAdminLanguageConfig() {
  if (adminLanguageConfigCache) return adminLanguageConfigCache;
  try {
    if (fs.existsSync(ADMIN_LANGUAGE_CONFIG_PATH)) {
      adminLanguageConfigCache = JSON.parse(fs.readFileSync(ADMIN_LANGUAGE_CONFIG_PATH, 'utf8'));
      return adminLanguageConfigCache;
    }
  } catch (err) {
    logger.warn(`[Admin] 读取语言配置失败: ${err.message}`);
  }
  adminLanguageConfigCache = {};
  return adminLanguageConfigCache;
}

function loadAdminConfigMap() {
  if (adminConfigMapCache) return adminConfigMapCache;
  try {
    if (fs.existsSync(ADMIN_CONFIG_MAP_PATH)) {
      adminConfigMapCache = JSON.parse(fs.readFileSync(ADMIN_CONFIG_MAP_PATH, 'utf8'));
      return adminConfigMapCache;
    }
  } catch (err) {
    logger.warn(`[Admin] 读取 configMap 失败: ${err.message}`);
  }
  adminConfigMapCache = {};
  return adminConfigMapCache;
}

function saveAdminConfigMap(nextMap = {}) {
  const normalized = ensurePlainObject(nextMap);
  fs.writeFileSync(ADMIN_CONFIG_MAP_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  adminConfigMapCache = normalized;
  return normalized;
}

function resolveAdminConfigName(id) {
  const safeId = toSafeInt(id, 0);
  if (safeId <= 0) return '';
  const row = loadAdminConfigMap()[String(safeId)] || loadAdminConfigMap()[safeId];
  return normalizeText(row && row.cn || '');
}

function normalizeAdminItemConfigRow(itemId, row = {}) {
  const id = Math.max(1, toSafeInt(itemId, 0));
  const src = ensurePlainObject(row);
  return {
    itemId: id,
    cn: normalizeText(src.cn || src.zh || src.text || '', 120),
  };
}

function parseAdminNumberList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[，,\s]+/);
  return raw
    .map((item) => toSafeInt(item, 0))
    .filter((item, index, arr) => item > 0 && arr.indexOf(item) === index);
}

function normalizeAdminItemDictionaryRow(row = {}) {
  const src = ensurePlainObject(row);
  const itemId = Math.max(1, toSafeInt(src.itemId || src.id, 0));
  return {
    itemId,
    name: normalizeText(src.name || src.cn || '', 120) || `道具#${itemId}`,
    cn: normalizeText(src.name || src.cn || '', 120) || `道具#${itemId}`,
    desc: normalizeText(src.desc || '', 1000),
    type: toSafeInt(src.type, 0),
    typeName: normalizeText(src.typeName || '', 80),
    subType: toSafeInt(src.subType, 0),
    quality: toSafeInt(src.quality, 0),
    icon: normalizeText(src.icon || '', 160),
    ifShow: toSafeInt(src.ifShow, 0),
    itemWay: parseAdminNumberList(src.itemWay),
    sourceTable: normalizeText(src.sourceTable || 'AssetsConfig', 80),
    raw: src.raw || null,
    generatedAt: src.generatedAt || new Date(),
  };
}

function resolveAdminText(value, languageConfig = loadAdminLanguageConfig()) {
  if (value == null) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    return resolveAdminConfigName(text) || text;
  }
  const key = String(value);
  const row = languageConfig[key];
  if (row && typeof row === 'object') {
    return normalizeText(row.cn || row.zh || row.text || '') || resolveAdminConfigName(value);
  }
  return resolveAdminConfigName(value) || key;
}

function getAdminItemLabel(itemId) {
  const safeId = toSafeInt(itemId, 0);
  return resolveAdminConfigName(safeId) || ADMIN_CURRENCY_ITEM_LABELS[safeId] || `道具#${safeId}`;
}

function getAdminTaskStatusLabel(status) {
  const safeStatus = toSafeInt(status, 10);
  if (safeStatus >= 30) return '已完成';
  if (safeStatus >= 20) return '可领取';
  return '进行中';
}

function getAdminTaskTypeLabel(type) {
  const safeType = toSafeInt(type, 0);
  if (safeType === 1) return '主线';
  if (safeType === 2) return '支线';
  if (safeType === 3) return '日常';
  if (safeType === 4) return '活动';
  return safeType > 0 ? `类型${safeType}` : '未分组';
}

function getAdminStageDisplayName(stage, stageCfg, resolveTextFn) {
  const stageName = resolveTextFn(stageCfg && stageCfg.name) || `境界${stage}`;
  return `第${Math.max(1, toSafeInt(stage, 1))}关·${stageName}`;
}

class HTTPServer {
  /**
   * @param {Object} options
   * @param {number} options.port - 监听端口（默认 8080）
   * @param {string} options.apiKey - internal API 认证密钥
   */
  constructor(options = {}) {
    this.port = options.port || 8080;
    this.apiKey = options.apiKey || process.env.API_KEY || 'lhs_internal_key';
    this.adminUsername = process.env.ADMIN_USERNAME || 'admin';
    this.adminPassword = process.env.ADMIN_PASSWORD || '';
    this._adminSessions = new Map(); // token -> session info
    this._internalApiHits = new Map();
    this.clientDir = options.clientDir || process.env.CLIENT_DIR || path.join(__dirname, '..', '..', '..', 'LHS-re');
    this.portalType = options.portalType || 'admin';
    this.defaultStaticPage = options.defaultStaticPage || 'index.html';
    this.app = express();
    this.server = null;
    this.realHttpProxyEnabled = parseBool(
      options.realHttpProxyEnabled ?? process.env.REAL_HTTP_PROXY_ENABLED,
      false
    );
    this.realHttpProxyBaseUrl = String(
      options.realHttpProxyBaseUrl ?? process.env.REAL_HTTP_PROXY_BASE_URL ?? ''
    ).trim();
    this.realHttpProxyCmdSet = parseCmdIdSet(
      options.realHttpProxyCmds ?? process.env.REAL_HTTP_PROXY_CMDS ?? ''
    );
    this.realHttpProxyTimeoutMs = Math.max(
      1000,
      parseIntSafe(options.realHttpProxyTimeoutMs ?? process.env.REAL_HTTP_PROXY_TIMEOUT_MS, 8000)
    );
    this.realHttpProxyFailOpen = parseBool(
      options.realHttpProxyFailOpen ?? process.env.REAL_HTTP_PROXY_FAIL_OPEN,
      false
    );
    this.gameMsgHandlerTimeoutMs = Math.max(
      1000,
      parseIntSafe(options.gameMsgHandlerTimeoutMs ?? process.env.GAME_MSG_HANDLER_TIMEOUT_MS, 10000)
    );
    this.gameMsgSlowLogMs = Math.max(
      100,
      parseIntSafe(options.gameMsgSlowLogMs ?? process.env.GAME_MSG_SLOW_LOG_MS, 1000)
    );
    this.internalJsonLimit = options.internalJsonLimit || process.env.INTERNAL_JSON_LIMIT || '2mb';
    this.adminJsonLimit = options.adminJsonLimit || process.env.ADMIN_JSON_LIMIT || '2mb';
    this.userJsonLimit = options.userJsonLimit || process.env.USER_JSON_LIMIT || '1mb';
    this.payBodyLimit = options.payBodyLimit || process.env.PAY_BODY_LIMIT || '1mb';
    this.gameMsgBodyLimit = options.gameMsgBodyLimit || process.env.GAME_MSG_BODY_LIMIT || '8mb';

    // 预扫描 bin 文件哈希映射，兼容客户端资源哈希变化。
    this.binFileMap = {};
    this.hashedFileMap = new Map();
    this.gzipStaticCache = new Map();
    this._scanBinFiles();
    this._scanHashedFiles();

    this._setupMiddleware();
    this._setupRoutes();
    this._setupErrorHandling();
  }

  _shouldProxyGameMsg(protocolId) {
    if (!this.realHttpProxyEnabled) return false;
    if (!this.realHttpProxyBaseUrl) return false;
    if (this.realHttpProxyCmdSet.size <= 0) return true;
    return this.realHttpProxyCmdSet.has(Number(protocolId));
  }

  async _proxyGameMsgToReal(req, body, protocolId) {
    const upstreamUrl = new URL(req.originalUrl || req.url || '/gameMsg.do', this.realHttpProxyBaseUrl).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.realHttpProxyTimeoutMs);
    try {
      logger.info(`[HTTP] proxy -> real cmd=${protocolId} url=${upstreamUrl}`);
      const headers = {
        'Content-Type': req.headers['content-type'] || 'application/octet-stream',
      };
      if (req.headers['binary-version']) {
        headers['binary-version'] = String(req.headers['binary-version']);
      }
      const resp = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      const raw = Buffer.from(await resp.arrayBuffer());
      return {
        ok: resp.ok,
        status: resp.status || 200,
        body: raw,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 扫描客户端 update/resource 目录中的 .bin 文件并建立前缀映射。
   */
  _scanBinFiles() {
    const resDir = path.join(this.clientDir, 'update', 'resource');
    if (!fs.existsSync(resDir)) return;
    fs.readdirSync(resDir).forEach(f => {
      if (f.endsWith('.bin')) {
        const prefix = f.replace(/_[a-f0-9]+\.bin$/, '');
        this.binFileMap[prefix] = f;
      }
    });
    const count = Object.keys(this.binFileMap).length;
    if (count > 0) logger.info(`[HTTPServer] mapped ${count} resource bin files`);
  }

  _scanHashedFiles() {
    if (!fs.existsSync(this.clientDir)) return;

    let count = 0;
    const stack = [this.clientDir];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_e) {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (!ext) continue;
        const base = path.basename(entry.name, ext);
        const match = base.match(/^(.*)_([a-f0-9]{6,})$/i);
        if (!match) continue;

        const prefix = match[1];
        const relDir = path.relative(this.clientDir, path.dirname(fullPath)).replace(/\\/g, '/');
        const key = `${relDir}|${prefix}|${ext}`;
        if (!this.hashedFileMap.has(key)) {
          this.hashedFileMap.set(key, fullPath);
          count++;
        }
      }
    }
    if (count > 0) logger.info(`[HTTPServer] mapped ${count} hashed static files`);
  }

  _resolveHashedFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (!ext) return null;
    const reqBase = path.basename(filePath, ext);
    if (!reqBase) return null;

    const match = reqBase.match(/^(.*)_([a-f0-9]{6,})$/i);
    const prefix = match ? match[1] : reqBase;
    const relDir = path.relative(this.clientDir, path.dirname(filePath)).replace(/\\/g, '/');
    const key = `${relDir}|${prefix}|${ext}`;
    return this.hashedFileMap.get(key) || null;
  }

  _getStaticCacheHeaders(filePath) {
    const name = path.basename(filePath);
    const isHtml = path.extname(filePath).toLowerCase() === '.html';
    const isVersioned = /_[a-f0-9]{6,}\./i.test(name);

    return {
      'Cache-Control': isHtml
        ? 'no-cache'
        : isVersioned
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
    };
  }

  _canGzipStatic(req, filePath, stat) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (!String(req.headers['accept-encoding'] || '').includes('gzip')) return false;
    if ((stat && stat.size) < 1024) return false;
    return COMPRESSIBLE_STATIC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  _sendStaticFile(req, res, filePath) {
    const stat = fs.statSync(filePath);
    const headers = this._getStaticCacheHeaders(filePath);
    if (!this._canGzipStatic(req, filePath, stat)) {
      return res.sendFile(filePath, { headers });
    }

    Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.type(path.extname(filePath));
    const cacheKey = `${filePath}|${stat.size}|${stat.mtimeMs}`;
    let gzipped = this.gzipStaticCache.get(cacheKey);
    if (!gzipped) {
      gzipped = zlib.gzipSync(fs.readFileSync(filePath), { level: 1 });
      this.gzipStaticCache.set(cacheKey, gzipped);
      if (this.gzipStaticCache.size > 32) {
        this.gzipStaticCache.delete(this.gzipStaticCache.keys().next().value);
      }
    }
    res.setHeader('Content-Length', gzipped.length);

    if (req.method === 'HEAD') return res.end();
    return res.end(gzipped);
  }

  /**
   * 配置中间件。
   */
  _setupMiddleware() {
    // CORS
    this.app.use((req, res, next) => {
      const corsState = runtimeConfig.applyCorsHeaders(req, res);
      if (req.headers.origin && !corsState.allowed) {
        return res.status(403).json({ success: false, error: 'CORS_ORIGIN_DENIED' });
      }
      next();
    });


    this.app.options('/{*path}', (req, res) => {
      const corsState = runtimeConfig.applyCorsHeaders(req, res);
      if (req.headers.origin && !corsState.allowed) {
        return res.sendStatus(403);
      }
      return res.sendStatus(200);
    });

    // JSON parser for internal API
    this.app.use('/api/internal', express.json({ limit: this.internalJsonLimit }));
    // JSON parser for admin API
    this.app.use('/api/admin', express.json({ limit: this.adminJsonLimit }));
    // JSON parser for public user registration/login API
    this.app.use('/api/user', express.json({ limit: this.userJsonLimit }));

    // raw binary body parser for game client requests
    this.app.use('/gameMsg.do', express.raw({ type: '*/*', limit: this.gameMsgBodyLimit }));
    this.app.use('/gameMsq.do', express.raw({ type: '*/*', limit: this.gameMsgBodyLimit }));
    // public payment APIs and gateway callbacks
    this.app.use('/api/pay', express.json({ limit: this.payBodyLimit }));
    this.app.use('/api/pay', express.urlencoded({ extended: false, limit: this.payBodyLimit }));
  }

  _setupErrorHandling() {
    this.app.use((err, req, res, next) => {
      if (!err) return next();
      if (err.type === 'entity.too.large' || err.status === 413) {
        logger.warn(
          `[HTTP] request entity too large path=${req.originalUrl || req.url || ''} `
          + `method=${req.method} contentLength=${req.headers['content-length'] || ''} limit=${err.limit || ''}`
        );
        return res.status(413).json({ success: false, error: 'PAYLOAD_TOO_LARGE' });
      }
      logger.error(`[HTTP] request parse failed path=${req.originalUrl || req.url || ''}: ${err.message}`);
      return res.status(err.status || 400).json({ success: false, error: 'BAD_REQUEST' });
    });
  }

  /**
   * 閰嶇疆璺敱
   */
  _setupRoutes() {
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        role: 'http',
        timestamp: new Date().toISOString(),
      });
    });

    this.app.get('/ready', async (_req, res) => {
      const checks = {
        mongo: mongo.isConnected(),
        redis: await redis.isConnected(),
      };
      const ok = checks.mongo && checks.redis;
      res.status(ok ? 200 : 503).json({
        status: ok ? 'ok' : 'degraded',
        role: 'http',
        checks,
        timestamp: new Date().toISOString(),
      });
    });


    // 游戏客户端 HTTP 请求（BinJson 二进制协议）。
    this.app.post(['/gameMsg.do', '/gameMsq.do'], (req, res) => {
      void this._handleGameMsg(req, res);
    });
    this.app.get(['/gameMsg.do', '/gameMsq.do'], (_req, res) => this._handleGameMsgGet(res));

    this.app.post('/api/pay/xtpay/create', (req, res) => {
      void this._handleXtPayCreate(req, res);
    });
    this.app.all('/api/pay/xtpay/notify', (req, res) => {
      void this._handleXtPayNotify(req, res);
    });
    this.app.get('/api/pay/xtpay/gateway', (req, res) => {
      void this._handleXtPayGateway(req, res);
    });
    this.app.all('/api/pay/xtpay/return', (req, res) => {
      void this._handleXtPayReturn(req, res);
    });

    // Public user account API for browser-side registration and login.
    const userRouter = express.Router();
    userRouter.get('/policy', (_req, res) => this._handleUserPolicy(res));
    userRouter.get('/check-account', (req, res) => this._handleUserCheckAccount(req, res));
    userRouter.post('/register', (req, res) => this._handleUserRegister(req, res));
    userRouter.post('/login', (req, res) => this._handleUserLogin(req, res));
    this.app.use('/api/user', userRouter);

    // Internal API（分销系统等）。
    const internalRouter = express.Router();
    internalRouter.use((req, res, next) => this._authApiKey(req, res, next));

    // 玩家信息查询。
    internalRouter.get('/player/info/:userId', (req, res) => this._handlePlayerInfo(req, res));
    // 在线统计。
    internalRouter.get('/stats/online', (_req, res) => this._handleStatsOnline(res));
    // recharge statistics
    internalRouter.get('/stats/recharge', (req, res) => this._handleStatsRecharge(req, res));
    // recharge callback
    internalRouter.post('/recharge', (req, res) => this._handleRechargeCallback(req, res));
    // cross-server node register/heartbeat/route
    internalRouter.post('/cross/node/register', (req, res) => this._handleCrossNodeRegister(req, res));
    internalRouter.post('/cross/node/heartbeat', (req, res) => this._handleCrossNodeHeartbeat(req, res));
    internalRouter.post('/cross/route', (req, res) => this._handleCrossRoute(req, res));

    this.app.use('/api/internal', internalRouter);

    // ── Admin player management API (/api/admin/) ────────────────────────────
    const adminRouter = express.Router();

    // Public: login does not require session auth
    adminRouter.post('/auth/login', (req, res) => this._adminLogin(req, res));

    // All routes below require a valid admin session
    adminRouter.use((req, res, next) => this._authAdminSession(req, res, next));
    adminRouter.get('/auth/me', (req, res) => this._adminMe(req, res));
    adminRouter.post('/auth/logout', (req, res) => this._adminLogout(req, res));

    adminRouter.get('/agents', (req, res) => this._adminListAgents(req, res));
    adminRouter.post('/agents', (req, res) => this._adminCreateAgent(req, res));
    adminRouter.patch('/agents/:agentId', (req, res) => this._adminUpdateAgent(req, res));
    adminRouter.get('/recharge-configs', (req, res) => this._adminListRechargeConfigs(req, res));
    adminRouter.post('/recharge-configs', (req, res) => this._adminSaveRechargeConfig(req, res));
    adminRouter.patch('/recharge-configs/:productId', (req, res) => this._adminSaveRechargeConfig(req, res));
    adminRouter.delete('/recharge-configs/:productId', (req, res) => this._adminDeleteRechargeConfig(req, res));
    adminRouter.get('/redeem-codes', (req, res) => this._adminListRedeemCodes(req, res));
    adminRouter.post('/redeem-codes', (req, res) => this._adminSaveRedeemCode(req, res));
    adminRouter.patch('/redeem-codes/:code', (req, res) => this._adminSaveRedeemCode(req, res));
    adminRouter.delete('/redeem-codes/:code', (req, res) => this._adminDeleteRedeemCode(req, res));
    adminRouter.get('/mails', (req, res) => this._adminListMails(req, res));
    adminRouter.post('/mails/send', (req, res) => this._adminSendMail(req, res));
    adminRouter.get('/item-configs', (req, res) => this._adminListItemConfigs(req, res));
    adminRouter.post('/item-configs', (req, res) => this._adminSaveItemConfig(req, res));
    adminRouter.patch('/item-configs/:itemId', (req, res) => this._adminSaveItemConfig(req, res));
    adminRouter.delete('/item-configs/:itemId', (req, res) => this._adminDeleteItemConfig(req, res));
    adminRouter.get('/item-dictionaries', (req, res) => this._adminListItemDictionaries(req, res));
    adminRouter.post('/item-dictionaries', (req, res) => this._adminSaveItemDictionary(req, res));
    adminRouter.patch('/item-dictionaries/:itemId', (req, res) => this._adminSaveItemDictionary(req, res));
    adminRouter.delete('/item-dictionaries/:itemId', (req, res) => this._adminDeleteItemDictionary(req, res));
    adminRouter.get('/action-logs', (req, res) => this._adminListActionLogs(req, res));

    // POST /api/admin/players/batch-create
    adminRouter.post('/players/batch-create', (req, res) => this._adminBatchCreatePlayers(req, res));
    adminRouter.post('/players/clear-game-data', (req, res) => this._adminClearPlayerGameData(req, res));
    // GET /api/admin/players?page=1&limit=20&search=xxx
    adminRouter.get('/players', (req, res) => this._adminListPlayers(req, res));
    // GET /api/admin/players/:userId
    adminRouter.get('/players/:userId', (req, res) => this._adminGetPlayer(req, res));
    // PATCH /api/admin/players/:userId  — partial update (currencies, level, items, name…)
    adminRouter.patch('/players/:userId', (req, res) => this._adminUpdatePlayer(req, res));
    adminRouter.get('/activity-entries', (req, res) => this._adminListActivityEntries(req, res));
    adminRouter.post('/players/:userId/activity-entry', (req, res) => this._adminSetPlayerActivityEntry(req, res));
    adminRouter.post('/players/batch-give', (req, res) => this._adminBatchGivePlayers(req, res));
    adminRouter.post('/players/batch-unlock-all-systems', (req, res) => this._adminBatchUnlockAllSystems(req, res));
    adminRouter.post('/players/:userId/mute', (req, res) => this._adminMutePlayer(req, res));
    adminRouter.post('/players/:userId/unmute', (req, res) => this._adminUnmutePlayer(req, res));
    adminRouter.post('/players/:userId/ban-account', (req, res) => this._adminBanPlayerAccount(req, res));
    adminRouter.post('/players/:userId/unban-account', (req, res) => this._adminUnbanPlayerAccount(req, res));
    // POST /api/admin/players/:userId/give — give items/currency delta
    adminRouter.post('/players/:userId/give', (req, res) => this._adminGivePlayer(req, res));
    adminRouter.post('/players/:userId/recharge', (req, res) => this._adminRechargePlayer(req, res));
    adminRouter.post('/players/:userId/reset-password', (req, res) => this._adminResetPlayerPassword(req, res));
    adminRouter.post('/players/:userId/unlock-all-systems', (req, res) => this._adminUnlockAllSystems(req, res));
    adminRouter.post('/players/:userId/normalize-orb', (req, res) => this._adminNormalizePlayerOrb(req, res));
    adminRouter.post('/agents/:agentId/ban', (req, res) => this._adminBanAgent(req, res));
    adminRouter.post('/agents/:agentId/unban', (req, res) => this._adminUnbanAgent(req, res));
    // DELETE /api/admin/players/:userId
    adminRouter.delete('/players/:userId', (req, res) => this._adminDeletePlayer(req, res));
    // GET /api/admin/servers — server/zone stats
    adminRouter.get('/servers', (req, res) => this._adminGetServerStats(req, res));
    adminRouter.post('/servers', (req, res) => this._adminCreateServer(req, res));
    adminRouter.patch('/servers/:serverId', (req, res) => this._adminUpdateServer(req, res));
    adminRouter.delete('/servers/:serverId', (req, res) => this._adminDeleteServer(req, res));

    this.app.use('/api/admin', adminRouter);
    // ─────────────────────────────────────────────────────────────────────────

    // 客户端静态文件托管，包含 .bin 哈希重映射。
    this.app.use((req, res, next) => {
      // 只处理 GET/HEAD 请求。
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();

      const requestPath = decodeURIComponent(req.path || '');
      const relativeRequestPath = requestPath.replace(/^\/+/, '');
      let filePath = path.join(this.clientDir, relativeRequestPath);

      // 默认返回 index.html。
      if (req.path === '/' || req.path === '') {
        filePath = path.join(this.clientDir, this.defaultStaticPage);
      }

      // 优先发送直接存在的文件。
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return this._sendStaticFile(req, res, filePath);
      }

      // Generic hashed-file fallback: foo.jpg <-> foo_xxxxxxxx.jpg
      const hashedFile = this._resolveHashedFile(filePath);
      if (hashedFile && fs.existsSync(hashedFile)) {
        logger.debug(`[HTTPServer] static hash fallback ${req.path} -> ${path.basename(hashedFile)}`);
        return this._sendStaticFile(req, res, hashedFile);
      }

      // .bin 哈希不匹配时尝试同前缀文件。
      if (filePath.endsWith('.bin')) {
        const basename = path.basename(filePath);
        const prefix = basename.replace(/_[a-f0-9]+\.bin$/, '');
        if (this.binFileMap[prefix]) {
          const realFile = path.join(path.dirname(filePath), this.binFileMap[prefix]);
          if (fs.existsSync(realFile)) {
            logger.debug(`[HTTPServer] 资源重映射 ${basename} -> ${this.binFileMap[prefix]}`);
            return this._sendStaticFile(req, res, realFile);
          }
          const resourceFile = path.join(this.clientDir, 'update', 'resource', this.binFileMap[prefix]);
          if (fs.existsSync(resourceFile)) {
            logger.debug(`[HTTPServer] resource bin fallback ${basename} -> update/resource/${this.binFileMap[prefix]}`);
            return this._sendStaticFile(req, res, resourceFile);
          }
        }
      }

      if (req.path.startsWith('/update/resource/assets/map/')) {
        logger.warn(`[HTTPServer] missing map asset: ${req.path}`);
      }

      next();
    });
  }

  /**
   * API Key 认证中间件。
   */
  _authApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (key !== this.apiKey) {
      logger.warn(`[InternalAPI] unauthorized ${req.method} ${req.originalUrl || req.url}`);
      return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
    }
    const verification = verifyInternalRequest({
      secret: this.apiKey,
      method: req.method,
      path: req.originalUrl || req.url || '',
      timestamp: req.headers['x-timestamp'],
      nonce: req.headers['x-nonce'],
      signature: req.headers['x-signature'],
      body: req.body,
    });
    if (!verification.ok) {
      logger.warn(`[InternalAPI] signature reject ${req.method} ${req.originalUrl || req.url}: ${verification.error}`);
      return res.status(401).json({ success: false, error: verification.error });
    }
    const now = Date.now();
    const remoteKey = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const slot = Math.floor(now / INTERNAL_API_WINDOW_MS);
    const bucketKey = `${remoteKey}:${slot}`;
    const count = (this._internalApiHits.get(bucketKey) || 0) + 1;
    this._internalApiHits.set(bucketKey, count);
    if (count > INTERNAL_API_MAX_REQUESTS) {
      logger.warn(`[InternalAPI] rate limited ${req.method} ${req.originalUrl || req.url} from ${remoteKey}`);
      return res.status(429).json({ success: false, error: 'RATE_LIMITED' });
    }
    next();
  }

  /** 验证管理员 session token（Bearer 方案）。 */
  _authAdminSession(req, res, next) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
    const session = this._adminSessions.get(token);
    if (!session || Date.now() > toSafeInt(session.expiresAt, 0)) {
      this._adminSessions.delete(token);
      return res.status(401).json({ success: false, error: 'SESSION_EXPIRED' });
    }
    req.adminSession = session;
    next();
  }

  _cleanExpiredAdminSessions() {
    const now = Date.now();
    for (const [token, session] of this._adminSessions) {
      if (now > toSafeInt(session && session.expiresAt, 0)) this._adminSessions.delete(token);
    }
  }

  _buildSessionUser(session = {}) {
    const permissions = session.role === 'admin'
      ? buildFullPermissions()
      : sanitizeAgentPermissions(session.permissions);
    const limits = session.role === 'admin'
      ? buildFullLimits()
      : sanitizeAgentLimits(session.limits);
    return {
      role: session.role === 'agent' ? 'agent' : 'admin',
      username: normalizeText(session.username, 64),
      displayName: normalizeText(session.displayName || session.username, 64),
      agentId: normalizeText(session.agentId, 64),
      permissions,
      limits,
      isAdmin: session.role !== 'agent',
    };
  }

  _createSession(token, sessionData = {}) {
    const session = {
      role: sessionData.role === 'agent' ? 'agent' : 'admin',
      username: normalizeText(sessionData.username, 64),
      displayName: normalizeText(sessionData.displayName || sessionData.username, 64),
      agentId: normalizeText(sessionData.agentId, 64),
      permissions: sessionData.role === 'agent'
        ? sanitizeAgentPermissions(sessionData.permissions)
        : buildFullPermissions(),
      limits: sessionData.role === 'agent'
        ? sanitizeAgentLimits(sessionData.limits)
        : buildFullLimits(),
      expiresAt: toSafeInt(sessionData.expiresAt, 0),
    };
    this._adminSessions.set(token, session);
    return session;
  }

  _isSuperAdmin(req) {
    return !req.adminSession || req.adminSession.role !== 'agent';
  }

  _requireSuperAdmin(req, res) {
    if (this._isSuperAdmin(req)) return true;
    res.status(403).json({ success: false, error: 'FORBIDDEN' });
    return false;
  }

  _hasPermission(req, permissionKey) {
    if (this._isSuperAdmin(req)) return true;
    return !!sanitizeAgentPermissions(req.adminSession && req.adminSession.permissions)[permissionKey];
  }

  _getSessionLimits(req) {
    if (this._isSuperAdmin(req)) return buildFullLimits();
    return sanitizeAgentLimits(req.adminSession && req.adminSession.limits);
  }

  _validateGivePayloadByLimits(req, body = {}) {
    if (this._isSuperAdmin(req)) return { ok: true };
    const limits = this._getSessionLimits(req);
    const disallowedCurrencies = [];
    const disallowedItems = [];
    ['diamond', 'gold', 'silver'].forEach((key) => {
      if (body[key] == null) return;
      if (Number(body[key]) === 0) return;
      if (limits.giveCurrencyWhitelist.length > 0 && !limits.giveCurrencyWhitelist.includes(key)) {
        disallowedCurrencies.push(key);
      }
    });
    const items = ensurePlainObject(body.items);
    Object.keys(items).forEach((key) => {
      const itemId = Math.max(1, toSafeInt(key, 0));
      const value = Number(items[key] || 0);
      if (itemId <= 0 || value === 0) return;
      if (limits.giveItemWhitelist.length > 0 && !limits.giveItemWhitelist.includes(itemId)) {
        disallowedItems.push(itemId);
      }
    });
    if (disallowedCurrencies.length > 0) {
      return { ok: false, error: 'GIVE_CURRENCY_NOT_ALLOWED', details: disallowedCurrencies };
    }
    if (disallowedItems.length > 0) {
      return { ok: false, error: 'GIVE_ITEM_NOT_ALLOWED', details: disallowedItems };
    }
    return { ok: true };
  }

  async _validateRechargeAmountByLimits(req, amount) {
    if (this._isSuperAdmin(req)) return { ok: true };
    const limits = this._getSessionLimits(req);
    const safeAmount = Math.max(0, Number(amount || 0));
    if (!(safeAmount > 0)) return { ok: false, error: 'INVALID_RECHARGE_AMOUNT' };
    if (limits.rechargeSingleLimit > 0 && safeAmount > limits.rechargeSingleLimit) {
      return {
        ok: false,
        error: 'RECHARGE_SINGLE_LIMIT_EXCEEDED',
        limit: limits.rechargeSingleLimit,
      };
    }
    if (limits.rechargeDailyLimit > 0) {
      const Transaction = require('../db/models/Transaction');
      const now = new Date();
      const startAt = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const endAt = startAt + 24 * 3600 * 1000;
      const channel = `admin:agent:${normalizeText(req.adminSession && req.adminSession.username, 64)}`;
      const rows = await Transaction.find({
        status: 'success',
        channel,
        createdAt: { $gte: new Date(startAt), $lt: new Date(endAt) },
      }).select('amount').lean();
      const used = rows.reduce((sum, row) => sum + Math.max(0, Number(row && row.amount || 0)), 0);
      if (used + safeAmount > limits.rechargeDailyLimit) {
        return {
          ok: false,
          error: 'RECHARGE_DAILY_LIMIT_EXCEEDED',
          limit: limits.rechargeDailyLimit,
          used,
        };
      }
    }
    return { ok: true };
  }

  _requirePermission(req, res, permissionKey) {
    if (this._hasPermission(req, permissionKey)) return true;
    res.status(403).json({ success: false, error: 'FORBIDDEN' });
    return false;
  }

  _canAccessPlayer(req, player = {}) {
    if (this._isSuperAdmin(req)) return true;
    return normalizeText(player.agentId, 64) === normalizeText(req.adminSession && req.adminSession.agentId, 64);
  }

  _buildPlayerAccessFilter(req) {
    if (this._isSuperAdmin(req)) return {};
    return { agentId: normalizeText(req.adminSession && req.adminSession.agentId, 64) };
  }

  async _recordAdminActionLog(req, payload = {}) {
    try {
      const AdminActionLog = require('../db/models/AdminActionLog');
      const actor = this._buildSessionUser(req && req.adminSession ? req.adminSession : {});
      await AdminActionLog.create({
        operatorRole: actor.role,
        operatorUsername: actor.username || 'unknown',
        operatorAgentId: actor.agentId || '',
        action: normalizeText(payload.action, 64) || 'unknown',
        result: normalizeText(payload.result, 32) || 'unknown',
        targetUserId: normalizeText(payload.targetUserId, 64),
        targetPlayerName: normalizeText(payload.targetPlayerName, 64),
        targetAgentId: normalizeText(payload.targetAgentId, 64),
        reason: normalizeText(payload.reason, 128),
        detail: ensurePlainObject(payload.detail),
      });
    } catch (err) {
      logger.warn(`[Admin] action log failed: ${err.message}`);
    }
  }

  async _assertBatchPlayerAccess(req, userIds = []) {
    if (this._isSuperAdmin(req)) return true;
    const Player = require('../db/models/Player');
    const agentId = normalizeText(req.adminSession && req.adminSession.agentId, 64);
    const count = await Player.countDocuments({ userId: { $in: userIds }, agentId });
    return count === userIds.length;
  }

  /** POST /api/admin/auth/login — 用户名密码登录，返回 session token。 */
  async _adminLogin(req, res) {
    const AdminAgent = require('../db/models/AdminAgent');
    const username = normalizeText(req.body && req.body.username, 64);
    const password = String((req.body && req.body.password) || '');
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'INVALID_CREDENTIALS' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 8 * 3600 * 1000; // 8 hours

    if (this.portalType !== 'agent' && this.adminPassword && username === this.adminUsername && password === this.adminPassword) {
      const session = this._createSession(token, {
        role: 'admin',
        username: this.adminUsername,
        displayName: '管理员',
        expiresAt,
      });
      this._cleanExpiredAdminSessions();
      logger.info(`[Admin] login: ${username}`);
      return res.json({ success: true, token, expiresAt, user: this._buildSessionUser(session) });
    }

    const agent = await AdminAgent.findOne({ username: username.toLowerCase() });
    const verification = await verifyOperatorPassword(password, agent && agent.passwordHash);
    if (!agent || !verification.matched) {
      return res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS' });
    }
    if (agent.status !== 'active') {
      return res.status(403).json({ success: false, error: 'AGENT_DISABLED' });
    }

    if (verification.needsUpgrade) {
      agent.passwordHash = await hashOperatorPassword(password);
    }

    agent.lastLoginAt = Date.now();
    await agent.save();
    const session = this._createSession(token, {
      role: 'agent',
      username: agent.username,
      displayName: agent.name || agent.username,
      agentId: agent.agentId,
      permissions: agent.permissions,
      limits: agent.limits,
      expiresAt,
    });
    this._cleanExpiredAdminSessions();
    logger.info(`[Admin] agent login: ${agent.username} -> ${agent.agentId}`);
    return res.json({ success: true, token, expiresAt, user: this._buildSessionUser(session) });
  }

  async _adminMe(req, res) {
    return res.json({ success: true, user: this._buildSessionUser(req.adminSession) });
  }

  /** POST /api/admin/auth/logout — 注销当前 session。 */
  async _adminLogout(req, res) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (token) {
      this._adminSessions.delete(token);
      logger.info('[Admin] logout');
    }
    res.json({ success: true });
  }

  async _adminListAgents(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const AdminAgent = require('../db/models/AdminAgent');
      const keyword = normalizeText(req.query.keyword, 64).toLowerCase();
      const status = normalizeText(req.query.status, 32);
      const filter = {};
      if (status) filter.status = status;
      if (keyword) {
        filter.$or = [
          { username: { $regex: keyword, $options: 'i' } },
          { agentId: { $regex: keyword, $options: 'i' } },
          { name: { $regex: keyword, $options: 'i' } },
        ];
      }
      const items = await AdminAgent.find(filter)
        .select('agentId username name status permissions limits note createdBy updatedBy lastLoginAt createdAt updatedAt')
        .sort({ createdAt: -1, username: 1 })
        .lean();
      return res.json({ success: true, agents: items.map((item) => ({
        ...item,
        permissions: sanitizeAgentPermissions(item.permissions),
        limits: sanitizeAgentLimits(item.limits),
      })) });
    } catch (err) {
      logger.error(`[Admin] list agents: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminCreateAgent(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const AdminAgent = require('../db/models/AdminAgent');
      const body = ensurePlainObject(req.body);
      const username = normalizeText(body.username, 64).toLowerCase();
      const password = String(body.password || '');
      const agentId = normalizeText(body.agentId || username, 64);
      const name = normalizeText(body.name || username, 64);
      if (!username || !password || !agentId) {
        return res.status(400).json({ success: false, error: 'MISSING_REQUIRED_FIELDS' });
      }
      const created = await AdminAgent.create({
        username,
        passwordHash: await hashOperatorPassword(password),
        agentId,
        name,
        status: normalizeText(body.status, 32) === 'disabled' ? 'disabled' : 'active',
        permissions: sanitizeAgentPermissions(body.permissions),
        limits: sanitizeAgentLimits(body.limits),
        note: normalizeText(body.note, 200),
        createdBy: normalizeText(req.adminSession && req.adminSession.username, 64),
        updatedBy: normalizeText(req.adminSession && req.adminSession.username, 64),
      });
      return res.json({
        success: true,
        agent: {
          ...created.toObject(),
          passwordHash: undefined,
          permissions: sanitizeAgentPermissions(created.permissions),
          limits: sanitizeAgentLimits(created.limits),
        },
      });
    } catch (err) {
      logger.error(`[Admin] create agent: ${err.message}`);
      return res.status(500).json({ success: false, error: err.code === 11000 ? 'AGENT_DUPLICATE' : 'INTERNAL_ERROR' });
    }
  }

  async _adminUpdateAgent(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const AdminAgent = require('../db/models/AdminAgent');
      const body = ensurePlainObject(req.body);
      const agentId = normalizeText(req.params.agentId, 64);
      const agent = await AdminAgent.findOne({ agentId });
      if (!agent) return res.status(404).json({ success: false, error: 'AGENT_NOT_FOUND' });

      if (body.username != null) agent.username = normalizeText(body.username, 64).toLowerCase();
      if (body.name != null) agent.name = normalizeText(body.name, 64);
      if (body.status != null) agent.status = normalizeText(body.status, 32) === 'disabled' ? 'disabled' : 'active';
      if (body.note != null) agent.note = normalizeText(body.note, 200);
      if (body.permissions && typeof body.permissions === 'object') {
        agent.permissions = sanitizeAgentPermissions(body.permissions);
      }
      if (body.limits && typeof body.limits === 'object') {
        agent.limits = sanitizeAgentLimits(body.limits);
      }
      if (body.password != null) {
        const nextPassword = String(body.password || '');
        if (!nextPassword) return res.status(400).json({ success: false, error: 'INVALID_PASSWORD' });
        agent.passwordHash = await hashOperatorPassword(nextPassword);
      }
      agent.updatedBy = normalizeText(req.adminSession && req.adminSession.username, 64);
      await agent.save();
      return res.json({
        success: true,
        agent: {
          ...agent.toObject(),
          passwordHash: undefined,
          permissions: sanitizeAgentPermissions(agent.permissions),
          limits: sanitizeAgentLimits(agent.limits),
        },
      });
    } catch (err) {
      logger.error(`[Admin] update agent: ${err.message}`);
      return res.status(500).json({ success: false, error: err.code === 11000 ? 'AGENT_DUPLICATE' : 'INTERNAL_ERROR' });
    }
  }

  async _adminListRechargeConfigs(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const rechargeConfigService = require('../services/RechargeConfigService');
      const rows = await rechargeConfigService.listMergedRows();
      return res.json({ success: true, configs: rows });
    } catch (err) {
      logger.error(`[Admin] list recharge configs: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminSaveRechargeConfig(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const rechargeConfigService = require('../services/RechargeConfigService');
      const actor = normalizeText(req.adminSession && req.adminSession.username, 64);
      const body = ensurePlainObject(req.body);
      const payload = {
        ...body,
        productId: normalizeText(req.params.productId, 64) || normalizeText(body.productId, 64),
      };
      const config = await rechargeConfigService.saveRow(payload, actor);
      return res.json({ success: true, config });
    } catch (err) {
      logger.error(`[Admin] save recharge config: ${err.message}`);
      const status = err.status || 500;
      return res.status(status).json({ success: false, error: normalizeText(err.message, 64) || 'INTERNAL_ERROR' });
    }
  }

  async _adminDeleteRechargeConfig(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const rechargeConfigService = require('../services/RechargeConfigService');
      const deleted = await rechargeConfigService.deleteRow(req.params.productId);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'RECHARGE_CONFIG_NOT_FOUND' });
      }
      return res.json({ success: true, productId: normalizeText(req.params.productId, 64) });
    } catch (err) {
      logger.error(`[Admin] delete recharge config: ${err.message}`);
      const status = err.status || 500;
      return res.status(status).json({ success: false, error: normalizeText(err.message, 64) || 'INTERNAL_ERROR' });
    }
  }

  async _adminSendSystemMail(userId, title, content) {
    const Mail = require('../db/models/Mail');
    const safeUserId = normalizeText(userId, 64);
    if (!safeUserId) return null;
    return Mail.create({
      userId: safeUserId,
      title: normalizeText(title, 120),
      content: normalizeText(content, 1000),
      sender: '系统',
      attachments: [],
    });
  }

  _normalizeAdminMailAttachments(value) {
    const rows = Array.isArray(value)
      ? value
      : String(value || '')
        .split(/[\n;,，]+/)
        .map((part) => {
          const [id, count] = String(part || '').split(/[:：*xX\s]+/).filter(Boolean);
          return { id, count };
        });
    return rows
      .map((row) => ({ id: Math.max(0, toSafeInt(row && row.id, 0)), count: Math.max(0, toSafeInt(row && row.count, 0)) }))
      .filter((row) => row.id > 0 && row.count > 0)
      .filter((row, index, arr) => arr.findIndex((item) => item.id === row.id) === index)
      .map((row) => ({
        id: row.id,
        count: rows.reduce((sum, item) => (toSafeInt(item && item.id, 0) === row.id ? sum + Math.max(0, toSafeInt(item && item.count, 0)) : sum), 0),
      }));
  }

  _buildAdminMailPayload(body = {}) {
    const title = normalizeText(body.title, 120);
    const content = normalizeText(body.content || body.text, 2000);
    if (!title) {
      const err = new Error('MAIL_TITLE_REQUIRED');
      err.status = 400;
      throw err;
    }
    if (!content) {
      const err = new Error('MAIL_CONTENT_REQUIRED');
      err.status = 400;
      throw err;
    }
    const expireDays = Math.max(1, Math.min(365, toSafeInt(body.expireDays, 30)));
    return {
      title,
      content,
      sender: normalizeText(body.sender, 60) || '系统',
      attachments: this._normalizeAdminMailAttachments(body.attachments || body.attachmentText),
      minClaimLevel: Math.max(0, toSafeInt(body.minClaimLevel, 0)),
      expireAt: new Date(Date.now() + expireDays * 24 * 60 * 60 * 1000),
    };
  }

  _normalizeAdminMailUserIds(value) {
    const raw = Array.isArray(value) ? value : String(value || '').split(/[\n,，;；\s]+/);
    return raw
      .map((id) => normalizeText(id, 64))
      .filter((id, index, arr) => id && arr.indexOf(id) === index);
  }

  _pushAdminMailToPlayer(userId, mailDoc) {
    if (!this.wsServer || !userId || !mailDoc) return;
    try {
      const { toClientMail } = require('../handlers/mail');
      this.wsServer.pushToUser(userId, 1102, {
        result: 0,
        mailData: toClientMail(mailDoc.toObject ? mailDoc.toObject() : mailDoc),
      });
    } catch (err) {
      logger.warn(`[Admin] push mail failed userId=${userId}: ${err.message}`);
    }
  }

  async _adminResolveMailTargets(body = {}) {
    const Player = require('../db/models/Player');
    const scope = normalizeText(body.scope, 20) || 'users';
    if (scope === 'server') {
      const serverId = Math.max(0, toSafeInt(body.serverId, 0));
      if (serverId <= 0) {
        const err = new Error('SERVER_ID_REQUIRED');
        err.status = 400;
        throw err;
      }
      const rows = await Player.find({ serverId }, { userId: 1, name: 1, serverId: 1, _id: 0 }).lean();
      return { scope, serverId, players: rows || [] };
    }

    const userIds = this._normalizeAdminMailUserIds(body.userIds || body.userId || body.targets);
    if (userIds.length <= 0) {
      const err = new Error('MAIL_TARGET_REQUIRED');
      err.status = 400;
      throw err;
    }
    const rows = await Player.find({ userId: { $in: userIds } }, { userId: 1, name: 1, serverId: 1, _id: 0 }).lean();
    const found = new Set((rows || []).map((row) => normalizeText(row && row.userId, 64)));
    const missing = userIds.filter((userId) => !found.has(userId));
    if (missing.length > 0) {
      const err = new Error('MAIL_TARGET_NOT_FOUND');
      err.status = 404;
      err.missing = missing;
      throw err;
    }
    return { scope: 'users', serverId: 0, players: rows || [] };
  }

  async _adminListMails(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const Mail = require('../db/models/Mail');
      const limit = Math.max(1, Math.min(200, toSafeInt(req.query.limit, 50)));
      const filter = {};
      const userId = normalizeText(req.query.userId, 64);
      const batchId = normalizeText(req.query.batchId, 80);
      const serverId = Math.max(0, toSafeInt(req.query.serverId, 0));
      if (userId) filter.userId = userId;
      if (batchId) filter.batchId = batchId;
      if (serverId > 0) filter.targetServerId = serverId;
      const rows = await Mail.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
      const mails = (rows || []).map((row) => ({
        id: String(row._id || ''),
        userId: row.userId || '',
        title: row.title || '',
        content: row.content || row.text || '',
        sender: row.sender || '系统',
        attachments: Array.isArray(row.attachments) ? row.attachments : [],
        targetType: row.targetType || 'user',
        targetServerId: toSafeInt(row.targetServerId, 0),
        batchId: row.batchId || '',
        createdBy: row.createdBy || '',
        read: !!row.read,
        claimed: !!row.claimed,
        createdAt: row.createdAt ? new Date(row.createdAt).getTime() : 0,
        expireAt: row.expireAt ? new Date(row.expireAt).getTime() : 0,
      }));
      return res.json({ success: true, mails });
    } catch (err) {
      logger.error(`[Admin] list mails: ${err.message}`);
      return res.status(err.status || 500).json({ success: false, error: normalizeText(err.message, 64) || 'INTERNAL_ERROR' });
    }
  }

  async _adminSendMail(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const Mail = require('../db/models/Mail');
      const body = ensurePlainObject(req.body);
      const payload = this._buildAdminMailPayload(body);
      const target = await this._adminResolveMailTargets(body);
      if (target.players.length <= 0) {
        return res.status(404).json({ success: false, error: 'MAIL_TARGET_EMPTY' });
      }

      const batchId = `mail_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const actor = normalizeText(req.adminSession && req.adminSession.username, 64);
      const docs = target.players.map((player) => ({
        userId: normalizeText(player && player.userId, 64),
        title: payload.title,
        content: payload.content,
        text: payload.content,
        sender: payload.sender,
        attachments: payload.attachments,
        minClaimLevel: payload.minClaimLevel,
        expireAt: payload.expireAt,
        targetType: target.scope,
        targetServerId: target.serverId || Math.max(0, toSafeInt(player && player.serverId, 0)),
        batchId,
        createdBy: actor,
      })).filter((row) => row.userId);

      const created = [];
      for (let i = 0; i < docs.length; i += 1000) {
        const chunk = docs.slice(i, i + 1000);
        const chunkRows = await Mail.insertMany(chunk, { ordered: false });
        created.push(...(Array.isArray(chunkRows) ? chunkRows : []));
      }
      created.forEach((mailDoc) => this._pushAdminMailToPlayer(mailDoc.userId, mailDoc));

      await this._recordAdminActionLog(req, {
        action: target.scope === 'server' ? 'send_server_mail' : 'send_user_mail',
        result: 'success',
        reason: normalizeText(body.reason || body.note, 300) || '后台信件推送',
        detail: {
          scope: target.scope,
          serverId: target.serverId,
          batchId,
          total: created.length,
          title: payload.title,
          attachments: payload.attachments,
        },
      });

      return res.json({
        success: true,
        scope: target.scope,
        serverId: target.serverId,
        batchId,
        total: created.length,
      });
    } catch (err) {
      logger.error(`[Admin] send mail: ${err.message}`);
      return res.status(err.status || 500).json({
        success: false,
        error: normalizeText(err.message, 64) || 'INTERNAL_ERROR',
        missing: Array.isArray(err.missing) ? err.missing : undefined,
      });
    }
  }

  _buildAdminPunishReason(body = {}, fallback = '') {
    const reason = normalizeText(body.reason || body.note, 300);
    return reason || fallback || '后台管理操作';
  }

  async _adminMutePlayer(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const Player = require('../db/models/Player');
      const userId = normalizeText(req.params.userId, 64);
      const body = ensurePlainObject(req.body);
      const player = await Player.findOne({ userId });
      if (!player) return res.status(404).json({ success: false, error: 'PLAYER_NOT_FOUND' });

      const durationHours = Math.max(0, Number(body.durationHours || 0));
      const reason = this._buildAdminPunishReason(body, '违反聊天规则');
      const now = Date.now();
      const muteUntil = durationHours > 0 ? now + Math.floor(durationHours * 3600 * 1000) : 0;
      player.adminStatus = ensurePlainObject(player.adminStatus);
      player.adminStatus.muted = true;
      player.adminStatus.muteReason = reason;
      player.adminStatus.muteUntil = muteUntil;
      player.adminStatus.mutedAt = now;
      player.adminStatus.mutedBy = normalizeText(req.adminSession && req.adminSession.username, 64);
      player.markModified('adminStatus');
      await player.save();
      await this._adminSendSystemMail(
        userId,
        '聊天禁言通知',
        `你的账号已被禁言。原因：${reason}。${muteUntil > 0 ? `预计解禁时间：${new Date(muteUntil).toLocaleString('zh-CN')}。` : '禁言期限：永久。'}`
      );
      await this._recordAdminActionLog(req, {
        action: 'mute_player_chat',
        result: 'success',
        targetUserId: userId,
        targetPlayerName: player.name,
        targetAgentId: player.agentId,
        reason,
        detail: { muteUntil, durationHours },
      });
      const roleMap = await this._adminLoadAccountRoleMap([userId]);
      return res.json({ success: true, player: this._adminBuildPlayerDetail(player.toObject ? player.toObject() : player, roleMap.get(userId) || {}) });
    } catch (err) {
      logger.error(`[Admin] mute player: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminUnmutePlayer(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const Player = require('../db/models/Player');
      const userId = normalizeText(req.params.userId, 64);
      const body = ensurePlainObject(req.body);
      const reason = this._buildAdminPunishReason(body, '后台解除禁言');
      const player = await Player.findOne({ userId });
      if (!player) return res.status(404).json({ success: false, error: 'PLAYER_NOT_FOUND' });
      player.adminStatus = ensurePlainObject(player.adminStatus);
      player.adminStatus.muted = false;
      player.adminStatus.unmuteReason = reason;
      player.adminStatus.unmutedAt = Date.now();
      player.adminStatus.unmutedBy = normalizeText(req.adminSession && req.adminSession.username, 64);
      player.markModified('adminStatus');
      await player.save();
      await this._adminSendSystemMail(userId, '聊天解禁通知', `你的账号聊天禁言已解除。原因：${reason}。`);
      await this._recordAdminActionLog(req, {
        action: 'unmute_player_chat',
        result: 'success',
        targetUserId: userId,
        targetPlayerName: player.name,
        targetAgentId: player.agentId,
        reason,
      });
      const roleMap = await this._adminLoadAccountRoleMap([userId]);
      return res.json({ success: true, player: this._adminBuildPlayerDetail(player.toObject ? player.toObject() : player, roleMap.get(userId) || {}) });
    } catch (err) {
      logger.error(`[Admin] unmute player: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminSetPlayerAccountStatus(req, res, status, action) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const Player = require('../db/models/Player');
      const Account = require('../db/models/Account');
      const userId = normalizeText(req.params.userId, 64);
      const body = ensurePlainObject(req.body);
      const reason = this._buildAdminPunishReason(body, status > 0 ? '后台解除账号封禁' : '违反用户规则');
      const player = await Player.findOne({ userId });
      if (!player) return res.status(404).json({ success: false, error: 'PLAYER_NOT_FOUND' });
      const account = await Account.findOne({ 'roles.userId': userId });
      if (!account) return res.status(404).json({ success: false, error: 'ACCOUNT_NOT_FOUND' });
      account.status = status;
      await account.save();
      await this._adminSendSystemMail(
        userId,
        status > 0 ? '账号解封通知' : '账号封禁通知',
        status > 0 ? `你的账号封禁已解除。原因：${reason}。` : `你的账号已被封禁，封禁期间无法登录。原因：${reason}。`
      );
      await this._recordAdminActionLog(req, {
        action,
        result: 'success',
        targetUserId: userId,
        targetPlayerName: player.name,
        targetAgentId: player.agentId,
        reason,
        detail: { accountId: account.accountId, status },
      });
      const roleMap = await this._adminLoadAccountRoleMap([userId]);
      return res.json({ success: true, player: this._adminBuildPlayerDetail(player.toObject ? player.toObject() : player, roleMap.get(userId) || {}) });
    } catch (err) {
      logger.error(`[Admin] set player account status: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminBanPlayerAccount(req, res) {
    return this._adminSetPlayerAccountStatus(req, res, 0, 'ban_player_account');
  }

  async _adminUnbanPlayerAccount(req, res) {
    return this._adminSetPlayerAccountStatus(req, res, 1, 'unban_player_account');
  }

  async _adminSetAgentStatus(req, res, status, action) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const AdminAgent = require('../db/models/AdminAgent');
      const agentId = normalizeText(req.params.agentId, 64);
      const body = ensurePlainObject(req.body);
      const reason = this._buildAdminPunishReason(body, status === 'active' ? '后台解除代理封禁' : '后台封禁代理账号');
      const agent = await AdminAgent.findOne({ agentId });
      if (!agent) return res.status(404).json({ success: false, error: 'AGENT_NOT_FOUND' });
      agent.status = status;
      agent.note = normalizeText(body.note || agent.note || reason, 200);
      agent.updatedBy = normalizeText(req.adminSession && req.adminSession.username, 64);
      await agent.save();
      await this._recordAdminActionLog(req, {
        action,
        result: 'success',
        reason,
        detail: { agentId, username: agent.username, status },
      });
      return res.json({ success: true, agent: { ...agent.toObject(), passwordHash: undefined } });
    } catch (err) {
      logger.error(`[Admin] set agent status: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminBanAgent(req, res) {
    return this._adminSetAgentStatus(req, res, 'disabled', 'ban_agent_account');
  }

  async _adminUnbanAgent(req, res) {
    return this._adminSetAgentStatus(req, res, 'active', 'unban_agent_account');
  }

  _normalizeRedeemCodePayload(body = {}, routeCode = '') {
    const rewards = sanitizeGivePayload(body.rewards || body);
    if (!hasGivePayloadContent(rewards)) {
      const err = new Error('EMPTY_REWARDS');
      err.status = 400;
      throw err;
    }
    const code = normalizeRedemptionCode(routeCode || body.code);
    if (!code) {
      const err = new Error('CODE_REQUIRED');
      err.status = 400;
      throw err;
    }
    return {
      code,
      name: normalizeText(body.name, 64),
      status: normalizeText(body.status, 16) === 'disabled' ? 'disabled' : 'active',
      rewards,
      maxUses: Math.max(0, toSafeInt(body.maxUses, 0)),
      perUserLimit: Math.max(1, toSafeInt(body.perUserLimit, 1)),
      startsAt: parseAdminDate(body.startsAt),
      expiresAt: parseAdminDate(body.expiresAt),
      note: normalizeText(body.note, 300),
    };
  }

  _serializeRedeemCode(row) {
    const data = row && typeof row.toObject === 'function' ? row.toObject() : ensurePlainObject(row);
    const rewards = ensurePlainObject(data.rewards);
    const itemMap = rewards.items instanceof Map ? Object.fromEntries(rewards.items) : ensurePlainObject(rewards.items);
    return {
      ...data,
      rewards: sanitizeGivePayload({
        diamond: rewards.diamond,
        gold: rewards.gold,
        silver: rewards.silver,
        items: itemMap,
      }),
      remainingUses: Math.max(0, toSafeInt(data.maxUses, 0) - toSafeInt(data.usedCount, 0)) || (toSafeInt(data.maxUses, 0) > 0 ? 0 : -1),
    };
  }

  async _adminListRedeemCodes(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const RedemptionCode = require('../db/models/RedemptionCode');
      const keyword = normalizeText(req.query.keyword, 64);
      const status = normalizeText(req.query.status, 16);
      const query = {};
      if (keyword) {
        query.$or = [
          { code: { $regex: keyword, $options: 'i' } },
          { name: { $regex: keyword, $options: 'i' } },
          { note: { $regex: keyword, $options: 'i' } },
        ];
      }
      if (status === 'active' || status === 'disabled') query.status = status;
      const codes = await RedemptionCode.find(query).sort({ createdAt: -1 }).limit(300).lean();
      return res.json({ success: true, codes: codes.map((row) => this._serializeRedeemCode(row)) });
    } catch (err) {
      logger.error(`[Admin] list redeem codes: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminSaveRedeemCode(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const RedemptionCode = require('../db/models/RedemptionCode');
      const actor = normalizeText(req.adminSession && req.adminSession.username, 64);
      const payload = this._normalizeRedeemCodePayload(ensurePlainObject(req.body), req.params.code);
      const existing = await RedemptionCode.findOne({ code: payload.code });
      let row;
      if (existing) {
        existing.set({ ...payload, updatedBy: actor });
        row = await existing.save();
      } else {
        row = await RedemptionCode.create({ ...payload, createdBy: actor, updatedBy: actor });
      }
      await this._recordAdminActionLog(req, {
        action: existing ? 'update_redeem_code' : 'create_redeem_code',
        result: 'success',
        reason: 'OK',
        detail: { code: payload.code, rewards: payload.rewards },
      });
      return res.json({ success: true, code: this._serializeRedeemCode(row) });
    } catch (err) {
      logger.error(`[Admin] save redeem code: ${err.message}`);
      const status = err.status || (err.code === 11000 ? 409 : 500);
      return res.status(status).json({ success: false, error: normalizeText(err.message, 64) || 'INTERNAL_ERROR' });
    }
  }

  async _adminDeleteRedeemCode(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const RedemptionCode = require('../db/models/RedemptionCode');
      const code = normalizeRedemptionCode(req.params.code);
      const deleted = await RedemptionCode.findOneAndDelete({ code });
      if (!deleted) return res.status(404).json({ success: false, error: 'REDEEM_CODE_NOT_FOUND' });
      await this._recordAdminActionLog(req, {
        action: 'delete_redeem_code',
        result: 'success',
        reason: 'OK',
        detail: { code },
      });
      return res.json({ success: true, code });
    } catch (err) {
      logger.error(`[Admin] delete redeem code: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminListItemConfigs(req, res) {
    try {
      if (!this._requirePermission(req, res, 'giveItems')) return;
      const keyword = normalizeText(req.query.keyword, 64).toLowerCase();
      const page = Math.max(1, toSafeInt(req.query.page, 1));
      const limit = Math.min(200, Math.max(1, toSafeInt(req.query.limit, 50)));
      const map = loadAdminConfigMap();
      const limits = this._getSessionLimits(req);
      const itemWhitelist = Array.isArray(limits.giveItemWhitelist) ? limits.giveItemWhitelist : [];
      const rows = Object.keys(map)
        .map((key) => normalizeAdminItemConfigRow(key, map[key]))
        .filter((row) => row.itemId > 0)
        .filter((row) => itemWhitelist.length === 0 || itemWhitelist.includes(row.itemId))
        .filter((row) => {
          if (!keyword) return true;
          return String(row.itemId).includes(keyword) || String(row.cn || '').toLowerCase().includes(keyword);
        })
        .sort((a, b) => a.itemId - b.itemId);
      const total = rows.length;
      const paged = rows.slice((page - 1) * limit, page * limit);
      return res.json({
        success: true,
        total,
        page,
        limit,
        pages: total > 0 ? Math.ceil(total / limit) : 0,
        items: paged,
      });
    } catch (err) {
      logger.error(`[Admin] list item configs: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminListItemDictionaries(req, res) {
    try {
      if (!this._requirePermission(req, res, 'giveItems')) return;
      const ItemDictionary = require('../db/models/ItemDictionary');
      const keyword = normalizeText(req.query.keyword, 64);
      const page = Math.max(1, toSafeInt(req.query.page, 1));
      const limit = Math.min(200, Math.max(1, toSafeInt(req.query.limit, 60)));
      const type = toSafeInt(req.query.type, 0);
      const quality = toSafeInt(req.query.quality, -1);
      const filter = {};
      if (type > 0) filter.type = type;
      if (quality >= 0) filter.quality = quality;
      if (keyword) {
        const keywordRegex = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const idKeyword = toSafeInt(keyword, 0);
        filter.$or = [
          { name: keywordRegex },
          { desc: keywordRegex },
          { typeName: keywordRegex },
          { sourceTable: keywordRegex },
        ];
        if (idKeyword > 0) filter.$or.push({ itemId: idKeyword });
      }

      const limits = this._getSessionLimits(req);
      const itemWhitelist = Array.isArray(limits.giveItemWhitelist) ? limits.giveItemWhitelist : [];
      if (itemWhitelist.length > 0) filter.itemId = { $in: itemWhitelist };

      const total = await ItemDictionary.countDocuments(filter);
      const docs = await ItemDictionary.find(filter)
        .sort({ itemId: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();
      return res.json({
        success: true,
        total,
        page,
        limit,
        pages: total > 0 ? Math.ceil(total / limit) : 0,
        items: docs.map(normalizeAdminItemDictionaryRow),
      });
    } catch (err) {
      logger.error(`[Admin] list item dictionaries: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminSaveItemDictionary(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const ItemDictionary = require('../db/models/ItemDictionary');
      const body = ensurePlainObject(req.body);
      const itemId = Math.max(1, toSafeInt(req.params.itemId, toSafeInt(body.itemId, 0)));
      if (itemId <= 0) return res.status(400).json({ success: false, error: 'INVALID_ITEM_ID' });
      const row = normalizeAdminItemDictionaryRow({ ...body, itemId });
      if (!row.name) return res.status(400).json({ success: false, error: 'INVALID_ITEM_NAME' });
      const updated = await ItemDictionary.findOneAndUpdate(
        { itemId },
        { $set: row },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      await this._recordAdminActionLog(req, {
        action: 'save_item_dictionary',
        result: 'success',
        reason: 'OK',
        detail: { itemId, name: row.name },
      });
      return res.json({ success: true, item: normalizeAdminItemDictionaryRow(updated) });
    } catch (err) {
      logger.error(`[Admin] save item dictionary: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminDeleteItemDictionary(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const ItemDictionary = require('../db/models/ItemDictionary');
      const itemId = Math.max(1, toSafeInt(req.params.itemId, 0));
      if (itemId <= 0) return res.status(400).json({ success: false, error: 'INVALID_ITEM_ID' });
      const deleted = await ItemDictionary.findOneAndDelete({ itemId });
      if (!deleted) return res.status(404).json({ success: false, error: 'ITEM_DICTIONARY_NOT_FOUND' });
      await this._recordAdminActionLog(req, {
        action: 'delete_item_dictionary',
        result: 'success',
        reason: 'OK',
        detail: { itemId },
      });
      return res.json({ success: true, itemId });
    } catch (err) {
      logger.error(`[Admin] delete item dictionary: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminSaveItemConfig(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const body = ensurePlainObject(req.body);
      const itemId = Math.max(1, toSafeInt(req.params.itemId, toSafeInt(body.itemId, 0)));
      const cn = normalizeText(body.cn || body.name, 120);
      if (itemId <= 0) {
        return res.status(400).json({ success: false, error: 'INVALID_ITEM_ID' });
      }
      if (!cn) {
        return res.status(400).json({ success: false, error: 'INVALID_ITEM_NAME' });
      }
      const nextMap = { ...loadAdminConfigMap() };
      nextMap[String(itemId)] = {
        ...ensurePlainObject(nextMap[String(itemId)]),
        cn,
      };
      saveAdminConfigMap(nextMap);
      return res.json({ success: true, item: normalizeAdminItemConfigRow(itemId, nextMap[String(itemId)]) });
    } catch (err) {
      logger.error(`[Admin] save item config: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminDeleteItemConfig(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const itemId = Math.max(1, toSafeInt(req.params.itemId, 0));
      if (itemId <= 0) {
        return res.status(400).json({ success: false, error: 'INVALID_ITEM_ID' });
      }
      const nextMap = { ...loadAdminConfigMap() };
      if (!Object.prototype.hasOwnProperty.call(nextMap, String(itemId))) {
        return res.status(404).json({ success: false, error: 'ITEM_CONFIG_NOT_FOUND' });
      }
      delete nextMap[String(itemId)];
      saveAdminConfigMap(nextMap);
      return res.json({ success: true, itemId });
    } catch (err) {
      logger.error(`[Admin] delete item config: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminListActionLogs(req, res) {
    try {
      const AdminActionLog = require('../db/models/AdminActionLog');
      const page = Math.max(1, toSafeInt(req.query.page, 1));
      const limit = Math.min(100, Math.max(1, toSafeInt(req.query.limit, 20)));
      const action = normalizeText(req.query.action, 64);
      const result = normalizeText(req.query.result, 32);
      const keyword = normalizeText(req.query.keyword, 64);
      const filter = {};
      if (!this._isSuperAdmin(req)) {
        filter.operatorAgentId = normalizeText(req.adminSession && req.adminSession.agentId, 64);
      }
      if (action) filter.action = action;
      if (result) filter.result = result;
      if (keyword) {
        filter.$or = [
          { operatorUsername: { $regex: keyword, $options: 'i' } },
          { targetUserId: { $regex: keyword, $options: 'i' } },
          { targetPlayerName: { $regex: keyword, $options: 'i' } },
          { targetAgentId: { $regex: keyword, $options: 'i' } },
          { reason: { $regex: keyword, $options: 'i' } },
        ];
      }
      const [total, rows] = await Promise.all([
        AdminActionLog.countDocuments(filter),
        AdminActionLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ]);
      return res.json({
        success: true,
        total,
        page,
        limit,
        pages: total > 0 ? Math.ceil(total / limit) : 0,
        logs: rows,
      });
    } catch (err) {
      logger.error(`[Admin] list action logs: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  /**
   * 处理游戏客户端 POST 请求（BinJson 二进制协议）。
   */
  async _handleGameMsg(req, res) {
    const startedAt = Date.now();
    let protocolId = 0;
    try {
      const body = req.body;
      if (!body || body.length < 8) {
        return res.status(400).end();
      }

      const unpacked = PacketManager.unpackHttpRequest(body);
      protocolId = unpacked.protocolId;
      const { params } = unpacked;
      logger.info(`[HTTP] POST gameMsg.do cmd=${protocolId}`);

      if (this._shouldProxyGameMsg(protocolId)) {
        try {
          const proxied = await this._proxyGameMsgToReal(req, body, protocolId);
          res.status(proxied.status || 200);
          res.set('Content-Type', 'application/octet-stream');
          return res.send(proxied.body);
        } catch (proxyErr) {
          logger.error(`[HTTP] proxy real cmd=${protocolId} failed: ${proxyErr.message}`);
          if (!this.realHttpProxyFailOpen) {
            const errResp = PacketManager.packHttpResponse({ ret: -1, serverTime: Date.now(), errInfo: 'upstream proxy failed' });
            res.set('Content-Type', 'application/octet-stream');
            return res.status(502).send(errResp);
          }
          logger.warn(`[HTTP] cmd=${protocolId} proxy failed, fallback to local handler`);
        }
      }

      // 路由到对应的 HTTP handler。
      const handler = this.httpHandlers && this.httpHandlers[protocolId];
      let responseData;

      if (handler) {
        let timedOut = false;
        let timeoutId = null;
        responseData = await Promise.race([
          Promise.resolve(handler(params, req)),
          new Promise((resolve) => {
            timeoutId = setTimeout(() => {
              timedOut = true;
              resolve({ ret: -1, serverTime: Date.now(), errInfo: 'request timeout' });
            }, this.gameMsgHandlerTimeoutMs);
          }),
        ]);
        if (timeoutId) clearTimeout(timeoutId);
        if (timedOut) {
          logger.warn(`[HTTP] gameMsg.do cmd=${protocolId} handler timeout after ${this.gameMsgHandlerTimeoutMs}ms`);
        }
      } else {
        logger.warn(`[HTTP] 未知 cmdId=${protocolId}`);
        responseData = {
          ret: -1,
          serverTime: Date.now(),
          errInfo: 'cmd_not_implemented',
          cmdId: protocolId,
        };
      }

      const compressed = PacketManager.packHttpResponse(responseData);
      res.set('Content-Type', 'application/octet-stream');
      res.send(compressed);
      const elapsed = Date.now() - startedAt;
      if (elapsed >= this.gameMsgSlowLogMs) {
        logger.warn(`[HTTP] gameMsg.do cmd=${protocolId} slow ${elapsed}ms`);
      }
    } catch (err) {
      logger.error(`[HTTP] gameMsg.do cmd=${protocolId || 'unknown'} 处理失败: ${err.message}`);
      const errResp = PacketManager.packHttpResponse({ ret: -1, serverTime: Date.now() });
      res.set('Content-Type', 'application/octet-stream');
      res.send(errResp);
    }
  }

  /**
   * 处理游戏客户端 GET 请求，返回服务器信息。
   */
  _handleGameMsgGet(res) {
    res.json({
      result: 0,
      serverTime: Date.now(),
      notice: '',
      maintenance: false,
      version: '1.0.0',
    });
  }

  /**
   * 查询玩家信息（internal API）。
   * GET /api/internal/player/info/:userId
   */
  async _handlePlayerInfo(req, res) {
    try {
      const Player = require('../db/models/Player');
      const player = await Player.findOne({ userId: req.params.userId });
      if (!player) {
        return res.status(404).json({ success: false, error: 'PLAYER_NOT_FOUND' });
      }
      res.json({
        userId: player.userId,
        playerId: player.playerId,
        name: player.name,
        level: player.level,
        vipLevel: player.rechargeInfo?.vipLevel || 0,
        agentId: player.agentId,
        registerTime: player.createTime,
        lastLoginTime: player.updatedAt ? player.updatedAt.getTime() : 0,
        status: 'active',
      });
    } catch (err) {
      logger.error(`[HTTP] 查询玩家信息失败: ${err.message}`);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  /**
   * 在线统计（internal API）。
   * GET /api/internal/stats/online
   */
  async _handleStatsOnline(res) {
    try {
      const Session = require('./Session');
      const count = await Session.getOnlineCount();
      res.json({ onlineCount: count, timestamp: Math.floor(Date.now() / 1000) });
    } catch (err) {
      logger.error(`[HTTP] 在线统计失败: ${err.message}`);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  /**
   * 充值统计（internal API）。
   * GET /api/internal/stats/recharge?startTime=xxx&endTime=xxx&agentId=xxx
   */
  async _handleStatsRecharge(req, res) {
    try {
      const Transaction = require('../db/models/Transaction');
      const { startTime, endTime, agentId } = req.query;

      const query = { status: 'success' };
      if (startTime || endTime) {
        query.createdAt = {};
        if (startTime) query.createdAt.$gte = new Date(parseInt(startTime, 10) * 1000);
        if (endTime) query.createdAt.$lte = new Date(parseInt(endTime, 10) * 1000);
      }
      if (agentId) query.agentId = agentId;

      const result = await Transaction.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: '$amount' },
            totalOrders: { $sum: 1 },
          },
        },
      ]);

      const stats = result[0] || { totalAmount: 0, totalOrders: 0 };
      res.json({
        totalAmount: stats.totalAmount,
        totalOrders: stats.totalOrders,
        period: {
          start: startTime ? parseInt(startTime, 10) : 0,
          end: endTime ? parseInt(endTime, 10) : Math.floor(Date.now() / 1000),
        },
      });
    } catch (err) {
      logger.error(`[HTTP] 充值统计失败: ${err.message}`);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  /**
   * 充值回调（internal API）。
   * POST /api/internal/recharge
   */
  async _handleRechargeCallback(req, res) {
    try {
      const recharge = require('../handlers/recharge');
      const result = await recharge.handleRecharge(req.body, this.wsServer);
      if (result.success) {
        res.json(result);
      } else {
        const status = result.error === 'PLAYER_NOT_FOUND' ? 404 : 400;
        res.status(status).json(result);
      }
    } catch (err) {
      logger.error(`[HTTP] 充值回调失败: ${err.message}`);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _handleXtPayCreate(req, res) {
    try {
      const xtpay = require('../services/XtPayService');
      const result = await xtpay.createPaymentOrder(req.body || {}, req);
      if (result.success) return res.json(result);
      const status = result.error === 'PLAYER_NOT_FOUND' ? 404 : 400;
      return res.status(status).json(result);
    } catch (err) {
      logger.error(`[HTTP] xtpay create failed: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _handleXtPayNotify(req, res) {
    try {
      const xtpay = require('../services/XtPayService');
      const result = await xtpay.handleNotify({ ...(req.query || {}), ...(req.body || {}) }, this.wsServer);
      if (result.success) return res.type('text/plain').send('success');
      logger.warn(`[HTTP] xtpay notify rejected: ${result.error || 'UNKNOWN'}`);
      return res.status(400).type('text/plain').send('fail');
    } catch (err) {
      logger.error(`[HTTP] xtpay notify failed: ${err.message}`);
      return res.status(500).type('text/plain').send('fail');
    }
  }

  async _handleXtPayGateway(req, res) {
    try {
      const xtpay = require('../services/XtPayService');
      const html = await xtpay.buildGatewayForm(req.query && req.query.orderId);
      if (!html) return res.status(404).type('text/html').send('支付订单不存在或已过期');
      return res.type('text/html').send(html);
    } catch (err) {
      logger.error(`[HTTP] xtpay gateway failed: ${err.message}`);
      return res.status(500).type('text/html').send('支付跳转失败');
    }
  }

  async _handleXtPayReturn(req, res) {
    try {
      const xtpay = require('../services/XtPayService');
      const params = { ...(req.query || {}), ...(req.body || {}) };
      const hasSign = Boolean(params.sign);
      const ok = hasSign ? xtpay.verifySign(params, process.env.XTPAY_KEY || '') : false;
      if (hasSign && !ok) {
        logger.warn(`[HTTP] xtpay return sign mismatch: orderId=${params.out_trade_no || ''} keys=${Object.keys(params).join(',')}`);
      }
      // Return URL is only a user-facing landing page; the async notify endpoint is authoritative for delivery.
      return res.type('text/html').send('支付结果已提交，请返回游戏查看到账结果');
    } catch (err) {
      logger.error(`[HTTP] xtpay return failed: ${err.message}`);
      return res.status(500).type('text/html').send('支付结果处理失败');
    }
  }

  _handleUserPolicy(res) {
    return res.json({
      success: true,
      data: {
        account: {
          minLength: 4,
          maxLength: 20,
          pattern: '^[a-zA-Z][a-zA-Z0-9_]{3,19}$',
          message: '账号需为4-20位字母、数字或下划线，且必须以字母开头',
        },
        password: {
          minLength: 8,
          maxLength: 32,
          requireLetter: true,
          requireDigit: true,
          message: '密码需为8-32位，且同时包含字母和数字',
        },
        clientValidationEnabled: String(process.env.USER_CLIENT_VALIDATION_ENABLED || '0') === '1',
      },
    });
  }

  async _handleUserCheckAccount(req, res) {
    const accountId = normalizeText((req.query && (req.query.accountId || req.query.username)) || '', 64);
    const validation = accountService.validateAccountId(accountId);
    if (!validation.ok) {
      return res.status(400).json({ success: false, code: validation.code, message: validation.message });
    }

    const existing = await accountService.findAccount(validation.accountId);
    return res.json({
      success: true,
      data: {
        accountId: validation.accountId,
        available: !existing,
      },
    });
  }

  async _handleUserRegister(req, res) {
    const body = req.body || {};
    const accountId = normalizeText(body.accountId || body.username || body.uid, 64);
    const password = String(body.password || body.strPassword || '');
    const confirmPassword = String(body.confirmPassword || body.passwordConfirm || body.rePassword || password);
    const inviteCode = normalizeText(body.inviteCode || body.invite || body.code || '', 16);

    if (String(process.env.REQUIRE_INVITE_REGISTER || '1') === '1' && !inviteCode) {
      return res.status(400).json({
        success: false,
        code: 'INVITE_CODE_REQUIRED',
        registerUrl: getRegisterUrl(req),
        message: '请通过代理邀请链接注册',
      });
    }

    try {
      const account = await accountService.createRegisteredAccount(
        accountId,
        password,
        confirmPassword,
        inviteCode ? { inviteCode } : {}
      );
      const serverId = toSafeInt(body.serverId, toSafeInt(process.env.DEFAULT_SERVER_ID, 1001) || 1001);
      const roleName = normalizeText(body.roleName || body.name || accountId, 32) || accountId;
      const role = await accountService.createRole(account.accountId, {
        password,
        serverId,
        roleName,
      });
      return res.status(201).json({
        success: true,
        message: '注册成功',
        data: {
          accountId: account.accountId,
          inviteCode: account.inviteCode || '',
          role,
          roles: role ? [role] : [],
          needCreateRole: false,
        },
      });
    } catch (err) {
      const code = String((err && (err.code || err.message)) || 'REGISTER_FAILED');
      const isExists = code === 'ACCOUNT_EXISTS';
      return res.status(isExists ? 409 : 400).json({
        success: false,
        code,
        message: isExists ? '账号已存在' : (err.message || '注册失败'),
      });
    }
  }

  async _handleUserLogin(req, res) {
    const body = req.body || {};
    const accountId = normalizeText(body.accountId || body.username || body.uid, 64);
    const password = String(body.password || body.strPassword || body.token || '');
    const serverId = toSafeInt(body.serverId, toSafeInt(process.env.DEFAULT_SERVER_ID, 1001) || 1001);

    const account = await accountService.authAccount(accountId, password);
    if (!account) {
      return res.status(401).json({ success: false, code: 'AUTH_FAILED', message: '账号或密码错误' });
    }

    const accountObj = account.toObject ? account.toObject() : account;
    let roles = Array.isArray(accountObj.roles) ? accountObj.roles : [];
    let selectedRole = accountService.pickRole(accountObj, {
      serverId,
      roleId: body.roleId,
      roleIndex: body.roleIndex,
      sameServerOnly: true,
    });

    if (!selectedRole) {
      const created = await accountService.createRole(accountObj.accountId, {
        password,
        serverId,
        name: normalizeText(body.roleName || body.name || accountObj.accountId, 32) || accountObj.accountId,
        reuseExisting: false,
        deferRoleSelection: true,
      });
      roles = Array.isArray(created && created.roles) ? created.roles : roles;
      selectedRole = created && created.role ? created.role : null;
    }

    let userToken = '';
    if (selectedRole) {
      const tokenPack = await authSessionService.create({
        accountId: accountObj.accountId,
        roleId: selectedRole.roleId,
        userId: selectedRole.userId,
        serverId,
        serverName: selectedRole.serverName || '',
        serverSwitched: false,
        loginTime: Date.now(),
      });
      await accountService.markRoleLogin(accountObj.accountId, selectedRole.roleId, serverId);
      userToken = tokenPack.token;
    }

    return res.json({
      success: true,
      message: '登录成功',
      data: {
        accountId: accountObj.accountId,
        userToken,
        activeRoleId: selectedRole ? selectedRole.roleId : '',
        roles: roles.map((role, index) => ({
          roleId: String(role.roleId || ''),
          userId: String(role.userId || ''),
          serverId: Number(role.serverId) || serverId,
          name: String(role.name || ''),
          createTime: Number(role.createTime) || 0,
          lastLoginTime: Number(role.lastLoginTime) || 0,
          roleIndex: index,
        })),
        needCreateRole: selectedRole ? 0 : 1,
      },
    });
  }

  /**
   * 注册跨服节点（internal API）。
   * POST /api/internal/cross/node/register
   */
  async _handleCrossNodeRegister(req, res) {
    try {
      const nodeRegistry = require('../services/NodeRegistryService');
      const node = await nodeRegistry.registerNode(req.body || {});
      res.json({ success: true, node });
    } catch (err) {
      logger.error(`[HTTP] cross node register failed: ${err.message}`);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  /**
   * 更新跨服节点心跳（internal API）。
   * POST /api/internal/cross/node/heartbeat
   */
  async _handleCrossNodeHeartbeat(req, res) {
    try {
      const nodeRegistry = require('../services/NodeRegistryService');
      const nodeId = req.body && req.body.nodeId;
      const node = await nodeRegistry.heartbeat(nodeId);
      if (!node) {
        return res.status(404).json({ success: false, error: 'NODE_NOT_FOUND' });
      }
      res.json({ success: true, node });
    } catch (err) {
      logger.error(`[HTTP] cross node heartbeat failed: ${err.message}`);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  /**
   * 发布跨服路由事件（internal API）。
   * POST /api/internal/cross/route
   */
  async _handleCrossRoute(req, res) {
    try {
      const crossBus = require('../services/CrossBus');
      const eventType = (req.body && req.body.eventType) || 'cross.route';
      const payload = (req.body && req.body.payload) || {};
      await crossBus.publish(eventType, payload);
      res.json({ success: true });
    } catch (err) {
      logger.error(`[HTTP] cross route failed: ${err.message}`);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  /**
   * 注册游戏客户端 BinJson HTTP handler。
   * @param {Object} map - { cmdId: handler(params) => responseData }
   */
  registerHttpHandlers(map) {
    this.httpHandlers = { ...this.httpHandlers, ...map };
  }

  /** Inject WSServer instance so admin handlers can push live updates. */
  setWsServer(ws) {
    this.wsServer = ws;
  }

  /** Push an item-sync packet (tag 1202) to an online player's WS session. */
  _pushItemSyncToPlayer(userId, player, changedItemIds, syncOptions) {
    if (!this.wsServer || !userId || !player) return;
    try {
      const { syncCurrencyItems } = require('../services/CurrencySync');
      const livePlayer = this.wsServer.syncSessionPlayer(userId, player, syncOptions) || player;
      syncCurrencyItems(livePlayer);
      this.wsServer.pushToUser(userId, 1202, buildItemSyncPayload(livePlayer, changedItemIds));
      logger.info(`[Admin] pushed item sync to ${userId}`);
    } catch (err) {
      logger.warn(`[Admin] push failed: ${err.message}`);
    }
  }

  _pushPlayerPayloadToPlayer(userId, player, syncOptions) {
    if (!this.wsServer || !userId || !player) return;
    try {
      const { buildPlayer500Data } = require('../handlers/playerPayload');
      const livePlayer = this.wsServer.syncSessionPlayer(userId, player, syncOptions) || player;
      this.wsServer.pushToUser(userId, 500, buildPlayer500Data(livePlayer));
      logger.info(`[Admin] pushed player payload to ${userId}`);
    } catch (err) {
      logger.warn(`[Admin] push payload failed: ${err.message}`);
    }
  }

  _pushActivityPayloadToPlayer(userId, player) {
    if (!this.wsServer || !userId || !player) return;
    try {
      const { ensureActivityInfo, buildActivityPayload } = require('../handlers/activity');
      this.wsServer.pushToUser(userId, 1700, buildActivityPayload(ensureActivityInfo(player)));
      this.wsServer.syncSessionPlayer(userId, player);
      logger.info(`[Admin] pushed activity payload to ${userId}`);
    } catch (err) {
      logger.warn(`[Admin] push activity payload failed: ${err.message}`);
    }
  }

  _pushAdminPlayerSync(userId, player, changedItemIds, syncOptions) {
    this._pushItemSyncToPlayer(userId, player, changedItemIds, syncOptions);
    this._pushPlayerPayloadToPlayer(userId, player, syncOptions);
  }

  async _adminFindAccountMatchedUserIds(search = '') {
    const keyword = normalizeText(search);
    if (!keyword) return [];

    const Account = require('../db/models/Account');
    const accountRows = await Account.find(
      {
        $or: [
          { accountId: { $regex: keyword, $options: 'i' } },
          { 'roles.roleId': { $regex: keyword, $options: 'i' } },
        ],
      },
      { accountId: 1, roles: 1, _id: 0 }
    ).lean();

    const userIds = new Set();
    accountRows.forEach((accountRow) => {
      const roles = Array.isArray(accountRow && accountRow.roles) ? accountRow.roles : [];
      roles.forEach((role) => {
        const userId = normalizeText(role && role.userId);
        if (userId) userIds.add(userId);
      });
    });

    return Array.from(userIds);
  }

  async _adminLoadAccountRoleMap(userIds = []) {
    const normalizedIds = Array.from(new Set(
      (Array.isArray(userIds) ? userIds : [])
        .map((userId) => normalizeText(userId))
        .filter(Boolean)
    ));
    if (normalizedIds.length <= 0) return new Map();

    const Account = require('../db/models/Account');
    const accounts = await Account.find(
      { 'roles.userId': { $in: normalizedIds } },
      { accountId: 1, status: 1, roles: 1, activeRoleByServer: 1, _id: 0 }
    ).lean();

    const map = new Map();
    accounts.forEach((accountRow) => {
      const roles = Array.isArray(accountRow && accountRow.roles) ? accountRow.roles : [];
      const activeRoleByServer = ensurePlainObject(accountRow && accountRow.activeRoleByServer);
      roles.forEach((role) => {
        const userId = normalizeText(role && role.userId);
        if (!userId || map.has(userId)) return;
        const serverId = toSafeInt(role && role.serverId, 0);
        map.set(userId, {
          accountId: normalizeText(accountRow && accountRow.accountId),
          accountStatus: toSafeInt(accountRow && accountRow.status, 1),
          roleId: normalizeText(role && role.roleId),
          serverId,
          lastLoginTime: toSafeInt(role && role.lastLoginTime, 0),
          activeRoleId: normalizeText(activeRoleByServer[String(serverId)]),
        });
      });
    });

    return map;
  }

  _adminResolveText(value) {
    return resolveAdminText(value, loadAdminLanguageConfig());
  }

  _adminBuildActivityEntryCatalog() {
    const activityCfg = ensurePlainObject(configService.get('ActivityConfig'));
    return Object.keys(activityCfg)
      .map((idKey) => {
        const id = Math.max(0, toSafeInt(idKey, 0));
        const row = ensurePlainObject(activityCfg[idKey]);
        const name = this._adminResolveText(row.name) || this._adminResolveText(row.title) || `活动#${id}`;
        return {
          id,
          name,
          activityType: Math.max(0, toSafeInt(row.activityType, 0)),
          module: Math.max(0, toSafeInt(row.module, 0)),
          index: Math.max(0, toSafeInt(row.index, 0)),
          status: Math.max(0, toSafeInt(row.status, 0)),
        };
      })
      .filter((row) => row.id > 0)
      .sort((a, b) => a.id - b.id);
  }

  _adminBuildActivityEntryInfo(player = {}) {
    try {
      const { ensureActivityInfo } = require('../handlers/activity');
      ensureActivityInfo(player);
    } catch (_err) {
      // Keep the admin page readable even if activity bootstrap is unavailable.
    }
    const info = ensurePlainObject(player.activityInfo);
    const disabledIds = new Set(
      Array.isArray(info.disabledEntryIds)
        ? info.disabledEntryIds.map((id) => Math.max(0, toSafeInt(id, 0))).filter((id) => id > 0)
        : []
    );
    const activeIds = new Set(
      Array.isArray(info.datas)
        ? info.datas.map((row) => Math.max(0, toSafeInt(row && row.id, 0))).filter((id) => id > 0)
        : []
    );
    const entries = this._adminBuildActivityEntryCatalog().map((row) => ({
      ...row,
      enabled: !disabledIds.has(row.id) && activeIds.has(row.id),
      disabled: disabledIds.has(row.id),
    }));
    return {
      disabledEntryIds: Array.from(disabledIds).sort((a, b) => a - b),
      activeEntryIds: Array.from(activeIds).sort((a, b) => a - b),
      entries,
    };
  }

  _adminBuildAttrRows(player = {}) {
    const attrCfgMap = configService.get('AttrConfig') || {};
    const attrs = ensurePlainObject(battleService.calcPlayerPower(player));

    return Object.keys(attrs)
      .map((attrIdKey) => {
        const attrId = toSafeInt(attrIdKey, 0);
        const attrCfg = attrCfgMap[attrId] || attrCfgMap[String(attrId)] || {};
        return {
          id: attrId,
          name: this._adminResolveText(attrCfg.name) || `属性#${attrId}`,
          value: Math.max(0, toSafeInt(attrs[attrIdKey], 0)),
          power: Math.max(0, toSafeInt(attrCfg.power, 0)),
        };
      })
      .filter((row) => row.id > 0)
      .sort((a, b) => a.id - b.id);
  }

  _adminBuildEquipRows(player = {}) {
    const equipInfo = ensurePlainObject(player.equipInfo);
    const assetsCfgMap = configService.get('AssetsConfig') || {};
    const attrCfgMap = configService.get('AttrConfig') || {};
    const curIndex = Math.max(0, toSafeInt(equipInfo.curIndex, 0));
    const equipSetMap = ensurePlainObject(equipInfo.equipSetMap);
    const openListMap = ensurePlainObject(equipInfo.openListMap);
    const equippedPlan = ensurePlainObject(equipSetMap[String(curIndex)] || equipSetMap[curIndex]);
    const openList = Array.isArray(openListMap[String(curIndex)] || openListMap[curIndex])
      ? (openListMap[String(curIndex)] || openListMap[curIndex])
      : [];
    const allList = Array.isArray(equipInfo.equipList) ? equipInfo.equipList : [];
    const slotLabels = {
      1: '武器',
      2: '头饰',
      3: '外袍',
      4: '项链',
      5: '戒指',
      6: '腰带',
      7: '护腕',
      8: '鞋子',
      9: '裤子',
      10: '法宝',
      11: '灵宝',
      12: '饰品',
    };
    const rows = [];
    const seen = new Set();

    const pushEquip = (raw, options = {}) => {
      const equip = ensurePlainObject(raw);
      const uid = toSafeInt(equip.uid, 0);
      const id = toSafeInt(equip.id, 0);
      if (uid <= 0 || id <= 0) return;
      const key = String(uid);
      if (seen.has(key)) return;
      seen.add(key);

      const assetRow = ensurePlainObject(assetsCfgMap[id] || assetsCfgMap[String(id)]);
      const type = Math.max(1, toSafeInt(equip.type, toSafeInt(assetRow.subType, 1)));
      const quality = Math.max(1, toSafeInt(equip.quailty != null ? equip.quailty : equip.quality, toSafeInt(assetRow.quality, 1)));
      const attrs = ensurePlainObject(equip.attrs);
      rows.push({
        uid,
        id,
        name: this._adminResolveText(assetRow.name) || resolveAdminConfigName(id) || `装备#${id}`,
        type,
        slot: slotLabels[type] || `部位${type}`,
        quality,
        level: Math.max(1, toSafeInt(equip.lv != null ? equip.lv : equip.level, 1)),
        equipped: !!options.equipped,
        location: options.location || (options.equipped ? '已穿戴' : '背包'),
        attrs: Object.keys(attrs)
          .map((attrIdKey) => {
            const attrId = toSafeInt(attrIdKey, 0);
            const attrCfg = ensurePlainObject(attrCfgMap[attrId] || attrCfgMap[String(attrId)]);
            return {
              id: attrId,
              name: this._adminResolveText(attrCfg.name) || resolveAdminConfigName(attrId) || `属性#${attrId}`,
              value: toSafeInt(attrs[attrIdKey], 0),
            };
          })
          .filter((row) => row.id > 0 && row.value !== 0)
          .sort((a, b) => a.id - b.id),
      });
    };

    Object.keys(equippedPlan).forEach((slotKey) => pushEquip(equippedPlan[slotKey], { equipped: true, location: `方案${curIndex}/部位${slotKey}` }));
    openList.forEach((equip) => pushEquip(equip, { equipped: false, location: `背包${curIndex}` }));
    allList.forEach((equip) => pushEquip(equip, { equipped: false, location: '装备列表' }));

    return rows.sort((a, b) => Number(b.equipped) - Number(a.equipped) || a.type - b.type || a.uid - b.uid);
  }

  _adminBuildItemRows(player = {}) {
    const items = ensurePlainObject(player.items);
    const itemIdSet = new Set([...Object.keys(items), '137']);

    return Array.from(itemIdSet)
      .map((itemIdKey) => {
        const itemId = toSafeInt(itemIdKey, 0);
        return {
          id: itemId,
          count: Math.max(0, toSafeInt(items[itemIdKey], 0)),
          label: getAdminItemLabel(itemId),
        };
      })
      .filter((row) => row.count > 0 || row.id < 0 || row.id === 137)
      .sort((a, b) => a.id - b.id);
  }

  _adminBuildFarmSeedRows(player = {}) {
    const items = ensurePlainObject(player.items);
    return Object.keys(ADMIN_FARM_SEED_ITEM_LABELS)
      .map((itemIdKey) => {
        const itemId = toSafeInt(itemIdKey, 0);
        return {
          id: itemId,
          label: ADMIN_FARM_SEED_ITEM_LABELS[itemId],
          count: Math.max(0, toSafeInt(items[itemId], 0)),
        };
      })
      .sort((a, b) => a.id - b.id);
  }

  _adminBuildTaskRow(taskId, taskState = {}, taskCfg = {}, currentStageTaskSet = new Set()) {
    const safeTaskId = toSafeInt(taskId, 0);
    const safeTaskState = ensurePlainObject(taskState);
    const safeTaskCfg = ensurePlainObject(taskCfg);
    const status = toSafeInt(safeTaskState.status, 10);
    return {
      id: safeTaskId,
      type: Math.max(0, toSafeInt(safeTaskState.type, toSafeInt(safeTaskCfg.type, 0))),
      typeLabel: getAdminTaskTypeLabel(safeTaskState.type != null ? safeTaskState.type : safeTaskCfg.type),
      name: this._adminResolveText(safeTaskCfg.textId)
        || normalizeText(safeTaskCfg.name)
        || normalizeText(safeTaskCfg.title)
        || `任务#${safeTaskId}`,
      desc: this._adminResolveText(safeTaskCfg.desc)
        || normalizeText(safeTaskCfg.taskDesc)
        || normalizeText(safeTaskCfg.content)
        || '',
      status,
      statusLabel: getAdminTaskStatusLabel(status),
      progress: Math.max(0, toSafeInt(safeTaskState.progress, 0)),
      target: Math.max(0, toSafeInt(safeTaskState.target, toSafeInt(safeTaskCfg.taskValue1, 0))),
      activeId: Math.max(0, toSafeInt(safeTaskCfg.activeId, 0)),
      isCurrentStageTask: currentStageTaskSet.has(safeTaskId),
    };
  }

  _adminBuildTaskRows(player = {}) {
    const roleInfo = ensurePlainObject(player.roleInfo);
    const taskInfo = normalizeTaskInfo(player.taskInfo || {}, roleInfo);
    const tasks = ensurePlainObject(taskInfo.tasks);
    const taskCfgMap = configService.get('TaskConfig') || {};
    const currentStage = Math.max(1, toSafeInt(roleInfo.stage, toSafeInt(roleInfo.stageId, 1)));
    const stageCfgMap = configService.get('RoleStageConfig') || {};
    const stageCfg = stageCfgMap[currentStage] || stageCfgMap[String(currentStage)] || {};
    const currentStageTaskIds = (Array.isArray(stageCfg.taskGroup) ? stageCfg.taskGroup : [])
      .map((taskId) => toSafeInt(taskId, 0))
      .filter((taskId) => taskId > 0);
    const currentStageTaskSet = new Set(currentStageTaskIds);

    const currentStageRows = currentStageTaskIds
      .map((taskId) => this._adminBuildTaskRow(
        taskId,
        tasks[taskId] || tasks[String(taskId)] || { id: taskId, status: 10, progress: 0, target: 0 },
        taskCfgMap[taskId] || taskCfgMap[String(taskId)] || {},
        currentStageTaskSet
      ))
      .filter((row) => row.id > 0);

    const extraRows = Object.keys(tasks)
      .map((taskIdKey) => {
        const taskId = toSafeInt(taskIdKey, 0);
        return this._adminBuildTaskRow(
          taskId,
          tasks[taskIdKey],
          taskCfgMap[taskId] || taskCfgMap[String(taskId)] || {},
          currentStageTaskSet
        );
      })
      .filter((row) => row.id > 0 && !currentStageTaskSet.has(row.id))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type - b.type;
        if (a.status !== b.status) return a.status - b.status;
        return a.id - b.id;
      });

    const rows = [...currentStageRows, ...extraRows];

    return {
      rows,
      currentStage,
      currentStageName: getAdminStageDisplayName(currentStage, stageCfg, (value) => this._adminResolveText(value)),
      currentStageTaskIds,
      stats: {
        total: rows.length,
        doing: rows.filter((row) => row.status < 20).length,
        claimable: rows.filter((row) => row.status >= 20 && row.status < 30).length,
        completed: rows.filter((row) => row.status >= 30).length,
      },
      counters: ensurePlainObject(
        ensurePlainObject(player.other_attr_info).mainTaskProgress
      ),
    };
  }

  _adminBuildProgressInfo(player = {}) {
    const raidInfo = ensurePlainObject(player.raidInfo);
    const roleInfo = ensurePlainObject(player.roleInfo);
    const chapter = Math.max(1, toSafeInt(raidInfo.chapter, 1));
    const chapterCfgMap = configService.get('ChapterConfig') || {};
    const chapterCfg = chapterCfgMap[chapter] || chapterCfgMap[String(chapter)] || {};
    const stage = Math.max(1, toSafeInt(roleInfo.stage, toSafeInt(roleInfo.stageId, 1)));
    const stageCfgMap = configService.get('RoleStageConfig') || {};
    const stageCfg = stageCfgMap[stage] || stageCfgMap[String(stage)] || {};
    const realmInfo = ensurePlainObject(roleInfo.realmInfo);

    return {
      raid: {
        chapter,
        level: Math.max(1, toSafeInt(raidInfo.level, 1)),
        hangUpChapter: Math.max(1, toSafeInt(raidInfo.hangUpChapter, chapter)),
        hangUpTime: Math.max(0, toSafeInt(raidInfo.hangUpTime, 0)),
        rewardChapter: Math.max(0, toSafeInt(raidInfo.rewardChapter, toSafeInt(raidInfo.chapterInfo && raidInfo.chapterInfo.rewardChapter, 0))),
        claimedChapters: Array.isArray(raidInfo.claimedChapters)
          ? raidInfo.claimedChapters.map((id) => Math.max(1, toSafeInt(id, 1))).sort((a, b) => a - b)
          : [],
        chapterLevelCount: Array.isArray(chapterCfg.levelList) ? chapterCfg.levelList.length : 0,
        totalChapters: Object.keys(chapterCfgMap).length,
      },
      realm: {
        stage,
        stageName: this._adminResolveText(stageCfg.name) || `境界${stage}`,
        levelCap: Math.max(0, toSafeInt(stageCfg.levelMax, 0)),
        realmLevel: Math.max(0, toSafeInt(realmInfo.realmLevel, 0)),
        realmExp: Math.max(0, toSafeInt(realmInfo.realmExp, 0)),
        realmStage: Math.max(0, toSafeInt(realmInfo.realmStage, 0)),
        rewardedStage: Math.max(0, toSafeInt(roleInfo.rewardedStage, 0)),
        failedTime: Math.max(0, toSafeInt(roleInfo.stageFailedTime, 0)),
        currentTaskGroup: Array.isArray(stageCfg.taskGroup)
          ? stageCfg.taskGroup.map((taskId) => Math.max(0, toSafeInt(taskId, 0))).filter((taskId) => taskId > 0)
          : [],
      },
    };
  }

  _adminBuildSystemUnlockInfo(player = {}) {
    const raw = ensurePlainObject(player.systemUnlockInfo);
    const allSystemIds = getAdminAllSystemIds();
    const unlockedSystem = Array.isArray(raw.unlockedSystem)
      ? raw.unlockedSystem.map((id) => Math.max(1, toSafeInt(id, 1))).filter((id, idx, arr) => id > 0 && arr.indexOf(id) === idx).sort((a, b) => a - b)
      : [];
    const rewardedSystem = Array.isArray(raw.rewardedSystem)
      ? raw.rewardedSystem.map((id) => Math.max(1, toSafeInt(id, 1))).filter((id, idx, arr) => id > 0 && arr.indexOf(id) === idx).sort((a, b) => a - b)
      : [];
    const settings = ensurePlainObject(raw.settings);
    const seenNewFeatures = Array.isArray(settings.seenNewFeatures)
      ? settings.seenNewFeatures.map((id) => Math.max(1, toSafeInt(id, 1))).filter((id, idx, arr) => id > 0 && arr.indexOf(id) === idx).sort((a, b) => a - b)
      : [];
    return {
      unlockedSystem,
      rewardedSystem,
      settings,
      guideStep: Math.max(0, toSafeInt(raw.guideStep, 0)),
      pendingNewFeatures: unlockedSystem.filter((id) => !seenNewFeatures.includes(id)),
      allSystemIds,
      allSystemCount: allSystemIds.length,
      unlockedSystemCount: unlockedSystem.length,
      rewardedSystemCount: rewardedSystem.length,
      seenNewFeatureCount: seenNewFeatures.length,
      lockSystemCount: Math.max(0, allSystemIds.length - unlockedSystem.length),
      canUnlockAllSystems: unlockedSystem.length < allSystemIds.length,
    };
  }

  _adminBuildPlayerSummary(player = {}, roleMeta = {}) {
    const currencies = ensurePlainObject(player.currencies);
    const items = ensurePlainObject(player.items);
    const raidInfo = ensurePlainObject(player.raidInfo);
    const roleInfo = ensurePlainObject(player.roleInfo);
    const rechargeInfo = ensurePlainObject(player.rechargeInfo);
    const spiritInfo = ensurePlainObject(player.spiritInfo);
    const artifactInfo = ensurePlainObject(player.artifactInfo);
    const artifacts = Array.isArray(artifactInfo.artifacts) ? artifactInfo.artifacts : [];
    const artifactMaxLevel = artifacts.reduce((max, artifact) => {
      const attr = ensurePlainObject(artifact && artifact.attr);
      return Math.max(
        max,
        toSafeInt(attr.level, 0),
        toSafeInt(artifact && artifact.level, 0),
        toSafeInt(artifact && artifact.quenchLv, 0)
      );
    }, 0);

    return {
      userId: normalizeText(player.userId),
      playerId: normalizeText(player.playerId),
      accountId: normalizeText(roleMeta.accountId),
      accountStatus: toSafeInt(roleMeta.accountStatus, 1),
      chatMuted: !!(ensurePlainObject(player.adminStatus).muted),
      muteUntil: Math.max(0, toSafeInt(ensurePlainObject(player.adminStatus).muteUntil, 0)),
      muteReason: normalizeText(ensurePlainObject(player.adminStatus).muteReason, 300),
      roleId: normalizeText(roleMeta.roleId),
      serverId: toSafeInt(roleMeta.serverId, 0),
      activeRoleId: normalizeText(roleMeta.activeRoleId),
      name: normalizeText(player.name),
      level: Math.max(1, toSafeInt(player.level, 1)),
      exp: Math.max(0, toSafeInt(player.exp, 0)),
      diamond: Math.max(0, toSafeInt(currencies.diamond, 0)),
      gold: Math.max(0, toSafeInt(currencies.gold, 0)),
      silver: Math.max(0, toSafeInt(currencies.silver, 0)),
      baozi: Math.max(0, toSafeInt(items[4], 0)),
      lingyun: Math.max(0, toSafeInt(items[137], 0)),
      tianyanSmall: Math.max(0, toSafeInt(items[1001], 0)),
      tianyanMedium: Math.max(0, toSafeInt(items[1002], 0)),
      tianyanLarge: Math.max(0, toSafeInt(items[1003], 0)),
      chapter: Math.max(1, toSafeInt(raidInfo.chapter, 1)),
      raidLevel: Math.max(1, toSafeInt(raidInfo.level, 1)),
      stage: Math.max(1, toSafeInt(roleInfo.stage, toSafeInt(roleInfo.stageId, 1))),
      vipLevel: Math.max(0, toSafeInt(rechargeInfo.vipLevel, 0)),
      totalRecharge: Math.max(0, toSafeInt(rechargeInfo.totalRecharge, toSafeInt(rechargeInfo.totalrecharge, 0))),
      spiritRank: Math.max(1, toSafeInt(spiritInfo.rank, 1)),
      artifactCount: artifacts.length,
      artifactMaxLevel,
      agentId: normalizeText(player.agentId),
      inviteCode: normalizeText(player.inviteCode),
      createdAt: player.createdAt,
      updatedAt: player.updatedAt,
      lastLoginTime: toSafeInt(roleMeta.lastLoginTime, 0),
    };
  }

  _adminBuildPlayerDetail(player = {}, roleMeta = {}) {
    const summary = this._adminBuildPlayerSummary(player, roleMeta);
    const currencies = ensurePlainObject(player.currencies);
    const items = ensurePlainObject(player.items);
    const raidInfo = ensurePlainObject(player.raidInfo);
    const roleInfo = ensurePlainObject(player.roleInfo);
    const boxInfo = ensurePlainObject(player.boxInfo);
    const rechargeInfo = ensurePlainObject(player.rechargeInfo);
    const spiritInfo = ensurePlainObject(player.spiritInfo);
    const farmInfo = ensurePlainObject(player.farmInfo);
    const templeInfo = ensurePlainObject(ensurePlainObject(player.other_attr_info).templeInfo);
    const systemUnlockInfo = this._adminBuildSystemUnlockInfo(player);
    const formationInfo = ensurePlainObject(player.formationInfo);
    const equipInfo = ensurePlainObject(player.equipInfo);
    const attrRows = this._adminBuildAttrRows(player);
    const power = Math.max(0, toSafeInt(battleService.calcPowerScore(battleService.calcPlayerPower(player)), 0));

    return {
      ...summary,
      avatar: Math.max(0, toSafeInt(player.avatar, 11305)),
      avatarFrame: Math.max(-1, toSafeInt(player.avatarFrame, -1)),
      title: Math.max(-1, toSafeInt(player.title, -1)),
      currencies: {
        diamond: Math.max(0, toSafeInt(currencies.diamond, 0)),
        gold: Math.max(0, toSafeInt(currencies.gold, 0)),
        silver: Math.max(0, toSafeInt(currencies.silver, 0)),
      },
      items: { ...items },
      raidInfo: {
        chapter: Math.max(1, toSafeInt(raidInfo.chapter, 1)),
        level: Math.max(1, toSafeInt(raidInfo.level, 1)),
      },
      roleInfo: {
        stage: Math.max(1, toSafeInt(roleInfo.stage, toSafeInt(roleInfo.stageId, 1))),
        stageId: Math.max(1, toSafeInt(roleInfo.stageId, toSafeInt(roleInfo.stage, 1))),
        kungfuId: Math.max(1, toSafeInt(roleInfo.kungfuId, 4)),
        subJob: Math.max(0, toSafeInt(roleInfo.subJob, 0)),
        avatarFrame: Math.max(-1, toSafeInt(roleInfo.avatarFrame, toSafeInt(player.avatarFrame, -1))),
        title: Math.max(-1, toSafeInt(roleInfo.title, toSafeInt(player.title, -1))),
      },
      boxInfo: {
        level: Math.max(1, toSafeInt(boxInfo.level, 1)),
      },
      rechargeInfo: {
        vipLevel: Math.max(0, toSafeInt(rechargeInfo.vipLevel, 0)),
        totalRecharge: Math.max(0, toSafeInt(rechargeInfo.totalRecharge, toSafeInt(rechargeInfo.totalrecharge, 0))),
      },
      spiritInfo: {
        id: toSafeInt(spiritInfo.id, -1),
        rank: Math.max(1, toSafeInt(spiritInfo.rank, 1)),
        attrs: ensurePlainObject(spiritInfo.attrs),
      },
      farmInfo: {
        lv: Math.max(1, toSafeInt(farmInfo.lv, 1)),
        exp: Math.max(0, toSafeInt(farmInfo.exp, 0)),
        ratSkin: Math.max(0, toSafeInt(farmInfo.ratSkin, 0)),
        offlineReward: !!farmInfo.offlineReward,
        buildLv: ensurePlainObject(farmInfo.buildLv),
        buildUpgrade: ensurePlainObject(farmInfo.buildUpgrade),
        blockInfo: Array.isArray(farmInfo.blockInfo) ? farmInfo.blockInfo : [],
        cookInfo: ensurePlainObject(farmInfo.cookInfo),
        cacheOffline: Array.isArray(farmInfo.cacheOffline) ? farmInfo.cacheOffline : [],
        cacheRecover: Array.isArray(farmInfo.cacheRecover) ? farmInfo.cacheRecover : [],
        neighbors: ensurePlainObject(farmInfo.neighbors),
        enemys: ensurePlainObject(farmInfo.enemys),
        autoStealRecord: Array.isArray(farmInfo.autoStealRecord) ? farmInfo.autoStealRecord : [],
      },
      templeInfo: {
        lingyunCount: Math.max(0, toSafeInt(items[137], 0)),
        lingyunNextRecoverTime: Math.max(0, toSafeInt(ensurePlainObject(templeInfo.lingyun).nextRecoverTime, 0)),
        lingyunMaxCount: 10,
      },
      farmSeedRows: this._adminBuildFarmSeedRows(player),
      systemUnlockInfo,
      activityEntryInfo: this._adminBuildActivityEntryInfo(player),
      equipInfo,
      formationInfo,
      combatInfo: {
        power,
        attrRows,
        equipRows: this._adminBuildEquipRows(player),
        equipCount: Array.isArray(equipInfo.equipList) ? equipInfo.equipList.length : 0,
        equippedFormationId: Math.max(0, toSafeInt(formationInfo.equippedId, toSafeInt(formationInfo.curFormation, 0))),
      },
      itemRows: this._adminBuildItemRows(player),
      taskProgress: this._adminBuildTaskRows(player),
      progressInfo: this._adminBuildProgressInfo(player),
      artifactInfo: {
        artifactCount: summary.artifactCount,
        maxArtifactLevel: summary.artifactMaxLevel,
      },
      accountInfo: {
        accountId: summary.accountId,
        roleId: summary.roleId,
        serverId: summary.serverId,
        activeRoleId: summary.activeRoleId,
        lastLoginTime: summary.lastLoginTime,
      },
      createdAt: player.createdAt,
      updatedAt: player.updatedAt,
    };
  }

  async _adminSyncAccountRoleName(userId, nextName) {
    const Account = require('../db/models/Account');
    const normalizedUserId = normalizeText(userId);
    const normalizedName = normalizeText(nextName, 16);
    if (!normalizedUserId || !normalizedName) return;
    await Account.updateOne(
      { 'roles.userId': normalizedUserId },
      { $set: { 'roles.$.name': normalizedName } }
    );
  }

  async _adminRemoveAccountRolesByUserId(userId) {
    const normalizedUserId = normalizeText(userId);
    if (!normalizedUserId) return 0;

    const Account = require('../db/models/Account');
    const accounts = await Account.find({ 'roles.userId': normalizedUserId });
    let removedCount = 0;
    for (const account of accounts) {
      const currentRoles = Array.isArray(account.roles) ? account.roles : [];
      const deletedRoles = currentRoles.filter((role) => normalizeText(role && role.userId) === normalizedUserId);
      if (deletedRoles.length <= 0) continue;
      removedCount += deletedRoles.length;

      const deletedRoleIds = new Set(
        deletedRoles.map((role) => normalizeText(role && role.roleId)).filter(Boolean)
      );
      const deletedServerIds = new Set(
        deletedRoles.map((role) => toSafeInt(role && role.serverId, 0)).filter((serverId) => serverId > 0)
      );

      account.roles = currentRoles.filter((role) => normalizeText(role && role.userId) !== normalizedUserId);
      account.markModified('roles');

      const activeRoleByServer = ensurePlainObject(account.activeRoleByServer);
      deletedServerIds.forEach((serverId) => {
        const key = String(serverId);
        const activeRoleId = normalizeText(activeRoleByServer[key]);
        if (!deletedRoleIds.has(activeRoleId)) return;

        const nextRole = account.roles.find((role) => toSafeInt(role && role.serverId, 0) === serverId);
        if (nextRole) activeRoleByServer[key] = normalizeText(nextRole.roleId);
        else delete activeRoleByServer[key];
      });
      account.activeRoleByServer = activeRoleByServer;
      account.markModified('activeRoleByServer');

      const currentSelectedServerId = toSafeInt(account.lastSelectedServerId, 0);
      if (deletedServerIds.has(currentSelectedServerId)) {
        const nextRole = account.roles[0] || null;
        account.lastSelectedServerId = nextRole ? toSafeInt(nextRole.serverId, 0) : 0;
      }
      await account.save();
    }
    return removedCount;
  }

  // ── Admin player management handlers ─────────────────────────────────────

  async _adminListPlayers(req, res) {
    try {
      const Player = require('../db/models/Player');
      const page  = Math.max(1, parseInt(req.query.page || '1', 10));
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '20', 10)));
      const search = normalizeText(req.query.search, 64);
      const inviteStatus = normalizeText(req.query.inviteStatus || req.query.inviteFilter, 16);
      const filter = this._buildPlayerAccessFilter(req);
      const andRules = [];

      if (inviteStatus === 'with') {
        andRules.push({ inviteCode: { $exists: true, $nin: [null, ''] } });
      } else if (inviteStatus === 'without') {
        andRules.push({
          $or: [
            { inviteCode: { $exists: false } },
            { inviteCode: null },
            { inviteCode: '' },
          ],
        });
      }

      if (search) {
        const accountMatchedUserIds = await this._adminFindAccountMatchedUserIds(search);
        const searchRules = [
          { name:     { $regex: search, $options: 'i' } },
          { userId:   { $regex: search, $options: 'i' } },
          { playerId: { $regex: search, $options: 'i' } },
          { agentId:  { $regex: search, $options: 'i' } },
          { inviteCode: { $regex: search, $options: 'i' } },
        ];
        if (accountMatchedUserIds.length > 0) {
          searchRules.push({ userId: { $in: accountMatchedUserIds } });
        }
        andRules.push({ $or: searchRules });
      }

      if (andRules.length > 0) {
        filter.$and = Array.isArray(filter.$and) ? filter.$and.concat(andRules) : andRules;
      }

      const [total, players] = await Promise.all([
        Player.countDocuments(filter),
        Player.find(filter)
          .select(
            'userId playerId name level exp avatar avatarFrame title currencies items raidInfo roleInfo '
            + 'boxInfo rechargeInfo artifactInfo spiritInfo agentId inviteCode createdAt updatedAt'
          )
          .sort({ updatedAt: -1, level: -1, createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        ]);

      const accountRoleMap = await this._adminLoadAccountRoleMap(players.map((player) => player.userId));

      res.json({
        success: true,
        total,
        page,
        limit,
        pages: total > 0 ? Math.ceil(total / limit) : 0,
        players: players.map((player) => this._adminBuildPlayerSummary(
          player,
          accountRoleMap.get(normalizeText(player.userId)) || {}
        )),
      });
    } catch (err) {
      logger.error(`[Admin] list: ${err.message}`);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminBatchCreatePlayers(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const Player = require('../db/models/Player');
      const body = ensurePlainObject(req.body);
      const count = Math.max(1, Math.min(200, toSafeInt(body.count, 1)));
      const startIndex = Math.max(1, toSafeInt(body.startIndex, 1));
      const userPrefix = normalizeText(body.userPrefix || 'user', 24);
      const namePrefix = normalizeText(body.namePrefix || 'Player', 24);
      const prefixRegex = /^[A-Za-z][A-Za-z0-9_-]*$/;
      if (!prefixRegex.test(userPrefix) || !prefixRegex.test(namePrefix)) {
        return res.status(400).json({ success: false, error: 'PREFIX_MUST_BE_ENGLISH' });
      }

      const created = [];
      let cursor = startIndex;
      let guard = 0;
      while (created.length < count && guard < count * 20) {
        guard += 1;
        const suffix = String(cursor).padStart(4, '0');
        const userId = `${userPrefix}${suffix}`;
        const name = `${namePrefix}${suffix}`;
        cursor += 1;

        const exists = await Player.findOne({ $or: [{ userId }, { name }] }).select('userId name').lean();
        if (exists) continue;

        const player = await playerService.createPlayer(userId, name);
        created.push({ userId: player.userId, name: player.name, playerId: player.playerId });
      }

      return res.json({ success: true, count: created.length, nextIndex: cursor, players: created });
    } catch (err) {
      logger.error(`[Admin] batch create: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminGetPlayer(req, res) {
    try {
      const Player = require('../db/models/Player');
      const userId = normalizeText(req.params.userId, 64);
      const p = await Player.findOne({ userId }).lean();
      if (!p) return res.status(404).json({ success: false, error: 'PLAYER_NOT_FOUND' });
      if (!this._canAccessPlayer(req, p)) {
        return res.status(403).json({ success: false, error: 'FORBIDDEN' });
      }

      const roleMap = await this._adminLoadAccountRoleMap([userId]);
      res.json({
        success: true,
        player: this._adminBuildPlayerDetail(p, roleMap.get(userId) || {}),
      });
    } catch (err) {
      logger.error(`[Admin] get: ${err.message}`);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminUpdatePlayer(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const Player = require('../db/models/Player');
      const body = ensurePlainObject(req.body);
      const userId = normalizeText(req.params.userId, 64);
      const p = await Player.findOne({ userId });
      if (!p) return res.status(404).json({ success: false, error: 'PLAYER_NOT_FOUND' });

      let nameChanged = false;
      if (body.name != null) {
        const n = normalizeText(body.name, 16);
        if (!n || n.length > 16) return res.status(400).json({ success: false, error: 'INVALID_NAME' });
        nameChanged = p.name !== n;
        p.name = n;
      }

      if (body.level != null) p.level = Math.max(1, Math.min(9999, toSafeInt(body.level, 1)));
      if (body.exp != null) p.exp = Math.max(0, toSafeInt(body.exp, 0));
      if (body.avatar != null) p.avatar = Math.max(0, toSafeInt(body.avatar, 11305));

      if (body.avatarFrame != null || body.title != null || (body.roleInfo && typeof body.roleInfo === 'object')) {
        p.roleInfo = ensurePlainObject(p.roleInfo);
        p.roleInfo.showInfo = ensurePlainObject(p.roleInfo.showInfo);
        let roleAppearanceTouched = false;

        if (body.avatarFrame != null) {
          const avatarFrame = Math.max(-1, toSafeInt(body.avatarFrame, -1));
          p.avatarFrame = avatarFrame;
          p.roleInfo.avatarFrame = avatarFrame;
          p.roleInfo.showInfo.avatarFrame = avatarFrame;
          roleAppearanceTouched = true;
        }

        if (body.title != null) {
          const title = Math.max(-1, toSafeInt(body.title, -1));
          p.title = title;
          p.roleInfo.title = title;
          p.roleInfo.showInfo.title = title;
          roleAppearanceTouched = true;
        }

        if (roleAppearanceTouched) p.markModified('roleInfo');
      }

      if (body.agentId != null) p.agentId = normalizeText(body.agentId, 64) || null;
      if (body.inviteCode != null) p.inviteCode = normalizeText(body.inviteCode, 64) || null;

      if (body.currencies && typeof body.currencies === 'object') {
        p.currencies = p.currencies || {};
        const c = ensurePlainObject(body.currencies);
        if (c.diamond != null) p.currencies.diamond = Math.max(0, toSafeInt(c.diamond, 0));
        if (c.gold != null) p.currencies.gold = Math.max(0, toSafeInt(c.gold, 0));
        if (c.silver != null) p.currencies.silver = Math.max(0, toSafeInt(c.silver, 0));
        p.markModified('currencies');
      }

      if (body.items && typeof body.items === 'object') {
        p.items = p.items || {};
        Object.keys(body.items).forEach((k) => {
          const v = Math.max(0, toSafeInt(body.items[k], 0));
          if (v > 0) p.items[k] = v; else delete p.items[k];
        });
        p.markModified('items');
      }

      if (body.exp != null || (body.items && typeof body.items === 'object' && Object.prototype.hasOwnProperty.call(body.items, '3'))) {
        const { checkLevelUp } = require('../handlers/raid');
        checkLevelUp(p);
      }

      if (body.raidInfo && typeof body.raidInfo === 'object') {
        const raidInfo = ensurePlainObject(body.raidInfo);
        p.raidInfo = ensurePlainObject(p.raidInfo);
        if (raidInfo.chapter != null) p.raidInfo.chapter = Math.max(1, toSafeInt(raidInfo.chapter, 1));
        if (raidInfo.level != null) p.raidInfo.level = Math.max(1, toSafeInt(raidInfo.level, 1));
        if (raidInfo.hangUpChapter != null) p.raidInfo.hangUpChapter = Math.max(1, toSafeInt(raidInfo.hangUpChapter, 1));
        if (raidInfo.hangUpTime != null) p.raidInfo.hangUpTime = Math.max(0, toSafeInt(raidInfo.hangUpTime, 0));
        if (raidInfo.rewardChapter != null) p.raidInfo.rewardChapter = Math.max(0, toSafeInt(raidInfo.rewardChapter, 0));
        if (Array.isArray(raidInfo.claimedChapters)) {
          p.raidInfo.claimedChapters = raidInfo.claimedChapters
            .map((id) => Math.max(1, toSafeInt(id, 1)))
            .filter((id, idx, arr) => id > 0 && arr.indexOf(id) === idx)
            .sort((a, b) => a - b);
        }
        if (raidInfo.chapterInfo && typeof raidInfo.chapterInfo === 'object') {
          p.raidInfo.chapterInfo = ensurePlainObject(p.raidInfo.chapterInfo);
          if (raidInfo.chapterInfo.rewardChapter != null) {
            p.raidInfo.chapterInfo.rewardChapter = Math.max(0, toSafeInt(raidInfo.chapterInfo.rewardChapter, 0));
          }
        }
        p.markModified('raidInfo');
      }

      if (body.roleInfo && typeof body.roleInfo === 'object') {
        const roleInfo = ensurePlainObject(body.roleInfo);
        p.roleInfo = ensurePlainObject(p.roleInfo);
        p.roleInfo.showInfo = ensurePlainObject(p.roleInfo.showInfo);

        if (roleInfo.stage != null || roleInfo.stageId != null) {
          const stage = Math.max(1, toSafeInt(
            roleInfo.stageId != null ? roleInfo.stageId : roleInfo.stage,
            1
          ));
          p.roleInfo.stage = stage;
          p.roleInfo.stageId = stage;
        }
        if (roleInfo.kungfuId != null) p.roleInfo.kungfuId = Math.max(1, toSafeInt(roleInfo.kungfuId, 4));
        if (roleInfo.subJob != null) p.roleInfo.subJob = Math.max(0, toSafeInt(roleInfo.subJob, 0));
        if (roleInfo.rewardedStage != null) p.roleInfo.rewardedStage = Math.max(0, toSafeInt(roleInfo.rewardedStage, 0));
        if (roleInfo.stageFailedTime != null) p.roleInfo.stageFailedTime = Math.max(0, toSafeInt(roleInfo.stageFailedTime, 0));
        p.markModified('roleInfo');
      }

      if (body.boxInfo && typeof body.boxInfo === 'object') {
        const boxInfo = ensurePlainObject(body.boxInfo);
        p.boxInfo = ensurePlainObject(p.boxInfo);
        if (boxInfo.level != null) p.boxInfo.level = Math.max(1, toSafeInt(boxInfo.level, 1));
        p.markModified('boxInfo');
      }

      if (body.rechargeInfo && typeof body.rechargeInfo === 'object') {
        const rechargeInfo = ensurePlainObject(body.rechargeInfo);
        p.rechargeInfo = ensurePlainObject(p.rechargeInfo);
        if (rechargeInfo.vipLevel != null) {
          p.rechargeInfo.vipLevel = Math.max(0, toSafeInt(rechargeInfo.vipLevel, 0));
        }
        if (rechargeInfo.totalRecharge != null || rechargeInfo.totalrecharge != null) {
          const totalRecharge = Math.max(
            0,
            toSafeInt(
              rechargeInfo.totalRecharge != null ? rechargeInfo.totalRecharge : rechargeInfo.totalrecharge,
              0
            )
          );
          p.rechargeInfo.totalRecharge = totalRecharge;
          p.rechargeInfo.totalrecharge = totalRecharge;
        }
        p.markModified('rechargeInfo');
      }

      if (body.spiritInfo && typeof body.spiritInfo === 'object') {
        const spiritInfo = ensurePlainObject(body.spiritInfo);
        p.spiritInfo = ensurePlainObject(p.spiritInfo);
        if (spiritInfo.id != null) p.spiritInfo.id = toSafeInt(spiritInfo.id, -1);
        if (spiritInfo.rank != null) p.spiritInfo.rank = Math.max(1, toSafeInt(spiritInfo.rank, 1));
        p.markModified('spiritInfo');
      }

      if (body.farmInfo && typeof body.farmInfo === 'object') {
        const farmInfo = ensurePlainObject(body.farmInfo);
        p.farmInfo = ensurePlainObject(p.farmInfo);
        if (farmInfo.lv != null) p.farmInfo.lv = Math.max(1, toSafeInt(farmInfo.lv, 1));
        if (farmInfo.exp != null) p.farmInfo.exp = Math.max(0, toSafeInt(farmInfo.exp, 0));
        if (farmInfo.ratSkin != null) p.farmInfo.ratSkin = Math.max(0, toSafeInt(farmInfo.ratSkin, 0));
        if (farmInfo.offlineReward != null) p.farmInfo.offlineReward = !!farmInfo.offlineReward;
        if (farmInfo.buildLv && typeof farmInfo.buildLv === 'object') p.farmInfo.buildLv = ensurePlainObject(farmInfo.buildLv);
        if (farmInfo.buildUpgrade && typeof farmInfo.buildUpgrade === 'object') p.farmInfo.buildUpgrade = ensurePlainObject(farmInfo.buildUpgrade);
        if (Array.isArray(farmInfo.blockInfo)) p.farmInfo.blockInfo = farmInfo.blockInfo;
        if (farmInfo.cookInfo && typeof farmInfo.cookInfo === 'object') p.farmInfo.cookInfo = ensurePlainObject(farmInfo.cookInfo);
        if (Array.isArray(farmInfo.cacheOffline)) p.farmInfo.cacheOffline = farmInfo.cacheOffline;
        if (Array.isArray(farmInfo.cacheRecover)) p.farmInfo.cacheRecover = farmInfo.cacheRecover;
        if (farmInfo.neighbors && typeof farmInfo.neighbors === 'object') p.farmInfo.neighbors = ensurePlainObject(farmInfo.neighbors);
        if (farmInfo.enemys && typeof farmInfo.enemys === 'object') p.farmInfo.enemys = ensurePlainObject(farmInfo.enemys);
        if (Array.isArray(farmInfo.autoStealRecord)) p.farmInfo.autoStealRecord = farmInfo.autoStealRecord;
        p.markModified('farmInfo');
      }

      if (body.equipInfo && typeof body.equipInfo === 'object') {
        p.equipInfo = ensurePlainObject(body.equipInfo);
        const { ensureEquipInfo } = require('../services/EquipService');
        ensureEquipInfo(p);
        p.markModified('equipInfo');
      }

      if (body.formationInfo && typeof body.formationInfo === 'object') {
        p.formationInfo = ensurePlainObject(body.formationInfo);
        p.markModified('formationInfo');
      }

      if (body.systemUnlockInfo && typeof body.systemUnlockInfo === 'object') {
        const info = ensurePlainObject(body.systemUnlockInfo);
        p.systemUnlockInfo = ensurePlainObject(p.systemUnlockInfo);
        if (Array.isArray(info.unlockedSystem)) {
          p.systemUnlockInfo.unlockedSystem = info.unlockedSystem
            .map((id) => Math.max(1, toSafeInt(id, 1)))
            .filter((id, idx, arr) => id > 0 && arr.indexOf(id) === idx)
            .sort((a, b) => a - b);
        }
        if (Array.isArray(info.rewardedSystem)) {
          p.systemUnlockInfo.rewardedSystem = info.rewardedSystem
            .map((id) => Math.max(1, toSafeInt(id, 1)))
            .filter((id, idx, arr) => id > 0 && arr.indexOf(id) === idx)
            .sort((a, b) => a - b);
        }
        if (info.guideStep != null) {
          p.systemUnlockInfo.guideStep = Math.max(0, toSafeInt(info.guideStep, 0));
        }
        if (info.settings && typeof info.settings === 'object') {
          p.systemUnlockInfo.settings = ensurePlainObject(info.settings);
        }
        p.markModified('systemUnlockInfo');
      }

      if (parseBool(body.unlockAllSystems, false) || parseBool(body.unlockAllNewFeatures, false)) {
        applyUnlockAllSystemsToPlayer(p);
        initializeUnlockedSystemData(p);
      }

      if (body.taskInfo && typeof body.taskInfo === 'object') {
        const nextTaskInfo = ensurePlainObject(body.taskInfo);
        p.taskInfo = normalizeTaskInfo({
          ...ensurePlainObject(p.taskInfo),
          ...nextTaskInfo,
        }, ensurePlainObject(p.roleInfo));
        p.markModified('taskInfo');
      }

      if (body.other_attr_info && typeof body.other_attr_info === 'object') {
        const otherAttrInfo = ensurePlainObject(body.other_attr_info);
        p.other_attr_info = ensurePlainObject(p.other_attr_info);

        if (otherAttrInfo.mainTaskProgress && typeof otherAttrInfo.mainTaskProgress === 'object') {
          const nextCounters = {};
          Object.keys(otherAttrInfo.mainTaskProgress).forEach((key) => {
            const cleanKey = normalizeText(key, 64);
            if (!cleanKey) return;
            nextCounters[cleanKey] = Math.max(0, toSafeInt(otherAttrInfo.mainTaskProgress[key], 0));
          });
          p.other_attr_info.mainTaskProgress = nextCounters;
        }

        p.markModified('other_attr_info');
      }

      await p.save();
      if (nameChanged) {
        await this._adminSyncAccountRoleName(p.userId, p.name);
      }

      logger.info(`[Admin] updated ${p.userId}`);
      const changedIds = body.items ? Object.keys(body.items).map(Number).filter((n) => n > 0) : [];
      const saved = p.toObject ? p.toObject() : p;
      const unlockAllRequested = parseBool(body.unlockAllSystems, false)
        || parseBool(body.unlockAllNewFeatures, false);
      const sessionSyncOptions = unlockAllRequested
        ? {
            fields: [],
            mergeSystemUnlockInfo: true,
            initializePlayer: initializeUnlockedSystemData,
          }
        : (body.systemUnlockInfo && typeof body.systemUnlockInfo === 'object'
          ? { fields: ['systemUnlockInfo'] }
          : undefined);
      this._pushAdminPlayerSync(p.userId, saved, changedIds, sessionSyncOptions);
      const roleMap = await this._adminLoadAccountRoleMap([p.userId]);
      res.json({
        success: true,
        userId: p.userId,
        player: this._adminBuildPlayerDetail(saved, roleMap.get(p.userId) || {}),
      });
    } catch (err) {
      logger.error(`[Admin] update: ${err.message}`);
      res.status(500).json({ success: false, error: err.code === 11000 ? 'NAME_DUPLICATE' : 'INTERNAL_ERROR' });
    }
  }

  async _adminGivePlayer(req, res) {
    try {
      if (!this._requirePermission(req, res, 'giveItems')) return;
      const Player = require('../db/models/Player');
      const body = ensurePlainObject(req.body);
      const userId = normalizeText(req.params.userId, 64);
      const p = await Player.findOne({ userId });
      if (!p) return res.status(404).json({ success: false, error: 'PLAYER_NOT_FOUND' });
      if (!this._canAccessPlayer(req, p)) {
        await this._recordAdminActionLog(req, {
          action: 'give_player',
          result: 'rejected',
          targetUserId: userId,
          targetPlayerName: p.name,
          targetAgentId: p.agentId,
          reason: 'FORBIDDEN',
        });
        return res.status(403).json({ success: false, error: 'FORBIDDEN' });
      }
      const giveValidation = this._validateGivePayloadByLimits(req, body);
      if (!giveValidation.ok) {
        await this._recordAdminActionLog(req, {
          action: 'give_player',
          result: 'rejected',
          targetUserId: userId,
          targetPlayerName: p.name,
          targetAgentId: p.agentId,
          reason: giveValidation.error,
          detail: { body, details: giveValidation.details || [] },
        });
        return res.status(403).json({ success: false, error: giveValidation.error, details: giveValidation.details || [] });
      }

      const applied = this._applyGivePayloadToPlayer(p, body);
      await p.save();
      logger.info(`[Admin] gave to ${p.userId}`);
      const saved = p.toObject ? p.toObject() : p;
      const giveItemIds = applied.itemIds;
      this._pushAdminPlayerSync(p.userId, saved, giveItemIds);
      await this._recordAdminActionLog(req, {
        action: 'give_player',
        result: 'success',
        targetUserId: p.userId,
        targetPlayerName: p.name,
        targetAgentId: p.agentId,
        detail: {
          currencies: {
            diamond: body.diamond || 0,
            gold: body.gold || 0,
            silver: body.silver || 0,
          },
          items: ensurePlainObject(body.items),
        },
      });
      res.json({ success: true, userId: p.userId, currencies: p.currencies });
    } catch (err) {
      logger.error(`[Admin] give: ${err.message}`);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  _adminListActivityEntries(_req, res) {
    res.json({ success: true, entries: this._adminBuildActivityEntryCatalog() });
  }

  async _adminSetPlayerActivityEntry(req, res) {
    try {
      if (req.adminSession && req.adminSession.role === 'agent') {
        return res.status(403).json({ success: false, error: 'FORBIDDEN' });
      }
      const Player = require('../db/models/Player');
      const { ensureActivityInfo, setActivityEntryEnabled, buildActivityPayload } = require('../handlers/activity');
      const userId = normalizeText(req.params.userId, 64);
      const body = ensurePlainObject(req.body);
      const activityId = Math.max(0, toSafeInt(body.activityId, 0));
      const enabled = parseBool(body.enabled, true);
      if (!userId || activityId <= 0) return res.status(400).json({ success: false, error: 'INVALID_ACTIVITY_ENTRY' });

      const player = await Player.findOne({ userId });
      if (!player) return res.status(404).json({ success: false, error: 'PLAYER_NOT_FOUND' });
      if (!this._canAccessPlayer(req, player)) return res.status(403).json({ success: false, error: 'FORBIDDEN' });

      const info = ensureActivityInfo(player);
      setActivityEntryEnabled(info, activityId, enabled);
      player.markModified('activityInfo');
      await player.save();

      const saved = player.toObject ? player.toObject() : player;
      this._pushActivityPayloadToPlayer(userId, saved);
      if (!enabled && this.wsServer) {
        const { buildActivityClosePacket } = require('../handlers/activity');
        const closePacket = buildActivityClosePacket(activityId);
        this.wsServer.pushToUser(userId, closePacket.tag, closePacket.data);
      }
      this._pushPlayerPayloadToPlayer(userId, saved);
      await this._recordAdminActionLog(req, {
        action: 'set_activity_entry',
        result: 'success',
        targetUserId: userId,
        targetPlayerName: player.name,
        targetAgentId: player.agentId,
        detail: { activityId, enabled },
      });

      res.json({
        success: true,
        userId,
        activityId,
        enabled,
        activityInfo: buildActivityPayload(ensureActivityInfo(saved)),
        activityEntryInfo: this._adminBuildActivityEntryInfo(saved),
      });
    } catch (err) {
      logger.error(`[Admin] set activity entry: ${err.message}`);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  _applyGivePayloadToPlayer(player, body = {}) {
    return applyGivePayloadToPlayer(player, body);
  }

  async _adminRechargePlayer(req, res) {
    try {
      if (!this._requirePermission(req, res, 'recharge')) return;
      const Player = require('../db/models/Player');
      const recharge = require('../handlers/recharge');
      const body = ensurePlainObject(req.body);
      const userId = normalizeText(req.params.userId, 64);
      const amount = Math.max(0, Number(body.amount || 0));
      const player = await Player.findOne({ userId }).select('userId agentId').lean();
      if (!player) return res.status(404).json({ success: false, error: 'PLAYER_NOT_FOUND' });
      if (!this._canAccessPlayer(req, player)) {
        await this._recordAdminActionLog(req, {
          action: 'recharge_player',
          result: 'rejected',
          targetUserId: userId,
          targetAgentId: player.agentId,
          reason: 'FORBIDDEN',
          detail: { amount },
        });
        return res.status(403).json({ success: false, error: 'FORBIDDEN' });
      }
      if (!(amount > 0)) {
        return res.status(400).json({ success: false, error: 'INVALID_RECHARGE_AMOUNT' });
      }
      const limitValidation = await this._validateRechargeAmountByLimits(req, amount);
      if (!limitValidation.ok) {
        await this._recordAdminActionLog(req, {
          action: 'recharge_player',
          result: 'rejected',
          targetUserId: userId,
          targetAgentId: player.agentId,
          reason: limitValidation.error,
          detail: { amount, limit: limitValidation.limit || 0, used: limitValidation.used || 0 },
        });
        return res.status(403).json({ success: false, ...limitValidation });
      }

      const actor = this._buildSessionUser(req.adminSession);
      const orderId = body.orderId
        ? normalizeText(body.orderId, 64)
        : `manual_${actor.role}_${actor.username}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      const result = await recharge.handleRecharge({
        userId,
        orderId,
        amount,
        productId: normalizeText(body.productId || 'manual-admin-recharge', 64),
        channel: normalizeText(body.channel || `admin:${actor.role}:${actor.username}`, 64),
      }, this.wsServer);
      if (!result || result.success !== true) {
        const error = normalizeText(result && result.error, 64) || 'RECHARGE_FAILED';
        await this._recordAdminActionLog(req, {
          action: 'recharge_player',
          result: 'failure',
          targetUserId: userId,
          targetAgentId: player.agentId,
          reason: error,
          detail: { amount, orderId },
        });
        const status = error === 'PLAYER_NOT_FOUND' ? 404 : error === 'DUPLICATE_ORDER' ? 409 : 400;
        return res.status(status).json({ success: false, error });
      }
      await this._recordAdminActionLog(req, {
        action: 'recharge_player',
        result: 'success',
        targetUserId: userId,
        targetAgentId: player.agentId,
        reason: 'OK',
        detail: { amount, orderId, recharge: result.data || {} },
      });
      return res.json({ success: true, userId, recharge: result.data || {} });
    } catch (err) {
      logger.error(`[Admin] recharge: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminResetPlayerPassword(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const Player = require('../db/models/Player');
      const Account = require('../db/models/Account');
      const userId = normalizeText(req.params.userId, 64);
      const player = await Player.findOne({ userId }).select('userId name agentId').lean();
      if (!player) return res.status(404).json({ success: false, error: 'PLAYER_NOT_FOUND' });

      const account = await Account.findOne(
        { 'roles.userId': userId },
        { _id: 1, accountId: 1 }
      ).lean();
      if (!account) {
        await this._recordAdminActionLog(req, {
          action: 'reset_player_password',
          result: 'failure',
          targetUserId: userId,
          targetPlayerName: player.name,
          targetAgentId: player.agentId,
          reason: 'ACCOUNT_NOT_FOUND',
        });
        return res.status(404).json({ success: false, error: 'ACCOUNT_NOT_FOUND' });
      }

      const resetPassword = '123456';
      const passwordHash = await accountService.hashPassword(resetPassword);
      await Account.updateOne(
        { _id: account._id },
        { $set: { passwordHash } }
      );

      await this._recordAdminActionLog(req, {
        action: 'reset_player_password',
        result: 'success',
        targetUserId: userId,
        targetPlayerName: player.name,
        targetAgentId: player.agentId,
        reason: 'OK',
        detail: {
          accountId: normalizeText(account.accountId, 64),
          resetPassword,
        },
      });

      return res.json({
        success: true,
        userId,
        accountId: normalizeText(account.accountId, 64),
        password: resetPassword,
      });
    } catch (err) {
      logger.error(`[Admin] reset player password: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminUnlockAllSystems(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const Player = require('../db/models/Player');
      const userId = normalizeText(req.params.userId, 64);
      const p = await Player.findOne({ userId });
      if (!p) return res.status(404).json({ success: false, error: 'PLAYER_NOT_FOUND' });

      const allSystemIds = applyUnlockAllSystemsToPlayer(p);
      initializeUnlockedSystemData(p);

      await p.save();
      logger.info(`[Admin] unlock all systems for ${p.userId}`);

      const saved = p.toObject ? p.toObject() : p;
      this._pushAdminPlayerSync(p.userId, saved, [], {
        fields: [],
        mergeSystemUnlockInfo: true,
        initializePlayer: initializeUnlockedSystemData,
      });
      const roleMap = await this._adminLoadAccountRoleMap([p.userId]);
      return res.json({
        success: true,
        userId: p.userId,
        unlockedSystemCount: allSystemIds.length,
        player: this._adminBuildPlayerDetail(saved, roleMap.get(p.userId) || {}),
      });
    } catch (err) {
      logger.error(`[Admin] unlock all systems: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminNormalizePlayerOrb(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const Player = require('../db/models/Player');
      const { ensureArtifactInfo } = require('../handlers/artifact');
      const userId = normalizeText(req.params.userId, 64);
      const p = await Player.findOne({ userId });
      if (!p) return res.status(404).json({ success: false, error: 'PLAYER_NOT_FOUND' });

      const before = JSON.parse(JSON.stringify((p.artifactInfo && p.artifactInfo.orbInfo) || {}));
      p.artifactInfo = ensureArtifactInfo(p).artifactInfo || ensurePlainObject(p.artifactInfo);
      p.markModified('artifactInfo');
      await p.save();

      const saved = p.toObject ? p.toObject() : p;
      this._pushAdminPlayerSync(p.userId, saved, []);
      await this._recordAdminActionLog(req, {
        action: 'normalize_player_orb',
        result: 'success',
        targetUserId: p.userId,
        targetPlayerName: p.name,
        targetAgentId: p.agentId,
        reason: 'OK',
        detail: {
          before,
          after: (saved.artifactInfo && saved.artifactInfo.orbInfo) || {},
        },
      });

      return res.json({
        success: true,
        ok: true,
        userId: p.userId,
        orbInfo: (saved.artifactInfo && saved.artifactInfo.orbInfo) || {},
      });
    } catch (err) {
      logger.error(`[Admin] normalize orb: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminBatchUnlockAllSystems(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const Player = require('../db/models/Player');
      const body = ensurePlainObject(req.body);
      const userIds = Array.isArray(body.userIds)
        ? body.userIds.map((id) => normalizeText(id, 64)).filter(Boolean)
        : [];
      if (userIds.length <= 0) {
        return res.status(400).json({ success: false, error: 'EMPTY_USER_IDS' });
      }

      const allSystemIds = getAdminAllSystemIds();
      let successCount = 0;
      const updatedUserIds = [];
      const failed = [];

      for (const userId of userIds) {
        try {
          const p = await Player.findOne({ userId });
          if (!p) {
            failed.push({ userId, reason: 'PLAYER_NOT_FOUND' });
            continue;
          }
          applyUnlockAllSystemsToPlayer(p);
          initializeUnlockedSystemData(p);
          await p.save();
          const saved = p.toObject ? p.toObject() : p;
          this._pushAdminPlayerSync(p.userId, saved, [], {
            fields: [],
            mergeSystemUnlockInfo: true,
            initializePlayer: initializeUnlockedSystemData,
          });
          updatedUserIds.push(p.userId);
          successCount += 1;
        } catch (playerErr) {
          logger.warn(`[Admin] batch unlock skip ${userId}: ${playerErr.message}`);
          failed.push({ userId, reason: normalizeText(playerErr && playerErr.message, 128) || 'UNLOCK_FAILED' });
        }
      }

      logger.info(`[Admin] batch unlock all systems: ${successCount}/${userIds.length}`);
      return res.json({
        success: true,
        total: userIds.length,
        successCount,
        failedCount: failed.length,
        failed,
        unlockedSystemCount: allSystemIds.length,
        userIds: updatedUserIds,
      });
    } catch (err) {
      logger.error(`[Admin] batch unlock all systems: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminBatchGivePlayers(req, res) {
    try {
      if (!this._requirePermission(req, res, 'giveItems')) return;
      const Player = require('../db/models/Player');
      const body = ensurePlainObject(req.body);
      const userIds = Array.isArray(body.userIds)
        ? body.userIds.map((id) => normalizeText(id, 64)).filter(Boolean)
        : [];
      if (userIds.length <= 0) {
        return res.status(400).json({ success: false, error: 'EMPTY_USER_IDS' });
      }
      if (!(await this._assertBatchPlayerAccess(req, userIds))) {
        await this._recordAdminActionLog(req, {
          action: 'batch_give_players',
          result: 'rejected',
          reason: 'FORBIDDEN',
          detail: { userIds },
        });
        return res.status(403).json({ success: false, error: 'FORBIDDEN' });
      }
      const giveValidation = this._validateGivePayloadByLimits(req, body);
      if (!giveValidation.ok) {
        await this._recordAdminActionLog(req, {
          action: 'batch_give_players',
          result: 'rejected',
          reason: giveValidation.error,
          detail: { userIds, body, details: giveValidation.details || [] },
        });
        return res.status(403).json({ success: false, error: giveValidation.error, details: giveValidation.details || [] });
      }

      const givePayload = sanitizeGivePayload(body);
      let successCount = 0;

      for (const userId of userIds) {
        const p = await Player.findOne({ userId });
        if (!p) continue;
        const applied = this._applyGivePayloadToPlayer(p, givePayload);
        await p.save();
        const saved = p.toObject ? p.toObject() : p;
        this._pushAdminPlayerSync(p.userId, saved, applied.itemIds);
        successCount += 1;
      }

      await this._recordAdminActionLog(req, {
        action: 'batch_give_players',
        result: 'success',
        reason: 'OK',
        detail: { userIds, successCount, total: userIds.length, body },
      });
      return res.json({ success: true, total: userIds.length, successCount });
    } catch (err) {
      logger.error(`[Admin] batch give: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminResolveClearGameDataUserIds(body = {}) {
    const Player = require('../db/models/Player');
    const Account = require('../db/models/Account');
    const scope = normalizeText(body.scope, 16) || 'selected';
    const serverId = Math.max(0, toSafeInt(body.serverId, 0));

    if (scope === 'selected') {
      const userIds = Array.isArray(body.userIds)
        ? Array.from(new Set(body.userIds.map((id) => normalizeText(id, 64)).filter(Boolean)))
        : [];
      if (serverId <= 0 || userIds.length <= 0) return userIds;

      const accounts = await Account.find(
        { roles: { $elemMatch: { userId: { $in: userIds }, serverId } } },
        { roles: 1, _id: 0 }
      ).lean();
      const matched = new Set();
      accounts.forEach((account) => {
        (Array.isArray(account && account.roles) ? account.roles : []).forEach((role) => {
          const roleUserId = normalizeText(role && role.userId, 64);
          if (userIds.includes(roleUserId) && toSafeInt(role && role.serverId, 0) === serverId) {
            matched.add(roleUserId);
          }
        });
      });
      return Array.from(matched);
    }

    if (scope === 'server') {
      if (serverId <= 0) return [];
      const accounts = await Account.find({ 'roles.serverId': serverId }, { roles: 1, _id: 0 }).lean();
      const userIds = new Set();
      accounts.forEach((account) => {
        (Array.isArray(account && account.roles) ? account.roles : []).forEach((role) => {
          if (toSafeInt(role && role.serverId, 0) === serverId) {
            const userId = normalizeText(role && role.userId, 64);
            if (userId) userIds.add(userId);
          }
        });
      });
      return Array.from(userIds);
    }

    if (scope === 'all') {
      const rows = await Player.find({}).select('userId').lean();
      return rows.map((row) => normalizeText(row && row.userId, 64)).filter(Boolean);
    }

    return [];
  }

  async _adminClearPlayerGameData(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const body = ensurePlainObject(req.body);
      const scope = normalizeText(body.scope, 16) || 'selected';
      const serverId = Math.max(0, toSafeInt(body.serverId, 0));
      const confirmText = normalizeText(body.confirmText, 64);
      if (confirmText !== 'CLEAR_GAME_DATA') {
        return res.status(400).json({ success: false, error: 'CONFIRM_TEXT_REQUIRED' });
      }
      if (!['selected', 'server', 'all'].includes(scope)) {
        return res.status(400).json({ success: false, error: 'INVALID_SCOPE' });
      }
      if (scope === 'server' && serverId <= 0) {
        return res.status(400).json({ success: false, error: 'SERVER_ID_REQUIRED' });
      }

      const userIds = await this._adminResolveClearGameDataUserIds(body);
      if (userIds.length <= 0) {
        await this._recordAdminActionLog(req, {
          action: 'clear_player_game_data',
          result: 'rejected',
          reason: 'EMPTY_USER_IDS',
          detail: { scope, serverId },
        });
        return res.status(400).json({ success: false, error: 'EMPTY_USER_IDS' });
      }

      let successCount = 0;
      let clearedRoleCount = 0;
      const failed = [];
      for (const userId of userIds) {
        try {
          const saved = await playerService.resetPlayerGameData(userId, { reason: `admin:${scope}` });
          if (!saved) {
            failed.push({ userId, reason: 'PLAYER_NOT_FOUND' });
            continue;
          }
          clearedRoleCount += await this._adminRemoveAccountRolesByUserId(userId);
          this._pushAdminPlayerSync(userId, saved, []);
          successCount += 1;
        } catch (err) {
          failed.push({ userId, reason: err.message || 'RESET_FAILED' });
        }
      }

      await this._recordAdminActionLog(req, {
        action: 'clear_player_game_data',
        result: failed.length > 0 ? 'failure' : 'success',
        reason: failed.length > 0 ? 'PARTIAL_FAILED' : 'OK',
        detail: { scope, serverId, total: userIds.length, successCount, clearedRoleCount, failedCount: failed.length, failed: failed.slice(0, 20) },
      });

      return res.json({
        success: true,
        scope,
        serverId,
        total: userIds.length,
        successCount,
        clearedRoleCount,
        failedCount: failed.length,
        failed,
      });
    } catch (err) {
      logger.error(`[Admin] clear player game data: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminDeletePlayer(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const Player = require('../db/models/Player');
      const userId = normalizeText(req.params.userId, 64);
      const existing = await Player.findOne({ userId }).select('userId').lean();
      if (!existing) return res.status(404).json({ success: false, error: 'PLAYER_NOT_FOUND' });

      await Player.deleteOne({ userId });
      await this._adminRemoveAccountRolesByUserId(userId);
      logger.info(`[Admin] deleted ${userId}`);
      res.json({ success: true, deleted: userId });
    } catch (err) {
      logger.error(`[Admin] delete: ${err.message}`);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminGetServerStats(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const Account  = require('../db/models/Account');
      const Session  = require('./Session');
      const serverConfigService = require('../services/ServerConfigService');

      // All servers from Mongo-backed config
      const allServers = await serverConfigService.listAllServers();

      // Count roles per serverId from Account model
      const accounts = await Account.find({}).select('roles').lean();
      const roleCounts  = {};   // total registered roles
      const recentCount = {};   // logged in within 7 days
      const sevenDaysAgo = Date.now() - 7 * 86400 * 1000;

      accounts.forEach((acc) => {
        (acc.roles || []).forEach((role) => {
          const sid = String(role.serverId || 1001);
          roleCounts[sid]  = (roleCounts[sid]  || 0) + 1;
          if ((role.lastLoginTime || 0) > sevenDaysAgo) {
            recentCount[sid] = (recentCount[sid] || 0) + 1;
          }
        });
      });

      // Online count total (Redis)
      let onlineTotal = 0;
      try { onlineTotal = await Session.getOnlineCount(); } catch (_e) {}

      const serverData = allServers.map((s) => {
        const sid = String(s.serverId);
        return {
          serverId:     s.serverId,
          serverName:   s.serverName,
          pageId:       Number(s.pageId) || Math.floor(s.serverId / 1000),
          pageName:     s.pageName || '',
          isNew:        !!s.isNew,
          isRecommend:  !!s.isRecommend,
          status:       Number.isFinite(Number(s.status)) && Number(s.status) >= 0 ? Math.floor(Number(s.status)) : 1,
          running:      s.running !== false,
          openTime:     Number(s.openTime) || 0,
          online:       0,
          totalPlayers: roleCounts[sid]  || 0,
          recentActive: recentCount[sid] || 0,
        };
      });

      // Group by page
      const pages = {};
      serverData.forEach((s) => {
        const pg = s.pageId;
        if (!pages[pg]) {
          pages[pg] = {
            pageId: pg,
            pageName: s.pageName || '',
            servers: [],
            totalPlayers: 0,
            recentActive: 0,
            online: 0,
          };
        }
        pages[pg].servers.push(s);
        pages[pg].totalPlayers += s.totalPlayers;
        pages[pg].recentActive += s.recentActive;
        pages[pg].online += s.online;
      });

      res.json({
        success: true,
        onlineTotal,
        totalAccounts: accounts.length,
        totalRoles:    Object.values(roleCounts).reduce((a, b) => a + b, 0),
        pages: Object.values(pages).sort((a, b) => a.pageId - b.pageId),
        servers: serverData,
      });
    } catch (err) {
      logger.error(`[Admin] server stats: ${err.message}`);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminCreateServer(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const serverConfigService = require('../services/ServerConfigService');
      const server = await serverConfigService.createServer(ensurePlainObject(req.body));
      res.json({ success: true, server });
    } catch (err) {
      if (err && (err.code === 11000 || err.message === 'SERVER_ID_DUPLICATE')) {
        return res.status(409).json({ success: false, error: 'SERVER_ID_DUPLICATE' });
      }
      if (err && (err.message === 'INVALID_SERVER_ID' || err.message === 'INVALID_PAGE_ID')) {
        return res.status(400).json({ success: false, error: err.message });
      }
      logger.error(`[Admin] create server: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminUpdateServer(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const serverConfigService = require('../services/ServerConfigService');
      const serverId = toSafeInt(req.params.serverId, 0);
      if (serverId <= 0) return res.status(400).json({ success: false, error: 'INVALID_SERVER_ID' });

      const server = await serverConfigService.updateServer(serverId, ensurePlainObject(req.body));
      return res.json({ success: true, server });
    } catch (err) {
      if (err && err.message === 'SERVER_NOT_FOUND') {
        return res.status(404).json({ success: false, error: 'SERVER_NOT_FOUND' });
      }
      if (err && (err.code === 11000 || err.message === 'SERVER_ID_DUPLICATE')) {
        return res.status(409).json({ success: false, error: 'SERVER_ID_DUPLICATE' });
      }
      if (err && (err.message === 'INVALID_SERVER_ID' || err.message === 'INVALID_PAGE_ID')) {
        return res.status(400).json({ success: false, error: err.message });
      }
      logger.error(`[Admin] update server: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  async _adminDeleteServer(req, res) {
    try {
      if (!this._requireSuperAdmin(req, res)) return;
      const serverId = toSafeInt(req.params.serverId, 0);
      if (serverId <= 0) return res.status(400).json({ success: false, error: 'INVALID_SERVER_ID' });

      const Account = require('../db/models/Account');
      const serverConfigService = require('../services/ServerConfigService');
      const accounts = await Account.find(
        { 'roles.serverId': serverId },
        { roles: 1, _id: 0 }
      ).lean();
      const roleCount = accounts.reduce((sum, accountRow) => (
        sum + (Array.isArray(accountRow && accountRow.roles)
          ? accountRow.roles.filter((role) => toSafeInt(role && role.serverId, 0) === serverId).length
          : 0)
      ), 0);
      if (roleCount > 0) {
        return res.status(409).json({ success: false, error: 'SERVER_NOT_EMPTY', roleCount });
      }

      await serverConfigService.deleteServer(serverId);
      return res.json({ success: true, serverId });
    } catch (err) {
      if (err && err.message === 'SERVER_NOT_FOUND') {
        return res.status(404).json({ success: false, error: 'SERVER_NOT_FOUND' });
      }
      if (err && err.message === 'INVALID_SERVER_ID') {
        return res.status(400).json({ success: false, error: 'INVALID_SERVER_ID' });
      }
      logger.error(`[Admin] delete server: ${err.message}`);
      return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 启动 HTTP 服务端。
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        logger.info(`[HTTPServer] 已启动 http://0.0.0.0:${this.port}`);
        resolve();
      });
      this.server.on('error', (err) => {
        logger.error(`[HTTPServer] 启动失败: ${err.message}`);
        reject(err);
      });
    });
  }

  /**
   * 停止 HTTP 服务端。
   */
  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      logger.info('[HTTPServer] stopped');
    }
  }
}

module.exports = HTTPServer;
