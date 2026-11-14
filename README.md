# legacy-beacon

The WMSFO v2 legacy beacon: one service that polls the legacy Heroku tracker once a second and posts what it reports, normalized to the API's location body, to both dev and prod as an enrolled beacon in each. It has a control page on the local network for the tracker's mode and the two beacons, and runs as a systemd service on one host that starts at boot with no login.

Read `docs/` before touching anything:

- `docs/legacy-beacon.md`: this repository's technical design.
- `docs/DESIGN.md`: the design overview for all of v2 (a copy; the original is in `wmsfo-api/docs`).
- `docs/contracts.md`: the shared contracts every component codes against (a copy; wins on any conflict). Section 9 is the beacon contract.

## Run, test, build

Requires Node 22 or newer. In the root (the service) and again in `web/` (the control page): `npm ci`, then `npm test`, `npm run typecheck`, `npm run build`; `npm run lint` in `web/`.

| Command | What it does |
|---|---|
| `npm test` | Vitest suites for the config, the normalizer, the poller, the mode setter, the HTTP surface, the heartbeat body, and the wiring. |
| `npm run build` | `tsc -p tsconfig.build.json`; emits `dist/`. `npm run build:web` builds the page into `web/dist`. |
| `npm run dev` | Runs `src/main.ts` under `ts-node` with the `LB_*` keys from the environment. |
| `npm start` | Runs the built service from `dist/`; it serves the page from `web/dist`. |
| `npm run contracts:check` | Verifies `contracts/` matches `wmsfo-api` at the pinned `CONTRACTS_SHA`. |
| `npm run beacon:check` | Verifies the vendored `beacon-library` tarball, its recorded SHA-256, and the pinned `BEACON_LIBRARY_SHA` still line up. |
| `npm run dev` in `web/` | The page on port 5176 with `/api` proxied to `http://localhost:3070`. |

## Install on the host (legacy-beacon.md 7)

1. Clone the repository on `main` as the user the service runs as.
2. Write `/etc/legacy-beacon/legacy-beacon.env` with the keys of legacy-beacon.md 6 (owner root, group that user, mode 0640).
3. Run `scripts/install-service.sh`. It builds the service and the page, installs `/etc/systemd/system/legacy-beacon.service`, enables it, and restarts it.

Update later with `scripts/install-service.sh --pull`. Logs: `journalctl -u legacy-beacon`. Page: `http://<host>:3070/`.
