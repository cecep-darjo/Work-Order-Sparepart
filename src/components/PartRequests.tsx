import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase, type Profile } from '@/lib/supabase';
import {
  PR_SELECT,
  PR_STATUS_COLORS,
  PR_STATUS_LABELS,
  downloadIssueSlip,
  fetchPartRequest,
  insufficientItems,
  type PartRequest,
} from '@/lib/partRequests';
import { Badge, Button, Card, Label, Modal, Spinner, Textarea } from '@/components/ui';
import { AlertTriangle, Check, ClipboardCheck, FileDown, RefreshCw, X, Ban } from 'lucide-react';

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-';
}

async function printSlip(id: string) {
  const full = await fetchPartRequest(id);
  if (!full) {
    alert('Data permintaan tidak ditemukan.');
    return;
  }
  await downloadIssueSlip(full);
}

/* ------------------------------------------------------------------ */
/* Kartu satu permintaan: info + tombol Approve / Reject / Batal / PDF  */
/* ------------------------------------------------------------------ */
export function PartRequestCard({
  request,
  viewer,
  showWO = true,
  onChanged,
}: {
  request: PartRequest;
  viewer: Pick<Profile, 'id' | 'role'>;
  showWO?: boolean;
  onChanged: () => void;
}) {
  const [acting, setActing] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');

  const items = request.items ?? [];
  const wo = request.work_order;
  const isPending = request.status === 'pending';
  const canDecide = isPending && (viewer.role === 'admin' || viewer.role === 'inventory');
  const canCancel = isPending && (request.requested_by === viewer.id || viewer.role === 'admin');
  const shortItems = insufficientItems(request);

  async function approve() {
    setActing(true);
    const { error } = await supabase.rpc('approve_part_request', { p_request_id: request.id });
    if (error) {
      alert('Gagal approve: ' + error.message);
      setActing(false);
      onChanged();
      return;
    }
    try {
      await printSlip(request.id);
    } catch (e) {
      alert('Permintaan disetujui, tetapi PDF gagal dibuat: ' + (e instanceof Error ? e.message : String(e)));
    }
    setActing(false);
    onChanged();
  }

  async function reject() {
    if (!reason.trim()) return;
    setActing(true);
    const { error } = await supabase.rpc('reject_part_request', { p_request_id: request.id, p_reason: reason.trim() });
    if (error) alert('Gagal menolak: ' + error.message);
    setActing(false);
    setShowReject(false);
    setReason('');
    onChanged();
  }

  async function cancel() {
    if (!confirm(`Batalkan permintaan ${request.request_no}?`)) return;
    setActing(true);
    const { error } = await supabase.rpc('cancel_part_request', { p_request_id: request.id });
    if (error) alert('Gagal membatalkan: ' + error.message);
    setActing(false);
    onChanged();
  }

  async function pdf() {
    setActing(true);
    try {
      await printSlip(request.id);
    } catch (e) {
      alert('PDF gagal dibuat: ' + (e instanceof Error ? e.message : String(e)));
    }
    setActing(false);
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm text-slate-900">{request.request_no}</span>
            <Badge className={PR_STATUS_COLORS[request.status]}>{PR_STATUS_LABELS[request.status]}</Badge>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            {request.requester?.full_name ?? 'Unknown'} - {fmt(request.requested_at)}
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
          {canDecide && (
            <>
              <Button size="sm" variant="success" onClick={approve} disabled={acting || shortItems.length > 0}>
                <Check className="w-4 h-4" /> {acting ? 'Memproses...' : 'Approve'}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setShowReject(true)} disabled={acting}>
                <X className="w-4 h-4" /> Reject
              </Button>
            </>
          )}
          {canCancel && !canDecide && (
            <Button size="sm" variant="secondary" onClick={cancel} disabled={acting}>
              <Ban className="w-4 h-4" /> Batalkan
            </Button>
          )}
          {request.status === 'approved' && (
            <Button size="sm" variant="secondary" onClick={pdf} disabled={acting}>
              <FileDown className="w-4 h-4" /> {acting ? 'Membuat...' : 'PDF'}
            </Button>
          )}
        </div>
      </div>

      {showWO && wo && (
        <div className="text-xs text-slate-500">
          <span className="font-medium text-slate-700">{wo.wo_number}</span>
          {wo.department?.name && <span> - {wo.department.name}</span>}
          {wo.equipment?.name && <span> - {wo.equipment.name}</span>}
          <p className="text-slate-500 mt-0.5 line-clamp-2">{wo.problem_description}</p>
        </div>
      )}

      <div>
        <p className="text-xs text-slate-400">Keperluan</p>
        <p className="text-sm text-slate-700 whitespace-pre-line">{request.purpose}</p>
      </div>

      <div className="rounded-lg bg-slate-50 divide-y divide-slate-100">
        {items.map((it) => {
          const short = isPending && (it.spare_part?.current_stock ?? 0) < it.quantity;
          const returned = request.status === 'approved' && it.work_order_part_id === null;
          return (
            <div key={it.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900 truncate">{it.spare_part?.name ?? '-'}</p>
                <p className="text-xs text-slate-400 truncate">
                  {it.spare_part?.code}
                  {it.spare_part?.location ? ` - ${it.spare_part.location}` : ''}
                  {it.note ? ` - ${it.note}` : ''}
                  {returned ? ' - dikembalikan ke stok' : ''}
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="text-sm font-bold text-slate-900">
                  {it.quantity} {it.spare_part?.unit}
                </p>
                {isPending && (
                  <p className={`text-xs ${short ? 'text-red-600 font-medium' : 'text-slate-400'}`}>
                    Stok: {it.spare_part?.current_stock ?? 0}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {canDecide && shortItems.length > 0 && (
        <p className="text-xs text-red-600 flex items-center gap-1">
          <AlertTriangle className="w-3.5 h-3.5" />
          Stok tidak mencukupi untuk: {shortItems.map((i) => i.spare_part?.name).join(', ')}. Approve tersedia setelah stok cukup.
        </p>
      )}

      {request.status === 'approved' && (
        <p className="text-xs text-slate-400">
          Disetujui oleh {request.decider?.full_name ?? '-'} - {fmt(request.decided_at)}
        </p>
      )}
      {request.status === 'rejected' && (
        <p className="text-xs text-red-600">
          Ditolak oleh {request.decider?.full_name ?? '-'} - {fmt(request.decided_at)}
          {request.decision_note ? `: ${request.decision_note}` : ''}
        </p>
      )}
      {request.status === 'cancelled' && (
        <p className="text-xs text-slate-400">Dibatalkan - {fmt(request.decided_at)}</p>
      )}

      <Modal open={showReject} onClose={() => setShowReject(false)} title={`Tolak ${request.request_no}`}>
        <div className="space-y-4">
          <div>
            <Label>Alasan penolakan *</Label>
            <Textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Mis. barang tidak tersedia / gunakan barang pengganti..."
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setShowReject(false)}>Cancel</Button>
            <Button variant="danger" onClick={reject} disabled={acting || !reason.trim()}>
              {acting ? 'Memproses...' : 'Tolak Permintaan'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Kotak masuk untuk Dashboard admin / inventory                       */
/* ------------------------------------------------------------------ */
export function PartRequestsInbox() {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PartRequest[]>([]);
  const [recent, setRecent] = useState<PartRequest[]>([]);
  const [busyPdf, setBusyPdf] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const [{ data: p }, { data: r }] = await Promise.all([
      supabase.from('wo_part_requests').select(PR_SELECT).eq('status', 'pending').order('requested_at', { ascending: true }),
      supabase
        .from('wo_part_requests')
        .select('id, request_no, decided_at, work_order:work_orders(wo_number), items:wo_part_request_items(id)')
        .eq('status', 'approved')
        .order('decided_at', { ascending: false })
        .limit(5),
    ]);
    setPending((p as unknown as PartRequest[]) ?? []);
    setRecent((r as unknown as PartRequest[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // Permintaan baru dari teknisi muncul otomatis tanpa perlu reload halaman.
    const timer = setInterval(() => load(true), 30000);
    return () => clearInterval(timer);
  }, [load]);

  if (!profile) return null;

  async function pdf(id: string) {
    setBusyPdf(id);
    try {
      await printSlip(id);
    } catch (e) {
      alert('PDF gagal dibuat: ' + (e instanceof Error ? e.message : String(e)));
    }
    setBusyPdf(null);
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-slate-900 flex items-center gap-2">
          <ClipboardCheck className="w-4 h-4 text-blue-600" />
          Permintaan Spare Part dari WO
          {pending.length > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-amber-500 text-white text-xs font-bold">
              {pending.length}
            </span>
          )}
        </h2>
        <button
          onClick={() => load()}
          className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {loading ? (
        <Spinner />
      ) : pending.length === 0 ? (
        <p className="text-sm text-slate-400 py-6 text-center">Tidak ada permintaan yang menunggu approval</p>
      ) : (
        <div className="space-y-3">
          {pending.map((r) => (
            <PartRequestCard key={r.id} request={r} viewer={profile} onChanged={() => load(true)} />
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <div className="mt-5 pt-4 border-t border-slate-100">
          <p className="text-xs font-medium text-slate-500 mb-2">Disetujui terbaru (cetak ulang lembar pengeluaran)</p>
          <div className="space-y-1">
            {recent.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 p-2 rounded-lg hover:bg-slate-50">
                <div className="min-w-0 text-sm">
                  <span className="font-medium text-slate-900">{r.request_no}</span>
                  <span className="text-xs text-slate-400">
                    {' '}- {r.work_order?.wo_number} - {r.items?.length ?? 0} barang - {fmt(r.decided_at)}
                  </span>
                </div>
                <Button size="sm" variant="secondary" onClick={() => pdf(r.id)} disabled={busyPdf === r.id}>
                  <FileDown className="w-4 h-4" /> {busyPdf === r.id ? 'Membuat...' : 'PDF'}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
