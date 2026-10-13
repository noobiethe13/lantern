import { useEffect, useRef, useCallback, useState } from 'react';

export interface ScanEvent {
  runId: number;
  type:
    | 'connected'
    | 'start'
    | 'source_start'
    | 'job_found'
    | 'source_done'
    | 'source_error'
    | 'scan_done'
    | 'rescue_start'
    | 'rescue_done'
    | 'l2_start'
    | 'l2_progress'
    | 'l2_done'
    | 'done'
    | 'error';
  msg: string;
  // l2_done additionally carries `aborted` (a fatal-provider-error abort mid
  // pass) and, when it happened, `error` — surface both, don't draw it as a
  // plain success. A terminal 'error' event has just `msg`.
  data?: Record<string, unknown> & { aborted?: boolean; error?: string };
}

const TERMINAL_TYPES = new Set<ScanEvent['type']>(['done', 'l2_done', 'error']);

export function useSSE(
  runId: number | null,
  onEvent: (event: ScanEvent) => void
): { reconnecting: boolean } {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const cleanup = useRef<(() => void) | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const connect = useCallback((id: number) => {
    cleanup.current?.();
    setReconnecting(false);

    const es = new EventSource(`/api/runs/${id}/stream`);
    let terminal = false;

    // EventSource exposes no "reconnecting" event of its own — poll readyState
    // so the UI can show a "reconnecting…" indicator instead of looking frozen.
    const pollReadyState = () => {
      if (!terminal) setReconnecting(es.readyState === EventSource.CONNECTING);
    };
    const iv = setInterval(pollReadyState, 500);

    es.onopen = () => setReconnecting(false);

    es.onmessage = e => {
      try {
        const event = JSON.parse(e.data) as ScanEvent;
        // The initial handshake frame carries no msg — it's transport
        // bookkeeping, not progress; don't forward it into the visible log.
        if (event.type !== 'connected') onEventRef.current(event);
        if (TERMINAL_TYPES.has(event.type)) {
          terminal = true;
          clearInterval(iv);
          setReconnecting(false);
          es.close();
        }
      } catch {
        // malformed event — ignore
      }
    };

    // A drop (sleep/resume, an idle proxy, the server's old 30-min cap) must
    // not freeze the log for the rest of the run: EventSource auto-reconnects
    // on its own unless we close it here, so just surface "reconnecting" and
    // let the browser retry. Only a terminal event or unmount closes the stream.
    es.onerror = pollReadyState;

    cleanup.current = () => { clearInterval(iv); es.close(); };
  }, []);

  useEffect(() => {
    if (runId === null) return;
    connect(runId);
    return () => cleanup.current?.();
  }, [runId, connect]);

  return { reconnecting };
}
