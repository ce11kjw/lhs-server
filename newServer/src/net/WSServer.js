/**
 * WSServer - WebSocket 服务端。
 * 处理客户端连接、消息解包、路由分发和响应发送。
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const WebSocket = require('ws');
const mongo = require('../db/mongo');
const redis = require('../db/redis');
const { PacketManager } = require('../protocol');
const router = require('../router');
const Session = require('./Session');
const logger = require('../logger');
const tagMetrics = require('../services/TagMetricsService');
const { STUB_TAGS } = require('../handlers/stubs');
const playerService = require('../services/PlayerService');
const runtimeConfig = require('../runtimeConfig');
const { refreshMainTaskProgress } = require('../services/MainTaskProgressService');
const { refreshRealmStageTasks } = require('../services/RealmTaskProgressService');
const { getTaskPerfSnapshot, runWithTaskPerfScope } = require('../services/TaskPerfService');
const { consumeTaskDirty, getTaskDirtyIds, getTaskRevision } = require('../services/TaskDirtyService');
const { checkLevelUp } = require('../handlers/raid');
const { syncSessionPlayerFields } = require('../services/SessionPlayerSyncService');

const STUB_TAG_SET = new Set((Array.isArray(STUB_TAGS) ? STUB_TAGS : []).map((tag) => Number(tag)));

// These handlers already maintain and, where necessary, push task deltas
// themselves. Re-running the full task normalizer here made common inventory
// actions wait hundreds of milliseconds before their ACK, blocking the
// per-connection message queue and freezing the client's action state.
const HANDLER_OWNS_TASK_REFRESH_TAGS = new Set([
  1000, // task claim compatibility handler
  10001, // system-unlock query (read/cache + async save only)
  2000, // box open updates bagel/task counters in the handler
  2001, // box reward does not change task counters
  2002, // box speed toggle is state-only and persists asynchronously
  2200, // equip replace refreshes and pushes task delta in the handler
  2201, // equip sale refreshes and pushes task delta in the handler
  2300, // mainline start defers task synchronization to the 2301 settlement
  4505, // double-tower settlement is not a mainline task transition
  6713, // homeland message list is read-only
]);

function buildTaskPushPackets(player, taskIds = []) {
  if (!player || typeof player !== 'object') return [];
  try {
    const task = require('../handlers/task');
    if (taskIds.length > 0 && task && typeof task.buildTaskUpdatePacketsByIds === 'function') {
      return task.buildTaskUpdatePacketsByIds(player, taskIds, 0);
    }
    if (task && typeof task.buildActiveTaskUpdatePackets === 'function') {
      return task.buildActiveTaskUpdatePackets(player, 0, { includeAllTypes: true });
    }
  } catch (_err) {}
  return [];
}

function getMatchingResultTaskIds(result, player) {
  const matchingIds = new Set();
  const list = Array.isArray(result) ? result : [result];
  list.forEach((packet) => {
    if (Number(packet && packet.tag) !== 1000 || !packet || !packet.data || !packet.data.task) return;
    const sentTask = packet.data.task || {};
    const taskId = Number(sentTask.id) || 0;
    const currentTask = taskId > 0 ? getCurrentTaskById(player, taskId) : null;
    if (!currentTask) return;
    if (
      Number(sentTask.status) === Number(currentTask.status)
      && Number(sentTask.progress) === Number(currentTask.progress)
      && Number(sentTask.target) === Number(currentTask.target)
      && Number(sentTask.type) === Number(currentTask.type)
    ) {
      matchingIds.add(taskId);
    }
  });
  return matchingIds;
}

function getCurrentTaskById(player, taskId) {
  const taskInfo = player && player.taskInfo && typeof player.taskInfo === 'object' ? player.taskInfo : {};
  const tasks = taskInfo.tasks && typeof taskInfo.tasks === 'object' && !Array.isArray(taskInfo.tasks) ? taskInfo.tasks : {};
  const direct = tasks[String(taskId)] || tasks[taskId];
  if (direct && typeof direct === 'object') return direct;

  const tasksMap = taskInfo.tasksMap && typeof taskInfo.tasksMap === 'object' && !Array.isArray(taskInfo.tasksMap)
    ? taskInfo.tasksMap
    : {};
  for (const typeKey of Object.keys(tasksMap)) {
    const list = Array.isArray(tasksMap[typeKey]) ? tasksMap[typeKey] : [];
    const found = list.find((task) => Number(task && task.id) === Number(taskId));
    if (found) return found;
  }
  return null;
}

function resultTaskPacketsMatchPlayer(result, player) {
  const list = Array.isArray(result) ? result : [result];
  const taskPackets = list.filter((packet) => Number(packet && packet.tag) === 1000 && packet && packet.data && packet.data.task);
  if (taskPackets.length <= 0) return false;
  return getMatchingResultTaskIds(result, player).size === taskPackets.length;
}

function formatTaskPerfKinds(taskPushKinds = {}) {
  const parts = Object.keys(taskPushKinds)
    .sort()
    .map((key) => `${key}:${taskPushKinds[key]}`);
  return parts.length > 0 ? parts.join(',') : 'none';
}

function estimateBatchBytes(messages = []) {
  return (Array.isArray(messages) ? messages : []).reduce((total, msg) => {
    if (!msg || msg.tag === undefined) return total;
    try {
      return total + Buffer.byteLength(JSON.stringify({
        tag: msg.tag,
        msgUid: msg.msgUid || 0,
        data: msg.data || {},
      }), 'utf8');
    } catch (_err) {
      return total + 1024;
    }
  }, 0);
}

function parseEnabled(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getSourceRevision() {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0, 12);
  } catch (_err) {
    return 'unknown';
  }
}

function withDeadline(promise, timeoutMs, label) {
  let timer = null;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timeout after ${timeoutMs}ms`);
      err.code = 'WS_CLEANUP_TIMEOUT';
      reject(err);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class WSServer {
  /**
   * @param {Object} options
   * @param {number} options.port - 监听端口（默认 9200）
   */
  constructor(options = {}) {
    this.port = options.port || 9200;
    this.host = options.host || process.env.WS_HOST || '0.0.0.0';
    this.tls = options.tls || null;
    this.maxMsgsPerSec = Number(options.maxMsgsPerSec || process.env.WS_MAX_MSGS_PER_SEC || 500);
    this.handlerStuckWarnMs = Math.max(
      1000,
      Number(options.handlerStuckWarnMs || process.env.WS_HANDLER_STUCK_WARN_MS || 3000) || 3000
    );
    this.handlerTimeoutMs = Math.max(
      this.handlerStuckWarnMs + 1000,
      Number(options.handlerTimeoutMs || process.env.WS_HANDLER_TIMEOUT_MS || 15000) || 15000
    );
    this.handlerPendingLogIntervalMs = Math.max(
      5000,
      Number(
        options.handlerPendingLogIntervalMs
        || process.env.WS_HANDLER_PENDING_LOG_INTERVAL_MS
        || 15000
      ) || 15000
    );
    // The official Egret client does not reliably recover after a server-side
    // close. A handler deadline is diagnostic by default; storage operations
    // have their own bounded timeouts and must settle before the next mutation.
    this.closeOnHandlerTimeout = parseEnabled(
      options.closeOnHandlerTimeout ?? process.env.WS_CLOSE_ON_HANDLER_TIMEOUT,
      false
    );
    this.queueWarnDepth = Math.max(
      2,
      Number(options.queueWarnDepth || process.env.WS_QUEUE_WARN_DEPTH || 8) || 8
    );
    this.bufferedAmountWarnBytes = Math.max(
      65536,
      Number(options.bufferedAmountWarnBytes || process.env.WS_BUFFERED_AMOUNT_WARN_BYTES || 1048576) || 1048576
    );
    this.heartbeatIntervalMs = Math.max(
      5000,
      Number(options.heartbeatIntervalMs || process.env.WS_HEARTBEAT_INTERVAL_MS || 30000) || 30000
    );
    this.sendCallbackWarnMs = Math.max(
      1000,
      Number(options.sendCallbackWarnMs || process.env.WS_SEND_CALLBACK_WARN_MS || 3000) || 3000
    );
    this.closeQueueDrainMs = Math.max(
      1000,
      Number(options.closeQueueDrainMs || process.env.WS_CLOSE_QUEUE_DRAIN_MS || 3000) || 3000
    );
    this.traceTags = new Set(
      String(options.traceTags ?? process.env.WS_TRACE_TAGS ?? '')
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0)
    );
    this.finalSaveWaitMs = Math.max(
      5000,
      (Number(options.finalSaveWaitMs || process.env.PLAYER_SAVE_TIMEOUT_MS || 20000) || 20000) + 1000
    );
    this.closeDuplicateLogin = String(
      options.closeDuplicateLogin ?? process.env.WS_CLOSE_DUPLICATE_LOGIN ?? '1'
    ) === '1';
    this.enableLoginMapFallback = String(
      options.enableLoginMapFallback ?? process.env.WS_ENABLE_LOGIN_MAP_FALLBACK ?? '0'
    ) === '1';
    this.loginMapFallbackDelayMs = Number(
      options.loginMapFallbackDelayMs ?? process.env.WS_LOGIN_MAP_FALLBACK_DELAY_MS ?? 1200
    );
    if (!Number.isFinite(this.loginMapFallbackDelayMs) || this.loginMapFallbackDelayMs < 0) {
      this.loginMapFallbackDelayMs = 1200;
    }
    this.httpServer = null;
    this.wss = null;
    this._heartbeatTimer = null;
    this._runtimeStartedAt = Date.now();
    this._sourceRevision = getSourceRevision();
    // wsId -> { ws, session } mapping, used for active push messages
    this.clients = new Map();
    this._nextWsId = 1;
  }

  /**
   * 启动 WebSocket 服务端。
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      const requestHandler = async (req, res) => {
        const isWebSocketUpgrade = String(req.headers.upgrade || '').toLowerCase() === 'websocket';
        const corsState = runtimeConfig.applyCorsHeaders(req, res);
        if (req.headers.origin && !corsState.allowed && !(isWebSocketUpgrade && !runtimeConfig.isProduction)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'CORS_ORIGIN_DENIED' }));
          return;
        }

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ok',
              role: 'ws',
              runtime: {
                revision: this._sourceRevision,
                pid: process.pid,
                pmId: process.env.pm_id ?? null,
                instanceId: process.env.NODE_APP_INSTANCE ?? process.env.PM2_INSTANCE_ID ?? null,
                cwd: process.cwd(),
                startedAt: new Date(this._runtimeStartedAt).toISOString(),
                uptimeSec: Math.floor((Date.now() - this._runtimeStartedAt) / 1000),
                clients: this.clients.size,
                handlerStuckWarnMs: this.handlerStuckWarnMs,
                handlerTimeoutMs: this.handlerTimeoutMs,
                closeOnHandlerTimeout: this.closeOnHandlerTimeout,
                finalSaveWaitMs: this.finalSaveWaitMs,
                traceTags: Array.from(this.traceTags).sort((a, b) => a - b),
              },
              timestamp: new Date().toISOString(),
            })
          );
          return;
        }

        if (req.url === '/ready') {
          const checks = {
            mongo: mongo.isConnected(),
            redis: await redis.isConnected(),
          };
          const ok = checks.mongo && checks.redis;
          res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: ok ? 'ok' : 'degraded',
              role: 'ws',
              checks,
              timestamp: new Date().toISOString(),
            })
          );
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('LHS Game Server Running');
      };

      this.httpServer = this.tls && this.tls.key && this.tls.cert
        ? https.createServer({
            key: fs.readFileSync(this.tls.key),
            cert: fs.readFileSync(this.tls.cert),
            ca: this.tls.ca ? fs.readFileSync(this.tls.ca) : undefined,
          }, requestHandler)
        : http.createServer(requestHandler);

      this.wss = new WebSocket.Server({
        server: this.httpServer,
        verifyClient: (info, done) => {
          if (!runtimeConfig.isProduction) {
            done(true);
            return;
          }
          if (runtimeConfig.isWsOriginAllowed(info.origin)) {
            done(true);
            return;
          }
          done(false, 403, 'Origin not allowed');
        },
      });
      this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
      this.wss.on('error', (err) => {
        logger.error(`[WSServer] runtime error: ${err.message}`);
        reject(err);
      });

      this.httpServer.on('error', (err) => {
        logger.error(`[WSServer] 启动失败: ${err.message}`);
        reject(err);
      });

      this.httpServer.listen(this.port, this.host, () => {
        this._startHeartbeatWatchdog();
        // Keep one deployment fingerprint visible even when LOG_LEVEL=warn.
        logger.warn(
          `[WSServer] runtime ready revision=${this._sourceRevision} pid=${process.pid} `
          + `pmId=${process.env.pm_id ?? 'none'} cwd=${process.cwd()} `
          + `handlerWarn=${this.handlerStuckWarnMs}ms handlerDeadline=${this.handlerTimeoutMs}ms `
          + `closeOnTimeout=${this.closeOnHandlerTimeout ? 'on' : 'off'}`
        );
        logger.info(
          `[WSServer] ${this.tls && this.tls.key && this.tls.cert ? 'wss' : 'ws'}://${this.host}:${this.port}`
          + ` rateLimit=${this.maxMsgsPerSec}/s`
          + ` mapFallback=${this.enableLoginMapFallback ? 'on' : 'off'}`
          + ` delay=${this.loginMapFallbackDelayMs}ms`
        );
        resolve();
      });
    });
  }

  /**
   * 停止 WebSocket 服务端。
   */
  async stop() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    // 关闭所有连接。
    for (const [_wsId, { ws }] of this.clients) {
      ws.close();
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
    }
    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(resolve));
    }
    logger.info('[WSServer] stopped');
  }

  /**
   * 处理新连接。
   */
  _onConnection(ws, req) {
    // Defensive init: avoid crash if constructor state is unexpectedly missing.
    if (!this.clients) {
      this.clients = new Map();
      logger.warn('[WSServer] clients map was missing and has been re-initialized');
    }
    if (typeof this._nextWsId !== 'number') {
      this._nextWsId = 1;
    }

    const wsId = this._nextWsId++;
    const remoteAddr = req.socket.remoteAddress;

    // 连接级会话上下文，仅保存在内存中。
    const session = {
      wsId,
      userId: null,
      player: null,
      _rateCount: 0,       // 频率限制计数
      _rateResetTime: 0,   // 计数重置时间
      _responseCache: new Map(),
      _queueDepth: 0,
      _queueSequence: 0,
      _closing: false,
      _closingDropLogged: false,
      _activeRequest: null,
      _lastReceiveAt: Date.now(),
      _lastSendAt: 0,
      _mapEnterSeen: false,
      _lastMapEnterAt: 0,
      _mapId: 0,
      _mapLine: 0,
      _mapPos: null,
      _mapSelfInfo: null,
      _fishRoomMapId: 0,
      // Keep requests on one connection in protocol order. Handlers mutate
      // the shared lean player object, so overlapping async handlers can
      // otherwise persist stale snapshots and race their push responses.
      _messageQueue: Promise.resolve(),
      remoteAddr,
      _broadcastExceptUser: (tag, data) => this.broadcastExceptUser(session.userId, tag, data),
      _broadcastMapExceptUser: (tag, data) => this.broadcastMapExceptUser(
        session.userId,
        session._mapId,
        session._mapLine,
        tag,
        data
      ),
      _getMapPlayers: (mapId, line) => this.getMapPlayers(session.userId, mapId, line),
    };

    this.clients.set(wsId, { ws, session });
    ws._lhsSession = session;
    logger.info(`[WSServer] 新连接 #${wsId} from ${remoteAddr}`);

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (rawData) => this._onMessage(ws, rawData, session));

    ws.on('close', (code, reason) => {
      this.clients.delete(wsId);
      this._onSocketClosed(session, wsId, code, reason).catch((err) => {
        logger.error(`[WSServer] close handler failed #${wsId}: ${err.message}`);
      });
    });

    ws.on('error', (err) => {
      logger.error(`[WSServer] 连接 #${wsId} 错误: ${err.message}`);
    });
  }

  _startHeartbeatWatchdog() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      for (const [wsId, item] of this.clients) {
        const ws = item && item.ws;
        const session = item && item.session;
        if (!ws || ws.readyState !== WebSocket.OPEN) continue;
        if (ws.isAlive === false) {
          logger.warn(
            `[WSServer] heartbeat timeout ws#${wsId} `
            + `user=${session && session.userId ? session.userId : 'unknown'}`
          );
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch (err) {
          logger.warn(`[WSServer] heartbeat ping failed ws#${wsId}: ${err.message}`);
          ws.terminate();
        }
      }
    }, this.heartbeatIntervalMs);
    if (typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
  }

  /**
   * 处理收到的消息。
   */
  _onMessage(ws, rawData, session) {
    try {
      session._lastReceiveAt = Date.now();
      const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
      if (buf.length < 12) {
        logger.warn('[WSServer] message too short, skipped');
        return;
      }

      // Frequency limit: keep high enough for client login burst (many init tags).
      const now = Date.now();
      if (now - session._rateResetTime > 1000) {
        session._rateCount = 0;
        session._rateResetTime = now;
      }
      session._rateCount++;
      if (session._rateCount > this.maxMsgsPerSec) {
        logger.warn(`[WSServer] connection #${session.wsId} rate limited, dropped`);
        return;
      }

      const decoded = PacketManager.unpackClient(buf);

      if (Array.isArray(decoded)) {
        for (const msg of decoded) {
          if (msg && msg.tag !== undefined) {
            this._enqueueMessage(ws, msg, session);
          }
        }
      } else if (decoded && typeof decoded === 'object' && decoded.tag !== undefined) {
        this._enqueueMessage(ws, decoded, session);
      }
    } catch (err) {
      logger.error(`[WSServer] 处理消息失败: ${err.message}`);
    }
  }

  _enqueueMessage(ws, msg, session) {
    if (!session) return;
    if (session._closing) {
      if (!session._closingDropLogged) {
        session._closingDropLogged = true;
        logger.warn(
          `[WSServer] message received while closing ws#${session.wsId} `
          + `tag=${Number(msg && msg.tag) || 0} msgUid=${Number(msg && msg.msgUid) || 0}`
        );
      }
      return;
    }
    const queuedAt = Date.now();
    const sequence = ++session._queueSequence;
    session._queueDepth += 1;
    if (session._queueDepth >= this.queueWarnDepth) {
      logger.warn(
        `[WSServer] queue backlog ws#${session.wsId} depth=${session._queueDepth} `
        + `tag=${Number(msg && msg.tag) || 0} msgUid=${Number(msg && msg.msgUid) || 0}`
      );
    }
    const previous = session._messageQueue && typeof session._messageQueue.then === 'function'
      ? session._messageQueue
      : Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        if (session._closing) return;
        const queueWaitMs = Date.now() - queuedAt;
        if (queueWaitMs >= this.handlerStuckWarnMs) {
          logger.warn(
            `[WSServer] queue wait ws#${session.wsId} seq=${sequence} depth=${session._queueDepth} `
            + `tag=${Number(msg && msg.tag) || 0} msgUid=${Number(msg && msg.msgUid) || 0} `
            + `wait=${queueWaitMs}ms`
          );
        }
        await this._handleSingleMessage(ws, msg, session);
      })
      .finally(() => {
        session._queueDepth = Math.max(0, session._queueDepth - 1);
      });
    session._messageQueue = current.catch((err) => {
      logger.error(`[WSServer] queued message failed: ${err && err.message ? err.message : err}`);
    });
  }

  /**
   * 处理单条消息，支持同步和异步 handler。
   */
  async _handleSingleMessage(ws, msg, session) {
    const safeTag = Number(msg && msg.tag);
    await runWithTaskPerfScope({
      tag: safeTag,
      msgUid: Number(msg && msg.msgUid) || 0,
      userId: session && session.userId ? session.userId : '',
      wsId: session && session.wsId ? session.wsId : 0,
    }, async () => {
      try {
        const startedAt = Date.now();
        const requestMsgUid = Number(msg && msg.msgUid) || 0;
        const responseCacheKey = requestMsgUid > 0 ? `${safeTag}:${requestMsgUid}` : '';
        const beforeLevel = session.player ? Number(session.player.level) || 1 : null;
        const beforeExp = session.player ? Number(session.player.exp) || 0 : null;
        const beforeTaskRevision = getTaskRevision(session.player);
        const fallbackLike = !router.hasHandler(safeTag) || STUB_TAG_SET.has(safeTag);
        tagMetrics.recordRequest(safeTag);
        let shouldSaveAfterResponse = false;

        logger.info(
          `[WSServer] handler enter ws#${session.wsId} tag=${safeTag} msgUid=${requestMsgUid} `
          + `queueDepth=${session._queueDepth}`
        );
        if (this.traceTags.has(safeTag)) {
          logger.warn(
            `[WSTrace] request ws#${session.wsId} tag=${safeTag} msgUid=${requestMsgUid} `
            + `user=${session.userId || 'unknown'} queueDepth=${session._queueDepth} `
            + `dataKeys=${msg.data && typeof msg.data === 'object' ? Object.keys(msg.data).join(',') : 'none'}`
          );
        }

        // WebSocket already delivers frames in order. If the client retries an
        // RPC, replay the completed response instead of silently dropping the
        // duplicate and leaving its callback pending forever.
        if (responseCacheKey && session._responseCache.has(responseCacheKey)) {
          logger.warn(
            `[WSServer] replay cached response ws#${session.wsId} tag=${safeTag} msgUid=${requestMsgUid}`
          );
          this.sendResponse(ws, session._responseCache.get(responseCacheKey));
          return;
        }
        if (msg.tag === 1400) {
          const nowMs = Date.now();
          if (session._lastMapEnterAt && (nowMs - session._lastMapEnterAt) < 1500) {
            session._mapEnterSeen = true;
            logger.info(
              `[WSServer] skip rapid duplicate tag=1400 ws#${session.wsId} `
              + `delta=${nowMs - session._lastMapEnterAt}ms`
            );
            return;
          }
          session._lastMapEnterAt = nowMs;
        }

        let stuckTimer = null;
        let timeoutTimer = null;
        let pendingTimer = null;
        const routePromise = Promise.resolve().then(() => router.route(msg.tag, msg.msgUid, msg.data, session));
        session._activeRequest = {
          tag: safeTag,
          msgUid: requestMsgUid,
          sequence: session._queueSequence,
          startedAt,
        };
        stuckTimer = setTimeout(() => {
          logger.warn(
            `[WSServer] handler stuck ws#${session.wsId} tag=${safeTag} msgUid=${requestMsgUid} `
            + `user=${session.userId || 'unknown'} elapsed=${Date.now() - startedAt}ms `
            + `queueDepth=${session._queueDepth}`
          );
        }, this.handlerStuckWarnMs);
        timeoutTimer = setTimeout(() => {
          logger.error(
            `[WSServer] handler deadline exceeded ws#${session.wsId} tag=${safeTag} `
            + `msgUid=${requestMsgUid} user=${session.userId || 'unknown'} `
            + `elapsed=${Date.now() - startedAt}ms queueDepth=${session._queueDepth} `
            + `action=${this.closeOnHandlerTimeout ? 'close' : 'keep-waiting'}`
          );
          if (this.closeOnHandlerTimeout) {
            session._closing = true;
            this.sendResponse(ws, {
              tag: msg.tag,
              msgUid: msg.msgUid,
              data: { result: -1, msg: 'request timeout' },
            });
            try {
              ws.close(1011, 'handler timeout');
            } catch (_err) {}
          }
        }, this.handlerTimeoutMs);
        pendingTimer = setInterval(() => {
          logger.warn(
            `[WSServer] handler still pending ws#${session.wsId} tag=${safeTag} `
            + `msgUid=${requestMsgUid} user=${session.userId || 'unknown'} `
            + `elapsed=${Date.now() - startedAt}ms queueDepth=${session._queueDepth} `
            + `socketState=${ws.readyState}`
          );
        }, this.handlerPendingLogIntervalMs);
        if (typeof stuckTimer.unref === 'function') stuckTimer.unref();
        if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
        if (typeof pendingTimer.unref === 'function') pendingTimer.unref();
        let result;
        try {
          // Preserve mutation order. Promise.race previously let a timed-out
          // handler continue in the background while poisoning the session and
          // silently dropping every later client request.
          result = await routePromise;
        } finally {
          if (stuckTimer) clearTimeout(stuckTimer);
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (pendingTimer) clearInterval(pendingTimer);
          if (session._activeRequest && session._activeRequest.startedAt === startedAt) {
            session._activeRequest = null;
          }
        }
        tagMetrics.recordSuccess(safeTag, { fallbackHit: fallbackLike });
        if (msg.tag === 1 && session.userId) {
          this._closeDuplicateConnections(session.userId, session.wsId);
        }
        if (msg.tag === 1400) {
          session._mapEnterSeen = true;
        }
        logger.info(`[WSServer] C->S tag=${msg.tag} msgUid=${msg.msgUid} dataKeys=${msg.data ? Object.keys(msg.data).join(',') : 'null'}`);
        if (result) {
          if (responseCacheKey) {
            const responseForReplay = Array.isArray(result)
              ? result.find((packet) => (
                  Number(packet && packet.tag) === safeTag
                  && Number(packet && packet.msgUid) === requestMsgUid
                ))
              : result;
            if (responseForReplay) {
              session._responseCache.set(responseCacheKey, responseForReplay);
            }
            while (session._responseCache.size > 100) {
              const oldestKey = session._responseCache.keys().next().value;
              session._responseCache.delete(oldestKey);
            }
          }
          let pendingTaskPackets = [];
          const handlerOwnsTaskRefresh = HANDLER_OWNS_TASK_REFRESH_TAGS.has(safeTag);
          if (beforeLevel != null && session.player && msg.tag !== 1 && !handlerOwnsTaskRefresh) {
            checkLevelUp(session.player);
            refreshMainTaskProgress(session.player);
            refreshRealmStageTasks(session.player);
          }
          if (session.player && msg.tag !== 1) {
            const afterTaskRevision = getTaskRevision(session.player);
            const playerProgressChanged = beforeLevel != null && (
              (Number(session.player.level) || 1) !== beforeLevel
              || (Number(session.player.exp) || 0) !== beforeExp
            );
            const taskRevisionChanged = afterTaskRevision !== beforeTaskRevision;
            const dirtyTaskIds = taskRevisionChanged ? getTaskDirtyIds(session.player) : [];
            const resultTaskIds = getMatchingResultTaskIds(result, session.player);
            const pendingTaskIds = dirtyTaskIds.filter((taskId) => !resultTaskIds.has(taskId));
            const resultHasCurrentTaskPackets = resultTaskPacketsMatchPlayer(result, session.player);
            if (taskRevisionChanged && (pendingTaskIds.length > 0 || (dirtyTaskIds.length <= 0 && !resultHasCurrentTaskPackets))) {
              pendingTaskPackets = buildTaskPushPackets(session.player, pendingTaskIds);
              logger.info(
                `[WSServer] task-refresh tag=${msg.tag} msgUid=${msg.msgUid} `
                + `beforeLevel=${beforeLevel} afterLevel=${Number(session.player.level) || 1} `
                + `dirtyTaskIds=${dirtyTaskIds.join(',') || 'fallback'} `
                + `taskPacketCount=${pendingTaskPackets.length}`
              );
            }
            if ((taskRevisionChanged || playerProgressChanged) && session.userId) {
              if (taskRevisionChanged) {
                consumeTaskDirty(session.player);
              }
              shouldSaveAfterResponse = true;
            }
          }

          this.sendResponse(ws, result);
          if (beforeLevel != null && session.player) {
            const afterLevel = Number(session.player.level) || 1;
            const afterExp = Number(session.player.exp) || 0;
            if (afterLevel !== beforeLevel) {
              this.sendResponse(ws, {
                tag: 501,
                msgUid: 0,
                data: { level: afterLevel, exp: afterExp },
              });
            }
          }
          if (pendingTaskPackets.length > 0) {
            this.sendResponse(ws, pendingTaskPackets);
          }

          const handlerPersistedPlayer = typeof playerService.wasRecentlySaved === 'function'
            && playerService.wasRecentlySaved(session.player, startedAt);
          if (shouldSaveAfterResponse && !handlerPersistedPlayer && session.userId && session.player) {
            playerService.savePlayer(session.userId, session.player).catch((err) => {
              logger.warn(`[WSServer] async save failed tag=${safeTag} user=${session.userId}: ${err.message}`);
            });
          }

          // 登录成功后执行可选的地图初始化兜底。
          if (msg.tag === 1 && Array.isArray(result)) {
            const basic = require('../handlers/basic');
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                // Fallback map init only when client did not explicitly send tag=1400.
                // This is optional and disabled by default to avoid duplicate enter-map races.
                if (this.enableLoginMapFallback && !session._mapEnterSeen) {
                  logger.info(`[WSServer] fallback push tag=1400 for ws#${session.wsId}`);
                  this.sendResponse(ws, basic.handleEnterMap({}, session, 0));
                }
                this.sendResponse(ws, basic.getHorseRaceInit());
              }
            }, this.loginMapFallbackDelayMs);
          }
        }
        const elapsed = Date.now() - startedAt;
        if (this.traceTags.has(safeTag)) {
          const resultList = Array.isArray(result) ? result : (result ? [result] : []);
          const responseTags = resultList
            .filter((packet) => packet && packet.tag !== undefined)
            .map((packet) => `${Number(packet.tag) || 0}:${Number(packet.msgUid) || 0}`)
            .slice(0, 24)
            .join(',');
          logger.warn(
            `[WSTrace] complete ws#${session.wsId} tag=${safeTag} msgUid=${requestMsgUid} `
            + `user=${session.userId || 'unknown'} elapsed=${elapsed}ms `
            + `responses=${responseTags || 'none'} socketState=${ws.readyState} `
            + `buffered=${Math.max(0, Number(ws.bufferedAmount) || 0)}`
          );
        }
        const slowMs = Math.max(0, Number(process.env.WS_HANDLER_SLOW_LOG_MS || 500) || 500);
        if (elapsed >= slowMs) {
          logger.warn(
            `[WSServer] slow tag=${safeTag} msgUid=${Number(msg && msg.msgUid) || 0} `
            + `user=${session && session.userId ? session.userId : 'unknown'} elapsed=${elapsed}ms`
          );
        }
      } catch (err) {
        const fallbackLike = !router.hasHandler(safeTag) || STUB_TAG_SET.has(safeTag);
        tagMetrics.recordFail(safeTag, { fallbackHit: fallbackLike });
        logger.error(`[WSServer] 处理 tag=${msg.tag} 失败: ${err.message}`);
        this._sendSingle(ws, {
          tag: 9,
          msgUid: 0,
          data: { msg: String(err && err.message ? err.message : '请求处理失败') },
        });
        // return an error response to avoid client hang
        this.sendResponse(ws, {
          tag: msg.tag,
          msgUid: msg.msgUid,
          data: { result: -1, msg: err.message },
        });
      } finally {
        const perf = getTaskPerfSnapshot();
        if (perf) {
          logger.info(
            `[Perf][WS] tag=${safeTag} msgUid=${Number(msg && msg.msgUid) || 0} `
            + `user=${session && session.userId ? session.userId : 'unknown'} `
            + `totalMs=${perf.totalMs} taskNormalizeMs=${perf.taskNormalizeMs} `
            + `taskNormalizeCount=${perf.taskNormalizeCount} taskPushMs=${perf.taskPushMs} `
            + `taskPushCount=${perf.taskPushCount} taskPushPackets=${perf.taskPushPackets} `
            + `taskPushKinds=${formatTaskPerfKinds(perf.taskPushKinds)}`
          );
        }
      }
    });
  }

  /**
   * 发送响应。
   * @param {WebSocket} ws - 目标连接
   * @param {Object|Array} result - 响应数据
   */
  sendResponse(ws, result) {
    if (!result || ws.readyState !== WebSocket.OPEN) return;

    if (Array.isArray(result) && result.length > 0 && result[0] && result[0].tag !== undefined) {
      // 批量结果按顺序逐条发送。
      this._sendBatch(ws, result);
    } else if (result.tag !== undefined) {
      // 单条消息。
      this._sendSingle(ws, result);
    }
  }

  /**
   * 发送单条消息。
   */
  _sendSingle(ws, msg) {
    try {
      const packed = PacketManager.packSingle(msg.tag, msg.data, msg.msgUid);
      const bufferedBefore = Math.max(0, Number(ws.bufferedAmount) || 0);
      const sendStartedAt = Date.now();
      const session = ws._lhsSession || null;
      if (bufferedBefore >= this.bufferedAmountWarnBytes) {
        logger.warn(
          `[WSServer] outbound backlog tag=${msg.tag} msgUid=${Number(msg.msgUid) || 0} `
          + `buffered=${bufferedBefore}`
        );
      }
      logger.info(
        `[WSServer] 发送 tag=${msg.tag} msgUid=${Number(msg.msgUid) || 0} `
        + `size=${packed.byteLength || packed.length} buffered=${bufferedBefore}`
      );
      let callbackDone = false;
      const pendingTimer = setTimeout(() => {
        if (callbackDone) return;
        logger.warn(
          `[WSServer] send callback pending tag=${msg.tag} msgUid=${Number(msg.msgUid) || 0} `
          + `ws#${session && session.wsId ? session.wsId : 'unknown'} `
          + `user=${session && session.userId ? session.userId : 'unknown'} `
          + `elapsed=${Date.now() - sendStartedAt}ms buffered=${Math.max(0, Number(ws.bufferedAmount) || 0)} `
          + `socketState=${ws.readyState}`
        );
      }, this.sendCallbackWarnMs);
      if (typeof pendingTimer.unref === 'function') pendingTimer.unref();
      ws.send(packed, (err) => {
        callbackDone = true;
        clearTimeout(pendingTimer);
        if (session) session._lastSendAt = Date.now();
        if (err) {
          logger.error(
            `[WSServer] send failed tag=${msg.tag} msgUid=${Number(msg.msgUid) || 0}: ${err.message}`
          );
          return;
        }
        const elapsed = Date.now() - sendStartedAt;
        if (elapsed >= this.sendCallbackWarnMs) {
          logger.warn(
            `[WSServer] slow send tag=${msg.tag} msgUid=${Number(msg.msgUid) || 0} `
            + `ws#${session && session.wsId ? session.wsId : 'unknown'} elapsed=${elapsed}ms`
          );
        }
      });
    } catch (err) {
      logger.error(`[WSServer] 打包消息 tag=${msg.tag} 失败: ${err.message}\n${err.stack}`);
    }
  }

  /**
   * 批量发送消息，按顺序逐条调用 packSingle。
   * 客户端 WASM zlib 对 tag=0 压缩批量包存在兼容问题，因此不使用 packBatch。
   */
  _sendBatch(ws, messages) {
    const tags = messages.map(m => m.tag);
    logger.info(`[WSServer] 发送 BATCH [${tags.join(',')}]（逐条）count=${messages.length}`);
    const equipPacketCount = messages.filter((msg) => Number(msg && msg.tag) === 2200).length;
    const chunkThreshold = Math.max(0, Number(process.env.WS_BATCH_CHUNK_THRESHOLD || 24) || 24);
    const chunkBytesThreshold = Math.max(0, Number(process.env.WS_BATCH_CHUNK_BYTES || 131072) || 131072);
    const totalBytes = estimateBatchBytes(messages);
    const shouldChunkForEquip = equipPacketCount > 0 && messages.length > chunkThreshold;
    const shouldChunkForPayload = totalBytes > chunkBytesThreshold && messages.length > 1;
    if (shouldChunkForEquip || shouldChunkForPayload) {
      logger.warn(
        `[WSServer] large ordered batch count=${messages.length} bytes=${totalBytes} `
        + `equipPackets=${equipPacketCount}; sending without timer interleave`
      );
    }

    for (const msg of messages) {
      if (msg && msg.tag !== undefined) {
        this._sendSingle(ws, msg);
      }
    }
  }

  async _onSocketClosed(session, wsId, code, reason) {
    const reasonText = Buffer.isBuffer(reason) ? reason.toString('utf8') : (reason || '');
    session._closing = true;
    const now = Date.now();
    const activeRequest = session._activeRequest;
    logger.warn(
      `[WSServer] socket closed ws#${wsId} code=${code} reason=${reasonText || 'none'} `
      + `user=${session.userId || 'unknown'} queueDepth=${session._queueDepth} `
      + `activeTag=${activeRequest ? activeRequest.tag : 0} `
      + `activeMsgUid=${activeRequest ? activeRequest.msgUid : 0} `
      + `activeElapsed=${activeRequest ? now - activeRequest.startedAt : 0}ms `
      + `lastRxAge=${session._lastReceiveAt ? now - session._lastReceiveAt : -1}ms `
      + `lastTxAge=${session._lastSendAt ? now - session._lastSendAt : -1}ms`
    );
    if (session._mapId > 0 && session.player && typeof session._broadcastMapExceptUser === 'function') {
      session._broadcastMapExceptUser(1402, {
        mapId: Math.max(0, Number(session._mapId) || 0),
        id: String(session.player.playerId || session.player.userId || session.userId || ''),
      });
      session._mapId = 0;
      session._mapLine = 0;
      session._mapPos = null;
      session._mapSelfInfo = null;
    }
    if (session._fishRoomMapId > 0 && session.player && typeof session._broadcastExceptUser === 'function') {
      session._broadcastExceptUser(4052, {
        mapId: Math.max(0, Number(session._fishRoomMapId) || 0),
        id: String(session.player.playerId || session.player.userId || session.userId || ''),
      });
      session._fishRoomMapId = 0;
    }
    let activeSession = null;
    let activeWsId = NaN;
    if (session.userId) {
      try {
        activeSession = await withDeadline(
          Session.get(session.userId),
          this.closeQueueDrainMs,
          `session close lookup #${wsId}`
        );
        activeWsId = activeSession ? Number(activeSession.wsId) : NaN;
      } catch (err) {
        logger.warn(`[WSServer] session close lookup failed #${wsId}: ${err.message}`);
      }
    }

    if (session.userId && session.player) {
      let queueDrained = true;
      try {
        if (session._messageQueue && typeof session._messageQueue.then === 'function') {
          await withDeadline(
            session._messageQueue.catch(() => undefined),
            this.closeQueueDrainMs,
            `message queue drain #${wsId}`
          );
        }
      } catch (err) {
        queueDrained = false;
        logger.warn(
          `[WSServer] close queue drain failed #${wsId}: ${err.message}; `
          + `skip final snapshot while handler may still be mutating`
        );
      }
      try {
        if (queueDrained && (!activeSession || activeWsId === wsId)) {
          await withDeadline(
            playerService.savePlayer(session.userId, session.player),
            Math.max(this.closeQueueDrainMs, this.finalSaveWaitMs),
            `final player save #${wsId}`
          );
        } else {
          logger.info(
            `[WSServer] skip save on stale close #${wsId}, user=${session.userId}, activeWsId=${activeWsId || 'none'}`
          );
        }
      } catch (err) {
        logger.warn(`[WSServer] save on close failed #${wsId}: ${err.message}`);
      }
    }
    if (session.userId && session._onlineCounted) {
      try {
        if (activeSession && activeWsId === wsId) {
          await withDeadline(Session.remove(session.userId), this.closeQueueDrainMs, `session remove #${wsId}`);
          await withDeadline(Session.decrOnline(), this.closeQueueDrainMs, `online decrement #${wsId}`);
          session._onlineCounted = false;
        } else {
          logger.info(
            `[WSServer] skip session cleanup for #${wsId}, user=${session.userId}, activeWsId=${activeWsId || 'none'}`
          );
        }
      } catch (err) {
        logger.warn(`[WSServer] session cleanup check failed #${wsId}: ${err.message}`);
      }
    }
    logger.info(
      `[WSServer] 连接断开 #${wsId} ${session.player ? session.player.name : 'unknown'} code=${code} reason=${reasonText}`
    );
  }

  _closeDuplicateConnections(userId, keepWsId) {
    if (!this.closeDuplicateLogin) {
      const duplicateIds = [];
      for (const [wsId, item] of this.clients) {
        if (wsId === keepWsId) continue;
        const sess = item && item.session;
        const ws = item && item.ws;
        if (sess && sess.userId === userId && ws && ws.readyState === WebSocket.OPEN) {
          duplicateIds.push(wsId);
        }
      }
      if (duplicateIds.length > 0) {
        logger.warn(
          `[WSServer] duplicate login user=${userId}, keep all local connections [${duplicateIds.join(',')},${keepWsId}]`
        );
      }
      return;
    }

    for (const [wsId, item] of this.clients) {
      if (wsId === keepWsId) continue;
      const sess = item && item.session;
      if (!sess || sess.userId !== userId) continue;
      const ws = item.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      logger.warn(`[WSServer] duplicate login user=${userId}, close old #${wsId}, keep #${keepWsId}`);
      try {
        ws.close(4001, 'relogin');
      } catch (_e) {
        // ignore close race
      }
    }
  }

  /**
   * 向指定玩家推送消息。
   * @param {string} userId - 目标玩家 ID
   * @param {number} tag - 协议标签
   * @param {*} data - 消息数据
   */
  pushToUser(userId, tag, data) {
    for (const [_wsId, { ws, session }] of this.clients) {
      if (session.userId === userId && ws.readyState === WebSocket.OPEN) {
        this._sendSingle(ws, { tag, data, msgUid: 0 });
        break;
      }
    }
  }

  /**
   * 同步管理端对玩家数据的修改到内存中的 session.player，
   * 防止玩家下次操作保存时用旧数据覆盖管理端的修改。
   * @param {string} userId
   * @param {Object} updatedPlayer - 管理端修改后的完整玩家对象
   */
  syncSessionPlayer(userId, updatedPlayer, options = {}) {
    for (const [_wsId, { session }] of this.clients) {
      if (session.userId === userId && session.player) {
        return syncSessionPlayerFields(session.player, updatedPlayer, options);
      }
    }
    return null;
  }

  /**
   * 广播消息给所有在线玩家。
   * @param {number} tag - 协议标签
   * @param {*} data - 消息数据
   */
  broadcast(tag, data) {
    for (const [_wsId, { ws }] of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        this._sendSingle(ws, { tag, data, msgUid: 0 });
      }
    }
  }

  broadcastExceptUser(userId, tag, data) {
    for (const [_wsId, { ws, session }] of this.clients) {
      if (session && session.userId === userId) continue;
      if (ws.readyState === WebSocket.OPEN) {
        this._sendSingle(ws, { tag, data, msgUid: 0 });
      }
    }
  }

  getMapPlayers(userId, mapId, line = 0) {
    const safeMapId = Math.max(0, Number(mapId) || 0);
    const safeLine = Math.max(0, Number(line) || 0);
    if (safeMapId <= 0) return [];

    const players = [];
    for (const [_wsId, { ws, session }] of this.clients) {
      if (!session || session.userId === userId || ws.readyState !== WebSocket.OPEN) continue;
      if (Number(session._mapId) !== safeMapId || Number(session._mapLine || 0) !== safeLine) continue;
      const mapPlayer = session._mapSelfInfo;
      if (mapPlayer && typeof mapPlayer === 'object' && !Array.isArray(mapPlayer)) {
        players.push(JSON.parse(JSON.stringify(mapPlayer)));
      }
    }
    return players;
  }

  broadcastMapExceptUser(userId, mapId, line, tag, data) {
    const safeMapId = Math.max(0, Number(mapId) || 0);
    const safeLine = Math.max(0, Number(line) || 0);
    if (safeMapId <= 0) return;

    for (const [_wsId, { ws, session }] of this.clients) {
      if (!session || session.userId === userId || ws.readyState !== WebSocket.OPEN) continue;
      if (Number(session._mapId) !== safeMapId || Number(session._mapLine || 0) !== safeLine) continue;
      this._sendSingle(ws, { tag, data, msgUid: 0 });
    }
  }
}

module.exports = WSServer;
