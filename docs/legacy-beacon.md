# Legacy beacon: technical design

The legacy beacon is an ordinary enrolled beacon (contracts 9) whose fixes come from the legacy tracker: it polls `https://<legacy-tracker-host>/get?id=<tracker id>` once a second, normalizes whatever comes back into the location body of contracts 4.2, and posts it every second in every mode, over the hub with the HTTP fallback every beacon has. It heartbeats every 15 s with the raw legacy payload and its poll statistics as its `debug` object. When mode control is configured, the leader also drives the legacy tracker's mode from its own heartbeat answer (section 3), so activating the beacon in the admin panel while an event is live is all an operator does. It has no user interface; the admin panel's beacon page is its whole face. It runs on the fleet behind the gateway as a manifest service.

Every name, shape, path, and rule below is the one in the shared contracts (`docs/contracts.md`); the contract wins on any difference. Choices this document makes are in section 10; choices that need the owner are in section 11.

---

## 1. Shape

| Piece | Choice |
|---|---|
| Runtime | Node 22, TypeScript strict, ES modules, `beacon-library` (the beacon core and the leader monitor), native `fetch`, `pino` logging (JSON lines); no database, no HTTP surface but the health probe |
| Container | `node:22-alpine`, port 3000, `GET /api/health`; deployed exactly like the API (platform.md 3.6, 9.2a) |
| Tests | Vitest for the normalizer, the poller, the send-loop decision table; a soak note like Red-Nose's |
| Repository | `legacy-beacon`, branches `grunt`, `dev`, `main`; `contracts/` vendored with `CONTRACTS_SHA` and a contracts check (contracts 13) |

```
legacy-beacon/
  package.json  tsconfig.json  tsconfig.build.json  vitest.config.ts  Dockerfile  .github/workflows/deploy.yml  .github/workflows/ci.yml
  CONTRACTS_SHA  contracts/  scripts/check-contracts.mjs
  BEACON_LIBRARY_SHA  vendor/  scripts/check-beacon-library.mjs
  docs/legacy-beacon.md  docs/DESIGN.md  docs/contracts.md  docs/README.md
  src/
    main.ts                     boot: config, logger, hand off to service.ts
    service.ts                  wires createBeacon and gateOnLeader from beacon-library to the poller and health
    config.ts                   the LB_* keys, validated (section 6)
    heartbeat.ts                the heartbeat body: the health core and the debug object (section 5)
    source/
      poller.ts                 GET LB_SOURCE_URL every LB_POLL_MS, timeouts, statistics
      normalize.ts              the legacy payload to a LocationPayload (section 3)
      modeControl.ts            sets the legacy tracker's mode from the heartbeat answer (section 3)
    health.ts                   GET /api/health
  tests/
```

The beacon core and the leader monitor come from the `beacon-library` package: its tarball ships in `vendor/`, `BEACON_LIBRARY_SHA` pins the library commit it was packed from, and `scripts/check-beacon-library.mjs` verifies the tarball, the recorded SHA-256, and the pinned commit id on every CI run (section 9).

---

## 2. What it does

1. Boots, verifies configuration, starts polling `GET /internal/leader` (every 2 s, 1 s timeout, leader only while the latest answer is `2xx`, `isLeader`, and `evaluatedAt` under 90 s old; `LB_FORCE_LEADER=true` for local runs, refused in prod).
2. Every node serves `GET /api/health`.
3. The leader runs the poller and the beacon core: every `LB_POLL_MS` (1000) it fetches the source, normalizes the answer, and hands the result to the send loop as the latest fix; the send loop posts it over the hub or HTTP like any beacon. When mode control is configured, the leader also runs the mode controller (section 3), evaluated after every completed poll and on a 1 s backstop; it starts after the poller and stops before it. A node that loses leadership stops its mode controller, socket, and poller within one poll; the new leader starts them, so a follower never sends a mode request. Two leaders for a loop during a hand-off post the same point twice, which the API stores as two rows; harmless.
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

Every poll that yields a usable position becomes the latest fix, whatever `mode` says and whether or not the point changed since the last poll; the API decides what to do with it (stored while an event is live, `409 no_live_event` otherwise, which the send loop treats as a failed send that never counts while the heartbeat says there is no live event). The legacy `mode` never changes what is posted; it rides along in `debug.source.mode` for the panel to show, and, when mode control is configured, it is the polled mode the mode controller below confirms against.

**Mode control** (`modeControl.ts`, only when `LB_MODE_URL` and `LB_MODE_AUTH` are set, only on the leader). The legacy tracker reports new positions only while its mode is RUN-SHOW. Its mode is set with a plain `GET` of `LB_MODE_URL` with `auth` (the token) and `value` (0 PRE-SHOW, 1 RUN-SHOW, 2 END-SHOW) appended as query parameters. The controller wants RUN-SHOW while this beacon is active, not revoked, and an event is live, per the latest heartbeat answer; it then owns the tracker. It wants END-SHOW once when that stops after it owned the tracker, until the tracker reads END-SHOW and the ownership clears, or while the beacon is active with no live event and the tracker is in RUN-SHOW. Otherwise it hands off and sends nothing, so the tracker can still be set by hand. The polled mode is the `mode` of the last payload when it is a number and the last poll succeeded within 5 s; otherwise it is unknown and nothing is sent. A request goes out only when the polled mode is known and differs from the wanted one (END-SHOW only from RUN-SHOW: a tracker in PRE-SHOW is left alone), with at most one in flight, at least 5 s between request starts, a 3 s timeout, no body, and no credentials. A `2xx` counts as sent (`legacy mode set` at info, with `from`, `to`, and `status`); whether it took is confirmed only by the next polls. A non-2xx, a timeout, or a network error is logged at warn (`legacy mode set failed`, with a `reason`) and retried on the 5 s spacing, with no other backoff. No log line, error, or debug field carries the token or the full request URL; the host and the tracker `id` at most.

**Ownership** lives in the beacon's state document (contracts 4.2 and 9.5), read and written through the library's `createStateStore`, one store per service built over the beacon's REST client. This beacon's part of the document is `{ "modeControl": { "owned": boolean, "lastSetValue": 1 | 2 | null, "lastSetAt": rfc3339 | null } }`; any other top-level key is kept as it is on every write. The controller reads the document when it is created, that is when this node becomes leader, and until that read lands it does nothing at all: no request, `stateLoaded` false. A failed read is logged at warn (`mode state load failed`) and retried every 5 s. After the read, `owned` starts from `modeControl.owned` (false when absent). Whenever `owned` changes, or a mode request answers `2xx` (recorded as `lastSetValue` and `lastSetAt`, the request's start), the controller writes `modeControl`, leaving the other keys alone; a failed write is logged at warn (`mode state write failed`), keeps the in-memory value, and is retried on the next evaluation until it lands. Each evaluation also asks the store to read the document again when the latest heartbeat's `stateVersion` is ahead of the copy held, and then takes `owned` from it, unless a write of its own is still pending. The decision rule above is unchanged; only where `owned` comes from is. The document never carries the token.

---

## 4. The beacon core

The core is the `beacon-library` package, vendored at the version in package.json: the socket loop (one connection, `JoinPrivateChannel` with the key, `connected` on the `joined` ack, evictions, the 1 s, 2 s, 3 s, 5 s backoff, never giving up), the send loop (one latest fix, one in-flight send, hub while connected else `POST /locations`, no fallback while the socket is up, `sendsFailedSinceBoot` only with a live event), the heartbeat loop (every 15 s over HTTP, `401` sets revoked), and the state. This repository keeps only what is particular to this beacon: the Heroku poller, the normalizer, the heartbeat health and debug builders, the leader-gated wiring in `src/service.ts`, and the health probe.

---

## 5. The heartbeat's debug object

```json
{
  "source": { "url": "https://<legacy-tracker-host>/get?id=<tracker id>", "pollMs": 1000, "lastPollAt": "...", "lastStatus": 200, "lastLatencyMs": 143,
              "consecutiveFailures": 0, "pollsOk": 3600, "pollsFailed": 2, "mode": 1, "lastPayload": { "...the raw legacy object..." } },
  "normalized": { "lat": 46.91852, "lng": -114.090039, "speedMps": 0, "altitudeM": 827.5, "headingDeg": 0, "recordedAt": "..." },
  "transport": { "socketState": "connected", "reconnectCount": 0, "httpFallbackSeconds": 0, "lastReceiptLatencyMs": 88, "sendsFailedSinceBoot": 0 },
  "process": { "uptimeS": 3600, "leader": true, "instance": "i-...", "version": "0.1.0", "node": "v22.x" },
  "modeControl": { "enabled": true, "stateLoaded": true, "stateVersion": 3, "owned": true, "wanted": 1, "polledMode": 1, "lastSetAt": "...", "lastSetValue": 1, "lastSetStatus": 200,
                   "lastSetError": null, "setsOk": 1, "setsFailed": 0 }
}
```

`modeControl` is the controller's state while it runs (times as ISO strings, unset values null; `stateLoaded` is whether the state document has been read, `stateVersion` the version of the copy last read or written), `{ "enabled": true, "owned": false, "wanted": null }` on a node with mode control configured that does not run it, and `{ "enabled": false }` when mode control is off.

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
| `LB_SOURCE_URL` | `https://<legacy-tracker-host>/get?id=<tracker id>` |
| `LB_POLL_MS` | `1000` (250 to 60000) |
| `LB_LOG_LEVEL` | `info` |
| `LB_FORCE_LEADER` (optional) | local only, refused in prod |
| `LB_MODE_URL` (optional) | `https://<legacy-tracker-host>/mode?id=<tracker id>`, the mode endpoint with its `id` and without `auth` or `value`; set together with `LB_MODE_AUTH` |
| `LB_MODE_AUTH` (optional) | `<mode token>`, the legacy tracker's mode token; set together with `LB_MODE_URL` |
| `GATEWAY_REALTIME_TOKEN` | injected by the gateway; used only for `/internal/leader`. Required when `LB_FORCE_LEADER` is false (its only reader); a forced leader never polls that endpoint, so the token is optional in that mode |

The app fails fast on a missing key, printing the key name and never the value. `LB_MODE_URL` and `LB_MODE_AUTH` are set together or not at all: either alone, an `LB_MODE_URL` that does not parse, or one already carrying `auth` or `value` fails the same way. Both unset turns mode control off and the service behaves as without it. Only the environment whose beacon should drive the real tracker carries them; dev and prod would otherwise fight over the one tracker.

---

## 7. Deployment

Manifest entry `legacy-beacon` (`-dev`), image `legacy-beacon:<sha>-<env>`, port 3000, secret per section 6, `includeInHealth` true, no realtime fields (platform.md 3.6). CI per platform.md 9.2a: `.github/workflows/deploy.yml` is the API's with the names changed (a `test` job that runs `npm ci`, the contracts check, `typecheck`, `test`, `build`; a `deploy` job needing it, gated on a push to `dev`, environment `dev` or `prod` by ref, OIDC-assumed AWS role, ECR login, QEMU and buildx, `docker buildx build --platform linux/arm64,linux/amd64 -t <ECR_REPOSITORY>:<sha>-<env> --push .`, the gateway client-credentials token, the deploy call, and a ten-minute wait for the gateway's `done` status). The gate widens to `main` once the prod manifest entry and secrets exist. First run per environment: mint the beacon in the panel, write the secret, upsert the manifest entry from the dashboard, deploy; activate the beacon when the legacy tracker should drive the site (the night of the flight if the phone is not the source, or never). Dev runs it enrolled against the dev API as a spare so its rows are stored but never published unless someone activates it. The mode secret (`LB_MODE_URL` and `LB_MODE_AUTH`) goes only into the secret of the environment whose beacon should drive the real tracker; dev and prod would otherwise fight over the one tracker.

---

## 8. Local development

`.env.local` carries the dev keys with `LB_FORCE_LEADER=true` and `LB_GATEWAY_INTERNAL_URL=http://localhost:1`; `npm run dev` polls the real Heroku endpoint and posts into dev.

---

## 9. Tests

| Suite | Covers |
|---|---|
| `config` | every `LB_*` key validated; missing keys named but not valued; `LB_FORCE_LEADER=true` refused in prod; `GATEWAY_REALTIME_TOKEN` optional under a forced leader; `LB_MODE_URL` and `LB_MODE_AUTH` both, neither, either alone, a bad URL, a URL already carrying `auth` or `value`, the token never printed |
| `modeControl` | the mode decision table under fake timers and a fake fetch: RUN-SHOW while active and live, END-SHOW once after owning or while active with no live event, nothing when never active, revoked, in PRE-SHOW with END-SHOW wanted, or on an unknown or stale polled mode; one request in flight, 5 s spacing, 3 s timeout, retries; the request carries `id`, `auth`, and `value`; no log line or state document carries the token; over the library's fake REST, a document with `owned` true after a restart sends END-SHOW and an empty one sends nothing, ownership written by one controller is loaded by the next (the hand-off), nothing is sent before the load lands and a failed load retries after 5 s, a failed write retries on the next evaluation, an unknown top-level key survives a write, and a heartbeat `stateVersion` ahead of the copy held reloads `owned` |
| `normalize` | the two samples; `lon` not `lng`; mph and feet conversions; `time` 0 becomes the poll time; unparseable speed and altitude become null; an out-of-range latitude is a failed poll; the output validates against the vendored `location.schema.json` |
| `poller` | schedule holds under failures; timeout counted as failure; statistics; the raw payload lands in the state |
| `heartbeat` | `health.socketState` and `health.lastFixAgeS`, `batteryPercent` absent; the `debug` tree (source, normalized, transport, process, modeControl in its three shapes); the whole body validates against the vendored `heartbeat.schema.json` |
| `service.wiring` | the poller runs only while the node is leader, and a polled fix reaches the fake hub while the socket is connected; with mode control on, only the leader sends a mode request, after reading the state document, and an active, live state with the tracker in PRE-SHOW sends one RUN-SHOW; with it off no mode request is made |
| Soak (dev) | 24 h enrolled as a spare against dev: heartbeat gap never over 60 s, `pollsFailed` small, no process restart; recorded under `docs/soak/<date>.md` |

The beacon core's own suites (socket loop, send loop, heartbeat loop, hub, leader) live in the `beacon-library` repository and run there; this repository trusts the vendored library and does not re-test its behaviour.

---

## 10. Decisions made here

- The legacy beacon posts every second in every mode; the API's live-event rule decides what is stored. No point-change detection.
- The beacon drives the legacy `mode` itself when mode control is configured: RUN-SHOW while this beacon is active and an event is live, END-SHOW once when that stops or while active with no live event and the tracker in RUN-SHOW, hands off otherwise. Activating the beacon in the panel is then the whole operator action, and the panel and the API stay unaware of the legacy tracker. Ownership lives in the beacon's state document, so it survives a container restart and a hand-off to another leader: a tracker this beacon put into RUN-SHOW is still set to END-SHOW once the beacon is deactivated.
- Units are converted at the edge: mph to metres per second, feet to metres, `bearing_raw` degrees as heading; accuracy is unknown and sent as null.
- `time` 0 (pre-show) becomes the poll time so `recordedAt` is always a real instant.
- Leader-gated like the simulator; no database of its own, only the beacon's state document on the API.
- The beacon core is a verbatim copy of the simulator's.

## 11. Needs a decision

Nothing at the moment. Add here as it comes up.
