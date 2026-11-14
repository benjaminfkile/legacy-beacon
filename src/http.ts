// The HTTP surface (legacy-beacon.md 4): the health probe, the status the
// control page polls, the mode request, and the built control page itself,
// all on one Fastify server bound to the LAN. There is no sign-in: the
// service is reachable only from the local network.

import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import type { BeaconLogger } from "beacon-library";
import { isLegacyMode, MODE_NAMES, type ModeSetResult, type LegacyMode } from "./source/modeSetter.js";
import type { StatusBody } from "./status.js";

export interface HttpServerOptions {
  host: string;
  port: number;
  webDir: string | null;
  status: () => StatusBody;
  // Null when mode control is off.
  setMode: ((value: LegacyMode) => Promise<ModeSetResult | null>) | null;
  log: BeaconLogger;
}

export interface HttpServer {
  app: FastifyInstance;
  port(): number;
  close(): Promise<void>;
}

function errorBody(code: string, message: string, details: unknown = null): object {
  return { code, message, details, requestId: "" };
}

function sendJson(reply: FastifyReply, status: number, body: unknown): FastifyReply {
  return reply
    .code(status)
    .header("Cache-Control", "no-store")
    .header("Content-Type", "application/json; charset=utf-8")
    .send(body);
}

export async function buildHttpApp(opts: Omit<HttpServerOptions, "host" | "port">): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const log = opts.log;

  app.get("/api/health", async (_req, reply) => sendJson(reply, 200, { status: "ok" }));

  app.get("/api/status", async (_req, reply) => sendJson(reply, 200, opts.status()));

  app.post("/api/mode", async (req, reply) => {
    const body = req.body as { value?: unknown } | null | undefined;
    const value = body?.value;
    if (!isLegacyMode(value)) {
      return sendJson(reply, 400, errorBody("validation_failed", "value must be 0, 1, or 2"));
    }
    if (opts.setMode === null) {
      return sendJson(reply, 409, errorBody("mode_control_off", "mode control is not configured"));
    }
    log.info({ to: value, mode: MODE_NAMES[value], client: req.ip }, "mode requested");
    const result = await opts.setMode(value);
    if (result === null) {
      return sendJson(reply, 409, errorBody("mode_busy", "a mode request is already in flight"));
    }
    if (!result.ok) {
      return sendJson(
        reply,
        502,
        errorBody("upstream_failed", `the legacy tracker refused: ${result.reason}`, {
          status: result.status,
        }),
      );
    }
    return sendJson(reply, 200, { ok: true, value: result.value, status: result.status });
  });

  if (opts.webDir !== null && existsSync(opts.webDir)) {
    await app.register(fastifyStatic, { root: opts.webDir, index: ["index.html"] });
  } else if (opts.webDir !== null) {
    log.warn({ webDir: opts.webDir }, "control page directory missing; serving the API only");
  }

  app.setNotFoundHandler((_req, reply) => sendJson(reply, 404, errorBody("not_found", "no such route")));

  return app;
}

export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServer> {
  const app = await buildHttpApp(opts);
  await app.listen({ host: opts.host, port: opts.port });
  return {
    app,
    port() {
      const addr = app.server.address();
      return addr !== null && typeof addr === "object" ? addr.port : opts.port;
    },
    close: () => app.close(),
  };
}
