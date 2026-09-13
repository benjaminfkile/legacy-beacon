// Build the heartbeat's `health` core and `debug` object per
// legacy-beacon.md section 5. `health.socketState` is the socket's state,
// `health.lastFixAgeS` the age of the last successful poll (so a dead source
// shows as "no recent fix" on the panel), `batteryPercent` absent. `debug` is
// the section 5 tree; it is stored verbatim by the API and rendered by the
// panel as a themed JSON tree.

import type { Config } from "./config.js";
import type { BeaconState } from "./beacon/state.js";
import type { HealthCore } from "./beacon/rest.js";
import { normalize } from "./source/normalize.js";
import type { PollerStats } from "./source/poller.js";

export interface HeartbeatHealthInput {
  state: BeaconState;
  pollerStats: PollerStats | null;
  now?: () => number;
}

export function buildHeartbeatHealth(input: HeartbeatHealthInput): HealthCore {
  const now = input.now ?? (() => Date.now());
  const lastFixAgeS =
    input.pollerStats?.lastSuccessAtMs !== undefined &&
    input.pollerStats?.lastSuccessAtMs !== null
      ? Math.max(0, (now() - input.pollerStats.lastSuccessAtMs) / 1000)
      : null;
  return {
    lastFixAgeS,
    socketState: input.state.socketState,
  };
}

export interface HeartbeatDebugInput {
  state: BeaconState;
  config: Config;
  pollerStats: PollerStats | null;
  bootMs: number;
  version: string;
  instance: string;
  leader: boolean;
  now?: () => number;
}

export interface HeartbeatDebug {
  source: {
    url: string;
    pollMs: number;
    lastPollAt: string | null;
    lastStatus: number | null;
    lastLatencyMs: number | null;
    consecutiveFailures: number;
    pollsOk: number;
    pollsFailed: number;
    mode: unknown;
    lastPayload: Record<string, unknown> | null;
  };
  normalized: {
    lat: number | null;
    lng: number | null;
    speedMps: number | null;
    altitudeM: number | null;
    headingDeg: number | null;
    recordedAt: string | null;
  };
  transport: {
    socketState: string;
    reconnectCount: number;
    httpFallbackSeconds: number;
    lastReceiptLatencyMs: number | null;
    sendsFailedSinceBoot: number;
  };
  process: {
    uptimeS: number;
    leader: boolean;
    instance: string;
    version: string;
    node: string;
  };
}

export function buildHeartbeatDebug(input: HeartbeatDebugInput): Record<string, unknown> {
  const now = input.now ?? (() => Date.now());
  const stats = input.pollerStats;
  const lastPayload = stats?.lastPayload ?? null;
  const modeRaw = lastPayload && typeof lastPayload === "object" ? lastPayload.mode : undefined;
  const normalizedFix = lastPayload
    ? normalize(lastPayload, { pollTimeMs: stats?.lastPollAtMs ?? now() })
    : null;
  const n = normalizedFix && normalizedFix.ok ? normalizedFix.fix : null;
  return {
    source: {
      url: input.config.sourceUrl,
      pollMs: input.config.pollMs,
      lastPollAt: stats?.lastPollAt ?? null,
      lastStatus: stats?.lastStatus ?? null,
      lastLatencyMs: stats?.lastLatencyMs ?? null,
      consecutiveFailures: stats?.consecutiveFailures ?? 0,
      pollsOk: stats?.pollsOk ?? 0,
      pollsFailed: stats?.pollsFailed ?? 0,
      mode: modeRaw ?? null,
      lastPayload,
    },
    normalized: {
      lat: n?.lat ?? null,
      lng: n?.lng ?? null,
      speedMps: n?.speedMps ?? null,
      altitudeM: n?.altitudeM ?? null,
      headingDeg: n?.headingDeg ?? null,
      recordedAt: n?.recordedAt ?? null,
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
      leader: input.leader,
      instance: input.instance,
      version: input.version,
      node: process.version,
    },
  };
}
