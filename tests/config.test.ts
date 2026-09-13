import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const base = {
  LB_ENV: "dev",
  LB_API_BASE_URL: "https://api.example.com",
  LB_BEACON_KEY: "wbk_abcdef",
  LB_HUB_URL: "wss://gateway.example.com/hub",
  LB_INGEST_CHANNEL: "wmsfo-api-dev:ingest",
  LB_GATEWAY_INTERNAL_URL: "http://172.17.0.1:8080",
  LB_SOURCE_URL: "https://santatracker-api.herokuapp.com/get?id=406santa",
  LB_POLL_MS: "1000",
  LB_LOG_LEVEL: "info",
  GATEWAY_REALTIME_TOKEN: "grt_xxx",
} as const;

describe("loadConfig", () => {
  it("loads a valid environment", () => {
    const c = loadConfig({ ...base });
    expect(c.env).toBe("dev");
    expect(c.pollMs).toBe(1000);
    expect(c.forceLeader).toBe(false);
    expect(c.apiBaseUrl).toBe("https://api.example.com");
  });

  it("fails fast on missing keys, listing only the names", () => {
    const env = { ...base } as Record<string, string | undefined>;
    delete env.LB_HUB_URL;
    delete env.LB_BEACON_KEY;
    try {
      loadConfig(env);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      expect(ce.keys).toContain("LB_HUB_URL");
      expect(ce.keys).toContain("LB_BEACON_KEY");
      // The message names keys but never values.
      expect(ce.message).not.toContain("wbk_");
      expect(ce.message).not.toContain("wss://");
    }
  });

  it("rejects LB_FORCE_LEADER=true when LB_ENV=prod", () => {
    expect(() =>
      loadConfig({ ...base, LB_ENV: "prod", LB_FORCE_LEADER: "true" }),
    ).toThrowError(/LB_FORCE_LEADER/);
  });

  it("accepts LB_FORCE_LEADER=true in dev", () => {
    const c = loadConfig({ ...base, LB_FORCE_LEADER: "true" });
    expect(c.forceLeader).toBe(true);
  });

  it("rejects out-of-range LB_POLL_MS", () => {
    expect(() => loadConfig({ ...base, LB_POLL_MS: "100" })).toThrowError(/LB_POLL_MS/);
    expect(() => loadConfig({ ...base, LB_POLL_MS: "99999" })).toThrowError(/LB_POLL_MS/);
  });

  it("rejects a non-wbk beacon key and a bad ingest channel", () => {
    expect(() => loadConfig({ ...base, LB_BEACON_KEY: "abc" })).toThrowError(/LB_BEACON_KEY/);
    expect(() => loadConfig({ ...base, LB_INGEST_CHANNEL: "no-colon" })).toThrowError(
      /LB_INGEST_CHANNEL/,
    );
  });

  it("rejects a non-wss hub URL and non-http gateway URL", () => {
    expect(() => loadConfig({ ...base, LB_HUB_URL: "https://x" })).toThrowError(/LB_HUB_URL/);
    expect(() => loadConfig({ ...base, LB_GATEWAY_INTERNAL_URL: "wss://x" })).toThrowError(
      /LB_GATEWAY_INTERNAL_URL/,
    );
  });
});
