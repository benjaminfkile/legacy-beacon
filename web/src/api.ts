// Thin fetch wrapper for the service's HTTP surface (legacy-beacon.md 4). The
// page is served by the service, so every path is same-origin. A non-2xx
// answer becomes an ApiError whose `code` is the error body's `code`
// (contracts 0.3) when the body was JSON, otherwise `http_<status>`.

import type { ApiErrorBody, LegacyMode, ModeAnswer, StatusBody } from "./types.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body: ApiErrorBody | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ApiClient {
  getStatus(): Promise<StatusBody>;
  setMode(value: LegacyMode): Promise<ModeAnswer>;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null;
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      body = null;
    }
  }
  const code = body?.code ?? `http_${res.status}`;
  const msg = body?.message ?? `${res.status} ${res.statusText}`;
  return new ApiError(res.status, code, msg, body);
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const base = (opts.baseUrl ?? "").replace(/\/$/, "");

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const init: RequestInit = { method, headers, cache: "no-store" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${base}${path}`, init);
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as T;
  }

  return {
    getStatus: () => req<StatusBody>("GET", "/api/status"),
    setMode: (value) => req<ModeAnswer>("POST", "/api/mode", { value }),
  };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
