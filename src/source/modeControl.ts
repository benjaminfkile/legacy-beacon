// Drives the legacy tracker's mode from this beacon's heartbeat answer
// (legacy-beacon.md 3). RUN-SHOW (1) while the beacon is active, not revoked,
// and an event is live; END-SHOW (2) once that stops after this controller
// owned the tracker, or while active with no live event; otherwise hands off.
// A request goes out only when the polled mode is fresh and differs from the
// wanted one, one at a time, at least 5 s apart, with a 3 s timeout. The token
// and the full request URL never reach a log line or the stats; the host and
// the tracker id are the most that is logged.

import type { BeaconState } from "beacon-library";
import type { PollerStats } from "./poller.js";

export interface ModeControlStats {
  enabled: true;
  owned: boolean;
  wanted: 1 | 2 | null;
  polledMode: number | null;
  lastSetAt: string | null;
  lastSetValue: number | null;
  lastSetStatus: number | null;
  lastSetError: string | null;
  setsOk: number;
  setsFailed: number;
}

export interface ModeControlLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
}

export interface ModeControllerOptions {
  url: string;
  auth: string;
  state: BeaconState;
  pollerStats: () => PollerStats | null;
  log: ModeControlLogger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface ModeController {
  evaluate(): void;
  stop(): void;
  stats(): ModeControlStats;
}

export const MODE_FRESH_MS = 5000;
export const MODE_SPACING_MS = 5000;
export const MODE_TIMEOUT_MS = 3000;

export function createModeController(opts: ModeControllerOptions): ModeController {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const target = new URL(opts.url);
  const logTarget = { host: target.host, id: target.searchParams.get("id") };

  let owned = false;
  let stopped = false;
  let inFlight: AbortController | null = null;
  let lastStartedMs: number | null = null;
  const stats: ModeControlStats = {
    enabled: true,
    owned: false,
    wanted: null,
    polledMode: null,
    lastSetAt: null,
    lastSetValue: null,
    lastSetStatus: null,
    lastSetError: null,
    setsOk: 0,
    setsFailed: 0,
  };

  function polledMode(): number | null {
    const p = opts.pollerStats();
    if (!p || p.consecutiveFailures !== 0 || p.lastSuccessAtMs === null) return null;
    if (now() - p.lastSuccessAtMs > MODE_FRESH_MS) return null;
    const mode = p.lastPayload?.mode;
    return typeof mode === "number" ? mode : null;
  }

  function wantedMode(): 1 | 2 | null {
    const hb = opts.state.lastHeartbeat;
    if (!opts.state.revoked && hb?.isActive === true && hb.liveEventId !== null) return 1;
    if (owned || hb?.isActive === true) return 2;
    return null;
  }

  // Keeps the token out of anything that is logged or reported.
  function scrub(text: string): string {
    return text.split(opts.auth).join("[redacted]");
  }

  async function send(from: number, to: 1 | 2): Promise<void> {
    const controller = new AbortController();
    inFlight = controller;
    const startedMs = now();
    lastStartedMs = startedMs;
    stats.lastSetAt = new Date(startedMs).toISOString();
    stats.lastSetValue = to;
    stats.lastSetStatus = null;
    stats.lastSetError = null;

    const url = new URL(opts.url);
    url.searchParams.set("auth", opts.auth);
    url.searchParams.set("value", String(to));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MODE_TIMEOUT_MS);

    let status: number | null = null;
    let reason: string | null = null;
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        credentials: "omit",
        signal: controller.signal,
      });
      status = res.status;
      // The body is not used; release it.
      await res.body?.cancel().catch(() => {});
      if (!res.ok) reason = `http ${res.status}`;
    } catch (err) {
      reason = timedOut
        ? "timeout"
        : scrub(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      if (inFlight === controller) inFlight = null;
    }

    // An abort by stop() is not a failure worth reporting.
    if (stopped && !timedOut && reason !== null) return;
    stats.lastSetStatus = status;
    if (reason === null) {
      stats.setsOk += 1;
      opts.log.info({ ...logTarget, from, to, status }, "legacy mode set");
    } else {
      stats.setsFailed += 1;
      stats.lastSetError = reason;
      opts.log.warn({ ...logTarget, from, to, status, reason }, "legacy mode set failed");
    }
  }

  function evaluate(): void {
    if (stopped) return;
    const wanted = wantedMode();
    const polled = polledMode();
    if (wanted === 1) owned = true;
    if (wanted === 2 && polled === 2) owned = false;
    stats.owned = owned;
    stats.wanted = wanted;
    stats.polledMode = polled;

    if (wanted === null || polled === null || polled === wanted) return;
    if (wanted === 2 && polled !== 1) return;
    if (inFlight) return;
    if (lastStartedMs !== null && now() - lastStartedMs < MODE_SPACING_MS) return;
    void send(polled, wanted);
  }

  function stop(): void {
    stopped = true;
    inFlight?.abort();
    inFlight = null;
  }

  return { evaluate, stop, stats: () => ({ ...stats }) };
}
