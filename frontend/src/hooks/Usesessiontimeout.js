// hooks/useSessionTimeout.js
import { useEffect, useRef, useCallback } from 'react';
import { getSession, touchSession, clearSession, getSessionInvalidReason } from '../utils/session.js';

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
const CHECK_INTERVAL_MS = 15 * 1000; // check every 15s — cheap, feels instant enough

/**
 * Call this once near the top of your app (e.g. in App.jsx), while logged in.
 * onLogout(reason) fires with reason 'idle' or 'expired' when the session should end.
 */
export function useSessionTimeout(isLoggedIn, onLogout) {
  const onLogoutRef = useRef(onLogout);
  onLogoutRef.current = onLogout;

  const handleActivity = useCallback(() => {
    touchSession();
  }, []);

  useEffect(() => {
    if (!isLoggedIn) return;

    ACTIVITY_EVENTS.forEach(evt => window.addEventListener(evt, handleActivity, { passive: true }));

    const interval = setInterval(() => {
      const session = getSession();
      const reason = getSessionInvalidReason(session);
      if (reason) {
        clearSession();
        clearInterval(interval);
        onLogoutRef.current?.(reason);
      }
    }, CHECK_INTERVAL_MS);

    // also check immediately in case the tab was reopened after being closed for hours
    const initialReason = getSessionInvalidReason(getSession());
    if (initialReason) {
      clearSession();
      onLogoutRef.current?.(initialReason);
    }

    return () => {
      ACTIVITY_EVENTS.forEach(evt => window.removeEventListener(evt, handleActivity));
      clearInterval(interval);
    };
  }, [isLoggedIn, handleActivity]);
}