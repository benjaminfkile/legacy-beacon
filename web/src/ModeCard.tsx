import { useState } from "react";
import styles from "./App.module.css";
import { formatTime } from "./format.js";
import { MODES, modeName, type LegacyMode, type StatusBody } from "./types.js";

export interface ModeCardProps {
  mode: StatusBody["mode"] | null;
  onSet: (value: LegacyMode) => Promise<void>;
  busy: boolean;
  errorLine: string | null;
}

function modePillClass(mode: number | null): string {
  if (mode === 1) return `${styles.pill} ${styles.pillOk}`;
  if (mode === 2) return `${styles.pill} ${styles.pillWarn}`;
  if (mode === null) return `${styles.pill} ${styles.pillErr}`;
  return styles.pill;
}

// The tracker's polled mode and the three mode buttons. A click asks for a
// confirmation first; the request goes out on Confirm and the polled mode on
// the next polls shows whether it took (legacy-beacon.md 4).
export function ModeCard(props: ModeCardProps) {
  const { mode, onSet, busy, errorLine } = props;
  const [pending, setPending] = useState<LegacyMode | null>(null);
  const polled = mode?.polledMode ?? null;
  const enabled = mode?.enabled ?? false;
  const disabled = !enabled || busy || (mode?.inFlight ?? false);

  return (
    <section className={styles.card} aria-labelledby="mode-title">
      <div className={styles.cardHead}>
        <h2 id="mode-title" className={styles.sectionTitle}>
          Tracker mode
        </h2>
        <span className={modePillClass(polled)} data-testid="polled-mode">
          {polled === null ? "mode unknown" : modeName(polled)}
        </span>
      </div>

      <div className={styles.modeButtons} role="group" aria-label="Set the tracker mode">
        {MODES.map((m) => {
          const current = polled === m.value;
          return (
            <button
              key={m.value}
              type="button"
              className={`${styles.button} ${current ? styles.buttonCurrent : ""}`}
              aria-pressed={current}
              disabled={disabled}
              onClick={() => setPending(m.value)}
            >
              {m.name}
            </button>
          );
        })}
      </div>

      {pending !== null && (
        <div className={styles.confirm} role="alertdialog" aria-label="Confirm mode change">
          <span>
            Set the tracker to <strong>{modeName(pending)}</strong>? Dev and prod both keep posting
            what the tracker reports.
          </span>
          <span className={styles.buttons}>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              disabled={disabled}
              onClick={() => {
                const value = pending;
                setPending(null);
                void onSet(value);
              }}
            >
              Confirm
            </button>
            <button type="button" className={styles.button} onClick={() => setPending(null)}>
              Cancel
            </button>
          </span>
        </div>
      )}

      {!enabled && mode !== null && (
        <p className={styles.note}>Mode control is not configured on this host; the buttons are off.</p>
      )}
      {enabled && mode && mode.lastSetValue !== null && (
        <p className={styles.note}>
          Last request: {modeName(mode.lastSetValue)} at {formatTime(mode.lastSetAt)}
          {mode.inFlight
            ? ", waiting for the tracker"
            : mode.lastSetError
              ? `, failed (${mode.lastSetError})`
              : `, answered ${mode.lastSetStatus ?? "?"}`}
        </p>
      )}
      {errorLine && <p className={styles.errorLine}>{errorLine}</p>}
    </section>
  );
}
