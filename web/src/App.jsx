import { lazy, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { GuildProvider } from './GuildContext.jsx';
import { SystemProvider, useSystem } from './SystemContext.jsx';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { LiveProvider } from './LiveContext.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import ForcePasswordChange from './pages/ForcePasswordChange.jsx';
import Onboarding from './pages/Onboarding.jsx';

// Route pages load on demand so Markdown rendering, charts and the settings
// screens aren't in the bundle a visitor downloads before the first paint.
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Live = lazy(() => import('./pages/Live.jsx'));
const Meetings = lazy(() => import('./pages/Meetings.jsx'));
const Reading = lazy(() => import('./pages/Reading.jsx'));
const ActionItems = lazy(() => import('./pages/ActionItems.jsx'));
const Campaigns = lazy(() => import('./pages/Campaigns.jsx'));
const Campaign = lazy(() => import('./pages/Campaign.jsx'));
const Analytics = lazy(() => import('./pages/Analytics.jsx'));
const Search = lazy(() => import('./pages/Search.jsx'));
const Commands = lazy(() => import('./pages/Commands.jsx'));
const Setup = lazy(() => import('./pages/Setup.jsx'));
const Account = lazy(() => import('./pages/Account.jsx'));
const Import = lazy(() => import('./pages/Import.jsx'));
const NotFound = lazy(() => import('./pages/NotFound.jsx'));

function Spinner() {
  return (
    <div className="min-h-screen grid place-items-center bg-bg">
      <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
    </div>
  );
}

function RetryCard({ title, message, onRetry }) {
  return (
    <div className="min-h-screen grid place-items-center bg-bg text-ink p-6">
      <div className="card p-7 max-w-[400px] w-full text-center">
        <h1 className="font-display text-lg font-extrabold mb-1">{title}</h1>
        <p className="text-sm text-muted mb-5">{message}</p>
        <button onClick={onRetry} className="btn btn-primary !py-2.5 w-full justify-center">Retry</button>
      </div>
    </div>
  );
}

// First run: this server manages the bot but has no Discord credentials yet.
// Once onboarding starts it stays up until the bot actually connects, so the
// "Connecting…" state and a rejected token's error are shown there instead of
// dropping the user onto an empty dashboard the moment credentials are saved.
function useOnboarding(status) {
  const firstRun = Boolean(status?.managed && !status?.bot?.hasCreds && !status?.bot?.connected);
  const connected = Boolean(status?.bot?.connected);
  const [sticky, setSticky] = useState(false);
  useEffect(() => {
    if (firstRun) setSticky(true);
    else if (connected) setSticky(false);
  }, [firstRun, connected]);
  return firstRun || (sticky && !connected);
}

// Authenticated shell: onboarding gate + the routed dashboard.
function Shell() {
  const { status, loading, error, refresh } = useSystem();
  const onboarding = useOnboarding(status);
  if (loading) return <Spinner />;
  if (!status && error) return <RetryCard title="Can't load server status" message={error} onRetry={refresh} />;
  if (onboarding) return <Onboarding />;

  return (
    <GuildProvider>
      <LiveProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="/live" element={<Live />} />
              <Route path="/meetings" element={<Meetings />} />
              <Route path="/meetings/:id" element={<Reading />} />
              <Route path="/import" element={<Import />} />
              <Route path="/campaigns" element={<Campaigns />} />
              <Route path="/campaigns/:id" element={<Campaign />} />
              <Route path="/action-items" element={<ActionItems />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/search" element={<Search />} />
              <Route path="/commands" element={<Commands />} />
              <Route path="/setup" element={<Setup />} />
              <Route path="/account" element={<Account />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </LiveProvider>
    </GuildProvider>
  );
}

// Auth gate: show the login screen until a session exists, then mount the
// system-status provider + dashboard shell. If the backend has no auth routes
// (an older server still running), authEnabled is false and we run open so the
// dashboard never gets trapped behind a login it can't satisfy. A transient
// /auth/me failure shows a retry card rather than failing open.
function Gate() {
  const { user, authEnabled, loading, error, retry } = useAuth();
  if (loading) return <Spinner />;
  if (error) return <RetryCard title="Can't reach the server" message={error} onRetry={retry} />;
  if (authEnabled && !user) return <Login />;
  // The API is locked until the seeded default password is changed; force it
  // here so the dashboard never mounts against a 403-ing backend.
  if (user?.mustChangePassword) return <ForcePasswordChange />;
  return (
    <SystemProvider>
      <Shell />
    </SystemProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
