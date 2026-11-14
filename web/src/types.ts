// Wire types for the service's HTTP surface. Keep in sync with
// legacy-beacon.md 4 and src/status.ts.

export type LegacyMode = 0 | 1 | 2;

export const MODES: ReadonlyArray<{ value: LegacyMode; name: string }> = [
  { value: 0, name: "PRE-SHOW" },
  { value: 1, name: "RUN-SHOW" },
  { value: 2, name: "END-SHOW" },
];

export function modeName(value: number | null | undefined): string {
  return MODES.find((m) => m.value === value)?.name ?? (value == null ? "unknown" : `mode ${value}`);
}

export interface Fix {
  lat: number;
  lng: number;
  recordedAt: string;
  speedMps: number | null;
  altitudeM: number | null;
  headingDeg: number | null;
  accuracyM: null;
}

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
  fix: Fix | null;
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

export interface ModeAnswer {
  ok: true;
  value: LegacyMode;
  status: number;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details: unknown;
  requestId: string;
}
