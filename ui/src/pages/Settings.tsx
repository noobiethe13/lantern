import {
  useState, useEffect, useCallback,
  type ReactNode, type CSSProperties, type Dispatch, type SetStateAction,
} from 'react';
import {
  CheckCircle2, XCircle, Circle, Trash2, Plus,
  RefreshCw, ChevronDown, ChevronRight, Search as SearchIcon,
} from 'lucide-react';
import {
  api, type Source, type SourceType, type HealthCheck,
} from '@/lib/api';
import { Button, Input, Badge, Spinner, useToast } from '@/components/ui';

type BadgeTone = 'neutral' | 'accent' | 'blue' | 'violet' | 'success' | 'warning' | 'danger' | 'dim';

const SOURCE_TYPE_OPTIONS: { value: SourceType; label: string; placeholder: string }[] = [
  { value: 'greenhouse', label: 'Greenhouse', placeholder: 'board-slug (e.g. stripe)' },
  { value: 'ashby', label: 'Ashby', placeholder: 'jobs.ashbyhq.com/company' },
  { value: 'lever', label: 'Lever', placeholder: 'jobs.lever.co/company' },
  { value: 'recruitee', label: 'Recruitee', placeholder: 'tenant slug (e.g. acme → acme.recruitee.com)' },
  { value: 'smartrecruiters', label: 'SmartRecruiters', placeholder: 'company slug (e.g. Bosch)' },
  { value: 'workable', label: 'Workable', placeholder: 'account slug (apply.workable.com/slug)' },
  { value: 'personio', label: 'Personio', placeholder: 'tenant slug (e.g. acme → acme.jobs.personio.de)' },
  { value: 'remoteok', label: 'RemoteOK', placeholder: 'global — searched by your role keyword' },
  { value: 'arbeitnow', label: 'Arbeitnow', placeholder: 'global — searched by your role keyword' },
  { value: 'himalayas', label: 'Himalayas', placeholder: 'global — searched by your role keyword' },
];

const TYPE_TONE: Record<SourceType, BadgeTone> = {
  greenhouse: 'success', ashby: 'blue', lever: 'warning', recruitee: 'violet',
  smartrecruiters: 'danger', workable: 'neutral', personio: 'neutral',
  remoteok: 'accent', arbeitnow: 'accent', himalayas: 'accent',
};

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
    : <XCircle size={8} style={{ color: 'var(--danger)' }} />;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 96px 64px 40px', alignItems: 'center', gap: 14, padding: '9px 14px', borderBottom: '1px solid var(--border-subtle)', opacity: enabled ? 1 : 0.5, transition: 'opacity 150ms ease' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.display_name}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-faint)', marginTop: 2, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.identifier}</div>
      </div>
      <Badge tone={TYPE_TONE[source.type] ?? 'neutral'}>{typeOpt?.label ?? source.type}</Badge>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '11px', color: 'var(--text-faint)' }}>{statusIcon}{timeAgo(source.last_scan_at)}</div>
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typeOpt = SOURCE_TYPE_OPTIONS.find(t => t.value === type)!;

  const handleAdd = async () => {
    if (!identifier.trim() || !displayName.trim()) return;
    setSaving(true); setError(null);
    try {
      await api.sources.create({ type, identifier: identifier.trim(), display_name: displayName.trim() });
      setIdentifier(''); setDisplayName(''); setOpen(false); onAdded();
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
      {error && <div style={{ fontSize: '12px', color: 'var(--danger)' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" onClick={handleAdd} loading={saving} disabled={!identifier.trim() || !displayName.trim()}><Plus size={13} /> Add</Button>
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

function SourcesSection({ sources, loading, setSources, reload }: {
  sources: Source[]; loading: boolean;
  setSources: Dispatch<SetStateAction<Source[]>>; reload: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(false);

  const handleToggle = async (source: Source) => {
    const newEnabled = source.enabled !== 1;
    setSources(prev => prev.map(s => s.id === source.id ? { ...s, enabled: newEnabled ? 1 : 0 } : s));
    await api.sources.update(source.id, { enabled: newEnabled }).catch(() => reload());
  };

  const handleDelete = async (id: number) => {
    setSources(prev => prev.filter(s => s.id !== id));
    await api.sources.delete(id).catch(() => reload());
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

function DangerZone() {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [done, setDone] = useState(false);

  const handleClear = async () => {
    setClearing(true);
    try { await api.admin.clearJobs(); setDone(true); setConfirming(false); } finally { setClearing(false); }
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
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)} style={{ flexShrink: 0 }}>Clear all jobs</Button>
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

  const [health, setHealth] = useState<HealthCheck | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const checkHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const res = await api.health.check();
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
          <EngineSection health={health} loading={healthLoading} checkedAt={checkedAt} onRecheck={checkHealth} />
        </section>
        <DangerZone />
      </div>
    </div>
  );
}
