import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Button from './components/primitives/Button.jsx';
import LoginPage from './routes/LoginPage.jsx';
import ScaffoldPage from './routes/ScaffoldPage.jsx';
import ConversationPage from './routes/ConversationPage.jsx';

/**
 * Route map, mirroring the seven screens in Phase 4 section 3.
 *
 * The customer sees two of them. Everything under /console is staff-only, and
 * policy and audit narrow further to lead/admin -- the same role split as the
 * actor table in Phase 1 section 2.
 */

/**
 * "/" depends on who is asking. Customers talk to the assistant; staff work the
 * console.
 *
 * Not a role gate on the conversation route: ProtectedRoute sends a user
 * without the right role back to "/", which for staff would be a redirect loop.
 * And a staff member on the customer screen would be invited to raise proposals
 * that the server drops on a staff turn anyway.
 */
function HomeRoute() {
  const { user } = useAuth();
  if (user?.role === 'customer') return <ConversationPage />;
  return <Navigate to="/console" replace />;
}

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
                <HomeRoute />
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
                <ScaffoldPage title="Policy rules" phase="Phase 11" />
              </ProtectedRoute>
            }
          />

          <Route
            path="/console/audit"
            element={
              <ProtectedRoute roles={['lead', 'admin']}>
                <ScaffoldPage title="Audit" phase="Phase 11" />
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
