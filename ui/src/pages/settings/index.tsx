import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Layers, Sparkles, Workflow, Cpu } from 'lucide-react';
import { api, type Source, type HealthCheck } from '@/lib/api';
import { useToast } from '@/components/ui';
import { SourcesPanel } from './SourcesPanel';
import { MatchingPanel } from './MatchingPanel';
import { PipelinePanel } from './PipelinePanel';
import { SystemPanel } from './SystemPanel';
import { errText } from './parts';
import './settings.css';

const TABS = [
  { id: 'sources', label: 'Sources', desc: 'Boards and aggregators', icon: Layers },
  { id: 'matching', label: 'Matching', desc: 'Resume, ranking, taste', icon: Sparkles },
  { id: 'pipeline', label: 'Pipeline', desc: 'Freshness, limits, cache', icon: Workflow },
  { id: 'system', label: 'System', desc: 'Engine and data', icon: Cpu },
] as const;
type TabId = typeof TABS[number]['id'];

/**
 * Settings in four rooms instead of one long corridor. The category lives in the
 * URL (?tab=) so it survives reloads and can be linked from the command menu.
 */
export default function Settings() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: TabId = TABS.some(t => t.id === raw) ? (raw as TabId) : 'sources';

  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const loadSources = useCallback(async () => {
    try {
      const res = await api.sources.list();
      setSources(res.sources);
    } catch (e) {
      toast(`Could not load sources: ${errText(e)}`, 'error');
    } finally {
      setSourcesLoading(false);
    }
  }, [toast]);
  useEffect(() => { loadSources(); }, [loadSources]);

  // A one-off check, not a live subscription — enough to know, when the page
  // loads, whether "Clear all" should start out disabled.
  const [scanRunning, setScanRunning] = useState(false);
  useEffect(() => {
    api.runs.list(1).then(res => setScanRunning(Boolean(res.runs[0] && !res.runs[0].finished_at)))
      .catch(e => console.error('run status failed', e));
  }, []);

  const [health, setHealth] = useState<HealthCheck | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  // Mount does the cheap check (DB + a quick LLM ping); "Re-check" runs the deep
  // probe (also exercises the model), so page loads don't pay that cost.
  const checkHealth = useCallback(async (deep = false) => {
    setHealthLoading(true);
    try {
      const res = await api.health.check(deep);
      setHealth(res); setCheckedAt(Date.now());
      if (!res.ok) toast('Some health checks failed.', 'error');
    } catch (e) { toast(`Health check failed: ${errText(e)}`, 'error'); } finally { setHealthLoading(false); }
  }, [toast]);
  useEffect(() => { checkHealth(); }, [checkHealth]);

  // Masthead summary — the page's state in one line, before any section is read.
  const enabledCount = sources.filter(s => s.enabled === 1).length;
  const failing = health ? Object.values(health.checks).filter(c => !c.ok).length : 0;
  const llmVersion = (health?.checks?.llm?.detail ?? '').match(/\d+(?:\.\d+)+/)?.[0];

  return (
    <div className="settings-page">
      <header className="settings-head">
        <h1>Settings</h1>
        {(!sourcesLoading || health) && (
          <p className="settings-meta">
            {sources.length > 0
              ? <><span className="tnum" style={{ color: 'var(--text)' }}>{sources.length.toLocaleString()}</span> boards{enabledCount !== sources.length && <> · <span className="tnum">{enabledCount.toLocaleString()}</span> enabled</>}</>
              : <>Boards load on your first search</>}
            <span className="text-faint"> · Claude Code{llmVersion ? <span className="tnum"> {llmVersion}</span> : null}</span>
            {health && (
              <button className="settings-health" data-ok={failing === 0 || undefined} onClick={() => setParams({ tab: 'system' })}>
                <span aria-hidden />
                {failing === 0 ? 'All checks passing' : `${failing} check${failing === 1 ? '' : 's'} failing`}
              </button>
            )}
          </p>
        )}
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings categories">
          {TABS.map(({ id, label, desc, icon: Icon }) => (
            <button key={id} className="snav-item" aria-current={tab === id ? 'page' : undefined} onClick={() => setParams({ tab: id }, { replace: true })}>
              <Icon size={15} strokeWidth={1.9} />
              <span>
                <span className="snav-label">{label}</span>
                <span className="snav-desc">{desc}</span>
              </span>
            </button>
          ))}
        </nav>

        <section key={tab} className="settings-panel" aria-label={TABS.find(t => t.id === tab)!.label}>
          {tab === 'sources' && <SourcesPanel sources={sources} loading={sourcesLoading} setSources={setSources} reload={loadSources} />}
          {tab === 'matching' && <MatchingPanel />}
          {tab === 'pipeline' && <PipelinePanel />}
          {tab === 'system' && (
            <SystemPanel health={health} loading={healthLoading} checkedAt={checkedAt} onRecheck={() => checkHealth(true)} scanRunning={scanRunning} onCleared={loadSources} />
          )}
        </section>
      </div>
    </div>
  );
}
