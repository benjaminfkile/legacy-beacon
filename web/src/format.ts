// Display helpers for the control page. Units on the page are the tracker's
// own (mph, feet); the wire carries metres and metres per second.

export function ageSeconds(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((nowMs - t) / 1000));
}

export function formatAge(iso: string | null, nowMs: number): string {
  const s = ageSeconds(iso, nowMs);
  if (s === null) return "never";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export function formatTime(iso: string | null): string {
  if (!iso) return "none";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "none" : d.toLocaleString();
}

export function mph(mps: number | null): string {
  return mps === null ? "none" : `${(mps * 2.23694).toFixed(1)} mph`;
}

export function feet(m: number | null): string {
  return m === null ? "none" : `${Math.round(m * 3.28084).toLocaleString()} ft`;
}

export function degrees(d: number | null): string {
  return d === null ? "none" : `${Math.round(d)}°`;
}

export function coords(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

export function uptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
}
