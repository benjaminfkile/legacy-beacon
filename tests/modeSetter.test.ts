// The mode setter: the request carries id, auth, and value; one request at a
// time; a 3 s timeout; non-2xx and network errors reported; no log line,
// result, or stat carries the token.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createModeSetter, MODE_TIMEOUT_MS } from "../src/source/modeSetter.js";

const URL_BASE = "https://legacy.example/mode?id=tracker-1";
const AUTH = "secret-mode-token";

function logger() {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (f: Record<string, unknown>, m: string) => lines.push(JSON.stringify({ ...f, m })),
      warn: (f: Record<string, unknown>, m: string) => lines.push(JSON.stringify({ ...f, m })),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("mode setter (legacy-beacon.md 3)", () => {
  it("a 2xx is a set; the request carries id, auth, and value", async () => {
    const seen: URL[] = [];
    const fetchImpl = (async (u: URL) => {
      seen.push(new URL(String(u)));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const { log, lines } = logger();
    const m = createModeSetter({ url: URL_BASE, auth: AUTH, log, fetchImpl });
    const r = await m.set(1, 0);
    expect(r).toEqual({ ok: true, value: 1, status: 200 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.searchParams.get("id")).toBe("tracker-1");
    expect(seen[0]!.searchParams.get("auth")).toBe(AUTH);
    expect(seen[0]!.searchParams.get("value")).toBe("1");
    const s = m.stats();
    expect([s.setsOk, s.setsFailed, s.lastSetValue, s.lastSetStatus, s.inFlight]).toEqual([1, 0, 1, 200, false]);
    expect(lines.join("\n")).not.toContain(AUTH);
    expect(lines[0]).toContain('"from":0');
  });

  it("a non-2xx is a failure with its status", async () => {
    const fetchImpl = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    const { log } = logger();
    const m = createModeSetter({ url: URL_BASE, auth: AUTH, log, fetchImpl });
    const r = await m.set(2, 1);
    expect(r).toEqual({ ok: false, value: 2, status: 403, reason: "http 403" });
    expect(m.stats().setsFailed).toBe(1);
    expect(m.stats().lastSetError).toBe("http 403");
  });

  it("a network error is reported without the token", async () => {
    const fetchImpl = (async (u: URL) => {
      throw new Error(`connect failed for ${String(u)}`);
    }) as unknown as typeof fetch;
    const { log, lines } = logger();
    const m = createModeSetter({ url: URL_BASE, auth: AUTH, log, fetchImpl });
    const r = await m.set(0, null);
    expect(r && !r.ok && r.reason).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain(AUTH);
    expect(JSON.stringify(m.stats())).not.toContain(AUTH);
    expect(lines.join("\n")).not.toContain(AUTH);
  });

  it("times out after 3 s", async () => {
    vi.useFakeTimers();
    const fetchImpl = ((_u: URL, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      })) as unknown as typeof fetch;
    const { log } = logger();
    const m = createModeSetter({ url: URL_BASE, auth: AUTH, log, fetchImpl });
    const p = m.set(1, 0);
    await vi.advanceTimersByTimeAsync(MODE_TIMEOUT_MS);
    expect(await p).toEqual({ ok: false, value: 1, status: null, reason: "timeout" });
  });

  it("one request at a time: a second set while one is in flight answers null", async () => {
    let release: (() => void) | null = null;
    const fetchImpl = (() =>
      new Promise<Response>((res) => {
        release = () => res(new Response("ok", { status: 200 }));
      })) as unknown as typeof fetch;
    const { log } = logger();
    const m = createModeSetter({ url: URL_BASE, auth: AUTH, log, fetchImpl });
    const first = m.set(1, 0);
    expect(m.stats().inFlight).toBe(true);
    expect(await m.set(2, 0)).toBeNull();
    release!();
    expect((await first)?.ok).toBe(true);
    // Once it settled, the next request goes out.
    const second = m.set(2, 1);
    expect(m.stats().inFlight).toBe(true);
    release!();
    expect((await second)?.ok).toBe(true);
    expect(m.stats().setsOk).toBe(2);
  });
});
