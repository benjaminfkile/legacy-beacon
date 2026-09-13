// Socket loop per contracts 9.2. At most one connection; `connected` only after
// the JoinPrivateChannel invoke resolves (the joined ack); evictions re-join
// immediately (auth_expired) or every 5 s (service_removed); a join denied by
// the gateway makes the first retry wait 10 s; every other close or failure
// takes the 1 s, 2 s, 3 s, 5 s backoff, and 5 s repeats forever. The loop
// never gives up.

import { backoffMs, JOIN_DENIED_FIRST_WAIT_MS } from "./backoff.js";
import type { HubClient } from "./hub.js";
import type { BeaconState } from "./state.js";

export interface SocketLoopOptions {
  build: () => HubClient;
  ingestChannel: string;
  key: string;
  state: BeaconState;
  onConnected?: () => void;
  onDisconnected?: () => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface SocketLoop {
  stop(): Promise<void>;
  wake(): void;
}

const CHANNEL_EVICTED = "channelEvicted";

function isJoinDenied(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /join.*denied|denied.*join|forbidden|401|403/i.test(msg);
}

export function startSocketLoop(opts: SocketLoopOptions): SocketLoop {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const state = opts.state;
  let stopped = false;
  let attempt = 0;
  let current: HubClient | null = null;

  async function stopCurrent(): Promise<void> {
    if (!current) return;
    const c = current;
    current = null;
    try {
      await c.stop();
    } catch {
      // A stop() throw is fine; the socket is going away either way.
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      state.socketState = "connecting";
      const client = opts.build();
      current = client;
      let deniedNext = false;
      let evictedNextAttempt: number | null = null;
      client.onClose(() => {
        if (state.socketState === "connected") state.socketState = "reconnecting";
      });
      client.on(CHANNEL_EVICTED, (arg: unknown) => {
        const reason =
          arg && typeof arg === "object" && "reason" in (arg as object)
            ? (arg as { reason?: string }).reason
            : undefined;
        // auth_expired: rejoin immediately (attempt=0);
        // service_removed: rejoin every 5 s (attempt=3, backoffMs=5000).
        evictedNextAttempt = reason === "service_removed" ? 3 : 0;
        void stopCurrent();
      });
      try {
        await client.start();
        await client.invoke("JoinPrivateChannel", opts.ingestChannel, opts.key);
        attempt = 0;
        state.socketState = "connected";
        state.reconnectCount += 1;
        opts.onConnected?.();
        // Sit here until stopCurrent() is called (by stop, close, or eviction).
        while (!stopped && current === client) {
          await sleep(1000);
        }
      } catch (err) {
        deniedNext = isJoinDenied(err);
        state.socketState = "reconnecting";
        opts.onDisconnected?.();
      } finally {
        await stopCurrent();
      }

      if (stopped) return;
      opts.onDisconnected?.();
      let delay: number;
      if (deniedNext) {
        delay = JOIN_DENIED_FIRST_WAIT_MS;
        attempt = 1;
      } else if (evictedNextAttempt !== null) {
        attempt = evictedNextAttempt;
        delay = attempt === 0 ? 0 : backoffMs(attempt);
        attempt += 1;
      } else {
        delay = backoffMs(attempt);
        attempt += 1;
      }
      if (delay > 0) await sleep(delay);
    }
  }

  // The loop never throws out; a stray failure would only mean stop() raced
  // with a build() throw. Kick it off in the microtask queue so the caller
  // returns a handle before the first `state.socketState = "connecting"`.
  void Promise.resolve().then(loop);

  return {
    async stop() {
      stopped = true;
      await stopCurrent();
      state.socketState = "disconnected";
    },
    wake() {
      // No wake-up channel: sleep-based delays run to completion; the loop
      // reads `stopped` on every cycle. A caller who needs to break the sleep
      // early passes their own sleep() and drives it themselves.
    },
  };
}
