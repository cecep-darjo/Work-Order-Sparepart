import { type ReactNode, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { ROLE_LABELS, type Role } from '@/lib/supabase';
import {
  LayoutDashboard,
  ClipboardList,
  Package,
  Settings,
  History,
  LogOut,
  Menu,
  X,
  Wrench,
  Boxes,
} from 'lucide-react';

export type PageKey =
  | 'dashboard'
  | 'workorders'
  | 'inventory'
  | 'spareparts'
  | 'transactions'
  | 'admin'
  | 'activity';

const NAV_ITEMS: {
  key: PageKey;
  label: string;
  icon: typeof LayoutDashboard;
  roles: Role[];
}[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ['admin', 'spv', 'teknisi', 'inventory'] },
  { key: 'workorders', label: 'Work Orders', icon: ClipboardList, roles: ['admin', 'spv', 'teknisi'] },
  { key: 'spareparts', label: 'Spare Parts', icon: Package, roles: ['admin', 'inventory'] },
  { key: 'transactions', label: 'Inventory Transactions', icon: Boxes, roles: ['admin', 'inventory'] },
  { key: 'inventory', label: 'Low Stock Alerts', icon: Package, roles: ['admin', 'inventory'] },
  { key: 'admin', label: 'Master Data', icon: Settings, roles: ['admin'] },
  { key: 'activity', label: 'Activity Log', icon: History, roles: ['admin'] },
];

export default function Layout({
  currentPage,
  onNavigate,
  children,
}: {
  currentPage: PageKey;
  onNavigate: (page: PageKey) => void;
  children: ReactNode;
}) {
  const { profile, signOut } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (!profile) return null;

  const items = NAV_ITEMS.filter((item) => item.roles.includes(profile.role));

  const currentLabel = NAV_ITEMS.find((i) => i.key === currentPage)?.label ?? '';

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:sticky top-0 left-0 h-screen w-64 bg-slate-900 text-slate-300 flex flex-col z-40 transition-transform duration-200 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="flex items-center gap-3 px-5 h-16 border-b border-slate-800 flex-shrink-0">
          <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <Wrench className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-white text-sm tracking-tight">EngWO Inventory</span>
        </div>

        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
          {items.map((item) => {
            const Icon = item.icon;
            const active = currentPage === item.key;
            return (
              <button
                key={item.key}
                onClick={() => {
                  onNavigate(item.key);
                  setSidebarOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-slate-800 p-3 flex-shrink-0">
          <div className="px-3 py-2 mb-2">
            <p className="text-sm font-medium text-white truncate">{profile.full_name}</p>
            <p className="text-xs text-slate-500">{ROLE_LABELS[profile.role]}</p>
          </div>
          <button
            onClick={() => signOut()}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-slate-200 h-16 flex items-center justify-between px-4 sm:px-6 flex-shrink-0 sticky top-0 z-20">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900"
            >
              {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
            <h1 className="text-lg font-semibold text-slate-900">{currentLabel}</h1>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
