// A stand-in for the L2 poller: exposes the same `setFix` shape the poller
// will use, but never calls it. Wiring it in main.ts keeps the L2 integration
// point explicit.

import { setLatestFix, type BeaconState } from "../beacon/state.js";

export interface FixSource {
  start(): void;
  stop(): void;
}

export interface FixSourceOptions {
  state: BeaconState;
  onFix?: (seqLocal: number) => void;
}

export function createStubFixSource(_opts: FixSourceOptions): FixSource {
  // L2 will replace this with poller.ts: GET LB_SOURCE_URL every LB_POLL_MS
  // and hand each normalized fix to setLatestFix(state, ...).
  void setLatestFix;
  return {
    start() {},
    stop() {},
  };
}
