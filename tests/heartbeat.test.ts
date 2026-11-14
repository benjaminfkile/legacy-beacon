// The heartbeat body per target: `health` carries socketState and lastFixAgeS
// from the last successful poll (batteryPercent absent); `debug` is the
// section 5 tree (target, source, normalized, transport, process,
// modeControl). The whole body validates against the vendored schema.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { createBeaconState } from "beacon-library";
import { buildHeartbeatDebug, buildHeartbeatHealth } from "../src/heartbeat.js";
import { normalize } from "../src/source/normalize.js";
import type { ModeSetterStats } from "../src/source/modeSetter.js";
import type { PollerStats } from "../src/source/poller.js";

const schema = JSON.parse(readFileSync(join(process.cwd(), "contracts/schema/heartbeat.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validate = ajv.compile(schema);

const SOURCE_URL = "https://legacy.example/get?id=tracker-1";

const RAW_PAYLOAD = {
  lat: "46.918520",
  lon: "-114.090039",
  speed: "0.00 mph",
  alt: "2715 ft",
  bearing_raw: "0",
  mode: 1,
  time: "1766460807560",
};

const FIX = (() => {
  const r = normalize(RAW_PAYLOAD, { pollTimeMs: 0 });
  if (!r.ok) throw new Error("sample did not normalize");
  return r.fix;
})();

function stats(overrides: Partial<PollerStats> = {}): PollerStats {
  return {
    lastPollAt: "2026-12-22T01:31:07.000Z",
    lastPollAtMs: Date.parse("2026-12-22T01:31:07.000Z"),
    lastStatus: 200,
    lastLatencyMs: 143,
    consecutiveFailures: 0,
    pollsOk: 3600,
    pollsFailed: 2,
    lastSuccessAt: "2026-12-22T01:31:07.000Z",
    lastSuccessAtMs: Date.parse("2026-12-22T01:31:07.000Z"),
    lastFailureReason: null,
    lastPayload: RAW_PAYLOAD,
    lastFix: FIX,
    ...overrides,
  };
}

const MODE_STATS: ModeSetterStats = {
  enabled: true,
  inFlight: false,
  lastSetAt: "2026-12-22T01:30:00.000Z",
  lastSetValue: 1,
  lastSetStatus: 200,
  lastSetError: null,
  setsOk: 1,
  setsFailed: 0,
};

function debugFor(over: { pollerStats?: PollerStats | null; modeStats?: ModeSetterStats | null } = {}) {
  const state = createBeaconState();
  state.socketState = "connected";
  state.reconnectCount = 3;
  state.httpFallbackSeconds = 12.4;
  state.lastReceiptLatencyMs = 88;
  state.sendsFailedSinceBoot = 1;
  return buildHeartbeatDebug({
    target: "prod",
    state,
    sourceUrl: SOURCE_URL,
    pollMs: 1000,
    pollerStats: over.pollerStats === undefined ? stats() : over.pollerStats,
    modeStats: over.modeStats === undefined ? null : over.modeStats,
    bootMs: Date.parse("2026-12-22T01:31:07.000Z"),
    version: "0.2.0",
    instance: "nimbus",
    now: () => Date.parse("2026-12-22T02:31:07.000Z"),
  });
}

describe("heartbeat body (legacy-beacon.md 5, contracts 4.2)", () => {
  it("health has socketState and lastFixAgeS; batteryPercent absent", () => {
    const state = createBeaconState();
    state.socketState = "connected";
    const health = buildHeartbeatHealth({ state, pollerStats: stats(), now: () => Date.parse("2026-12-22T01:31:12.000Z") });
    expect(health.socketState).toBe("connected");
    expect(health.lastFixAgeS).toBe(5);
    expect("batteryPercent" in health).toBe(false);
  });

  it("health.lastFixAgeS is null before the first good poll", () => {
    const health = buildHeartbeatHealth({ state: createBeaconState(), pollerStats: stats({ lastSuccessAtMs: null }) });
    expect(health.lastFixAgeS).toBeNull();
  });

  it("debug has the section 5 shape", () => {
    const debug = debugFor();
    expect(Object.keys(debug).sort()).toEqual(["modeControl", "normalized", "process", "source", "target", "transport"]);
    expect(debug.target).toBe("prod");
    const source = debug.source as Record<string, unknown>;
    expect(source.url).toBe(SOURCE_URL);
    expect(source.mode).toBe(1);
    expect(source.pollsOk).toBe(3600);
    expect(source.lastPayload).toEqual(RAW_PAYLOAD);
    const normalized = debug.normalized as Record<string, unknown>;
    expect(normalized.lat).toBe(46.91852);
    expect(normalized.altitudeM).toBe(827.5);
    expect(normalized.recordedAt).toBe("2025-12-23T03:33:27.560Z");
    const transport = debug.transport as Record<string, unknown>;
    expect(transport.httpFallbackSeconds).toBe(12);
    expect(transport.sendsFailedSinceBoot).toBe(1);
    const proc = debug.process as Record<string, unknown>;
    expect(proc.uptimeS).toBe(3600);
    expect(proc.instance).toBe("nimbus");
    expect("leader" in proc).toBe(false);
  });

  it("modeControl is { enabled: false } when off and the setter's stats when on", () => {
    expect(debugFor().modeControl).toEqual({ enabled: false });
    expect(debugFor({ modeStats: MODE_STATS }).modeControl).toEqual(MODE_STATS);
  });

  it("debug is empty of source data before the first poll", () => {
    const debug = debugFor({ pollerStats: null });
    expect((debug.source as Record<string, unknown>).lastPayload).toBeNull();
    expect((debug.normalized as Record<string, unknown>).lat).toBeNull();
  });

  it("the full heartbeat body validates against the vendored schema", () => {
    const state = createBeaconState();
    state.socketState = "connected";
    const body = {
      sentAt: "2026-12-22T01:31:07.000Z",
      health: buildHeartbeatHealth({ state, pollerStats: stats() }),
      debug: debugFor({ modeStats: MODE_STATS }),
    };
    const ok = validate(body);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });
});
