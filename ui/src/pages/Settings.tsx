import { useState, useEffect, useCallback, type ReactNode, type CSSProperties } from 'react';
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

function SourcesSection() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    const res = await api.sources.list();
    setSources(res.sources); setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (source: Source) => {
    const newEnabled = source.enabled !== 1;
    setSources(prev => prev.map(s => s.id === source.id ? { ...s, enabled: newEnabled ? 1 : 0 } : s));
    await api.sources.update(source.id, { enabled: newEnabled }).catch(() => load());
  };

  const handleDelete = async (id: number) => {
    setSources(prev => prev.filter(s => s.id !== id));
    await api.sources.delete(id).catch(() => load());
  };

  const f = filter.trim().toLowerCase();
  const filtered = f ? sources.filter(s => s.display_name.toLowerCase().includes(f) || s.identifier.toLowerCase().includes(f) || s.type.includes(f)) : sources;
  const enabledCount = sources.filter(s => s.enabled === 1).length;

  const grouped = SOURCE_TYPE_OPTIONS
    .map(opt => ({ ...opt, sources: filtered.filter(s => s.type === opt.value) }))
    .filter(g => g.sources.length > 0);

  const canExpand = sources.length > 0;

  return (
    <section>
      <SectionHeading
        title="Sources"
        desc={sources.length === 0
          ? 'The default set of boards and aggregators loads on your first search.'
          : `${sources.length} boards and aggregators · ${enabledCount} enabled.`}
        action={
          canExpand ? (
            <Button variant="outline" size="sm" onClick={() => setExpanded(e => !e)}>
              {expanded ? <><ChevronDown size={13} /> Hide</> : <><ChevronRight size={13} /> Manage</>}
            </Button>
          ) : undefined
        }
      />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
      ) : expanded && canExpand ? (
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
          <AddSourceForm onAdded={load} />
        </div>
      ) : null}
    </section>
  );
}

function LlmProviderSection() {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try { const res = await api.llmSettings.health(); setTestResult({ ok: res.ok, detail: res.detail }); }
    catch (e) { setTestResult({ ok: false, detail: String(e) }); } finally { setTesting(false); }
  };

  return (
    <section>
      <SectionHeading title={<>LLM <em>provider</em></>} desc="L2 scoring and NL-to-criteria run through the Claude Code CLI." />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '14px', fontWeight: 550, color: 'var(--text)' }}>Claude Code</span>
          <Badge tone="accent">Active</Badge>
        </div>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-faint)' }}>
          Requires the <code style={{ fontFamily: 'var(--font-mono)' }}>claude</code> CLI on your PATH.{' '}
          <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-text)' }}>Install Claude Code</a>.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button variant="outline" onClick={handleTest} loading={testing}>Test connection</Button>
          {testResult && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '12.5px', color: testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
              {testResult.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}{testResult.detail.slice(0, 80)}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

const HEALTH_LABELS: Record<string, string> = { db: 'Database', llm: 'LLM provider' };
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
        </div>
      )}
    </div>
  );
}

function HealthSection() {
  const [health, setHealth] = useState<HealthCheck | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const toast = useToast();

  const check = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.health.check();
      setHealth(res); setCheckedAt(Date.now());
      if (!res.ok) toast('Some health checks failed.', 'error');
    } catch (e) { toast(`Health check failed: ${String(e)}`, 'error'); } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { check(); }, [check]);

  const entries = health ? Object.entries(health.checks) : [];
  const ordered = ['db', 'llm'].map(k => {
    const found = entries.find(([name]) => name === k);
    return found ?? [k, { ok: false, detail: 'not checked' }] as [string, { ok: boolean; detail?: string }];
  }).concat(entries.filter(([name]) => !['db', 'llm'].includes(name)));

  return (
    <section>
      <SectionHeading
        title="Health"
        desc="Checks that Lantern is ready to run."
        action={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {checkedAt && !loading && <span style={{ fontSize: '11px', color: 'var(--text-faint)' }}>Checked {new Date(checkedAt).toLocaleTimeString()}</span>}
            <Button variant="ghost" size="sm" onClick={check} loading={loading}><RefreshCw size={12} /> Re-check</Button>
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
    </section>
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

const sectionCard: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-lg)',
  padding: 'var(--space-xl)',
};

export default function Settings() {
  return (
    <div style={{ padding: 'var(--space-2xl) var(--space-xl)', maxWidth: 820, margin: '0 auto' }}>
      <h1 style={{ margin: '0 0 var(--space-xl)', fontSize: '26px', fontWeight: 580, color: 'var(--text)' }}>Settings</h1>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
        <div style={sectionCard}><SourcesSection /></div>
        <div style={sectionCard}><LlmProviderSection /></div>
        <div style={sectionCard}><HealthSection /></div>
        <DangerZone />
      </div>
    </div>
  );
}
