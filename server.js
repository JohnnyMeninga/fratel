import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import ipaddr from 'ipaddr.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { Server } from 'socket.io';

const projectRoot = dirname(fileURLToPath(import.meta.url));

function readConfig(env) {
  const mode = env.GEOIP_MODE ?? 'auto';
  if (!['auto', 'mock'].includes(mode)) {
    throw new Error('GEOIP_MODE must be auto or mock');
  }
  const origins = (env.CORS_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000,http://[::1]:3000')
    .split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('CORS_ORIGINS must contain exact HTTP(S) origins without trailing slashes');
    }
  }
  const proxies = (env.TRUST_PROXY ?? '').split(',').map(value => value.trim()).filter(Boolean);
  for (const proxy of proxies) {
    const valid = proxy.includes('/')
      ? isIP(proxy.split('/')[0]) && ipaddr.isValidCIDR(proxy)
      : isIP(proxy);
    if (!valid) {
      throw new Error('TRUST_PROXY must contain trusted proxy IP addresses or CIDRs, not true or hop counts');
    }
  }
  return { mode, origins, proxies, production: env.NODE_ENV === 'production' };
}

function mockLocation(ip, reason) {
  return {
    ip,
    latitude: 51.5074,
    longitude: -0.1278,
    city: 'London (development fixture)',
    country: 'United Kingdom',
    countryCode: 'GB',
    isp: 'Mock ISP',
    asn: 'AS00000',
    source: 'mock',
    isMock: true,
    fallbackReason: reason,
  };
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function createApp({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = readConfig(env);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.proxies.length ? config.proxies : false);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://tile.openstreetmap.org'],
        connectSrc: ["'self'", ...config.origins.map(origin => {
          const url = new URL(origin);
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
          return url.origin;
        })],
        upgradeInsecureRequests: config.production ? [] : null,
      },
    },
  }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.origins.includes(origin)) return callback(null, true);
      const error = new Error('Origin is not allowed');
      error.status = 403;
      callback(error);
    },
    methods: ['GET'],
    credentials: false,
  }));
  app.get('/api/geoip', (req, res, next) => {
    if (!isIP(req.ip)) {
      return res.status(400).json({ error: { code: 'INVALID_IP', message: 'Could not resolve a valid client IP.' } });
    }
    next();
  }, rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: { error: { code: 'RATE_LIMITED', message: 'Too many lookups; retry in one minute.' } },
  }), async (req, res) => {
    const address = ipaddr.process(req.ip);
    const ip = address.toString();
    if (config.mode === 'mock') {
      return res.json(mockLocation(ip, 'explicit_mock_mode'));
    }
    if (address.range() === 'loopback' && !config.production) {
      return res.json(mockLocation(ip, 'localhost_development'));
    }
    if (address.range() !== 'unicast') {
      return res.status(422).json({ error: {
        code: 'NON_PUBLIC_IP',
        message: 'Client IP is not publicly routable. For a reverse proxy, configure TRUST_PROXY explicitly.',
      } });
    }
    try {
      const response = await fetchImpl(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
        signal: AbortSignal.timeout(4000),
        headers: { Accept: 'application/json' },
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Provider HTTP failure');
      const data = await response.json();
      if (!data || data.error || !Number.isFinite(data.latitude) || !Number.isFinite(data.longitude)
        || Math.abs(data.latitude) > 90 || Math.abs(data.longitude) > 180) {
        throw new Error('Invalid provider coordinates');
      }
      return res.json({
        ip,
        latitude: data.latitude,
        longitude: data.longitude,
        city: optionalText(data.city),
        country: optionalText(data.country_name),
        countryCode: optionalText(data.country_code),
        isp: optionalText(data.org),
        asn: optionalText(data.asn),
        source: 'ipapi.co',
        isMock: false,
        fallbackReason: null,
      });
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      return res.status(timedOut ? 504 : 502).json({ error: {
        code: timedOut ? 'GEOIP_TIMEOUT' : 'GEOIP_UNAVAILABLE',
        message: timedOut ? 'IP geolocation provider timed out.' : 'IP geolocation provider is unavailable or returned invalid data.',
      } });
    }
  });
  app.use('/vendor/leaflet', express.static(join(projectRoot, 'node_modules', 'leaflet', 'dist')));
  app.use('/vendor/socket.io', express.static(join(projectRoot, 'node_modules', 'socket.io', 'client-dist')));
  app.use('/vendor/icons', express.static(join(projectRoot, 'node_modules', 'lucide-static', 'icons')));
  app.use(express.static(join(projectRoot, 'public'), { dotfiles: 'deny' }));
  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } });
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const forbidden = error.status === 403;
    res.status(forbidden ? 403 : 500).json({ error: {
      code: forbidden ? 'ORIGIN_NOT_ALLOWED' : 'INTERNAL_ERROR',
      message: forbidden ? 'Origin is not allowed.' : 'An unexpected server error occurred.',
    } });
  });
  return app;
}

export function createDashboardServer(options = {}) {
  const config = readConfig(options.env ?? process.env);
  const app = createApp(options);
  const httpServer = createServer(app);
  const allowed = origin => !origin || config.origins.includes(origin);
  const io = new Server(httpServer, {
    serveClient: false,
    maxHttpBufferSize: 1024,
    cors: {
      origin(origin, callback) { callback(null, allowed(origin)); },
      methods: ['GET', 'POST'],
      credentials: false,
    },
    allowRequest(req, callback) { callback(null, allowed(req.headers.origin)); },
  });
  io.engine.use(helmet({ contentSecurityPolicy: false }));
  io.on('connection', socket => {
    let lastPing = -Infinity;
    socket.on('telemetry:ping', acknowledge => {
      if (typeof acknowledge !== 'function') return;
      const current = performance.now();
      if (current - lastPing < 250) return;
      lastPing = current;
      acknowledge();
    });
  });
  return { app, httpServer, io };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  const { httpServer: server } = createDashboardServer();
  server.listen(port, host, () => {
    const displayHost = host.includes(':') ? `[${host}]` : host;
    console.log(`Dashboard: http://${displayHost}:${port}/`);
  });
  server.on('error', error => {
    console.error(`Server could not start: ${error.code ?? error.message}`);
    process.exitCode = 1;
  });
}