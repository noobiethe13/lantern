import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { Search, LayoutList, Settings as SettingsIcon } from 'lucide-react';
import Jobs from './pages/Jobs';
import SearchPage from './pages/Search';
import Settings from './pages/Settings';
import { ToastProvider } from './components/ui';
import { LanternMark, PageBackdrop } from './components/brand';

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
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

function Sidebar() {
  const { theme, toggle } = useTheme();

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

      <div style={{ position: 'relative', zIndex: 1, marginBottom: 28 }}>
        <Wordmark />
      </div>

      <nav style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={navClass}>
            <Icon size={16} strokeWidth={2} />
            <span className="nav-label">{label}</span>
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

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}>
          <Sidebar />
          <main style={{ position: 'relative', flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', height: '100vh' }}>
            <PageBackdrop />
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
      </ToastProvider>
    </BrowserRouter>
  );
}
