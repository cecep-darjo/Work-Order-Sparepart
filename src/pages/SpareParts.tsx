import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  supabase,
  fetchAllRows,
  stockStatus,
  type SparePart,
  type PartCategory,
  type UnitOfMeasure,
  type PartLocation,
} from '@/lib/supabase';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { Card, Badge, Button, Input, Select, Label, Modal, Textarea, Spinner, EmptyState } from '@/components/ui';
import { Plus, Search, Pencil, Trash2, Package, AlertTriangle, TrendingUp, Sliders, ClipboardList, FileDown } from 'lucide-react';
import { exportOpnamePdf, exportOpnameXls } from '@/lib/stockOpname';

type StockLevel = 'all' | 'low' | 'normal' | 'over';

export default function SpareParts({ lowStockOnly = false }: { lowStockOnly?: boolean }) {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [parts, setParts] = useState<SparePart[]>([]);
  // Teks di kolom pencarian langsung berubah; query ke server memakai nilai yang sudah ditunda (debounce).
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput.trim(), 300);
  const [refreshing, setRefreshing] = useState(false);
  const reqSeq = useRef(0);
  const [stockFilter, setStockFilter] = useState<StockLevel>(lowStockOnly ? 'low' : 'all');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SparePart | null>(null);
  const [showTx, setShowTx] = useState<SparePart | null>(null);
  const [acting, setActing] = useState(false);
  const [categories, setCategories] = useState<PartCategory[]>([]);
  const [units, setUnits] = useState<UnitOfMeasure[]>([]);
  const [locations, setLocations] = useState<PartLocation[]>([]);

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
    let filtered = all;

    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.name?.toLowerCase().includes(s) ||
          p.code?.toLowerCase().includes(s) ||
          (p.category ?? '').toLowerCase().includes(s)
      );
    }

    if (stockFilter === 'low') {
      filtered = filtered.filter((p) => stockStatus(p) === 'low');
    } else if (stockFilter === 'over') {
      filtered = filtered.filter((p) => stockStatus(p) === 'over');
    } else if (stockFilter === 'normal') {
      filtered = filtered.filter((p) => stockStatus(p) === 'normal');
    }

    setParts(filtered);
    setLoading(false);
    setRefreshing(false);
  }, [search, stockFilter]);

  useEffect(() => {
    loadParts();
  }, [loadParts]);

  useEffect(() => {
    async function loadMasters() {
      const [{ data: cat }, { data: un }, { data: loc }] = await Promise.all([
        supabase.from('part_categories').select('*').order('name'),
        supabase.from('units_of_measure').select('*').order('name'),
        supabase.from('part_locations').select('*').order('name'),
      ]);
      setCategories((cat as PartCategory[]) ?? []);
      setUnits((un as UnitOfMeasure[]) ?? []);
      setLocations((loc as PartLocation[]) ?? []);
    }
    loadMasters();
  }, []);

  function openCreate() {
    setEditing(null);
    setForm({ code: '', name: '', category: '', unit: '', min_stock: 0, max_stock: 0, location: '' });
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
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase.from('spare_parts').update(data).eq('id', editing.id);
      if (error) {
        alert('Gagal menyimpan: ' + error.message);
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
      };
      const { error } = await supabase.from('spare_parts').insert(data);
      if (error) {
        alert('Gagal menyimpan: ' + error.message);
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
        list = parts;
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

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search by code, name, or category..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-10"
          />
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
        <div className={`grid gap-3 transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
          {parts.map((part) => {
            const status = stockStatus(part);
            return (
              <Card key={part.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-900 text-sm">{part.name}</span>
                      <Badge className="bg-slate-100 text-slate-600 border-slate-200">{part.code}</Badge>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-400 mt-1 flex-wrap">
                      {part.category && <span>{part.category}</span>}
                      {part.location && <span>• {part.location}</span>}
                    </div>
                    <div className="flex items-center gap-4 mt-2 text-sm">
                      <div>
                        <span className="text-slate-400 text-xs">Current: </span>
                        <span className={`font-bold ${status === 'low' ? 'text-orange-600' : status === 'over' ? 'text-blue-600' : 'text-slate-900'}`}>
                          {part.current_stock} {part.unit}
                        </span>
                      </div>
                      <span className="text-xs text-slate-400">Min: {part.min_stock} / Max: {part.max_stock}</span>
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
                    </div>
                  </div>
                  {canManage && (
                    <div className="flex gap-1 flex-shrink-0">
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
                      <button onClick={() => openEdit(part)} className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg">
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleDelete(part.id)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
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
