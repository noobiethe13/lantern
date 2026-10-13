import { useState, useEffect } from 'react';
import {
  api, type FreshnessSettings, type L2CapSettings, type BoardCacheSettings, type BoardRefreshStatus,
} from '@/lib/api';
import { Switch, useToast } from '@/components/ui';
import { PanelHeader, SettingRow, NumberSetting, RowLoading, timeAgo, errText } from './parts';

export function PipelinePanel() {
  return (
    <>
      <PanelHeader title="Pipeline" intro="What happens between finding a job and showing it to you: what's too old, how much Claude grades, and how boards stay fresh." />
      <FreshnessSetting />
      <GradingLimitSetting />
      <BoardCacheSetting />
      <BoardRefreshSetting />
    </>
  );
}

function FreshnessSetting() {
  const toast = useToast();
  const [saved, setSaved] = useState<FreshnessSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.freshness.get().then(res => setSaved(res.settings))
      .catch(e => { console.error('freshness settings failed', e); setSaved({ enabled: true, maxAgeDays: 7 }); });
  }, []);

  const save = async (next: FreshnessSettings) => {
    setBusy(true);
    try {
      const res = await api.freshness.save(next);
      setSaved(res.settings);
      toast(res.settings.enabled ? `Dropping dated jobs older than ${res.settings.maxAgeDays} days before grading.` : 'Freshness filter off.', 'success');
    } catch (e) {
      toast(`Could not save: ${errText(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow
      title="Skip stale postings"
      desc="Jobs whose posted date is older than this are dropped before Claude grades them: cheaper, and fresher results. Jobs with no posted date always pass."
      control={saved ? (
        <div className="controls-inline">
          <NumberSetting label="Maximum age in days" value={saved.maxAgeDays} unit="days" min={1} max={365} width={64} disabled={!saved.enabled}
            onSave={async v => save({ enabled: saved.enabled, maxAgeDays: v })} />
          <Switch checked={saved.enabled} busy={busy} onChange={v => save({ enabled: v, maxAgeDays: saved.maxAgeDays })} label="Skip stale postings" />
        </div>
      ) : undefined}
    />
  );
}

// Bounds one search's grading bill: only the best-ranked N survivors go to Claude,
// the rest wait for a repeat search of the same query.
function GradingLimitSetting() {
  const toast = useToast();
  const [saved, setSaved] = useState<L2CapSettings | null>(null);

  useEffect(() => {
    api.l2Cap.get().then(res => setSaved(res.settings))
      .catch(e => { console.error('grading limit failed', e); setSaved({ maxJobs: 300 }); });
  }, []);

  return (
    <SettingRow
      title="Grading limit"
      desc="The most jobs one search sends to Claude. With semantic ranking on, the best matches go first; anything past the limit waits for the same search to run again."
      control={saved ? (
        <NumberSetting label="Jobs graded per search" value={saved.maxJobs} unit="per search" min={20} max={5000} step={20} width={84}
          onSave={async v => {
            try {
              const res = await api.l2Cap.save({ maxJobs: v });
              setSaved(res.settings);
              toast(`Grading up to ${res.settings.maxJobs} jobs per search.`, 'success');
            } catch (e) { toast(`Could not save: ${errText(e)}`, 'error'); }
          }} />
      ) : undefined}
    />
  );
}

// Company boards return their whole listing whatever you search, so a board fetched
// recently is checked against the new search from its stored jobs instead of fetched again.
function BoardCacheSetting() {
  const toast = useToast();
  const [saved, setSaved] = useState<BoardCacheSettings | null>(null);

  useEffect(() => {
    api.boardCache.get().then(res => setSaved(res.settings))
      .catch(e => { console.error('board cache settings failed', e); setSaved({ ttlHours: 6 }); });
  }, []);

  return (
    <SettingRow
      title="Board cache"
      desc="Company boards list every job whatever you search, so one fetched within this window is checked against your search from its stored jobs. 0 fetches every board on every search. Aggregators are always fetched."
      control={saved ? (
        <NumberSetting label="Board cache hours" value={saved.ttlHours} unit="hours" min={0} max={168} width={64}
          onSave={async v => {
            try {
              const res = await api.boardCache.save({ ttlHours: v });
              setSaved(res.settings);
              toast(res.settings.ttlHours === 0 ? 'Board cache off. Every search fetches each board.' : `Reusing boards fetched in the last ${res.settings.ttlHours} hours.`, 'success');
            } catch (e) { toast(`Could not save: ${errText(e)}`, 'error'); }
          }} />
      ) : undefined}
    />
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
function BoardRefreshSetting() {
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

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      const res = await api.boardRefresh.save(on);
      setStatus(res.status);
    } catch (e) {
      toast(`Could not update: ${errText(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const on = status?.enabled ?? false;
  const boards = status?.boards;
  const freshShare = boards && boards.total > 0 ? boards.fresh / boards.total : 0;
  const state = !status ? '' : !on
    ? IDLE_NOTES.off
    : status.refreshing.length > 0
      ? `Refreshing ${status.refreshing.slice(0, 2).join(', ')}${status.refreshing.length > 2 ? ` and ${status.refreshing.length - 2} more` : ''}.`
      : status.idleReason === 'nothing-stale' ? nothingToRefresh(status) : status.idleReason ? IDLE_NOTES[status.idleReason] : 'Waiting for the next pass.';

  return (
    <SettingRow
      title="Keep boards fresh in the background"
      desc="Re-fetches company boards before the cache window runs out, a few at a time and never during a search, so your next search is served from stored jobs."
      control={status && <Switch checked={on} busy={busy} onChange={toggle} label="Keep boards fresh in the background" />}
    >
      {!status || !boards ? <RowLoading /> : (
        <div className="refresh-status">
          {/* how much of the roster is warm, as a single quiet line of light */}
          <div className="refresh-meter" aria-hidden><span style={{ width: `${Math.round(freshShare * 100)}%` }} /></div>
          <div className="refresh-counts tnum">
            <span><b>{boards.fresh.toLocaleString()}</b> fresh</span>
            <span><b>{boards.stale.toLocaleString()}</b> stale</span>
            {boards.backedOff > 0 && <span><b>{boards.backedOff.toLocaleString()}</b> waiting after errors</span>}
            <span className="text-faint">of {boards.total.toLocaleString()} enabled boards</span>
          </div>
          <p className="refresh-line">
            {state}
            {on && status.lastTickAt && <> Last pass {timeAgo(status.lastTickAt)}{status.lastTick ? `: ${status.lastTick.ok} refreshed${status.lastTick.failed > 0 ? `, ${status.lastTick.failed} failed` : ''}` : ''}.</>}
            {on && status.running && status.nextTickAt && <> Next pass {inFuture(status.nextTickAt)}.</>}
          </p>
          {status.lastError && (
            <p className="refresh-line" title={status.lastError.error}>
              Last error {timeAgo(status.lastError.at)}: {status.lastError.board}, {status.lastError.error.slice(0, 90)}
            </p>
          )}
        </div>
      )}
    </SettingRow>
  );
}
