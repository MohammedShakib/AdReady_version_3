import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wand2, Lock, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { apiUrl } from '../lib/api';

const DEV_AUTH_BYPASS_ENABLED = String(import.meta.env.VITE_ALLOW_DEV_AUTH_BYPASS || '').toLowerCase() === 'true';
const DEV_AUTH_BYPASS_TOKEN = String(import.meta.env.VITE_DEV_AUTH_BYPASS_TOKEN || 'dev-auth-bypass').trim();
const DEV_AUTH_BYPASS_USERNAME = String(import.meta.env.VITE_DEV_AUTH_BYPASS_USERNAME || 'sadmin').trim();

export default function Login() {
  const [authMode, setAuthMode] = useState('signin');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const emailInputRef = useRef(null);
  const passwordInputRef = useRef(null);
  const confirmPasswordInputRef = useRef(null);
  const navigate = useNavigate();
  const isSignup = authMode === 'signup';

  useEffect(() => {
    if (!DEV_AUTH_BYPASS_ENABLED) return;
    localStorage.setItem('authToken', DEV_AUTH_BYPASS_TOKEN);
    localStorage.setItem('username', DEV_AUTH_BYPASS_USERNAME);
    localStorage.setItem('userId', 'dev-bypass');
    localStorage.setItem('userRole', 'admin');
    localStorage.setItem('isSuperAdmin', 'true');
    navigate('/admin', { replace: true });
  }, [navigate]);

  if (DEV_AUTH_BYPASS_ENABLED) {
    return null;
  }

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    const cleanUsername = username.trim();
    const cleanEmail = email.trim().toLowerCase();

    if (!cleanUsername || !password) {
      setError('Username and password are required');
      return;
    }
    if (isSignup && !cleanEmail) {
      setError('Email is required');
      return;
    }
    if (isSignup && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError('Enter a valid email address');
      return;
    }
    if (isSignup && password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (isSignup && password !== confirmPassword) {
      setError('Password and confirm password do not match');
      return;
    }

    setIsSubmitting(true);
    setError('');

    try {
      const endpoint = isSignup ? '/api/auth/signup' : '/api/auth/login';
      const response = await fetch(apiUrl(endpoint), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: cleanUsername,
          ...(isSignup ? { email: cleanEmail } : {}),
          password,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || data?.details || (isSignup ? 'Signup failed' : 'Login failed'));
      }
      if (!data?.token || !data?.user) {
        throw new Error(
          'Auth response missing token. Verify your Vercel API routes or set VITE_API_BASE_URL only if the API is hosted separately.'
        );
      }

      localStorage.setItem('authToken', data?.token || '');
      localStorage.setItem('username', data?.user?.username || cleanUsername);
      localStorage.setItem('userId', data?.user?.id || '');
      localStorage.setItem('userRole', data?.user?.role || 'member');
      const isSuperAdmin = Boolean(
        data?.user?.isSuperAdmin ||
        String(data?.user?.username || cleanUsername).toLowerCase() === 'sadmin'
      );
      localStorage.setItem('isSuperAdmin', isSuperAdmin ? 'true' : 'false');

      if (isSuperAdmin) {
        navigate('/admin', { replace: true });
      } else {
        navigate('/dashboard', { replace: true });
      }
    } catch (err) {
      setError(err?.message || (isSignup ? 'Signup failed' : 'Invalid credentials'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSwitchMode = () => {
    setAuthMode((prev) => (prev === 'signin' ? 'signup' : 'signin'));
    setError('');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4 selection:bg-emerald-500/30">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(52,211,153,0.05)_0,rgba(9,9,11,1)_100%)] pointer-events-none" />

      <div className="w-full max-w-md bg-zinc-900/80 backdrop-blur-xl border border-zinc-800/80 rounded-2xl shadow-2xl p-8 relative z-10">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-4">
            <Wand2 className="w-6 h-6 text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">{isSignup ? 'Create Account' : 'Welcome Back'}</h1>
          <p className="text-zinc-400 text-sm mt-1">
            {isSignup ? 'Create your account to access the dashboard' : 'Sign in to access the dashboard'}
          </p>
        </div>

        <form onSubmit={handleAuthSubmit} className="space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm rounded-lg p-3 text-center">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-zinc-300 ml-1">Username</label>
            <input
              type="text"
              className="w-full bg-zinc-950/50 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50 transition-all font-medium"
              placeholder="Enter username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (isSignup) {
                    emailInputRef.current?.focus();
                  } else {
                    passwordInputRef.current?.focus();
                  }
                }
              }}
            />
          </div>

          {isSignup && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-300 ml-1">Email</label>
              <input
                ref={emailInputRef}
                type="email"
                className="w-full bg-zinc-950/50 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50 transition-all font-medium"
                placeholder="Enter email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    passwordInputRef.current?.focus();
                  }
                }}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-zinc-300 ml-1">Password</label>
            <div className="relative">
              <input
                ref={passwordInputRef}
                type={showPassword ? 'text' : 'password'}
                className="w-full bg-zinc-950/50 border border-zinc-800 rounded-xl pl-4 pr-11 py-3 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50 transition-all font-medium"
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (isSignup && e.key === 'Enter') {
                    e.preventDefault();
                    confirmPasswordInputRef.current?.focus();
                  }
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 transition-colors"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {isSignup && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-300 ml-1">Confirm Password</label>
              <input
                ref={confirmPasswordInputRef}
                type={showPassword ? 'text' : 'password'}
                className="w-full bg-zinc-950/50 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50 transition-all font-medium"
                placeholder="Confirm password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
          )}

          <button
            type="submit"
            className="w-full mt-6 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-xl px-4 py-3 flex items-center justify-center gap-2 transition-colors group shadow-[0_0_15px_rgba(16,185,129,0.2)] disabled:opacity-70 disabled:cursor-not-allowed"
            disabled={isSubmitting}
          >
            {isSubmitting ? (isSignup ? 'Creating Account...' : 'Signing In...') : (isSignup ? 'Create Account' : 'Sign In')}
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </button>
        </form>

        <div className="mt-5 text-center text-sm text-zinc-400">
          {isSignup ? 'Already have an account?' : "Don't have an account?"}
          {' '}
          <button
            type="button"
            onClick={handleSwitchMode}
            className="text-emerald-400 hover:text-emerald-300 font-semibold transition-colors"
          >
            {isSignup ? 'Sign In' : 'Sign Up'}
          </button>
        </div>

        <div className="mt-6 flex items-center justify-center text-xs text-zinc-500 gap-1.5">
          <Lock className="w-3 h-3" />
          <span>{isSignup ? 'New users are created in database users table' : 'Credentials are validated from database users table'}</span>
        </div>
      </div>
    </div>
  );
}
