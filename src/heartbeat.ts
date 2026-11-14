// Builds the heartbeat's `health` core and `debug` object for one target
// (legacy-beacon.md 5). `health.socketState` is that target's socket state,
// `health.lastFixAgeS` the age of the last successful poll (so a dead source
// shows as "no recent fix" on the panel), `batteryPercent` absent. `debug` is
// the section 5 tree; the API stores it verbatim and the panel renders it.

import type { BeaconState, HealthCore } from "beacon-library";
import type { ModeSetterStats } from "./source/modeSetter.js";
import type { PollerStats } from "./source/poller.js";

export interface HeartbeatHealthInput {
  state: BeaconState;
  pollerStats: PollerStats | null;
  now?: () => number;
}

export function buildHeartbeatHealth(input: HeartbeatHealthInput): HealthCore {
  const now = input.now ?? (() => Date.now());
  const last = input.pollerStats?.lastSuccessAtMs ?? null;
  return {
    lastFixAgeS: last !== null ? Math.max(0, (now() - last) / 1000) : null,
    socketState: input.state.socketState,
  };
}

export interface HeartbeatDebugInput {
  target: string;
  state: BeaconState;
  sourceUrl: string;
  pollMs: number;
  pollerStats: PollerStats | null;
  // The mode setter's stats; null when mode control is off.
  modeStats: ModeSetterStats | null;
  bootMs: number;
  version: string;
  instance: string;
  now?: () => number;
}

export function buildHeartbeatDebug(input: HeartbeatDebugInput): Record<string, unknown> {
  const now = input.now ?? (() => Date.now());
  const stats = input.pollerStats;
  const lastPayload = stats?.lastPayload ?? null;
  const fix = stats?.lastFix ?? null;
  return {
    target: input.target,
    source: {
      url: input.sourceUrl,
      pollMs: input.pollMs,
      lastPollAt: stats?.lastPollAt ?? null,
      lastStatus: stats?.lastStatus ?? null,
      lastLatencyMs: stats?.lastLatencyMs ?? null,
      consecutiveFailures: stats?.consecutiveFailures ?? 0,
      pollsOk: stats?.pollsOk ?? 0,
      pollsFailed: stats?.pollsFailed ?? 0,
      mode: lastPayload?.mode ?? null,
      lastPayload,
    },
    normalized: {
      lat: fix?.lat ?? null,
      lng: fix?.lng ?? null,
      speedMps: fix?.speedMps ?? null,
      altitudeM: fix?.altitudeM ?? null,
      headingDeg: fix?.headingDeg ?? null,
      recordedAt: fix?.recordedAt ?? null,
    },
    transport: {
      socketState: input.state.socketState,
      reconnectCount: input.state.reconnectCount,
      httpFallbackSeconds: Math.round(input.state.httpFallbackSeconds),
      lastReceiptLatencyMs: input.state.lastReceiptLatencyMs,
      sendsFailedSinceBoot: input.state.sendsFailedSinceBoot,
    },
    process: {
      uptimeS: Math.max(0, Math.round((now() - input.bootMs) / 1000)),
      instance: input.instance,
      version: input.version,
      node: process.version,
    },
    modeControl: input.modeStats ?? { enabled: false },
  };
}
