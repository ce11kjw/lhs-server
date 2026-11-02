const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const ROOT_DIR = __dirname;
const PORT = Number.parseInt(process.env.LHS_ADMIN_PORT || '8082', 10);

const proxyRoutes = [
  {
    prefix: '/game',
    target: process.env.GAME_ADMIN_ORIGIN || 'http://127.0.0.1:18080',
    label: 'game-admin',
  },
  {
    prefix: '/dist',
    target: process.env.DIST_ADMIN_ORIGIN || 'http://127.0.0.1:3001',
    label: 'dist-admin',
  },
];

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
};

function normalizePathname(reqUrl) {
  try {
    return new URL(reqUrl, 'http://localhost').pathname;
  } catch (_error) {
    return '/';
  }
}

function findProxyRoute(pathname) {
  return proxyRoutes.find((route) => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`));
}

function resolveStaticPath(pathname) {
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const decoded = decodeURIComponent(requestPath).replace(/\\/g, '/');
  const safeRelative = decoded.replace(/^\/+/, '');
  let filePath = path.resolve(ROOT_DIR, safeRelative);

  if (!filePath.startsWith(ROOT_DIR)) {
    return null;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath) && !path.extname(filePath)) {
    const htmlPath = `${filePath}.html`;
    if (htmlPath.startsWith(ROOT_DIR) && fs.existsSync(htmlPath)) {
      filePath = htmlPath;
    }
  }

  return filePath.startsWith(ROOT_DIR) ? filePath : null;
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });
  res.end(text);
}

function serveStatic(req, res, pathname) {
  const filePath = resolveStaticPath(pathname);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(res, 404, 'Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

function rewriteLocationHeader(value, route) {
  if (!value || typeof value !== 'string') return value;
  if (value.startsWith('/')) return `${route.prefix}${value}`;
  try {
    const target = new URL(route.target);
    const next = new URL(value);
    if (next.origin === target.origin) {
      return `${route.prefix}${next.pathname}${next.search}${next.hash}`;
    }
  } catch (_error) {
    // Keep non-URL Location values unchanged.
  }
  return value;
}

function proxyRequest(req, res, route) {
  const originalUrl = new URL(req.url, 'http://localhost');
  const upstreamPath = originalUrl.pathname.slice(route.prefix.length) || '/';
  const targetUrl = new URL(`${upstreamPath}${originalUrl.search}`, route.target);
  const client = targetUrl.protocol === 'https:' ? https : http;

  const headers = { ...req.headers, host: targetUrl.host };
  delete headers.connection;
  delete headers['proxy-connection'];

  const upstreamReq = client.request(
    targetUrl,
    {
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      if (responseHeaders.location) {
        responseHeaders.location = rewriteLocationHeader(responseHeaders.location, route);
      }
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on('error', (error) => {
    sendText(res, 502, `${route.label} proxy failed: ${error.message}`);
  });

  req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  const pathname = normalizePathname(req.url);

  if (pathname === '/health') {
    sendText(
      res,
      200,
      JSON.stringify({ status: 'ok', service: 'lhs-admin-gateway', routes: proxyRoutes }, null, 2),
      'application/json; charset=utf-8'
    );
    return;
  }

  const route = findProxyRoute(pathname);
  if (route) {
    proxyRequest(req, res, route);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`LHS-admin listening on http://127.0.0.1:${PORT}`);
  proxyRoutes.forEach((route) => console.log(`${route.prefix}/ -> ${route.target}`));
});
