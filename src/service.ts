// Wire the shared beacon-library to this repository's poller and health probe.
// createBeacon owns the socket loop, the send loop, the heartbeat loop, and the
// REST client; gateOnLeader starts and stops that beacon as leadership changes,
// with onStart bringing up the poller as the fix source and onStop tearing it
// down. Extracted from main.ts so a test can drive the wiring with fakes.

import type { Logger } from "pino";
import {
  createBeacon,
  gateOnLeader,
  type Beacon,
  type BeaconLogger,
  type HubClient,
  type HubOptions,
  type Leader,
} from "beacon-library";
import type { Config } from "./config.js";
import { startHealthServer, type HealthProbe, type HealthServer } from "./health.js";
import { buildHeartbeatDebug, buildHeartbeatHealth } from "./heartbeat.js";
import { createPoller, type Poller } from "./source/poller.js";

export interface ServiceDeps {
  log: Logger;
  version: string;
  bootMs: number;
  instance: string;
  fetchImpl?: typeof fetch;
  buildHub?: (o: HubOptions) => HubClient;
  healthPort?: number;
  startHealth?: (probe: () => HealthProbe, port: number) => HealthServer;
}

export interface Service {
  stop(): Promise<void>;
  leader(): Leader;
  beacon(): Beacon;
  health(): HealthServer;
}

export function startService(config: Config, deps: ServiceDeps): Service {
  const log = deps.log;
  const beaconLog: BeaconLogger = {
    info: (fields, msg) => log.info(fields, msg),
    warn: (fields, msg) => log.warn(fields, msg),
    error: (fields, msg) => log.error(fields, msg),
  };

  let leader: Leader | null = null;
  let poller: Poller | null = null;

  const health = (deps.startHealth ?? startHealthServer)(
    () => ({
      configLoaded: true,
      leaderPolledOnce: leader?.polledOnce() ?? false,
    }),
    deps.healthPort ?? 3000,
  );

  const beacon: Beacon = createBeacon({
    apiBaseUrl: config.apiBaseUrl,
    beaconKey: config.beaconKey,
    hubUrl: config.hubUrl,
    ingestChannel: config.ingestChannel,
    log: beaconLog,
    buildHealth: () =>
      buildHeartbeatHealth({ state: beacon.state, pollerStats: poller?.stats() ?? null }),
    buildDebug: () =>
      buildHeartbeatDebug({
        state: beacon.state,
        config,
        pollerStats: poller?.stats() ?? null,
        bootMs: deps.bootMs,
        version: deps.version,
        instance: deps.instance,
        leader: leader?.isLeader() ?? false,
      }),
    ...(deps.buildHub ? { buildHub: deps.buildHub } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  leader = gateOnLeader({
    leader: {
      gatewayInternalUrl: config.gatewayInternalUrl,
      realtimeToken: config.gatewayRealtimeToken,
      forceLeader: config.forceLeader,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    },
    beacon,
    log: beaconLog,
    onStart: () => {
      poller = createPoller({
        url: config.sourceUrl,
        pollMs: config.pollMs,
        state: beacon.state,
        onFix: () => beacon.wake(),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      poller.start();
    },
    onStop: () => {
      poller?.stop();
      poller = null;
    },
  });

  return {
    leader: () => leader!,
    beacon: () => beacon,
    health: () => health,
    async stop() {
      leader?.stop();
      poller?.stop();
      poller = null;
      await beacon.stop();
      await health.close();
    },
  };
}
