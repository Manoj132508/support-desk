import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Route guard.
 *
 * Worth being explicit about what this is and is not. It is a CONVENIENCE: it
 * stops a signed-out user seeing a broken screen and stops an agent seeing a
 * link they cannot use. It is NOT security. Every one of these routes is also
 * guarded server-side, and the server's answer is the only one that counts --
 * anyone can edit client-side state in a debugger.
 *
 * The same reasoning as the console rendering only legal ticket transitions
 * (Phase 4 section 6): the UI narrowing the options is help, never enforcement,
 * and both layers exist on purpose.
 *
 * `state={{ from }}` lets the login page send the user back where they were
 * trying to go, instead of dumping everyone on a generic landing page.
 */
export default function ProtectedRoute({ children, roles }) {
  const { user, bootstrapping } = useAuth();
  const location = useLocation();

  // Render nothing until the session question has been answered once, or a
  // signed-in user reloading the page flashes past the login screen.
  if (bootstrapping) return null;

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return children;
}
