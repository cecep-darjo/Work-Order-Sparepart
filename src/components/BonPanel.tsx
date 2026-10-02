import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Badge, Button, Card } from '@/components/ui';
import type { PageKey } from '@/components/Layout';
import { BON_SELECT, BON_STATUS_COLORS, bonRemaining, bonStatusLabel, type Bon } from '@/lib/bons';
import { ClipboardList, Plus, RefreshCw } from 'lucide-react';

/**
 * Panel Dashboard Bon Sparepart.
 * - admin/inventory: semua bon yang masih menunggu/sebagian (untuk diproses di Pengeluaran).
 * - user lain: bon aktif milik sendiri.
 */
export default function BonPanel({ onNavigate }: { onNavigate: (page: PageKey) => void }) {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Bon[]>([]);
  const [total, setTotal] = useState(0);

  const staff = profile?.role === 'admin' || profile?.role === 'inventory';
  const canCreate = profile?.role !== 'inventory';

  const load = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    let q = supabase
      .from('spare_part_bons')
      .select(BON_SELECT, { count: 'exact' })
      .in('status', ['pending', 'partial'])
      .order('created_at', { ascending: staff })
      .limit(staff ? 8 : 5);
    if (!staff) q = q.eq('requester_id', profile.id);
    const { data, count } = await q;
    setRows((data as unknown as Bon[]) ?? []);
    setTotal(count ?? 0);
    setLoading(false);
  }, [profile, staff]);

  useEffect(() => {
    load();
  }, [load]);

  if (!profile) return null;

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <h2 className="font-semibold text-slate-900 flex items-center gap-2">
          <ClipboardList className="w-4 h-4 text-amber-600" />
          {staff ? 'Bon Sparepart - Menunggu Diproses' : 'Bon Sparepart Saya'}
          {total > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-amber-500 text-white text-xs font-bold">
              {total}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {staff && (
            <Button size="sm" onClick={() => onNavigate('transactions')}>
              Proses di Pengeluaran
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => onNavigate('bons')}>
            {staff ? 'Lihat semua' : canCreate ? <><Plus className="w-4 h-4" /> Buat / lihat bon</> : 'Lihat bon'}
          </Button>
          <Button size="sm" variant="secondary" onClick={load} aria-label="Refresh">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400">Memuat bon...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">{staff ? 'Tidak ada bon yang menunggu.' : 'Anda tidak punya bon yang sedang aktif.'}</p>
      ) : (
        <div className="space-y-3">
          {rows.map((b) => {
            const open = b.items.filter((i) => bonRemaining(i) > 0);
            return (
              <div key={b.id} className="rounded-lg border border-slate-200 p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{b.bon_no}</p>
                    <p className="text-xs text-slate-400">
                      {new Date(b.created_at).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}
                      {staff && <> • oleh <b className="text-slate-600">{b.requester?.full_name ?? '-'}</b></>}
                    </p>
                  </div>
                  <Badge className={BON_STATUS_COLORS[b.status]}>{bonStatusLabel(b)}</Badge>
                </div>
                <p className="text-sm text-slate-700 line-clamp-2">{b.notes}</p>
                <p className="text-xs text-slate-500">
                  {open
                    .slice(0, 3)
                    .map((i) => `${i.spare_part?.name} (${bonRemaining(i)} ${i.spare_part?.unit ?? ''})`)
                    .join(', ')}
                  {open.length > 3 ? `, +${open.length - 3} lainnya` : ''}
                </p>
              </div>
            );
          })}
          {total > rows.length && <p className="text-xs text-slate-400">+{total - rows.length} bon lainnya</p>}
        </div>
      )}
    </Card>
  );
}
