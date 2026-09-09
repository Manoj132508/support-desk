import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Button from './components/primitives/Button.jsx';
import LoginPage from './routes/LoginPage.jsx';
import ScaffoldPage from './routes/ScaffoldPage.jsx';

/**
 * Route map, mirroring the seven screens in Phase 4 section 3.
 *
 * The customer sees two of them. Everything under /console is staff-only, and
 * policy and audit narrow further to lead/admin -- the same role split as the
 * actor table in Phase 1 section 2.
 */
function AppRoutes() {
  const { user, bootstrapping, logout } = useAuth();

  if (bootstrapping) return null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="app-header__brand">
          AI Support Desk
        </Link>
        {user && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <span style={{ color: 'var(--color-muted)' }}>
              {user.name ?? user.email} · {user.role}
            </span>
            <Button variant="ghost" size="sm" onClick={logout}>
              Sign out
            </Button>
          </div>
        )}
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route
            path="/"
            element={
              <ProtectedRoute>
                <ScaffoldPage title="Conversation" phase="Phase 9 and 10" />
              </ProtectedRoute>
            }
          />

          <Route
            path="/console"
            element={
              <ProtectedRoute roles={['agent', 'lead', 'admin']}>
                <ScaffoldPage title="Agent console" phase="Phase 11" />
              </ProtectedRoute>
            }
          />

          <Route
            path="/console/policies"
            element={
              <ProtectedRoute roles={['lead', 'admin']}>
                <ScaffoldPage title="Policy rules" phase="Phase 10" />
              </ProtectedRoute>
            }
          />

          <Route
            path="/console/audit"
            element={
              <ProtectedRoute roles={['lead', 'admin']}>
                <ScaffoldPage title="Audit" phase="Phase 10" />
              </ProtectedRoute>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
