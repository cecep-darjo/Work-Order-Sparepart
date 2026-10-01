import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase, WO_SELECT, spvOrFilter, STATUS_LABELS, STATUS_COLORS, type WorkOrder, type SparePart, stockStatus, type WOStatus } from '@/lib/supabase';
import { Card, Badge, Spinner } from '@/components/ui';
import { ClipboardList, AlertTriangle, CheckCircle2, Clock, TrendingDown, PackageX, UserCheck } from 'lucide-react';
import type { PageKey } from '@/components/Layout';
import { PartRequestsInbox } from '@/components/PartRequests';
import { PurchaseRequirementsInbox } from '@/pages/PurchaseRequirements';

type PrStatus = 'pending_numbering' | 'numbered';

export default function Dashboard({ onNavigate }: { onNavigate: (page: PageKey) => void }) {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [lowStockParts, setLowStockParts] = useState<SparePart[]>([]);
  const [stats, setStats] = useState({ total: 0, open: 0, done: 0, pending: 0 });
  const [picStats, setPicStats] = useState({ total: 0, open: 0 }); // SPV: WO dengan dirinya sebagai PIC
  const [prStats, setPrStats] = useState({ total: 0, pending: 0, numbered: 0 });

  useEffect(() => {
    loadData();
  }, [profile]);

  async function loadData() {
    if (!profile) return;
    setLoading(true);

    let woQuery = supabase
      .from('work_orders')
      .select(WO_SELECT)
      .order('created_at', { ascending: false })
      .limit(10);

    if (profile.role === 'spv') {
      woQuery = woQuery.or(spvOrFilter(profile));
    }
    // Teknisi: RLS hanya mengembalikan WO tempat dia ditugaskan (termasuk penugasan bersama).

    const { data: wos } = await woQuery;
    setWorkOrders((wos as unknown as WorkOrder[]) ?? []);

    // Stats
    let statQuery = supabase.from('work_orders').select('status, spv_id', { count: 'exact', head: false });
    if (profile.role === 'spv') {
      statQuery = statQuery.or(spvOrFilter(profile));
    }
    const { data: allWos } = await statQuery;
    const allStatuses = (allWos as { status: WOStatus; spv_id: string | null }[]) ?? [];
    setStats({
      total: allStatuses.length,
      open: allStatuses.filter((w) => !['closed', 'verified'].includes(w.status)).length,
      done: allStatuses.filter((w) => ['done', 'verified', 'closed'].includes(w.status)).length,
      pending: allStatuses.filter((w) => w.status === 'pending').length,
    });

    // SPV: highlight WO yang PIC-nya dirinya sendiri, terpisah dari total departemen.
    if (profile.role === 'spv') {
      const mine = allStatuses.filter((w) => w.spv_id === profile.id);
      setPicStats({
        total: mine.length,
        open: mine.filter((w) => !['closed', 'verified'].includes(w.status)).length,
      });
    }

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

    // Progress PR untuk admin/SS/inventory
    if (profile.role === 'admin' || profile.role === 'ss' || profile.role === 'inventory') {
      const { data: prs } = await supabase.from('purchase_requirements').select('status');
      const statuses = (prs as { status: PrStatus }[]) ?? [];
      setPrStats({
        total: statuses.length,
        pending: statuses.filter((r) => r.status === 'pending_numbering').length,
        numbered: statuses.filter((r) => r.status === 'numbered').length,
      });
    } else {
      setPrStats({ total: 0, pending: 0, numbered: 0 });
    }

    setLoading(false);
  }

  if (loading) return <Spinner />;
  if (!profile) return null;

  const showInventory = profile.role === 'admin' || profile.role === 'inventory';
  const showPrInbox = profile.role === 'admin' || profile.role === 'inventory';
  const showPrProgress = profile.role === 'admin' || profile.role === 'ss' || profile.role === 'inventory';
  const prProgressPct = prStats.total > 0 ? Math.round((prStats.numbered / prStats.total) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard icon={ClipboardList} label="Total WO" value={stats.total} color="blue" />
        <StatCard icon={Clock} label="Open WO" value={stats.open} color="amber" />
        <StatCard icon={AlertTriangle} label="Pending" value={stats.pending} color="orange" />
        <StatCard icon={CheckCircle2} label="Completed" value={stats.done} color="emerald" />
      </div>

      {/* SPV: WO dengan dirinya sebagai PIC, sebelumnya tidak ada tampilan ini */}
      {profile.role === 'spv' && (
        <div className="grid grid-cols-2 gap-3 sm:gap-4">
          <StatCard icon={UserCheck} label="PIC Saya (Total)" value={picStats.total} color="blue" />
          <StatCard icon={UserCheck} label="PIC Saya (Open)" value={picStats.open} color="amber" />
        </div>
      )}

      {/* Permintaan spare part dari WO: PIC inventory tinggal approve */}
      {showInventory && <PartRequestsInbox />}

      {/* Progress Purchase Requirement */}
      {showPrProgress && (
        <Card className="p-5 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="font-semibold text-slate-900">Progress Purchase Requirement</h2>
            <button
              onClick={() => onNavigate('purchase_requirements')}
              className="text-xs text-blue-600 hover:text-blue-700 font-medium"
            >
              Lihat detail →
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-400">Total PR</p>
              <p className="text-lg font-semibold text-slate-900">{prStats.total}</p>
            </div>
            <div className="rounded-lg bg-amber-50 p-3">
              <p className="text-xs text-amber-700">Pending Numbering</p>
              <p className="text-lg font-semibold text-amber-800">{prStats.pending}</p>
            </div>
            <div className="rounded-lg bg-emerald-50 p-3">
              <p className="text-xs text-emerald-700">Sudah Dinomori</p>
              <p className="text-lg font-semibold text-emerald-800">{prStats.numbered}</p>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
              <span>Progress selesai numbering</span>
              <span>{prProgressPct}%</span>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
              <div className="h-2 bg-emerald-500" style={{ width: `${prProgressPct}%` }} />
            </div>
          </div>
        </Card>
      )}

      {/* Purchase Requirement: SS membuat, inventory/admin melengkapi nomor SAP & PR */}
      {showPrInbox && <PurchaseRequirementsInbox onNavigate={onNavigate} />}

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
                      {profile.role === 'spv' && wo.spv_id === profile.id && (
                        <span className="ml-2 text-xs font-normal text-blue-600">PIC: Anda</span>
                      )}
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
