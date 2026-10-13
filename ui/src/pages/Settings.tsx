import {
  useState, useEffect, useCallback, useRef,
  type ReactNode, type CSSProperties, type Dispatch, type SetStateAction,
} from 'react';
import {
  CheckCircle2, XCircle, Circle, Trash2, Plus,
  RefreshCw, ChevronDown, ChevronRight, Search as SearchIcon, FileUp,
} from 'lucide-react';
import {
  api, type Source, type SourceType, type HealthCheck, type ResumeSettings,
  type EmbeddingSettings, type FreshnessSettings, type L2CapSettings, type BoardCacheSettings, type BoardRefreshStatus, type Calibration, type TasteStats,
} from '@/lib/api';
import { Button, Input, Badge, Spinner, Textarea, useToast } from '@/components/ui';

type BadgeTone = 'neutral' | 'accent' | 'blue' | 'violet' | 'success' | 'warning' | 'danger' | 'dim';

const SOURCE_TYPE_OPTIONS: { value: SourceType; label: string; placeholder: string; gated?: boolean }[] = [
  { value: 'greenhouse', label: 'Greenhouse', placeholder: 'board-slug (e.g. stripe)' },
  { value: 'ashby', label: 'Ashby', placeholder: 'jobs.ashbyhq.com/company' },
  { value: 'lever', label: 'Lever', placeholder: 'jobs.lever.co/company' },
  { value: 'recruitee', label: 'Recruitee', placeholder: 'tenant slug (e.g. acme → acme.recruitee.com)' },
  { value: 'smartrecruiters', label: 'SmartRecruiters', placeholder: 'company slug (e.g. Bosch)' },
  { value: 'workable', label: 'Workable', placeholder: 'account slug (apply.workable.com/slug)' },
  { value: 'personio', label: 'Personio', placeholder: 'tenant slug (e.g. acme → acme.jobs.personio.de)' },
  { value: 'bamboohr', label: 'BambooHR', placeholder: 'subdomain slug (e.g. acme → acme.bamboohr.com)' },
  { value: 'workday', label: 'Workday', placeholder: 'tenant slug (e.g. salesforce)' },
  { value: 'breezy', label: 'Breezy HR', placeholder: 'subdomain slug (e.g. acme → acme.breezy.hr)' },
  { value: 'rippling', label: 'Rippling', placeholder: 'board slug (ats.rippling.com/slug)' },
  { value: 'teamtailor', label: 'Teamtailor', placeholder: 'subdomain slug (e.g. acme → acme.teamtailor.com)' },
  { value: 'remoteok', label: 'RemoteOK', placeholder: 'global — searched by your role keyword' },
  { value: 'arbeitnow', label: 'Arbeitnow', placeholder: 'global — searched by your role keyword' },
  { value: 'himalayas', label: 'Himalayas', placeholder: 'global — searched by your role keyword' },
  { value: 'linkedin', label: 'LinkedIn', placeholder: 'global — searched by your role keyword', gated: true },
  { value: 'google_jobs', label: 'Google Jobs', placeholder: 'global — needs a SerpAPI key' },
  { value: 'jobicy', label: 'Jobicy', placeholder: 'global — searched by your role keyword' },
  { value: 'themuse', label: 'The Muse', placeholder: 'global — searched by your role keyword' },
  { value: 'smartrecruiters_search', label: 'SmartRecruiters (search)', placeholder: 'global — searched by your role keyword' },
  { value: 'workingnomads', label: 'Working Nomads', placeholder: 'global — searched by your role keyword' },
  { value: 'weworkremotely', label: 'We Work Remotely', placeholder: 'global — searched by your role keyword' },
  { value: 'remotive', label: 'Remotive', placeholder: 'global — searched by your role keyword (max ~4 calls/day)' },
  { value: 'jobtech', label: 'JobTech (Sweden)', placeholder: 'global — Swedish postings, searched by your role keyword' },
  { value: 'hn_hiring', label: 'HN Who is hiring', placeholder: 'global — monthly Hacker News threads, matched on your role keyword' },
];

const TYPE_TONE: Record<SourceType, BadgeTone> = {
  greenhouse: 'success', ashby: 'blue', lever: 'warning', recruitee: 'violet',
  smartrecruiters: 'danger', workable: 'neutral', personio: 'neutral',
  bamboohr: 'success', workday: 'blue',
  breezy: 'violet', rippling: 'warning', teamtailor: 'blue',
  remoteok: 'accent', arbeitnow: 'accent', himalayas: 'accent', linkedin: 'warning',
  google_jobs: 'blue', jobicy: 'accent',
  themuse: 'accent', smartrecruiters_search: 'danger', workingnomads: 'accent',
  weworkremotely: 'accent', remotive: 'accent',
  jobtech: 'accent', hn_hiring: 'accent',
};

const GATED_TYPES = new Set<SourceType>(
  SOURCE_TYPE_OPTIONS.filter(o => o.gated).map(o => o.value),
);

// Badge tone → concrete color, for the composition bar + legend (mirrors the
// badge colors used on the roster rows so the encodings agree).
const TONE_COLOR: Record<BadgeTone, string> = {
  neutral: 'var(--text-muted)', accent: 'var(--accent-text)', blue: 'var(--tone-blue)',
  violet: 'var(--tone-violet)', success: 'var(--success)', warning: 'var(--warning)',
  danger: 'var(--danger)', dim: 'var(--text-faint)',
};

function timeAgo(ts: number | null): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function SectionHeading({ title, desc, action }: { title: ReactNode; desc: string; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 'var(--space-md)' }}>
      <div>
        <h2 style={{ margin: '0 0 4px', fontSize: '17px', fontWeight: 580, color: 'var(--text)' }}>{title}</h2>
        <p style={{ margin: 0, fontSize: '13.5px', color: 'var(--text-muted)' }}>{desc}</p>
      </div>
      {action}
    </div>
  );
}

function Disclosure({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '12.5px', fontFamily: 'inherit', padding: 0 }}>
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      {label}
    </button>
  );
}

function SourceRow({ source, onToggle, onDelete }: { source: Source; onToggle: () => void; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const enabled = source.enabled === 1;
  const typeOpt = SOURCE_TYPE_OPTIONS.find(t => t.value === source.type);

  const statusIcon = !source.last_scan_at
    ? <Circle size={8} style={{ color: 'var(--text-faint)' }} />
    : source.last_status === 'ok'
    ? <CheckCircle2 size={8} style={{ color: 'var(--success)' }} />
    : source.last_status === 'rate-limited'
    ? <Circle size={8} style={{ color: 'var(--warning)' }} />
    : <XCircle size={8} style={{ color: 'var(--danger)' }} />;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 96px 64px 40px', alignItems: 'center', gap: 14, padding: '9px 14px', borderBottom: '1px solid var(--border-subtle)', opacity: enabled ? 1 : 0.5, transition: 'opacity 150ms ease' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.display_name}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-faint)', marginTop: 2, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.identifier}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <Badge tone={TYPE_TONE[source.type] ?? 'neutral'}>{typeOpt?.label ?? source.type}</Badge>
        {GATED_TYPES.has(source.type) && (
          <span title="Unofficial endpoint — gray-area, rate-limited, may break" style={{ fontSize: '9.5px', color: 'var(--warning)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            unofficial
          </span>
        )}
      </div>
      <div
        title={source.last_status === 'ok' || !source.last_scan_at
          ? undefined
          : source.last_status === 'rate-limited'
          ? `Rate-limited by the host ${timeAgo(source.last_scan_at)} - will retry in the background`
          : `Last attempt ${timeAgo(source.last_scan_at)} failed${source.last_error ? `: ${source.last_error}` : ''}`}
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '11px', color: 'var(--text-faint)' }}
      >
        {/* The age is of the last good fetch (what the board cache serves), the icon is the latest attempt. */}
        {statusIcon}{timeAgo(source.last_ok_fetch_at)}
      </div>
      <button onClick={onToggle} style={{ background: enabled ? 'var(--accent-muted)' : 'var(--surface-2)', color: enabled ? 'var(--accent-text)' : 'var(--text-faint)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 150ms ease' }}>
        {enabled ? 'On' : 'Off'}
      </button>
      {confirming ? (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <button onClick={() => { onDelete(); setConfirming(false); }} style={{ fontSize: '11px', color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}>Yes</button>
          <button onClick={() => setConfirming(false)} style={{ fontSize: '11px', color: 'var(--text-faint)', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}>No</button>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={() => setConfirming(true)} aria-label={`Delete ${source.display_name}`} className="del-btn" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: 4, display: 'flex' }}>
            <Trash2 size={13} />
            <style>{`.del-btn:hover{color:var(--danger)!important;}`}</style>
          </button>
        </div>
      )}
    </div>
  );
}

function AddSourceForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<SourceType>('greenhouse');
  const [identifier, setIdentifier] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [wdSite, setWdSite] = useState('');
  const [wdDc, setWdDc] = useState('');
  const [serpKey, setSerpKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typeOpt = SOURCE_TYPE_OPTIONS.find(t => t.value === type)!;
  const isWorkday = type === 'workday';
  const isGoogleJobs = type === 'google_jobs';
  const isGated = GATED_TYPES.has(type);
  const workdayReady = !isWorkday || (wdSite.trim() && wdDc.trim());
  const googleReady = !isGoogleJobs || !!serpKey.trim();

  const handleAdd = async () => {
    if (!identifier.trim() || !displayName.trim() || !workdayReady || !googleReady) return;
    setSaving(true); setError(null);
    try {
      const config_json = isWorkday
        ? { site: wdSite.trim(), dc: wdDc.trim() }
        : isGoogleJobs
          ? { apiKey: serpKey.trim() }
          : undefined;
      await api.sources.create({ type, identifier: identifier.trim(), display_name: displayName.trim(), config_json });
      setIdentifier(''); setDisplayName(''); setWdSite(''); setWdDc(''); setSerpKey(''); setOpen(false); onAdded();
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  };

  if (!open) {
    return (
      <div style={{ marginTop: 'var(--space-sm)' }}>
        <Disclosure label="Add a source manually" open={false} onToggle={() => setOpen(true)} />
      </div>
    );
  }

  return (
    <div style={{ padding: 14, background: 'var(--surface-2)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: 12, marginTop: 'var(--space-sm)', animation: 'fadeIn 150ms ease' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr 1fr', gap: 10, alignItems: 'end' }}>
        <div>
          <label htmlFor="add-src-type" style={{ display: 'block', fontSize: '11px', color: 'var(--text-faint)', marginBottom: 4 }}>Type</label>
          <select id="add-src-type" value={type} onChange={e => setType(e.target.value as SourceType)} style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontFamily: 'inherit', fontSize: '12.5px', padding: '7px 8px', outline: 'none' }}>
            {SOURCE_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="add-src-id" style={{ display: 'block', fontSize: '11px', color: 'var(--text-faint)', marginBottom: 4 }}>Identifier</label>
          <Input id="add-src-id" value={identifier} onChange={e => setIdentifier(e.target.value)} placeholder={typeOpt.placeholder} style={{ fontSize: '12.5px', height: 32 }} />
        </div>
        <div>
          <label htmlFor="add-src-name" style={{ display: 'block', fontSize: '11px', color: 'var(--text-faint)', marginBottom: 4 }}>Display name</label>
          <Input id="add-src-name" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Company name" style={{ fontSize: '12.5px', height: 32 }} onKeyDown={e => e.key === 'Enter' && handleAdd()} />
        </div>
      </div>
      {isWorkday && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 10, alignItems: 'end' }}>
          <div>
            <label htmlFor="add-src-wdsite" style={{ display: 'block', fontSize: '11px', color: 'var(--text-faint)', marginBottom: 4 }}>Career-site name</label>
            <Input id="add-src-wdsite" value={wdSite} onChange={e => setWdSite(e.target.value)} placeholder="e.g. External_Career_Site" style={{ fontSize: '12.5px', height: 32 }} />
          </div>
          <div>
            <label htmlFor="add-src-wddc" style={{ display: 'block', fontSize: '11px', color: 'var(--text-faint)', marginBottom: 4 }}>Datacenter</label>
            <Input id="add-src-wddc" value={wdDc} onChange={e => setWdDc(e.target.value)} placeholder="e.g. wd5" style={{ fontSize: '12.5px', height: 32 }} />
          </div>
        </div>
      )}
      {isWorkday && (
        <div style={{ fontSize: '11.5px', color: 'var(--text-faint)' }}>
          From the careers URL <span style={{ fontFamily: 'var(--font-mono)' }}>{'{tenant}.{dc}.myworkdayjobs.com/{site}'}</span> — e.g.
          {' '}<span style={{ fontFamily: 'var(--font-mono)' }}>salesforce</span> · <span style={{ fontFamily: 'var(--font-mono)' }}>wd12</span> · <span style={{ fontFamily: 'var(--font-mono)' }}>External_Career_Site</span>.
        </div>
      )}
      {isGoogleJobs && (
        <div>
          <label htmlFor="add-src-serpkey" style={{ display: 'block', fontSize: '11px', color: 'var(--text-faint)', marginBottom: 4 }}>SerpAPI key</label>
          <Input id="add-src-serpkey" type="password" value={serpKey} onChange={e => setSerpKey(e.target.value)} placeholder="your SerpAPI api_key" style={{ fontSize: '12.5px', height: 32 }} />
          <div style={{ fontSize: '11.5px', color: 'var(--text-faint)', marginTop: 6 }}>
            Google's deduplicated cross-board job index. Your key is stored locally and sent only to serpapi.com.
          </div>
        </div>
      )}
      {isGated && (
        <div style={{ fontSize: '11.5px', color: 'var(--warning)' }}>
          Unofficial endpoint — gray-area, aggressively rate-limited, and may break without notice.
          Use lightly for personal search.
        </div>
      )}
      {error && <div style={{ fontSize: '12px', color: 'var(--danger)' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" onClick={handleAdd} loading={saving} disabled={!identifier.trim() || !displayName.trim() || !workdayReady || !googleReady}><Plus size={13} /> Add</Button>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setError(null); }}>Cancel</Button>
      </div>
    </div>
  );
}

// The shape of the field Lantern watches: one quiet stacked bar showing how the
// roster splits across source types, colored to match the roster's type badges.
function CompositionBar({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return null;
  const groups = SOURCE_TYPE_OPTIONS
    .map(o => ({ label: o.label, color: TONE_COLOR[TYPE_TONE[o.value]], n: sources.filter(s => s.type === o.value).length }))
    .filter(g => g.n > 0);
  return (
    <div style={{ margin: '0 0 var(--space-md)' }}>
      <div style={{ display: 'flex', gap: 2, height: 6, borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
        {groups.map(g => (
          <div key={g.label} title={`${g.label} · ${g.n}`} style={{ flex: g.n, minWidth: 3, background: g.color, opacity: 0.7, borderRadius: 2 }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 8 }}>
        {groups.map(g => (
          <span key={g.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '11px', color: 'var(--text-faint)' }}>
            <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: g.color, opacity: 0.7 }} />
            {g.label} <span className="tnum" style={{ fontFamily: 'var(--font-mono)' }}>{g.n}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// Boards found by scripts/discover-boards.ts: live-checked but unreviewed, and far
// too many to list, so they are one bulk switch rather than roster rows.
function DiscoveredBoards() {
  const toast = useToast();
  const [counts, setCounts] = useState<{ total: number; enabled: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.sources.discovered().then(setCounts).catch(e => console.error('discovered boards count failed', e));
  }, []);

  if (!counts || counts.total === 0) return null;
  const on = counts.enabled > 0;

  const toggle = async () => {
    setBusy(true);
    try {
      const res = await api.sources.setDiscovered(!on);
      setCounts({ total: res.total, enabled: res.enabled });
    } catch (e) {
      toast(`Could not update discovered boards: ${String(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, padding: '12px 14px', margin: '0 0 var(--space-md)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)' }}>
          Include discovered boards <span className="tnum" style={{ color: 'var(--text-faint)', fontWeight: 400 }}>({counts.total.toLocaleString()})</span>
        </div>
        <div style={{ fontSize: '11.5px', color: 'var(--text-faint)', marginTop: 3, lineHeight: 1.5, maxWidth: 520 }}>
          Company boards found through public web crawls and checked live, but not hand-picked. Turning them on starts warming them in the background, a few at a time: the first full pass over all {counts.total.toLocaleString()} takes one to three hours depending on your connection (about 100 minutes in testing). A search that starts sooner fetches whatever is not warm yet, so the first one can be slow. Once warm, searches reuse the stored jobs within the board cache window. With these on, the background refresher re-downloads all of them roughly every cache window (6 hours by default), a lot of traffic: raise the board cache hours below if that is more than you want.
        </div>
      </div>
      <button onClick={toggle} disabled={busy} aria-pressed={on} style={{ background: on ? 'var(--accent-muted)' : 'var(--surface-2)', color: on ? 'var(--accent-text)' : 'var(--text-faint)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontSize: '12px', fontWeight: 500, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit', transition: 'all 150ms ease', flexShrink: 0 }}>
        {on ? 'On' : 'Off'}
      </button>
    </div>
  );
}

function SourcesSection({ sources, loading, setSources, reload }: {
  sources: Source[]; loading: boolean;
  setSources: Dispatch<SetStateAction<Source[]>>; reload: () => void;
}) {
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(false);

  const handleToggle = async (source: Source) => {
    const newEnabled = source.enabled !== 1;
    setSources(prev => prev.map(s => s.id === source.id ? { ...s, enabled: newEnabled ? 1 : 0 } : s));
    await api.sources.update(source.id, { enabled: newEnabled }).catch(() => reload());
  };

  // Seeded sources (or ones with saved jobs) can't be hard-deleted — the server
  // turns them off instead and says so. Wait for the real outcome rather than
  // optimistically removing the row: a "disabled" response must leave the row
  // in place (just switched off), and a genuine error must surface, not
  // silently self-heal via reload (which used to mask a 500 as a UI glitch).
  const handleDelete = async (id: number) => {
    try {
      const res = await api.sources.delete(id);
      if ('deleted' in res && res.deleted) {
        setSources(prev => prev.filter(s => s.id !== id));
      } else if ('disabled' in res && res.disabled) {
        setSources(prev => prev.map(s => s.id === id ? { ...s, enabled: 0 } : s));
        toast(res.msg, 'info');
      }
    } catch (e) {
      toast(`Could not delete: ${String(e)}`, 'error');
    }
  };

  const f = filter.trim().toLowerCase();
  const filtered = f ? sources.filter(s => s.display_name.toLowerCase().includes(f) || s.identifier.toLowerCase().includes(f) || s.type.includes(f)) : sources;
  const enabledCount = sources.filter(s => s.enabled === 1).length;

  const grouped = SOURCE_TYPE_OPTIONS
    .map(opt => ({ ...opt, sources: filtered.filter(s => s.type === opt.value) }))
    .filter(g => g.sources.length > 0);

  const canExpand = sources.length > 0;

  return (
    <div>
      <SectionHeading
        title="Sources"
        desc={sources.length === 0
          ? 'The default set of boards and aggregators loads on your first search.'
          : `${sources.length} boards and aggregators · ${enabledCount === sources.length ? 'all enabled' : `${enabledCount} enabled`}.`}
        action={
          canExpand ? (
            <button className="manage-link" onClick={() => setExpanded(e => !e)} aria-expanded={expanded}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {expanded ? 'Hide roster' : 'Manage roster'}
              <style>{`
                .manage-link { display: inline-flex; align-items: center; gap: 6px; padding: 6px 4px; background: none; border: none;
                  cursor: pointer; font-family: var(--font-ui); font-size: 13px; font-weight: 500; color: var(--text-muted);
                  transition: color 150ms ease; white-space: nowrap; }
                .manage-link:hover { color: var(--text); }
                .manage-link[aria-expanded="true"] { color: var(--accent-text); }
              `}</style>
            </button>
          ) : undefined
        }
      />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
      ) : (
        <>
          <CompositionBar sources={sources} />
          <DiscoveredBoards />
          {expanded && canExpand && (
            <div style={{ animation: 'fadeIn 150ms ease' }}>
              <div style={{ position: 'relative', marginBottom: 'var(--space-sm)' }}>
                <SearchIcon size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)', pointerEvents: 'none' }} />
                <Input placeholder="Filter sources…" value={filter} onChange={e => setFilter(e.target.value)} style={{ paddingLeft: 30, height: 34, fontSize: '12.5px' }} />
              </div>
              {/* contained scroll so a long roster never stretches the page */}
              <div style={{ maxHeight: 420, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
                {grouped.length === 0 ? (
                  <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-faint)', fontSize: '13px' }}>
                    No sources match your filter.
                  </div>
                ) : (
                  grouped.map(group => (
                    <div key={group.value}>
                      <div style={{ position: 'sticky', top: 0, zIndex: 1, display: 'flex', justifyContent: 'space-between', padding: '7px 14px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border-subtle)' }}>
                        <span style={{ fontSize: '10.5px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{group.label}</span>
                        <span className="tnum" style={{ fontSize: '11px', color: 'var(--text-faint)' }}>{group.sources.length}</span>
                      </div>
                      {group.sources.map(source => (
                        <SourceRow key={source.id} source={source} onToggle={() => handleToggle(source)} onDelete={() => handleDelete(source.id)} />
                      ))}
                    </div>
                  ))
                )}
              </div>
              <AddSourceForm onAdded={reload} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Master resume for triage scoring. One form, one Save: the toggle and the
// text are a single settings object, so they save together (a toggle that
// applies instantly while the text waits on Save would race itself).
function ResumeSection() {
  const toast = useToast();
  const [saved, setSaved] = useState<ResumeSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.resume.get().then(res => {
      setSaved(res.settings);
      setEnabled(res.settings.enabled);
      setText(res.settings.text);
    }).catch(() => setSaved({ enabled: false, text: '' }));
  }, []);

  const dirty = saved !== null && (enabled !== saved.enabled || text !== saved.text);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.resume.save({ enabled, text });
      setSaved(res.settings);
      toast(enabled
        ? 'Resume saved — current scores are cleared and re-graded (with background fit) on your next search.'
        : 'Resume saved — current scores are cleared and re-graded on your next search.', 'success');
    } catch (e) {
      toast(`Could not save: ${String(e)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handlePdf = async (file: File) => {
    setExtracting(true);
    try {
      const { text: extracted } = await api.resume.extract(file);
      setText(extracted);
      toast('Text extracted — review it below, then save.', 'success');
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
    } finally {
      setExtracting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  if (saved === null) {
    return (
      <div>
        <SectionHeading title="Resume" desc="Score each match against your background." />
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
      </div>
    );
  }

  return (
    <div>
      <SectionHeading
        title="Resume"
        desc="Optionally grade every match against your background — adds a fit sub-score and gap list alongside the criteria score. Stays on this machine."
        action={
          <button onClick={() => setEnabled(v => !v)} aria-pressed={enabled} style={{ background: enabled ? 'var(--accent-muted)' : 'var(--surface-2)', color: enabled ? 'var(--accent-text)' : 'var(--text-faint)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '5px 12px', fontSize: '12.5px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 150ms ease', whiteSpace: 'nowrap' }}>
            {enabled ? 'On' : 'Off'}
          </button>
        }
      />
      <Textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Paste your resume as plain text, or import a PDF below…"
        rows={9}
        maxLength={50000}
        aria-label="Resume text"
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) handlePdf(f); }}
        />
        <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()} loading={extracting}>
          <FileUp size={13} /> Import from PDF
        </Button>
        <span style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
          The PDF isn't stored — only the text you save.
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {dirty && <span style={{ fontSize: '11.5px', color: 'var(--warning)' }}>Unsaved changes</span>}
          <Button size="sm" onClick={handleSave} loading={saving} disabled={!dirty}>Save</Button>
        </div>
      </div>
    </div>
  );
}

function FreshnessSection() {
  const toast = useToast();
  const [saved, setSaved] = useState<FreshnessSettings | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [days, setDays] = useState(7);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.freshness.get().then(res => {
      setSaved(res.settings);
      setEnabled(res.settings.enabled);
      setDays(res.settings.maxAgeDays);
    }).catch(() => setSaved({ enabled: true, maxAgeDays: 7 }));
  }, []);

  const clampedDays = Math.min(365, Math.max(1, Math.floor(days) || 7));
  const dirty = saved !== null && (enabled !== saved.enabled || clampedDays !== saved.maxAgeDays);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.freshness.save({ enabled, maxAgeDays: clampedDays });
      setSaved(res.settings);
      setDays(res.settings.maxAgeDays);
      toast(enabled
        ? `Freshness on — dropping dated jobs older than ${clampedDays} days before grading.`
        : 'Freshness off.', 'success');
    } catch (e) {
      toast(`Could not save: ${String(e)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (saved === null) {
    return (
      <div>
        <SectionHeading title="Freshness" desc="Skip stale postings before grading." />
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
      </div>
    );
  }

  return (
    <div>
      <SectionHeading
        title="Freshness"
        desc="Drop jobs whose posted date is older than your window before L2 grades them — cuts grading cost and surfaces fresh roles. Jobs with no posted date always pass through."
        action={
          <button onClick={() => setEnabled(v => !v)} aria-pressed={enabled} style={{ background: enabled ? 'var(--accent-muted)' : 'var(--surface-2)', color: enabled ? 'var(--accent-text)' : 'var(--text-faint)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '5px 12px', fontSize: '12.5px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 150ms ease', whiteSpace: 'nowrap' }}>
            {enabled ? 'On' : 'Off'}
          </button>
        }
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <label htmlFor="freshness-days" style={{ fontSize: '12.5px', color: enabled ? 'var(--text)' : 'var(--text-faint)' }}>Max age</label>
        <Input id="freshness-days" type="number" min={1} max={365} value={String(days)} disabled={!enabled} onChange={e => setDays(Number(e.target.value))} style={{ width: 72, fontSize: '12.5px', height: 32 }} />
        <span style={{ fontSize: '12.5px', color: 'var(--text-faint)' }}>days</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {dirty && <span style={{ fontSize: '11.5px', color: 'var(--warning)' }}>Unsaved changes</span>}
          <Button size="sm" onClick={handleSave} loading={saving} disabled={!dirty}>Save</Button>
        </div>
      </div>
    </div>
  );
}

// Bounds one search's grading bill: only the best-ranked N survivors go to Claude,
// the rest wait for a repeat search of the same query.
function GradingLimitSection() {
  const toast = useToast();
  const [saved, setSaved] = useState<L2CapSettings | null>(null);
  const [max, setMax] = useState(300);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.l2Cap.get().then(res => {
      setSaved(res.settings);
      setMax(res.settings.maxJobs);
    }).catch(() => setSaved({ maxJobs: 300 }));
  }, []);

  const clamped = Math.min(5000, Math.max(20, Math.floor(max) || 300));
  const dirty = saved !== null && clamped !== saved.maxJobs;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.l2Cap.save({ maxJobs: clamped });
      setSaved(res.settings);
      setMax(res.settings.maxJobs);
      toast(`Grading up to ${clamped} jobs per search.`, 'success');
    } catch (e) {
      toast(`Could not save: ${String(e)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (saved === null) return null;

  return (
    <div>
      <SectionHeading
        title="Grading limit"
        desc="Most jobs one search sends to Claude. With semantic ranking on, the best matches go first. Anything beyond the limit waits: search the same query again to grade the next batch."
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <label htmlFor="l2-cap" style={{ fontSize: '12.5px', color: 'var(--text)' }}>Up to</label>
        <Input id="l2-cap" type="number" min={20} max={5000} step={20} value={String(max)} onChange={e => setMax(Number(e.target.value))} style={{ width: 84, fontSize: '12.5px', height: 32 }} />
        <span style={{ fontSize: '12.5px', color: 'var(--text-faint)' }}>jobs per search</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {dirty && <span style={{ fontSize: '11.5px', color: 'var(--warning)' }}>Unsaved changes</span>}
          <Button size="sm" onClick={handleSave} loading={saving} disabled={!dirty}>Save</Button>
        </div>
      </div>
    </div>
  );
}

// Company boards return their whole listing whatever you search, so a board fetched
// recently is checked against the new search from its stored jobs instead of fetched again.
function BoardCacheSection() {
  const toast = useToast();
  const [saved, setSaved] = useState<BoardCacheSettings | null>(null);
  const [hours, setHours] = useState(6);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.boardCache.get().then(res => {
      setSaved(res.settings);
      setHours(res.settings.ttlHours);
    }).catch(() => setSaved({ ttlHours: 6 }));
  }, []);

  const clamped = Math.min(168, Math.max(0, Math.floor(hours) || 0));
  const dirty = saved !== null && clamped !== saved.ttlHours;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.boardCache.save({ ttlHours: clamped });
      setSaved(res.settings);
      setHours(res.settings.ttlHours);
      toast(clamped === 0 ? 'Board cache off. Every scan fetches each board.' : `Reusing boards fetched in the last ${clamped} hours.`, 'success');
    } catch (e) {
      toast(`Could not save: ${String(e)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (saved === null) return null;

  return (
    <div>
      <SectionHeading
        title="Board cache"
        desc="Company boards return every job whatever you search. A board fetched within this window is checked against your search from its stored jobs instead of being fetched again. Keyword aggregators are always fetched."
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <label htmlFor="board-cache-ttl" style={{ fontSize: '12.5px', color: 'var(--text)' }}>Reuse for</label>
        <Input id="board-cache-ttl" type="number" min={0} max={168} value={String(hours)} onChange={e => setHours(Number(e.target.value))} style={{ width: 72, fontSize: '12.5px', height: 32 }} />
        <span style={{ fontSize: '12.5px', color: 'var(--text-faint)' }}>hours (0 fetches every board on every scan)</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {dirty && <span style={{ fontSize: '11.5px', color: 'var(--warning)' }}>Unsaved changes</span>}
          <Button size="sm" onClick={handleSave} loading={saving} disabled={!dirty}>Save</Button>
        </div>
      </div>
    </div>
  );
}

function inFuture(ts: number | null): string {
  if (!ts) return 'soon';
  const diff = ts - Date.now();
  if (diff < 60000) return 'in under a minute';
  if (diff < 3600000) return `in ${Math.round(diff / 60000)}m`;
  return `in ${Math.round(diff / 3600000)}h`;
}

const IDLE_NOTES: Record<NonNullable<BoardRefreshStatus['idleReason']>, string> = {
  off: 'Off.',
  'cache-off': 'Paused: the board cache is off.',
  'scan-running': 'Paused while a search runs.',
  'nothing-stale': 'Nothing to refresh right now.',
  busy: 'Working.',
};

// "All fresh" only when the counts say so: stale boards that are not being retried are either
// waiting out an error backoff or on a host resting after rate limits.
function nothingToRefresh(status: BoardRefreshStatus): string {
  const { stale, backedOff } = status.boards;
  if (stale === 0) return 'All boards are fresh.';
  const reasons = [
    backedOff > 0 && `${backedOff.toLocaleString()} waiting to retry after errors`,
    status.restingHosts.length > 0 && `${status.restingHosts.join(', ')} resting after rate limits`,
  ].filter(Boolean);
  return reasons.length > 0 ? `No board is due: ${reasons.join(', ')}.` : 'No board is due yet.';
}

// Keeps company boards inside the cache window between searches, so a search is served from
// stored jobs instead of fetching hundreds or thousands of boards itself. It yields to any search.
function BoardRefreshSection() {
  const toast = useToast();
  const [status, setStatus] = useState<BoardRefreshStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => api.boardRefresh.get().then(res => { if (live) setStatus(res.status); }).catch(e => console.error('board refresh status failed', e));
    load();
    const timer = setInterval(load, 5000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  if (status === null) return null;
  const on = status.enabled;

  const toggle = async () => {
    setBusy(true);
    try {
      const res = await api.boardRefresh.save(!on);
      setStatus(res.status);
    } catch (e) {
      toast(`Could not update: ${String(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const { boards } = status;
  const state = !on
    ? IDLE_NOTES.off
    : status.refreshing.length > 0
      ? `Refreshing ${status.refreshing.slice(0, 2).join(', ')}${status.refreshing.length > 2 ? ` and ${status.refreshing.length - 2} more` : ''}.`
      : status.idleReason === 'nothing-stale' ? nothingToRefresh(status) : status.idleReason ? IDLE_NOTES[status.idleReason] : 'Waiting for the next pass.';

  return (
    <div>
      <SectionHeading
        title="Keep boards fresh in background"
        desc="Re-fetches company boards before the board cache window runs out, a few at a time and never while a search is running, so your next search is served from stored jobs."
        action={
          <button onClick={toggle} disabled={busy} aria-pressed={on} style={{ background: on ? 'var(--accent-muted)' : 'var(--surface-2)', color: on ? 'var(--accent-text)' : 'var(--text-faint)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontSize: '12px', fontWeight: 500, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit', transition: 'all 150ms ease', flexShrink: 0 }}>
            {on ? 'On' : 'Off'}
          </button>
        }
      />
      <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', lineHeight: 1.7 }}>
        <div>
          <span className="tnum" style={{ color: 'var(--text)' }}>{boards.fresh.toLocaleString()}</span> fresh
          {' · '}<span className="tnum" style={{ color: 'var(--text)' }}>{boards.stale.toLocaleString()}</span> stale
          {boards.backedOff > 0 && <>{' · '}<span className="tnum">{boards.backedOff.toLocaleString()}</span> waiting after errors</>}
          <span style={{ color: 'var(--text-faint)' }}> of {boards.total.toLocaleString()} enabled boards</span>
        </div>
        <div style={{ color: 'var(--text-faint)' }}>
          {state}
          {on && status.lastTickAt && <> Last pass {timeAgo(status.lastTickAt)}{status.lastTick ? `: ${status.lastTick.ok} refreshed${status.lastTick.failed > 0 ? `, ${status.lastTick.failed} failed` : ''}` : ''}.</>}
          {on && status.running && status.nextTickAt && <> Next pass {inFuture(status.nextTickAt)}.</>}
        </div>
        {status.lastError && (
          <div style={{ color: 'var(--text-faint)' }} title={status.lastError.error}>
            Last error {timeAgo(status.lastError.at)}: {status.lastError.board}, {status.lastError.error.slice(0, 90)}
          </div>
        )}
      </div>
    </div>
  );
}

function EmbeddingSection() {
  const toast = useToast();
  const [saved, setSaved] = useState<EmbeddingSettings | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.embeddings.get().then(res => {
      setSaved(res.settings);
      setEnabled(res.settings.enabled);
    }).catch(() => setSaved({ enabled: true }));
  }, []);

  const dirty = saved !== null && enabled !== saved.enabled;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.embeddings.save({ enabled });
      setSaved(res.settings);
      toast(enabled
        ? 'Semantic ranking on — the model downloads once on your next search.'
        : 'Semantic ranking off.', 'success');
    } catch (e) {
      toast(`Could not save: ${String(e)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (saved === null) {
    return (
      <div>
        <SectionHeading title="Semantic ranking" desc="Order the best matches first." />
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
      </div>
    );
  }

  return (
    <div>
      <SectionHeading
        title="Semantic ranking"
        desc="Use a small on-device model to order each search's survivors so the best matches are graded first. Runs locally — a ~25MB model downloads once. Turning this off skips the download entirely."
        action={
          <button onClick={() => setEnabled(v => !v)} aria-pressed={enabled} style={{ background: enabled ? 'var(--accent-muted)' : 'var(--surface-2)', color: enabled ? 'var(--accent-text)' : 'var(--text-faint)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '5px 12px', fontSize: '12.5px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 150ms ease', whiteSpace: 'nowrap' }}>
            {enabled ? 'On' : 'Off'}
          </button>
        }
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {dirty && <span style={{ fontSize: '11.5px', color: 'var(--warning)' }}>Unsaved changes</span>}
          <Button size="sm" onClick={handleSave} loading={saving} disabled={!dirty}>Save</Button>
        </div>
      </div>
    </div>
  );
}

function pct(score: number | null): string {
  return score == null ? '—' : String(Math.round(score * 100));
}

function TasteRow({ label, stats, flagLabel, flag }: { label: string; stats: TasteStats; flagLabel: string; flag: number }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 0.7fr 0.8fr 1.4fr', gap: 12, padding: '9px 0', borderTop: '1px solid var(--border-subtle)', fontSize: '13px', alignItems: 'baseline' }}>
      <span style={{ color: 'var(--text)' }}>{label}</span>
      <span className="tnum" style={{ color: 'var(--text-muted)' }}>{stats.triaged}</span>
      <span className="tnum" style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{pct(stats.mean_score)}</span>
      <span className="tnum" style={{ color: flag > 0 ? 'var(--warning)' : 'var(--text-faint)' }}>
        {stats.scored === 0 ? '—' : `${flag} of ${stats.scored} ${flagLabel}`}
      </span>
    </div>
  );
}

function TasteSection() {
  const [cal, setCal] = useState<Calibration | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.jobs.calibration().then(setCal).catch(e => {
      console.error('[settings] calibration failed', e);
      setFailed(true);
    });
  }, []);

  const head: CSSProperties = { fontSize: '10.5px', fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.08em' };
  const desc = 'Shortlisting, applying to or hiding jobs teaches lantern what you like. It reorders near-equal matches and the order jobs are graded in, and never decides which jobs pass. Below, how the grades line up with your decisions.';

  if (cal === null) {
    return (
      <div>
        <SectionHeading title="Learned taste" desc={desc} />
        {failed
          ? <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--danger)' }}>Could not load the calibration report.</p>
          : <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>}
      </div>
    );
  }

  const { preference } = cal;
  return (
    <div>
      <SectionHeading title="Learned taste" desc={desc} />
      <p style={{ margin: '0 0 10px', fontSize: '12.5px', color: preference.active ? 'var(--accent-text)' : 'var(--text-faint)' }}>
        {preference.active
          ? `Reordering results from ${preference.liked} liked${preference.disliked > 0 ? ` and ${preference.disliked} dismissed` : ''} jobs.`
          : 'Not active yet — shortlist at least three jobs from different companies (needs semantic ranking on).'}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 0.7fr 0.8fr 1.4fr', gap: 12, paddingBottom: 6 }}>
        <span style={head}>Your call</span><span style={head}>Jobs</span><span style={head}>Mean score</span><span style={head}>Grade vs call</span>
      </div>
      <TasteRow label="Shortlisted or further" stats={cal.liked} flagLabel="graded not a fit" flag={cal.liked.not_fit} />
      <TasteRow label="Hidden or rejected (not applied)" stats={cal.disliked} flagLabel="graded a fit" flag={cal.disliked.fit} />
    </div>
  );
}

const HEALTH_LABELS: Record<string, string> = { db: 'Database', llm: 'Claude Code' };
const HEALTH_FIX: Record<string, string> = {
  db: 'Check that data/ is writable.',
  llm: 'Ensure the claude CLI is installed and logged in.',
};

function HealthRow({ name, status }: { name: string; status: { ok: boolean; detail?: string } }) {
  const [open, setOpen] = useState(false);
  const label = HEALTH_LABELS[name] ?? name;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--border-subtle)', cursor: status.ok ? 'default' : 'pointer' }} onClick={() => !status.ok && setOpen(o => !o)}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: status.ok ? 'var(--success)' : 'var(--danger)', flexShrink: 0 }} />
        <span style={{ fontSize: '13px', color: 'var(--text)', flex: 1 }}>{label}</span>
        {status.detail && status.ok && <span style={{ fontSize: '11px', color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>{status.detail.slice(0, 60)}</span>}
        {!status.ok && <span style={{ fontSize: '11px', color: 'var(--accent-text)', fontWeight: 500 }}>{open ? 'Hide' : 'How to fix'}</span>}
      </div>
      {!status.ok && open && (
        <div style={{ padding: '10px 14px 10px 38px', background: 'color-mix(in oklch, var(--danger) 5%, transparent)', borderBottom: '1px solid var(--border-subtle)', fontSize: '12px', color: 'var(--text-muted)', animation: 'fadeIn 150ms ease' }}>
          {status.detail && <div style={{ marginBottom: 4, color: 'var(--danger)', fontSize: '11.5px' }}>{status.detail}</div>}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text)' }}>{HEALTH_FIX[name]}</code>
          {name === 'llm' && (
            <>
              {' '}
              <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-text)', fontSize: '12px' }}>Install Claude Code</a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// One section, one truth: the engine (Claude Code) and its checks. The old page
// had an "LLM provider · Active" card AND a health row both saying the same
// thing; install guidance now only surfaces when the check actually fails.
function EngineSection({ health, loading, checkedAt, onRecheck }: {
  health: HealthCheck | null; loading: boolean; checkedAt: number | null; onRecheck: () => void;
}) {
  const entries = health ? Object.entries(health.checks) : [];
  const ordered = ['llm', 'db'].map(k => {
    const found = entries.find(([name]) => name === k);
    return found ?? [k, { ok: false, detail: 'not checked' }] as [string, { ok: boolean; detail?: string }];
  }).concat(entries.filter(([name]) => !['llm', 'db'].includes(name)));

  return (
    <div>
      <SectionHeading
        title="Engine"
        desc="Claude Code scores matches and turns your searches into criteria."
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {checkedAt && !loading && <span style={{ fontSize: '11px', color: 'var(--text-faint)' }}>Checked {new Date(checkedAt).toLocaleTimeString()}</span>}
            <Button variant="ghost" size="sm" onClick={onRecheck} loading={loading}><RefreshCw size={12} /> Re-check</Button>
          </div>
        }
      />
      <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
        {loading && health === null ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
        ) : (
          ordered.map(([name, status]) => <HealthRow key={name} name={name} status={status} />)
        )}
      </div>
    </div>
  );
}

function DangerZone({ scanRunning, onCleared }: { scanRunning: boolean; onCleared: () => void }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [done, setDone] = useState(false);

  const handleClear = async () => {
    setClearing(true);
    try {
      await api.admin.clearJobs();
      setDone(true);
      setConfirming(false);
      onCleared();
    } catch (e) {
      toast(`Could not clear: ${String(e)}`, 'error');
    } finally {
      setClearing(false);
    }
  };

  // Deliberately the ONLY boxed element on the page — quarantined by contrast.
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '16px 18px', border: '1px solid color-mix(in oklch, var(--danger) 22%, var(--border))', borderRadius: 'var(--radius-lg)' }}>
        <div>
          <div style={{ fontSize: '13.5px', fontWeight: 550, color: 'var(--text)', marginBottom: 3 }}>Clear all scanned data</div>
          <div style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>Deletes all jobs, scores, run history, and attachments. Your source list is preserved.</div>
        </div>
        {done ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12.5px', color: 'var(--success)', flexShrink: 0 }}><CheckCircle2 size={13} /> Cleared</div>
        ) : confirming ? (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <Button variant="danger" size="sm" onClick={handleClear} loading={clearing}>Yes, clear everything</Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        ) : (
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)} disabled={scanRunning} title={scanRunning ? 'A scan is running — try again once it finishes.' : undefined} style={{ flexShrink: 0 }}>Clear all jobs</Button>
        )}
      </div>
    </section>
  );
}

// Editorial strip — sections sit on the page behind a hairline, no card boxes
// (matching the Search/Jobs language).
const strip: CSSProperties = {
  borderTop: '1px solid var(--border-subtle)',
  paddingTop: 'var(--space-lg)',
};

export default function Settings() {
  const toast = useToast();

  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const loadSources = useCallback(async () => {
    const res = await api.sources.list();
    setSources(res.sources); setSourcesLoading(false);
  }, []);
  useEffect(() => { loadSources(); }, [loadSources]);

  // A one-off check, not a live subscription (Settings has no run/SSE
  // infra) — enough to know, at the moment the page loads, whether the
  // Danger Zone's "Clear all" should start out disabled.
  const [scanRunning, setScanRunning] = useState(false);
  useEffect(() => {
    api.runs.list(1).then(res => setScanRunning(Boolean(res.runs[0] && !res.runs[0].finished_at))).catch(() => {});
  }, []);

  const [health, setHealth] = useState<HealthCheck | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  // Mount does the cheap check (DB + a quick LLM ping); "Re-check" runs the
  // deep probe (also exercises the model) — no need to pay that cost on every
  // page load.
  const checkHealth = useCallback(async (deep = false) => {
    setHealthLoading(true);
    try {
      const res = await api.health.check(deep);
      setHealth(res); setCheckedAt(Date.now());
      if (!res.ok) toast('Some health checks failed.', 'error');
    } catch (e) { toast(`Health check failed: ${String(e)}`, 'error'); } finally { setHealthLoading(false); }
  }, [toast]);
  useEffect(() => { checkHealth(); }, [checkHealth]);

  // Masthead summary — the page's state in one line, before any section is read.
  const enabledCount = sources.filter(s => s.enabled === 1).length;
  const checks = health ? Object.values(health.checks) : [];
  const failing = checks.filter(c => !c.ok).length;
  const llmVersion = (health?.checks?.llm?.detail ?? '').match(/\d+(?:\.\d+)+/)?.[0];

  return (
    <div style={{ padding: 'var(--space-2xl) var(--space-xl) var(--space-3xl)', maxWidth: 820, margin: '0 auto' }}>
      <header style={{ marginBottom: 'var(--space-xl)' }}>
        <h1 style={{ margin: 0, fontFamily: 'var(--font-serif)', fontSize: 'clamp(28px, 3.4vw, 34px)', fontWeight: 500, color: 'var(--text)', letterSpacing: '-0.02em', lineHeight: 1 }}>Settings</h1>
        {(!sourcesLoading || health) && (
          <p style={{ margin: '10px 0 0', fontSize: '13.5px', color: 'var(--text-muted)' }}>
            {sources.length > 0
              ? <><span className="tnum" style={{ color: 'var(--text)' }}>{sources.length.toLocaleString()}</span> boards{enabledCount !== sources.length && <> · <span className="tnum">{enabledCount.toLocaleString()}</span> enabled</>}</>
              : <>Boards load on your first search</>}
            <span style={{ color: 'var(--text-faint)' }}> · Claude Code{llmVersion ? <span className="tnum"> {llmVersion}</span> : null}</span>
            {health && (
              <span style={{ color: failing === 0 ? 'var(--success)' : 'var(--danger)' }}>
                {' '}· {failing === 0 ? 'all checks passing' : `${failing} check${failing === 1 ? '' : 's'} failing`}
              </span>
            )}
          </p>
        )}
      </header>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2xl)' }}>
        <section style={strip}>
          <SourcesSection sources={sources} loading={sourcesLoading} setSources={setSources} reload={loadSources} />
        </section>
        <section style={strip}>
          <ResumeSection />
        </section>
        <section style={strip}>
          <EmbeddingSection />
        </section>
        <section style={strip}>
          <TasteSection />
        </section>
        <section style={strip}>
          <FreshnessSection />
        </section>
        <section style={strip}>
          <GradingLimitSection />
        </section>
        <section style={strip}>
          <BoardCacheSection />
        </section>
        <section style={strip}>
          <BoardRefreshSection />
        </section>
        <section style={strip}>
          <EngineSection health={health} loading={healthLoading} checkedAt={checkedAt} onRecheck={() => checkHealth(true)} />
        </section>
        <DangerZone scanRunning={scanRunning} onCleared={loadSources} />
      </div>
    </div>
  );
}
