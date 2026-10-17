# Fratel: Geolocation & Network Quality Dashboard

Phases 1 through 3 implement the Express IP geolocation API, a same-origin
Leaflet dashboard comparing IP and browser locations, and live Socket.IO
latency telemetry. VPN heuristics and exports belong to Phase 4.

## Run

Requires Node.js 22.9+ (Node.js 24 LTS recommended) and npm.

```powershell
npm.cmd install
npm.cmd start
```

Open http://127.0.0.1:3000/ for the dashboard, or `/api/geoip` for JSON.
Use `npm.cmd run dev` for automatic restarts, `npm.cmd test` for deterministic
tests, and `npm.cmd run check` for JavaScript syntax checks.

Optional configuration: copy `.env.example` to `.env` using `Copy-Item .env.example .env`.
The start/dev scripts load it automatically; no API key is required.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listening port |
| `HOST` | `127.0.0.1` | Loopback by default; explicitly use `0.0.0.0` for network access |
| `NODE_ENV` | unset | `production` disables automatic localhost mock |
| `GEOIP_MODE` | `auto` | `auto`: localhost mock or public IP lookup; `mock`: explicitly offline |
| `CORS_ORIGINS` | localhost/127.0.0.1/[::1] port 3000 | Exact HTTP(S) origins for API and Socket.IO, no trailing slash; also supplies CSP WebSocket origins |
| `TRUST_PROXY` | empty | Only known reverse proxy IPs/CIDRs; never `true` or hop counts |

If Node.js is unavailable on PATH, the implementation session prepared a
checksum-verified portable installation under `%LOCALAPPDATA%\fratel-tools`.
For a new PowerShell terminal, activate that installation before running npm:

```powershell
$nodeHome = Get-ChildItem "$env:LOCALAPPDATA\fratel-tools" -Directory -Filter 'node-*-win-x64' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$env:Path = "$($nodeHome.FullName);$env:Path"
npm.cmd start
```

## API Contract

`GET /api/geoip` returns:

```json
{
  "ip": "127.0.0.1",
  "latitude": 51.5074,
  "longitude": -0.1278,
  "city": "London (development fixture)",
  "country": "United Kingdom",
  "countryCode": "GB",
  "isp": "Mock ISP",
  "asn": "AS00000",
  "source": "mock",
  "isMock": true,
  "fallbackReason": "localhost_development"
}
```

The London fixture is **not your actual location**. Loopback includes IPv4,
IPv6, and IPv4-mapped IPv6. Other private/reserved IPs return `422 NON_PUBLIC_IP`
in auto mode, rather than sending them to an external service. Use explicit
mock mode for offline/LAN development. Production loopback also returns 422.

Public IPs use `https://ipapi.co/{ip}/json/`; `source` becomes `ipapi.co`,
`isMock` becomes false, and `fallbackReason` becomes null. Missing optional
city/country/ISP/ASN fields are null. Requests disclose the public IP to ipapi.co,
whose accuracy, service availability, usage terms, and free-tier quotas apply.
The frontend requests browser coordinates with permission. They are held in
tab memory, never sent to this backend, and never persisted by the application.
OpenStreetMap receives the requested map tile areas and your network IP;
the visible map area can reveal approximate location. Leaflet and icons are
served locally, not from a CDN. IP geolocation remains an external lookup.

Failures use `{ "error": { "code": "...", "message": "..." } }`:
400 invalid IP, 403 disallowed browser origin, 422 non-public IP, 429 local
rate limit (60 lookups/IP/minute), 502 provider failure/invalid data, or 504
provider timeout (4 seconds). Provider failures never silently become mock data.
The rate limiter is in-memory and per process; multi-instance production deployments
will need a shared store. CORS is not authentication or an API access boundary.

## Verification

1. Start the server and run `Invoke-RestMethod http://127.0.0.1:3000/api/geoip`.
   Expect the labeled localhost mock, with latitude/longitude, ISP, and ASN.
2. Send a spoofed header: `Invoke-RestMethod http://127.0.0.1:3000/api/geoip -Headers @{ 'X-Forwarded-For' = '8.8.8.8' }`.
   With default settings, it must still report localhost, not 8.8.8.8.
3. To test real lookup locally, temporarily set `TRUST_PROXY=127.0.0.1,::1`
   in `.env`, restart, and repeat step 2. Expect an ipapi.co response, or a
   structured 502/504 if the provider is unavailable or rate-limited. This
   intentionally looks up 8.8.8.8, not your own connection's public IP. Remove
   this setting afterward; only trust real, controlled proxies in deployment.
4. Test IPv6 using `HOST=::1` and `http://[::1]:3000/api/geoip`. Expect a mock.
   Set `NODE_ENV=production` and restart to verify localhost returns 422 instead.
5. Run `npm.cmd test`. Tests stub external lookups and cover proxy-chain spoofing,
   loopback forms, private addresses, coordinates at zero, missing fields,
   provider errors/timeouts/invalid JSON, CORS preflight/denial, rate limits,
   configuration validation, JSON errors, and security headers.

Security review: Helmet headers, disabled framework identification, no-store
responses, exact-origin CORS, validated IPs, fixed HTTPS provider host, disabled
provider redirects, finite coordinate bounds, and no raw provider errors or
IP logging. Forwarded headers only affect `req.ip` behind explicitly trusted
proxies. Configure proxies to sanitize forwarding headers. Serve over HTTPS in
production. The frontend uses textContent for untrusted provider text. The CSP
allows local scripts and the OpenStreetMap tile host; inline styles are allowed
for Leaflet's runtime positioning, but inline scripts are not.

## Phase 2: Browser Verification

The Phase 2 server started during development at http://127.0.0.1:3001/ because
the Phase 1 process already occupied port 3000. Future `npm.cmd start` runs
default to port 3000. If changing ports, set `PORT` and update `CORS_ORIGINS`
to match the frontend origin. Backend changes require a restart, or use
`npm.cmd run dev`. Do not open `public/index.html` directly with `file://`.

1. Open the dashboard in Chrome or Edge. Allow the location prompt. Expect a
   blue IP marker, red browser marker, browser accuracy circle, connecting
   dashed line, and distance in kilometers/miles. Localhost IP results are
   explicitly labeled mock London data, including the distance caveat.
2. Open DevTools, press Ctrl+Shift+P, and choose **Show Sensors**. Under
   **Location**, select **Other...**, enter latitude `40.7128` and longitude
   `-74.0060`, then click **Refresh locations**. Against the localhost London
   fixture, expect about **5,570.23 km / 3,461.18 miles**. Override does not
   bypass the browser's site permission or OS location settings.
3. Set Sensors coordinates to `51.5074`, `-0.1278` to verify a zero offset.
   The two markers overlap at this location; restore New York to separate them.
4. In the browser site controls next to the address bar, block Location and
   refresh. Expect **Blocked**, a permission error, the IP marker remaining,
   and no distance. Re-enable Location and retry to verify recovery. Site
   permissions are origin-specific, including the port.
5. Choose **Location unavailable** in Sensors and refresh. Expect an unavailable
   GPS message, not an unhandled exception. Unsupported APIs and insecure
   non-localhost HTTP pages also show specific fallback messages. Use HTTPS
   for non-localhost deployment; requesting high accuracy cannot guarantee GPS.
6. To simulate a GPS timeout, choose a location available in Sensors, then in
   DevTools Console temporarily replace the browser method:

   ```javascript
   navigator.geolocation.getCurrentPosition = (success, failure) => failure({ code: 3 });
   ```

   Refresh locations to see the timeout state; reload the page to restore the
   native API. Browser acquisition times out after 15 seconds, with an outer
   20-second guard for permission prompts or browsers that never call back.
7. In DevTools Network request blocking, block `*/api/geoip` and refresh.
   GPS should remain usable with no distance. Unblock and retry. Slow network
   throttling exercises either arrival order; IP fetch has an 8-second timeout.
   Repeated refreshes cancel the previous fetch and ignore stale GPS results.
8. Block `*tile.openstreetmap.org*` and pan/zoom to request new tiles. The tile
   warning must leave location readouts and distance functional. Blocking
   `*/vendor/leaflet/leaflet.js` before a reload tests library-load failure.
   Unblock requests and reload to recover.
9. Test widths of 375px and 1440px using device emulation. The sidebar moves
   below the map on narrow screens. In DevTools Rendering, emulate dark mode
   and reduced motion. Zoom buttons and the fit-locations icon remain usable.
10. Run `npm.cmd test` and `npm.cmd run check` for all API, static-asset,
    distance, coordinate-boundary, and browser-location helper checks.

Phase 2 self-review: GPS/IP settle independently, missing or denied positions
never become zero coordinates, Haversine is clamped for antipodal rounding,
antimeridian lines take the short path, refreshes remove stale layers, timers
are cleared when requests settle, and API/GPS/library/tile errors have separate
fallbacks. GPS accuracy is an estimate, not proof of GPS hardware. The embedded
VS Code browser cannot automate native permission grants; browser rendering
checks used controlled GPS callbacks, while native permission testing remains
the manual Chrome/Edge check above.

## Phase 3: Network Telemetry

The current Phase 3 server is running at http://127.0.0.1:3002/ because the
earlier servers occupy ports 3000 and 3001. For future starts, use the normal
run commands above, or set `PORT=3002` and
`CORS_ORIGINS=http://127.0.0.1:3002,http://localhost:3002` in `.env`.
Use a single server process when restarting on an occupied port.

Socket.IO starts with WebSocket and falls back to HTTP polling if necessary.
The same HTTP server serves the UI, API, client bundle, and realtime endpoint;
reverse proxies must forward `/socket.io/` and support WebSocket upgrades.
`CORS_ORIGINS` enforces allowed browser origins on both transport handshakes.
Non-browser clients without an Origin header are allowed; this is not authentication.
No GPS or IP geolocation fields are included in telemetry messages.

### Metric Definitions

- Current RTT: application-level round trip from `performance.now()` immediately
  before a payload-free `telemetry:ping` event to its empty acknowledgement.
  Includes browser scheduling and server processing, not just wire latency.
- Average/minimum/maximum: the most recent **60 successful measurements**.
  Older samples are discarded, keeping memory bounded. History remains across
  transport reconnects and tab pauses, but resets on a new page session.
- Jitter: mean absolute difference between consecutive RTTs within that window.
  It is unavailable until two successful measurements exist.
- Pings sent/acknowledged/timeouts: session-wide counters, independent of the
  rolling window. Cancelled probes during pauses/reconnects/interval changes are
  not counted as timeouts, so sent may exceed acknowledged plus timeouts.
- Interval: 1, 1.5 (default), or 2 seconds **after each completed probe**. One
  probe is in flight at a time; acknowledgement timeout is 4 seconds. Socket.IO
  also has a separate internal heartbeat for connection liveness.
- Thresholds: green below 50 ms, yellow from 50 through 150 ms inclusive, red
  above 150 ms, on timeout, or when disconnected/reconnecting. Paused and
  not-yet-measured states are neutral; color is accompanied by a text label.

Measurements pause when the tab is hidden or the browser is offline. In-flight
callbacks are invalidated before resuming. A callback delayed beyond the
4-second deadline plus 250 ms scheduling tolerance is discarded rather than
reported as an extreme RTT or a network timeout. This guard cannot identify
every smaller browser scheduling delay. Timeouts are application probe failures,
**not measured IP packet loss**. TCP/WebSocket can retransmit lost packets.

### Verification Steps

1. Open the Phase 3 URL. The Network quality panel should show **Connected**,
   **WebSocket** (or HTTP polling), an updating current RTT, and ping counters.
   Jitter appears after the second acknowledgement. Denying GPS must not stop it.
2. Change Interval to 1 or 2 seconds. Counts should keep increasing without a
   duplicate loop. Refresh locations to confirm it does not reset telemetry.
3. Open DevTools **Network**, choose **Slow 3G**, or add a custom throttling
   profile with high latency, and reload. If the connection's RTT crosses 50 or
   150 ms, expect yellow or red respectively. **Chrome versions differ in how
   they throttle established WebSocket frames**; unchanged RTT does not prove
   the implementation is broken. For HTTP-only throttling, temporarily use
   DevTools Local Overrides on `network.js` to set `transports: ['polling']`,
   reload, and apply the throttling profile. Remove the override afterward.
   For realistic raw WebSocket delay, use an OS-level network emulator on a
   test connection instead. Deterministic threshold tests are also automated.
4. Select **Offline** in DevTools Network. Expect **Disconnected**, red quality,
   no current RTT, and retained history. Restore **No throttling** and verify
   automatic measurement recovery. An existing WebSocket can behave differently
   across Chrome versions; step 5 tests actual transport loss independently.
5. Stop the current backend with Ctrl+C, leaving the browser open. Expect
   **Reconnecting** with current RTT cleared. Restart on the **same port** and
   with matching `CORS_ORIGINS`. The client should reconnect automatically with
   jitter/history retained. Retry delay grows from about 1 to 5 seconds with
   randomization; failed connection attempts can take up to 5 seconds each.
6. Switch to another browser tab and return. Measurement pauses while hidden
   and resumes without a huge artificial RTT or a burst of queued pings.
   Browser/OS scheduling delays can still influence application RTT.
7. Chrome's standard throttling controls do not expose a reliable packet-loss
   percentage for WebSockets. Use Offline or stop/start to test interruptions;
   use an OS network emulator for actual loss. Acknowledgement timeouts and
   scheduling-stall behavior have deterministic coverage in the test suite.
8. Test desktop/mobile widths and dark mode. Verify all metric labels and
   numbers fit, and the interval selector remains usable. The rolling sample
   count must stop growing at `60 / 60`, while session counters keep increasing.
9. Run `npm.cmd test` and `npm.cmd run check`. Integration tests open real
   WebSocket and polling connections, reject untrusted origins, acknowledge
   minimal events, reconnect, and verify local client security headers.

Phase 3 self-review: only one probe is scheduled at a time; recent samples are
bounded; acknowledgements have timeouts and are not buffered while offline;
stale callbacks cannot update current metrics; visibility/offline transitions
clear scheduled work; page lifecycle cleanup removes listeners and disconnects
the socket; back-forward cache restoration starts a fresh monitor. The server
limits messages to 1 KiB and acknowledges at most four telemetry events per
second per socket. This is not a global connection limiter or authentication.
Socket.IO assets are served through Express/Helmet rather than a bypass route.
The CSP explicitly allows only WebSocket equivalents of configured origins.