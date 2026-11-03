import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { ActionItemsProvider } from '@/context/ActionItemsContext';
import Login from '@/pages/Login';
import Layout, { type PageKey } from '@/components/Layout';
import Dashboard from '@/pages/Dashboard';
import WorkOrders from '@/pages/WorkOrders';
import WorkOrderDetail from '@/pages/WorkOrderDetail';
import JobAssignments from '@/pages/JobAssignments';
import SpareParts from '@/pages/SpareParts';
import Transactions from '@/pages/Transactions';
import PurchaseRequirements from '@/pages/PurchaseRequirements';
import GoodsReceipts from '@/pages/GoodsReceipts';
import Bons from '@/pages/Bons';
import AdminPanel from '@/pages/AdminPanel';
import ActivityLogPage from '@/pages/ActivityLogPage';
import UserSettings from '@/pages/UserSettings';
import Portal from '@/pages/Portal';
import PreventiveMaintenance from '@/pages/PreventiveMaintenance';
import Chat from '@/pages/Chat';
import { Spinner } from '@/components/ui';
import { isSupabaseConfigured } from '@/lib/supabase';

function AppContent() {
  const { session, profile, loading } = useAuth();
  const [page, setPage] = useState<PageKey>('portal');
  const [selectedWO, setSelectedWO] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !profile?.is_active) return;

    const rootRoute = { page: 'portal' as PageKey, selectedWO: null as string | null };
    const currentState = window.history.state;
    window.history.replaceState({ ...currentState, engwoRoute: rootRoute }, '');

    const handlePopState = (event: PopStateEvent) => {
      const route = event.state?.engwoRoute as { page: PageKey; selectedWO: string | null } | undefined;
      if (route) {
        setPage(route.page);
        setSelectedWO(route.selectedWO);
        return;
      }

      // Recover gracefully if the browser history entry has no app route data.
      setPage('portal');
      setSelectedWO(null);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [session, profile?.is_active]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!session || !profile) {
    return <Login />;
  }

  // If inactive user, show message
  if (!profile.is_active) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="text-center">
          <p className="text-lg font-semibold text-slate-900 mb-2">Account Inactive</p>
          <p className="text-sm text-slate-500">Your account has been deactivated. Please contact your administrator.</p>
        </div>
      </div>
    );
  }

  function navigate(p: PageKey) {
    const route = { page: p, selectedWO: null };
    window.history.pushState({ engwoRoute: route }, '');
    setSelectedWO(null);
    setPage(p);
  }

  function openWorkOrder(woId: string) {
    const route = { page, selectedWO: woId };
    window.history.pushState({ engwoRoute: route }, '');
    setSelectedWO(woId);
  }

  return (
    <ActionItemsProvider refreshKey={`${page}:${selectedWO ?? ''}`}>
    <Layout currentPage={page} onNavigate={navigate}>
      {selectedWO ? (
        <WorkOrderDetail woId={selectedWO} onBack={() => window.history.back()} />
      ) : (
        <>
          {page === 'dashboard' && <Dashboard onNavigate={navigate} onOpenWO={openWorkOrder} />}
          {page === 'portal' && <Portal onNavigate={navigate} />}
          {page === 'workorders' && <WorkOrders onSelectWO={openWorkOrder} />}
          {page === 'job_assignments' && <JobAssignments />}
          {page === 'preventive_maintenance' && <PreventiveMaintenance />}
          {page === 'chat' && <Chat />}
          {page === 'spareparts' && <SpareParts />}
          {page === 'transactions' && <Transactions />}
          {page === 'goods_receipts' && <GoodsReceipts />}
          {page === 'bons' && <Bons />}
          {page === 'purchase_requirements' && <PurchaseRequirements />}
          {page === 'pr_list' && <PurchaseRequirements listingOnly />}
          {page === 'inventory' && <SpareParts lowStockOnly />}
          {page === 'master_wo' && <AdminPanel scope="wo" />}
          {page === 'master_inventory' && <AdminPanel scope="inventory" />}
          {page === 'activity' && <ActivityLogPage />}
          {page === 'user_settings' && <UserSettings />}
        </>
      )}
    </Layout>
    </ActionItemsProvider>
  );
}

function App() {
  if (!isSupabaseConfigured) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md text-center">
          <p className="text-lg font-semibold text-slate-900 mb-2">Konfigurasi Supabase belum terisi</p>
          <p className="text-sm text-slate-500">
            VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY harus tersedia saat <code>npm run build</code>.
            Isi file <code>.env</code> (atau Build variables di Cloudflare), lalu build dan deploy ulang.
          </p>
        </div>
      </div>
    );
  }

  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
