import { supabase, type Profile, type WorkOrderHistory } from '@/lib/supabase';

/**
 * Riwayat WO terbaru-dulu, lengkap dengan nama pelaku.
 *
 * Sengaja TIDAK memakai embed `performer:profiles!performed_by(*)`: embed itu butuh foreign key
 * langsung ke `profiles`, dan bila relasinya tidak ada query gagal total dan riwayat tampil
 * kosong. Nama pelaku diambil lewat query terpisah sehingga riwayat tetap muncul apa pun kondisi
 * relasi di database.
 */
export async function fetchWoHistory(woId: string): Promise<WorkOrderHistory[]> {
  const { data, error } = await supabase
    .from('work_order_history')
    .select('*')
    .eq('work_order_id', woId)
    .order('performed_at', { ascending: false });
  if (error) {
    console.warn('Gagal memuat riwayat WO:', error.message);
    return [];
  }
  const rows = (data as WorkOrderHistory[] | null) ?? [];

  const ids = [...new Set(rows.map((r) => r.performed_by).filter(Boolean))];
  if (ids.length > 0) {
    const { data: profs } = await supabase.from('profiles').select('*').in('id', ids);
    const byId = new Map(((profs as Profile[] | null) ?? []).map((p) => [p.id, p]));
    for (const r of rows) r.performer = byId.get(r.performed_by);
  }
  return rows;
}

export type WoWorkTimes = { startedAt: string | null; finishedAt: string | null };

/**
 * Kapan WO mulai dikerjakan dan kapan selesai, diturunkan dari riwayat.
 *
 * - Mulai  : perpindahan PERTAMA ke status on_progress ("Started work"); bila WO tidak pernah
 *            masuk on_progress, dipakai perpindahan pertama ke analysis.
 * - Selesai: perpindahan TERAKHIR ke status done ("Work completed"), dan hanya bila WO sekarang
 *            memang berstatus done/verified/closed (WO yang sedang rework belum selesai).
 *
 * Hanya perpindahan status yang dihitung: catatan lain (foto, permintaan part) mencatat status
 * yang sedang berjalan dan tidak boleh dianggap sebagai awal/akhir pekerjaan.
 */
export function woWorkTimes(history: WorkOrderHistory[], currentStatus: string): WoWorkTimes {
  const asc = [...history].sort((a, b) => new Date(a.performed_at).getTime() - new Date(b.performed_at).getTime());
  let prev: string | null = null;
  let firstProgress: string | null = null;
  let firstAnalysis: string | null = null;
  let lastDone: string | null = null;

  for (const h of asc) {
    if (h.status !== prev) {
      if (h.status === 'on_progress' && !firstProgress) firstProgress = h.performed_at;
      if (h.status === 'analysis' && !firstAnalysis) firstAnalysis = h.performed_at;
      if (h.status === 'done') lastDone = h.performed_at;
    }
    prev = h.status;
  }

  const isFinished = currentStatus === 'done' || currentStatus === 'verified' || currentStatus === 'closed';
  return { startedAt: firstProgress ?? firstAnalysis, finishedAt: isFinished ? lastDone : null };
}

export function fmtWoTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}
