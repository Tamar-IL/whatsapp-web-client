import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { ApiError } from '../api/client';

type Mode = 'password' | 'code';

const inputClass =
  'w-full rounded border border-gray-300 bg-white px-3 py-2 focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary';

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
      {!open && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

export function LoginPage() {
  const { login, requestLoginCode, loginWithCode } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function run(action: () => Promise<void>, fallback: string) {
    setError(null);
    setSubmitting(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallback);
    } finally {
      setSubmitting(false);
    }
  }

  async function sendCode() {
    await run(async () => {
      const sentTo = await requestLoginCode();
      setMode('code');
      setCode('');
      setInfo(`A 6-digit code was sent to ${sentTo}. It expires in 10 minutes.`);
    }, 'Could not send the code. Please try again.');
  }

  function backToPassword() {
    setMode('password');
    setError(null);
    setInfo(null);
    setCode('');
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      if (mode === 'password') await login(email, password);
      else await loginWithCode(code);
      navigate('/app', { replace: true });
    }, 'Could not sign in. Please try again.');
  }

  return (
    <div className="flex h-full items-center justify-center bg-chat-list">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-lg bg-white p-8 shadow-md"
        autoComplete="on"
      >
        <h1 className="mb-1 text-2xl font-semibold text-brand-primary">Sign in</h1>
        <p className="mb-6 text-sm text-ink-muted">
          {mode === 'password'
            ? 'Manage your Business conversations.'
            : 'Enter the code we emailed you.'}
        </p>

        {mode === 'password' && (
          <>
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
              className={`mb-4 ${inputClass}`}
            />

            <label className="mb-1 block text-sm font-medium text-ink" htmlFor="password">
              Password
            </label>
            <div className="relative mb-2">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`${inputClass} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-ink-muted hover:text-ink"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                <EyeIcon open={showPassword} />
              </button>
            </div>
            <div className="mb-4 text-right">
              <button
                type="button"
                disabled={submitting}
                onClick={() => void sendCode()}
                className="text-sm text-brand-primary hover:underline disabled:opacity-50"
              >
                Forgot password? Email me a code
              </button>
            </div>
          </>
        )}

        {mode === 'code' && (
          <>
            <label className="mb-1 block text-sm font-medium text-ink" htmlFor="code">
              6-digit code
            </label>
            <input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className={`mb-2 ${inputClass} text-center text-lg tracking-[0.5em]`}
            />
            <div className="mb-4 flex justify-between text-sm">
              <button
                type="button"
                disabled={submitting}
                onClick={() => void sendCode()}
                className="text-brand-primary hover:underline disabled:opacity-50"
              >
                Resend code
              </button>
              <button type="button" onClick={backToPassword} className="text-ink-muted hover:underline">
                Back to password
              </button>
            </div>
          </>
        )}

        {info && !error && (
          <div className="mb-4 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            {info}
          </div>
        )}

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
          {submitting ? 'Please wait…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
