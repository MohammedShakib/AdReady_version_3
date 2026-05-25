import React, { useEffect } from 'react';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import SuperAdminDashboard from './pages/SuperAdminDashboard';
import './App.css';

const DEV_AUTH_BYPASS_ENABLED = String(import.meta.env.VITE_ALLOW_DEV_AUTH_BYPASS || '').toLowerCase() === 'true';
const DEV_AUTH_BYPASS_TOKEN = String(import.meta.env.VITE_DEV_AUTH_BYPASS_TOKEN || 'dev-auth-bypass').trim();
const DEV_AUTH_BYPASS_USERNAME = String(import.meta.env.VITE_DEV_AUTH_BYPASS_USERNAME || 'sadmin').trim();

const isSuperAdminSession = () => {
  const marker = localStorage.getItem('isSuperAdmin');
  if (marker === 'true') return true;
  if (marker === 'false') return false;
  const username = String(localStorage.getItem('username') || '').toLowerCase();
  return username === 'sadmin';
};

const DevAuthBootstrap = () => {
  useEffect(() => {
    if (!DEV_AUTH_BYPASS_ENABLED) return;
    localStorage.setItem('authToken', DEV_AUTH_BYPASS_TOKEN);
    localStorage.setItem('username', DEV_AUTH_BYPASS_USERNAME);
    localStorage.setItem('userId', 'dev-bypass');
    localStorage.setItem('userRole', 'admin');
    localStorage.setItem('isSuperAdmin', 'true');
  }, []);

  return null;
};

// Simple PrivateRoute wrapper
const PrivateRoute = ({ children }) => {
  const authToken = localStorage.getItem('authToken');
  const isAuthenticated = Boolean(authToken);
  return isAuthenticated ? children : <Navigate to="/login" replace />;
};

const DashboardRoute = () => {
  const authToken = localStorage.getItem('authToken');
  const isAuthenticated = Boolean(authToken);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (isSuperAdminSession()) return <Navigate to="/admin" replace />;
  return <Dashboard />;
};

// AdminRoute wrapper
const AdminRoute = ({ children }) => {
  const authToken = localStorage.getItem('authToken');
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
        <Route
          path="/"
          element={DEV_AUTH_BYPASS_ENABLED ? <Navigate to="/admin" replace /> : <LandingPage />}
        />
        <Route
          path="/login"
          element={DEV_AUTH_BYPASS_ENABLED ? <Navigate to="/admin" replace /> : <Login />}
        />
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
