# Legacy beacon: technical design

The legacy beacon is an ordinary enrolled beacon (contracts 9) whose fixes come from the legacy tracker: it polls `https://santatracker-api.herokuapp.com/get?id=406santa` once a second, normalizes whatever comes back into the location body of contracts 4.2, and posts it every second in every mode, over the hub with the HTTP fallback every beacon has. It heartbeats every 15 s with the raw legacy payload and its poll statistics as its `debug` object. It has no user interface; the admin panel's beacon page is its whole face. It runs on the fleet behind the gateway as a manifest service.

Every name, shape, path, and rule below is the one in the shared contracts (`docs/contracts.md`); the contract wins on any difference. Choices this document makes are in section 10; choices that need the owner are in section 11.

---

## 1. Shape

| Piece | Choice |
|---|---|
| Runtime | Node 22, TypeScript strict, ES modules, `@microsoft/signalr` (WebSockets only, negotiation skipped), native `fetch`, `pino` logging (JSON lines); no database, no HTTP surface but the health probe |
| Container | `node:22-alpine`, port 3000, `GET /api/health`; deployed exactly like the API (platform.md 3.6, 9.2a) |
| Tests | Vitest for the normalizer, the poller, the send-loop decision table; a soak note like Red-Nose's |
| Repository | `legacy-beacon`, branches `grunt`, `dev`, `main`; `contracts/` vendored with `CONTRACTS_SHA` and a contracts check (contracts 13) |

```
legacy-beacon/
  package.json  tsconfig.json  Dockerfile  .github/workflows/deploy.yml  .github/workflows/ci.yml
  CONTRACTS_SHA  contracts/  scripts/check-contracts.mjs
  docs/legacy-beacon.md  docs/DESIGN.md  docs/contracts.md  docs/README.md
  src/
    main.ts                     boot: config, leader monitor, poller, beacon core, http
    config.ts                   the LB_* keys, validated (section 6)
    beacon/                     the beacon core (contracts 9.2), byte-identical to simulator-beacon's src/beacon/
      socketLoop.ts  sendLoop.ts  heartbeatLoop.ts  backoff.ts  rest.ts  hub.ts  state.ts
    source/
      poller.ts                 GET LB_SOURCE_URL every LB_POLL_MS, timeouts, statistics
      normalize.ts              the legacy payload to a LocationPayload (section 3)
    leader.ts                   GET /internal/leader poll (contracts 7.5), 90 s expiry
    health.ts                   GET /api/health
  tests/
```

---

## 2. What it does

1. Boots, verifies configuration, starts polling `GET /internal/leader` (every 2 s, 1 s timeout, leader only while the latest answer is `2xx`, `isLeader`, and `evaluatedAt` under 90 s old; `LB_FORCE_LEADER=true` for local runs, refused in prod).
2. Every node serves `GET /api/health`.
3. The leader runs the poller and the beacon core: every `LB_POLL_MS` (1000) it fetches the source, normalizes the answer, and hands the result to the send loop as the latest fix; the send loop posts it over the hub or HTTP like any beacon. A node that loses leadership stops its socket and poller within one poll; the new leader starts them. Two leaders for a loop during a hand-off post the same point twice, which the API stores as two rows; harmless.
4. Heartbeats go every 15 s from the leader only; `health.socketState` is the socket's state, `health.lastFixAgeS` the age of the last successful poll (so a dead source shows as "no recent fix" on the panel), `health.batteryPercent` absent; `debug` is section 5.

---

## 3. The source and the normalizer

**Poller.** `GET LB_SOURCE_URL` with a 3 s timeout, `Accept: application/json`, no credentials (the endpoint is public). A non-2xx, a timeout, or a body that is not a JSON object counts as a failed poll: the last fix is kept, `consecutiveFailures` increments, the next poll is on schedule (no backoff on the source; it is one small GET a second). A successful poll resets the counter and stamps `lastPollAt`.

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

Every poll that yields a usable position becomes the latest fix, whatever `mode` says and whether or not the point changed since the last poll; the API decides what to do with it (stored while an event is live, `409 no_live_event` otherwise, which the send loop treats as a failed send that never counts while the heartbeat says there is no live event). Nothing about the legacy `mode` is interpreted; it rides along in `debug.source.mode` for the panel to show.

---

## 4. The beacon core

`src/beacon/` is the same code as the simulator beacon's (simulator-beacon.md 3): the socket loop (one connection, `JoinPrivateChannel` with the key, `connected` on the `joined` ack, evictions, the 1 s, 2 s, 3 s, 5 s backoff, never giving up), the send loop (one latest fix, one in-flight send, hub while connected else `POST /locations`, no fallback while the socket is up, `sendsFailedSinceBoot` only with a live event), the heartbeat loop (every 15 s over HTTP, `401` sets revoked), and the state. The two copies are kept identical by hand; a change lands in both repositories in the same wave.

---

## 5. The heartbeat's debug object

```json
{
  "source": { "url": "https://santatracker-api.herokuapp.com/get?id=406santa", "pollMs": 1000, "lastPollAt": "...", "lastStatus": 200, "lastLatencyMs": 143,
              "consecutiveFailures": 0, "pollsOk": 3600, "pollsFailed": 2, "mode": 1, "lastPayload": { "...the raw legacy object..." } },
  "normalized": { "lat": 46.91852, "lng": -114.090039, "speedMps": 0, "altitudeM": 827.5, "headingDeg": 0, "recordedAt": "..." },
  "transport": { "socketState": "connected", "reconnectCount": 0, "httpFallbackSeconds": 0, "lastReceiptLatencyMs": 88, "sendsFailedSinceBoot": 0 },
  "process": { "uptimeS": 3600, "leader": true, "instance": "i-...", "version": "0.1.0", "node": "v22.x" }
}
```

The panel renders it as a tree; nothing in it is read by anything.

---

## 6. Configuration

Flat JSON secret per environment (platform.md 3.6), every key required unless marked:

| Key | Value |
|---|---|
| `LB_ENV` | `dev` or `prod` |
| `LB_API_BASE_URL` | the WMSFO API, `https://<api-domain>` |
| `LB_BEACON_KEY` | the `wbk_` key of the beacon named `legacy-tracker`, minted in the panel |
| `LB_HUB_URL`, `LB_INGEST_CHANNEL` | `wss://<gateway-domain>/hub`, `<service>:ingest` (verified against `GET /beacons/me` at boot; a mismatch is logged) |
| `LB_GATEWAY_INTERNAL_URL` | `http://<docker-bridge-ip>:8080` |
| `LB_SOURCE_URL` | `https://santatracker-api.herokuapp.com/get?id=406santa` |
| `LB_POLL_MS` | `1000` (250 to 60000) |
| `LB_LOG_LEVEL` | `info` |
| `LB_FORCE_LEADER` (optional) | local only, refused in prod |
| `GATEWAY_REALTIME_TOKEN` | injected by the gateway; used only for `/internal/leader` |

The app fails fast on a missing key, printing the key name and never the value.

---

## 7. Deployment

Manifest entry `legacy-beacon` (`-dev`), image `legacy-beacon:<sha>-<env>`, port 3000, secret per section 6, `includeInHealth` true, no realtime fields (platform.md 3.6). CI per platform.md 9.2a. First run per environment: mint the beacon in the panel, write the secret, upsert the manifest entry from the dashboard, deploy; activate the beacon when the legacy tracker should drive the site (the night of the flight if the phone is not the source, or never). Dev runs it enrolled against the dev API as a spare so its rows are stored but never published unless someone activates it.

---

## 8. Local development

`.env.local` carries the dev keys with `LB_FORCE_LEADER=true` and `LB_GATEWAY_INTERNAL_URL=http://localhost:1`; `npm run dev` polls the real Heroku endpoint and posts into dev.

---

## 9. Tests

| Suite | Covers |
|---|---|
| `normalize` | the two samples; `lon` not `lng`; mph and feet conversions; `time` 0 becomes the poll time; unparseable speed and altitude become null; an out-of-range latitude is a failed poll; the output validates against the vendored `location.schema.json` |
| `poller` | schedule holds under failures; timeout counted as failure; statistics; the raw payload lands in the state |
| `beacon/*` | the same suites as the simulator's (they are the same files) |
| `leader` | 90 s expiry, follower on any failure, force flag refused in prod |
| Soak (dev) | 24 h enrolled as a spare against dev: heartbeat gap never over 60 s, `pollsFailed` small, no process restart; recorded under `docs/soak/<date>.md` |

---

## 10. Decisions made here

- The legacy beacon posts every second in every mode; the API's live-event rule decides what is stored. No point-change detection.
- The legacy `mode` is never interpreted; it is shown in `debug`.
- Units are converted at the edge: mph to metres per second, feet to metres, `bearing_raw` degrees as heading; accuracy is unknown and sent as null.
- `time` 0 (pre-show) becomes the poll time so `recordedAt` is always a real instant.
- Leader-gated like the simulator; no database.
- The beacon core is a verbatim copy of the simulator's.

## 11. Needs a decision

Nothing at the moment. Add here as it comes up.
