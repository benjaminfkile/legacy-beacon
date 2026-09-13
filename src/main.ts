// Boot: load config, start the health server, start the leader poll, start the
// beacon core on the leader. A stub fix source stands in for L2's poller: it
// leaves the state's latestFix untouched, so the send loop naturally idles
// until L2 wires the legacy poller in.

import pino from "pino";
import { loadConfig, ConfigError } from "./config.js";
import { startLeader, type Leader } from "./leader.js";
import { startHealthServer } from "./health.js";
import { createBeaconState } from "./beacon/state.js";
import { createRest } from "./beacon/rest.js";
import { buildHubClient, type HubClient } from "./beacon/hub.js";
import { startSocketLoop, type SocketLoop } from "./beacon/socketLoop.js";
import { startSendLoop, type SendLoop } from "./beacon/sendLoop.js";
import { startHeartbeatLoop, type HeartbeatLoop } from "./beacon/heartbeatLoop.js";
import { createStubFixSource, type FixSource } from "./source/stub.js";

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

  let leader: Leader | null = null;
  const health = startHealthServer(
    () => ({
      configLoaded: true,
      leaderPolledOnce: leader?.polledOnce() ?? false,
    }),
    3000,
  );

  const state = createBeaconState();
  const rest = createRest({ apiBaseUrl: config.apiBaseUrl, key: config.beaconKey });

  let hub: HubClient | null = null;
  let socket: SocketLoop | null = null;
  let sendLoop: SendLoop | null = null;
  let heartbeat: HeartbeatLoop | null = null;
  let source: FixSource | null = null;

  function startCore() {
    if (socket) return;
    log.info("starting beacon core");
    socket = startSocketLoop({
      build: () => {
        hub = buildHubClient({ hubUrl: config.hubUrl, key: config.beaconKey });
        return hub;
      },
      ingestChannel: config.ingestChannel,
      key: config.beaconKey,
      state,
      onConnected: () => sendLoop?.wake(),
    });
    sendLoop = startSendLoop({
      state,
      rest,
      getHub: () => hub,
      ingestChannel: config.ingestChannel,
    });
    heartbeat = startHeartbeatLoop({ state, rest });
    source = createStubFixSource({ state, onFix: () => sendLoop?.wake() });
    source.start();
  }

  async function stopCore() {
    if (!socket) return;
    log.info("stopping beacon core");
    source?.stop();
    sendLoop?.stop();
    heartbeat?.stop();
    await socket.stop();
    socket = null;
    sendLoop = null;
    heartbeat = null;
    hub = null;
    source = null;
  }

  leader = startLeader({
    gatewayInternalUrl: config.gatewayInternalUrl,
    realtimeToken: config.gatewayRealtimeToken,
    forceLeader: config.forceLeader,
    onChange: (isLeader) => {
      log.info({ isLeader }, "leader change");
      if (isLeader) startCore();
      else void stopCore();
    },
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutdown");
    leader?.stop();
    await stopCore();
    await health.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
