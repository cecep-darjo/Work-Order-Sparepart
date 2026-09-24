import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase, STATUS_LABELS, STATUS_COLORS, type WorkOrder, type SparePart, stockStatus, type WOStatus } from '@/lib/supabase';
import { Card, Badge, Spinner } from '@/components/ui';
import { ClipboardList, AlertTriangle, CheckCircle2, Clock, TrendingDown, PackageX } from 'lucide-react';
import type { PageKey } from '@/components/Layout';

export default function Dashboard({ onNavigate }: { onNavigate: (page: PageKey) => void }) {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [lowStockParts, setLowStockParts] = useState<SparePart[]>([]);
  const [stats, setStats] = useState({ total: 0, open: 0, done: 0, pending: 0 });

  useEffect(() => {
    loadData();
  }, [profile]);

  async function loadData() {
    if (!profile) return;
    setLoading(true);

    let woQuery = supabase
      .from('work_orders')
      .select('*, department:departments(*), area:areas(*), equipment:equipment(*), spv:profiles!spv_id(*), technician:profiles!technician_id(*)')
      .order('created_at', { ascending: false })
      .limit(10);

    if (profile.role === 'spv') {
      woQuery = woQuery.eq('department_id', profile.department_id);
    } else if (profile.role === 'teknisi') {
      woQuery = woQuery.eq('technician_id', profile.id);
    }

    const { data: wos } = await woQuery;
    setWorkOrders((wos as unknown as WorkOrder[]) ?? []);

    // Stats
    let statQuery = supabase.from('work_orders').select('status', { count: 'exact', head: false });
    if (profile.role === 'spv') {
      statQuery = statQuery.eq('department_id', profile.department_id);
    } else if (profile.role === 'teknisi') {
      statQuery = statQuery.eq('technician_id', profile.id);
    }
    const { data: allWos } = await statQuery;
    const allStatuses = (allWos as { status: WOStatus }[]) ?? [];
    setStats({
      total: allStatuses.length,
      open: allStatuses.filter((w) => !['closed', 'verified'].includes(w.status)).length,
      done: allStatuses.filter((w) => ['done', 'verified', 'closed'].includes(w.status)).length,
      pending: allStatuses.filter((w) => w.status === 'pending').length,
    });

    // Low stock for admin/inventory
    if (profile.role === 'admin' || profile.role === 'inventory') {
      const { data: parts } = await supabase
        .from('spare_parts')
        .select('*')
        .order('current_stock', { ascending: true })
        .limit(10);
      const lowStock = (parts as SparePart[] ?? []).filter((p) => stockStatus(p) === 'low');
      setLowStockParts(lowStock);
    }

    setLoading(false);
  }

  if (loading) return <Spinner />;
  if (!profile) return null;

  const showInventory = profile.role === 'admin' || profile.role === 'inventory';

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard icon={ClipboardList} label="Total WO" value={stats.total} color="blue" />
        <StatCard icon={Clock} label="Open WO" value={stats.open} color="amber" />
        <StatCard icon={AlertTriangle} label="Pending" value={stats.pending} color="orange" />
        <StatCard icon={CheckCircle2} label="Completed" value={stats.done} color="emerald" />
      </div>

      <div className={`grid ${showInventory ? 'lg:grid-cols-2' : 'grid-cols-1'} gap-6`}>
        {/* Recent Work Orders */}
        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-slate-900">Recent Work Orders</h2>
            {profile.role !== 'inventory' && (
              <button
                onClick={() => onNavigate('workorders')}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                View all →
              </button>
            )}
          </div>
          {workOrders.length === 0 ? (
            <p className="text-sm text-slate-400 py-8 text-center">No work orders yet</p>
          ) : (
            <div className="space-y-2">
              {workOrders.slice(0, 6).map((wo) => (
                <button
                  key={wo.id}
                  onClick={() => onNavigate('workorders')}
                  className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-slate-50 transition text-left"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900 truncate">
                      {wo.wo_number}
                    </p>
                    <p className="text-xs text-slate-500 truncate">{wo.problem_description}</p>
                  </div>
                  <Badge className={STATUS_COLORS[wo.status] + ' ml-3 flex-shrink-0'}>
                    {STATUS_LABELS[wo.status]}
                  </Badge>
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* Low Stock Alert */}
        {showInventory && (
          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-slate-900 flex items-center gap-2">
                <TrendingDown className="w-4 h-4 text-orange-500" />
                Low Stock Alerts
              </h2>
              <button
                onClick={() => onNavigate('inventory')}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                View all →
              </button>
            </div>
            {lowStockParts.length === 0 ? (
              <div className="flex flex-col items-center py-8 text-slate-400">
                <PackageX className="w-8 h-8 mb-2" />
                <p className="text-sm">All stock levels are normal</p>
              </div>
            ) : (
              <div className="space-y-2">
                {lowStockParts.slice(0, 6).map((part) => (
                  <div
                    key={part.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-orange-50 border border-orange-100"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">{part.name}</p>
                      <p className="text-xs text-slate-500">{part.code}</p>
                    </div>
                    <div className="text-right ml-3 flex-shrink-0">
                      <p className="text-sm font-bold text-orange-600">{part.current_stock}</p>
                      <p className="text-xs text-slate-400">min: {part.min_stock} {part.unit}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: typeof ClipboardList;
  label: string;
  value: number;
  color: 'blue' | 'amber' | 'orange' | 'emerald';
}) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600',
    amber: 'bg-amber-50 text-amber-600',
    orange: 'bg-orange-50 text-orange-600',
    emerald: 'bg-emerald-50 text-emerald-600',
  };
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${colors[color]}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <p className="text-2xl font-bold text-slate-900">{value}</p>
          <p className="text-xs text-slate-500 truncate">{label}</p>
        </div>
      </div>
    </Card>
  );
}
