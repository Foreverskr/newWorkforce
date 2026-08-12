import { useState } from 'react';
import { ArrowRight, Lock, User } from 'lucide-react';
import { saveSession } from '../utils/session.js';
import loginBg from '../../picture/login_bg.png';
import tripwiseIcon from '../../picture/tripwise_icon.png';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export default function LoginPage({ onLogin }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const set = k => e => {
    setError('');
    setForm(f => ({ ...f, [k]: e.target.value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }

      // Save session (admin + token) with login time + last-activity time,
      // used for the 8hr absolute expiry and the idle timeout.
      saveSession(data.admin, data.token);
      onLogin(data.admin);

    } catch (err) {
      setError('Cannot connect to server. Is the backend running?');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-shell">
      <section
        className="login-hero"
        style={{ backgroundImage: `url(${loginBg})` }}
        aria-label="TripWise operations dashboard"
      >
        <div className="login-hero-overlay" />
        <div className="login-brand">
          <img src={tripwiseIcon} alt="" />
          <span>TripWise.</span>
        </div>

        <div className="login-hero-copy">
          <h1>
            Total Control.
            <span> One Dashboard.</span>
          </h1>
          <p>
            Monitor attendance, workforce, logistics, and operations across all
            integrated subsystems from a single secure portal.
          </p>
        </div>
      </section>

      <section className="login-panel">
        <div className="login-form-wrap">
          <div className="login-heading">
            <h2>Welcome back</h2>
            <p>Sign in to your account</p>
          </div>

          <form onSubmit={handleSubmit} className="login-form" autoComplete="off">
            <div className="login-field">
              <label>Username</label>
              <div className="login-input-wrap">
                <User size={15} />
                <input
                  type="text"
                  value={form.username}
                  onChange={set('username')}
                  placeholder="admin"
                  autoComplete="off"
                  autoFocus
                />
              </div>
            </div>

            <div className="login-field">
              <label>Password</label>
              <div className="login-input-wrap">
                <Lock size={15} />
                <input
                  type="password"
                  value={form.password}
                  onChange={set('password')}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </div>
            </div>

            {error && (
              <div className="login-error">
                {error}
              </div>
            )}

            <button
              type="submit"
              className="login-submit"
              disabled={loading || !form.username || !form.password}
            >
              {loading ? 'Signing in...' : 'Login'}
              <ArrowRight size={15} />
            </button>
          </form>
        </div>

        <footer className="login-footer">
          <span>© 2026 TripWise. All rights reserved.</span>
        </footer>
      </section>
    </div>
  );
}
