import { useEffect, useRef } from 'react';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import MinutesCard from '../components/MinutesCard';
import { Brand, Loading } from '../components/ui';
import { useAuth } from '../lib/auth';

export default function AppShell() {
  const { user, status, signOut } = useAuth();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Move focus to the content on route changes so keyboard and screen reader users land in the new page.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [location.pathname]);

  if (status === 'loading') {
    return <div className="auth-main"><Loading what="Checking your session" /></div>;
  }
  if (!user) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;

  async function handleSignOut() {
    await signOut(); // the redirect to /signin happens because the user becomes null
  }

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="app-header">
        <div className="wrap">
          <Brand to="/app" />
          <nav className="app-nav" aria-label="Dashboard">
            <NavLink to="/app/copilots">Copilots</NavLink>
            <NavLink to="/app/profile">Profile</NavLink>
            <NavLink to="/app/privacy">Privacy &amp; data</NavLink>
          </nav>
          <div className="app-user">
            <span className="email" title={user.email ?? undefined}>{user.email ?? 'Signed in'}</span>
            <button type="button" className="btn small" onClick={() => void handleSignOut()}>Sign out</button>
          </div>
        </div>
      </header>
      <main id="main" ref={mainRef} tabIndex={-1} className="app-main">
        <div className="wrap">
          <MinutesCard />
          <Outlet />
        </div>
      </main>
    </>
  );
}
