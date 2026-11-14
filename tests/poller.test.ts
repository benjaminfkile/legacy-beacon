// The poller under failures and timeouts. The schedule holds under failures
// (no backoff); a timeout counts as a failed poll; statistics; the raw
// payload and the normalized fix land in the stats; onFix gets every fix.

import { describe, expect, it, vi } from "vitest";
import { createPoller } from "../src/source/poller.js";
import type { NormalizedFix } from "../src/source/normalize.js";

const SAMPLE = {
  lat: "46.918520",
  lon: "-114.090039",
  speed: "0.00 mph",
  temp: "0",
  alt: "2715 ft",
  bearing: "N",
  bearing_raw: "0",
  mode: 1,
  time: "1766460807560",
  type: "tracker",
  status: "Battery Full at 100%",
  redirect: 0,
  count: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(entries: Array<Response | Error>): typeof fetch {
  let i = 0;
  return (async () => {
    const next = entries[i++];
    if (!next) throw new Error(`no scripted response ${i - 1}`);
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
}

function make(entries: Array<Response | Error>, extra: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
  const fixes: NormalizedFix[] = [];
  const polled = vi.fn();
  const p = createPoller({
    url: "https://x/get",
    pollMs: 60_000,
    fetchImpl: extra.fetchImpl ?? makeFetch(entries),
    onFix: (f) => fixes.push(f),
    onPolled: polled,
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
  });
  return { p, fixes, polled };
}

describe("poller (legacy-beacon.md 3)", () => {
  it("a successful poll hands the fix to onFix and updates stats", async () => {
    const { p, fixes, polled } = make([jsonResponse(SAMPLE)]);
    await p.pollOnce();
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.lat).toBe(46.91852);
    const s = p.stats();
    expect(s.pollsOk).toBe(1);
    expect(s.pollsFailed).toBe(0);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastStatus).toBe(200);
    expect(s.lastSuccessAt).not.toBeNull();
    expect(s.lastPayload).toEqual(SAMPLE);
    expect(s.lastFix).toEqual(fixes[0]);
    expect(polled).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it("a non-2xx counts as a failed poll; the last fix is kept", async () => {
    const { p, fixes } = make([jsonResponse(SAMPLE), jsonResponse({}, 502)]);
    await p.pollOnce();
    const before = p.stats().lastFix;
    await p.pollOnce();
    expect(fixes).toHaveLength(1);
    const s = p.stats();
    expect(s.lastFix).toEqual(before);
    expect(s.pollsOk).toBe(1);
    expect(s.pollsFailed).toBe(1);
    expect(s.consecutiveFailures).toBe(1);
    expect(s.lastStatus).toBe(502);
    p.stop();
  });

  it("a timeout counts as a failed poll", async () => {
    const fetchImpl: typeof fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as typeof fetch;
    const { p } = make([], { fetchImpl, timeoutMs: 10 });
    await p.pollOnce();
    const s = p.stats();
    expect(s.pollsFailed).toBe(1);
    expect(s.lastFailureReason).toBe("timeout");
    p.stop();
  });

  it("a body that is not a JSON object counts as a failed poll", async () => {
    const { p, fixes } = make([jsonResponse(["not", "an", "object"])]);
    await p.pollOnce();
    expect(p.stats().pollsFailed).toBe(1);
    expect(fixes).toHaveLength(0);
    p.stop();
  });

  it("an out-of-range latitude is a failed poll; the raw payload is still kept", async () => {
    const bad = { ...SAMPLE, lat: "95.0" };
    const { p, fixes } = make([jsonResponse(bad)]);
    await p.pollOnce();
    expect(fixes).toHaveLength(0);
    const s = p.stats();
    expect(s.pollsFailed).toBe(1);
    expect(s.lastPayload).toEqual(bad);
    expect(s.lastFailureReason).toMatch(/usable position/);
    p.stop();
  });

  it("a successful poll resets consecutiveFailures", async () => {
    const { p } = make([jsonResponse({}, 500), jsonResponse({}, 500), jsonResponse(SAMPLE)]);
    await p.pollOnce();
    await p.pollOnce();
    expect(p.stats().consecutiveFailures).toBe(2);
    await p.pollOnce();
    expect(p.stats().consecutiveFailures).toBe(0);
    expect(p.stats().pollsOk).toBe(1);
    expect(p.stats().pollsFailed).toBe(2);
    p.stop();
  });

  it("a network error counts as a failed poll with the error message", async () => {
    const { p } = make([new Error("ECONNREFUSED")]);
    await p.pollOnce();
    expect(p.stats().lastFailureReason).toBe("ECONNREFUSED");
    expect(p.stats().lastStatus).toBeNull();
    p.stop();
  });

  it("the schedule holds under failures: every poll after the first is pollMs later", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return jsonResponse({}, 500);
      }) as typeof fetch;
      const p = createPoller({ url: "https://x/get", pollMs: 1000, fetchImpl });
      p.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(3000);
      expect(calls).toBe(5);
      p.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
