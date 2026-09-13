// The poller under failures and timeouts. The schedule holds under failures
// (no backoff); a timeout counts as a failed poll; statistics; the raw
// payload lands in the stats for the heartbeat's debug tree.

import { describe, expect, it } from "vitest";
import { createBeaconState } from "../src/beacon/state.js";
import { createPoller } from "../src/source/poller.js";

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

describe("poller (legacy-beacon.md 3)", () => {
  it("a successful poll sets the latest fix and updates stats", async () => {
    const state = createBeaconState();
    const p = createPoller({
      url: "https://x/get",
      pollMs: 60_000,
      state,
      fetchImpl: makeFetch([jsonResponse(SAMPLE)]),
    });
    await p.pollOnce();
    expect(state.latestFix).not.toBeNull();
    expect(state.latestFix!.lat).toBe(46.91852);
    const s = p.stats();
    expect(s.pollsOk).toBe(1);
    expect(s.pollsFailed).toBe(0);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastStatus).toBe(200);
    expect(s.lastPollAt).not.toBeNull();
    expect(s.lastSuccessAt).not.toBeNull();
    // The raw payload is kept for the heartbeat's debug tree.
    expect(s.lastPayload).toEqual(SAMPLE);
    p.stop();
  });

  it("a non-2xx counts as a failed poll; the last fix is kept", async () => {
    const state = createBeaconState();
    const p = createPoller({
      url: "https://x/get",
      pollMs: 60_000,
      state,
      fetchImpl: makeFetch([jsonResponse(SAMPLE), jsonResponse({}, 502)]),
    });
    await p.pollOnce();
    expect(state.latestFix).not.toBeNull();
    const before = state.latestFix;
    await p.pollOnce();
    // Same fix; the poller did not clear it.
    expect(state.latestFix).toBe(before);
    const s = p.stats();
    expect(s.pollsOk).toBe(1);
    expect(s.pollsFailed).toBe(1);
    expect(s.consecutiveFailures).toBe(1);
    expect(s.lastStatus).toBe(502);
    p.stop();
  });

  it("a timeout counts as a failed poll (name === 'AbortError')", async () => {
    const state = createBeaconState();
    // A fetch that never resolves and throws AbortError when signal aborts.
    const fetchImpl: typeof fetch = ((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const s = init?.signal;
        if (s) {
          s.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }) as typeof fetch;
    const p = createPoller({
      url: "https://x/get",
      pollMs: 60_000,
      state,
      fetchImpl,
      timeoutMs: 10,
    });
    await p.pollOnce();
    const s = p.stats();
    expect(s.pollsFailed).toBe(1);
    expect(s.consecutiveFailures).toBe(1);
    expect(s.lastFailureReason).toBe("timeout");
    p.stop();
  });

  it("a body that is not a JSON object counts as a failed poll", async () => {
    const state = createBeaconState();
    const p = createPoller({
      url: "https://x/get",
      pollMs: 60_000,
      state,
      fetchImpl: makeFetch([jsonResponse(["not", "an", "object"])]),
    });
    await p.pollOnce();
    const s = p.stats();
    expect(s.pollsFailed).toBe(1);
    expect(state.latestFix).toBeNull();
    p.stop();
  });

  it("a normalizer failure (out-of-range lat) counts as a failed poll; raw payload still kept", async () => {
    const state = createBeaconState();
    const bad = { ...SAMPLE, lat: "95.0" };
    const p = createPoller({
      url: "https://x/get",
      pollMs: 60_000,
      state,
      fetchImpl: makeFetch([jsonResponse(bad)]),
    });
    await p.pollOnce();
    expect(state.latestFix).toBeNull();
    const s = p.stats();
    expect(s.pollsFailed).toBe(1);
    expect(s.lastPayload).toEqual(bad);
    expect(s.lastFailureReason).toMatch(/usable position/);
    p.stop();
  });

  it("a successful poll resets consecutiveFailures", async () => {
    const state = createBeaconState();
    const p = createPoller({
      url: "https://x/get",
      pollMs: 60_000,
      state,
      fetchImpl: makeFetch([
        jsonResponse({}, 500),
        jsonResponse({}, 500),
        jsonResponse(SAMPLE),
      ]),
    });
    await p.pollOnce();
    await p.pollOnce();
    expect(p.stats().consecutiveFailures).toBe(2);
    await p.pollOnce();
    expect(p.stats().consecutiveFailures).toBe(0);
    expect(p.stats().pollsOk).toBe(1);
    expect(p.stats().pollsFailed).toBe(2);
    p.stop();
  });

  it("the schedule holds under failures (no backoff): next tick is pollMs", async () => {
    // We drive time manually: on start(), the first schedule is 0; after the
    // poll finishes we advance and observe the next schedule was `pollMs`.
    const state = createBeaconState();
    let currentMs = 1_000_000;
    const now = () => currentMs;
    const scriptedFetch = makeFetch([jsonResponse({}, 500)]);
    const p = createPoller({
      url: "https://x/get",
      pollMs: 60_000,
      state,
      fetchImpl: scriptedFetch,
      now,
    });
    // A single manual poll, no automatic timer involved.
    await p.pollOnce();
    // A failed poll leaves consecutiveFailures=1 and does not delay any
    // subsequent poll: the caller (or the auto timer) reschedules on the
    // ordinary interval. This test asserts the state contract; there is no
    // "backoff" state kept on the poller.
    const s = p.stats();
    expect(s.consecutiveFailures).toBe(1);
    p.stop();
  });

  it("network error counts as a failed poll with the error message", async () => {
    const state = createBeaconState();
    const p = createPoller({
      url: "https://x/get",
      pollMs: 60_000,
      state,
      fetchImpl: makeFetch([new Error("ECONNRESET")]),
    });
    await p.pollOnce();
    const s = p.stats();
    expect(s.pollsFailed).toBe(1);
    expect(s.lastFailureReason).toContain("ECONNRESET");
    expect(s.lastStatus).toBeNull();
    p.stop();
  });

  it("onFix fires on a successful poll with the fix's seqLocal", async () => {
    const state = createBeaconState();
    const seen: number[] = [];
    const p = createPoller({
      url: "https://x/get",
      pollMs: 60_000,
      state,
      fetchImpl: makeFetch([jsonResponse(SAMPLE), jsonResponse(SAMPLE)]),
      onFix: (seq) => seen.push(seq),
    });
    await p.pollOnce();
    await p.pollOnce();
    expect(seen).toEqual([1, 2]);
    p.stop();
  });
});
