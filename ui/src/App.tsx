import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { Briefcase, Play, Settings as SettingsIcon, Zap, Sun, Moon } from 'lucide-react';
import Jobs from './pages/Jobs';
import Run from './pages/Run';
import Settings from './pages/Settings';
import { ToastProvider } from './components/ui';

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof localStorage !== 'undefined') {
      return (localStorage.getItem('lantern-theme') as 'dark' | 'light') ?? 'dark';
    }
    return 'dark';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : '';
    localStorage.setItem('lantern-theme', theme);
  }, [theme]);

  const toggle = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  return { theme, toggle };
}

function Sidebar() {
  const { theme, toggle } = useTheme();

  const navClass = ({ isActive }: { isActive: boolean }) =>
    [
      'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-fast',
      isActive
        ? 'bg-[var(--accent-muted)] text-[var(--accent-hover)]'
        : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]',
    ].join(' ');

  return (
    <aside
      style={{ background: 'var(--surface)', borderRight: '1px solid var(--border)' }}
      className="flex flex-col w-52 min-h-screen shrink-0 px-3 py-4"
    >
      {/* Logo */}
      <div className="flex items-center gap-2 px-1 mb-6">
        <Zap size={18} style={{ color: 'var(--accent)' }} strokeWidth={2.5} />
        <span className="font-semibold tracking-tight" style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}>
          lantern
        </span>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-0.5 flex-1">
        <NavLink to="/jobs" className={navClass}>
          <Briefcase size={15} />
          Jobs
        </NavLink>
        <NavLink to="/run" className={navClass}>
          <Play size={15} />
          Run
        </NavLink>
        <NavLink to="/settings" className={navClass}>
          <SettingsIcon size={15} />
          Settings
        </NavLink>
      </nav>

      {/* Theme toggle */}
      <button
        onClick={toggle}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          borderRadius: '8px',
          background: 'none',
          border: 'none',
          color: 'var(--text-muted)',
          fontSize: '12px',
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'all 150ms ease-out',
          width: '100%',
          fontFamily: 'inherit',
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)';
          (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-2)';
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)';
          (e.currentTarget as HTMLButtonElement).style.background = 'none';
        }}
      >
        {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        {theme === 'dark' ? 'Light mode' : 'Dark mode'}
      </button>
    </aside>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <div className="flex min-h-screen" style={{ background: 'var(--bg)' }}>
          <Sidebar />
          <main className="flex-1 min-w-0 overflow-auto">
            <Routes>
              <Route path="/" element={<Navigate to="/jobs" replace />} />
              <Route path="/jobs" element={<Jobs />} />
              <Route path="/run" element={<Run />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      </ToastProvider>
    </BrowserRouter>
  );
}
