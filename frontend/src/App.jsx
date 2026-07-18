import { Routes, Route, useLocation } from 'react-router-dom';
import { useState, useEffect, useCallback } from 'react';
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
import { api } from './lib/api.js';

const PAGE_TITLES = {
  '/': 'Dashboard',
  '/clock': 'Clock In / Out',
  '/attendance': 'Attendance Records',
  '/employees': 'Employees',
  '/drivers': 'Drivers',
  '/leaves': 'Leave Management',
  '/analytics': 'Analytics',
};

export default function App() {
  const location = useLocation();
  const [toasts, setToasts] = useState([]);

  const [isLoggedIn, setIsLoggedIn] = useState(
    () => !!localStorage.getItem('at_auth')
  );

  // 'checking' | 'online' | 'offline'
  const [serverStatus, setServerStatus] = useState('checking');

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

  const onToast = useCallback((message, type = 'success') => {
    const id = Date.now();
    setToasts(t => [...t, { id, message, type }]);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(t => t.filter(x => x.id !== id));
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('at_auth');
    setIsLoggedIn(false);
  };

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
            <span className={`badge ${serverStatus}`}>
              <span className="badge-dot" /> {statusLabel}
            </span>
            <button className="btn btn-outline" onClick={handleLogout}>
              Logout
            </button>
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