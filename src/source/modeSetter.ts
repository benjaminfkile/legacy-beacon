// Sets the legacy tracker's mode when the operator asks from the control page
// (legacy-beacon.md 3). A plain GET of LB_MODE_URL with `auth` (the token) and
// `value` (0 PRE-SHOW, 1 RUN-SHOW, 2 END-SHOW) appended, a 3 s timeout, no
// body, no credentials, one request at a time. Whether a request took is
// confirmed only by the next polls (the polled `mode`). The token and the full
// request URL never reach a log line, an answer, or the stats; the host and
// the tracker id are the most that is logged.

export type LegacyMode = 0 | 1 | 2;

export const MODE_NAMES: Record<LegacyMode, string> = {
  0: "PRE-SHOW",
  1: "RUN-SHOW",
  2: "END-SHOW",
};

export const MODE_TIMEOUT_MS = 3000;

export function isLegacyMode(value: unknown): value is LegacyMode {
  return value === 0 || value === 1 || value === 2;
}

export interface ModeSetterStats {
  enabled: true;
  inFlight: boolean;
  lastSetAt: string | null;
  lastSetValue: LegacyMode | null;
  lastSetStatus: number | null;
  lastSetError: string | null;
  setsOk: number;
  setsFailed: number;
}

export type ModeSetResult =
  | { ok: true; value: LegacyMode; status: number }
  | { ok: false; value: LegacyMode; status: number | null; reason: string };

export interface ModeSetterLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
}

export interface ModeSetterOptions {
  url: string;
  auth: string;
  log: ModeSetterLogger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface ModeSetter {
  // Resolves null when a request is already in flight.
  set(value: LegacyMode, from: number | null): Promise<ModeSetResult | null>;
  stop(): void;
  stats(): ModeSetterStats;
}

export function createModeSetter(opts: ModeSetterOptions): ModeSetter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const target = new URL(opts.url);
  const logTarget = { host: target.host, id: target.searchParams.get("id") };
  let inFlight: AbortController | null = null;

  const stats: ModeSetterStats = {
    enabled: true,
    inFlight: false,
    lastSetAt: null,
    lastSetValue: null,
    lastSetStatus: null,
    lastSetError: null,
    setsOk: 0,
    setsFailed: 0,
  };

  // Keeps the token out of anything that is logged or reported.
  function scrub(text: string): string {
    return text.split(opts.auth).join("[redacted]");
  }

  async function set(value: LegacyMode, from: number | null): Promise<ModeSetResult | null> {
    if (inFlight) return null;
    const controller = new AbortController();
    inFlight = controller;
    stats.inFlight = true;
    stats.lastSetAt = new Date(now()).toISOString();
    stats.lastSetValue = value;
    stats.lastSetStatus = null;
    stats.lastSetError = null;

    const url = new URL(opts.url);
    url.searchParams.set("auth", opts.auth);
    url.searchParams.set("value", String(value));

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
      reason = timedOut ? "timeout" : scrub(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      if (inFlight === controller) inFlight = null;
      stats.inFlight = false;
    }

    stats.lastSetStatus = status;
    if (reason === null) {
      stats.setsOk += 1;
      opts.log.info({ ...logTarget, from, to: value, status }, "legacy mode set");
      return { ok: true, value, status: status as number };
    }
    stats.setsFailed += 1;
    stats.lastSetError = reason;
    opts.log.warn({ ...logTarget, from, to: value, status, reason }, "legacy mode set failed");
    return { ok: false, value, status, reason };
  }

  return {
    set,
    stop() {
      inFlight?.abort();
      inFlight = null;
    },
    stats: () => ({ ...stats }),
  };
}
