// Lets route modules cancel an in-flight background refresh without importing the refresher,
// which would create an import cycle (the refresher imports routes/sources for the aggregator
// set, and builds its singleton from scan.ts constants at load time).
type Cancel = (sourceId?: number) => void;

let cancel: Cancel | null = null;

export function registerRefreshCancel(fn: Cancel): void {
  cancel = fn;
}

/** Aborts the refresher's in-flight fetch of one source, or all. No-op until it is loaded. */
export function cancelBoardRefresh(sourceId?: number): void {
  cancel?.(sourceId);
}
