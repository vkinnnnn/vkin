import { Link } from 'react-router-dom';
import { Brand, Notice } from '../components/ui';
import { usePageTitle } from '../lib/hooks';

export default function NotFound() {
  usePageTitle('Page not found');
  return (
    <div className="center-page">
      <header className="site-header">
        <div className="wrap"><Brand /></div>
      </header>
      <main id="main" className="auth-main" tabIndex={-1}>
        <div className="card auth-card">
          <h1>Page not found</h1>
          <Notice kind="info">There is nothing at this address.</Notice>
          <p><Link to="/">Go to the home page</Link></p>
        </div>
      </main>
    </div>
  );
}
