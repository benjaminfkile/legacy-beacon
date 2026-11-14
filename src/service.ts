// Wires the service (legacy-beacon.md 2): one poller of the legacy tracker,
// one beacon core per target (dev and prod), every polled fix handed to every
// target, the optional mode setter, and the HTTP surface. One process on one
// host: no leader gate. Fetch, the hub builder, and the HTTP port are
// injectable for the wiring test.

import type { Logger } from "pino";
import { createBeacon, setLatestFix, type Beacon, type HubClient, type HubOptions } from "beacon-library";
import type { Config } from "./config.js";
import { buildHeartbeatDebug, buildHeartbeatHealth } from "./heartbeat.js";
import { startHttpServer, type HttpServer } from "./http.js";
import { createModeSetter, type LegacyMode, type ModeSetter } from "./source/modeSetter.js";
import { createPoller, type Poller } from "./source/poller.js";
import { buildStatus, polledMode, type StatusBody } from "./status.js";

export interface ServiceDeps {
  log: Logger;
  version: string;
  bootMs: number;
  instance: string;
  fetchImpl?: typeof fetch;
  buildHub?: (o: HubOptions) => HubClient;
  httpPort?: number;
  now?: () => number;
}

export interface Service {
  stop(): Promise<void>;
  http(): HttpServer;
  poller(): Poller;
  beacons(): Array<{ name: string; beacon: Beacon }>;
  status(): StatusBody;
}

export async function startService(config: Config, deps: ServiceDeps): Promise<Service> {
  const { log } = deps;
  const now = deps.now ?? (() => Date.now());
  let poller: Poller | null = null;

  const modeSetter: ModeSetter | null = config.modeControl
    ? createModeSetter({
        url: config.modeControl.url,
        auth: config.modeControl.auth,
        log,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      })
    : null;

  const runtimes = config.targets.map((target) => {
    const beaconLog = log.child({ target: target.name });
    const beacon: Beacon = createBeacon({
      apiBaseUrl: target.apiBaseUrl,
      beaconKey: target.beaconKey,
      hubUrl: target.hubUrl,
      ingestChannel: target.ingestChannel,
      log: beaconLog,
      buildHealth: () => buildHeartbeatHealth({ state: beacon.state, pollerStats: poller?.stats() ?? null }),
      buildDebug: () =>
        buildHeartbeatDebug({
          target: target.name,
          state: beacon.state,
          sourceUrl: config.sourceUrl,
          pollMs: config.pollMs,
          pollerStats: poller?.stats() ?? null,
          modeStats: modeSetter?.stats() ?? null,
          bootMs: deps.bootMs,
          version: deps.version,
          instance: deps.instance,
        }),
      ...(deps.buildHub ? { buildHub: deps.buildHub } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    log.info(
      { target: target.name, apiBaseUrl: target.apiBaseUrl, ingestChannel: target.ingestChannel },
      "target configured",
    );
    return { name: target.name, apiBaseUrl: target.apiBaseUrl, beacon };
  });

  const activePoller = createPoller({
    url: config.sourceUrl,
    pollMs: config.pollMs,
    onFix: (fix) => {
      for (const r of runtimes) {
        setLatestFix(r.beacon.state, fix);
        r.beacon.wake();
      }
    },
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  poller = activePoller;

  const status = (): StatusBody =>
    buildStatus({
      sourceUrl: config.sourceUrl,
      pollMs: config.pollMs,
      pollerStats: activePoller.stats(),
      modeStats: modeSetter?.stats() ?? null,
      targets: runtimes.map((r) => ({ name: r.name, apiBaseUrl: r.apiBaseUrl, state: r.beacon.state })),
      bootMs: deps.bootMs,
      version: deps.version,
      instance: deps.instance,
      now: now(),
    });

  const http = await startHttpServer({
    host: config.httpHost,
    port: deps.httpPort ?? config.httpPort,
    webDir: config.webDir,
    status,
    setMode: modeSetter
      ? (value: LegacyMode) => modeSetter.set(value, polledMode(activePoller.stats(), now()))
      : null,
    log,
  });

  log.info(
    {
      targets: runtimes.map((r) => r.name),
      pollMs: config.pollMs,
      modeControl: modeSetter !== null,
      httpHost: config.httpHost,
      httpPort: http.port(),
    },
    "legacy beacon starting",
  );

  for (const r of runtimes) r.beacon.start();
  activePoller.start();

  return {
    async stop(): Promise<void> {
      activePoller.stop();
      modeSetter?.stop();
      await Promise.all(runtimes.map((r) => r.beacon.stop()));
      await http.close();
    },
    http: () => http,
    poller: () => activePoller,
    beacons: () => runtimes.map((r) => ({ name: r.name, beacon: r.beacon })),
    status,
  };
}
