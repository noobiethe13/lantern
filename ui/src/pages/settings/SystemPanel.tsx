import { useState } from 'react';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import { api, type HealthCheck } from '@/lib/api';
import { Button, useToast } from '@/components/ui';
import { PanelHeader, SettingRow, RowLoading, errText } from './parts';

const HEALTH_LABELS: Record<string, string> = { db: 'Database', llm: 'Claude Code' };
const HEALTH_FIX: Record<string, string> = {
  db: 'Check that data/ is writable.',
  llm: 'Ensure the claude CLI is installed and logged in.',
};

export function SystemPanel({ health, loading, checkedAt, onRecheck, scanRunning, onCleared }: {
  health: HealthCheck | null; loading: boolean; checkedAt: number | null; onRecheck: () => void;
  scanRunning: boolean; onCleared: () => void;
}) {
  const entries = health ? Object.entries(health.checks) : [];
  const ordered = ['llm', 'db'].map(k => {
    const found = entries.find(([name]) => name === k);
    return found ?? [k, { ok: false, detail: 'not checked' }] as [string, { ok: boolean; detail?: string }];
  }).concat(entries.filter(([name]) => !['llm', 'db'].includes(name)));

  return (
    <>
      <PanelHeader title="System" intro="The engine underneath, and the one irreversible thing on this page." />
      <SettingRow
        title="Engine"
        desc="Claude Code scores matches and turns your searches into criteria. The check runs on load; Re-check also exercises the model."
        control={
          <div className="controls-inline">
            {checkedAt && !loading && <span className="text-faint" style={{ fontSize: '11.5px' }}>Checked {new Date(checkedAt).toLocaleTimeString()}</span>}
            <Button variant="outline" size="sm" onClick={onRecheck} loading={loading}><RefreshCw size={12} /> Re-check</Button>
          </div>
        }
      >
        {loading && health === null ? <RowLoading /> : (
          <div className="health">
            {ordered.map(([name, status]) => (
              <div key={name} className="health-row" data-ok={status.ok || undefined}>
                <span aria-hidden className="health-dot" />
                <span className="health-name">{HEALTH_LABELS[name] ?? name}</span>
                {status.ok
                  ? <span className="health-detail">{status.detail?.slice(0, 60)}</span>
                  : (
                    <span className="health-fix">
                      {status.detail && <span style={{ color: 'var(--danger)' }}>{status.detail} · </span>}
                      {HEALTH_FIX[name]}
                      {name === 'llm' && <> <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer">Install Claude Code</a></>}
                    </span>
                  )}
              </div>
            ))}
          </div>
        )}
      </SettingRow>
      <ClearData scanRunning={scanRunning} onCleared={onCleared} />
    </>
  );
}

function ClearData({ scanRunning, onCleared }: { scanRunning: boolean; onCleared: () => void }) {
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
      toast(`Could not clear: ${errText(e)}`, 'error');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="danger-row">
      <SettingRow
        title="Clear all scanned data"
        desc="Deletes every job, score, run and attachment. Your boards and settings stay. This can't be undone."
        control={done ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '12.5px', color: 'var(--success)' }}><CheckCircle2 size={13} /> Cleared</span>
        ) : confirming ? (
          <div className="controls-inline">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={handleClear} loading={clearing}>Yes, clear everything</Button>
          </div>
        ) : (
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)} disabled={scanRunning} title={scanRunning ? 'A search is running. Try again once it finishes.' : undefined}>
            Clear all jobs
          </Button>
        )}
      />
    </div>
  );
}
