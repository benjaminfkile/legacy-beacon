// One HubConnection per beacon: WebSockets only, negotiation skipped,
// keep-alive 15 s, timeout 30 s, no automatic reconnect (the socket loop owns
// reconnect). Wrapped behind HubClient so tests can substitute a fake.

import {
  HubConnection,
  HubConnectionBuilder,
  HttpTransportType,
  LogLevel,
} from "@microsoft/signalr";

export interface HubClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  on(method: string, handler: (...args: unknown[]) => void): void;
  off(method: string, handler: (...args: unknown[]) => void): void;
  onClose(handler: (err?: Error) => void): void;
}

export interface HubOptions {
  hubUrl: string;
  key: string;
}

export function buildHubClient(opts: HubOptions): HubClient {
  const conn: HubConnection = new HubConnectionBuilder()
    .withUrl(opts.hubUrl, {
      transport: HttpTransportType.WebSockets,
      skipNegotiation: true,
      accessTokenFactory: () => opts.key,
    })
    .withKeepAliveInterval(15_000)
    .withServerTimeout(30_000)
    .configureLogging(LogLevel.Warning)
    .build();
  // No .withAutomaticReconnect(): reconnect belongs to the socket loop.
  return {
    start: () => conn.start(),
    stop: () => conn.stop(),
    invoke: <T,>(method: string, ...args: unknown[]) => conn.invoke<T>(method, ...args),
    on: (method, handler) => conn.on(method, handler),
    off: (method, handler) => conn.off(method, handler),
    onClose: (handler) => conn.onclose((err) => handler(err ?? undefined)),
  };
}
