// The wiring in src/service.ts: gateOnLeader owns the poller through onStart
// and onStop, so the poller runs only while this node is leader; a polled fix
// reaches the fake hub while the socket is connected.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHubClient, type HubClient, type HubOptions } from "beacon-library";
import pino from "pino";
import { startService } from "../src/service.js";
import type { Config } from "../src/config.js";

const CONFIG: Config = {
  env: "dev",
  apiBaseUrl: "https://api.example.com",
  beaconKey: "wbk_x",
  hubUrl: "wss://gateway.example.com/hub",
  ingestChannel: "wmsfo-api-dev:ingest",
  gatewayInternalUrl: "http://172.17.0.1:8080",
  sourceUrl: "https://source.example.com/get",
  pollMs: 250,
  logLevel: "silent",
  forceLeader: false,
  gatewayRealtimeToken: "grt_x",
};

const LEGACY_SAMPLE = {
  lat: "46.918520",
  lon: "-114.090039",
  speed: "0.00 mph",
  alt: "2715 ft",
  bearing_raw: "0",
  mode: 1,
  time: "1766460807560",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Scenario {
  hub: FakeHubClient;
  fetchCalls: string[];
  setLeader: (v: boolean) => void;
  buildHub: (o: HubOptions) => HubClient;
  fetchImpl: typeof fetch;
}

function makeScenario(): Scenario {
  const hub = new FakeHubClient();
  const fetchCalls: string[] = [];
  let leaderNow = false;
  const fetchImpl: typeof fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    fetchCalls.push(url);
    if (url.includes("/internal/leader")) {
      return jsonResponse({ isLeader: leaderNow, evaluatedAt: new Date().toISOString() });
    }
    if (url.startsWith(CONFIG.sourceUrl)) {
      return jsonResponse(LEGACY_SAMPLE);
    }
    if (url.includes("/beacons/heartbeat")) {
      return jsonResponse({
        receivedAt: new Date().toISOString(),
        liveEventId: 1,
        isActive: true,
        serverTime: new Date().toISOString(),
      });
    }
    if (url.includes("/locations")) {
      return jsonResponse({
        seq: 1,
        published: true,
        receivedAt: new Date().toISOString(),
        serverTime: new Date().toISOString(),
      });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
  return {
    hub,
    fetchCalls,
    setLeader: (v) => {
      leaderNow = v;
    },
    buildHub: () => hub,
    fetchImpl,
  };
}

const log = pino({ level: "silent" });

describe("service.ts wiring (L7)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the poller starts only after this node becomes leader and stops when it becomes follower", async () => {
    const s = makeScenario();
    const service = startService(CONFIG, {
      log,
      version: "0.1.0",
      bootMs: Date.now(),
      instance: "test",
      fetchImpl: s.fetchImpl,
      buildHub: s.buildHub,
      healthPort: 0,
      startHealth: () => ({ port: () => 0, close: async () => {} }),
    });

    // Not leader yet: settle a few leader polls; no source poll fired.
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();
    expect(s.fetchCalls.some((u) => u.startsWith(CONFIG.sourceUrl))).toBe(false);

    // Become leader; the source URL is fetched by the poller.
    s.setLeader(true);
    // Trigger the next leader poll; default pollMs is 2000.
    await vi.advanceTimersByTimeAsync(2100);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // The poller schedule fires immediately on start().
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(s.fetchCalls.some((u) => u.startsWith(CONFIG.sourceUrl))).toBe(true);
    const sourceCountAfterLead = s.fetchCalls.filter((u) => u.startsWith(CONFIG.sourceUrl)).length;

    // Fall back to follower; poller stops so no more source polls fire.
    s.setLeader(false);
    await vi.advanceTimersByTimeAsync(2100);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const beforeIdle = s.fetchCalls.filter((u) => u.startsWith(CONFIG.sourceUrl)).length;
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const afterIdle = s.fetchCalls.filter((u) => u.startsWith(CONFIG.sourceUrl)).length;
    expect(afterIdle).toBe(beforeIdle);
    expect(sourceCountAfterLead).toBeGreaterThan(0);

    await service.stop();
  });

  it("a polled fix reaches the hub while the socket is connected", async () => {
    const s = makeScenario();
    const forced: Config = { ...CONFIG, forceLeader: true, gatewayRealtimeToken: null };
    const service = startService(forced, {
      log,
      version: "0.1.0",
      bootMs: Date.now(),
      instance: "test",
      fetchImpl: s.fetchImpl,
      buildHub: s.buildHub,
      healthPort: 0,
      startHealth: () => ({ port: () => 0, close: async () => {} }),
    });

    // Settle: leader forces immediate onStart which starts the poller; the
    // socket loop starts, invokes JoinPrivateChannel on the fake hub, and
    // becomes connected. The poller's first fetch is on schedule 0.
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
      const sent = s.hub.invokes.find((iv) => iv.method === "SendToChannel");
      if (sent) {
        expect(sent.args[0]).toBe(forced.ingestChannel);
        expect(sent.args[1]).toBe("location");
        const body = sent.args[2] as { lat: number; lng: number };
        expect(body.lat).toBe(46.91852);
        expect(body.lng).toBe(-114.090039);
        await service.stop();
        return;
      }
    }
    await service.stop();
    throw new Error("hub never received SendToChannel");
  });
});
