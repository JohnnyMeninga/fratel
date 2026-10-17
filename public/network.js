import { createTelemetryMonitor, latencyQuality } from './telemetry.js';

const milliseconds = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
let monitor = null;
let lifetime = null;

function text(id, value) {
  document.getElementById(id).textContent = value;
}

function render(snapshot) {
  const { current, status, lastProbe } = snapshot;
  const live = status === 'Connected';
  const quality = !live ? ['Disconnected', 'Reconnecting'].includes(status) ? 'poor' : 'neutral'
    : lastProbe === 'timeout' ? 'poor' : latencyQuality(current);
  const labels = { good: 'Low latency', warning: 'Moderate latency', poor: 'High latency', neutral: 'Awaiting sample' };
  document.getElementById('network-panel').dataset.quality = quality;
  const indicator = document.getElementById('network-connection');
  indicator.dataset.state = status;
  text('network-status', status);
  text('network-quality', !live ? status : lastProbe === 'timeout' ? 'Timed out' : labels[quality]);
  text('network-current', current === null ? '--' : milliseconds.format(current));
  for (const metric of ['average', 'min', 'max', 'jitter']) {
    text(`network-${metric}`, snapshot[metric] === null ? '--' : milliseconds.format(snapshot[metric]));
  }
  text('network-sent', snapshot.sent.toLocaleString());
  text('network-received', snapshot.received.toLocaleString());
  text('network-timeouts', snapshot.timeouts.toLocaleString());
  text('network-samples', `${snapshot.sampleCount} / ${snapshot.sampleLimit}`);
  text('network-transport', snapshot.transport === '--' ? '--' : snapshot.transport === 'websocket' ? 'WebSocket' : 'HTTP polling');
  text('network-note', snapshot.note);
}

function startTelemetry() {
  if (monitor) return;
  if (typeof window.io !== 'function') {
    document.getElementById('network-panel').dataset.quality = 'poor';
    document.getElementById('network-connection').dataset.state = 'Disconnected';
    text('network-status', 'Disconnected');
    text('network-quality', 'Unavailable');
    text('network-note', 'Realtime client could not load. Reload to retry.');
    return;
  }
  lifetime = new AbortController();
  const socket = window.io({ autoConnect: false, transports: ['websocket', 'polling'],
    tryAllTransports: true, reconnection: true, reconnectionDelay: 1000,
    reconnectionDelayMax: 5000, randomizationFactor: 0.5, timeout: 5000 });
  monitor = createTelemetryMonitor({ socket, onUpdate: render,
    intervalMs: Number(document.getElementById('ping-interval').value) });
  monitor.start();
  monitor.setVisible(!document.hidden);
  monitor.setOnline(navigator.onLine);
  const options = { signal: lifetime.signal };
  document.addEventListener('visibilitychange', () => monitor.setVisible(!document.hidden), options);
  document.getElementById('ping-interval').addEventListener('change', event => {
    monitor.setIntervalMs(Number(event.target.value));
  }, options);
  window.addEventListener('offline', () => monitor.setOnline(false), options);
  window.addEventListener('online', () => monitor.setOnline(true), options);
  if (navigator.onLine) socket.connect();
}

function stopTelemetry() {
  lifetime?.abort();
  monitor?.dispose();
  monitor = null;
  lifetime = null;
}

document.addEventListener('DOMContentLoaded', startTelemetry, { once: true });
window.addEventListener('pagehide', stopTelemetry);
window.addEventListener('pageshow', event => { if (event.persisted) startTelemetry(); });