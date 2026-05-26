import React, { useEffect } from 'react';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import SuperAdminDashboard from './pages/SuperAdminDashboard';
import './App.css';

const DEV_AUTH_BYPASS_ENABLED = false;
const DEV_AUTH_BYPASS_TOKEN = String(import.meta.env.VITE_DEV_AUTH_BYPASS_TOKEN || 'dev-auth-bypass').trim();
const DEV_AUTH_BYPASS_USERNAME = String(import.meta.env.VITE_DEV_AUTH_BYPASS_USERNAME || 'sadmin').trim();
const DEV_AUTH_BYPASS_LOGOUT_FLAG_KEY = 'devAuthBypassLoggedOut';
const safeStorage = {
  get(key) {
    try {
      if (typeof window === 'undefined') return null;
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (typeof window === 'undefined') return false;
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      if (typeof window === 'undefined') return false;
      window.localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  },
};

const isSuperAdminSession = () => {
  if (typeof window === 'undefined') return false;
  const marker = safeStorage.get('isSuperAdmin');
  if (marker === 'true') return true;
  if (marker === 'false') return false;
  const username = String(safeStorage.get('username') || '').toLowerCase();
  return username === 'sadmin';
};

const DevAuthBootstrap = () => {
  useEffect(() => {
    if (!DEV_AUTH_BYPASS_ENABLED) return;
    if (typeof window === 'undefined') return;
    const wasManuallyLoggedOut = safeStorage.get(DEV_AUTH_BYPASS_LOGOUT_FLAG_KEY) === 'true';
    if (wasManuallyLoggedOut) return;
    safeStorage.set('authToken', DEV_AUTH_BYPASS_TOKEN);
    safeStorage.set('username', DEV_AUTH_BYPASS_USERNAME);
    safeStorage.set('userId', 'dev-bypass');
    safeStorage.set('userRole', 'admin');
    safeStorage.set('isSuperAdmin', 'true');
  }, []);

  return null;
};

// Simple PrivateRoute wrapper
const PrivateRoute = ({ children }) => {
  const authToken = typeof window === 'undefined' ? '' : safeStorage.get('authToken');
  const isAuthenticated = Boolean(authToken);
  return isAuthenticated ? children : <Navigate to="/login" replace />;
};

const DashboardRoute = () => {
  const authToken = typeof window === 'undefined' ? '' : safeStorage.get('authToken');
  const isAuthenticated = Boolean(authToken);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (isSuperAdminSession()) return <Navigate to="/admin" replace />;
  return <Dashboard />;
};

// AdminRoute wrapper
const AdminRoute = ({ children }) => {
  const authToken = typeof window === 'undefined' ? '' : safeStorage.get('authToken');
  const isAuthenticated = Boolean(authToken);
  const isAdmin = isSuperAdminSession();
  
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!isAdmin) return <Navigate to="/dashboard" replace />;
  
  return children;
};

function App() {
  return (
    <Router>
      <DevAuthBootstrap />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<Login />} />
        <Route 
          path="/dashboard" 
          element={
            <PrivateRoute>
              <DashboardRoute />
            </PrivateRoute>
          } 
        />
        <Route 
          path="/admin" 
          element={
            <AdminRoute>
              <SuperAdminDashboard />
            </AdminRoute>
          } 
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
