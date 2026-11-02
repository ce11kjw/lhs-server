const Redis = require('ioredis');
const redis = require('../db/redis');
const logger = require('../logger');

const CHANNEL_NAME = 'cross:events';
const STREAM_NAME = 'cross:events';

function buildRedisOptions() {
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    keyPrefix: process.env.REDIS_PREFIX || '',
    connectTimeout: 10000,
  };
}

let subscriber = null;

async function publish(eventType, payload = {}) {
  const client = redis.getClient();
  if (!client) throw new Error('redis not connected');

  const message = JSON.stringify({
    eventType,
    payload,
    at: Date.now(),
  });

  await client.publish(CHANNEL_NAME, message);
  await client.xadd(STREAM_NAME, '*', 'eventType', String(eventType), 'payload', message);
  return true;
}

async function subscribe(handler) {
  if (typeof handler !== 'function') {
    throw new Error('handler must be a function');
  }
  if (!subscriber) {
    subscriber = new Redis(buildRedisOptions());
  }
  await subscriber.subscribe(CHANNEL_NAME);
  subscriber.on('message', (channel, message) => {
    if (channel !== CHANNEL_NAME) return;
    try {
      const parsed = JSON.parse(message);
      handler(parsed);
    } catch (err) {
      logger.warn(`[CrossBus] bad message: ${err.message}`);
    }
  });
}

async function closeSubscriber() {
  if (!subscriber) return;
  await subscriber.quit();
  subscriber = null;
}

module.exports = {
  CHANNEL_NAME,
  STREAM_NAME,
  publish,
  subscribe,
  closeSubscriber,
};
