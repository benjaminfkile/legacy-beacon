import styles from "./App.module.css";
import { formatAge } from "./format.js";
import type { TargetStatus } from "./types.js";

export interface BeaconsCardProps {
  targets: TargetStatus[];
  nowMs: number;
}

function socketPillClass(state: string): string {
  switch (state) {
    case "connected":
      return `${styles.pill} ${styles.pillOk}`;
    case "connecting":
    case "reconnecting":
      return `${styles.pill} ${styles.pillWarn}`;
    default:
      return `${styles.pill} ${styles.pillErr}`;
  }
}

function Target({ t, nowMs }: { t: TargetStatus; nowMs: number }) {
  const behind = t.latestSeqLocal !== null && t.latestSeqLocal !== t.lastDeliveredSeqLocal;
  return (
    <article className={styles.target} aria-label={`${t.name} beacon`}>
      <h3 className={styles.targetName}>{t.name}</h3>
      {t.revoked && <div className={styles.banner}>Revoked: this key no longer works</div>}
      <div className={styles.pills}>
        <span className={socketPillClass(t.socketState)}>socket {t.socketState}</span>
        <span className={`${styles.pill} ${t.isActive ? styles.pillOk : ""}`}>
          {t.isActive === null ? "no heartbeat yet" : t.isActive ? "Active" : "Spare"}
        </span>
        <span className={`${styles.pill} ${t.liveEventId !== null ? styles.pillOk : ""}`}>
          {t.liveEventId !== null ? `live event ${t.liveEventId}` : "no live event"}
        </span>
      </div>
      <div className={styles.grid}>
        <span className={styles.label}>Heartbeat</span>
        <span className={styles.value}>{formatAge(t.lastHeartbeatAt, nowMs)}</span>
        <span className={styles.label}>Fixes</span>
        <span className={styles.value}>
          {t.lastDeliveredSeqLocal.toLocaleString()} delivered{behind ? ", sending" : ""}
        </span>
        <span className={styles.label}>Receipt</span>
        <span className={styles.value}>
          {t.lastReceiptLatencyMs === null ? "none" : `${t.lastReceiptLatencyMs} ms`}
        </span>
        <span className={styles.label}>Sends failed</span>
        <span className={styles.value}>{t.sendsFailedSinceBoot}</span>
        <span className={styles.label}>Reconnects</span>
        <span className={styles.value}>
          {t.reconnectCount}
          {t.httpFallbackSeconds > 0 ? `, ${t.httpFallbackSeconds} s on HTTP` : ""}
        </span>
      </div>
    </article>
  );
}

// One row per target environment: both beacons post the same polled fix.
export function BeaconsCard({ targets, nowMs }: BeaconsCardProps) {
  return (
    <section className={styles.card} aria-labelledby="beacons-title">
      <h2 id="beacons-title" className={styles.sectionTitle}>
        Beacons
      </h2>
      <div className={styles.targets}>
        {targets.map((t) => (
          <Target key={t.name} t={t} nowMs={nowMs} />
        ))}
      </div>
    </section>
  );
}
