import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from '../components/primitives/Button.jsx';
import Input from '../components/primitives/Input.jsx';
import PolicyBlock from '../components/PolicyBlock.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import styles from './AccountPage.module.css';

/**
 * Deleting your account. FR-13.4.
 *
 * The page says plainly what goes and what stays, because the honest answer is
 * not "everything goes". A record of each action proposed on the customer's
 * orders is kept, without their name or email, since that record is the
 * evidence nothing was done without authorisation (ADR 0006). A deletion page
 * that implied otherwise would be the product misstating its own design.
 *
 * Two deliberate steps before the button works: the password, which the server
 * checks, and an acknowledgement that it cannot be undone, which is only for
 * the person.
 */

function messageFor(error) {
  if (error?.status === 403) return 'That password was not right. Your account has not been changed.';
  if (error?.status === 429) return 'Too many attempts. Please wait a few minutes before trying again.';
  return 'Your account could not be deleted just now. Please try again.';
}

export default function AccountPage({ client = api }) {
  const { forgetUser } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function onSubmit(event) {
    event.preventDefault();
    if (!password || !understood) return;
    setBusy(true);
    setError(null);
    try {
      await client.post('/api/account/delete', { password });
      // The server has already ended the session. The page only has to stop
      // showing a signed-in person.
      navigate('/login', { replace: true, state: { notice: 'account-deleted' } });
      forgetUser();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Delete your account</h1>

      <section aria-labelledby="removed-heading">
        <h2 id="removed-heading" className={styles.subheading}>
          What is removed
        </h2>
        <ul className={styles.list}>
          <li>Your sign-in details: your email address and password.</li>
          <li>Your name and email on your customer profile.</li>
          <li>Your conversations with the assistant, and every message in them.</li>
        </ul>
      </section>

      <section aria-labelledby="kept-heading">
        <h2 id="kept-heading" className={styles.subheading}>
          What is kept, without your name or email
        </h2>
        <ul className={styles.list}>
          <li>
            A record of each action the assistant proposed on your orders, and whether it was allowed. That
            record is how the service shows it never acted without authorisation, so it is not deleted.
          </li>
          <li>Your orders, which are business records.</li>
          <li>Any support tickets, with agents’ notes removed.</li>
        </ul>
      </section>

      <form className={styles.form} onSubmit={onSubmit}>
        <Input
          label="Your password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <label className={styles.check}>
          <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
          I understand this cannot be undone
        </label>
        {error && <PolicyBlock kind="fault" customerMessage={messageFor(error)} />}
        <div>
          <Button type="submit" variant="danger" loading={busy} disabled={!password || !understood}>
            Delete my account
          </Button>
        </div>
      </form>
    </div>
  );
}
