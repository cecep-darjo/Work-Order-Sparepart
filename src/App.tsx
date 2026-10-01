import { useState } from 'react';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import Login from '@/pages/Login';
import Layout, { type PageKey } from '@/components/Layout';
import Dashboard from '@/pages/Dashboard';
import WorkOrders from '@/pages/WorkOrders';
import WorkOrderDetail from '@/pages/WorkOrderDetail';
import SpareParts from '@/pages/SpareParts';
import Transactions from '@/pages/Transactions';
import PurchaseRequirements from '@/pages/PurchaseRequirements';
import GoodsReceipts from '@/pages/GoodsReceipts';
import AdminPanel from '@/pages/AdminPanel';
import ActivityLogPage from '@/pages/ActivityLogPage';
import { Spinner } from '@/components/ui';
import { isSupabaseConfigured } from '@/lib/supabase';

function AppContent() {
  const { session, profile, loading } = useAuth();
  const [page, setPage] = useState<PageKey>('dashboard');
  const [selectedWO, setSelectedWO] = useState<string | null>(null);

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
    setSelectedWO(null);
    setPage(p);
  }

  return (
    <Layout currentPage={page} onNavigate={navigate}>
      {selectedWO ? (
        <WorkOrderDetail woId={selectedWO} onBack={() => setSelectedWO(null)} />
      ) : (
        <>
          {page === 'dashboard' && <Dashboard onNavigate={navigate} />}
          {page === 'workorders' && <WorkOrders onSelectWO={setSelectedWO} />}
          {page === 'spareparts' && <SpareParts />}
          {page === 'transactions' && <Transactions />}
          {page === 'goods_receipts' && <GoodsReceipts />}
          {page === 'purchase_requirements' && <PurchaseRequirements />}
          {page === 'inventory' && <SpareParts lowStockOnly />}
          {page === 'master_wo' && <AdminPanel scope="wo" />}
          {page === 'master_inventory' && <AdminPanel scope="inventory" />}
          {page === 'activity' && <ActivityLogPage />}
        </>
      )}
    </Layout>
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
