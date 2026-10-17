import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLatencyMetrics, latencyQuality, createTelemetryMonitor } from '../public/telemetry.js';

function harness() {
  let clock = 0;
  let nextId = 0;
  const timers = new Map();
  const probes = [];
  const updates = [];
  const socket = new EventEmitter();
  socket.connected = true;
  socket.active = true;
  socket.io = new EventEmitter();
  socket.io.engine = { transport: { name: 'websocket' } };
  socket.timeout = () => socket;
  socket.volatile = { emit(event, callback) {
    assert.equal(event, 'telemetry:ping');
    probes.push(callback);
  } };
  socket.disconnect = () => { socket.connected = false; };
  socket.connect = () => { socket.connected = true; socket.emit('connect'); };
  const monitor = createTelemetryMonitor({ socket, onUpdate: value => updates.push(value),
    now: () => clock,
    setTimer(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  return { socket, monitor, probes, timers,
    latest: () => updates[updates.length - 1],
    advance(value) { clock += value; },
    tick() {
      const [id, timer] = [...timers][0];
      timers.delete(id);
      clock += timer.delay;
      timer.callback();
    },
  };
}

test('rolling metrics bound samples and calculate average, extrema, and consecutive RTT jitter', () => {
  const metrics = createLatencyMetrics(3);
  for (const value of [10, 20, 40]) { metrics.attempt(); metrics.record(value); }
  assert.equal(metrics.snapshot().average, 70 / 3);
  assert.equal(metrics.snapshot().jitter, 15);
  metrics.attempt();
  metrics.record(0);
  metrics.attempt();
  metrics.timeout();
  assert.deepEqual(metrics.snapshot(), { sent: 5, received: 4, timeouts: 1, sampleCount: 3,
    sampleLimit: 3, average: 20, min: 0, max: 40, jitter: 30 });
});

test('long sessions remain bounded and reject invalid RTT values', () => {
  const metrics = createLatencyMetrics();
  for (let count = 0; count < 10000; count += 1) metrics.record(count);
  assert.equal(metrics.snapshot().sampleCount, 60);
  assert.equal(metrics.snapshot().received, 10000);
  for (const value of [null, NaN, Infinity, -1, '5']) assert.equal(metrics.record(value), false);
  assert.equal(metrics.snapshot().received, 10000);
  assert.equal(createLatencyMetrics().snapshot().average, null);
  assert.equal(createLatencyMetrics().snapshot().jitter, null);
  for (const limit of [0, 1, 601, 2.5]) assert.throws(() => createLatencyMetrics(limit));
});

test('latency thresholds include 50 and 150 in warning and accept zero RTT', () => {
  for (const [value, expected] of [[0, 'good'], [49.99, 'good'], [50, 'warning'], [150, 'warning'],
    [150.01, 'poor'], [null, 'neutral'], [NaN, 'neutral']]) assert.equal(latencyQuality(value), expected);
});

test('only one probe is in flight and acknowledgement schedules the next interval', () => {
  const setup = harness();
  setup.monitor.start();
  setup.monitor.start();
  assert.equal(setup.probes.length, 1);
  assert.equal(setup.timers.size, 0);
  setup.advance(25);
  setup.probes[0](null);
  assert.equal(setup.latest().current, 25);
  assert.equal(setup.latest().status, 'Connected');
  assert.equal(setup.timers.size, 1);
  setup.tick();
  assert.equal(setup.probes.length, 2);
  assert.equal(setup.latest().sent, 2);
});

test('timeout does not become a latency sample and the loop recovers', () => {
  const setup = harness();
  setup.monitor.start();
  setup.advance(4000);
  setup.probes[0](new Error('ack timed out'));
  assert.equal(setup.latest().timeouts, 1);
  assert.equal(setup.latest().received, 0);
  assert.equal(setup.latest().current, null);
  setup.tick();
  setup.advance(12);
  setup.probes[1](null);
  assert.equal(setup.latest().current, 12);
});

test('hidden tabs invalidate pending probes and resume without duplicate timers', () => {
  const setup = harness();
  setup.monitor.start();
  setup.monitor.setVisible(false);
  setup.advance(20000);
  setup.probes[0](null);
  assert.equal(setup.latest().received, 0);
  assert.equal(setup.latest().status, 'Paused');
  assert.equal(setup.timers.size, 0);
  setup.monitor.setVisible(true);
  setup.monitor.setVisible(true);
  assert.equal(setup.probes.length, 2);
  setup.advance(8);
  setup.probes[1](null);
  assert.equal(setup.latest().current, 8);
  assert.equal(setup.timers.size, 1);
});

test('disconnects clear live RTT while retaining historical metrics and ignore stale acknowledgements', () => {
  const setup = harness();
  setup.monitor.start();
  setup.advance(10);
  setup.probes[0](null);
  setup.tick();
  setup.socket.connected = false;
  setup.socket.emit('disconnect');
  assert.equal(setup.latest().current, null);
  assert.equal(setup.latest().average, 10);
  assert.equal(setup.latest().status, 'Reconnecting');
  setup.socket.connect();
  setup.probes[1](null);
  assert.equal(setup.latest().received, 1);
  setup.advance(20);
  setup.probes[2](null);
  assert.equal(setup.latest().received, 2);
  assert.equal(setup.timers.size, 1);
});

test('browser scheduling stalls do not inflate latency or timeout counts', () => {
  const setup = harness();
  setup.monitor.start();
  setup.advance(30000);
  setup.probes[0](new Error('delayed timeout'));
  assert.equal(setup.latest().received, 0);
  assert.equal(setup.latest().timeouts, 0);
  assert.equal(setup.latest().current, null);
  assert.equal(setup.timers.size, 1);
});

test('offline and disposal stop measurement and remove listeners', () => {
  const setup = harness();
  setup.monitor.start();
  setup.monitor.setOnline(false);
  assert.equal(setup.latest().status, 'Disconnected');
  setup.probes[0](null);
  assert.equal(setup.latest().received, 0);
  setup.monitor.setOnline(true);
  assert.equal(setup.probes.length, 2);
  setup.monitor.dispose();
  setup.monitor.dispose();
  assert.equal(setup.timers.size, 0);
  assert.equal(setup.socket.listenerCount('connect'), 0);
  assert.equal(setup.socket.io.listenerCount('reconnect_attempt'), 0);
  assert.equal(setup.socket.connected, false);
});

test('interval changes replace the loop without accepting stale probes', () => {
  const setup = harness();
  setup.monitor.start();
  setup.monitor.setIntervalMs(2000);
  assert.equal(setup.probes.length, 2);
  setup.probes[0](null);
  assert.equal(setup.latest().received, 0);
  setup.advance(15);
  setup.probes[1](null);
  assert.equal([...setup.timers.values()][0].delay, 2000);
  assert.equal(setup.latest().intervalMs, 2000);
  for (const value of [0, 999, 10001, NaN]) assert.throws(() => setup.monitor.setIntervalMs(value));
});