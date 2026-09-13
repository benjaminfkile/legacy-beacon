# Soak drill: 24 h enrolled against dev

Legacy-beacon.md §9 asks for a 24 h soak of the legacy beacon enrolled as a spare against the dev API, checking that the heartbeat gap stays under 60 s, `pollsFailed` stays small, and the process never restarts. Copy this file to `<date>.md` for each run and fill it in.

## Template

Copy to `docs/soak/YYYY-MM-DD.md` and record the drill as it runs.

```
# Soak, YYYY-MM-DD (dev, spare)

Environment:
- API base URL: https://<dev-api-domain>
- Hub URL: wss://<dev-gateway-domain>/hub
- Beacon: legacy-tracker (wbk_...), enrolled as a spare (not active)
- Started at: YYYY-MM-DDTHH:MM:SSZ
- Ended at:   YYYY-MM-DDTHH:MM:SSZ
- Runner: <name>
- Container image: legacy-beacon:<sha>-dev
- Host: <fleet node id>

Windows watched (panel + logs):
- Heartbeat gap (max seen): ___ s (target: < 60 s)
- pollsOk over 24 h: ___ (expect ~86,400 at pollMs=1000)
- pollsFailed over 24 h: ___ (target: single digits absent an outage)
- Longest consecutiveFailures burst: ___
- Socket reconnects: ___ (target: < 5, excluding gateway re-auth every ~15 min)
- httpFallbackSeconds accrued: ___ s
- Process restarts: 0 (any restart fails the drill; note the reason)
- sendsFailedSinceBoot (while live): ___ (target: 0 while dev has no live event)

Panel checks (start, +6 h, +12 h, +24 h):
- Beacon row shows heartbeats with the raw Heroku payload in the debug tree.
- Health colouring: green (socket connected, lastFixAgeS < 30, no battery row).
- No stale-since flag; no revoked banner.

Incidents (with UTC timestamps):
- (none)   or   HH:MM:SS reason, mitigation, whether it self-recovered.

Verdict: pass / fail. Reasons:
```

## When to run

- Every environment cut-over (dev before prod).
- After any change to `poller.ts`, `normalize.ts`, or the beacon core (`src/beacon/*`).
- Before every operational season, on the live dev stack the site points at.

## Notes

- The dev event should be off (`status_id` != 3) for most of the drill so the send loop only sees `409 no_live_event`, which does not count against `sendsFailedSinceBoot` (contracts 9.2). Flipping dev live for a short window is fine and useful; log the window.
- The Heroku endpoint is public; nothing about the drill exposes production data.
- A single failed poll is not an incident. A minute of consecutive failures, or a heartbeat gap above 60 s, or any process restart, is.
