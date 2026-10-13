import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { Search, LayoutList, Settings as SettingsIcon } from 'lucide-react';
import Jobs from './pages/jobs';
import SearchPage from './pages/Search';
import Settings from './pages/settings';
import { ToastProvider, Kbd, MOD_KEY } from './components/ui';
import { LanternMark, PageBackdrop } from './components/brand';
import { CommandPalette } from './components/CommandPalette';
import { api } from './lib/api';

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    // ?theme=dark|light overrides (and then persists) — lets a link force a theme.
    const fromUrl = new URLSearchParams(window.location.search).get('theme');
    if (fromUrl === 'dark' || fromUrl === 'light') return fromUrl;
    if (typeof localStorage !== 'undefined') {
      return (localStorage.getItem('lantern-theme') as 'dark' | 'light') ?? 'light';
    }
    return 'light';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : '';
    localStorage.setItem('lantern-theme', theme);
  }, [theme]);

  const toggle = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  return { theme, toggle };
}

// Whether a search is running anywhere, so the rail can say so from any page.
// Polls only while the tab is visible; the server is local so a 5s tick is free.
function useScanActive(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let live = true;
    const check = () => {
      if (document.hidden) return;
      api.runs.list(1)
        .then(({ runs }) => { if (live) setActive(Boolean(runs[0] && runs[0].finished_at == null)); })
        .catch(e => console.error('run status poll failed', e));
    };
    check();
    const iv = setInterval(check, 5000);
    document.addEventListener('visibilitychange', check);
    return () => { live = false; clearInterval(iv); document.removeEventListener('visibilitychange', check); };
  }, []);
  return active;
}

const TITLES: Record<string, string> = { '/jobs': 'Jobs', '/settings': 'Settings' };

function DocumentTitle({ scanning }: { scanning: boolean }) {
  const { pathname } = useLocation();
  useEffect(() => {
    const page = TITLES[pathname];
    document.title = `${scanning ? '● ' : ''}${page ? `${page} · ` : ''}Lantern`;
  }, [pathname, scanning]);
  return null;
}

function Wordmark() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '2px 6px' }}>
      <LanternMark size={22} animate />
      <span
        className="wordmark-text"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: '21px',
          fontWeight: 600,
          color: 'var(--text)',
          letterSpacing: '-0.01em',
        }}
      >
        Lantern
      </span>
    </div>
  );
}

const NAV = [
  { to: '/', label: 'Search', icon: Search, end: true },
  { to: '/jobs', label: 'Jobs', icon: LayoutList, end: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
];

function Sidebar({ theme, toggle, scanning, onOpenPalette }: {
  theme: 'dark' | 'light'; toggle: () => void; scanning: boolean; onOpenPalette: () => void;
}) {

  const navClass = ({ isActive }: { isActive: boolean }) =>
    [
      'nav-link',
      isActive ? 'nav-link-active' : '',
    ].join(' ');

  return (
    <aside
      className="app-sidebar"
      style={{
        position: 'relative',
        zIndex: 2,
        overflow: 'hidden',
        background: 'var(--bg)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        width: 216,
        minHeight: '100vh',
        flexShrink: 0,
        padding: '20px 14px',
      }}
    >
      {/* ambient lantern light pooling at the base of the rail */}
      <div aria-hidden style={{
        position: 'absolute', bottom: -120, left: '50%', transform: 'translateX(-50%)',
        width: 280, height: 280, pointerEvents: 'none', zIndex: 0,
        background: 'radial-gradient(50% 50% at 50% 50%, color-mix(in oklch, var(--accent) 22%, transparent), transparent 70%)',
        animation: 'breathe 7s ease-in-out infinite',
      }} />

      <div style={{ position: 'relative', zIndex: 1, marginBottom: 22 }}>
        <Wordmark />
      </div>

      <button className="cmdk-trigger" onClick={onOpenPalette} aria-label="Open command menu" title={`Command menu (${MOD_KEY}+K)`}>
        <Search size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
        <span className="nav-label" style={{ flex: 1, textAlign: 'left' }}>Jump to…</span>
        <span className="nav-label cmdk-keys"><Kbd>{MOD_KEY}</Kbd><Kbd>K</Kbd></span>
      </button>

      <nav style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={navClass} viewTransition>
            <Icon size={16} strokeWidth={2} />
            <span className="nav-label">{label}</span>
            {/* a search in flight keeps its lantern lit on the rail, wherever you are */}
            {to === '/' && scanning && <span className="nav-live" title="A search is running" aria-label="A search is running" />}
          </NavLink>
        ))}
      </nav>

      {/* Theme toggle is the lantern itself: dark theme lights it (amber core +
          glow + flicker), light theme puts it out (cool, hollow core). No labels —
          the flame state + tooltip carry the meaning. */}
      <button
        onClick={toggle}
        title={theme === 'dark' ? 'Put out the lantern — switch to light' : 'Light the lantern — switch to dark'}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        className="lantern-toggle"
        data-lit={theme === 'dark'}
        style={{ position: 'relative', zIndex: 1 }}
      >
        <svg className="lt-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden style={{ overflow: 'visible', display: 'block', flexShrink: 0 }}>
          <circle className="lt-halo" cx="12" cy="12.2" r="6.5" fill="var(--accent)" />
          <path d="M9.4 4.1c0-1.43 1.16-2.6 2.6-2.6s2.6 1.17 2.6 2.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <rect x="7.3" y="4.4" width="9.4" height="2.4" rx="1.2" fill="currentColor" />
          <path d="M8.1 7.4h7.8l-.62 9.0c-.05.74-.66 1.3-1.4 1.3H10.1c-.74 0-1.35-.56-1.4-1.3L8.1 7.4Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <rect x="9.1" y="17.9" width="5.8" height="2.2" rx="1.1" fill="currentColor" />
          <circle className="lt-core" cx="12" cy="11.9" r="2.5" />
        </svg>
        <span className="lt-label">{theme === 'dark' ? 'Dark mode' : 'Light mode'}</span>
      </button>

      <style>{`
        .nav-link {
          display: flex; align-items: center; gap: 10px;
          padding: 8px 11px; border-radius: var(--radius-md);
          font-size: 13.5px; font-weight: 500;
          color: var(--text-muted); text-decoration: none;
          transition: color 150ms cubic-bezier(0.22,1,0.36,1), background 150ms cubic-bezier(0.22,1,0.36,1);
        }
        .nav-link:hover { color: var(--text); background: var(--surface-2); }
        .nav-link-active { color: var(--accent-text); background: var(--accent-muted); }
        .nav-link-active:hover { color: var(--accent-text); background: var(--accent-muted); }
        .nav-link { position: relative; }
        .nav-live {
          margin-left: auto; width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
          background: var(--accent); box-shadow: 0 0 10px var(--accent);
          animation: glow-pulse 1.4s ease-in-out infinite;
        }
        .cmdk-trigger {
          position: relative; z-index: 1; display: flex; align-items: center; gap: 9px; width: 100%;
          margin-bottom: 14px; padding: 7px 8px 7px 11px; border-radius: var(--radius-md);
          background: color-mix(in oklch, var(--surface) 70%, transparent); border: 1px solid var(--border-subtle);
          color: var(--text-faint); font-family: inherit; font-size: 13px; cursor: pointer;
          transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
        }
        .cmdk-trigger:hover { color: var(--text-muted); border-color: var(--border); background: var(--surface); }
        .cmdk-keys { display: inline-flex; gap: 3px; }
        @media (max-width: 860px) {
          .cmdk-trigger { justify-content: center; padding: 8px; }
          .nav-live { position: absolute; top: 6px; right: 8px; }
        }
        .lantern-toggle {
          display: flex; align-items: center; gap: 10px; width: 100%;
          padding: 8px 11px; border-radius: var(--radius-md);
          background: none; border: 1px solid transparent; cursor: pointer;
          color: var(--text-muted); font-family: inherit; font-size: 13.5px; font-weight: 500;
          transition: background 160ms ease, color 160ms ease;
        }
        .lantern-toggle:hover { background: var(--surface-2); color: var(--text); }
        .lt-label { line-height: 1; }
        .lt-halo { opacity: 0; filter: blur(3px); transform-origin: center; transition: opacity 360ms ease; }
        .lt-core { fill: var(--text-faint); transform-origin: center; transition: fill 360ms ease; }
        .lantern-toggle[data-lit="true"] .lt-icon { color: var(--accent-text); }
        .lantern-toggle[data-lit="true"] .lt-halo { opacity: 0.24; animation: flicker 4.5s ease-in-out infinite; }
        .lantern-toggle[data-lit="true"] .lt-core { fill: var(--accent); animation: flicker 4.5s ease-in-out infinite; }
      `}</style>
    </aside>
  );
}

function AppBackdrop() {
  // Data-dense pages get the quiet backdrop — blobs stay out from under the tables.
  const { pathname } = useLocation();
  return <PageBackdrop quiet={pathname.startsWith('/jobs') || pathname.startsWith('/settings')} />;
}

function Shell() {
  const { theme, toggle } = useTheme();
  const scanning = useScanActive();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Ctrl/Cmd+K works from anywhere, inputs included, since that's the point of it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <DocumentTitle scanning={scanning} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} theme={theme} onToggleTheme={toggle} />
      <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}>
        <Sidebar theme={theme} toggle={toggle} scanning={scanning} onOpenPalette={() => setPaletteOpen(true)} />
        <main style={{ position: 'relative', flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', height: '100vh' }}>
          <AppBackdrop />
          <div style={{ position: 'relative', zIndex: 1 }}>
            <Routes>
              <Route path="/" element={<SearchPage />} />
              <Route path="/jobs" element={<Jobs />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </main>
      </div>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </BrowserRouter>
  );
}
