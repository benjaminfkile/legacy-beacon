// Loads and validates the LB_* configuration from the environment
// (legacy-beacon.md 6). Every problem is collected before throwing, and the
// thrown ConfigError names the offending keys, never their values.

export interface Target {
  name: "dev" | "prod";
  apiBaseUrl: string;
  beaconKey: string;
  hubUrl: string;
  ingestChannel: string;
}

export interface Config {
  targets: Target[];
  sourceUrl: string;
  pollMs: number;
  // The legacy tracker's mode endpoint and its token; null when mode control
  // is off (neither LB_MODE_URL nor LB_MODE_AUTH set).
  modeControl: { url: string; auth: string } | null;
  httpHost: string;
  httpPort: number;
  // The built control page; null serves the API only.
  webDir: string | null;
  logLevel: string;
}

export class ConfigError extends Error {
  readonly keys: string[];

  constructor(keys: string[]) {
    super(`invalid or missing configuration: ${keys.join(", ")}`);
    this.name = "ConfigError";
    this.keys = keys;
  }
}

const TARGET_NAMES = ["dev", "prod"] as const;
const DEFAULT_POLL_MS = 1000;
const MIN_POLL_MS = 250;
const MAX_POLL_MS = 60_000;
const DEFAULT_HTTP_HOST = "0.0.0.0";
const DEFAULT_HTTP_PORT = 3070;
const DEFAULT_LOG_LEVEL = "info";

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseUrl(value: string | undefined, protocols: string[]): string | null {
  if (!isNonEmpty(value)) return null;
  const trimmed = value.trim();
  try {
    if (!protocols.includes(new URL(trimmed).protocol)) return null;
  } catch {
    return null;
  }
  return trimmed;
}

function parseHttpUrl(value: string | undefined): string | null {
  return parseUrl(value, ["http:", "https:"])?.replace(/\/+$/, "") ?? null;
}

function parseWsUrl(value: string | undefined): string | null {
  return parseUrl(value, ["ws:", "wss:"]);
}

function isTargetName(value: string): value is Target["name"] {
  return (TARGET_NAMES as readonly string[]).includes(value);
}

function parseTargetNames(value: string | undefined): Target["name"][] | null {
  if (!isNonEmpty(value)) return null;
  const names: Target["name"][] = [];
  for (const part of value.split(",")) {
    const name = part.trim();
    if (!isTargetName(name) || names.includes(name)) return null;
    names.push(name);
  }
  return names;
}

function parseInteger(value: string, min: number, max: number): number | null {
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

function parseTarget(name: Target["name"], env: NodeJS.ProcessEnv, bad: string[]): Target | null {
  const prefix = `LB_${name.toUpperCase()}_`;
  const apiBaseUrlKey = `${prefix}API_BASE_URL`;
  const beaconKeyKey = `${prefix}BEACON_KEY`;
  const hubUrlKey = `${prefix}HUB_URL`;
  const ingestChannelKey = `${prefix}INGEST_CHANNEL`;

  const apiBaseUrl = parseHttpUrl(env[apiBaseUrlKey]);
  if (apiBaseUrl === null) bad.push(apiBaseUrlKey);

  const beaconKey = env[beaconKeyKey];
  const beaconKeyOk = isNonEmpty(beaconKey) && beaconKey.startsWith("wbk_");
  if (!beaconKeyOk) bad.push(beaconKeyKey);

  const hubUrl = parseWsUrl(env[hubUrlKey]);
  if (hubUrl === null) bad.push(hubUrlKey);

  const ingestChannel = env[ingestChannelKey];
  const ingestChannelOk = isNonEmpty(ingestChannel) && ingestChannel.includes(":");
  if (!ingestChannelOk) bad.push(ingestChannelKey);

  if (apiBaseUrl === null || !beaconKeyOk || hubUrl === null || !ingestChannelOk) return null;
  return { name, apiBaseUrl, beaconKey: beaconKey.trim(), hubUrl, ingestChannel: ingestChannel.trim() };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bad: string[] = [];

  const targetNames = parseTargetNames(env.LB_TARGETS);
  if (targetNames === null) bad.push("LB_TARGETS");
  const targets: Target[] = [];
  for (const name of targetNames ?? []) {
    const target = parseTarget(name, env, bad);
    if (target !== null) targets.push(target);
  }

  const sourceUrl = parseHttpUrl(env.LB_SOURCE_URL);
  if (sourceUrl === null) bad.push("LB_SOURCE_URL");

  let pollMs = DEFAULT_POLL_MS;
  if (isNonEmpty(env.LB_POLL_MS)) {
    const parsed = parseInteger(env.LB_POLL_MS, MIN_POLL_MS, MAX_POLL_MS);
    if (parsed === null) bad.push("LB_POLL_MS");
    else pollMs = parsed;
  }

  // LB_MODE_URL and LB_MODE_AUTH are optional and set together. The URL is the
  // mode endpoint with its id parameter; auth and value are appended per
  // request, so a URL that already carries either is refused.
  let modeControl: Config["modeControl"] = null;
  const hasModeUrl = isNonEmpty(env.LB_MODE_URL);
  const hasModeAuth = isNonEmpty(env.LB_MODE_AUTH);
  if (hasModeUrl !== hasModeAuth) {
    bad.push(hasModeUrl ? "LB_MODE_AUTH" : "LB_MODE_URL");
  } else if (hasModeUrl && hasModeAuth) {
    const url = parseUrl(env.LB_MODE_URL, ["http:", "https:"]);
    if (url === null) {
      bad.push("LB_MODE_URL");
    } else {
      const params = new URL(url).searchParams;
      if (params.has("auth") || params.has("value")) bad.push("LB_MODE_URL");
      else modeControl = { url, auth: env.LB_MODE_AUTH!.trim() };
    }
  }

  const httpHost = isNonEmpty(env.LB_HTTP_HOST) ? env.LB_HTTP_HOST.trim() : DEFAULT_HTTP_HOST;

  let httpPort = DEFAULT_HTTP_PORT;
  if (isNonEmpty(env.LB_HTTP_PORT)) {
    const parsed = parseInteger(env.LB_HTTP_PORT, 1, 65535);
    if (parsed === null) bad.push("LB_HTTP_PORT");
    else httpPort = parsed;
  }

  const webDir = isNonEmpty(env.LB_WEB_DIR) ? env.LB_WEB_DIR.trim() : null;
  const logLevel = isNonEmpty(env.LB_LOG_LEVEL) ? env.LB_LOG_LEVEL.trim() : DEFAULT_LOG_LEVEL;

  if (bad.length > 0) throw new ConfigError([...new Set(bad)]);

  return {
    targets,
    sourceUrl: sourceUrl as string,
    pollMs,
    modeControl,
    httpHost,
    httpPort,
    webDir,
    logLevel,
  };
}
