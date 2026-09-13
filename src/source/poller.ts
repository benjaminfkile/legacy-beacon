// Polls LB_SOURCE_URL every LB_POLL_MS. GET with a 3 s timeout,
// `Accept: application/json`, no credentials. A non-2xx, a timeout, or a body
// that is not a JSON object counts as a failed poll: the last fix is kept,
// `consecutiveFailures` increments, the next poll is on schedule (no backoff
// on the source; it is one small GET a second). A successful poll resets the
// counter and stamps `lastPollAt`. The raw payload is kept for the heartbeat's
// debug object.

import { normalize, type LegacyPayload } from "./normalize.js";
import { setLatestFix, type BeaconState } from "../beacon/state.js";

export interface PollerStats {
  lastPollAt: string | null;
  lastPollAtMs: number | null;
  lastStatus: number | null;
  lastLatencyMs: number | null;
  consecutiveFailures: number;
  pollsOk: number;
  pollsFailed: number;
  lastSuccessAt: string | null;
  lastSuccessAtMs: number | null;
  lastFailureReason: string | null;
  lastPayload: LegacyPayload | null;
}

export interface PollerOptions {
  url: string;
  pollMs: number;
  state: BeaconState;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  onFix?: (seqLocal: number) => void;
  onError?: (reason: string) => void;
}

export interface Poller {
  start(): void;
  stop(): void;
  pollOnce(): Promise<void>;
  stats(): PollerStats;
}

function isoNow(ms: number): string {
  return new Date(ms).toISOString();
}

function createStats(): PollerStats {
  return {
    lastPollAt: null,
    lastPollAtMs: null,
    lastStatus: null,
    lastLatencyMs: null,
    consecutiveFailures: 0,
    pollsOk: 0,
    pollsFailed: 0,
    lastSuccessAt: null,
    lastSuccessAtMs: null,
    lastFailureReason: null,
    lastPayload: null,
  };
}

export function createPoller(opts: PollerOptions): Poller {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const now = opts.now ?? (() => Date.now());
  const state = opts.state;
  const stats: PollerStats = createStats();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight = false;

  function schedule(ms: number) {
    if (timer) clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => void tickAndReschedule(), ms);
  }

  async function tickAndReschedule() {
    try {
      await pollOnce();
    } finally {
      schedule(opts.pollMs);
    }
  }

  function markFailure(reason: string, status: number | null): void {
    stats.pollsFailed += 1;
    stats.consecutiveFailures += 1;
    stats.lastFailureReason = reason;
    stats.lastStatus = status;
    opts.onError?.(reason);
  }

  async function pollOnce(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    const started = now();
    stats.lastPollAtMs = started;
    stats.lastPollAt = isoNow(started);
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetchImpl(opts.url, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
      } catch (err) {
        const reason =
          err instanceof Error && err.name === "AbortError"
            ? "timeout"
            : err instanceof Error
              ? err.message
              : String(err);
        stats.lastLatencyMs = now() - started;
        markFailure(reason, null);
        return;
      }
      stats.lastLatencyMs = now() - started;
      stats.lastStatus = res.status;
      if (!res.ok) {
        markFailure(`http ${res.status}`, res.status);
        return;
      }
      let payload: unknown;
      try {
        payload = await res.json();
      } catch (err) {
        markFailure(
          `parse error: ${err instanceof Error ? err.message : String(err)}`,
          res.status,
        );
        return;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        markFailure("body not a JSON object", res.status);
        return;
      }
      const raw = payload as LegacyPayload;
      // Keep the raw payload for the heartbeat's debug tree regardless of
      // whether the position is usable.
      stats.lastPayload = raw;
      const result = normalize(raw, { pollTimeMs: now() });
      if (!result.ok) {
        markFailure(result.reason, res.status);
        return;
      }
      const fix = setLatestFix(state, result.fix);
      stats.consecutiveFailures = 0;
      stats.pollsOk += 1;
      stats.lastSuccessAtMs = now();
      stats.lastSuccessAt = isoNow(stats.lastSuccessAtMs);
      stats.lastFailureReason = null;
      opts.onFix?.(fix.seqLocal);
    } finally {
      clearTimeout(to);
      inFlight = false;
    }
  }

  function start(): void {
    schedule(0);
  }

  function stop(): void {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { start, stop, pollOnce, stats: () => stats };
}
