import { useCallback, useEffect, useState } from "react";
import styles from "./App.module.css";
import { ApiError, errorText, type ApiClient } from "./api.js";
import { BeaconsCard } from "./BeaconsCard.js";
import { formatAge, uptime } from "./format.js";
import { ModeCard } from "./ModeCard.js";
import { SourceCard } from "./SourceCard.js";
import type { LegacyMode, StatusBody } from "./types.js";

export const POLL_MS = 1000;

export interface AppProps {
  api: ApiClient;
}

// The whole control page: polls GET /api/status every second while visible
// and renders the mode, the tracker, and the two beacons (legacy-beacon.md 4).
export function App({ api }: AppProps) {
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [lastOkAt, setLastOkAt] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await api.getStatus();
      setStatus(next);
      setLastOkAt(new Date().toISOString());
      setPollError(null);
    } catch (err) {
      setPollError(errorText(err));
    } finally {
      setNowMs(Date.now());
    }
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      if (cancelled || document.visibilityState !== "visible") return;
      void refresh();
    };
    tick();
    const handle = setInterval(tick, POLL_MS);
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(handle);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const onSetMode = useCallback(
    async (value: LegacyMode): Promise<void> => {
      setBusy(true);
      setModeError(null);
      try {
        await api.setMode(value);
      } catch (err) {
        setModeError(err instanceof ApiError ? err.message : errorText(err));
      } finally {
        setBusy(false);
        void refresh();
      }
    },
    [api, refresh],
  );

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>Legacy beacon</h1>
        <span className={styles.meta}>
          {status
            ? `${status.process.instance}, v${status.process.version}, up ${uptime(status.process.uptimeS)}`
            : "connecting"}
        </span>
      </header>

      {pollError && (
        <div className={styles.card}>
          <p className={styles.errorLine}>
            The service is not answering: {pollError}. Last answer {formatAge(lastOkAt, nowMs)}.
          </p>
        </div>
      )}

      <ModeCard mode={status?.mode ?? null} onSet={onSetMode} busy={busy} errorLine={modeError} />
      {status && <SourceCard status={status} nowMs={nowMs} />}
      {status && <BeaconsCard targets={status.targets} nowMs={nowMs} />}
    </div>
  );
}
