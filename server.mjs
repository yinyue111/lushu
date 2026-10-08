import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { envFlag, envNumber } from './server/config/env.mjs';
import { evaluateStartupSafety } from './server/config/startup-checks.mjs';
import { ALLOW_LOCAL_ADMIN_BYPASS, ALLOW_LOCAL_API_BYPASS, HOST, IS_PRODUCTION, PORT, PROFILE_ID_SECRET_SOURCE, PUBLIC_BASE_URL, TRUST_PROXY_HEADERS } from './server/config/index.mjs';
import { assignRequestId } from './server/http/response.mjs';
import { consumeRateLimit } from './server/http/rate-limit.mjs';
import { matchShareLandingPath, sendStatic, serveShareLandingHtml } from './server/http/static.mjs';
import { handleApi } from './server/routes/index.mjs';

{
  const { errors, warnings } = evaluateStartupSafety({
    host: HOST,
    isProduction: IS_PRODUCTION,
    allowLocalApiBypass: ALLOW_LOCAL_API_BYPASS,
    allowLocalAdminBypass: ALLOW_LOCAL_ADMIN_BYPASS,
    trustProxyHeaders: TRUST_PROXY_HEADERS,
    allowBypassOnPublicHost: envFlag('ALLOW_LOCAL_BYPASS_ON_PUBLIC_HOST', false),
    profileSecretSource: PROFILE_ID_SECRET_SOURCE,
    publicBaseUrl: PUBLIC_BASE_URL
  });
  for (const warning of warnings) console.warn(`[startup] WARNING: ${warning}`);
  if (errors.length) throw new Error(errors.join('\n'));
}

const vite = IS_PRODUCTION ? null : await createDevelopmentViteServer();

async function createDevelopmentViteServer() {
  const { createServer: createViteServer } = await import('vite');
  const preferredHmrPort = envNumber('VITE_HMR_PORT', 24679, { min: 0, max: 65535 });
  const hmrPort = await findAvailablePort(preferredHmrPort, '0.0.0.0');
  return createViteServer({
    server: { middlewareMode: true, hmr: { host: HOST === '0.0.0.0' ? 'localhost' : HOST, port: hmrPort } },
    appType: 'spa'
  });
}

async function findAvailablePort(preferredPort, host = '127.0.0.1') {
  const start = Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : 0;
  if (start === 0) return probeAvailablePort(0, host);
  for (let offset = 0; offset < 50; offset += 1) {
    const candidate = start + offset;
    const available = await probeAvailablePort(candidate, host).catch(() => null);
    if (available) return available;
  }
  return probeAvailablePort(0, host);
}

function probeAvailablePort(port, host = '127.0.0.1') {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once('error', rejectPort);
    server.listen(port, host, () => {
      const address = server.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : port;
      server.close(() => resolvePort(resolvedPort));
    });
  });
}

// L3: auto-incrementing the port on EADDRINUSE is a development convenience only;
// in production a busy port must fail loudly instead of silently drifting.
const DEV_PORT_FALLBACK_ATTEMPTS = IS_PRODUCTION ? 0 : 10;
const SHUTDOWN_GRACE_MS = envNumber('SHUTDOWN_GRACE_MS', 10000, { min: 0, max: 120000 });

function listen(port, attemptsLeft = DEV_PORT_FALLBACK_ATTEMPTS) {
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/api/')) {
      assignRequestId(req, res);
      const handled = await handleApi(req, res);
      if (handled !== false) return;
    }
    // rank15①：分享/回顾落地页优先尝试注入 og meta，失败则回退默认托管路径。
    // 落地页构建要反扫路书/回顾 JSONL，挂 public-read 桶；超限不回 429，
    // 直接跳过注入回退纯静态 index.html（成本极低，分享打开也不至于报错页）。
    const shareLandingTarget = matchShareLandingPath(req);
    if (shareLandingTarget && consumeRateLimit(req, 'public-read')) {
      const served = await serveShareLandingHtml(req, res, shareLandingTarget, vite).catch(() => false);
      if (served) return;
    }
    if (vite) {
      vite.middlewares(req, res);
      return;
    }
    await sendStatic(req, res);
  });
  server.requestTimeout = envNumber('REQUEST_TIMEOUT_MS', 130000, { min: 0 });
  server.headersTimeout = envNumber('HEADERS_TIMEOUT_MS', 15000, { min: 0 });

  const onError = (error) => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.warn(`[server] port ${port} is in use, trying ${port + 1} (development only)`);
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    if (error.code === 'EADDRINUSE') {
      console.error(`[server] port ${port} on ${HOST} is already in use; set PORT to a free port.`);
      process.exit(1);
    }
    throw error;
  };

  server.once('error', onError);
  server.listen(port, HOST, () => {
    server.off('error', onError);
    installGracefulShutdown(server);
    const mode = IS_PRODUCTION ? 'production' : 'dev';
    console.log(`Trusted Routebook ${mode} server: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}/`);
  });
}

// L3: stop accepting connections on SIGTERM/SIGINT, let in-flight requests (and
// their JSONL appends) finish, then exit. A second signal or the grace timeout
// forces the exit.
function installGracefulShutdown(server) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) {
      process.exit(1);
      return;
    }
    shuttingDown = true;
    console.log(`[server] ${signal} received, shutting down`);
    const forceTimer = setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    forceTimer.unref();
    server.close(async () => {
      await vite?.close().catch(() => {});
      process.exit(0);
    });
    server.closeIdleConnections?.();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

listen(PORT);
