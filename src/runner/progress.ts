export type ScanEventType =
  | 'start'
  | 'source_start'
  | 'job_found'
  | 'source_done'
  | 'source_error'
  | 'l2_start'
  | 'l2_progress'
  | 'l2_done'
  | 'done'
  | 'error';

export interface ScanEvent {
  runId: number;
  type: ScanEventType;
  msg: string;
  data?: Record<string, unknown>;
}

type ScanHandler = (event: ScanEvent) => void;

class ProgressBus {
  private subs = new Map<number, Set<ScanHandler>>();

  subscribe(runId: number, handler: ScanHandler): () => void {
    if (!this.subs.has(runId)) this.subs.set(runId, new Set());
    this.subs.get(runId)!.add(handler);
    return () => {
      this.subs.get(runId)?.delete(handler);
      if (this.subs.get(runId)?.size === 0) this.subs.delete(runId);
    };
  }

  emit(event: ScanEvent): void {
    this.subs.get(event.runId)?.forEach(h => h(event));
  }
}

export const bus = new ProgressBus();
