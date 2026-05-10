import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { Briefcase, Play, Settings as SettingsIcon, Zap } from 'lucide-react';
import Jobs from './pages/Jobs';
import Run from './pages/Run';
import Settings from './pages/Settings';

function Sidebar() {
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
      <nav className="flex flex-col gap-0.5">
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
    </aside>
  );
}

export default function App() {
  return (
    <BrowserRouter>
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
    </BrowserRouter>
  );
}
