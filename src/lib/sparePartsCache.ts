import { supabase, fetchAllRows, type SparePart } from '@/lib/supabase';

/**
 * Cache daftar spare part (ribuan baris) yang dipakai bersama oleh semua halaman.
 *
 * Alih-alih mengunduh ulang SELURUH tabel setiap halaman dibuka, cache ini hanya meminta baris yang
 * berubah sejak sinkronisasi terakhir (delta by `updated_at`) ditambah satu query hitung baris
 * (head, tanpa body) untuk mendeteksi baris yang dihapus. Unduhan penuh hanya terjadi saat:
 *  - pertama kali (cache kosong),
 *  - jumlah baris di server berbeda dengan cache (ada yang dihapus / sinkron gagal sebagian),
 *  - sudah lewat FULL_REFRESH_MS (menangkap perubahan yang tidak menaikkan `updated_at`,
 *    mis. update langsung lewat SQL / scripts/update-spareparts.mjs),
 *  - dipanggil dengan { force: true }.
 */

// Hanya kolom yang ada di tipe SparePart — bukan select('*').
export const SPARE_PART_COLUMNS =
  'id,code,name,category,unit,min_stock,max_stock,current_stock,location,group_id,inventory_code,created_at,updated_at';

const FULL_REFRESH_MS = 10 * 60_000;
// now() di Postgres = waktu AWAL transaksi, jadi baris bisa ter-commit belakangan dengan
// updated_at yang sedikit lebih lama dari yang sudah kita lihat. Jendela tumpang-tindih ini
// mengambil ulang baris-baris terakhir (aman: digabung per id).
const OVERLAP_MS = 2 * 60_000;
const DELTA_LIMIT = 1000;

type Cache = { rows: Map<string, SparePart>; fullAt: number; maxUpdated: number };

let cache: Cache | null = null;
let inflight: Promise<SparePart[]> | null = null;

function ts(v: string | null | undefined): number {
  const n = v ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function snapshot(c: Cache): SparePart[] {
  return [...c.rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

async function loadFull(): Promise<SparePart[]> {
  const list = await fetchAllRows<SparePart>('spare_parts', SPARE_PART_COLUMNS, 'name');
  const rows = new Map<string, SparePart>();
  let maxUpdated = 0;
  for (const p of list) {
    rows.set(p.id, p);
    maxUpdated = Math.max(maxUpdated, ts(p.updated_at));
  }
  cache = { rows, fullAt: Date.now(), maxUpdated };
  return snapshot(cache);
}

async function loadDelta(c: Cache): Promise<SparePart[] | null> {
  const since = new Date(Math.max(0, c.maxUpdated - OVERLAP_MS)).toISOString();
  const { data, error } = await supabase
    .from('spare_parts')
    .select(SPARE_PART_COLUMNS)
    .gt('updated_at', since)
    .order('updated_at', { ascending: true })
    .limit(DELTA_LIMIT);
  if (error) return null;
  const changed = (data as SparePart[] | null) ?? [];
  if (changed.length >= DELTA_LIMIT) return null; // terlalu banyak berubah: unduh penuh saja

  for (const p of changed) {
    c.rows.set(p.id, p);
    c.maxUpdated = Math.max(c.maxUpdated, ts(p.updated_at));
  }

  // Deteksi baris yang dihapus (atau sinkron yang tidak lengkap): hitung saja, tanpa body.
  const { count, error: countError } = await supabase
    .from('spare_parts')
    .select('id', { count: 'exact', head: true });
  if (countError || typeof count !== 'number' || count !== c.rows.size) return null;

  return snapshot(c);
}

export async function fetchSpareParts(opts: { force?: boolean } = {}): Promise<SparePart[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const c = cache;
      if (!opts.force && c && Date.now() - c.fullAt < FULL_REFRESH_MS) {
        const delta = await loadDelta(c);
        if (delta) return delta;
      }
      return await loadFull();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Buang cache (mis. setelah logout) — pemanggilan berikutnya mengunduh penuh. */
export function invalidateSpareParts(): void {
  cache = null;
}

/** Hapus satu baris dari cache setelah delete berhasil, agar tidak memicu unduhan penuh. */
export function dropSparePart(id: string): void {
  cache?.rows.delete(id);
}
