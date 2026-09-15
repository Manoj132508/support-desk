import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Input from '../components/primitives/Input.jsx';
import Button from '../components/primitives/Button.jsx';
import PolicyBlock from '../components/PolicyBlock.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { ERROR_KIND } from '../lib/outcomes.js';
import { safeRedirect } from '../lib/safeRedirect.js';

/**
 * Sign in. The form shape is ported from Project 2; the error rendering is not.
 *
 * A failed login is a FAULT-language message, not a policy one. The policy
 * language means "a rule declined an action"; a wrong password is neither.
 * Reaching for PolicyBlock everywhere would blur exactly the distinction Phase
 * 4 section 5 is built on -- so it is used here with `fault`, deliberately.
 *
 * Phase 12 added two things. The ORGANISATION, because an account is unique
 * within a tenant and an email alone does not say which account is meant. And
 * a checked redirect, because where the page goes afterwards comes from the
 * address the visitor arrived at.
 */
export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [tenantSlug, setTenantSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password, tenantSlug);
      navigate(safeRedirect(location.state?.from), { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scaffold-page" style={{ maxWidth: 380 }}>
      <h1>Sign in</h1>
      <form onSubmit={onSubmit} noValidate>
        <Input
          label="Organisation"
          value={tenantSlug}
          autoComplete="organization"
          onChange={(e) => setTenantSlug(e.target.value)}
          required
        />
        <Input
          label="Email"
          type="email"
          value={email}
          autoComplete="username"
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          label="Password"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && (
          <PolicyBlock
            kind={ERROR_KIND.FAULT}
            customerMessage={
              error.status === 401
                ? 'That organisation, email and password combination was not recognised.'
                : 'We could not sign you in just now. Please try again.'
            }
          />
        )}
        <Button type="submit" loading={busy} fullWidth>
          Sign in
        </Button>
      </form>
    </div>
  );
}
