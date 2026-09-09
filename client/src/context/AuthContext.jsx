import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Session state for the whole app.
 *
 * The client holds NO TOKEN. The session lives in an httpOnly cookie the
 * browser attaches automatically and JavaScript cannot read, so there is
 * nothing here for an XSS payload to steal. What this context holds is the
 * *answer to a question* -- "who am I?" -- fetched from the server on boot.
 *
 * That fetch is the `bootstrapping` state, and it matters more than it looks.
 * Without it, every guarded route flickers to the login screen on first paint
 * while the session check is still in flight, and a signed-in user reloading
 * the page gets bounced to login for a moment. So routes render nothing until
 * the question has been answered once.
 */

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [bootstrapping, setBootstrapping] = useState(true);

  useEffect(() => {
    let cancelled = false;

    api
      .get('/api/auth/me')
      .then((data) => {
        if (!cancelled) setUser(data?.user ?? null);
      })
      .catch(() => {
        // A 401 here is the normal "not signed in" answer, not a failure. It is
        // also what we get while the API does not exist yet (Phase 6 builds
        // it), which is why this deliberately does not surface an error.
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setBootstrapping(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await api.post('/api/auth/login', { email, password });
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      // Clear local state even if the request failed. Leaving a signed-out user
      // looking signed-in is the worse of the two failures.
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      bootstrapping,
      login,
      logout,
      isStaff: Boolean(user) && user.role !== 'customer',
      hasRole: (...roles) => Boolean(user) && roles.includes(user.role),
    }),
    [user, bootstrapping, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
