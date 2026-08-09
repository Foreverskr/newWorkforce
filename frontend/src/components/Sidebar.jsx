import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Users, Clock, Calendar, BarChart2, FileText
} from 'lucide-react';
import { format } from 'date-fns';
import tripwiseLogo from '../../picture/tripwise_icon.png';

const navItems = [
  { to: '/',           label: 'Dashboard',        icon: LayoutDashboard },
  { to: '/clock',      label: 'Clock In / Out',   icon: Clock           },
  { to: '/attendance', label: 'Timesheet Management',        icon: Calendar        },
  { to: '/employees',  label: 'Status & Biometrics Management',         icon: Users           },
  { to: '/schedule',  label: 'Shift & Schedule Management',         icon: Calendar           },
  { to: '/leaves',     label: 'Leave Management',  icon: FileText        },
  { to: '/drivers',    label: 'Drivers',           icon: Users           },
  { to: '/analytics',  label: 'Analytics',         icon: BarChart2       },
];

export default function Sidebar() {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="sidebar-brand-mark" aria-hidden="true">
          <img src={tripwiseLogo} alt="" />
        </div>
        <div className="sidebar-brand-copy">
          <h1>Trip<span>Wise</span></h1>
          <p>Workforce Management</p>
        </div>
      </div>

      <nav className="sidebar-nav">
        <span className="nav-section-label">Main</span>
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="live-clock">{format(time, 'HH:mm:ss')}</div>
        <div className="live-date">{format(time, 'EEE, MMM d yyyy')}</div>
      </div>
    </aside>
  );
}
