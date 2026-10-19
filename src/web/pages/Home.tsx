import { useAuth } from '../lib/auth';

export function HomePage() {
  const { me } = useAuth();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Hi {me?.displayName || me?.username}</h1>
      <div className="card text-sm text-muted">Your library, requests and what's coming up will appear here.</div>
    </div>
  );
}
