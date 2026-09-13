// The normalizer against the two payload samples in legacy-beacon.md 3 and
// the vendored location.schema.json. `lon` not `lng`; mph and feet
// conversions; `time` 0 becomes the poll time; unparseable speed and altitude
// become null; an out-of-range latitude is a failed poll.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { normalize } from "../src/source/normalize.js";

const schema = JSON.parse(
  readFileSync(join(process.cwd(), "contracts/schema/location.schema.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validate = ajv.compile(schema);

// The observed payload of 2026-09-12 (legacy-beacon.md 3). Every value a
// string except `mode`, `redirect`, `count`.
const SAMPLE = {
  lat: "46.918520",
  lon: "-114.090039",
  speed: "0.00 mph",
  temp: "0",
  alt: "2715 ft",
  bearing: "N",
  bearing_raw: "0",
  mode: 1,
  time: "1766460807560",
  type: "tracker",
  status: "Battery Full at 100%",
  redirect: 0,
  count: 0,
};

// The pre-show sample: `time` 0 (no fix time from the vendor yet).
const SAMPLE_PRESHOW = { ...SAMPLE, time: 0 };

const POLL_MS = Date.parse("2026-09-13T00:00:00.000Z");

describe("normalize (legacy-beacon.md 3)", () => {
  it("normalizes the observed sample: lon->lng, mph->mps, ft->m, bearing_raw", () => {
    const r = normalize(SAMPLE, { pollTimeMs: POLL_MS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fix.lat).toBe(46.91852);
    expect(r.fix.lng).toBe(-114.090039);
    // 0.00 mph → 0 mps (rounded to 3 decimals).
    expect(r.fix.speedMps).toBe(0);
    // 2715 ft * 0.3048 = 827.532 m → 827.5 rounded to 1 decimal.
    expect(r.fix.altitudeM).toBe(827.5);
    // bearing_raw "0" is 0 degrees; bearing "N" is never used.
    expect(r.fix.headingDeg).toBe(0);
    // accuracy is unknown and always null.
    expect(r.fix.accuracyM).toBeNull();
    // time > 0: epoch ms rendered as three-fractional-digit UTC.
    expect(r.fix.recordedAt).toBe("2025-12-23T03:33:27.560Z");
  });

  it("uses the poll time when `time` is 0 (pre-show sample)", () => {
    const r = normalize(SAMPLE_PRESHOW, { pollTimeMs: POLL_MS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fix.recordedAt).toBe("2026-09-13T00:00:00.000Z");
  });

  it("output validates against the vendored location.schema.json for both samples", () => {
    for (const p of [SAMPLE, SAMPLE_PRESHOW]) {
      const r = normalize(p, { pollTimeMs: POLL_MS });
      if (!r.ok) throw new Error("expected ok");
      const ok = validate(r.fix);
      if (!ok) console.error(validate.errors);
      expect(ok).toBe(true);
    }
  });

  it("mph conversion rounds to three decimals", () => {
    const r = normalize({ ...SAMPLE, speed: "12.34 mph" }, { pollTimeMs: POLL_MS });
    if (!r.ok) throw new Error("expected ok");
    // 12.34 * 0.44704 = 5.5164736 → 5.516.
    expect(r.fix.speedMps).toBe(5.516);
  });

  it("feet conversion rounds to one decimal", () => {
    const r = normalize({ ...SAMPLE, alt: "1000 ft" }, { pollTimeMs: POLL_MS });
    if (!r.ok) throw new Error("expected ok");
    // 1000 * 0.3048 = 304.8 → 304.8.
    expect(r.fix.altitudeM).toBe(304.8);
  });

  it("unparseable speed and altitude become null", () => {
    const r = normalize(
      { ...SAMPLE, speed: "n/a", alt: "?" },
      { pollTimeMs: POLL_MS },
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.fix.speedMps).toBeNull();
    expect(r.fix.altitudeM).toBeNull();
  });

  it("absent speed and altitude become null", () => {
    const partial = { ...SAMPLE } as Record<string, unknown>;
    delete partial.speed;
    delete partial.alt;
    const r = normalize(partial, { pollTimeMs: POLL_MS });
    if (!r.ok) throw new Error("expected ok");
    expect(r.fix.speedMps).toBeNull();
    expect(r.fix.altitudeM).toBeNull();
  });

  it("bearing_raw out of range becomes null; `bearing` 'N' is never read", () => {
    const r1 = normalize({ ...SAMPLE, bearing_raw: "999" }, { pollTimeMs: POLL_MS });
    if (!r1.ok) throw new Error("expected ok");
    expect(r1.fix.headingDeg).toBeNull();

    // Without bearing_raw, no heading — even though `bearing` is present.
    const without = { ...SAMPLE } as Record<string, unknown>;
    delete without.bearing_raw;
    const r2 = normalize(without, { pollTimeMs: POLL_MS });
    if (!r2.ok) throw new Error("expected ok");
    expect(r2.fix.headingDeg).toBeNull();
  });

  it("out-of-range latitude is a failed poll", () => {
    const r = normalize({ ...SAMPLE, lat: "95.0" }, { pollTimeMs: POLL_MS });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/usable position/);
  });

  it("out-of-range longitude is a failed poll", () => {
    const r = normalize({ ...SAMPLE, lon: "-200" }, { pollTimeMs: POLL_MS });
    expect(r.ok).toBe(false);
  });

  it("missing lat or lon is a failed poll", () => {
    const noLat = { ...SAMPLE } as Record<string, unknown>;
    delete noLat.lat;
    expect(normalize(noLat, { pollTimeMs: POLL_MS }).ok).toBe(false);

    const noLon = { ...SAMPLE } as Record<string, unknown>;
    delete noLon.lon;
    expect(normalize(noLon, { pollTimeMs: POLL_MS }).ok).toBe(false);
  });

  it("a non-object payload is a failed poll", () => {
    expect(normalize(null, { pollTimeMs: POLL_MS }).ok).toBe(false);
    expect(normalize("string", { pollTimeMs: POLL_MS }).ok).toBe(false);
    expect(normalize([], { pollTimeMs: POLL_MS }).ok).toBe(false);
  });

  it("the legacy `mode` is never read by the normalizer", () => {
    const r1 = normalize({ ...SAMPLE, mode: 1 }, { pollTimeMs: POLL_MS });
    const r2 = normalize({ ...SAMPLE, mode: 99 }, { pollTimeMs: POLL_MS });
    if (!r1.ok || !r2.ok) throw new Error("expected ok");
    expect(r1.fix).toEqual(r2.fix);
  });
});
