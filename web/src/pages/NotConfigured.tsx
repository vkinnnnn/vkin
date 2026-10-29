import { Link } from 'react-router-dom';
import { Brand, Notice } from '../components/ui';
import { usePageTitle } from '../lib/hooks';

export default function NotConfigured() {
  usePageTitle('Not configured yet');
  return (
    <div className="center-page">
      <header className="site-header">
        <div className="wrap">
          <Brand />
          <nav className="nav" aria-label="Primary"><Link to="/">Back to home</Link></nav>
        </div>
      </header>
      <main id="main" className="auth-main" tabIndex={-1}>
        <div className="card auth-card" style={{ maxWidth: 560 }}>
          <h1>Not configured yet</h1>
          <Notice kind="warn">
            Sign-in and the dashboard need a Supabase project, and this build was made without one. Nothing here is simulated, so
            there is nothing to show until it is connected.
          </Notice>
          <p>To connect it, create <code>web/.env.local</code> with:</p>
          <pre className="card flat" style={{ overflowX: 'auto' }}><code>{`VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<public anon key>`}</code></pre>
          <p>Then restart the dev server or rebuild. Use the public anon key only, never a service role key.</p>
          <p><Link to="/">Back to the home page</Link></p>
        </div>
      </main>
    </div>
  );
}
