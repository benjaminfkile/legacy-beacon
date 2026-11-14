// Every LB_* key of legacy-beacon.md 6: targets, per-target keys required only
// for named targets, the source, the poll interval, the mode pair, the HTTP
// host and port; missing keys named but never valued.

import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const DEV_KEY = "wbk_devsecretvalue";
const PROD_KEY = "wbk_prodsecretvalue";
const MODE_AUTH = "mode-token-value";

function base(): NodeJS.ProcessEnv {
  return {
    LB_TARGETS: "dev,prod",
    LB_DEV_API_BASE_URL: "https://api-dev.example.com/",
    LB_DEV_BEACON_KEY: DEV_KEY,
    LB_DEV_HUB_URL: "wss://hub-dev.example.com/hub",
    LB_DEV_INGEST_CHANNEL: "wmsfo-api-dev:ingest",
    LB_PROD_API_BASE_URL: "https://api.example.com",
    LB_PROD_BEACON_KEY: PROD_KEY,
    LB_PROD_HUB_URL: "wss://hub.example.com/hub",
    LB_PROD_INGEST_CHANNEL: "wmsfo-api:ingest",
    LB_SOURCE_URL: "https://legacy.example/get?id=tracker-1",
  };
}

function keysOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).keys;
  }
  return [];
}

describe("config (legacy-beacon.md 6)", () => {
  it("loads two targets with defaults", () => {
    const c = loadConfig(base());
    expect(c.targets.map((t) => t.name)).toEqual(["dev", "prod"]);
    expect(c.targets[0]!.apiBaseUrl).toBe("https://api-dev.example.com");
    expect(c.targets[1]!.beaconKey).toBe(PROD_KEY);
    expect(c.pollMs).toBe(3000);
    expect(c.httpHost).toBe("0.0.0.0");
    expect(c.httpPort).toBe(3070);
    expect(c.webDir).toBeNull();
    expect(c.logLevel).toBe("info");
    expect(c.modeControl).toBeNull();
  });

  it("one target needs only its own keys", () => {
    const env = base();
    env.LB_TARGETS = "prod";
    delete env.LB_DEV_API_BASE_URL;
    delete env.LB_DEV_BEACON_KEY;
    expect(loadConfig(env).targets.map((t) => t.name)).toEqual(["prod"]);
  });

  it.each(["", "staging", "dev,dev", "dev,,prod"])("LB_TARGETS %j is refused", (v) => {
    expect(keysOf({ ...base(), LB_TARGETS: v })).toContain("LB_TARGETS");
  });

  it("names every bad per-target key without printing a value", () => {
    const env: NodeJS.ProcessEnv = { ...base(), LB_DEV_BEACON_KEY: "nope", LB_PROD_HUB_URL: "https://hub.example.com", LB_PROD_INGEST_CHANNEL: "nochannel" };
    delete env.LB_DEV_API_BASE_URL;
    let message = "";
    try {
      loadConfig(env);
    } catch (err) {
      message = (err as Error).message;
      expect((err as ConfigError).keys.sort()).toEqual(
        ["LB_DEV_API_BASE_URL", "LB_DEV_BEACON_KEY", "LB_PROD_HUB_URL", "LB_PROD_INGEST_CHANNEL"].sort(),
      );
    }
    expect(message).not.toContain("nope");
    expect(message).not.toContain(PROD_KEY);
  });

  it("requires a source URL", () => {
    const env = base();
    delete env.LB_SOURCE_URL;
    expect(keysOf(env)).toEqual(["LB_SOURCE_URL"]);
    expect(keysOf({ ...base(), LB_SOURCE_URL: "ftp://x" })).toEqual(["LB_SOURCE_URL"]);
  });

  it.each(["100", "60001", "1.5", "abc"])("LB_POLL_MS %j is refused", (v) => {
    expect(keysOf({ ...base(), LB_POLL_MS: v })).toEqual(["LB_POLL_MS"]);
  });

  it("LB_POLL_MS within bounds is taken", () => {
    expect(loadConfig({ ...base(), LB_POLL_MS: "250" }).pollMs).toBe(250);
  });

  it("mode control: both, neither, either alone, a bad URL, a URL already carrying auth or value", () => {
    const both = loadConfig({ ...base(), LB_MODE_URL: "https://legacy.example/mode?id=tracker-1", LB_MODE_AUTH: MODE_AUTH });
    expect(both.modeControl).toEqual({ url: "https://legacy.example/mode?id=tracker-1", auth: MODE_AUTH });
    expect(keysOf({ ...base(), LB_MODE_URL: "https://legacy.example/mode?id=1" })).toEqual(["LB_MODE_AUTH"]);
    expect(keysOf({ ...base(), LB_MODE_AUTH: MODE_AUTH })).toEqual(["LB_MODE_URL"]);
    expect(keysOf({ ...base(), LB_MODE_URL: "not a url", LB_MODE_AUTH: MODE_AUTH })).toEqual(["LB_MODE_URL"]);
    expect(keysOf({ ...base(), LB_MODE_URL: "https://l.example/mode?id=1&auth=x", LB_MODE_AUTH: MODE_AUTH })).toEqual(["LB_MODE_URL"]);
    expect(keysOf({ ...base(), LB_MODE_URL: "https://l.example/mode?id=1&value=1", LB_MODE_AUTH: MODE_AUTH })).toEqual(["LB_MODE_URL"]);
  });

  it("the mode token never reaches the error message", () => {
    try {
      loadConfig({ ...base(), LB_MODE_URL: "bad", LB_MODE_AUTH: MODE_AUTH });
    } catch (err) {
      expect((err as Error).message).not.toContain(MODE_AUTH);
    }
  });

  it("HTTP host, port, web dir, and log level", () => {
    const c = loadConfig({ ...base(), LB_HTTP_HOST: "127.0.0.1", LB_HTTP_PORT: "8080", LB_WEB_DIR: "/srv/web", LB_LOG_LEVEL: "debug" });
    expect([c.httpHost, c.httpPort, c.webDir, c.logLevel]).toEqual(["127.0.0.1", 8080, "/srv/web", "debug"]);
    expect(keysOf({ ...base(), LB_HTTP_PORT: "70000" })).toEqual(["LB_HTTP_PORT"]);
  });
});
