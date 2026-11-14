// The body of GET /api/status (legacy-beacon.md 4): the source, the polled
// mode, the mode setter, and every target's beacon state, for the control
// page. Pure: the clock is passed in.

import type { BeaconState } from "beacon-library";
import type { ModeSetterStats } from "./source/modeSetter.js";
import type { NormalizedFix } from "./source/normalize.js";
import type { PollerStats } from "./source/poller.js";

// The polled mode counts only while the last poll succeeded within this long.
export const MODE_FRESH_MS = 5000;

export interface TargetStatus {
  name: string;
  apiBaseUrl: string;
  socketState: string;
  isActive: boolean | null;
  liveEventId: number | null;
  lastHeartbeatAt: string | null;
  revoked: boolean;
  latestSeqLocal: number | null;
  lastDeliveredSeqLocal: number;
  lastReceiptLatencyMs: number | null;
  sendsFailedSinceBoot: number;
  reconnectCount: number;
  httpFallbackSeconds: number;
}

export interface StatusBody {
  serverTime: string;
  source: {
    url: string;
    pollMs: number;
    lastPollAt: string | null;
    lastStatus: number | null;
    lastLatencyMs: number | null;
    consecutiveFailures: number;
    pollsOk: number;
    pollsFailed: number;
    lastSuccessAt: string | null;
    lastFailureReason: string | null;
    lastPayload: Record<string, unknown> | null;
  };
  fix: NormalizedFix | null;
  mode: {
    enabled: boolean;
    polledMode: number | null;
    inFlight: boolean;
    lastSetAt: string | null;
    lastSetValue: number | null;
    lastSetStatus: number | null;
    lastSetError: string | null;
    setsOk: number;
    setsFailed: number;
  };
  targets: TargetStatus[];
  process: { uptimeS: number; version: string; node: string; instance: string };
}

export function polledMode(stats: PollerStats | null, nowMs: number): number | null {
  if (!stats || stats.consecutiveFailures !== 0 || stats.lastSuccessAtMs === null) return null;
  if (nowMs - stats.lastSuccessAtMs > MODE_FRESH_MS) return null;
  const mode = stats.lastPayload?.mode;
  return typeof mode === "number" ? mode : null;
}

export interface StatusInput {
  sourceUrl: string;
  pollMs: number;
  pollerStats: PollerStats;
  modeStats: ModeSetterStats | null;
  targets: Array<{ name: string; apiBaseUrl: string; state: BeaconState }>;
  bootMs: number;
  version: string;
  instance: string;
  now: number;
}

export function buildStatus(input: StatusInput): StatusBody {
  const p = input.pollerStats;
  const m = input.modeStats;
  return {
    serverTime: new Date(input.now).toISOString(),
    source: {
      url: input.sourceUrl,
      pollMs: input.pollMs,
      lastPollAt: p.lastPollAt,
      lastStatus: p.lastStatus,
      lastLatencyMs: p.lastLatencyMs,
      consecutiveFailures: p.consecutiveFailures,
      pollsOk: p.pollsOk,
      pollsFailed: p.pollsFailed,
      lastSuccessAt: p.lastSuccessAt,
      lastFailureReason: p.lastFailureReason,
      lastPayload: p.lastPayload,
    },
    fix: p.lastFix,
    mode: {
      enabled: m !== null,
      polledMode: polledMode(p, input.now),
      inFlight: m?.inFlight ?? false,
      lastSetAt: m?.lastSetAt ?? null,
      lastSetValue: m?.lastSetValue ?? null,
      lastSetStatus: m?.lastSetStatus ?? null,
      lastSetError: m?.lastSetError ?? null,
      setsOk: m?.setsOk ?? 0,
      setsFailed: m?.setsFailed ?? 0,
    },
    targets: input.targets.map(({ name, apiBaseUrl, state }) => ({
      name,
      apiBaseUrl,
      socketState: state.socketState,
      isActive: state.lastHeartbeat?.isActive ?? null,
      liveEventId: state.lastHeartbeat?.liveEventId ?? null,
      lastHeartbeatAt: state.lastHeartbeat?.receivedAt ?? null,
      revoked: state.revoked,
      latestSeqLocal: state.latestFix?.seqLocal ?? null,
      lastDeliveredSeqLocal: state.lastDeliveredSeqLocal,
      lastReceiptLatencyMs: state.lastReceiptLatencyMs,
      sendsFailedSinceBoot: state.sendsFailedSinceBoot,
      reconnectCount: state.reconnectCount,
      httpFallbackSeconds: Math.round(state.httpFallbackSeconds),
    })),
    process: {
      uptimeS: Math.max(0, Math.round((input.now - input.bootMs) / 1000)),
      version: input.version,
      node: process.version,
      instance: input.instance,
    },
  };
}
