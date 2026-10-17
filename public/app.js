import { validCoordinates, distanceKm, mapPoints, requestBrowserLocation } from './location.js';

const state = { ip: null, gps: null, generation: 0, pending: 0, controller: null };
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
let map;
let locations;
let tileFailure = false;

function text(id, value) {
  document.getElementById(id).textContent = value;
}

function badge(source, label, tone = '') {
  const element = document.getElementById(`${source}-badge`);
  element.textContent = label;
  element.className = `badge ${tone}`;
}

function frameMap() {
  if (!map) return;
  const points = mapPoints(state.ip, state.gps);
  if (points.length === 2) map.fitBounds(points, { padding: [48, 48], maxZoom: 14, animate: false });
  else if (points.length === 1) map.setView(points[0], state.gps ? 13 : 9, { animate: false });
  else map.setView([25, 0], 2, { animate: false });
}

function mapStatus() {
  if (!map) return;
  const count = [state.ip, state.gps].filter(Boolean).length;
  text('map-status', tileFailure
    ? 'Some map tiles are unavailable. Location readouts remain available.'
    : count === 2 ? 'Both sources located.'
      : count === 1 ? state.pending ? 'One source located. Waiting for the second source.'
        : 'One source available. Check the other source status.'
        : state.pending ? 'Waiting for location sources.' : 'No locations available. Check source status.');
}

function renderLocations() {
  const points = mapPoints(state.ip, state.gps);
  text('source-count', `${points.length} / 2`);
  const offset = distanceKm(state.ip, state.gps);
  text('distance-km', offset === null ? '--' : number.format(offset));
  text('distance-miles', offset === null ? '-- miles' : `${number.format(offset * 0.6213711922)} miles`);
  text('distance-status', offset === null ? state.pending ? 'Waiting for both locations.'
    : 'Both locations are required to calculate an offset.'
    : state.ip.isMock ? 'Compared against a development fixture, not a real IP location.'
      : 'Approximate straight-line distance; location accuracy varies.');
  if (points.length) text('session-updated', `Updated ${new Date().toLocaleTimeString()}`);
  document.getElementById('fit-map').disabled = !map || !points.length;
  if (!map) return;
  locations.clearLayers();
  if (state.ip) {
    window.L.circleMarker(points[0], { radius: 9, weight: 3, color: '#ffffff', fillColor: '#2673df', fillOpacity: 1 })
      .bindTooltip(state.ip.isMock ? 'IP location (development fixture)' : 'IP location').addTo(locations);
  }
  if (state.gps) {
    const gpsPoint = points[points.length - 1];
    window.L.circle(gpsPoint, { radius: state.gps.accuracy, color: '#da454d', weight: 1, fillOpacity: 0.07 })
      .addTo(locations);
    window.L.circleMarker(gpsPoint, { radius: 9, weight: 3, color: '#ffffff', fillColor: '#da454d', fillOpacity: 1 })
      .bindTooltip('Browser location').addTo(locations);
  }
  if (points.length === 2) {
    window.L.polyline(points, { color: '#536976', weight: 2, dashArray: '6 7', opacity: 0.85 })
      .addTo(locations).bringToBack();
  }
  frameMap();
  mapStatus();
}

async function loadIp(generation, signal) {
  try {
    const response = await fetch('/api/geoip', { signal, cache: 'no-store', headers: { Accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message ?? `IP lookup failed (${response.status}).`);
    if (!validCoordinates(data) || typeof data.isMock !== 'boolean') throw new Error('IP lookup returned invalid location data.');
    if (generation !== state.generation) return;
    state.ip = data;
    text('ip-address', data.ip ?? '--');
    text('ip-place', [data.city, data.country].filter(Boolean).join(', ') || 'Location available');
    text('ip-latitude', data.latitude.toFixed(5));
    text('ip-longitude', data.longitude.toFixed(5));
    text('ip-isp', data.isp ?? 'Unavailable');
    text('ip-asn', data.asn ?? 'Unavailable');
    text('ip-status', data.isMock ? 'Development fixture. Not your actual IP location.' : `Geolocated by ${data.source ?? 'IP provider'}. Approximate location.`);
    badge('ip', data.isMock ? 'Mock data' : 'Located', data.isMock ? 'warning' : 'success');
  } catch (error) {
    if (generation !== state.generation) return;
    badge('ip', 'Unavailable', 'error');
    text('ip-place', 'IP lookup unavailable');
    text('ip-status', signal.aborted ? 'IP lookup timed out. Retry when the server is reachable.'
      : error instanceof SyntaxError ? 'IP lookup returned an unreadable response.' : error.message || 'IP lookup failed.');
  } finally {
    settle(generation);
  }
}

async function loadGps(generation) {
  try {
    const data = await requestBrowserLocation();
    if (generation !== state.generation) return;
    state.gps = data;
    text('gps-place', 'Browser position acquired');
    text('gps-latitude', data.latitude.toFixed(5));
    text('gps-longitude', data.longitude.toFixed(5));
    text('gps-accuracy', `+/- ${number.format(data.accuracy)} m`);
    text('gps-captured', new Date(data.timestamp).toLocaleTimeString());
    text('gps-status', data.accuracy > 1000 ? 'Coarse browser estimate. Device GPS may not be available.' : 'High accuracy requested; actual precision depends on your device.');
    badge('gps', data.accuracy > 1000 ? 'Coarse' : 'Located', data.accuracy > 1000 ? 'warning' : 'success');
  } catch (error) {
    if (generation !== state.generation) return;
    text('gps-place', error.code === 'GPS_DENIED' ? 'Permission denied' : 'Position unavailable');
    text('gps-status', error.message);
    badge('gps', error.code === 'GPS_DENIED' ? 'Blocked' : 'Unavailable', 'error');
  } finally {
    settle(generation);
  }
}

function settle(generation) {
  if (generation !== state.generation) return;
  state.pending -= 1;
  if (state.pending === 0) {
    document.getElementById('refresh').removeAttribute('aria-busy');
  }
  renderLocations();
}

function refresh() {
  state.controller?.abort();
  state.controller = new AbortController();
  state.generation += 1;
  state.ip = null;
  state.gps = null;
  state.pending = 2;
  document.getElementById('refresh').setAttribute('aria-busy', 'true');
  for (const id of ['ip-address', 'ip-latitude', 'ip-longitude', 'ip-isp', 'ip-asn', 'gps-latitude', 'gps-longitude', 'gps-accuracy', 'gps-captured']) text(id, '--');
  badge('ip', 'Pending');
  badge('gps', 'Pending');
  text('ip-place', 'Awaiting lookup');
  text('ip-status', 'Looking up network location...');
  text('gps-place', 'Awaiting permission');
  text('gps-status', 'Requesting high-accuracy location...');
  text('session-updated', 'Refreshing locations...');
  renderLocations();
  const generation = state.generation;
  const controller = state.controller;
  const timeout = setTimeout(() => controller.abort(), 8000);
  void loadIp(generation, controller.signal).finally(() => clearTimeout(timeout));
  void loadGps(generation);
}

function start() {
  try {
    if (!window.L) throw new Error('Map library unavailable');
    map = window.L.map('map', { zoomControl: true, scrollWheelZoom: false }).setView([25, 0], 2);
    locations = window.L.featureGroup().addTo(map);
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).on('tileerror', () => { tileFailure = true; mapStatus(); }).addTo(map);
    new ResizeObserver(() => map.invalidateSize({ pan: false })).observe(document.getElementById('map'));
  } catch {
    map = null;
    text('map-status', 'Map unavailable. Location readouts are still available.');
  }
  document.getElementById('refresh').addEventListener('click', refresh);
  document.getElementById('fit-map').addEventListener('click', frameMap);
  refresh();
}

document.addEventListener('DOMContentLoaded', start, { once: true });