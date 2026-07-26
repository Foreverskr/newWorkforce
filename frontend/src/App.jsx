import { Routes, Route, useLocation } from 'react-router-dom';
import { useState, useEffect, useCallback } from 'react';
import { Moon, Sun } from 'lucide-react';
import Sidebar from './components/Sidebar.jsx';
import Toast from './components/Toast.jsx';
import LoginPage from './pages/LoginPage.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ClockPage from './pages/ClockPage.jsx';
import AttendancePage from './pages/AttendancePage.jsx';
import EmployeesPage from './pages/EmployeesPage.jsx';
import DriversPage from './pages/DriverPage.jsx';
import LeavesPage from './pages/LeavesPage.jsx';
import AnalyticsPage from './pages/AnalyticsPage.jsx';
import SchedulePage from './pages/SchedulePage';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { api } from './lib/api.js';
import { useSessionTimeout } from './hooks/Usesessiontimeout.js';
import { getSession, getSessionInvalidReason, clearSession } from './utils/session.js';

const PAGE_TITLES = {
  '/': 'Dashboard',
  '/clock': 'Clock In / Out',
  '/attendance': 'Attendance Records',
  '/employees': 'Employees',
  '/drivers': 'Drivers',
  '/leaves': 'Leave Management',
  '/analytics': 'Analytics',
};

function AppContent() {
  const location = useLocation();
  const [toasts, setToasts] = useState([]);
  const { theme, toggleTheme } = useTheme();

  const [isLoggedIn, setIsLoggedIn] = useState(() => {
    const session = getSession();
    return !!session && !getSessionInvalidReason(session);
  });

  // 'checking' | 'online' | 'offline'
  const [serverStatus, setServerStatus] = useState('checking');

  const onToast = useCallback((message, type = 'success') => {
    const id = Date.now();
    setToasts(t => [...t, { id, message, type }]);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(t => t.filter(x => x.id !== id));
  }, []);

  // Central logout, used by: the Logout button, the idle/8hr frontend timer,
  // and 401s coming back from the API (backend-enforced expiry).
  const handleLogout = useCallback((reason) => {
    clearSession();
    setIsLoggedIn(false);
    if (reason === 'idle') onToast('You were logged out due to inactivity.', 'error');
    if (reason === 'expired') onToast('Your session expired. Please sign in again.', 'error');
  }, [onToast]);

  // Frontend-side idle timer + absolute 8hr check (fast, no network needed)
  useSessionTimeout(isLoggedIn, handleLogout);

  // Backend-side enforcement: api.js dispatches this when any request comes
  // back 401 (token missing/expired/invalid), which is the real source of truth.
  useEffect(() => {
    const onSessionExpired = () => handleLogout('expired');
    window.addEventListener('session-expired', onSessionExpired);
    return () => window.removeEventListener('session-expired', onSessionExpired);
  }, [handleLogout]);

  useEffect(() => {
    let cancelled = false;

    const checkHealth = async () => {
      try {
        const data = await api.getHealth(); // { status: 'ok' | 'error', supabase, timestamp }
        if (!cancelled) setServerStatus(data.status === 'ok' ? 'online' : 'offline');
      } catch (err) {
        if (!cancelled) setServerStatus('offline');
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 15000); // re-check every 15s

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!isLoggedIn) {
    return <LoginPage onLogin={() => setIsLoggedIn(true)} />;
  }

  const pageTitle = PAGE_TITLES[location.pathname] || 'Workforce Management';

  const statusLabel = {
    online: 'System Online',
    offline: 'System Offline',
    checking: 'Checking...',
  }[serverStatus];

  return (
    <div className="layout">
      <Sidebar />
      <div className="main">
        <div className="topbar">
          <span className="topbar-title">{pageTitle}</span>
          <div className="topbar-actions">
            <button className="btn btn-ghost" onClick={() => handleLogout()}>
              Logout
            </button>
            <button 
              className="btn btn-ghost"
              onClick={toggleTheme}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? (
                <Sun size={16} />
              ) : (
                <Moon size={16} />
              )}
            </button>
            <span className={`badge ${serverStatus}`}>
              <span className="badge-dot" /> {statusLabel}
            </span>
          </div>
        </div>

        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/clock" element={<ClockPage onToast={onToast} />} />
          <Route path="/attendance" element={<AttendancePage onToast={onToast} />} />
          <Route path="/employees" element={<EmployeesPage onToast={onToast} />} />
          <Route path="/schedule" element={<SchedulePage onToast={onToast} />} />
          <Route path="/leaves" element={<LeavesPage onToast={onToast} />} />
          <Route path="/drivers" element={<DriversPage onToast={onToast} />} />
          <Route path="/analytics" element={<AnalyticsPage onToast={onToast} />} />
        </Routes>
      </div>

      {toasts.map(t => (
        <Toast key={t.id} message={t.message} type={t.type} onClose={() => removeToast(t.id)} />
      ))}
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}