import { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle2, XCircle, Circle, Trash2, Plus,
  Wand2, Save, AlertCircle, RefreshCw,
} from 'lucide-react';
import { api, type Source, type Criteria, type SourceType, type HealthCheck } from '@/lib/api';
import { Button, Input, Textarea, Badge, Spinner, useToast } from '@/components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

const SOURCE_TYPE_OPTIONS: { value: SourceType; label: string; placeholder: string }[] = [
  { value: 'greenhouse', label: 'Greenhouse', placeholder: 'board-slug (e.g. stripe)' },
  { value: 'ashby', label: 'Ashby', placeholder: 'jobs.ashbyhq.com/company' },
  { value: 'lever', label: 'Lever', placeholder: 'jobs.lever.co/company' },
  { value: 'hn-whos-hiring', label: 'HN Who\'s Hiring', placeholder: 'hn-whos-hiring' },
  { value: 'generic-url', label: 'Generic URL', placeholder: 'https://company.com/careers' },
  { value: 'x-grok', label: 'X / Grok', placeholder: 'x-grok' },
];

const TYPE_BADGE_VARIANT: Record<SourceType, 'indigo' | 'blue' | 'amber' | 'green' | 'red' | 'default'> = {
  greenhouse: 'green',
  ashby: 'blue',
  lever: 'amber',
  'hn-whos-hiring': 'indigo',
  'generic-url': 'default',
  'x-grok': 'red',
};

function timeAgo(ts: number | null): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// ─── Criteria section ─────────────────────────────────────────────────────────

function CriteriaSection() {
  const [criteria, setCriteria] = useState<Criteria | null>(null);
  const [yamlDraft, setYamlDraft] = useState('');
  const [nlText, setNlText] = useState('');
  const [savingYaml, setSavingYaml] = useState(false);
  const [generatingNL, setGeneratingNL] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.criteria.get().then((c: Criteria) => {
      setCriteria(c);
      setYamlDraft(c.yaml);
    }).catch(() => setError('Failed to load criteria'));
  }, []);

  const handleSave = async () => {
    setSavingYaml(true);
    setError(null);
    try {
      await api.criteria.save(yamlDraft);
      setSavedAt(Date.now());
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingYaml(false);
    }
  };

  const handleGenerate = async () => {
    if (!nlText.trim()) return;
    setGeneratingNL(true);
    setError(null);
    try {
      const res = await api.criteria.fromNL(nlText);
      setYamlDraft(res.yaml);
      setSavedAt(Date.now());
    } catch (e) {
      setError(String(e));
    } finally {
      setGeneratingNL(false);
    }
  };

  return (
    <div>
      <h2 style={{ margin: '0 0 4px', fontSize: '15px', fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em' }}>
        Search criteria
      </h2>
      <p style={{ margin: '0 0 20px', fontSize: '13px', color: 'var(--text-muted)' }}>
        YAML filter rules for L1 and the Gemini scoring prompt. Edit directly or generate from a description.
      </p>

      {/* NL generator */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '10px', padding: '16px', marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', marginBottom: 8 }}>
          Generate from description
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            value={nlText}
            onChange={e => setNlText(e.target.value)}
            placeholder='e.g. "senior backend engineer, remote, $130k+, no agencies"'
            onKeyDown={e => e.key === 'Enter' && handleGenerate()}
          />
          <Button
            onClick={handleGenerate}
            disabled={!nlText.trim()}
            loading={generatingNL}
            variant="outline"
            style={{ flexShrink: 0 }}
          >
            <Wand2 size={13} />
            Generate
          </Button>
        </div>
        <p style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--text-faint)' }}>
          Uses Gemini Flash to convert your description into filter YAML.
        </p>
      </div>

      {/* YAML editor */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)' }}>
            Criteria YAML
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {criteria?.updated_at && (
              <span style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
                Updated {timeAgo(savedAt ?? criteria.updated_at)}
              </span>
            )}
            {criteria?.source_text && (
              <span style={{ fontSize: '11px', color: 'var(--text-faint)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                · from "{criteria.source_text}"
              </span>
            )}
          </div>
        </div>
        {criteria === null ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
        ) : (
          <Textarea
            value={yamlDraft}
            onChange={e => setYamlDraft(e.target.value)}
            rows={16}
            spellCheck={false}
          />
        )}
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', marginBottom: 12 }}>
          <AlertCircle size={13} style={{ color: 'var(--danger)', flexShrink: 0 }} />
          <span style={{ fontSize: '12px', color: 'var(--danger)' }}>{error}</span>
        </div>
      )}

      <Button onClick={handleSave} loading={savingYaml} disabled={criteria === null}>
        <Save size={13} />
        Save criteria
      </Button>

      {savedAt && !savingYaml && (
        <span style={{ marginLeft: 12, fontSize: '12px', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <CheckCircle2 size={12} />
          Saved
        </span>
      )}
    </div>
  );
}

// ─── Source row ───────────────────────────────────────────────────────────────

function SourceRow({ source, onToggle, onDelete }: {
  source: Source;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const enabled = source.enabled === 1;
  const typeOpt = SOURCE_TYPE_OPTIONS.find(t => t.value === source.type);

  const statusIcon = !source.last_scan_at
    ? <Circle size={8} style={{ color: 'var(--text-faint)' }} />
    : source.last_status === 'ok'
    ? <CheckCircle2 size={8} style={{ color: 'var(--success)' }} />
    : <XCircle size={8} style={{ color: 'var(--danger)' }} />;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 100px 80px 80px 60px',
        alignItems: 'center',
        gap: 16,
        padding: '10px 16px',
        borderBottom: '1px solid var(--border-subtle)',
        opacity: enabled ? 1 : 0.5,
        transition: 'opacity 150ms ease-out',
      }}
    >
      {/* Name */}
      <div>
        <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)' }}>
          {source.display_name}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-faint)', marginTop: 2, fontFamily: 'var(--mono)' }}>
          {source.identifier.length > 50 ? source.identifier.slice(0, 50) + '…' : source.identifier}
        </div>
      </div>

      {/* Type */}
      <Badge variant={TYPE_BADGE_VARIANT[source.type] ?? 'default'}>
        {typeOpt?.label ?? source.type}
      </Badge>

      {/* Last scan */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '11px', color: 'var(--text-faint)' }}>
        {statusIcon}
        {timeAgo(source.last_scan_at)}
      </div>

      {/* Enable toggle */}
      <button
        onClick={onToggle}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: enabled ? 'rgba(99,102,241,0.15)' : 'var(--surface-2)',
          color: enabled ? 'var(--accent-hover)' : 'var(--text-faint)',
          border: 'none',
          borderRadius: '6px',
          padding: '4px 10px',
          fontSize: '12px',
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'all 150ms ease-out',
        }}
      >
        {enabled ? 'On' : 'Off'}
      </button>

      {/* Delete */}
      {confirming ? (
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={() => { onDelete(); setConfirming(false); }}
            style={{ fontSize: '11px', color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}
          >
            Confirm
          </button>
          <button
            onClick={() => setConfirming(false)}
            style={{ fontSize: '11px', color: 'var(--text-faint)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: 4, display: 'flex', alignItems: 'center', transition: 'color 120ms' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--danger)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-faint)'; }}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

// ─── Add source form ──────────────────────────────────────────────────────────

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
    setSaving(true);
    setError(null);
    try {
      await api.sources.create({ type, identifier: identifier.trim(), display_name: displayName.trim() });
      setIdentifier('');
      setDisplayName('');
      setOpen(false);
      onAdded();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '8px 14px', borderRadius: '8px', fontSize: '12px',
          fontWeight: 500, cursor: 'pointer',
          background: 'transparent', color: 'var(--text-muted)',
          border: '1px dashed var(--border)',
          transition: 'all 150ms ease-out', width: '100%',
          justifyContent: 'center', marginTop: 2,
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent-hover)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
      >
        <Plus size={13} />
        Add source
      </button>
    );
  }

  return (
    <div style={{ padding: 16, background: 'var(--surface-2)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: 12, marginTop: 2, animation: 'fadeIn 150ms ease-out' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 1fr', gap: 10, alignItems: 'end' }}>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-faint)', marginBottom: 4 }}>Type</label>
          <select
            value={type}
            onChange={e => setType(e.target.value as SourceType)}
            style={{
              width: '100%', background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: '7px', color: 'var(--text)', fontFamily: 'inherit',
              fontSize: '12px', padding: '5px 8px', outline: 'none',
            }}
          >
            {SOURCE_TYPE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-faint)', marginBottom: 4 }}>Identifier</label>
          <Input value={identifier} onChange={e => setIdentifier(e.target.value)} placeholder={typeOpt.placeholder} style={{ fontSize: '12px', height: '30px' }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-faint)', marginBottom: 4 }}>Display name</label>
          <Input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Company name" style={{ fontSize: '12px', height: '30px' }} onKeyDown={e => e.key === 'Enter' && handleAdd()} />
        </div>
      </div>

      {error && (
        <div style={{ fontSize: '12px', color: 'var(--danger)' }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" onClick={handleAdd} loading={saving} disabled={!identifier.trim() || !displayName.trim()}>
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setError(null); }}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ─── Sources section ──────────────────────────────────────────────────────────

function SourcesSection() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await api.sources.list();
    setSources(res.sources);
    setLoading(false);
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

  const grouped = SOURCE_TYPE_OPTIONS.map(opt => ({
    ...opt,
    sources: sources.filter(s => s.type === opt.value),
  })).filter(g => g.sources.length > 0);

  return (
    <div>
      <h2 style={{ margin: '0 0 4px', fontSize: '15px', fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em' }}>
        Sources
      </h2>
      <p style={{ margin: '0 0 20px', fontSize: '13px', color: 'var(--text-muted)' }}>
        Job boards and feeds that lantern scans.
      </p>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden', marginBottom: 12 }}>
          {/* Header */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 80px 80px 60px', gap: 16, padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
            {['Source', 'Type', 'Last scan', 'Enabled', ''].map((h, i) => (
              <span key={i} style={{ fontSize: '11px', color: 'var(--text-faint)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</span>
            ))}
          </div>

          {sources.length === 0 ? (
            <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-faint)', fontSize: '13px' }}>
              No sources configured yet.
            </div>
          ) : (
            grouped.map(group => (
              <div key={group.value}>
                {grouped.length > 1 && (
                  <div style={{ padding: '6px 16px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border-subtle)' }}>
                    <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      {group.label}
                    </span>
                  </div>
                )}
                {group.sources.map((source) => (
                  <SourceRow
                    key={source.id}
                    source={source}
                    onToggle={() => handleToggle(source)}
                    onDelete={() => handleDelete(source.id)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      )}

      <AddSourceForm onAdded={load} />
    </div>
  );
}

// ─── Health section ───────────────────────────────────────────────────────────

const HEALTH_LABELS: Record<string, string> = {
  db:            'Database',
  gemini:        'Gemini CLI',
  playwright:    'Playwright / Chromium',
  browserProfile:'Browser profile (X/Grok)',
};

const HEALTH_FIX: Record<string, string> = {
  db:            'Check that data/ is writable. Run: bun run setup',
  gemini:        'Install: npm i -g @google/gemini-cli  then run: gemini auth',
  playwright:    'Run: bun x playwright install chromium',
  browserProfile:'Run: bun run setup  and complete the X/Grok login step.',
};

function HealthRow({ name, status }: { name: string; status: { ok: boolean; detail?: string } }) {
  const [open, setOpen] = useState(false);
  const label = HEALTH_LABELS[name] ?? name;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 16px',
          borderBottom: '1px solid var(--border-subtle)',
          cursor: status.ok ? 'default' : 'pointer',
        }}
        onClick={() => !status.ok && setOpen(o => !o)}
      >
        {status.ok
          ? <CheckCircle2 size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />
          : <XCircle size={14} style={{ color: 'var(--danger)', flexShrink: 0 }} />
        }
        <span style={{ fontSize: '13px', color: 'var(--text)', flex: 1 }}>{label}</span>
        {status.detail && status.ok && (
          <span style={{ fontSize: '11px', color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>
            {status.detail.slice(0, 60)}
          </span>
        )}
        {!status.ok && (
          <span style={{ fontSize: '11px', color: 'var(--accent-hover)', fontWeight: 500 }}>
            {open ? 'Hide fix' : 'How to fix'}
          </span>
        )}
      </div>
      {!status.ok && open && (
        <div
          style={{
            padding: '10px 16px 10px 40px',
            background: 'rgba(239,68,68,0.04)',
            borderBottom: '1px solid var(--border-subtle)',
            fontSize: '12px',
            color: 'var(--text-muted)',
            animation: 'fadeIn 150ms ease-out',
          }}
        >
          <div style={{ marginBottom: 4, color: 'var(--danger)', fontSize: '11px' }}>
            {status.detail}
          </div>
          <code style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--text)' }}>
            {HEALTH_FIX[name]}
          </code>
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
      setHealth(res);
      setCheckedAt(Date.now());
      if (!res.ok) toast('Some health checks failed — see details below.', 'error');
    } catch (e) {
      toast(`Health check failed: ${String(e)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { check(); }, [check]);

  const entries = health ? Object.entries(health.checks) : [];
  const ordered = ['db', 'gemini', 'playwright', 'browserProfile'].map(k => {
    const found = entries.find(([name]) => name === k);
    return found ?? [k, { ok: false, detail: 'not checked' }] as [string, { ok: boolean; detail?: string }];
  }).concat(entries.filter(([name]) => !['db','gemini','playwright','browserProfile'].includes(name)));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em' }}>
          Health
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {checkedAt && !loading && (
            <span style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
              Checked {new Date(checkedAt).toLocaleTimeString()}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={check} loading={loading} style={{ gap: 5 }}>
            <RefreshCw size={12} />
            Re-check
          </Button>
        </div>
      </div>
      <p style={{ margin: '0 0 20px', fontSize: '13px', color: 'var(--text-muted)' }}>
        Runtime dependencies lantern needs to scan.
      </p>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
        {loading && health === null ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
            <Spinner />
          </div>
        ) : (
          ordered.map(([name, status]) => (
            <HealthRow key={name} name={name} status={status} />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Settings() {
  return (
    <div style={{ padding: '32px', maxWidth: 780 }}>
      <h1 style={{ margin: '0 0 32px', fontSize: '18px', fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.02em' }}>
        Settings
      </h1>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 48 }}>
        <CriteriaSection />
        <div style={{ height: 1, background: 'var(--border)' }} />
        <SourcesSection />
        <div style={{ height: 1, background: 'var(--border)' }} />
        <HealthSection />
        <div style={{ height: 1, background: 'var(--border)' }} />
        <DangerZone />
      </div>
    </div>
  );
}

// ─── Danger zone ──────────────────────────────────────────────────────────────

function DangerZone() {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [done, setDone] = useState(false);

  const handleClear = async () => {
    setClearing(true);
    try {
      await api.admin.clearJobs();
      setDone(true);
      setConfirming(false);
    } finally {
      setClearing(false);
    }
  };

  return (
    <div>
      <h2 style={{ margin: '0 0 4px', fontSize: '15px', fontWeight: 600, color: 'var(--danger)', letterSpacing: '-0.01em' }}>
        Danger zone
      </h2>
      <p style={{ margin: '0 0 20px', fontSize: '13px', color: 'var(--text-muted)' }}>
        Irreversible actions. Sources and criteria are kept.
      </p>

      <div
        style={{
          background: 'rgba(239,68,68,0.05)',
          border: '1px solid rgba(239,68,68,0.2)',
          borderRadius: '10px',
          padding: '16px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 24,
        }}
      >
        <div>
          <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)', marginBottom: 3 }}>
            Clear all scanned data
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Deletes all jobs, L2 scores, run history, and attachments. Sources and criteria are preserved.
          </div>
        </div>

        {done ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: 'var(--success)', flexShrink: 0 }}>
            <CheckCircle2 size={13} />
            Cleared
          </div>
        ) : confirming ? (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <Button variant="danger" size="sm" onClick={handleClear} loading={clearing}>
              Yes, clear everything
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)} style={{ flexShrink: 0 }}>
            Clear all jobs
          </Button>
        )}
      </div>
    </div>
  );
}
