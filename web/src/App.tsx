import { Suspense, lazy } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Loading } from './components/ui';
import { isConfigured } from './lib/config';
import Landing from './pages/Landing';
import NotConfigured from './pages/NotConfigured';
import NotFound from './pages/NotFound';

const ConfiguredApp = lazy(() => import('./ConfiguredApp'));

function UnconfiguredRoutes() {
  return (
    <Routes>
      <Route path="/signin" element={<NotConfigured />} />
      <Route path="/app/*" element={<NotConfigured />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route
          path="*"
          element={
            isConfigured ? (
              <Suspense fallback={<div className="auth-main"><Loading /></div>}>
                <ConfiguredApp />
              </Suspense>
            ) : (
              <UnconfiguredRoutes />
            )
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
