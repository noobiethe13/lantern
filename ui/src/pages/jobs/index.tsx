import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { X } from 'lucide-react';
import { api, type Job, type JobStatus, type Run } from '@/lib/api';
import { useToast } from '@/components/ui';
import { SearchField, StatusTabs, RefineControl } from './controls';
import { JobRow, SkeletonRows, EmptyState, ErrorState } from './JobList';
import { JobDetail, PanePlaceholder } from './JobDetail';
import './jobs.css';

const PAGE_LIMIT = 200;
// Must match the jobs.css breakpoint where the reading pane appears.
const SPLIT_QUERY = '(min-width: 1180px)';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/**
 * The triage workspace. Wide windows get two panes — the ranked list and a
 * reading pane that's always showing the selected role, so moving through
 * results is j, j, j with no open/close. Narrow windows keep the list and slide
 * the same detail in as a drawer.
 */
export default function Jobs() {
  const toast = useToast();
  const split = useMediaQuery(SPLIT_QUERY);
  const [params, setParams] = useSearchParams();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [totalCapped, setTotalCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [counts, setCounts] = useState<Partial<Record<JobStatus, number>>>({});
  // Latest run, while it's still scoring (finished_at null) — drives the
  // "scoring in progress" hint and the poll that refreshes the list on completion.
  const [scanningRun, setScanningRun] = useState<Run | null>(null);
  // Survivors of the latest finished run that L2 has not graded yet (grading limit).
  const [ungraded, setUngraded] = useState(0);

  const status = params.get('status') ?? '';
  const l1 = params.get('l1') === '1';
  const l2 = params.get('l2') === '1';
  const fit = params.get('fit') === '1';
  const remote = params.get('remote') === '1';
  const run = params.get('run') ?? '';
  const sourceTypeRaw = params.get('source_type') ?? '';
  const sourceTypes = sourceTypeRaw.split(',').filter(Boolean);
  const q = params.get('q') ?? '';

  // Apply several URL-param changes in ONE setParams call. Calling setParams
  // multiple times in a tick doesn't accumulate (each functional update reads the
  // same snapshot), so batched edits like "clear all filters" must mutate once.
  const mutate = useCallback((fn: (p: URLSearchParams) => void) => {
    setParams(prev => { const next = new URLSearchParams(prev); fn(next); return next; });
  }, [setParams]);

  const setParam = (key: string, val: string) => mutate(p => { if (val) p.set(key, val); else p.delete(key); });

  // Source filter is multi-select. '' = "All sources" (clear the set).
  const toggleSource = (val: string) => mutate(p => {
    if (!val) { p.delete('source_type'); return; }
    const cur = new Set((p.get('source_type') ?? '').split(',').filter(Boolean));
    if (cur.has(val)) cur.delete(val); else cur.add(val);
    if (cur.size) p.set('source_type', [...cur].join(',')); else p.delete('source_type');
  });

  const clearFilters = () => mutate(p => { for (const k of ['fit', 'remote', 'l1', 'l2', 'source_type', 'run']) p.delete(k); });

  // Guards against out-of-order responses: debounced typing + fast tab clicks
  // can fire overlapping requests, and without this an older response landing
  // after a newer one would overwrite it with stale rows.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.jobs.list({
        status: status || undefined,
        l1: l1 ? '1' : undefined,
        l2: l2 ? '1' : undefined,
        fit: fit ? '1' : undefined,
        remote: remote ? '1' : undefined,
        run: run || undefined,
        source_type: sourceTypeRaw || undefined,
        q: q || undefined,
        limit: PAGE_LIMIT,
      });
      if (seq !== loadSeq.current) return; // a newer request has already resolved
      setJobs(res.jobs);
      setTotal(res.total);
      setTotalCapped(Boolean(res.total_capped));
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadError(String(e instanceof Error ? e.message : e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [status, l1, l2, fit, remote, run, sourceTypeRaw, q]);

  useEffect(() => { load(); }, [load]);

  const loadCounts = useCallback(() => {
    api.jobs.statusCounts().then(r => setCounts(r.counts)).catch(e => console.error('status counts failed', e));
  }, []);
  useEffect(() => { loadCounts(); }, [loadCounts]);

  // Two panes always show something: when a list lands and the selection isn't
  // in it, read the top result. (A drawer stays closed until asked for.)
  useEffect(() => {
    if (!split || jobs.length === 0) return;
    setSelectedId(cur => (cur != null && jobs.some(j => j.id === cur) ? cur : jobs[0].id));
  }, [jobs, split]);

  // A search wipes verdicts before scanning, so /jobs mid-scan would otherwise
  // show every row frozen at L1/unscored with no explanation and never refresh.
  // Poll the latest run while it's unfinished; reload once L2 completes.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const pollRun = (id: number) => {
      timer = setTimeout(async () => {
        if (!live) return;
        try {
          const latest = await api.runs.get(id);
          if (!live) return;
          if (latest.finished_at != null) {
            setScanningRun(null);
            setUngraded(latest.l2_pending ?? 0);
            loadRef.current();
          } else {
            setScanningRun(latest);
            pollRun(id);
          }
        } catch (e) {
          // transient — try again on the next tick rather than getting stuck
          console.error('run poll failed', e);
          pollRun(id);
        }
      }, 4000);
    };

    api.runs.list(1).then(({ runs }) => {
      if (!live) return;
      const latest = runs[0];
      if (latest && latest.finished_at == null) {
        setScanningRun(latest);
        pollRun(latest.id);
      } else {
        setScanningRun(null);
        setUngraded(latest?.l2_pending ?? 0);
      }
    }).catch(e => console.error('latest run lookup failed', e));

    return () => { live = false; clearTimeout(timer); };
  }, []);

  const handleStatusChange = useCallback(async (job: Job, newStatus: JobStatus) => {
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: newStatus } : j));
    try {
      await api.jobs.setStatus(job.id, newStatus);
      loadCounts();
    } catch (e) {
      toast(`Couldn't update status: ${String(e instanceof Error ? e.message : e)}`, 'error');
      load();
    }
  }, [load, loadCounts, toast]);

  // Status each job had before it was dismissed this session, so Restore can undo
  // exactly. After a reload it is unknown and Restore falls back to 'new'.
  const prevStatus = useRef(new Map<number, JobStatus>());

  // Dismiss, then step to the next row so a run of "no"s is a run of keypresses.
  const handleDismiss = (job: Job) => {
    const idx = jobs.findIndex(j => j.id === job.id);
    const before = job.status as JobStatus;
    if (job.status !== 'hidden') prevStatus.current.set(job.id, before);
    handleStatusChange(job, 'hidden');
    if (idx >= 0 && idx < jobs.length - 1) select(jobs[idx + 1].id);
    toast(`Hid ${job.title} at ${job.company}`, 'info', {
      action: { label: 'Undo', onClick: () => { handleStatusChange(job, before); select(job.id); } },
    });
  };

  // `s` toggles the shortlist: the most common "yes" in triage, one key away.
  const handleShortlist = (job: Job) => {
    handleStatusChange(job, job.status === 'shortlist' ? 'new' : 'shortlist');
  };

  const handleNotesSaved = useCallback((id: number, notes: string) => {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, notes } : j));
  }, []);

  const select = useCallback((id: number) => {
    setSelectedId(id);
    // keep the row in view when moving by keyboard or from the pane's arrows
    requestAnimationFrame(() => document.querySelector(`[data-job-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, []);

  const selected = jobs.find(j => j.id === selectedId) ?? null;
  const selIdx = selected ? jobs.findIndex(j => j.id === selected.id) : -1;

  // Keyboard triage: j/k or arrows to move, s shortlist, x dismiss, o open, / filter,
  // Esc to close. Bound once; live state is read through refs.
  const jobsRef = useRef(jobs); jobsRef.current = jobs;
  const selRef = useRef(selectedId); selRef.current = selectedId;
  const actions = useRef({ dismiss: (_: Job) => {}, shortlist: (_: Job) => {} });
  actions.current = { dismiss: handleDismiss, shortlist: handleShortlist };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A popover (StatusPill dropdown, Refine) already handled this Escape and
      // called preventDefault — without this check, closing a popover with Esc
      // would also close the whole detail panel underneath it.
      if (e.defaultPrevented) return;
      // Ctrl/Cmd/Alt+J/K etc. are browser/OS shortcuts, not triage shortcuts.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // Inside an open popover the keys belong to it.
      if (target?.closest('[role="listbox"]:not(.jobs-list), [role="dialog"]')) return;
      const list = jobsRef.current;
      const cur = selRef.current;
      const curJob = cur != null ? list.find(j => j.id === cur) : undefined;
      // Arrow keys inside the reading pane scroll it; j/k still move the list.
      const inPane = !!target?.closest('.detail-panel');

      if (e.key === 'Escape') { setSelectedId(null); return; }
      if (e.key === '/') {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('.job-search input')?.focus();
        return;
      }
      if (list.length === 0) return;
      if (e.key === 'x') { if (curJob && curJob.status !== 'hidden') actions.current.dismiss(curJob); return; }
      if (e.key === 's') { if (curJob) actions.current.shortlist(curJob); return; }
      if (e.key === 'o') { if (curJob) window.open(curJob.url, '_blank', 'noopener,noreferrer'); return; }
      const down = e.key === 'j' || (e.key === 'ArrowDown' && !inPane);
      const up = e.key === 'k' || (e.key === 'ArrowUp' && !inPane);
      if (!down && !up) return;
      e.preventDefault();
      const idx = cur != null ? list.findIndex(j => j.id === cur) : -1;
      const next = down
        ? list[Math.min(idx + 1, list.length - 1)]
        : list[Math.max((idx === -1 ? list.length : idx) - 1, 0)];
      select(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [select]);

  const hasFilters = !!(status || l1 || l2 || fit || remote || run || sourceTypeRaw || q);

  const detail = selected && (
    <JobDetail
      job={selected}
      mode={split ? 'pane' : 'drawer'}
      onClose={() => setSelectedId(null)}
      onStatusChange={s => handleStatusChange(selected, s)}
      onDismiss={() => handleDismiss(selected)}
      onShortlist={() => handleShortlist(selected)}
      restoreTo={prevStatus.current.get(selected.id) ?? 'new'}
      onNotesSaved={handleNotesSaved}
      onPrev={selIdx > 0 ? () => select(jobs[selIdx - 1].id) : undefined}
      onNext={selIdx >= 0 && selIdx < jobs.length - 1 ? () => select(jobs[selIdx + 1].id) : undefined}
    />
  );

  return (
    <div className="jobs-page">
      <header className="jobs-head">
        <div aria-hidden className="jobs-head-glow" />
        <div className="jobs-head-top">
          <div style={{ minWidth: 0 }}>
            <h1 className="jobs-title">Jobs</h1>
            <p className="jobs-meta">
              {loading && jobs.length === 0 ? <span style={{ color: 'var(--text-faint)' }}>Loading…</span> : (
                <>
                  <span className="tnum" style={{ color: 'var(--text)' }}>{total.toLocaleString()}{totalCapped ? '+' : ''}</span> {total === 1 ? 'role' : 'roles'}
                  <span className="jd-faint"> · ranked by fit</span>
                  {scanningRun && <span style={{ color: 'var(--accent-text)' }}> · scoring in progress</span>}
                  {!scanningRun && ungraded > 0 && <span className="jd-faint" title="Search the same query again to grade the next batch"> · <span className="tnum">{ungraded.toLocaleString()}</span> more not yet graded</span>}
                  {total > PAGE_LIMIT && <span className="jd-faint"> · showing the top {PAGE_LIMIT}</span>}
                </>
              )}
            </p>
          </div>
          <div className="jobs-tools">
            <SearchField q={q} onQ={v => setParam('q', v)} />
            <RefineControl
              fit={fit} remote={remote} l1={l1} l2={l2} sourceTypes={sourceTypes}
              onFit={v => setParam('fit', v ? '1' : '')}
              onRemote={v => setParam('remote', v ? '1' : '')}
              onL1={v => setParam('l1', v ? '1' : '')}
              onL2={v => setParam('l2', v ? '1' : '')}
              onToggleSource={toggleSource}
              onClearAll={clearFilters}
            />
          </div>
        </div>
        <div className="jobs-tabs-row">
          <StatusTabs status={status} counts={counts} onStatus={v => setParam('status', v)} />
          {/* Run scope — set by "Review matches" / Recent runs on Search. */}
          {run && (
            <span className="run-chip">
              {run === 'latest' ? 'Latest search' : `Search #${run}`}
              <button onClick={() => setParam('run', '')} aria-label="Show all searches"><X size={12} /></button>
            </span>
          )}
        </div>
      </header>

      <div className="jobs-split">
        <section className="jobs-list" role="listbox" aria-label="Jobs" data-loading={loading || undefined}>
          {loading && jobs.length === 0 ? <SkeletonRows />
            : loadError ? <ErrorState message={loadError} onRetry={load} />
            : jobs.length === 0 ? <EmptyState hasFilters={hasFilters} />
            : jobs.map((job, i) => <JobRow key={job.id} job={job} index={i} selected={job.id === selectedId} onSelect={select} />)}
        </section>
        {split && (
          <section className="jobs-pane">
            {detail ?? (jobs.length > 0 && <PanePlaceholder />)}
          </section>
        )}
      </div>

      {!split && detail}
    </div>
  );
}
