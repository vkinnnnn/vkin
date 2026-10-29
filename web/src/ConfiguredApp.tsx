// Everything that needs Supabase. Loaded lazily so the public landing page stays small.
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { supabase } from './lib/supabase';
import AppShell from './pages/AppShell';
import CopilotDetail from './pages/CopilotDetail';
import Copilots from './pages/Copilots';
import NotFound from './pages/NotFound';
import Privacy from './pages/Privacy';
import Profile from './pages/Profile';
import SignIn from './pages/SignIn';
import ThreadPage from './pages/ThreadPage';

function InnerRoutes() {
  // Keyed on the sign-out counter so every page component (and its state) is discarded on sign-out.
  const { epoch } = useAuth();
  return (
    <Routes key={epoch}>
      <Route path="/signin" element={<SignIn />} />
      <Route path="/app" element={<AppShell />}>
        <Route index element={<Navigate to="copilots" replace />} />
        <Route path="copilots" element={<Copilots />} />
        <Route path="copilots/:copilotId" element={<CopilotDetail />} />
        <Route path="copilots/:copilotId/threads/:threadId" element={<ThreadPage />} />
        <Route path="profile" element={<Profile />} />
        <Route path="privacy" element={<Privacy />} />
        <Route path="*" element={<Navigate to="/app/copilots" replace />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function ConfiguredApp() {
  if (!supabase) return null; // unreachable: App only renders this when configured
  return (
    <AuthProvider client={supabase}>
      <InnerRoutes />
    </AuthProvider>
  );
}
