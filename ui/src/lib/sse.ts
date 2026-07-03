import { useEffect, useRef, useCallback } from 'react';

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
    | 'l2_start'
    | 'l2_progress'
    | 'l2_done'
    | 'done'
    | 'error';
  msg: string;
  data?: Record<string, unknown>;
}

export function useSSE(
  runId: number | null,
  onEvent: (event: ScanEvent) => void
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const cleanup = useRef<(() => void) | null>(null);

  const connect = useCallback((id: number) => {
    cleanup.current?.();

    const es = new EventSource(`/api/runs/${id}/stream`);

    es.onmessage = e => {
      try {
        const event = JSON.parse(e.data) as ScanEvent;
        onEventRef.current(event);
        if (event.type === 'done' || event.type === 'l2_done' || event.type === 'error') {
          es.close();
        }
      } catch {
        // malformed event — ignore
      }
    };

    es.onerror = () => es.close();

    cleanup.current = () => es.close();
  }, []);

  useEffect(() => {
    if (runId === null) return;
    connect(runId);
    return () => cleanup.current?.();
  }, [runId, connect]);
}
