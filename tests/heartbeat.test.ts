// The heartbeat body shape: `health` carries socketState and lastFixAgeS from
// the last successful poll (batteryPercent absent); `debug` is the section 5
// tree (source, normalized, transport, process). The whole body must also
// validate against the vendored heartbeat.schema.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { createBeaconState } from "../src/beacon/state.js";
import { buildHeartbeatDebug, buildHeartbeatHealth } from "../src/heartbeat.js";
import type { Config } from "../src/config.js";
import type { PollerStats } from "../src/source/poller.js";

const schema = JSON.parse(
  readFileSync(join(process.cwd(), "contracts/schema/heartbeat.schema.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validate = ajv.compile(schema);

const CONFIG: Config = {
  env: "dev",
  apiBaseUrl: "https://api.example.com",
  beaconKey: "wbk_x",
  hubUrl: "wss://gateway.example.com/hub",
  ingestChannel: "wmsfo-api-dev:ingest",
  gatewayInternalUrl: "http://172.17.0.1:8080",
  sourceUrl: "https://santatracker-api.herokuapp.com/get?id=406santa",
  pollMs: 1000,
  logLevel: "info",
  forceLeader: true,
  gatewayRealtimeToken: "grt_x",
};

const RAW_PAYLOAD = {
  lat: "46.918520",
  lon: "-114.090039",
  speed: "0.00 mph",
  alt: "2715 ft",
  bearing_raw: "0",
  mode: 1,
  time: "1766460807560",
};

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
    ...overrides,
  };
}

describe("heartbeat body shape (legacy-beacon.md 5, contracts 4.2)", () => {
  it("health has socketState and lastFixAgeS; batteryPercent absent", () => {
    const state = createBeaconState();
    state.socketState = "connected";
    const now = () =>
      Date.parse("2026-12-22T01:31:12.000Z"); // 5 s after the last success
    const health = buildHeartbeatHealth({ state, pollerStats: stats(), now });
    expect(health.socketState).toBe("connected");
    expect(health.lastFixAgeS).toBe(5);
    // batteryPercent must be absent, not just null: a legacy tracker has no
    // battery.
    expect("batteryPercent" in health).toBe(false);
  });

  it("health.lastFixAgeS is null when no poll has succeeded yet", () => {
    const state = createBeaconState();
    const health = buildHeartbeatHealth({
      state,
      pollerStats: stats({ lastSuccessAtMs: null, lastSuccessAt: null }),
    });
    expect(health.lastFixAgeS).toBeNull();
  });

  it("debug has the section 5 shape: source, normalized, transport, process", () => {
    const state = createBeaconState();
    state.socketState = "connected";
    state.reconnectCount = 3;
    state.httpFallbackSeconds = 12.4;
    state.lastReceiptLatencyMs = 88;
    state.sendsFailedSinceBoot = 1;
    const now = () => Date.parse("2026-12-22T02:31:07.000Z");
    const debug = buildHeartbeatDebug({
      state,
      config: CONFIG,
      pollerStats: stats(),
      bootMs: Date.parse("2026-12-22T01:31:07.000Z"),
      version: "0.1.0",
      instance: "i-abc",
      leader: true,
      now,
    });
    // The four top-level branches.
    expect(Object.keys(debug).sort()).toEqual(
      ["normalized", "process", "source", "transport"].sort(),
    );

    const source = debug.source as Record<string, unknown>;
    expect(source.url).toBe(CONFIG.sourceUrl);
    expect(source.pollMs).toBe(1000);
    expect(source.lastStatus).toBe(200);
    expect(source.pollsOk).toBe(3600);
    expect(source.pollsFailed).toBe(2);
    expect(source.consecutiveFailures).toBe(0);
    expect(source.lastLatencyMs).toBe(143);
    expect(source.mode).toBe(1);
    expect(source.lastPayload).toEqual(RAW_PAYLOAD);

    const normalized = debug.normalized as Record<string, unknown>;
    expect(normalized.lat).toBe(46.91852);
    expect(normalized.lng).toBe(-114.090039);
    expect(normalized.speedMps).toBe(0);
    expect(normalized.altitudeM).toBe(827.5);
    expect(normalized.headingDeg).toBe(0);
    expect(normalized.recordedAt).toBe("2025-12-23T03:33:27.560Z");

    const transport = debug.transport as Record<string, unknown>;
    expect(transport.socketState).toBe("connected");
    expect(transport.reconnectCount).toBe(3);
    expect(transport.httpFallbackSeconds).toBe(12);
    expect(transport.lastReceiptLatencyMs).toBe(88);
    expect(transport.sendsFailedSinceBoot).toBe(1);

    const proc = debug.process as Record<string, unknown>;
    expect(proc.uptimeS).toBe(3600);
    expect(proc.leader).toBe(true);
    expect(proc.instance).toBe("i-abc");
    expect(proc.version).toBe("0.1.0");
    expect(typeof proc.node).toBe("string");
  });

  it("debug is empty of source data before the first poll", () => {
    const state = createBeaconState();
    const debug = buildHeartbeatDebug({
      state,
      config: CONFIG,
      pollerStats: null,
      bootMs: Date.now(),
      version: "0.1.0",
      instance: "i-x",
      leader: true,
    });
    const source = debug.source as Record<string, unknown>;
    expect(source.lastPayload).toBeNull();
    expect(source.pollsOk).toBe(0);
    expect(source.pollsFailed).toBe(0);
    const normalized = debug.normalized as Record<string, unknown>;
    expect(normalized.lat).toBeNull();
    expect(normalized.recordedAt).toBeNull();
  });

  it("the full heartbeat body validates against the vendored schema", () => {
    const state = createBeaconState();
    state.socketState = "connected";
    const body = {
      sentAt: "2026-12-22T01:31:07.000Z",
      health: buildHeartbeatHealth({ state, pollerStats: stats() }),
      debug: buildHeartbeatDebug({
        state,
        config: CONFIG,
        pollerStats: stats(),
        bootMs: Date.now() - 60_000,
        version: "0.1.0",
        instance: "i-x",
        leader: true,
      }),
    };
    const ok = validate(body);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });
});
