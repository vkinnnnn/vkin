import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Brand, Notice, TextField } from '../components/ui';
import { useAuth } from '../lib/auth';
import { googleEnabled } from '../lib/config';
import { usePageTitle } from '../lib/hooks';

const RESEND_SECONDS = 30;

function friendly(message: string, status?: number): string {
  if (status === 429 || /rate limit|too many|security purposes/i.test(message)) {
    return 'Too many attempts. Wait a minute, then try again.';
  }
  if (/expired|invalid/i.test(message) && /token|otp|code/i.test(message)) {
    return 'That code is wrong or has expired. Check the newest email, or request a new code.';
  }
  if (/valid email|invalid.*email|email.*invalid/i.test(message)) return 'Enter a valid email address.';
  if (/signups? not allowed|not allowed/i.test(message)) return 'Sign-ups are not open for this address.';
  return message || 'Something went wrong. Try again.';
}

/** A magic link that failed or expired comes back with the error in the URL hash. */
function linkErrorFromUrl(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const desc = params.get('error_description');
  if (!desc) return null;
  return /expired|invalid/i.test(desc)
    ? 'That sign-in link is invalid or has expired. Request a new code below.'
    : desc.replace(/\+/g, ' ');
}

export default function SignIn() {
  usePageTitle('Sign in');
  const { client, user, status, farewell, clearFarewell } = useAuth();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => linkErrorFromUrl());
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  if (status === 'ready' && user) return <Navigate to={farewell ? '/app' : (from ?? '/app')} replace />;

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    const address = email.trim();
    if (!address) {
      setError('Enter your email address.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await client.auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: `${window.location.origin}/app` },
    });
    setBusy(false);
    if (err) {
      setError(friendly(err.message, err.status));
      return;
    }
    clearFarewell();
    setStep('code');
    setCode('');
    setCooldown(RESEND_SECONDS);
  }

  async function continueWithGoogle() {
    setBusy(true);
    setError(null);
    const { error: err } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/app` },
    });
    // On success the browser leaves for Google, so only a failure needs handling here.
    if (err) {
      setBusy(false);
      setError(friendly(err.message, err.status));
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    const token = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(token)) {
      setError('Enter the 6-digit code from the email.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await client.auth.verifyOtp({ email: email.trim(), token, type: 'email' });
    setBusy(false);
    if (err) setError(friendly(err.message, err.status));
    // On success the auth listener sets the user and this page redirects.
  }

  return (
    <div className="center-page">
      <header className="site-header">
        <div className="wrap">
          <Brand />
          <nav className="nav" aria-label="Primary"><Link to="/">Back to home</Link></nav>
        </div>
      </header>
      <main id="main" className="auth-main" tabIndex={-1}>
        <div className="card auth-card">
          <h1>Sign in</h1>
          {farewell?.deleted && <Notice kind="ok">Your Vkin data was deleted and you have been signed out.</Notice>}
          {farewell && !farewell.deleted && <Notice kind="ok">You are signed out.</Notice>}
          {farewell?.warning && (
            <Notice kind="warn">This device is signed out. The server reported a problem while ending the session: {farewell.warning}</Notice>
          )}
          {error && <Notice kind="error">{error}</Notice>}

          {step === 'email' && googleEnabled && (
            <>
              <button type="button" className="btn google-btn" disabled={busy} onClick={() => void continueWithGoogle()}>
                Continue with Google
              </button>
              <p className="or-divider"><span>or</span></p>
            </>
          )}

          {step === 'email' ? (
            <form onSubmit={sendCode} noValidate>
              <p className="muted">No password. We email you a 6-digit code.</p>
              <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" inputMode="email" required />
              <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Email me a code'}</button>
            </form>
          ) : (
            <form onSubmit={verify} noValidate>
              <p>
                We sent a code to <strong>{email.trim()}</strong>. It can take a minute to arrive.
              </p>
              <TextField
                label="6-digit code" value={code} onChange={(v) => setCode(v.replace(/[^\d\s]/g, ''))} maxLength={7}
                autoComplete="one-time-code" inputMode="numeric" className="code" required
              />
              <div className="row">
                <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Sign in'}</button>
                <button type="button" className="btn" disabled={busy || cooldown > 0} onClick={() => void sendCode()}>
                  {cooldown > 0 ? `Resend in ${cooldown}s` : 'Send a new code'}
                </button>
              </div>
              <p className="hint" style={{ marginTop: '1rem' }}>
                Magic link fallback: if the email contains a sign-in link instead of (or as well as) a code, open the link in this
                browser. Links work once and expire.
              </p>
              <p style={{ marginTop: '0.5rem' }}>
                <button type="button" className="btn ghost small" onClick={() => { setStep('email'); setError(null); }}>
                  Use a different email
                </button>
              </p>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
