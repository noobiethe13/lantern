import { useState, useEffect, useRef } from 'react';
import { Search, X, SlidersHorizontal, Check } from 'lucide-react';
import type { JobStatus } from '@/lib/api';
import { Kbd, Switch } from '@/components/ui';

const STATUS_TABS: { label: string; value: '' | JobStatus }[] = [
  { label: 'All', value: '' },
  { label: 'New', value: 'new' },
  { label: 'Shortlist', value: 'shortlist' },
  { label: 'Applied', value: 'applied' },
  { label: 'Interview', value: 'interview' },
  { label: 'Offer', value: 'offer' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Hidden', value: 'hidden' },
];

// Source types for the roster filter, with display labels (the internal ids
// like "remoteok" aren't how the boards are branded).
const SOURCE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All sources' },
  { value: 'greenhouse', label: 'Greenhouse' },
  { value: 'ashby', label: 'Ashby' },
  { value: 'lever', label: 'Lever' },
  { value: 'recruitee', label: 'Recruitee' },
  { value: 'smartrecruiters', label: 'SmartRecruiters' },
  { value: 'workable', label: 'Workable' },
  { value: 'personio', label: 'Personio' },
  { value: 'bamboohr', label: 'BambooHR' },
  { value: 'workday', label: 'Workday' },
  { value: 'remoteok', label: 'RemoteOK' },
  { value: 'arbeitnow', label: 'Arbeitnow' },
  { value: 'himalayas', label: 'Himalayas' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'google_jobs', label: 'Google Jobs' },
  { value: 'jobicy', label: 'Jobicy' },
  { value: 'themuse', label: 'The Muse' },
  { value: 'smartrecruiters_search', label: 'SmartRecruiters (search)' },
  { value: 'workingnomads', label: 'Working Nomads' },
  { value: 'weworkremotely', label: 'We Work Remotely' },
  { value: 'remotive', label: 'Remotive' },
  { value: 'jobtech', label: 'JobTech (Sweden)' },
  { value: 'hn_hiring', label: 'HN Who is hiring' },
  { value: 'breezy', label: 'Breezy HR' },
  { value: 'rippling', label: 'Rippling' },
  { value: 'teamtailor', label: 'Teamtailor' },
];

/** Text filter over title and company, debounced; `/` focuses it from anywhere on the page. */
export function SearchField({ q, onQ }: { q: string; onQ: (v: string) => void }) {
  const [val, setVal] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { setVal(q); }, [q]);
  const handle = (v: string) => {
    setVal(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onQ(v), 250);
  };
  return (
    <div className="job-search">
      <Search size={15} className="job-search-icon" />
      <input
        aria-label="Filter jobs by title or company"
        placeholder="Filter by role or company"
        value={val}
        onChange={e => handle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { (e.target as HTMLInputElement).blur(); } }}
      />
      {val
        ? <button aria-label="Clear filter" onClick={() => { setVal(''); onQ(''); }}><X size={13} /></button>
        : <Kbd style={{ position: 'absolute', right: 10, pointerEvents: 'none' }}>/</Kbd>}
    </div>
  );
}

/**
 * The triage funnel as section tabs with an amber tick under the active one.
 * Triage states carry their count; All/New don't (they're most of the table and
 * the number says nothing).
 */
export function StatusTabs({ status, counts, onStatus }: {
  status: string; counts: Partial<Record<JobStatus, number>>; onStatus: (v: string) => void;
}) {
  return (
    <nav className="status-tabs" aria-label="Filter by status">
      {STATUS_TABS.map(tab => {
        const n = tab.value && tab.value !== 'new' ? counts[tab.value] : undefined;
        return (
          <button key={tab.value} onClick={() => onStatus(tab.value)} className={status === tab.value ? 'stab active' : 'stab'} aria-current={status === tab.value ? 'page' : undefined}>
            {tab.label}
            {n ? <span className="stab-n tnum">{n.toLocaleString()}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}

// All secondary filters collapse behind one control (progressive disclosure), so
// the always-visible bar stays calm. Badge shows how many are active.
export function RefineControl({
  fit, remote, l1, l2, sourceTypes, onFit, onRemote, onL1, onL2, onToggleSource, onClearAll,
}: {
  fit: boolean; remote: boolean; l1: boolean; l2: boolean; sourceTypes: string[];
  onFit: (v: boolean) => void; onRemote: (v: boolean) => void; onL1: (v: boolean) => void;
  onL2: (v: boolean) => void; onToggleSource: (v: string) => void; onClearAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const count = [fit, remote, l1, l2].filter(Boolean).length + sourceTypes.length;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const row = (label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string) => (
    <label className="refine-row">
      <span>
        <span style={{ color: checked ? 'var(--text)' : 'var(--text-muted)' }}>{label}</span>
        {hint && <span className="refine-hint">{hint}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </label>
  );

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)} className="refine-btn" aria-expanded={open} data-active={count > 0}>
        <SlidersHorizontal size={14} />
        Refine
        {count > 0 && <span className="refine-badge">{count}</span>}
      </button>

      {open && (
        <div className="refine-pop" role="dialog" aria-label="Refine results">
          <div className="refine-sec-label">Match</div>
          {row('Fit only', fit, onFit, 'Claude called it a match')}
          {row('Passed filters', l1, onL1, 'Title, location, salary rules')}
          {row('Scored', l2, onL2, 'Has a Claude verdict')}
          <div className="refine-divider" />
          <div className="refine-sec-label">Location</div>
          {row('Remote only', remote, onRemote)}
          <div className="refine-divider" />
          <div className="refine-sec-label">Source</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {SOURCE_TYPE_OPTIONS.map(o => {
              const active = o.value === '' ? sourceTypes.length === 0 : sourceTypes.includes(o.value);
              return (
                <button key={o.value} onClick={() => onToggleSource(o.value)} className={active ? 'src-chip active' : 'src-chip'}>
                  {active && o.value !== '' && <Check size={11} style={{ marginRight: 3, verticalAlign: '-1px' }} />}
                  {o.label}
                </button>
              );
            })}
          </div>
          {count > 0 && (
            <button onClick={onClearAll} className="refine-clear">Clear all filters</button>
          )}
        </div>
      )}
    </div>
  );
}
