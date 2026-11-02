/**
 * Application entry:
 * MongoDB + Redis + handlers + (optional) WS + (optional) HTTP.
 */

const path = require('path');
const nodeCrypto = require('crypto');

if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
  globalThis.crypto = nodeCrypto.webcrypto;
}

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongo = require('./db/mongo');
const redis = require('./db/redis');
const WSServer = require('./net/WSServer');
const HTTPServer = require('./net/HTTPServer');
const handlers = require('./handlers');
const ConfigService = require('./services/ConfigService');
const tagMetrics = require('./services/TagMetricsService');
const logger = require('./logger');
const runtimeConfig = require('./runtimeConfig');
const runtimeBus = require('./services/RuntimeBus');

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const WS_PORT = parsePort(process.env.WS_PORT, 9200);
const HTTP_PORT = parsePort(process.env.HTTP_PORT, 18080);
const AGENT_HTTP_PORT = parsePort(process.env.AGENT_HTTP_PORT, 8081);
const SERVER_ID = parsePort(process.env.SERVER_ID, 1001);
const SERVER_NAME = process.env.SERVER_NAME || 'default-server';
const WS_TLS_KEY = process.env.WS_TLS_KEY || '/etc/ssl/private/lhs.key';
const WS_TLS_CERT = process.env.WS_TLS_CERT || '/etc/ssl/certs/lhs.crt';

async function start() {
  runtimeConfig.validateProductionConfig();
  logger.info(`[App] starting... (${SERVER_NAME} #${SERVER_ID})`);

  // 1. Infrastructure connections.
  await mongo.connect();
  redis.connect();

  // 2. Runtime init.
  ConfigService.loadAllTables();
  await require('./services/ServerConfigService').initializeServerConfigs();
  handlers.registerAll();

  // 3. Start WS/HTTP by role.
  let wsServer = null;
  let httpServer = null;
  let agentHttpServer = null;

  if (WS_PORT > 0) {
    const wsBehindProxy = String(process.env.WS_BEHIND_PROXY || '').toLowerCase() === '1'
      || String(process.env.WS_BEHIND_PROXY || '').toLowerCase() === 'true';
    const wsHost = process.env.WS_HOST || (wsBehindProxy ? '127.0.0.1' : '0.0.0.0');
    const wsOpts = { port: WS_PORT, host: wsHost };
    if (!wsBehindProxy) {
      wsOpts.tls = { key: WS_TLS_KEY, cert: WS_TLS_CERT };
    }
    wsServer = new WSServer(wsOpts);
    await wsServer.start();
    runtimeBus.setWsServer(wsServer);
  } else {
    logger.warn('[App] WS disabled because WS_PORT <= 0');
    runtimeBus.setWsServer(null);
  }

  if (HTTP_PORT > 0) {
    httpServer = new HTTPServer({ port: HTTP_PORT });
    const serverList = require('./handlers/serverList');
    serverList.register(httpServer);
    // Wire WSServer so admin endpoints can push live updates to online players
    if (wsServer) httpServer.setWsServer(wsServer);
    await httpServer.start();
  } else {
    logger.warn('[App] HTTP disabled because HTTP_PORT <= 0');
  }

  if (AGENT_HTTP_PORT > 0) {
    agentHttpServer = new HTTPServer({
      port: AGENT_HTTP_PORT,
      portalType: 'agent',
      clientDir: path.join(__dirname, '..', '..', 'LHS-agent-portal'),
      defaultStaticPage: 'agent-users.html',
    });
    const serverList = require('./handlers/serverList');
    serverList.register(agentHttpServer);
    if (wsServer) agentHttpServer.setWsServer(wsServer);
    await agentHttpServer.start();
  } else {
    logger.info('[App] 内置代理 HTTP 已禁用（分销后台由 lhs-dist:3001 提供）');
  }

  if (!wsServer && !httpServer && !agentHttpServer) {
    throw new Error('WS/HTTP/AGENT_HTTP are all disabled. Set at least one port > 0');
  }

  logger.info(
    `[App] started: ${SERVER_NAME} #${SERVER_ID}`
      + `${wsServer ? ` WS:${WS_PORT}` : ''}`
      + `${httpServer ? ` HTTP:${HTTP_PORT}` : ''}`
      + `${agentHttpServer ? ` AGENT_HTTP:${AGENT_HTTP_PORT}` : ''}`
  );

  const shutdown = async (signal) => {
    logger.info(`[App] received ${signal}, shutting down...`);
    try {
      if (wsServer) await wsServer.stop();
      runtimeBus.setWsServer(null);
      if (httpServer) await httpServer.stop();
      if (agentHttpServer) await agentHttpServer.stop();
    } catch (err) {
      logger.error(`[App] stop server failed: ${err.message}`);
    }

    try {
      const result = tagMetrics.writeDailyReport();
      if (result.enabled) {
        logger.info(`[Metrics] tag metrics written: ${result.filePath}`);
      }
    } catch (err) {
      logger.warn(`[Metrics] write tag metrics failed: ${err.message}`);
    }

    await redis.disconnect();
    await mongo.disconnect();
    logger.info('[App] stopped');
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  process.on('uncaughtException', (err) => {
    logger.error(`[App] uncaught exception: ${err.message}\n${err.stack}`);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(`[App] unhandled rejection: ${reason}`);
  });

  return { wsServer, httpServer, agentHttpServer };
}

if (require.main === module) {
  start().catch((err) => {
    logger.error(`[App] startup failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { start, parsePort };
