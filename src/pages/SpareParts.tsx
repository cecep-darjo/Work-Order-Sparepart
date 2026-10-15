import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  supabase,
  fetchAllRows,
  stockStatus,
  type SparePart,
  type PartCategory,
  type UnitOfMeasure,
  type PartLocation,
  type InventoryGroup,
} from '@/lib/supabase';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { matchesQuery, SearchablePicker, type PickerOption } from '@/components/Pickers';
import { groupNameMap } from '@/lib/partOptions';
import { Card, Badge, Button, Input, Select, Label, Modal, Textarea, Spinner, EmptyState } from '@/components/ui';
import { Plus, Search, Pencil, Trash2, Package, AlertTriangle, TrendingUp, Sliders, ClipboardList, FileDown, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { exportOpnamePdf, exportOpnameXls } from '@/lib/stockOpname';

type StockLevel = 'all' | 'low' | 'normal' | 'over';

type SortKey = 'name' | 'code' | 'inventory_code' | 'category' | 'location' | 'current_stock';
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Nama' },
  { key: 'code', label: 'Kode' },
  { key: 'inventory_code', label: 'Kode Inventori' },
  { key: 'category', label: 'Kategori' },
  { key: 'location', label: 'Lokasi' },
  { key: 'current_stock', label: 'Stok' },
];

/**
 * Pratinjau kode inventori 9 digit (xxyyyzzzz) tanpa nomor urut (zzzz masih = 0000
 * karena nomor urut ditentukan di server berdasarkan urutan item dalam grup).
 */
function previewInventoryCode(name: string, group: InventoryGroup): string {
  const xxyyy = group.use_abjad
    ? (group.kode ?? '00').padStart(2, '0') + abjadValue(name)
    : (group.kode ?? '').padStart(5, '0');
  return xxyyy + '0000';
}

/**
 * Kode unik grup yang dipakai membentuk kode inventori: 2 digit (xx) bila grup memakai abjad,
 * 5 digit (xxyyy) bila kode manual. Sama dengan yang dipakai trigger database (generate_inventory_code).
 */
function groupKode(group: InventoryGroup): string {
  return group.use_abjad !== false
    ? (group.kode ?? '').slice(0, 2).padStart(2, '0')
    : (group.kode ?? '').padStart(5, '0');
}

/** Pesan gagal simpan yang jelas; kode inventori ganda ditolak database (unique index, migrasi 042). */
function saveErrorText(error: { message: string; code?: string }): string {
  if (error.code === '23505' && error.message.includes('uq_spare_parts_inventory_code')) {
    return 'Kode inventori sudah dipakai spare part lain. Silakan simpan ulang; jika masih gagal, hubungi admin.';
  }
  return error.message;
}

/** Urutan abjad huruf awal nama (a=001 ... z=026); selain huruf = 000. */
function abjadValue(name: string): string {
  const first = name.trim().charAt(0).toLowerCase();
  const code = first.charCodeAt(0);
  if (first >= 'a' && first <= 'z') return String(code - 96).padStart(3, '0');
  return '000';
}

const PAGE_SIZE = 20;

/** Daftar nomor halaman dengan elipsis, mis. 1 … 4 5 6 … 20. */
function pageList(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const set = new Set<number>([1, total, current - 1, current, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((n) => set.add(n));
  if (current >= total - 2) [total - 3, total - 2, total - 1].forEach((n) => set.add(n));
  const nums = [...set].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  nums.forEach((n, i) => {
    if (i > 0 && n - nums[i - 1] > 1) out.push('…');
    out.push(n);
  });
  return out;
}

export default function SpareParts({ lowStockOnly = false }: { lowStockOnly?: boolean }) {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  // Seluruh spare part diambil SEKALI (dan setelah simpan/hapus/refresh). Pencarian & filter stok
  // dikerjakan di klien tanpa memanggil server lagi, jadi mengetik tidak lagi memicu unduh ulang ribuan baris.
  const [allParts, setAllParts] = useState<SparePart[]>([]);
  const [groupNameLookup, setGroupNameLookup] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  // Teks di kolom pencarian langsung berubah; query ke server memakai nilai yang sudah ditunda (debounce).
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput.trim(), 300);
  const [refreshing, setRefreshing] = useState(false);
  const reqSeq = useRef(0);
  // Nama grup per id (diisi saat master dimuat) agar nama grup ikut dicari di daftar.
  const groupNamesRef = useRef<Record<string, string>>({});
  const [stockFilter, setStockFilter] = useState<StockLevel>(lowStockOnly ? 'low' : 'all');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SparePart | null>(null);
  const [showTx, setShowTx] = useState<SparePart | null>(null);
  const [acting, setActing] = useState(false);
  const [categories, setCategories] = useState<PartCategory[]>([]);
  const [units, setUnits] = useState<UnitOfMeasure[]>([]);
  const [locations, setLocations] = useState<PartLocation[]>([]);
  const [groups, setGroups] = useState<InventoryGroup[]>([]);

  // Stock Opname (lembar hitung PDF / Excel)
  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const [showOpname, setShowOpname] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [opname, setOpname] = useState({
    scope: (lowStockOnly ? 'view' : 'all') as 'all' | 'location' | 'category' | 'view',
    value: '',
    blind: false,
    format: 'pdf' as 'pdf' | 'xls',
    date: todayIso(),
  });

  const [form, setForm] = useState({
    code: '',
    name: '',
    category: '',
    unit: 'pcs',
    min_stock: 0,
    max_stock: 0,
    location: '',
    group_id: '',
  });

  const [txForm, setTxForm] = useState({
    type: 'stock_in' as 'stock_in' | 'stock_out' | 'adjustment' | 'opname',
    quantity: 0,
    reference: '',
    notes: '',
  });

  const canManage = profile?.role === 'admin' || profile?.role === 'inventory';

  const loadParts = useCallback(async () => {
    // Hanya pemuatan pertama yang menampilkan spinner layar penuh. Spinner pada setiap pencarian
    // membongkar seluruh halaman (termasuk kolom pencarian) sehingga ketikan terputus-putus.
    const seq = ++reqSeq.current;
    setRefreshing(true);
    // Ambil SEMUA spare part (melewati limit ~1000 baris/query), lalu saring di sisi klien
    // sesuai kata kunci pencarian dan filter stok.
    const all = await fetchAllRows<SparePart>('spare_parts', '*', 'name');
    if (seq !== reqSeq.current) return; // sudah ada permintaan yang lebih baru; abaikan jawaban usang
    setAllParts(all);
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Teks pencarian tiap part disusun sekali per pemuatan data (bukan per ketikan).
  const haystacks = useMemo(
    () =>
      allParts.map((p) =>
        [p.name, p.code, p.inventory_code, p.group_id ? groupNameLookup[p.group_id] : '', p.category, p.location]
          .filter(Boolean)
          .join(' ')
      ),
    [allParts, groupNameLookup]
  );

  const parts = useMemo(() => {
    // Metode sama dengan pemilih spare part di Purchase Requirement: semua kata yang diketik
    // harus cocok (urutan bebas) pada gabungan nama, kode, kode inventori, Inventory Group,
    // kategori, dan lokasi.
    const out: SparePart[] = [];
    for (let i = 0; i < allParts.length; i++) {
      const p = allParts[i];
      if (stockFilter !== 'all' && stockStatus(p) !== stockFilter) continue;
      if (search && !matchesQuery(haystacks[i], search)) continue;
      out.push(p);
    }
    return out;
  }, [allParts, haystacks, search, stockFilter]);

  useEffect(() => {
    loadParts();
  }, [loadParts]);

  useEffect(() => {
    async function loadMasters() {
      const [{ data: cat }, { data: un }, { data: loc }, { data: grp }] = await Promise.all([
        supabase.from('part_categories').select('*').order('name'),
        supabase.from('units_of_measure').select('*').order('name'),
        supabase.from('part_locations').select('*').order('name'),
        supabase.from('inventory_groups').select('*').order('name'),
      ]);
      setCategories((cat as PartCategory[]) ?? []);
      setUnits((un as UnitOfMeasure[]) ?? []);
      setLocations((loc as PartLocation[]) ?? []);
      setGroups((grp as InventoryGroup[]) ?? []);
      groupNamesRef.current = groupNameMap((grp as InventoryGroup[]) ?? []);
      setGroupNameLookup(groupNamesRef.current);
    }
    loadMasters();
  }, []);

  function openCreate() {
    setEditing(null);
    setForm({ code: '', name: '', category: '', unit: '', min_stock: 0, max_stock: 0, location: '', group_id: '' });
    setShowForm(true);
  }

  function openEdit(part: SparePart) {
    setEditing(part);
    setForm({
      code: part.code,
      name: part.name,
      category: part.category ?? '',
      unit: part.unit,
      min_stock: part.min_stock,
      max_stock: part.max_stock,
      location: part.location ?? '',
      group_id: part.group_id != null ? String(part.group_id) : '',
    });
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      alert('Nama part wajib diisi.');
      return;
    }
    if (!form.unit) {
      alert('Satuan wajib dipilih.');
      return;
    }
    setActing(true);

    if (editing) {
      const data = {
        name: form.name,
        category: form.category || null,
        unit: form.unit,
        min_stock: form.min_stock,
        max_stock: form.max_stock,
        location: form.location || null,
        group_id: form.group_id || null,
        updated_at: new Date().toISOString(),
      };
      const { data: updated, error } = await supabase
        .from('spare_parts')
        .update(data)
        .eq('id', editing.id)
        .select('id, group_id, inventory_code');
      if (error) {
        alert('Gagal menyimpan: ' + saveErrorText(error));
        setActing(false);
        return;
      }
      if (!updated || updated.length === 0) {
        alert(
          'Perubahan tidak tersimpan: tidak ada baris yang diperbarui. ' +
            'Kemungkinan akun ini tidak punya izin mengubah spare part (RLS) atau data sudah tidak ada.'
        );
        setActing(false);
        return;
      }
    } else {
      // Kode part dibuat otomatis di server: <KODE_KATEGORI>-00001 (atau SP-00001 tanpa kategori).
      const categoryId = categories.find((c) => c.name === form.category)?.id ?? null;
      const { data: code, error: codeError } = await supabase.rpc('next_part_code', { p_category_id: categoryId });
      if (codeError || !code) {
        alert('Gagal membuat kode part: ' + (codeError?.message ?? 'kode kosong'));
        setActing(false);
        return;
      }
      const data = {
        code,
        name: form.name,
        category: form.category || null,
        unit: form.unit,
        min_stock: form.min_stock,
        max_stock: form.max_stock,
        location: form.location || null,
        group_id: form.group_id || null,
      };
      const { error } = await supabase.from('spare_parts').insert(data);
      if (error) {
        alert('Gagal menyimpan: ' + saveErrorText(error));
        setActing(false);
        return;
      }
    }

    setActing(false);
    setShowForm(false);
    loadParts();
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this spare part?')) return;
    await supabase.from('spare_parts').delete().eq('id', id);
    loadParts();
  }

  async function handleTransaction() {
    if (!showTx || !profile) return;
    if (txForm.quantity <= 0) {
      alert('Quantity harus lebih besar dari 0.');
      return;
    }
    if (txForm.type === 'stock_out' && txForm.quantity > showTx.current_stock) {
      alert(`Stok tidak mencukupi. Stok tersedia: ${showTx.current_stock} ${showTx.unit}.`);
      return;
    }
    setActing(true);
    const { error } = await supabase.rpc('apply_inventory_transaction', {
      p_spare_part_id: showTx.id,
      p_type: txForm.type,
      p_quantity: txForm.quantity,
      p_reference: txForm.reference || null,
      p_notes: txForm.notes || null,
      p_work_order_id: null,
      p_source: txForm.type === 'stock_in' ? 'Spare Parts' : null,
      p_destination: txForm.type === 'stock_out' ? 'Spare Parts' : null,
    });
    if (error) alert('Transaksi gagal: ' + error.message);
    else {
      setShowTx(null);
      setTxForm({ type: 'stock_in', quantity: 0, reference: '', notes: '' });
      await loadParts();
    }
    setActing(false);
  }

  async function handleOpnameExport() {
    if (!profile) return;
    setExporting(true);
    try {
      let list: SparePart[];
      let scopeLabel: string;
      if (opname.scope === 'view') {
        list = sortedParts;
        scopeLabel = `Sesuai tampilan layar${search ? ` (pencarian: "${search}")` : ''}`;
      } else {
        const all = await fetchAllRows<SparePart>('spare_parts', '*', 'name');
        list = all;
        scopeLabel = 'Semua spare part';
        if (opname.scope === 'location') {
          list = list.filter((p) => p.location === opname.value);
          scopeLabel = `Lokasi: ${opname.value}`;
        } else if (opname.scope === 'category') {
          list = list.filter((p) => p.category === opname.value);
          scopeLabel = `Kategori: ${opname.value}`;
        }
      }
      if (list.length === 0) {
        alert('Tidak ada spare part pada cakupan ini.');
        return;
      }
      const meta = { date: opname.date || todayIso(), scopeLabel, blind: opname.blind, printedBy: profile.full_name };
      if (opname.format === 'pdf') await exportOpnamePdf(list, meta);
      else exportOpnameXls(list, meta);
      setShowOpname(false);
    } catch (e) {
      alert('Gagal membuat lembar stock opname: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setExporting(false);
    }
  }

  // Pilihan Inventory Group: diurutkan menurut NOMOR KODE (bukan abjad nama); grup tanpa kode di
  // paling bawah. Bisa dicari lewat kode maupun nama (kata bebas urutan).
  const groupOptions = useMemo<PickerOption[]>(() => {
    const byCode = (a: InventoryGroup, b: InventoryGroup) => {
      if (!a.kode && b.kode) return 1;
      if (a.kode && !b.kode) return -1;
      // Kode 2 digit (xx) disejajarkan dengan kode 5 digit (xxyyy) menurut kode inventori 9 digit:
      // 15 → 15000, sehingga urutannya 10250, 15, 15097, 21 (bukan semua 2 digit dulu).
      const ka = groupKode(a);
      const kb = groupKode(b);
      return (
        ka.padEnd(5, '0').localeCompare(kb.padEnd(5, '0'), undefined, { numeric: true }) ||
        ka.length - kb.length ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );
    };
    return [...groups].sort(byCode).map((g) => {
      const k = groupKode(g);
      return {
        value: g.id,
        label: `${k} - ${g.name}`,
        sublabel: g.use_abjad !== false ? 'Kode 2 digit + abjad nama part' : 'Kode 5 digit manual',
        search: `${k} ${g.kode ?? ''} ${g.name}`,
      };
    });
  }, [groups]);

  // Klik header kolom: kolom sama membalik arah, kolom baru mulai dari naik.
  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  // Urutan tampilan. Nilai kosong selalu di paling bawah, apa pun arah urutannya.
  const sortedParts = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...parts].sort((a, b) => {
      if (sortKey === 'current_stock') {
        return (Number(a.current_stock) - Number(b.current_stock)) * dir || a.name.localeCompare(b.name);
      }
      const av = (a[sortKey] ?? '').toString().trim();
      const bv = (b[sortKey] ?? '').toString().trim();
      if (!av && !bv) return a.name.localeCompare(b.name);
      if (!av) return 1;
      if (!bv) return -1;
      return (
        av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' }) * dir ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );
    });
  }, [parts, sortKey, sortDir]);

  // Pencarian/filter/urutan berubah → kembali ke halaman 1.
  useEffect(() => {
    setPage(1);
  }, [search, stockFilter, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedParts.length / PAGE_SIZE));
  // Setelah data dimuat ulang (mis. hapus item di halaman terakhir), jaga agar halaman tetap valid.
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Cari nama, kode, kode inventori, grup, kategori, atau lokasi..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-10"
          />
        </div>
        <div className="flex gap-1 sm:w-auto">
          <Select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className="sm:w-44" aria-label="Urutkan berdasarkan">
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                Urutkan: {o.label}
              </option>
            ))}
          </Select>
          <button
            type="button"
            onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
            className="px-3 border border-slate-300 rounded-lg bg-white text-slate-600 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
            title={sortDir === 'asc' ? 'Naik (A-Z / terkecil) — klik untuk membalik' : 'Turun (Z-A / terbesar) — klik untuk membalik'}
            aria-label="Balik arah urutan"
          >
            {sortDir === 'asc' ? <ArrowUp className="w-4 h-4" /> : <ArrowDown className="w-4 h-4" />}
          </button>
        </div>
        {!lowStockOnly && (
          <Select value={stockFilter} onChange={(e) => setStockFilter(e.target.value as StockLevel)} className="sm:w-40">
            <option value="all">All Stock</option>
            <option value="normal">Normal</option>
            <option value="low">Low Stock</option>
            <option value="over">Over Stock</option>
          </Select>
        )}
        {canManage && (
          <Button variant="secondary" onClick={() => setShowOpname(true)}>
            <ClipboardList className="w-4 h-4" /> Stock Opname
          </Button>
        )}
        {canManage && (
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" /> Add Part
          </Button>
        )}
      </div>

      {/* Stats */}
      {!lowStockOnly && (
        <div className="grid grid-cols-3 gap-3">
          <StockStatCard icon={AlertTriangle} label="Low Stock" value={parts.filter((p) => stockStatus(p) === 'low').length} color="orange" />
          <StockStatCard icon={Package} label="Normal" value={parts.filter((p) => stockStatus(p) === 'normal').length} color="emerald" />
          <StockStatCard icon={TrendingUp} label="Over Stock" value={parts.filter((p) => stockStatus(p) === 'over').length} color="blue" />
        </div>
      )}

      {/* List */}
      {parts.length === 0 ? (
        <Card className="p-6">
          <EmptyState message={lowStockOnly ? 'No low stock items - all levels are normal' : 'No spare parts found'} />
        </Card>
      ) : (
        <Card className={`overflow-hidden transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  {(
                    [
                      { key: 'name', label: 'Spare Part', align: 'left' },
                      { key: 'code', label: 'Kode', align: 'left' },
                      { key: 'inventory_code', label: 'Kode Inventori', align: 'left' },
                      { key: 'category', label: 'Kategori', align: 'left' },
                      { key: 'location', label: 'Lokasi', align: 'left' },
                      { key: 'current_stock', label: 'Stok', align: 'right' },
                    ] as { key: SortKey; label: string; align: 'left' | 'right' }[]
                  ).map((col) => (
                    <th key={col.key} className={`${col.align === 'right' ? 'text-right' : 'text-left'} px-4 py-3`}>
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key)}
                        className="inline-flex items-center gap-1 hover:text-slate-800 uppercase"
                      >
                        {col.label} <SortIcon active={sortKey === col.key} dir={sortDir} />
                      </button>
                    </th>
                  ))}
                  <th className="text-right px-4 py-3">Min / Max</th>
                  <th className="text-left px-4 py-3">Status</th>
                  {canManage && <th className="text-right px-4 py-3">Aksi</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sortedParts.slice(pageStart, pageStart + PAGE_SIZE).map((part) => {
                  const status = stockStatus(part);
                  return (
                    <tr key={part.id} className="hover:bg-slate-50/60 align-top">
                      <td className="px-4 py-3 font-semibold text-slate-900 min-w-[12rem]">{part.name}</td>
                      <td className="px-4 py-3">
                        <Badge className="bg-slate-100 text-slate-600 border-slate-200">{part.code}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        {part.inventory_code ? (
                          <Badge className="bg-indigo-50 text-indigo-700 border-indigo-200 font-mono">{part.inventory_code}</Badge>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{part.category || <span className="text-slate-300">-</span>}</td>
                      <td className="px-4 py-3 text-slate-600">{part.location || <span className="text-slate-300">-</span>}</td>
                      <td
                        className={`px-4 py-3 text-right font-bold whitespace-nowrap ${
                          status === 'low' ? 'text-orange-600' : status === 'over' ? 'text-blue-600' : 'text-slate-900'
                        }`}
                      >
                        {part.current_stock} {part.unit}
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-slate-400 whitespace-nowrap">
                        {part.min_stock} / {part.max_stock}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          className={
                            status === 'low'
                              ? 'bg-orange-100 text-orange-700 border-orange-200'
                              : status === 'over'
                              ? 'bg-blue-100 text-blue-700 border-blue-200'
                              : 'bg-emerald-100 text-emerald-700 border-emerald-200'
                          }
                        >
                          {status === 'low' ? 'Low Stock' : status === 'over' ? 'Over Stock' : 'Normal'}
                        </Badge>
                      </td>
                      {canManage && (
                        <td className="px-4 py-3">
                          <div className="flex gap-1 justify-end">
                            <button
                              onClick={() => {
                                setTxForm({ type: 'stock_in', quantity: 0, reference: '', notes: '' });
                                setShowTx(part);
                              }}
                              className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg"
                              title="Transaction"
                            >
                              <Sliders className="w-4 h-4" />
                            </button>
                            <button onClick={() => openEdit(part)} className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg" title="Edit">
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button onClick={() => handleDelete(part.id)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg" title="Hapus">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="border-t border-slate-100 p-3 flex flex-col sm:flex-row items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                Menampilkan {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, sortedParts.length)} dari {sortedParts.length} item
              </p>
              {totalPages > 1 && (
                <nav className="flex items-center gap-1 flex-wrap justify-center" aria-label="Halaman">
                  <Button size="sm" variant="secondary" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>
                    Sebelumnya
                  </Button>
                  {pageList(currentPage, totalPages).map((n, i) =>
                    n === '…' ? (
                      <span key={`gap-${i}`} className="px-2 text-slate-400">…</span>
                    ) : (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setPage(n)}
                        aria-current={n === currentPage ? 'page' : undefined}
                        className={`min-w-[2rem] h-8 px-2 rounded-lg text-sm border ${
                          n === currentPage
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        {n}
                      </button>
                    )
                  )}
                  <Button size="sm" variant="secondary" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)}>
                    Berikutnya
                  </Button>
                </nav>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Stock Opname Modal */}
      <Modal open={showOpname} onClose={() => setShowOpname(false)} title="Stock Opname" maxWidth="max-w-lg">
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            Buat lembar hitung untuk dibawa ke gudang. Kolom Stok Fisik dikosongkan untuk diisi saat penghitungan.
          </p>

          <div>
            <Label>Cakupan</Label>
            <Select
              value={opname.scope}
              onChange={(e) => setOpname((o) => ({ ...o, scope: e.target.value as typeof o.scope, value: '' }))}
            >
              <option value="all">Semua spare part</option>
              <option value="location">Per lokasi</option>
              <option value="category">Per kategori</option>
              <option value="view">Sesuai tampilan layar saat ini ({parts.length} item)</option>
            </Select>
          </div>

          {opname.scope === 'location' && (
            <div>
              <Label>Lokasi *</Label>
              <Select value={opname.value} onChange={(e) => setOpname((o) => ({ ...o, value: e.target.value }))}>
                <option value="">Pilih lokasi...</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.name}>{l.name}</option>
                ))}
              </Select>
            </div>
          )}
          {opname.scope === 'category' && (
            <div>
              <Label>Kategori *</Label>
              <Select value={opname.value} onChange={(e) => setOpname((o) => ({ ...o, value: e.target.value }))}>
                <option value="">Pilih kategori...</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.name}>{c.name}</option>
                ))}
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Tanggal Opname</Label>
              <Input type="date" value={opname.date} onChange={(e) => setOpname((o) => ({ ...o, date: e.target.value }))} />
            </div>
            <div>
              <Label>Format</Label>
              <Select value={opname.format} onChange={(e) => setOpname((o) => ({ ...o, format: e.target.value as 'pdf' | 'xls' }))}>
                <option value="pdf">PDF (cetak)</option>
                <option value="xls">Excel (.xls)</option>
              </Select>
            </div>
          </div>

          <label className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={opname.blind}
              onChange={(e) => setOpname((o) => ({ ...o, blind: e.target.checked }))}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <span>
              Hitung buta (sembunyikan stok sistem)
              <span className="block text-xs text-slate-400">
                PDF: kolom Stok Sistem &amp; Selisih tidak dicetak. Excel: kolom Stok Sistem disembunyikan, Selisih tetap terhitung.
              </span>
            </span>
          </label>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowOpname(false)}>Batal</Button>
            <Button
              onClick={handleOpnameExport}
              disabled={exporting || (opname.scope !== 'all' && opname.scope !== 'view' && !opname.value)}
            >
              <FileDown className="w-4 h-4" />
              {exporting ? 'Membuat...' : 'Unduh Lembar Opname'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Create/Edit Modal */}
      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? 'Edit Spare Part' : 'Add Spare Part'} maxWidth="max-w-2xl">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Code</Label>
              <Input value={editing ? form.code : 'Dibuat otomatis saat disimpan'} disabled className="bg-slate-50 text-slate-400" />
            </div>
            <div>
              <Label>Unit *</Label>
              <Select value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}>
                <option value="">Select unit...</option>
                {(form.unit && !units.some((u) => u.name === form.unit)
                  ? [{ id: '__legacy_unit__', name: form.unit }, ...units]
                  : units
                ).map((u) => (
                  <option key={u.id} value={u.name}>{u.name}</option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <Label>Name *</Label>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Bearing 6204" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Inventory Group</Label>
              <SearchablePicker
                inline
                value={form.group_id}
                onChange={(v) => setForm((f) => ({ ...f, group_id: v }))}
                placeholder="None — cari & pilih grup..."
                searchPlaceholder="Ketik kode atau nama grup..."
                emptyText="Grup tidak ditemukan. Tambahkan dulu di Master Data Inventory."
                options={groupOptions}
              />
              {form.group_id && groups.some((g) => g.id === form.group_id) && (
                <p className="text-xs text-slate-400 mt-1">
                  {(() => {
                    const g = groups.find((x) => x.id === form.group_id)!;
                    const k = groupKode(g);
                    return `Kode grup: ${k} (${k.length} digit)`;
                  })()}
                </p>
              )}
            </div>
            <div>
              <Label>Inventory Code</Label>
              <Input
                value={
                  form.group_id && groups.some((g) => g.id === form.group_id)
                    ? previewInventoryCode(
                        form.name,
                        groups.find((g) => g.id === form.group_id)!
                      )
                    : '—'
                }
                disabled
                readOnly
                className="bg-slate-50 text-slate-500"
              />
              <p className="text-xs text-slate-400 mt-1">Kode 9 digit dibuat otomatis dari grup & nama.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Category</Label>
              <Select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                <option value="">None</option>
                {(form.category && !categories.some((c) => c.name === form.category)
                  ? [{ id: '__legacy_cat__', name: form.category }, ...categories]
                  : categories
                ).map((c) => (
                  <option key={c.id} value={c.name}>{c.name}</option>
                ))}
              </Select>
              {!editing && <p className="text-xs text-slate-400 mt-1">Menentukan awalan kode part.</p>}
            </div>
            <div>
              <Label>Location</Label>
              <Select value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}>
                <option value="">None</option>
                {(form.location && !locations.some((l) => l.name === form.location)
                  ? [{ id: '__legacy_loc__', name: form.location }, ...locations]
                  : locations
                ).map((l) => (
                  <option key={l.id} value={l.name}>{l.name}</option>
                ))}
              </Select>
            </div>
          </div>
          <p className="text-xs text-slate-400">
            Kategori, satuan, dan lokasi baru bisa ditambahkan lewat menu Master Data Inventory.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Min Stock</Label>
              <Input type="number" min={0} value={form.min_stock} onChange={(e) => setForm((f) => ({ ...f, min_stock: Number(e.target.value) }))} />
              <p className="text-xs text-slate-400 mt-1">Isi 0 bila part tidak perlu distok (tidak ada alert Low Stock).</p>
            </div>
            <div>
              <Label>Max Stock</Label>
              <Input type="number" min={0} value={form.max_stock} onChange={(e) => setForm((f) => ({ ...f, max_stock: Number(e.target.value) }))} />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={acting || !form.name}>
              {acting ? 'Saving...' : editing ? 'Update' : 'Create'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Transaction Modal */}
      <Modal open={!!showTx} onClose={() => setShowTx(null)} title={`Transaction: ${showTx?.name ?? ''}`}>
        <div className="space-y-4">
          <div className="p-3 bg-slate-50 rounded-lg text-sm">
            <span className="text-slate-400">Current stock: </span>
            <span className="font-bold text-slate-900">{showTx?.current_stock} {showTx?.unit}</span>
          </div>
          <div>
            <Label>Transaction Type</Label>
            <Select value={txForm.type} onChange={(e) => setTxForm((f) => ({ ...f, type: e.target.value as 'stock_in' | 'stock_out' | 'adjustment' | 'opname' }))}>
              <option value="stock_in">Stock In (add stock)</option>
              <option value="stock_out">Stock Out (remove stock)</option>
              <option value="adjustment">Adjustment (set to exact qty)</option>
              <option value="opname">Stock Opname (set to exact qty)</option>
            </Select>
          </div>
          <div>
            <Label>
              {txForm.type === 'adjustment' || txForm.type === 'opname' ? 'New Actual Quantity' : 'Quantity'}
            </Label>
            <Input
              type="number"
              min={0}
              value={txForm.quantity}
              onChange={(e) => setTxForm((f) => ({ ...f, quantity: Number(e.target.value) }))}
            />
          </div>
          <div>
            <Label>Reference</Label>
            <Input value={txForm.reference} onChange={(e) => setTxForm((f) => ({ ...f, reference: e.target.value }))} placeholder="PO number, WO number, etc." />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea rows={2} value={txForm.notes} onChange={(e) => setTxForm((f) => ({ ...f, notes: e.target.value }))} />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setShowTx(null)}>Cancel</Button>
            <Button onClick={handleTransaction} disabled={acting || txForm.quantity < 0}>
              {acting ? 'Processing...' : 'Confirm Transaction'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Ikon urutan (sort) di header kolom tabel (sama dengan tabel Inventory Transactions). */
function SortIcon({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <ArrowUpDown className="w-3.5 h-3.5 text-slate-300" />;
  return dir === 'asc' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />;
}

function StockStatCard({ icon: Icon, label, value, color }: { icon: typeof Package; label: string; value: number; color: 'orange' | 'emerald' | 'blue' }) {
  const colors = {
    orange: 'bg-orange-50 text-orange-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    blue: 'bg-blue-50 text-blue-600',
  };
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${colors[color]}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div>
          <p className="text-lg font-bold text-slate-900">{value}</p>
          <p className="text-xs text-slate-400">{label}</p>
        </div>
      </div>
    </Card>
  );
}
