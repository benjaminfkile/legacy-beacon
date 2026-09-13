// Validates every LB_* key of legacy-beacon.md 6 and returns a typed Config.
// Fails fast: prints the key names that failed, never a value.

export interface Config {
  env: "dev" | "prod";
  apiBaseUrl: string;
  beaconKey: string;
  hubUrl: string;
  ingestChannel: string;
  gatewayInternalUrl: string;
  sourceUrl: string;
  pollMs: number;
  logLevel: string;
  forceLeader: boolean;
  gatewayRealtimeToken: string;
}

export class ConfigError extends Error {
  constructor(public readonly keys: string[], message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const REQUIRED_KEYS = [
  "LB_ENV",
  "LB_API_BASE_URL",
  "LB_BEACON_KEY",
  "LB_HUB_URL",
  "LB_INGEST_CHANNEL",
  "LB_GATEWAY_INTERNAL_URL",
  "LB_SOURCE_URL",
  "LB_POLL_MS",
  "LB_LOG_LEVEL",
  "GATEWAY_REALTIME_TOKEN",
] as const;

function isNonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseHttpUrl(v: string, keys: string[], key: string, protocols: string[]): URL | null {
  try {
    const u = new URL(v);
    if (!protocols.includes(u.protocol)) {
      keys.push(key);
      return null;
    }
    return u;
  } catch {
    keys.push(key);
    return null;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bad: string[] = [];

  for (const k of REQUIRED_KEYS) {
    if (!isNonEmpty(env[k])) bad.push(k);
  }

  const envValueRaw = env.LB_ENV;
  let envValue: Config["env"] | undefined;
  if (isNonEmpty(envValueRaw)) {
    if (envValueRaw === "dev" || envValueRaw === "prod") envValue = envValueRaw;
    else bad.push("LB_ENV");
  }

  if (isNonEmpty(env.LB_API_BASE_URL))
    parseHttpUrl(env.LB_API_BASE_URL, bad, "LB_API_BASE_URL", ["http:", "https:"]);
  if (isNonEmpty(env.LB_HUB_URL))
    parseHttpUrl(env.LB_HUB_URL, bad, "LB_HUB_URL", ["ws:", "wss:"]);
  if (isNonEmpty(env.LB_GATEWAY_INTERNAL_URL))
    parseHttpUrl(env.LB_GATEWAY_INTERNAL_URL, bad, "LB_GATEWAY_INTERNAL_URL", ["http:", "https:"]);
  if (isNonEmpty(env.LB_SOURCE_URL))
    parseHttpUrl(env.LB_SOURCE_URL, bad, "LB_SOURCE_URL", ["http:", "https:"]);

  if (isNonEmpty(env.LB_BEACON_KEY) && !env.LB_BEACON_KEY.startsWith("wbk_"))
    bad.push("LB_BEACON_KEY");

  if (isNonEmpty(env.LB_INGEST_CHANNEL) && !env.LB_INGEST_CHANNEL.includes(":"))
    bad.push("LB_INGEST_CHANNEL");

  let pollMs = 1000;
  if (isNonEmpty(env.LB_POLL_MS)) {
    const n = Number(env.LB_POLL_MS);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 250 || n > 60000) bad.push("LB_POLL_MS");
    else pollMs = n;
  }

  let forceLeader = false;
  if (isNonEmpty(env.LB_FORCE_LEADER)) {
    const v = env.LB_FORCE_LEADER.toLowerCase();
    if (v !== "true" && v !== "false") bad.push("LB_FORCE_LEADER");
    else forceLeader = v === "true";
  }

  // LB_FORCE_LEADER is a local-only override and is refused when LB_ENV is prod.
  if (envValue === "prod" && forceLeader) bad.push("LB_FORCE_LEADER");

  const uniqueBad = Array.from(new Set(bad));
  if (uniqueBad.length > 0) {
    throw new ConfigError(
      uniqueBad,
      `invalid or missing configuration: ${uniqueBad.join(", ")}`,
    );
  }

  return {
    env: envValue!,
    apiBaseUrl: env.LB_API_BASE_URL!.replace(/\/$/, ""),
    beaconKey: env.LB_BEACON_KEY!,
    hubUrl: env.LB_HUB_URL!,
    ingestChannel: env.LB_INGEST_CHANNEL!,
    gatewayInternalUrl: env.LB_GATEWAY_INTERNAL_URL!.replace(/\/$/, ""),
    sourceUrl: env.LB_SOURCE_URL!,
    pollMs,
    logLevel: env.LB_LOG_LEVEL!,
    forceLeader,
    gatewayRealtimeToken: env.GATEWAY_REALTIME_TOKEN!,
  };
}
