import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, LayoutList, Settings as SettingsIcon, Clock, Star, Send, MessagesSquare,
  Trophy, EyeOff, Sparkles, Moon, Sun, CornerDownLeft,
} from 'lucide-react';
import { api } from '@/lib/api';
import { Kbd } from './ui';
import { LanternMark } from './brand';

interface Command {
  id: string;
  group: string;
  label: ReactNode;
  /** Text the filter matches against (label may be JSX). */
  text: string;
  icon: ReactNode;
  hint?: string;
  run: () => void;
}

const I = { size: 15, strokeWidth: 1.9 } as const;

/**
 * ⌘K / Ctrl+K — one keyboard surface for everything: start a search from any
 * page, re-run a recent one, jump to a saved Jobs view, switch theme. The
 * search box stays the product's front door; this is the side entrance for
 * someone who already knows where they're going.
 */
export function CommandPalette({ open, onClose, theme, onToggleTheme }: {
  open: boolean; onClose: () => void; theme: 'dark' | 'light'; onToggleTheme: () => void;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(0);
    api.runs.recentQueries().then(r => setRecent(r.queries)).catch(e => console.error('recent queries failed', e));
    // focus after the open frame so the browser doesn't scroll the page to it
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const go = (to: string) => { onClose(); navigate(to, { viewTransition: true }); };
  const runSearch = (query: string) => { onClose(); navigate('/', { state: { runQuery: query }, viewTransition: true }); };

  const commands = buildCommands();
  function buildCommands(): Command[] {
    const term = q.trim();
    const list: Command[] = [];
    if (term) {
      list.push({
        id: 'search-new', group: 'Search', text: term, icon: <Sparkles {...I} style={{ color: 'var(--accent-text)' }} />,
        label: <>Search for <span style={{ color: 'var(--text)', fontWeight: 600 }}>“{term}”</span></>,
        hint: 'Run', run: () => runSearch(term),
      });
    }
    for (const r of recent.slice(0, term ? 6 : 4)) {
      list.push({ id: `recent-${r}`, group: 'Recent searches', text: r, label: r, icon: <Clock {...I} />, hint: 'Run again', run: () => runSearch(r) });
    }
    list.push(
      { id: 'nav-search', group: 'Go to', text: 'Search home new', label: 'Search', icon: <Search {...I} />, run: () => go('/') },
      { id: 'nav-jobs', group: 'Go to', text: 'Jobs all roles', label: 'Jobs', icon: <LayoutList {...I} />, run: () => go('/jobs') },
      { id: 'nav-settings', group: 'Go to', text: 'Settings sources resume engine', label: 'Settings', icon: <SettingsIcon {...I} />, run: () => go('/settings') },
      { id: 'view-latest', group: 'Jobs views', text: 'Latest search matches fit', label: 'Matches from the latest search', icon: <Sparkles {...I} />, run: () => go('/jobs?fit=1&run=latest') },
      { id: 'view-shortlist', group: 'Jobs views', text: 'Shortlist', label: 'Shortlist', icon: <Star {...I} />, run: () => go('/jobs?status=shortlist') },
      { id: 'view-applied', group: 'Jobs views', text: 'Applied', label: 'Applied', icon: <Send {...I} />, run: () => go('/jobs?status=applied') },
      { id: 'view-interview', group: 'Jobs views', text: 'Interview interviewing', label: 'Interviewing', icon: <MessagesSquare {...I} />, run: () => go('/jobs?status=interview') },
      { id: 'view-offer', group: 'Jobs views', text: 'Offers', label: 'Offers', icon: <Trophy {...I} />, run: () => go('/jobs?status=offer') },
      { id: 'view-hidden', group: 'Jobs views', text: 'Hidden not interested', label: 'Hidden', icon: <EyeOff {...I} />, run: () => go('/jobs?status=hidden') },
      {
        id: 'theme', group: 'Preferences', text: 'theme dark light mode lantern',
        label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        icon: theme === 'dark' ? <Sun {...I} /> : <Moon {...I} />,
        run: () => { onToggleTheme(); onClose(); },
      },
    );
    if (!term) return list;
    // The "Search for" row always stays; everything else filters on its words.
    const t = term.toLowerCase();
    return list.filter(c => c.id === 'search-new' || c.text.toLowerCase().includes(t) || c.group.toLowerCase().includes(t));
  }

  const activeIdx = Math.min(active, Math.max(commands.length - 1, 0));

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (i + 1) % Math.max(commands.length, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i - 1 + commands.length) % Math.max(commands.length, 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); commands[activeIdx]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let lastGroup = '';
  return (
    <div className="cmdk-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command menu" onKeyDown={onKeyDown}>
        <div aria-hidden className="cmdk-glow" />
        <div className="cmdk-input-row">
          <Search size={17} strokeWidth={2} style={{ color: 'var(--accent-text)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => { setQ(e.target.value); setActive(0); }}
            placeholder="Describe a role, or jump to…"
            aria-label="Command or search"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={commands[activeIdx] ? `cmdk-${commands[activeIdx].id}` : undefined}
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={listRef} id="cmdk-list" role="listbox" className="cmdk-list">
          {commands.length === 0 && <div className="cmdk-empty">Nothing matches.</div>}
          {commands.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && <div className="cmdk-group">{header}</div>}
                <div
                  id={`cmdk-${c.id}`}
                  role="option"
                  aria-selected={i === activeIdx}
                  data-idx={i}
                  className="cmdk-item"
                  onMouseMove={() => { if (i !== activeIdx) setActive(i); }}
                  onClick={() => c.run()}
                >
                  <span className="cmdk-icon">{c.icon}</span>
                  <span className="cmdk-label">{c.label}</span>
                  {i === activeIdx && (
                    <span className="cmdk-hint">{c.hint ?? 'Open'} <CornerDownLeft size={12} /></span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="cmdk-foot">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Kbd>↵</Kbd> select</span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-faint)' }}>
            <span style={{ color: 'var(--text-muted)' }}><LanternMark size={14} glow={false} /></span>
            Lantern
          </span>
        </div>
      </div>
    </div>
  );
}
