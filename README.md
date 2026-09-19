# legacy-beacon

The WMSFO v2 legacy beacon: an enrolled beacon that polls the legacy Heroku tracker once a second and posts what it reports, normalized to the API's location body. A Node and TypeScript service on the fleet behind the gateway with no user interface.

Read `docs/` before touching anything:

- `docs/legacy-beacon.md`: this repository's technical design.
- `docs/DESIGN.md`: the design overview for all of v2 (a copy; the original is in `wmsfo-api/docs`).
- `docs/contracts.md`: the shared contracts every component codes against (a copy; wins on any conflict). Section 9 is the beacon contract.

## Run, test, build

Requires Node 22 or newer. `npm ci` installs dependencies.

| Command | What it does |
|---|---|
| `npm test` | Vitest suites for the config, the normalizer, the poller, the beacon loops, and the heartbeat body shape. |
| `npm run typecheck` | `tsc --noEmit` against `tsconfig.json` (src and tests). |
| `npm run build` | `tsc -p tsconfig.build.json`; emits `dist/` for the container. |
| `npm run dev` | Runs `src/main.ts` under `ts-node`; polls the real Heroku endpoint and posts into whatever `LB_API_BASE_URL` names (see below). |
| `npm start` | Runs the built service from `dist/`. |
| `npm run contracts:check` | Verifies `contracts/` matches `wmsfo-api` at the pinned `CONTRACTS_SHA`. |
| `npm run beacon:check` | Verifies the vendored `beacon-library` tarball, its recorded SHA-256, and the pinned `BEACON_LIBRARY_SHA` still line up. |

## Local recipe (legacy-beacon.md §8)

Create `.env.local` at the repo root with the dev configuration:

```
LB_ENV=dev
LB_API_BASE_URL=https://<dev-api-domain>
LB_BEACON_KEY=wbk_<the key minted in the panel for the beacon named "legacy-tracker">
LB_HUB_URL=wss://<dev-gateway-domain>/hub
LB_INGEST_CHANNEL=wmsfo-api-dev:ingest
LB_GATEWAY_INTERNAL_URL=http://localhost:1
LB_SOURCE_URL=https://santatracker-api.herokuapp.com/get?id=406santa
LB_POLL_MS=1000
LB_LOG_LEVEL=info
LB_FORCE_LEADER=true
```

`LB_GATEWAY_INTERNAL_URL=http://localhost:1` and `LB_FORCE_LEADER=true` let the service run without a gateway: the forced leader never polls `/internal/leader`, so `GATEWAY_REALTIME_TOKEN` is not required in this mode (it is required in every other run — see legacy-beacon.md §6). `LB_FORCE_LEADER=true` is refused when `LB_ENV=prod`.

Load the file and run the dev command:

```
set -a; source .env.local; set +a
npm run dev
```

The service polls the real Heroku endpoint once a second, normalizes each answer, and posts it to dev over the hub (falling back to `POST /locations` while the socket is down). The dev beacon should be enrolled as a spare, so its rows are stored but never published unless someone activates it.

The reviewer's local checklist runs this recipe against dev with the `legacy-tracker` beacon key and watches the admin panel's beacon row for heartbeats carrying the Heroku payload in the `debug` tree and, while the dev event is live, unpublished location rows on the beacon.
