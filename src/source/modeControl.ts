// Drives the legacy tracker's mode from this beacon's heartbeat answer
// (legacy-beacon.md 3). RUN-SHOW (1) while the beacon is active, not revoked,
// and an event is live; END-SHOW (2) once that stops after this controller
// owned the tracker, or while active with no live event; otherwise hands off.
// A request goes out only when the polled mode is fresh and differs from the
// wanted one, one at a time, at least 5 s apart, with a 3 s timeout. The token
// and the full request URL never reach a log line or the stats; the host and
// the tracker id are the most that is logged.
//
// Ownership lives in the beacon's state document under `modeControl`. The
// controller loads the document when it is created (this node became leader)
// and does nothing until that load lands, retrying a failed load every 5 s.
// It writes `modeControl` whenever `owned` changes or a mode request answers
// 2xx, leaving every other top-level key as it is, and retries a failed write
// on the next evaluate(). Each evaluate() also reloads the document when the
// heartbeat's stateVersion is ahead of the copy held, and takes `owned` from it
// unless a write of its own is still pending.

import { StateStoreError, type BeaconState, type StateStore } from "beacon-library";
import type { PollerStats } from "./poller.js";

export interface ModeControlDocument {
  owned: boolean;
  lastSetValue: 1 | 2 | null;
  lastSetAt: string | null;
}

// The beacon's state document: `modeControl` is this beacon's; any other
// top-level key is carried through writes untouched.
export interface BeaconDocument {
  modeControl?: ModeControlDocument;
  [key: string]: unknown;
}

export interface ModeControlStats {
  enabled: true;
  stateLoaded: boolean;
  stateVersion: number | null;
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
  store: StateStore<BeaconDocument>;
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
export const MODE_STATE_LOAD_RETRY_MS = 5000;

function readDocument(doc: BeaconDocument): ModeControlDocument {
  const m = doc.modeControl;
  const lastSetValue = m?.lastSetValue === 1 || m?.lastSetValue === 2 ? m.lastSetValue : null;
  return {
    owned: m?.owned === true,
    lastSetValue,
    lastSetAt: typeof m?.lastSetAt === "string" ? m.lastSetAt : null,
  };
}

function storeErrorFields(err: unknown): Record<string, unknown> {
  if (err instanceof StateStoreError) return { code: err.code, status: err.status };
  return { reason: err instanceof Error ? err.name : "unknown" };
}

export function createModeController(opts: ModeControllerOptions): ModeController {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const target = new URL(opts.url);
  const logTarget = { host: target.host, id: target.searchParams.get("id") };

  const store = opts.store;
  let owned = false;
  let stopped = false;
  let inFlight: AbortController | null = null;
  let lastStartedMs: number | null = null;

  // The document as this controller last read or wrote it.
  let loaded = false;
  let loadTimer: ReturnType<typeof setTimeout> | null = null;
  let knownVersion: number | null = null;
  let lastSet: Pick<ModeControlDocument, "lastSetValue" | "lastSetAt"> = {
    lastSetValue: null,
    lastSetAt: null,
  };
  // A change not yet written: `changes` counts them, `writtenChanges` is the
  // count the last successful write carried.
  let changes = 0;
  let writtenChanges = 0;
  let writing = false;
  let refreshing = false;

  const stats: ModeControlStats = {
    enabled: true,
    stateLoaded: false,
    stateVersion: null,
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

  function adopt(doc: BeaconDocument, version: number): void {
    const m = readDocument(doc);
    owned = m.owned;
    lastSet = { lastSetValue: m.lastSetValue, lastSetAt: m.lastSetAt };
    knownVersion = version;
    stats.owned = owned;
    stats.stateVersion = version;
  }

  function load(): void {
    loadTimer = null;
    store.load().then(
      (snap) => {
        if (stopped) return;
        adopt(snap.state, snap.version);
        loaded = true;
        stats.stateLoaded = true;
      },
      (err: unknown) => {
        if (stopped) return;
        opts.log.warn(
          { ...storeErrorFields(err), retryMs: MODE_STATE_LOAD_RETRY_MS },
          "mode state load failed",
        );
        loadTimer = setTimeout(load, MODE_STATE_LOAD_RETRY_MS);
      },
    );
  }

  function pending(): boolean {
    return writtenChanges !== changes;
  }

  function markChanged(): void {
    changes += 1;
    write();
  }

  // Writes `modeControl` as it stands now; one write at a time.
  function write(): void {
    if (stopped || writing || !pending()) return;
    writing = true;
    let carried = changes;
    store
      .update((doc) => {
        carried = changes;
        doc.modeControl = { owned, ...lastSet };
      })
      .then(
        (snap) => {
          writtenChanges = carried;
          knownVersion = snap.version;
          stats.stateVersion = snap.version;
        },
        (err: unknown) => {
          if (stopped) return;
          opts.log.warn(storeErrorFields(err), "mode state write failed");
        },
      )
      .finally(() => {
        writing = false;
      });
  }

  // Reloads the document when the heartbeat says it is ahead of the copy held.
  function refresh(): void {
    if (refreshing) return;
    refreshing = true;
    store
      .refreshIfBehind(opts.state.lastHeartbeat?.stateVersion ?? null)
      .then(() => {
        if (stopped) return;
        const cur = store.current();
        if (!cur || cur.version === knownVersion) return;
        if (pending() || writing) {
          knownVersion = cur.version;
          stats.stateVersion = cur.version;
          return;
        }
        adopt(cur.state, cur.version);
      })
      .catch(() => {})
      .finally(() => {
        refreshing = false;
      });
  }

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
      lastSet = { lastSetValue: to, lastSetAt: new Date(startedMs).toISOString() };
      if (!stopped) markChanged();
    } else {
      stats.setsFailed += 1;
      stats.lastSetError = reason;
      opts.log.warn({ ...logTarget, from, to, status, reason }, "legacy mode set failed");
    }
  }

  function evaluate(): void {
    if (stopped || !loaded) return;
    write();
    refresh();
    const wanted = wantedMode();
    const polled = polledMode();
    const ownedBefore = owned;
    if (wanted === 1) owned = true;
    if (wanted === 2 && polled === 2) owned = false;
    stats.owned = owned;
    if (owned !== ownedBefore) markChanged();
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
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = null;
    inFlight?.abort();
    inFlight = null;
  }

  load();
  return { evaluate, stop, stats: () => ({ ...stats }) };
}
