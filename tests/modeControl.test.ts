// The mode controller's decision table (legacy-beacon.md 3): RUN-SHOW while
// active and live, END-SHOW once after owning or while active with no live
// event and the tracker in RUN-SHOW, hands off otherwise; nothing is sent on an
// unknown or stale polled mode; one request in flight, 5 s spacing, 3 s
// timeout; the token never reaches a log line or the stats. Ownership comes
// from the beacon's state document, served by the library's fake REST: loaded
// before anything is sent, written when it changes, carried across a restart
// and a hand-off, with failed loads and writes retried.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBeaconState,
  createFakeRest,
  createStateStore,
  type BeaconState,
  type FakeRest,
  type RestError,
} from "beacon-library";
import {
  createModeController,
  type BeaconDocument,
  type ModeController,
} from "../src/source/modeControl.js";
import type { PollerStats } from "../src/source/poller.js";

const TOKEN = "test-mode-auth";
const MODE_URL = "https://legacy.example/mode?id=tracker-1";

type Reply = "ok" | "hang" | number;

interface Harness {
  state: BeaconState;
  rest: FakeRest;
  controller: ModeController;
  requests: URL[];
  logs: string[];
  replies: Reply[];
  poll(mode: unknown): void;
  failPoll(): void;
  setHeartbeat(
    isActive: boolean | null,
    liveEventId: number | null,
    stateVersion?: number | null,
  ): void;
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

interface HarnessOptions {
  rest?: FakeRest;
  doc?: Record<string, unknown> | null;
  // Leave the first load in flight instead of letting it land.
  noSettle?: boolean;
}

function restError(status: number): RestError {
  return {
    ok: false,
    status,
    code: null,
    message: null,
    requestId: null,
    serverTime: null,
  };
}

async function makeHarness(o: HarnessOptions = {}): Promise<Harness> {
  const rest = o.rest ?? createFakeRest();
  if (o.doc !== undefined) rest.setState(o.doc, 1);
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

  const log = { info: capture("info"), warn: capture("warn"), error: capture("error") };
  const store = createStateStore<BeaconDocument>({ rest, log, empty: () => ({}) });

  const controller = createModeController({
    url: MODE_URL,
    auth: TOKEN,
    state,
    store,
    pollerStats: () => stats,
    log,
    fetchImpl,
  });
  if (!o.noSettle) await vi.advanceTimersByTimeAsync(0);

  return {
    state,
    rest,
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
    setHeartbeat(isActive, liveEventId, stateVersion = null) {
      state.lastHeartbeat = {
        receivedAt: new Date().toISOString(),
        liveEventId,
        isActive,
        stateVersion,
      };
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
    const h = await makeHarness();
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
    const h = await makeHarness();
    h.setHeartbeat(true, 7);
    h.poll(1);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(0);
    expect(h.controller.stats()).toMatchObject({ wanted: 1, polledMode: 1, owned: true });
  });

  it("active with no live event and polled 1 sends value 2", async () => {
    const h = await makeHarness();
    h.setHeartbeat(true, null);
    h.poll(1);
    h.controller.evaluate();
    await h.settle();
    expect(values(h)).toEqual(["2"]);
    expect(h.controller.stats().wanted).toBe(2);
  });

  it("deactivated after owning with polled 1 sends value 2; owned clears once polled reads 2", async () => {
    const h = await makeHarness();
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
      const h = await makeHarness();
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
    const h = await makeHarness();
    h.setHeartbeat(true, null);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(0);
    expect(h.controller.stats().wanted).toBe(2);
  });

  it("revoked sends nothing new for value 1", async () => {
    const h = await makeHarness();
    h.state.revoked = true;
    h.setHeartbeat(true, 7);
    h.poll(0);
    h.controller.evaluate();
    await h.settle();
    expect(h.requests).toHaveLength(0);
    expect(h.controller.stats().wanted).toBe(2);
  });

  it("an unknown polled mode sends nothing: no payload, stale poll, failed last poll, non-number mode", async () => {
    const h = await makeHarness();
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
    const h = await makeHarness();
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
    const h = await makeHarness();
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
    const h = await makeHarness();
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
    const h = await makeHarness();
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
    expect(h.rest.state).not.toBeNull();
    expect(JSON.stringify(h.rest.state)).not.toContain(TOKEN);
  });

  it("stop aborts the request in flight and later evaluations do nothing", async () => {
    const h = await makeHarness();
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

  describe("the state document", () => {
    function puts(rest: FakeRest): BeaconDocument[] {
      return rest.stateCalls
        .filter((c) => c.method === "put")
        .map((c) => c.state as BeaconDocument);
    }

    it("restart: a document with owned true, not active, polled 1 sends value 2", async () => {
      const h = await makeHarness({
        doc: { modeControl: { owned: true, lastSetValue: 1, lastSetAt: "2026-12-24T17:00:00.000Z" } },
      });
      expect(h.controller.stats()).toMatchObject({ stateLoaded: true, stateVersion: 1, owned: true });
      h.setHeartbeat(false, 7);
      h.poll(1);
      h.controller.evaluate();
      await h.settle();
      expect(values(h)).toEqual(["2"]);
      expect(h.controller.stats().wanted).toBe(2);
      // The 2xx is recorded in the document; ownership holds until polled reads 2.
      expect(h.rest.state).toEqual({
        modeControl: { owned: true, lastSetValue: 2, lastSetAt: "2026-12-24T18:00:00.000Z" },
      });

      await vi.advanceTimersByTimeAsync(1000);
      h.poll(2);
      h.controller.evaluate();
      await h.settle();
      expect(h.rest.state).toMatchObject({ modeControl: { owned: false, lastSetValue: 2 } });
    });

    it("an empty document, not active, polled 1 sends nothing", async () => {
      const h = await makeHarness({ doc: null });
      h.setHeartbeat(false, 7);
      h.poll(1);
      h.controller.evaluate();
      await h.settle();
      expect(h.requests).toHaveLength(0);
      expect(h.controller.stats()).toMatchObject({ stateLoaded: true, owned: false, wanted: null });
      expect(puts(h.rest)).toHaveLength(0);
    });

    it("hand-off: A becomes owner and writes the document; B on the same store backend loads owned true", async () => {
      const a = await makeHarness();
      a.setHeartbeat(true, 7);
      a.poll(1);
      a.controller.evaluate();
      await a.settle();
      expect(a.rest.state).toEqual({
        modeControl: { owned: true, lastSetValue: null, lastSetAt: null },
      });
      a.controller.stop();

      const b = await makeHarness({ rest: a.rest });
      expect(b.controller.stats()).toMatchObject({ stateLoaded: true, owned: true });
      b.setHeartbeat(false, 7);
      b.poll(1);
      b.controller.evaluate();
      await b.settle();
      expect(values(b)).toEqual(["2"]);
    });

    it("nothing is sent before the load lands; a failed load is logged and retried after 5 s", async () => {
      const rest = createFakeRest();
      rest.nextStateError(restError(503));
      const h = await makeHarness({ rest, noSettle: true });
      h.setHeartbeat(true, 7);
      h.poll(0);
      h.controller.evaluate();
      expect(h.controller.stats()).toMatchObject({ stateLoaded: false, stateVersion: null, wanted: null });

      await h.settle();
      expect(h.logs.some((l) => l.includes('"level":"warn"') && l.includes("mode state load failed"))).toBe(true);
      h.poll(0);
      h.controller.evaluate();
      await h.settle();
      expect(h.requests).toHaveLength(0);
      expect(rest.stateCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(4999);
      expect(rest.stateCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(rest.stateCalls).toHaveLength(2);
      expect(h.controller.stats().stateLoaded).toBe(true);

      h.poll(0);
      h.controller.evaluate();
      await h.settle();
      expect(values(h)).toEqual(["1"]);
    });

    it("a failed write is logged, keeps the in-memory value, and is retried on the next evaluate", async () => {
      const h = await makeHarness();
      h.rest.nextStateError(restError(500));
      h.setHeartbeat(true, 7);
      h.poll(1);
      h.controller.evaluate();
      await h.settle();
      expect(h.logs.some((l) => l.includes('"level":"warn"') && l.includes("mode state write failed"))).toBe(true);
      expect(h.controller.stats().owned).toBe(true);
      expect(h.rest.state).toBeNull();

      h.poll(1);
      h.controller.evaluate();
      await h.settle();
      expect(h.rest.state).toEqual({
        modeControl: { owned: true, lastSetValue: null, lastSetAt: null },
      });
      const writes = puts(h.rest).length;

      // Landed: a further evaluate with nothing changed writes nothing.
      h.poll(1);
      h.controller.evaluate();
      await h.settle();
      expect(puts(h.rest)).toHaveLength(writes);
    });

    it("an unknown top-level key survives a write", async () => {
      const h = await makeHarness({ doc: { other: { kept: [1, 2] }, note: "x" } });
      h.setHeartbeat(true, 7);
      h.poll(0);
      h.controller.evaluate();
      await h.settle();
      expect(h.rest.state).toEqual({
        other: { kept: [1, 2] },
        note: "x",
        modeControl: { owned: true, lastSetValue: 1, lastSetAt: "2026-12-24T18:00:00.000Z" },
      });
      expect(JSON.stringify(h.rest.stateCalls)).not.toContain(TOKEN);
    });

    it("a heartbeat stateVersion ahead of the copy held reloads the document and takes owned from it", async () => {
      const h = await makeHarness({ doc: {} });
      h.setHeartbeat(false, 7, 1);
      h.poll(1);
      h.controller.evaluate();
      await h.settle();
      expect(h.rest.stateCalls).toHaveLength(1);
      expect(h.controller.stats().owned).toBe(false);

      h.rest.setState({ modeControl: { owned: true, lastSetValue: 1, lastSetAt: null } }, 4);
      h.setHeartbeat(false, 7, 4);
      h.controller.evaluate();
      await h.settle();
      expect(h.controller.stats()).toMatchObject({ owned: true, stateVersion: 4 });

      await vi.advanceTimersByTimeAsync(5000);
      h.poll(1);
      h.controller.evaluate();
      await h.settle();
      expect(values(h)).toEqual(["2"]);
    });
  });
});
