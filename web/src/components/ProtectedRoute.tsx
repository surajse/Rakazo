import { useEffect } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { getAccessToken } from '../api/client';
import { Layout } from './Layout';
import { Spinner } from './ui';

export function ProtectedRoute() {
  const { user, initialized, refreshUser } = useAuth();

  useEffect(() => {
    if (!initialized && getAccessToken()) {
      refreshUser();
    } else if (!initialized) {
      // No token at all; mark initialized so we redirect to login.
      useAuth.setState({ initialized: true });
    }
  }, [initialized, refreshUser]);

  if (!initialized) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size={28} />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}
