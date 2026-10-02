// Bon Sparepart: tipe & helper bersama (halaman Bon, Dashboard, Pengeluaran).

export type BonStatus = 'pending' | 'partial' | 'issued' | 'cancelled';

export type BonItem = {
  id: string;
  spare_part_id: string;
  quantity: number;
  issued_qty: number;
  spare_part: { code: string; name: string; unit: string; current_stock: number } | null;
};

export type Bon = {
  id: string;
  bon_no: string;
  requester_id: string;
  notes: string;
  status: BonStatus;
  cancel_reason: string | null;
  closed_reason: string | null;
  created_at: string;
  requester: { full_name: string } | null;
  items: BonItem[];
};

export const BON_SELECT =
  'id, bon_no, requester_id, notes, status, cancel_reason, closed_reason, created_at, requester:profiles!requester_id(full_name), items:spare_part_bon_items(id, spare_part_id, quantity, issued_qty, spare_part:spare_parts(code, name, unit, current_stock))';

export const BON_STATUS_LABELS: Record<BonStatus, string> = {
  pending: 'Menunggu',
  partial: 'Sebagian',
  issued: 'Selesai',
  cancelled: 'Dibatalkan',
};

export const BON_STATUS_COLORS: Record<BonStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 border-amber-200',
  partial: 'bg-blue-100 text-blue-700 border-blue-200',
  issued: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  cancelled: 'bg-slate-100 text-slate-500 border-slate-200',
};

/** Sisa yang belum dikeluarkan untuk satu item bon (dibulatkan agar aman dari selisih desimal). */
export function bonRemaining(item: Pick<BonItem, 'quantity' | 'issued_qty'>): number {
  return Math.round((Number(item.quantity) - Number(item.issued_qty)) * 1000) / 1000;
}

export function bonStatusLabel(bon: Pick<Bon, 'status' | 'closed_reason'>): string {
  if (bon.status === 'issued' && bon.closed_reason) return 'Selesai (ditutup)';
  return BON_STATUS_LABELS[bon.status];
}
