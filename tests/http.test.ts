// The HTTP surface: health, status, the mode request and its errors, the
// control page served from the web directory, 404 elsewhere.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHttpApp } from "../src/http.js";
import type { ModeSetResult } from "../src/source/modeSetter.js";
import type { StatusBody } from "../src/status.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const STATUS = { serverTime: "2026-12-22T01:31:07.000Z", targets: [] } as unknown as StatusBody;
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function app(setMode: ((v: 0 | 1 | 2) => Promise<ModeSetResult | null>) | null, webDir: string | null = null) {
  return buildHttpApp({ webDir, status: () => STATUS, setMode, log: silent });
}

describe("http (legacy-beacon.md 4)", () => {
  it("health is 200 with no-store", async () => {
    const res = await (await app(null)).inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("status answers the status body", async () => {
    const res = await (await app(null)).inject({ method: "GET", url: "/api/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(STATUS);
  });

  it("a mode request with a bad value is 400", async () => {
    const setMode = vi.fn();
    const a = await app(setMode);
    for (const payload of [{ value: 3 }, { value: "1" }, {}]) {
      const res = await a.inject({ method: "POST", url: "/api/mode", payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("validation_failed");
    }
    expect(setMode).not.toHaveBeenCalled();
  });

  it("a mode request with mode control off is 409 mode_control_off", async () => {
    const res = await (await app(null)).inject({ method: "POST", url: "/api/mode", payload: { value: 1 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("mode_control_off");
  });

  it("a mode request answers 200, 409 mode_busy, or 502 upstream_failed", async () => {
    const results: Array<ModeSetResult | null> = [
      { ok: true, value: 1, status: 200 },
      null,
      { ok: false, value: 2, status: 500, reason: "http 500" },
    ];
    const setMode = vi.fn(async (_v: 0 | 1 | 2) => results.shift() ?? null);
    const a = await app(setMode);
    const ok = await a.inject({ method: "POST", url: "/api/mode", payload: { value: 1 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, value: 1, status: 200 });
    const busy = await a.inject({ method: "POST", url: "/api/mode", payload: { value: 2 } });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().code).toBe("mode_busy");
    const failed = await a.inject({ method: "POST", url: "/api/mode", payload: { value: 2 } });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().code).toBe("upstream_failed");
    expect(setMode.mock.calls.map((c) => c[0])).toEqual([1, 2, 2]);
  });

  it("serves the control page from the web directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lb-web-"));
    dirs.push(dir);
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Legacy beacon</title>");
    const a = await app(null, dir);
    const res = await a.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Legacy beacon");
  });

  it("anything else is 404 in the error shape", async () => {
    const res = await (await app(null)).inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: "not_found", message: "no such route", details: null, requestId: "" });
  });
});
