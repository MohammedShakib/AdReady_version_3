import React from 'react';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import SuperAdminDashboard from './pages/SuperAdminDashboard';
import './App.css';

const isSuperAdminSession = () => {
  const marker = localStorage.getItem('isSuperAdmin');
  if (marker === 'true') return true;
  if (marker === 'false') return false;
  const username = String(localStorage.getItem('username') || '').toLowerCase();
  return username === 'sadmin';
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
