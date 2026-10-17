import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp, createDashboardServer } from '../server.js';
import { io as connectSocket } from 'socket.io-client';
import { once } from 'node:events';

const providerData = {
  latitude: 0, longitude: 0, city: 'Test City', country_name: 'Test Country',
  country_code: 'TC', org: 'Test ISP', asn: 'AS12345',
};
const trustedEnv = { TRUST_PROXY: '127.0.0.1,::1' };
function publicRequest(app) {
  return request(app).get('/api/geoip').set('X-Forwarded-For', '8.8.8.8');
}

test('localhost returns a labeled mock without contacting a provider or trusting spoofed headers', async () => {
  const app = createApp({ env: {}, fetchImpl: () => { throw new Error('Must not call provider'); } });
  const response = await publicRequest(app).expect(200);
  assert.equal(response.body.ip, '127.0.0.1');
  assert.equal(response.body.isMock, true);
  assert.equal(response.body.source, 'mock');
  assert.equal(response.body.fallbackReason, 'localhost_development');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-powered-by'], undefined);
});

for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
  test(`loopback fallback supports ${ip}`, async () => {
    const response = await request(createApp({ env: trustedEnv }))
      .get('/api/geoip').set('X-Forwarded-For', ip).expect(200);
    assert.equal(response.body.fallbackReason, 'localhost_development');
  });
}

test('trusted proxy resolves a public IP and normalizes provider fields, including zero coordinates', async () => {
  const app = createApp({ env: trustedEnv, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://ipapi.co/8.8.8.8/json/');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => providerData };
  } });
  const { body } = await publicRequest(app).expect(200);
  assert.deepEqual(body, {
    ip: '8.8.8.8', latitude: 0, longitude: 0, city: 'Test City', country: 'Test Country',
    countryCode: 'TC', isp: 'Test ISP', asn: 'AS12345', source: 'ipapi.co',
    isMock: false, fallbackReason: null,
  });
});

test('proxy chain stops at the nearest untrusted hop', async () => {
  const app = createApp({ env: trustedEnv, fetchImpl: async url => {
    assert.equal(url, 'https://ipapi.co/8.8.8.8/json/');
    return { ok: true, json: async () => providerData };
  } });
  await request(app).get('/api/geoip').set('X-Forwarded-For', '1.1.1.1, 8.8.8.8').expect(200);
});

test('production localhost does not silently return a mock', async () => {
  const response = await request(createApp({ env: { NODE_ENV: 'production' } })).get('/api/geoip').expect(422);
  assert.equal(response.body.error.code, 'NON_PUBLIC_IP');
});

for (const ip of ['10.0.0.5', '192.168.1.8', '169.254.1.2', 'fc00::1', 'fe80::1', '0.0.0.0']) {
  test(`non-public IP ${ip} is not sent to an external provider`, async () => {
    const app = createApp({ env: trustedEnv, fetchImpl: () => { throw new Error('Must not call provider'); } });
    await request(app).get('/api/geoip').set('X-Forwarded-For', ip).expect(422);
  });
}

test('invalid forwarded IP returns a structured error', async () => {
  const response = await request(createApp({ env: trustedEnv }))
    .get('/api/geoip').set('X-Forwarded-For', 'not-an-ip').expect(400);
  assert.equal(response.body.error.code, 'INVALID_IP');
});

test('explicit mock mode works offline for public IPs', async () => {
  const response = await publicRequest(createApp({ env: { ...trustedEnv, GEOIP_MODE: 'mock' } })).expect(200);
  assert.equal(response.body.fallbackReason, 'explicit_mock_mode');
});

for (const [name, fetchImpl, status, code] of [
  ['network failure', async () => { throw new Error('private provider details'); }, 502, 'GEOIP_UNAVAILABLE'],
  ['timeout', async () => { throw new DOMException('expired', 'TimeoutError'); }, 504, 'GEOIP_TIMEOUT'],
  ['provider rate limit', async () => ({ ok: false, status: 429 }), 502, 'GEOIP_UNAVAILABLE'],
  ['provider error payload', async () => ({ ok: true, json: async () => ({ error: true }) }), 502, 'GEOIP_UNAVAILABLE'],
  ['invalid JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid'); } }), 502, 'GEOIP_UNAVAILABLE'],
  ['null coordinates', async () => ({ ok: true, json: async () => ({ latitude: null, longitude: null }) }), 502, 'GEOIP_UNAVAILABLE'],
  ['out-of-range coordinates', async () => ({ ok: true, json: async () => ({ latitude: 91, longitude: 181 }) }), 502, 'GEOIP_UNAVAILABLE'],
]) {
  test(`${name} produces a safe structured response`, async () => {
    const response = await publicRequest(createApp({ env: trustedEnv, fetchImpl })).expect(status);
    assert.equal(response.body.error.code, code);
    assert.equal(JSON.stringify(response.body).includes('private provider details'), false);
  });
}

test('missing optional provider fields become null', async () => {
  const app = createApp({ env: trustedEnv, fetchImpl: async () => ({
    ok: true, json: async () => ({ latitude: 1, longitude: 2 }),
  }) });
  const { body } = await publicRequest(app).expect(200);
  for (const field of ['city', 'country', 'countryCode', 'isp', 'asn']) assert.equal(body[field], null);
});

test('CORS allows an exact configured origin and handles preflight', async () => {
  const app = createApp({ env: { CORS_ORIGINS: 'http://localhost:5173' } });
  const response = await request(app).get('/api/geoip').set('Origin', 'http://localhost:5173').expect(200);
  assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5173');
  await request(app).options('/api/geoip').set('Origin', 'http://localhost:5173')
    .set('Access-Control-Request-Method', 'GET').expect(204);
  const denied = await request(app).get('/api/geoip').set('Origin', 'https://untrusted.example').expect(403);
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
});

test('lookup requests are rate limited', async () => {
  const app = createApp({ env: {} });
  for (let count = 0; count < 60; count += 1) await request(app).get('/api/geoip').expect(200);
  const response = await request(app).get('/api/geoip').expect(429);
  assert.equal(response.body.error.code, 'RATE_LIMITED');
  assert.ok(response.headers['retry-after']);
});

test('invalid configuration fails early', () => {
  for (const env of [
    { TRUST_PROXY: 'true' }, { TRUST_PROXY: '1' }, { TRUST_PROXY: '127.1' },
    { TRUST_PROXY: '1/8' }, { GEOIP_MODE: 'invalid' },
    { CORS_ORIGINS: '*' }, { CORS_ORIGINS: 'https://example.com/' },
  ]) assert.throws(() => createApp({ env }), JSON.stringify(env));
});

test('unknown routes return JSON, not stack traces', async () => {
  const response = await request(createApp({ env: {} })).get('/missing').expect(404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
});

test('dashboard is served with a restrictive map-compatible content security policy', async () => {
  const response = await request(createApp({ env: {} })).get('/').expect(200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.text, /id="map"/);
  assert.match(response.text, /\/vendor\/leaflet\/leaflet.js/);
  const policy = response.headers['content-security-policy'];
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /https:\/\/tile.openstreetmap.org/);
  assert.equal(policy.includes('upgrade-insecure-requests'), false);
});

test('production retains upgrade-insecure-requests', async () => {
  const response = await request(createApp({ env: { NODE_ENV: 'production' } })).get('/').expect(200);
  assert.match(response.headers['content-security-policy'], /upgrade-insecure-requests/);
});

test('dashboard scripts, map assets, and icons are served locally', async () => {
  const app = createApp({ env: {} });
  for (const url of ['/app.js', '/location.js', '/network.js', '/telemetry.js', '/styles.css',
    '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/vendor/icons/radar.svg',
    '/vendor/socket.io/socket.io.min.js']) {
    await request(app).get(url).expect(200);
  }
});

async function socketFixture(context, transport, origin = 'http://localhost:3000') {
  const { httpServer, io } = createDashboardServer({ env: {} });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const client = connectSocket(url, { transports: [transport], autoConnect: false,
    reconnection: false, timeout: 1500, extraHeaders: { Origin: origin } });
  context.after(async () => {
    client.disconnect();
    await new Promise(resolve => io.close(resolve));
  });
  return { client, httpServer };
}

for (const transport of ['websocket', 'polling']) {
  test(`${transport} connection acknowledges a payload-free ping and reconnects`, { timeout: 5000 }, async context => {
    const { client, httpServer } = await socketFixture(context, transport);
    const connected = once(client, 'connect');
    client.connect();
    await connected;
    const result = await new Promise((resolve, reject) => {
      client.timeout(1000).emit('telemetry:ping', (error, ...payload) => error ? reject(error) : resolve(payload));
    });
    assert.deepEqual(result, []);
    client.disconnect();
    const reconnected = once(client, 'connect');
    client.connect();
    await reconnected;
    assert.equal(client.connected, true);
    const response = await request(httpServer).get('/vendor/socket.io/socket.io.min.js').expect(200);
    assert.match(response.headers['content-type'], /javascript/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  });

  test(`${transport} rejects an untrusted browser origin`, { timeout: 5000 }, async context => {
    const { client } = await socketFixture(context, transport, 'https://untrusted.example');
    const rejected = once(client, 'connect_error');
    client.connect();
    await rejected;
    assert.equal(client.connected, false);
  });
}

test('unexpected ping payloads are ignored without dropping the connection', { timeout: 5000 }, async context => {
  const { client } = await socketFixture(context, 'websocket');
  const connected = once(client, 'connect');
  client.connect();
  await connected;
  const error = await new Promise(resolve => {
    client.timeout(100).emit('telemetry:ping', { unexpected: true }, resolve);
  });
  assert.ok(error);
  assert.equal(client.connected, true);
});