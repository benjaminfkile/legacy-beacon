# Legacy beacon: technical design

The legacy beacon is two ordinary enrolled beacons (contracts 9) in one process, fed by one source: it polls `https://<legacy-tracker-host>/get?id=<tracker id>` every 3 seconds, normalizes whatever comes back into the location body of contracts 4.2, and posts that same fix after every poll, in every mode, to every WMSFO environment it is configured for (dev and prod), over each environment's hub with the HTTP fallback every beacon has. To each API it is one more beacon with its own key. It heartbeats every 15 s per environment with the raw legacy payload and its poll statistics as its `debug` object. It has a control page on the local network that shows the tracker, its mode, and both beacons, and sets the tracker's mode on request. It runs as a systemd service on one host on the operator's network, starts at boot with no login, and is not a fleet service.

Every name, shape, path, and rule below is the one in the shared contracts (`docs/contracts.md`); the contract wins on any difference. Choices this document makes are in section 10; choices that need the owner are in section 11.

---

## 1. Shape

| Piece | Choice |
|---|---|
| Runtime | Node 22, TypeScript strict, ES modules, `beacon-library` (the beacon core), native `fetch`, Fastify for the HTTP surface and the static page, `pino` logging (JSON lines to the journal); no database, no leader gate (one process on one host) |
| Control page | `web/`: Vite, React 19, TypeScript, the site's token file, IBM Plex Sans and Mono, no UI library; built to `web/dist` and served by the service from the same origin |
| Host | a systemd system unit (`deploy/legacy-beacon.service`) on one machine on the operator's LAN; configuration in `/etc/legacy-beacon/legacy-beacon.env` on that machine only |
| Tests | Vitest for the config, the normalizer, the poller, the mode setter, the HTTP surface, the heartbeat body, and the service wiring; Vitest and Testing Library for the page |
| Repository | `legacy-beacon`, branches `grunt`, `dev`, `main`; `contracts/` vendored with `CONTRACTS_SHA` and a contracts check (contracts 13); `beacon-library` vendored with `BEACON_LIBRARY_SHA` |

```
legacy-beacon/
  package.json  tsconfig.json  tsconfig.build.json  vitest.config.ts  .github/workflows/ci.yml
  CONTRACTS_SHA  contracts/  scripts/check-contracts.mjs
  BEACON_LIBRARY_SHA  vendor/  scripts/check-beacon-library.mjs  scripts/check-no-infra.mjs
  deploy/legacy-beacon.service  the systemd unit template (section 7)
  scripts/install-service.sh    builds the checkout and installs or restarts the unit (section 7)
  docs/legacy-beacon.md  docs/DESIGN.md  docs/contracts.md  docs/README.md
  src/
    main.ts                     boot: config, logger, hand off to service.ts
    service.ts                  wires the poller, one beacon core per target, the mode setter, and the HTTP surface (section 2)
    config.ts                   the LB_* keys, validated (section 6)
    http.ts                     the health probe, the status, the mode request, the page (section 4)
    status.ts                   the status body the page polls (section 4)
    heartbeat.ts                the heartbeat body per target: the health core and the debug object (section 5)
    source/
      poller.ts                 GET LB_SOURCE_URL every LB_POLL_MS, timeouts, statistics
      normalize.ts              the legacy payload to a location body (section 3)
      modeSetter.ts             sets the legacy tracker's mode on request (section 3)
  web/
    src/App.tsx  ModeCard.tsx  SourceCard.tsx  BeaconsCard.tsx  api.ts  types.ts  format.ts  tokens.css  App.module.css
    tests/
  tests/
```

---

## 2. What it does

1. Boots, verifies configuration, builds one beacon (`createBeacon`) per target, starts every beacon core (socket loop, send loop, heartbeat loop), starts the poller, and serves the HTTP surface on `LB_HTTP_HOST:LB_HTTP_PORT` (default `0.0.0.0:3070`).
2. Every `LB_POLL_MS` (3000) the poller fetches the source and normalizes the answer; each usable fix becomes the latest fix of every target's beacon (`setLatestFix` and `wake` on each), so dev and prod post the same point from the same poll. The send loop of each target posts it over its hub or HTTP like any beacon.
3. Heartbeats go every 15 s per target; `health.socketState` is that target's socket state, `health.lastFixAgeS` the age of the last successful poll (so a dead source shows as "no recent fix" on the panel), `health.batteryPercent` absent; `debug` is section 5.
4. A mode request from the control page (`POST /api/mode`) sets the tracker's mode (section 3). Nothing else changes the mode: what is posted never depends on it.

A target is one WMSFO environment: an API base URL, a hub URL, an ingest channel, and the `wbk_` key of the beacon named `legacy` in that environment's panel. Targets are independent: one API or hub being down, or one beacon being revoked, changes nothing for the other.

---

## 3. The source, the normalizer, and the mode

**Poller.** `GET LB_SOURCE_URL` with a 3 s timeout, `Accept: application/json`, no credentials (the endpoint is public). A non-2xx, a timeout, or a body that is not a JSON object counts as a failed poll: the last fix is kept, `consecutiveFailures` increments, the next poll is on schedule (no backoff on the source; it is one small GET every few seconds). A successful poll resets the counter, stamps `lastSuccessAt`, and keeps the raw payload and the normalized fix.

**The legacy payload** (as observed on 2026-09-12, every value a string except `mode`, `redirect`, `count`):

```json
{ "lat": "46.918520", "lon": "-114.090039", "speed": "0.00 mph", "temp": "0", "alt": "2715 ft", "bearing": "N",
  "bearing_raw": "0", "mode": 1, "time": "1766460807560", "type": "tracker", "status": "Battery Full at 100%", "redirect": 0, "count": 0 }
```

**Normalizer** (`normalize.ts`, pure, unit tested against the sample above and the pre-show sample with `"time": 0`):

| Output | From | Rule |
|---|---|---|
| `lat` | `lat` | `Number()`; must be finite and within -90 to 90, else the poll is a failed poll ("no usable position") |
| `lng` | `lon` (the legacy field is `lon`) | `Number()`; finite, -180 to 180 |
| `recordedAt` | `time` | epoch milliseconds when `Number(time) > 0`, rendered RFC 3339 UTC with three fractional digits; otherwise the poll time |
| `speedMps` | `speed` | the leading number of `"12.34 mph"` times 0.44704, rounded to three decimals; null when absent or unparseable |
| `altitudeM` | `alt` | the leading number of `"2715 ft"` times 0.3048, rounded to one decimal; null when absent or unparseable |
| `headingDeg` | `bearing_raw` | `Number()` when finite and within 0 to 360, else null (`bearing` "N" is never used) |
| `accuracyM` | | always null; the legacy tracker reports none |

Every poll that yields a usable position becomes the latest fix of every target, whatever `mode` says and whether or not the point changed since the last poll; each API decides what to do with it (stored while an event is live, `409 no_live_event` otherwise, which the send loop treats as a failed send that never counts while the heartbeat says there is no live event).

**Mode** (`modeSetter.ts`, only when `LB_MODE_URL` and `LB_MODE_AUTH` are set). The legacy tracker reports new positions only while its mode is RUN-SHOW. Its mode is set with a plain `GET` of `LB_MODE_URL` with `auth` (the token) and `value` (0 PRE-SHOW, 1 RUN-SHOW, 2 END-SHOW) appended as query parameters. The service sends one only when the operator asks from the control page; it never sets the mode on its own. One request at a time (a second while one is in flight is refused), a 3 s timeout, no body, no credentials. A `2xx` counts as sent (`legacy mode set` at info, with `from`, `to`, and `status`); whether it took is confirmed only by the next polls, which the page shows as the polled mode. A non-2xx, a timeout, or a network error is logged at warn (`legacy mode set failed`, with a `reason`) and reported to the page; nothing retries. The polled mode is the `mode` of the last payload when it is a number and the last poll succeeded within 5 s; otherwise it is unknown. No log line, answer, error, or debug field carries the token or the full request URL; the host and the tracker `id` at most. Whatever the mode, both targets keep posting what the tracker reports.

---

## 4. The HTTP surface and the control page

One Fastify server on `LB_HTTP_HOST:LB_HTTP_PORT`, `Cache-Control: no-store` on every API answer, the contracts error shape (0.3) on every error. There is no sign-in: the host is on the operator's private network and the port is not forwarded to the internet.

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `GET /api/health` | | `200 { "status": "ok" }` | |
| `GET /api/status` | | `200 StatusBody` | |
| `POST /api/mode` | `{ "value": 0 \| 1 \| 2 }` | `200 { "ok": true, "value", "status" }` (the tracker's answer status) | `400 validation_failed` (any other value), `409 mode_control_off` (no mode pair configured), `409 mode_busy` (a request in flight), `502 upstream_failed` (the tracker refused or did not answer; `details.status` is its status or null) |
| `GET /`, `GET /assets/...` | | the built control page from `LB_WEB_DIR` (default `web/dist` beside `dist/`) | `404 not_found` for anything else |

```ts
type StatusBody = {
  serverTime: string;
  source: { url; pollMs; lastPollAt; lastStatus; lastLatencyMs; consecutiveFailures; pollsOk; pollsFailed; lastSuccessAt; lastFailureReason; lastPayload };
  fix: { lat; lng; recordedAt; speedMps; altitudeM; headingDeg; accuracyM } | null;   // the last normalized fix
  mode: { enabled; polledMode; inFlight; lastSetAt; lastSetValue; lastSetStatus; lastSetError; setsOk; setsFailed };
  targets: Array<{ name; apiBaseUrl; socketState; isActive; liveEventId; lastHeartbeatAt; revoked; latestSeqLocal; lastDeliveredSeqLocal;
                   lastReceiptLatencyMs; sendsFailedSinceBoot; reconnectCount; httpFallbackSeconds }>;   // isActive and liveEventId from the last heartbeat answer
  process: { uptimeS; version; node; instance };
};
```

**The page** (`web/`), one column of frost cards, polling `GET /api/status` every second while visible:

- **Tracker mode**: the polled mode (RUN-SHOW green, END-SHOW amber, PRE-SHOW neutral, "mode unknown" red), three buttons PRE-SHOW, RUN-SHOW, END-SHOW with the current one marked; a click shows an inline confirmation naming the mode, and Confirm sends `POST /api/mode`. The last request's mode, time, and answer (or error) show under the buttons. With mode control off the buttons are disabled and a line says so.
- **Tracker**: position, speed in mph, altitude in feet, heading, fix time, the tracker's own `status` string, the last good poll's age, latency, poll counts, and the raw payload in a collapsed block.
- **Beacons**: one panel per target: socket state, Active or Spare, the live event or "no live event", heartbeat age, delivered fixes (with "sending" while the latest is not yet delivered), receipt latency, sends failed, reconnects and HTTP fallback seconds, and a red banner when the key is revoked.
- A line at the top when the service stops answering, with the age of the last answer.

Styling: the site's token file copied (`tokens.css`, dark and light by `prefers-color-scheme`), Plex Sans and Mono; no UI library. `npm run dev` in `web/` serves the page on port 5176 and proxies `/api` to `http://localhost:3070` (`LB_API_PROXY` overrides).

---

## 5. The heartbeat's debug object

Per target, built by `buildHeartbeatHealth` and `buildHeartbeatDebug` in `heartbeat.ts`:

```json
{
  "target": "prod",
  "source": { "url": "https://<legacy-tracker-host>/get?id=<tracker id>", "pollMs": 3000, "lastPollAt": "...", "lastStatus": 200, "lastLatencyMs": 143,
              "consecutiveFailures": 0, "pollsOk": 3600, "pollsFailed": 2, "mode": 1, "lastPayload": { "...the raw legacy object..." } },
  "normalized": { "lat": 46.91852, "lng": -114.090039, "speedMps": 0, "altitudeM": 827.5, "headingDeg": 0, "recordedAt": "..." },
  "transport": { "socketState": "connected", "reconnectCount": 0, "httpFallbackSeconds": 0, "lastReceiptLatencyMs": 88, "sendsFailedSinceBoot": 0 },
  "process": { "uptimeS": 3600, "instance": "<host name>", "version": "0.2.0", "node": "v22.x" },
  "modeControl": { "enabled": true, "inFlight": false, "lastSetAt": "...", "lastSetValue": 1, "lastSetStatus": 200, "lastSetError": null, "setsOk": 1, "setsFailed": 0 }
}
```

`modeControl` is `{ "enabled": false }` when mode control is off. The panel renders the tree; nothing in it is read by anything.

---

## 6. Configuration

Environment file `/etc/legacy-beacon/legacy-beacon.env` on the host (owner root, group the service user, mode 0640), every key required unless marked:

| Key | Value |
|---|---|
| `LB_TARGETS` | comma-separated target names, each `dev` or `prod`, at least one, no repeats; `dev,prod` to feed both |
| `LB_<TARGET>_API_BASE_URL` | per target, `<TARGET>` upper case (`LB_DEV_API_BASE_URL`, `LB_PROD_API_BASE_URL`): that environment's WMSFO API, `https://<api-domain>` |
| `LB_<TARGET>_BEACON_KEY` | the `wbk_` key of the beacon named `legacy` in that environment |
| `LB_<TARGET>_HUB_URL`, `LB_<TARGET>_INGEST_CHANNEL` | `wss://<hub-domain>/hub`, `<service>:ingest` (`wmsfo-api-dev:ingest` for dev, `wmsfo-api:ingest` for prod) |
| `LB_SOURCE_URL` | `https://<legacy-tracker-host>/get?id=<tracker id>` |
| `LB_POLL_MS` (optional) | `3000` (250 to 60000) |
| `LB_MODE_URL` (optional) | `https://<legacy-tracker-host>/mode?id=<tracker id>`, the mode endpoint with its `id` and without `auth` or `value`; set together with `LB_MODE_AUTH` |
| `LB_MODE_AUTH` (optional) | `<mode token>`, the legacy tracker's mode token; set together with `LB_MODE_URL` |
| `LB_HTTP_HOST` (optional) | `0.0.0.0` |
| `LB_HTTP_PORT` (optional) | `3070` |
| `LB_WEB_DIR` (optional) | the built page; defaults to `web/dist` in the checkout |
| `LB_LOG_LEVEL` (optional) | `info` |

The app fails fast on a missing or invalid key, printing the key names and never a value, and systemd keeps restarting it until the file is fixed. Keys of a target not named in `LB_TARGETS` are ignored. `LB_MODE_URL` and `LB_MODE_AUTH` are set together or not at all: either alone, an `LB_MODE_URL` that does not parse, or one already carrying `auth` or `value` fails the same way. Both unset turns mode control off; the page then shows the mode without buttons.

---

## 7. Deployment

One host, one systemd system unit, no container and no gateway entry. On the host, as the user the service runs as:

1. Node 22 or newer on the path; a clone of this repository on `main`.
2. `/etc/legacy-beacon/legacy-beacon.env` per section 6.
3. `scripts/install-service.sh` builds the service and the page, writes `/etc/systemd/system/legacy-beacon.service` from `deploy/legacy-beacon.service` (user, checkout path, and node filled in), enables it, and restarts it. A system unit starts at boot without anyone logging in; `Restart=always` brings it back after a crash.
4. Updates: `scripts/install-service.sh --pull` fast-forwards to `origin/main`, rebuilds, and restarts.

Logs: `journalctl -u legacy-beacon`. The page: `http://<host>:3070/`.

Registration: the beacon named `legacy` exists in both environments under the same id (the row the legacy migration created, contracts 10), each with its own key, minted with `POST /admin/beacons/{id}/rotate` in that environment. The prod to dev mirror keeps dev's key for it (the job's `KEEP_DEV_BEACON_KEYS`, contracts 8.5), so dev and prod each keep their own key and a rotate on either side never touches the other. Activate the beacon in an environment's panel when the legacy tracker should drive that environment's site; until then its rows are stored while an event is live and never published.

---

## 8. Local development

`npm run dev` runs `src/main.ts` under `ts-node` with the `LB_*` keys from the environment (`set -a; source .env.local; set +a` first); with `LB_TARGETS=dev` and only dev keys it posts into dev alone. `npm run dev` in `web/` serves the page with hot reload against that service. Leave `LB_MODE_URL` and `LB_MODE_AUTH` out of a local file: the host service is the one that sets the real tracker's mode.

---

## 9. Tests

| Suite | Covers |
|---|---|
| `config` | `LB_TARGETS` parsing (one, two, unknown name, repeat, empty); per-target keys required only for named targets; missing keys named but not valued; the source URL; `LB_POLL_MS` bounds; `LB_MODE_URL` and `LB_MODE_AUTH` both, neither, either alone, a bad URL, a URL already carrying `auth` or `value`, the token never printed; host, port, web dir, log level |
| `normalize` | the two samples; `lon` not `lng`; mph and feet conversions; `time` 0 becomes the poll time; unparseable speed and altitude become null; an out-of-range latitude is a failed poll; the output validates against the vendored `location.schema.json` |
| `poller` | the fix reaches `onFix`; failures keep the last fix; timeout and network errors counted; statistics; the raw payload kept; the schedule holds under failures |
| `modeSetter` | the request carries `id`, `auth`, and `value`; non-2xx, network error, and timeout reported; one request at a time; no log line, result, or stat carries the token |
| `http` | health; status; the mode request's 200, 400, 409 `mode_control_off`, 409 `mode_busy`, and 502; the page served from the web directory; 404 elsewhere |
| `heartbeat` | `health` from the last successful poll, `batteryPercent` absent; the `debug` tree with its target and `modeControl` in both shapes; the whole body validates against the vendored `heartbeat.schema.json` |
| `service.wiring` | one polled fix reaches both targets' beacons and both fake hubs; heartbeats reach both APIs with their own target; the status lists both targets and the polled mode; a mode request over HTTP reaches the tracker with `id`, `auth`, and `value` and the status never carries the token; with mode control off no mode request is made |
| `web` | the page renders the polled mode, the fix in mph and feet, and both beacons; a mode button asks first and sends only on Confirm; a refused request shows the API's message; buttons disabled with mode control off; unknown mode and revoked banner; a failing poll shows the service is not answering; the API client's paths, body, and errors |

The beacon core's own suites (socket loop, send loop, heartbeat loop, hub) live in the `beacon-library` repository and run there; this repository trusts the vendored library and does not re-test its behaviour.

---

## 10. Decisions made here

- One process feeds dev and prod from one poll, because there is one legacy tracker and both environments need it; to each API it is one ordinary beacon with its own key, and the APIs never learn about the legacy tracker (the operator, 2026-11-14).
- The beacon is the `legacy` row both environments already have from the migration, unrevoked and given a key per environment, rather than a new row (the operator, 2026-11-14). Beacon rows are never deleted (sql.md), and that row owns the migrated flights.
- The mode is set only by the operator from the control page; the service never sets it on its own. Dev and prod heartbeats could disagree about whether an event is live, and one tracker cannot follow both (the operator, 2026-11-14).
- The service runs on one host on the operator's network as a systemd unit, not on the fleet: one process, no leader gate, no container.
- The control page has no sign-in; it is reachable from the local network only (the operator, 2026-11-14).
- The legacy beacon polls every 3 seconds (the operator, 2026-11-14) and posts every polled fix in every mode; each API's live-event rule decides what is stored. No point-change detection.
- Units are converted at the edge: mph to metres per second, feet to metres, `bearing_raw` degrees as heading; accuracy is unknown and sent as null.
- `time` 0 (pre-show) becomes the poll time so `recordedAt` is always a real instant.

## 11. Needs a decision

Nothing at the moment. Add here as it comes up.
