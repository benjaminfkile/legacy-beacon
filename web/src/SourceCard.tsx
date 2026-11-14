import styles from "./App.module.css";
import { coords, degrees, feet, formatAge, formatTime, mph } from "./format.js";
import type { StatusBody } from "./types.js";

export interface SourceCardProps {
  status: StatusBody;
  nowMs: number;
}

// What the legacy tracker reports: the normalized fix in the tracker's own
// units, the poll statistics, and the raw payload.
export function SourceCard({ status, nowMs }: SourceCardProps) {
  const { source, fix } = status;
  const healthy = source.consecutiveFailures === 0 && source.lastSuccessAt !== null;
  const trackerStatus = source.lastPayload?.status;
  return (
    <section className={styles.card} aria-labelledby="source-title">
      <div className={styles.cardHead}>
        <h2 id="source-title" className={styles.sectionTitle}>
          Tracker
        </h2>
        <span className={`${styles.pill} ${healthy ? styles.pillOk : styles.pillErr}`}>
          {healthy ? "polling" : source.lastFailureReason ?? "no answer yet"}
        </span>
      </div>
      <div className={styles.grid}>
        <span className={styles.label}>Position</span>
        <span className={styles.value}>{fix ? coords(fix.lat, fix.lng) : "none"}</span>
        <span className={styles.label}>Speed</span>
        <span className={styles.value}>{mph(fix?.speedMps ?? null)}</span>
        <span className={styles.label}>Altitude</span>
        <span className={styles.value}>{feet(fix?.altitudeM ?? null)}</span>
        <span className={styles.label}>Heading</span>
        <span className={styles.value}>{degrees(fix?.headingDeg ?? null)}</span>
        <span className={styles.label}>Fix time</span>
        <span className={styles.value}>{formatTime(fix?.recordedAt ?? null)}</span>
        {typeof trackerStatus === "string" && (
          <>
            <span className={styles.label}>Tracker status</span>
            <span className={styles.value}>{trackerStatus}</span>
          </>
        )}
        <span className={styles.label}>Last good poll</span>
        <span className={styles.value}>{formatAge(source.lastSuccessAt, nowMs)}</span>
        <span className={styles.label}>Latency</span>
        <span className={styles.value}>{source.lastLatencyMs === null ? "none" : `${source.lastLatencyMs} ms`}</span>
        <span className={styles.label}>Polls</span>
        <span className={styles.value}>
          {source.pollsOk.toLocaleString()} ok, {source.pollsFailed.toLocaleString()} failed
          {source.consecutiveFailures > 0 ? `, ${source.consecutiveFailures} in a row` : ""}
        </span>
      </div>
      <details className={styles.details}>
        <summary>Raw payload</summary>
        <pre className={styles.raw}>{JSON.stringify(source.lastPayload, null, 2)}</pre>
      </details>
    </section>
  );
}
