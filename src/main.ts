// Boots the service: loads the configuration (exiting 2 with the key names on
// a bad one), builds the pino logger, reads the version from package.json,
// starts the service, and stops it gracefully on SIGTERM or SIGINT. Anything
// thrown past that is fatal and exits 1, so systemd restarts the process.

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { startService, type Service } from "./service.js";

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function loadOrExit(): Config {
  try {
    const config = loadConfig();
    // The built control page sits beside dist/ unless LB_WEB_DIR says otherwise.
    return config.webDir === null
      ? { ...config, webDir: fileURLToPath(new URL("../web/dist", import.meta.url)) }
      : config;
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`config error: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const config = loadOrExit();
  const log = pino({ level: config.logLevel });
  const version = readVersion();
  const instance = hostname();

  const fatal = (err: unknown, msg: string): void => {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, msg);
    process.exit(1);
  };
  process.on("uncaughtException", (err) => fatal(err, "uncaught exception"));
  process.on("unhandledRejection", (err) => fatal(err, "unhandled rejection"));

  log.info({ version, instance }, "booting");
  let service: Service;
  try {
    service = await startService(config, { log, version, bootMs: Date.now(), instance });
  } catch (err) {
    fatal(err, "start failed");
    return;
  }

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    service.stop().then(
      () => process.exit(0),
      (err: unknown) => fatal(err, "shutdown failed"),
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
