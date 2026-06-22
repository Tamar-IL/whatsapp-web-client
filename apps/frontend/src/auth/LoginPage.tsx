import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { ApiError } from '../api/client';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate('/app', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Could not sign in. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-chat-list">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-lg bg-white p-8 shadow-md"
        autoComplete="on"
      >
        <h1 className="mb-1 text-2xl font-semibold text-brand-primary">Sign in</h1>
        <p className="mb-6 text-sm text-ink-muted">Manage your Business conversations.</p>

        <label className="mb-1 block text-sm font-medium text-ink" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mb-4 w-full rounded border border-gray-300 bg-white px-3 py-2 focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
        />

        <label className="mb-1 block text-sm font-medium text-ink" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded border border-gray-300 bg-white px-3 py-2 focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary"
        />

        {error && (
          <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-brand-action px-4 py-2 font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
