/**
 * 多大区多进程启动配置
 *
 * 每个服务器实例独立进程，独立 WS 端口，共享 MongoDB 和 Redis。
 * 敏感项（API_KEY / DIST_API_KEY / ADMIN_PASSWORD）通过环境变量注入，
 * 不要写死在源码里 —— 见 newServer/.env.example。
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

module.exports = {
  apps: [
    // ===== 长安一区 (serverId: 1001) =====
    {
      name: 'lhs-s1001',
      script: 'src/app.js',
      cwd: '/data/lhs/newServer',
      env: {
        NODE_ENV: 'production',
        WS_PORT: 9200,
        WS_PUBLIC_PORT: 81,
        WS_PUBLIC_PATH: '/ws',
        WS_BEHIND_PROXY: 1,
        HTTP_PORT: 8080,
        SERVER_ID: 1001,
        SERVER_NAME: '长安一区',
        SERVER_HOST: '127.0.0.1',
        MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/lhs_s1001',
        REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
        REDIS_PREFIX: 's1001:',
        API_KEY: process.env.API_KEY || '',
        DIST_API_KEY: process.env.DIST_API_KEY || '',
        ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'aplm',
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
        FREE_RECHARGE_FOR_ALL: process.env.FREE_RECHARGE_FOR_ALL || '1',
        REQUIRE_INVITE_REGISTER: process.env.REQUIRE_INVITE_REGISTER || '0',
        CORS_ALLOWED_ORIGINS: '*',
      },
    },
    {
      name: 'lhs-dist',
      script: 'src/app.js',
      cwd: '/data/lhs/LHS-dist',
      env: { NODE_ENV: 'production', PORT: 3001 },
    },
    {
      name: 'lhs-admin',
      script: 'server.js',
      cwd: '/data/lhs/LHS-admin',
      env: { NODE_ENV: 'production', LHS_ADMIN_PORT: 8082 },
    },
  ],
};
