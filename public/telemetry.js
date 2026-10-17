export function latencyQuality(value) {
  if (!Number.isFinite(value) || value < 0) return 'neutral';
  return value < 50 ? 'good' : value <= 150 ? 'warning' : 'poor';
}

export function createLatencyMetrics(limit = 60) {
  if (!Number.isInteger(limit) || limit < 2 || limit > 600) throw new Error('Sample limit must be 2 to 600');
  const samples = [];
  let sent = 0;
  let received = 0;
  let timeouts = 0;
  return {
    attempt() { sent += 1; },
    timeout() { timeouts += 1; },
    record(value) {
      if (!Number.isFinite(value) || value < 0) return false;
      received += 1;
      samples.push(value);
      if (samples.length > limit) samples.shift();
      return true;
    },
    snapshot() {
      const count = samples.length;
      let variation = 0;
      for (let index = 1; index < count; index += 1) variation += Math.abs(samples[index] - samples[index - 1]);
      return {
        sent, received, timeouts, sampleCount: count, sampleLimit: limit,
        average: count ? samples.reduce((sum, value) => sum + value, 0) / count : null,
        min: count ? Math.min(...samples) : null,
        max: count ? Math.max(...samples) : null,
        jitter: count > 1 ? variation / (count - 1) : null,
      };
    },
  };
}

export function createTelemetryMonitor({
  socket, onUpdate, intervalMs = 1500, timeoutMs = 4000,
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  metrics = createLatencyMetrics(),
}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 1000 || intervalMs > 10000) throw new Error('Interval must be 1000 to 10000 ms');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 10000) throw new Error('Timeout must be 1000 to 10000 ms');
  let visible = true;
  let online = true;
  let started = false;
  let disposed = false;
  let timer = null;
  let version = 0;
  let probing = false;
  let current = null;
  let status = 'Connecting';
  let note = 'Establishing a connection...';
  let lastProbe = 'idle';

  function publish() {
    onUpdate({ ...metrics.snapshot(), current, status, note, intervalMs, lastProbe,
      transport: socket.io?.engine?.transport?.name ?? '--' });
  }

  function cancel() {
    version += 1;
    probing = false;
    current = null;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function measure() {
    timer = null;
    if (disposed || !started || !online || !visible || !socket.connected || probing) return;
    probing = true;
    const token = ++version;
    const began = now();
    metrics.attempt();
    publish();
    const finish = error => {
      if (disposed || !probing || token !== version || !online || !visible || !socket.connected) return;
      probing = false;
      const elapsed = now() - began;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > timeoutMs + 250) {
        current = null;
        lastProbe = 'idle';
        note = 'Measurement skipped after a browser scheduling delay.';
      } else if (error || elapsed > timeoutMs) {
        metrics.timeout();
        current = null;
        lastProbe = 'timeout';
        note = 'Ping timed out. Retrying...';
      } else {
        metrics.record(elapsed);
        current = elapsed;
        lastProbe = 'ok';
        note = 'Receiving acknowledgements.';
      }
      publish();
      timer = setTimer(measure, intervalMs);
    };
    try {
      socket.timeout(timeoutMs).volatile.emit('telemetry:ping', finish);
    } catch (error) {
      finish(error);
    }
  }

  function connected() {
    cancel();
    status = !online ? 'Disconnected' : visible ? 'Connected' : 'Paused';
    note = !online ? 'Browser is offline.' : visible ? 'Waiting for an acknowledgement...' : 'Measurement paused while the tab is hidden.';
    lastProbe = 'idle';
    publish();
    measure();
  }

  function disconnected() {
    cancel();
    status = online && socket.active ? 'Reconnecting' : 'Disconnected';
    note = online ? 'Connection interrupted. Waiting for the server.' : 'Browser is offline.';
    lastProbe = 'idle';
    publish();
  }

  function reconnecting() {
    if (!online) return;
    cancel();
    status = 'Reconnecting';
    note = 'Attempting to reconnect...';
    publish();
  }

  function failed() {
    cancel();
    status = 'Disconnected';
    note = 'Connection unavailable. Restore the network or reload to retry.';
    publish();
  }

  const socketHandlers = { connect: connected, disconnect: disconnected, connect_error: disconnected };
  const managerHandlers = { reconnect_attempt: reconnecting, reconnect_failed: failed };
  return {
    start() {
      if (started || disposed) return;
      started = true;
      for (const [event, handler] of Object.entries(socketHandlers)) socket.on(event, handler);
      for (const [event, handler] of Object.entries(managerHandlers)) socket.io.on(event, handler);
      if (socket.connected) connected();
      else publish();
    },
    setVisible(value) {
      if (disposed || visible === value) return;
      visible = value;
      cancel();
      if (socket.connected) connected();
      else publish();
    },
    setOnline(value) {
      if (disposed || online === value) return;
      online = value;
      cancel();
      if (!online) disconnected();
      else if (socket.connected) connected();
      else {
        reconnecting();
        socket.connect();
      }
    },
    setIntervalMs(value) {
      if (!Number.isFinite(value) || value < 1000 || value > 10000) throw new Error('Interval must be 1000 to 10000 ms');
      if (disposed || value === intervalMs) return;
      intervalMs = value;
      cancel();
      if (socket.connected) connected();
      else publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      for (const [event, handler] of Object.entries(socketHandlers)) socket.off(event, handler);
      for (const [event, handler] of Object.entries(managerHandlers)) socket.io.off(event, handler);
      socket.disconnect();
    },
  };
}