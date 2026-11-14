// The wiring in src/service.ts: one poller feeds both targets, so a polled fix
// reaches the dev and the prod fake hub alike; heartbeats go to both APIs
// with their own target in debug; the status lists both; a mode request from
// the HTTP surface reaches the legacy tracker with id, auth, and value, and
// with mode control off no mode request is ever made.

import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHubClient, type HubOptions } from "beacon-library";
import { pino } from "pino";
import { startService, type Service } from "../src/service.js";
import type { Config } from "../src/config.js";

const SOURCE_URL = "https://legacy.example/get?id=tracker-1";
const MODE_URL = "https://legacy.example/mode?id=tracker-1";
const MODE_AUTH = "test-mode-auth";

function config(modeControl: Config["modeControl"]): Config {
  return {
    targets: [
      { name: "dev", apiBaseUrl: "https://api-dev.example.com", beaconKey: "wbk_dev", hubUrl: "wss://hub-dev.example.com/hub", ingestChannel: "wmsfo-api-dev:ingest" },
      { name: "prod", apiBaseUrl: "https://api.example.com", beaconKey: "wbk_prod", hubUrl: "wss://hub.example.com/hub", ingestChannel: "wmsfo-api:ingest" },
    ],
    sourceUrl: SOURCE_URL,
    pollMs: 250,
    modeControl,
    httpHost: "127.0.0.1",
    httpPort: 0,
    webDir: null,
    logLevel: "silent",
  };
}

const SAMPLE = { lat: "46.918520", lon: "-114.090039", speed: "10.00 mph", alt: "2715 ft", bearing_raw: "90", mode: 1, time: "1766460807560" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function scenario() {
  const hubs = new Map<string, FakeHubClient>();
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
    if (url.startsWith(SOURCE_URL)) return json(SAMPLE);
    if (url.startsWith("https://legacy.example/mode")) return new Response("ok", { status: 200 });
    if (url.endsWith("/beacons/heartbeat")) {
      return json({ receivedAt: new Date().toISOString(), liveEventId: null, isActive: false, stateVersion: 0, serverTime: new Date().toISOString() });
    }
    if (url.endsWith("/locations")) {
      return json({ seq: 1, published: false, receivedAt: new Date().toISOString(), serverTime: new Date().toISOString() });
    }
    return json({}, 404);
  }) as typeof fetch;
  const buildHub = (o: HubOptions) => {
    const hub = new FakeHubClient();
    hubs.set(o.hubUrl, hub);
    return hub;
  };
  return { hubs, calls, fetchImpl, buildHub };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

let service: Service | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await service?.stop();
  service = null;
});

async function start(modeControl: Config["modeControl"]) {
  const s = scenario();
  service = await startService(config(modeControl), {
    log: pino({ level: "silent" }),
    version: "0.2.0",
    bootMs: Date.now(),
    instance: "test",
    fetchImpl: s.fetchImpl,
    buildHub: s.buildHub,
    httpPort: 0,
  });
  return s;
}

describe("service wiring (legacy-beacon.md 2)", () => {
  it("one polled fix reaches both targets' beacon state", async () => {
    await start(null);
    await until(() => service!.beacons().every((b) => b.beacon.state.latestFix !== null));
    for (const { beacon } of service!.beacons()) {
      expect(beacon.state.latestFix!.lat).toBe(46.91852);
      expect(beacon.state.latestFix!.speedMps).toBe(4.47);
    }
  });

  it("each target builds its own hub and the fix goes out on both", async () => {
    const s = await start(null);
    await until(() => s.hubs.size === 2 && [...s.hubs.values()].every((h) => h.invokes.length > 0));
    expect([...s.hubs.keys()].sort()).toEqual(["wss://hub-dev.example.com/hub", "wss://hub.example.com/hub"]);
    for (const hub of s.hubs.values()) {
      const sent = hub.invokes[0]!;
      expect(JSON.stringify(sent.args)).toContain("46.91852");
    }
  });

  it("heartbeats go to both APIs with their own target", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"], shouldAdvanceTime: true });
    const s = await start(null);
    await vi.advanceTimersByTimeAsync(15_500);
    await until(() => {
      const hb = s.calls.filter((c) => c.url.endsWith("/beacons/heartbeat"));
      return hb.some((c) => c.url.startsWith("https://api-dev.example.com")) && hb.some((c) => c.url.startsWith("https://api.example.com"));
    }, 5000);
    const prod = s.calls.find((c) => c.url === "https://api.example.com/beacons/heartbeat")!;
    expect(JSON.parse(prod.body!).debug.target).toBe("prod");
  });

  it("the status lists both targets and the polled mode", async () => {
    await start(null);
    await until(() => service!.status().source.pollsOk > 0);
    const st = service!.status();
    expect(st.targets.map((t) => t.name)).toEqual(["dev", "prod"]);
    expect(st.mode.polledMode).toBe(1);
    expect(st.mode.enabled).toBe(false);
    expect(st.fix?.lat).toBe(46.91852);
  });

  it("a mode request through HTTP reaches the tracker with id, auth, and value", async () => {
    const s = await start({ url: MODE_URL, auth: MODE_AUTH });
    const port = service!.http().port();
    const res = await fetch(`http://127.0.0.1:${port}/api/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 2 }),
    });
    expect(res.status).toBe(200);
    const mode = s.calls.filter((c) => c.url.startsWith("https://legacy.example/mode"));
    expect(mode).toHaveLength(1);
    const u = new URL(mode[0]!.url);
    expect([u.searchParams.get("id"), u.searchParams.get("auth"), u.searchParams.get("value")]).toEqual(["tracker-1", MODE_AUTH, "2"]);
    const status = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()) as { mode: { enabled: boolean; lastSetValue: number } };
    expect(status.mode.enabled).toBe(true);
    expect(status.mode.lastSetValue).toBe(2);
    expect(JSON.stringify(status)).not.toContain(MODE_AUTH);
  });

  it("with mode control off no mode request is ever made", async () => {
    const s = await start(null);
    await until(() => service!.status().source.pollsOk > 2);
    expect(s.calls.some((c) => c.url.startsWith("https://legacy.example/mode"))).toBe(false);
  });
});
