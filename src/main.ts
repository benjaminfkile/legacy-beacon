// Boot: load config, log its acceptance, and hand the wiring to startService.
// startService owns the beacon-library createBeacon and gateOnLeader; this
// file loads configuration, prepares the logger, version, boot time, and
// instance name, and handles process-level shutdown.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loadConfig, ConfigError } from "./config.js";
import { startService } from "./service.js";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/main.ts and dist/main.js both sit one level below the repo root.
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const config = (() => {
    try {
      return loadConfig();
    } catch (err) {
      if (err instanceof ConfigError) {
        process.stderr.write(`config error: ${err.message}\n`);
        process.exit(2);
      }
      throw err;
    }
  })();

  const log = pino({ level: config.logLevel });
  const version = readVersion();
  const bootMs = Date.now();
  const instance = process.env.HOSTNAME ?? "local";

  const service = startService(config, { log, version, bootMs, instance });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutdown");
    await service.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
