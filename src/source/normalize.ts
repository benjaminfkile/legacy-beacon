// Normalize the legacy Heroku tracker payload into the location body of
// contracts 4.2, per the table in legacy-beacon.md section 3. Pure and unit
// tested. Returns `{ ok: true, fix }` for a usable position or `{ ok: false,
// reason }` when the payload does not carry one (the poll is counted as
// failed by the caller).

export interface NormalizedFix {
  lat: number;
  lng: number;
  recordedAt: string;
  speedMps: number | null;
  altitudeM: number | null;
  headingDeg: number | null;
  accuracyM: null;
}

export type NormalizeResult =
  | { ok: true; fix: NormalizedFix }
  | { ok: false; reason: string };

// A raw legacy payload: every value is a string except `mode`, `redirect`,
// `count` (as observed 2026-09-12). We tolerate unknown keys and never touch
// them; only the listed fields are read.
export type LegacyPayload = Record<string, unknown>;

const MPH_TO_MPS = 0.44704;
const FEET_TO_M = 0.3048;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseLeadingNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function toRfc3339Ms(ms: number): string {
  // Three fractional digits, Z. contracts 0.2 wire format.
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `.${pad(d.getUTCMilliseconds(), 3)}Z`
  );
}

export interface NormalizeOptions {
  // Poll time as epoch ms; used for recordedAt when the payload's `time` is 0
  // or missing.
  pollTimeMs: number;
}

export function normalize(
  payload: unknown,
  opts: NormalizeOptions,
): NormalizeResult {
  if (!isPlainObject(payload)) return { ok: false, reason: "payload not an object" };

  const latRaw = payload.lat;
  const lngRaw = payload.lon; // the legacy field is `lon`, not `lng`
  const lat = parseLeadingNumber(latRaw);
  const lng = parseLeadingNumber(lngRaw);
  if (lat === null || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { ok: false, reason: "no usable position" };
  }
  if (lng === null || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { ok: false, reason: "no usable position" };
  }

  let recordedAt: string;
  const timeMsRaw = parseLeadingNumber(payload.time);
  if (timeMsRaw !== null && timeMsRaw > 0) {
    recordedAt = toRfc3339Ms(timeMsRaw);
  } else {
    recordedAt = toRfc3339Ms(opts.pollTimeMs);
  }

  const speedNumber = parseLeadingNumber(payload.speed);
  const speedMps =
    speedNumber === null ? null : round(speedNumber * MPH_TO_MPS, 3);

  const altNumber = parseLeadingNumber(payload.alt);
  const altitudeM = altNumber === null ? null : round(altNumber * FEET_TO_M, 1);

  const bearingNumber = parseLeadingNumber(payload.bearing_raw);
  const headingDeg =
    bearingNumber === null || bearingNumber < 0 || bearingNumber > 360
      ? null
      : bearingNumber;

  return {
    ok: true,
    fix: {
      lat,
      lng,
      recordedAt,
      speedMps,
      altitudeM,
      headingDeg,
      accuracyM: null,
    },
  };
}
