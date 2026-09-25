import { useState } from 'react';
import { NavLink, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { cx } from '../lib/utils';

const NAV = [
  { to: '/', label: 'Bots', end: true, icon: BotIcon },
  { to: '/bots/new', label: 'New bot', end: false, icon: PlusIcon },
  { to: '/approvals', label: 'Approvals', end: false, icon: ShieldIcon },
  { to: '/audit', label: 'Audit log', end: false, icon: ListIcon },
  { to: '/settings', label: 'Settings', end: false, icon: GearIcon },
];

function BotIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
      <rect x="2" y="4" width="16" height="12" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="7.5" cy="10" r="1.3" fill="currentColor" />
      <circle cx="12.5" cy="10" r="1.3" fill="currentColor" />
      <path d="M10 4V2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="10" cy="2" r="1" fill="currentColor" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
      <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
      <path d="M10 2l6 2.5v5c0 4-2.7 6.8-6 8.5-3.3-1.7-6-4.5-6-8.5v-5L10 2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M7.5 10l1.8 1.8L12.8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ListIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
      <path d="M6.5 5.5h10M6.5 10h10M6.5 14.5h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="3.5" cy="5.5" r="1" fill="currentColor" />
      <circle cx="3.5" cy="10" r="1" fill="currentColor" />
      <circle cx="3.5" cy="14.5" r="1" fill="currentColor" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 2.8v2.2M10 15v2.2M2.8 10h2.2M15 10h2.2M4.9 4.9l1.5 1.5M13.6 13.6l1.5 1.5M15.1 4.9l-1.5 1.5M6.4 13.6l-1.5 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-white">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <circle cx="9" cy="10" r="2.4" fill="currentColor" />
          <circle cx="15" cy="10" r="2.4" fill="currentColor" />
          <rect x="7" y="15" width="10" height="2" rx="1" fill="currentColor" />
        </svg>
      </span>
      <span className="font-display text-xl font-bold tracking-tight">Rakazo</span>
    </Link>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const nav = (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium transition',
              isActive ? 'bg-primary-soft text-primary-dark' : 'text-ink/80 hover:bg-gray-100',
            )
          }
        >
          <item.icon />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              className="btn-ghost md:hidden"
              onClick={() => setMobileOpen((v) => !v)}
              aria-label="Toggle menu"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            <Brand />
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted sm:block">{user?.email}</span>
            <button
              className="btn-secondary !py-2 text-xs"
              onClick={() => {
                logout();
                navigate('/login');
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-64 bg-paper p-4 shadow-pop">{nav}</aside>
        </div>
      )}

      <div className="mx-auto flex max-w-6xl gap-8 px-4 py-8 sm:px-6">
        <aside className="hidden w-56 shrink-0 md:block">
          <div className="sticky top-24">{nav}</div>
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
