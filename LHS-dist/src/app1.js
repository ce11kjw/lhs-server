const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const { connectDB } = require('./config/db');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');
const { ensureDefaultAdmin } = require('./services/defaultAdminService');
const config = require('./config');

const agentRoutes = require('./routes/agent');
const commissionRoutes = require('./routes/commission');
const withdrawalRoutes = require('./routes/withdrawal');
const internalRoutes = require('./routes/internal');
const adminRoutes = require('./routes/admin');

function buildCorsOptions() {
  if (config.cors.allowAll) {
    return {};
  }

  const allowedOrigins = new Set(config.cors.allowedOrigins);
  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('CORS origin denied'));
    },
  };
}

config.validateProductionConfig();

const app = express();

app.use(
  helmet({
    crossOriginOpenerPolicy: config.isProduction ? { policy: 'same-origin' } : false,
    originAgentCluster: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        scriptSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        upgradeInsecureRequests: null,
      },
    },
    hsts: config.isProduction
      ? {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true,
        }
      : false,
  })
);

app.use(mongoSanitize());
app.use(cors(buildCorsOptions()));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/', apiLimiter);
app.use(express.static('public'));

app.use('/api/agent', agentRoutes);
app.use('/api/commission', commissionRoutes);
app.use('/api/withdrawal', withdrawalRoutes);
app.use('/api/admin', adminRoutes);
app.use('/internal', internalRoutes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', env: config.nodeEnv, timestamp: new Date().toISOString() });
});

app.use(notFound);
app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  connectDB()
    .then(async () => {
      const defaultAdminResult = await ensureDefaultAdmin();
      if (defaultAdminResult.action === 'created') {
        console.log(
          `Default admin ready: ${defaultAdminResult.username} (${defaultAdminResult.inviteCode})`
        );
      } else if (defaultAdminResult.action === 'updated_password') {
        console.log(`Default admin password synced: ${defaultAdminResult.username}`);
      } else if (defaultAdminResult.action === 'skipped') {
        console.warn(`Default admin skipped: ${defaultAdminResult.reason}`);
      }

      const port = config.port || 3001;
      app.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`Server listening on ${port}`);
      });
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error('Database connection failed:', error);
      process.exit(1);
    });
}

module.exports = app;
