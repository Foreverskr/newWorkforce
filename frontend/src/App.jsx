import { Routes, Route, useLocation } from "react-router-dom";
import { useState, useEffect, useCallback, useRef } from "react";
import { LogOut, Menu, Moon, Settings, Sun, User } from "lucide-react";
import Sidebar from "./components/Sidebar.jsx";
import Toast from "./components/Toast.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import ClockPage from "./pages/ClockPage.jsx";
import AttendancePage from "./pages/AttendancePage.jsx";
import EmployeesPage from "./pages/EmployeesPage.jsx";
import DriversPage from "./pages/DriverPage.jsx";
import LeavesPage from "./pages/LeavesPage.jsx";
import AnalyticsPage from "./pages/AnalyticsPage.jsx";
import SchedulePage from "./pages/SchedulePage";
import { ThemeProvider, useTheme } from "./contexts/ThemeContext";
import { useSessionTimeout } from "./hooks/useSessionTimeout.js";
import {
  getSession,
  getSessionInvalidReason,
  clearSession,
} from "./utils/session.js";

function AppContent() {
  const [toasts, setToasts] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef(null);
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();

  const [isLoggedIn, setIsLoggedIn] = useState(() => {
    const session = getSession();
    return !!session && !getSessionInvalidReason(session);
  });

  const onToast = useCallback((message, type = "success") => {
    const id = Date.now();
    setToasts((t) => [...t, { id, message, type }]);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  // Central logout, used by: the Logout button, the idle/8hr frontend timer,
  // and 401s coming back from the API (backend-enforced expiry).
  const handleLogout = useCallback(
    (reason) => {
      clearSession();
      setIsLoggedIn(false);
      if (reason === "idle")
        onToast("You were logged out due to inactivity.", "error");
      if (reason === "expired")
        onToast("Your session expired. Please sign in again.", "error");
    },
    [onToast],
  );

  // Frontend-side idle timer + absolute 8hr check (fast, no network needed)
  useSessionTimeout(isLoggedIn, handleLogout);

  // Backend-side enforcement: api.js dispatches this when any request comes
  // back 401 (token missing/expired/invalid), which is the real source of truth.
  useEffect(() => {
    const onSessionExpired = () => handleLogout("expired");
    window.addEventListener("session-expired", onSessionExpired);
    return () =>
      window.removeEventListener("session-expired", onSessionExpired);
  }, [handleLogout]);

  useEffect(() => {
    const onPointerDown = (event) => {
      if (!profileMenuRef.current?.contains(event.target)) {
        setProfileMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  if (!isLoggedIn) {
    return <LoginPage onLogin={() => setIsLoggedIn(true)} />;
  }

  const admin = getSession()?.admin || {};
  const displayName =
    admin.name || admin.full_name || admin.username || "Admin";
  const username = admin.username || displayName;
  const initials = displayName
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const activeStatus =
    admin.status || (admin.is_active === false ? "inactive" : "active");
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good Morning" : hour < 18 ? "Good Afternoon" : "Good Evening";
  const pageTitles = {
    "/": "Dashboard",
    "/clock": "Clock In / Out",
    "/attendance": "Timesheet Management",
    "/employees": "Status & Biometrics Management",
    "/schedule": "Shift & Schedule Management",
    "/leaves": "Leave Management",
    "/drivers": "Drivers",
    "/analytics": "Analytics",
  };
  const pageTitle = pageTitles[location.pathname] || "Dashboard";

  return (
    <div className={`layout ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <Sidebar />
      <div className="main">
        <div className="topbar">
          <div className="topbar-left">
            <button
              className="btn btn-ghost btn-icon sidebar-toggle"
              onClick={() => setSidebarOpen((open) => !open)}
              title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              aria-expanded={sidebarOpen}
            >
              <Menu size={18} />
            </button>
            <span className="topbar-title">{pageTitle}</span>
          </div>
          <div className="topbar-actions">
            <span className="topbar-greeting">
              {greeting}, {username}
            </span>
            <div className="profile-menu-wrap" ref={profileMenuRef}>
              <button
                className="profile-trigger"
                onClick={() => setProfileMenuOpen((open) => !open)}
                title="Account menu"
                aria-label="Account menu"
                aria-expanded={profileMenuOpen}
                aria-haspopup="menu"
              >
                {initials || <User size={18} />}
              </button>

              {profileMenuOpen && (
                <div className="profile-menu" role="menu">
                  <div className="profile-menu-header">
                    <div className="profile-avatar">{initials || "A"}</div>
                    <div className="profile-identity">
                      <strong>{displayName}</strong>
                      <span className={`badge ${activeStatus}`}>
                        <span className="badge-dot" /> {activeStatus}
                      </span>
                    </div>
                  </div>

                  <button
                    className="profile-menu-item"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      onToast("Profile page is not set up yet.", "success");
                    }}
                    role="menuitem"
                  >
                    <User size={16} />
                    Profile
                  </button>

                  <button
                    className="profile-menu-item"
                    onClick={toggleTheme}
                    role="menuitem"
                  >
                    {theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
                    <span>Theme</span>
                    <span className="profile-menu-meta">
                      {theme === "dark" ? "Dark mode" : "Light mode"}
                    </span>
                  </button>

                  <div className="profile-menu-divider" />

                  <button
                    className="profile-menu-item"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      onToast("Settings page is not set up yet.", "success");
                    }}
                    role="menuitem"
                  >
                    <Settings size={16} />
                    Settings
                  </button>

                  <div className="profile-menu-divider" />

                  <button
                    className="profile-menu-item danger"
                    onClick={() => handleLogout()}
                    role="menuitem"
                  >
                    <LogOut size={16} />
                    Signout
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/clock" element={<ClockPage onToast={onToast} />} />
          <Route
            path="/attendance"
            element={<AttendancePage onToast={onToast} />}
          />
          <Route
            path="/employees"
            element={<EmployeesPage onToast={onToast} />}
          />
          <Route
            path="/schedule"
            element={<SchedulePage onToast={onToast} />}
          />
          <Route path="/leaves" element={<LeavesPage onToast={onToast} />} />
          <Route path="/drivers" element={<DriversPage onToast={onToast} />} />
          <Route
            path="/analytics"
            element={<AnalyticsPage onToast={onToast} />}
          />
        </Routes>
      </div>

      {toasts.map((t) => (
        <Toast
          key={t.id}
          message={t.message}
          type={t.type}
          onClose={() => removeToast(t.id)}
        />
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
