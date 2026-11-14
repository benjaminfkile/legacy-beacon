import { describe, expect, it } from "vitest";
import { ApiError, createApiClient } from "../src/api.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("api client", () => {
  it("GET /api/status and POST /api/mode with the value", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith("/api/status") ? json({ targets: [] }) : json({ ok: true, value: 2, status: 200 });
    }) as unknown as typeof fetch;
    const api = createApiClient({ fetchImpl });
    expect(await api.getStatus()).toEqual({ targets: [] });
    expect(await api.setMode(2)).toEqual({ ok: true, value: 2, status: 200 });
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["GET", "/api/status"],
      ["POST", "/api/mode"],
    ]);
    expect(calls[1]!.init.body).toBe('{"value":2}');
  });

  it("a non-2xx becomes an ApiError with the error body's code and message", async () => {
    const fetchImpl = (async () =>
      json({ code: "mode_busy", message: "a mode request is already in flight", details: null, requestId: "" }, 409)) as unknown as typeof fetch;
    const err = await createApiClient({ fetchImpl }).setMode(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("mode_busy");
    expect((err as ApiError).message).toBe("a mode request is already in flight");
  });

  it("a non-JSON error is http_<status>", async () => {
    const fetchImpl = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    const err = (await createApiClient({ fetchImpl }).getStatus().catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("http_502");
  });
});
