import type { PickerOption } from '@/components/Pickers';

/** Bagian dari inventory_groups yang dibutuhkan untuk menampilkan grup di pemilih spare part. */
export type GroupInfo = {
  id: string;
  name: string;
};

/** Peta id grup → nama Inventory Group, untuk dipakai berulang saat membuat opsi pemilih. */
export function groupNameMap(groups: GroupInfo[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const g of groups) m[g.id] = g.name;
  return m;
}

type PartLike = {
  id: string;
  code: string;
  name: string;
  unit: string;
  current_stock: number;
  category?: string | null;
  location?: string | null;
  inventory_code?: string | null;
  group_id?: string | null;
};

/**
 * Opsi pemilih spare part yang seragam di semua halaman.
 * - Baris di bawah nama: kode inventori (9 digit) • nama Inventory Group,
 *   mis. "150970001 • Compr. Desiccant Dryer Dc108". Bila keduanya kosong, tampil kode part.
 * - Pencarian mencakup nama, kode part, kode inventori, nama grup, kategori, dan lokasi
 *   (kata bebas urutan).
 * - `forIssue`: untuk pengeluaran; stok habis ditandai "Stok habis" dan tidak bisa dipilih.
 */
export function partPickerOption(
  p: PartLike,
  groupNames: Record<string, string>,
  opts: { forIssue?: boolean } = {}
): PickerOption {
  const group = p.group_id ? groupNames[p.group_id] ?? '' : '';
  const empty = opts.forIssue === true && p.current_stock <= 0;
  return {
    value: p.id,
    label: p.name,
    sublabel: [p.inventory_code, group].filter(Boolean).join(' • ') || p.code,
    right: empty ? 'Stok habis' : `${p.current_stock} ${p.unit}`,
    search: [p.name, p.code, p.inventory_code, group, p.category, p.location].filter(Boolean).join(' '),
    ...(empty ? { disabled: true } : {}),
  };
}
