// The mode controller's decision table (legacy-beacon.md 3): RUN-SHOW while
// active and live, END-SHOW once after owning or while active with no live
// event and the tracker in RUN-SHOW, hands off otherwise; nothing is sent on an
// unknown or stale polled mode; one request in flight, 5 s spacing, 3 s
// timeout; the token never reaches a log line or the stats.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBeaconState, type BeaconState } from "beacon-library";
import { createModeController, type ModeController } from "../src/source/modeControl.js";
import type { PollerStats } from "../src/source/poller.js";

const TOKEN = "test-mode-auth";
const MODE_URL = "https://legacy.example/mode?id=tracker-1";

type Reply = "ok" | "hang" | number;

interface Harness {
  state: BeaconState;
  controller: ModeController;
  requests: URL[];
  logs: string[];
  replies: Reply[];
  poll(mode: unknown): void;
  failPoll(): void;
  setHeartbeat(isActive: boolean | null, liveEventId: number | null): void;
  settle(): Promise<void>;
}

function emptyStats(): PollerStats {
  return {
    lastPollAt: null,
    lastPollAtMs: null,
    lastStatus: null,
    lastLatencyMs: null,
    consecutiveFailures: 0,
    pollsOk: 0,
    pollsFailed: 0,
    lastSuccessAt: null,
    lastSuccessAtMs: null,
    lastFailureReason: null,
    lastPayload: null,
  };
}

function makeHarness(): Harness {
  const state = createBeaconState();
  const stats = emptyStats();
  const requests: URL[] = [];
  const logs: string[] = [];
  const replies: Reply[] = [];

  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof URL ? input.toString() : String(input));
    requests.push(url);
    const reply = replies.shift() ?? "ok";
    if (reply === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    const status = reply === "ok" ? 200 : reply;
    return Promise.resolve(new Response("ok", { status }));
  }) as typeof fetch;

  const capture =
    (level: string) =>
    (fields: Record<string, unknown>, msg: string): void => {
      logs.push(JSON.stringify({ level, msg, ...fields }));
    };

  const controller = createModeController({
    url: MODE_URL,
    auth: TOKEN,
    state,
    pollerStats: () => stats,
    log: { info: capture("info"), warn: capture("warn") },
    fetchImpl,
  });

  return {
    state,
    controller,
    requests,
    logs,
    replies,
    poll(mode) {
      stats.lastPayload = { mode } as PollerStats["lastPayload"];
      stats.consecutiveFailures = 0;
      stats.lastSuccessAtMs = Date.now();
      stats.lastSuccessAt = new Date(stats.lastSuccessAtMs).toISOString();
    },
    failPoll() {
      stats.consecutiveFailures += 1;
    },
    setHeartbeat(isActive, liveEventId) {
      state.lastHeartbeat = { receivedAt: new Date().toISOString(), liveEventId, isActive };
    },
    async settle() {
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

function values(h: Harness): string[] {
  return h.requests.map((u) => u.searchParams.get("value") ?? "");
}

describe("mode controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-12-24T18:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("active and live with polled 0 sends value 1 once and not again within 5 s", async () => {
    const h = makeHarness();
    h.setHeartbeat(true, 7);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    expect(values(h)).toEqual(["1"]);
    expect(h.controller.stats().owned).toBe(true);
    expect(h.controller.stats().setsOk).toBe(1);

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      h.poll(0);
      h.controller.evaluate();
      await h.settle();
    }
    expect(values(h)).toEqual(["1"]);

    await vi.advanceTimersByTimeAsync(1000);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    expect(values(h)).toEqual(["1", "1"]);
  });

  it("polled 1 while active and live sends nothing", async () => {
    const h = makeHarness();
    h.setHeartbeat(true, 7);
    h.poll(1);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(0);
    expect(h.controller.stats()).toMatchObject({ wanted: 1, polledMode: 1, owned: true });
  });

  it("active with no live event and polled 1 sends value 2", async () => {
    const h = makeHarness();
    h.setHeartbeat(true, null);
    h.poll(1);
    h.controller.evaluate();
    await h.settle();
    expect(values(h)).toEqual(["2"]);
    expect(h.controller.stats().wanted).toBe(2);
  });

  it("deactivated after owning with polled 1 sends value 2; owned clears once polled reads 2", async () => {
    const h = makeHarness();
    h.setHeartbeat(true, 7);
    h.poll(1);
    h.controller.evaluate();
    expect(h.controller.stats().owned).toBe(true);

    h.setHeartbeat(false, 7);
    h.poll(1);
    h.controller.evaluate();
    await h.settle();
    expect(values(h)).toEqual(["2"]);
    expect(h.controller.stats().owned).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    h.poll(2);
    h.controller.evaluate();
    expect(h.controller.stats().owned).toBe(false);

    // Handed off: a tracker set back to RUN-SHOW by hand is left alone.
    await vi.advanceTimersByTimeAsync(10_000);
    h.poll(1);
    h.controller.evaluate();
    await h.settle();
    expect(values(h)).toEqual(["2"]);
    expect(h.controller.stats().wanted).toBeNull();
  });

  it("never active sends nothing whatever the polled mode", async () => {
    for (const hb of [null, { isActive: false, liveEventId: 7 }, { isActive: null, liveEventId: 7 }]) {
      const h = makeHarness();
      if (hb) h.setHeartbeat(hb.isActive, hb.liveEventId);
      for (const mode of [0, 1, 2]) {
        await vi.advanceTimersByTimeAsync(6000);
        h.poll(mode);
        h.controller.evaluate();
        await h.settle();
      }
      expect(h.requests).toHaveLength(0);
      expect(h.controller.stats()).toMatchObject({ wanted: null, owned: false });
    }
  });

  it("wanted 2 with polled 0 sends nothing", async () => {
    const h = makeHarness();
    h.setHeartbeat(true, null);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(0);
    expect(h.controller.stats().wanted).toBe(2);
  });

  it("revoked sends nothing new for value 1", async () => {
    const h = makeHarness();
    h.state.revoked = true;
    h.setHeartbeat(true, 7);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(0);
    expect(h.controller.stats().wanted).toBe(2);
  });

  it("an unknown polled mode sends nothing: no payload, stale poll, failed last poll, non-number mode", async () => {
    const h = makeHarness();
    h.setHeartbeat(true, 7);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(0);

    h.poll(0);
    await vi.advanceTimersByTimeAsync(5001);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(0);
    expect(h.controller.stats().polledMode).toBeNull();

    h.poll(0);
    h.failPoll();
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(0);

    h.poll("0");
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(0);
  });

  it("a non-2xx is logged at warn and retried after 5 s", async () => {
    const h = makeHarness();
    h.replies.push(500);
    h.setHeartbeat(true, 7);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    expect(h.controller.stats()).toMatchObject({
      setsFailed: 1,
      lastSetStatus: 500,
      lastSetError: "http 500",
    });
    expect(h.logs.some((l) => l.includes('"level":"warn"') && l.includes("legacy mode set failed"))).toBe(true);

    await vi.advanceTimersByTimeAsync(4000);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(2);
    expect(h.controller.stats().setsOk).toBe(1);
    expect(h.logs.some((l) => l.includes('"level":"info"') && l.includes("legacy mode set"))).toBe(true);
  });

  it("a timeout after 3 s is logged at warn and retried after 5 s; one request in flight at a time", async () => {
    const h = makeHarness();
    h.replies.push("hang");
    h.setHeartbeat(true, 7);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(1);

    // Still in flight: nothing else goes out.
    await vi.advanceTimersByTimeAsync(2000);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.controller.stats()).toMatchObject({ setsFailed: 1, lastSetError: "timeout" });
    expect(h.logs.filter((l) => l.includes('"level":"warn"'))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(2);
  });

  it("the request carries id, auth, and value as query parameters", async () => {
    const h = makeHarness();
    h.setHeartbeat(true, 7);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    const u = h.requests[0]!;
    expect(u.host).toBe("legacy.example");
    expect(u.pathname).toBe("/mode");
    expect(u.searchParams.get("id")).toBe("tracker-1");
    expect(u.searchParams.get("auth")).toBe(TOKEN);
    expect(u.searchParams.get("value")).toBe("1");
  });

  it("no log line or stats field contains the token", async () => {
    const h = makeHarness();
    h.replies.push(500, "hang", "ok");
    h.setHeartbeat(true, 7);
    for (let i = 0; i < 20; i++) {
      h.poll(0);
      h.controller.evaluate();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(h.requests.length).toBeGreaterThanOrEqual(3);
    expect(h.logs.length).toBeGreaterThanOrEqual(3);
    for (const line of h.logs) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain("auth=");
    }
    expect(JSON.stringify(h.controller.stats())).not.toContain(TOKEN);
  });

  it("stop aborts the request in flight and later evaluations do nothing", async () => {
    const h = makeHarness();
    h.replies.push("hang");
    h.setHeartbeat(true, 7);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    h.controller.stop();
    await h.settle();
    await vi.advanceTimersByTimeAsync(10_000);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(1);
    expect(h.logs).toHaveLength(0);
  });
});
