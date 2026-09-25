import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage, SignupPage } from './pages/Auth';
import { DashboardPage } from './pages/Dashboard';
import { BotDetailPage } from './pages/BotDetail';
import { NewBotPage } from './pages/NewBot';
import { BotSettingsPage } from './pages/BotSettings';
import { SubBotsPage } from './pages/SubBots';
import { ApprovalsPage } from './pages/Approvals';
import { AuditPage } from './pages/Audit';
import { SettingsPage } from './pages/Settings';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/bots/new" element={<NewBotPage />} />
          <Route path="/bots/:id" element={<BotDetailPage />} />
          <Route path="/bots/:id/settings" element={<BotSettingsPage />} />
          <Route path="/bots/:id/subbots" element={<SubBotsPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
