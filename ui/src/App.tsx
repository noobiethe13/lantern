import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { Search, LayoutList, Settings as SettingsIcon, Sun, Moon } from 'lucide-react';
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

      <button
        onClick={toggle}
        title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
        className="theme-toggle"
        style={{ position: 'relative', zIndex: 1 }}
      >
        {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        <span className="theme-label">{theme === 'dark' ? 'Light' : 'Dark'}</span>
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
        .theme-toggle {
          display: flex; align-items: center; gap: 9px;
          padding: 8px 11px; border-radius: var(--radius-md);
          background: none; border: none; cursor: pointer;
          color: var(--text-muted); font-size: 13px; font-weight: 500;
          font-family: inherit; width: 100%;
          transition: color 150ms ease, background 150ms ease;
        }
        .theme-toggle:hover { color: var(--text); background: var(--surface-2); }
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
