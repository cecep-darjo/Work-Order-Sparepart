import { supabase, PRIORITY_LABELS } from '@/lib/supabase';
import { renderSlipPdf, fmtDateTime, fmtQty } from '@/lib/slipPdf';
import { fetchSlipSignatures } from '@/lib/signatures';

export type PartRequestStatus = 'pending' | 'ss_approved' | 'approved' | 'rejected' | 'cancelled';

export type PartRequestItem = {
  id: string;
  request_id: string;
  spare_part_id: string;
  quantity: number;
  note: string | null;
  // Terisi saat approved; NULL kembali bila part dikembalikan dari WO setelahnya.
  work_order_part_id: string | null;
  spare_part: {
    code: string;
    name: string;
    unit: string;
    current_stock: number;
    location: string | null;
  } | null;
};

export type PartRequest = {
  id: string;
  request_no: string;
  work_order_id: string;
  purpose: string;
  status: PartRequestStatus;
  requested_by: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  requester?: { full_name: string } | null;
  decider?: { full_name: string } | null;
  work_order?: {
    id: string;
    wo_number: string;
    status: string;
    problem_description: string;
    priority: string;
    spv_id: string | null;
    department?: { name: string } | null;
    area?: { name: string } | null;
    equipment?: { name: string } | null;
    technicians?: { technician: { full_name: string } | null }[];
  } | null;
  items?: PartRequestItem[];
};

export const PR_SELECT =
  '*, work_order:work_orders(id, wo_number, status, problem_description, priority, spv_id, department:departments(name), area:areas(name), equipment:equipment(name), technicians:work_order_technicians(technician:profiles!technician_id(full_name))), requester:profiles!requested_by(full_name), decider:profiles!decided_by(full_name), items:wo_part_request_items(*, spare_part:spare_parts(code, name, unit, current_stock, location))';

export const PR_STATUS_LABELS: Record<PartRequestStatus, string> = {
  pending: 'Waiting Part Approval',
  ss_approved: 'Menunggu Proses Inventory',
  approved: 'Selesai Diproses Inventory',
  rejected: 'Ditolak',
  cancelled: 'Dibatalkan',
};

export const PR_STATUS_COLORS: Record<PartRequestStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 border-amber-200',
  ss_approved: 'bg-blue-100 text-blue-700 border-blue-200',
  approved: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  rejected: 'bg-red-100 text-red-700 border-red-200',
  cancelled: 'bg-gray-200 text-gray-600 border-gray-300',
};

export async function fetchPartRequest(id: string): Promise<PartRequest | null> {
  const { data } = await supabase.from('wo_part_requests').select(PR_SELECT).eq('id', id).maybeSingle();
  return (data as unknown as PartRequest) ?? null;
}

/** Item yang stoknya saat ini kurang dari jumlah diminta (utama untuk tahap proses inventory). */
export function insufficientItems(req: PartRequest): PartRequestItem[] {
  return (req.items ?? []).filter((i) => (i.spare_part?.current_stock ?? 0) < i.quantity);
}

/**
 * Petugas inventory yang memproses pengeluaran. Alur approval 2 tahap mengisi `decided_by` dengan
 * SS yang menyetujui, sehingga pemroses diambil dari transaksi stok keluar yang dibuat saat proses.
 * Mengembalikan null bila tidak ditemukan (mis. belum diproses).
 */
async function fetchProcessor(req: PartRequest): Promise<{ id: string; name: string | null } | null> {
  const { data: tx } = await supabase
    .from('inventory_transactions')
    .select('created_by')
    .eq('reference', req.request_no)
    .eq('type', 'stock_out')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const id = (tx as { created_by: string } | null)?.created_by;
  if (!id) return null;
  const { data: p } = await supabase.from('profiles').select('full_name').eq('id', id).maybeSingle();
  return { id, name: (p as { full_name: string } | null)?.full_name ?? null };
}

/**
 * Membuat & mengunduh "Lembar Pengeluaran Barang" (PDF) dari permintaan yang sudah disetujui.
 * Tanda tangan digital dibubuhkan sesuai user: Penerima = peminta, Bagian Spare Part = pemroses inventory.
 */
export async function downloadIssueSlip(req: PartRequest): Promise<void> {
  const processor = await fetchProcessor(req);
  const sigs = await fetchSlipSignatures([req.requested_by, processor?.id]);

  const wo = req.work_order;
  const techNames = (wo?.technicians ?? [])
    .map((t) => t.technician?.full_name)
    .filter(Boolean)
    .join(', ');
  const areaEquip = [wo?.area?.name, wo?.equipment?.name].filter(Boolean).join(' / ') || '-';

  await renderSlipPdf({
    docNo: req.request_no,
    subtitle: 'Spare Part - permintaan dari Work Order',
    fileName: `Pengeluaran-${req.request_no}.pdf`,
    infoRows: [
      ['No. Dokumen', req.request_no, 'No. WO', wo?.wo_number ?? '-'],
      ['Tgl. Permintaan', fmtDateTime(req.requested_at), 'Departemen', wo?.department?.name ?? '-'],
      ['Tgl. Disetujui', fmtDateTime(req.decided_at), 'Area / Equipment', areaEquip],
      ['Diminta oleh', req.requester?.full_name ?? '-', 'Prioritas', wo ? PRIORITY_LABELS[wo.priority] ?? wo.priority : '-'],
      ['Teknisi WO', techNames || '-'],
      ['Masalah WO', wo?.problem_description ?? '-'],
      ['Keperluan', req.purpose],
    ],
    items: (req.items ?? []).map((it) => [
      it.spare_part?.code ?? '-',
      it.spare_part?.name ?? '-',
      fmtQty(it.quantity),
      it.spare_part?.unit ?? '-',
      [it.note, it.work_order_part_id === null ? '(dikembalikan ke stok)' : ''].filter(Boolean).join(' ') || '-',
    ]),
    signatures: [
      {
        title: 'Penerima',
        name: req.requester?.full_name,
        image: req.requested_by ? sigs[req.requested_by] : null,
      },
      {
        title: 'Bagian Spare Part',
        name: processor?.name ?? req.decider?.full_name,
        image: processor ? sigs[processor.id] : null,
      },
    ],
  });
}
