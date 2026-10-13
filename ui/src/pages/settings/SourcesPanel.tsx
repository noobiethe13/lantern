import { useState, useEffect, type Dispatch, type SetStateAction } from 'react';
import { CheckCircle2, XCircle, Circle, Trash2, Plus, ChevronDown, ChevronRight, Search as SearchIcon } from 'lucide-react';
import { api, type Source, type SourceType } from '@/lib/api';
import { Button, Input, Switch, useToast } from '@/components/ui';
import { PanelHeader, SettingRow, RowLoading, timeAgo, errText } from './parts';

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

const GATED_TYPES = new Set<SourceType>(SOURCE_TYPE_OPTIONS.filter(o => o.gated).map(o => o.value));

// Badge tone → concrete color, for the composition bar + legend (mirrors the
// badge colors used on the roster rows so the encodings agree).
const TONE_COLOR: Record<BadgeTone, string> = {
  neutral: 'var(--text-muted)', accent: 'var(--accent-text)', blue: 'var(--tone-blue)',
  violet: 'var(--tone-violet)', success: 'var(--success)', warning: 'var(--warning)',
  danger: 'var(--danger)', dim: 'var(--text-faint)',
};

export function SourcesPanel({ sources, loading, setSources, reload }: {
  sources: Source[]; loading: boolean; setSources: Dispatch<SetStateAction<Source[]>>; reload: () => void;
}) {
  const enabled = sources.filter(s => s.enabled === 1).length;
  const types = new Set(sources.map(s => s.type)).size;
  return (
    <>
      <PanelHeader title="Sources" intro="Where Lantern looks. Company boards are read whole and cached; aggregators are searched with your role each time." />
      {loading ? <RowLoading /> : sources.length === 0 ? (
        <p className="panel-note">The default set of boards and aggregators loads on your first search.</p>
      ) : (
        <>
          {/* the shape of the field, typographically: the count is the headline */}
          <div className="coverage">
            <div className="coverage-figure">
              <span className="coverage-n tnum">{sources.length.toLocaleString()}</span>
              <span className="coverage-label">
                boards and aggregators across {types} source types
                <span className="text-faint"> · {enabled === sources.length ? 'all enabled' : `${enabled.toLocaleString()} enabled`}</span>
              </span>
            </div>
            <CompositionBar sources={sources} />
          </div>
          <DiscoveredBoards />
          <Roster sources={sources} setSources={setSources} reload={reload} />
        </>
      )}
    </>
  );
}

function CompositionBar({ sources }: { sources: Source[] }) {
  const groups = SOURCE_TYPE_OPTIONS
    .map(o => ({ label: o.label, color: TONE_COLOR[TYPE_TONE[o.value]], n: sources.filter(s => s.type === o.value).length }))
    .filter(g => g.n > 0);
  return (
    <div>
      <div className="comp-bar">
        {groups.map(g => <div key={g.label} title={`${g.label} · ${g.n}`} style={{ flex: g.n, background: g.color }} />)}
      </div>
      <div className="comp-legend">
        {groups.map(g => (
          <span key={g.label}>
            <span aria-hidden style={{ background: g.color }} />
            {g.label} <span className="tnum">{g.n}</span>
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
      toast(`Could not update discovered boards: ${errText(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow
      title={<>Include discovered boards <span className="tnum text-faint" style={{ fontWeight: 400 }}>{counts.total.toLocaleString()}</span></>}
      desc={<>
        Company boards found through public web crawls and checked live, but not hand-picked.
        Turning them on warms them in the background a few at a time: the first full pass takes one to three hours
        (about 100 minutes in testing), and a search that starts sooner fetches whatever isn't warm yet.
        Once warm, the refresher re-downloads all of them roughly every cache window, which is a lot of traffic;
        raise the board cache hours under Pipeline if that's more than you want.
      </>}
      control={<Switch checked={on} onChange={toggle} busy={busy} label="Include discovered boards" />}
    />
  );
}

function Roster({ sources, setSources, reload }: {
  sources: Source[]; setSources: Dispatch<SetStateAction<Source[]>>; reload: () => void;
}) {
  const toast = useToast();
  const [filter, setFilter] = useState('');

  const handleToggle = async (source: Source) => {
    const newEnabled = source.enabled !== 1;
    setSources(prev => prev.map(s => s.id === source.id ? { ...s, enabled: newEnabled ? 1 : 0 } : s));
    try {
      await api.sources.update(source.id, { enabled: newEnabled });
    } catch (e) {
      toast(`Could not update ${source.display_name}: ${errText(e)}`, 'error');
      reload();
    }
  };

  // Seeded sources (or ones with saved jobs) can't be hard-deleted — the server
  // turns them off instead and says so. Wait for the real outcome rather than
  // optimistically removing the row: a "disabled" response must leave the row
  // in place (just switched off), and a genuine error must surface.
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
      toast(`Could not delete: ${errText(e)}`, 'error');
    }
  };

  const f = filter.trim().toLowerCase();
  const filtered = f ? sources.filter(s => s.display_name.toLowerCase().includes(f) || s.identifier.toLowerCase().includes(f) || s.type.includes(f)) : sources;
  const grouped = SOURCE_TYPE_OPTIONS
    .map(opt => ({ ...opt, sources: filtered.filter(s => s.type === opt.value) }))
    .filter(g => g.sources.length > 0);

  return (
    <SettingRow
      title="Roster"
      desc="Every board Lantern reads, by vendor. Turning one off skips it on the next search; the status dot is its latest fetch."
      control={
        <div className="roster-filter">
          <SearchIcon size={13} />
          <Input placeholder="Filter boards" value={filter} onChange={e => setFilter(e.target.value)} style={{ paddingLeft: 30, height: 32, fontSize: '12.5px', width: 220 }} />
        </div>
      }
    >
      <div className="roster">
        {grouped.length === 0 ? (
          <div className="roster-empty">No boards match “{filter}”.</div>
        ) : grouped.map(group => (
          <div key={group.value}>
            <div className="roster-group">
              <span>{group.label}</span>
              <span className="tnum">{group.sources.length}</span>
            </div>
            {group.sources.map(source => (
              <SourceRow key={source.id} source={source} onToggle={() => handleToggle(source)} onDelete={() => handleDelete(source.id)} />
            ))}
          </div>
        ))}
      </div>
      <AddSourceForm onAdded={reload} />
    </SettingRow>
  );
}

function SourceRow({ source, onToggle, onDelete }: { source: Source; onToggle: () => void; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const enabled = source.enabled === 1;
  const statusIcon = !source.last_scan_at
    ? <Circle size={8} style={{ color: 'var(--text-faint)' }} />
    : source.last_status === 'ok'
    ? <CheckCircle2 size={9} style={{ color: 'var(--success)' }} />
    : source.last_status === 'rate-limited'
    ? <Circle size={8} style={{ color: 'var(--warning)' }} />
    : <XCircle size={9} style={{ color: 'var(--danger)' }} />;

  return (
    <div className="roster-row" data-off={!enabled || undefined}>
      <div style={{ minWidth: 0 }}>
        <div className="roster-name">
          {source.display_name}
          {GATED_TYPES.has(source.type) && (
            <span title="Unofficial endpoint — gray-area, rate-limited, may break" className="roster-gated">unofficial</span>
          )}
        </div>
        <div className="roster-id">{source.identifier}</div>
      </div>
      <div
        className="roster-health"
        title={source.last_status === 'ok' || !source.last_scan_at
          ? undefined
          : source.last_status === 'rate-limited'
          ? `Rate-limited by the host ${timeAgo(source.last_scan_at)} - will retry in the background`
          : `Last attempt ${timeAgo(source.last_scan_at)} failed${source.last_error ? `: ${source.last_error}` : ''}`}
      >
        {/* The age is of the last good fetch (what the board cache serves), the icon is the latest attempt. */}
        {statusIcon}{timeAgo(source.last_ok_fetch_at)}
      </div>
      <Switch checked={enabled} onChange={onToggle} label={`Include ${source.display_name}`} />
      {confirming ? (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <button onClick={() => { onDelete(); setConfirming(false); }} className="roster-confirm" style={{ color: 'var(--danger)' }}>Delete</button>
          <button onClick={() => setConfirming(false)} className="roster-confirm">Keep</button>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={() => setConfirming(true)} aria-label={`Delete ${source.display_name}`} className="roster-del"><Trash2 size={13} /></button>
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
  const ready = identifier.trim() && displayName.trim() && workdayReady && googleReady;

  const handleAdd = async () => {
    if (!ready) return;
    setSaving(true); setError(null);
    try {
      const config_json = isWorkday
        ? { site: wdSite.trim(), dc: wdDc.trim() }
        : isGoogleJobs
          ? { apiKey: serpKey.trim() }
          : undefined;
      await api.sources.create({ type, identifier: identifier.trim(), display_name: displayName.trim(), config_json });
      setIdentifier(''); setDisplayName(''); setWdSite(''); setWdDc(''); setSerpKey(''); setOpen(false); onAdded();
    } catch (e) { setError(errText(e)); } finally { setSaving(false); }
  };

  if (!open) {
    return (
      <button className="disclosure" onClick={() => setOpen(true)}>
        <ChevronRight size={13} /> Add a board by hand
      </button>
    );
  }

  return (
    <div className="add-source">
      <button className="disclosure" onClick={() => { setOpen(false); setError(null); }} style={{ marginBottom: 12 }}>
        <ChevronDown size={13} /> Add a board by hand
      </button>
      <div className="add-grid">
        <label>
          <span>Type</span>
          <select value={type} onChange={e => setType(e.target.value as SourceType)} className="field" style={{ height: 32, fontSize: '12.5px', padding: '0 8px' }}>
            {SOURCE_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label>
          <span>Identifier</span>
          <Input value={identifier} onChange={e => setIdentifier(e.target.value)} placeholder={typeOpt.placeholder} style={{ fontSize: '12.5px', height: 32 }} />
        </label>
        <label>
          <span>Display name</span>
          <Input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Company name" style={{ fontSize: '12.5px', height: 32 }} onKeyDown={e => e.key === 'Enter' && handleAdd()} />
        </label>
      </div>
      {isWorkday && (
        <>
          <div className="add-grid" style={{ gridTemplateColumns: '1fr 150px' }}>
            <label>
              <span>Career-site name</span>
              <Input value={wdSite} onChange={e => setWdSite(e.target.value)} placeholder="e.g. External_Career_Site" style={{ fontSize: '12.5px', height: 32 }} />
            </label>
            <label>
              <span>Datacenter</span>
              <Input value={wdDc} onChange={e => setWdDc(e.target.value)} placeholder="e.g. wd5" style={{ fontSize: '12.5px', height: 32 }} />
            </label>
          </div>
          <p className="add-note">
            From the careers URL <code>{'{tenant}.{dc}.myworkdayjobs.com/{site}'}</code>, e.g. <code>salesforce</code> · <code>wd12</code> · <code>External_Career_Site</code>.
          </p>
        </>
      )}
      {isGoogleJobs && (
        <>
          <div className="add-grid" style={{ gridTemplateColumns: '1fr' }}>
            <label>
              <span>SerpAPI key</span>
              <Input type="password" value={serpKey} onChange={e => setSerpKey(e.target.value)} placeholder="your SerpAPI api_key" style={{ fontSize: '12.5px', height: 32 }} />
            </label>
          </div>
          <p className="add-note">Google's deduplicated cross-board job index. Your key is stored locally and sent only to serpapi.com.</p>
        </>
      )}
      {isGated && (
        <p className="add-note" style={{ color: 'var(--warning)' }}>
          Unofficial endpoint: gray-area, aggressively rate-limited, and may break without notice. Use lightly for personal search.
        </p>
      )}
      {error && <p className="add-note" style={{ color: 'var(--danger)' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Button size="sm" onClick={handleAdd} loading={saving} disabled={!ready}><Plus size={13} /> Add board</Button>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setError(null); }}>Cancel</Button>
      </div>
    </div>
  );
}
