# legacy-beacon

The WMSFO v2 legacy beacon: an enrolled beacon that polls the legacy Heroku tracker once a second and posts what it reports, normalized to the API's location body. A Node and TypeScript service on the fleet behind the gateway with no user interface.

Read `docs/` before touching anything:

- `docs/legacy-beacon.md`: this repository's technical design.
- `docs/DESIGN.md`: the design overview for all of v2 (a copy; the original is in `wmsfo-api/docs`).
- `docs/contracts.md`: the shared contracts every component codes against (a copy; wins on any conflict). Section 9 is the beacon contract.

The code is not yet produced; the structure in `docs/legacy-beacon.md` section 1 is the target.
