import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  supabase,
  TX_TYPE_LABELS,
  TX_TYPE_COLORS,
  type InventoryTransaction,
  type SparePart,
} from '@/lib/supabase';
import { Card, Badge, Button, Select, Input, Label, Modal, Textarea, Spinner, EmptyState } from '@/components/ui';
import { Search, ArrowDownToLine, ArrowUpFromLine, History, PackageSearch, RefreshCw } from 'lucide-react';

type TxKind = 'stock_in' | 'stock_out';

export default function Transactions() {
  const { profile } = useAuth();
  const canTransact = profile?.role === 'admin' || profile?.role === 'inventory';
  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [parts, setParts] = useState<SparePart[]>([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [partFilter, setPartFilter] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [txKind, setTxKind] = useState<TxKind>('stock_in');
  const [acting, setActing] = useState(false);
  const [stockCardPart, setStockCardPart] = useState<SparePart | null>(null);
  const [stockCard, setStockCard] = useState<InventoryTransaction[]>([]);
  const [form, setForm] = useState({
    spare_part_id: '',
    quantity: 0,
    reference: '',
    notes: '',
    source: '',
    destination: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: sp }, { data }] = await Promise.all([
      supabase.from('spare_parts').select('*').order('name'),
      supabase
        .from('inventory_transactions')
        .select('*, spare_part:spare_parts(*)')
        .order('created_at', { ascending: false }),
    ]);
    setParts((sp as SparePart[]) ?? []);
    let txns = (data as unknown as InventoryTransaction[]) ?? [];
    if (typeFilter !== 'all') txns = txns.filter((t) => t.type === typeFilter);
    if (partFilter !== 'all') txns = txns.filter((t) => t.spare_part_id === partFilter);
    if (search.trim()) {
      const s = search.toLowerCase();
      txns = txns.filter((t) =>
        t.spare_part?.name?.toLowerCase().includes(s) ||
        t.spare_part?.code?.toLowerCase().includes(s) ||
        (t.reference ?? '').toLowerCase().includes(s) ||
        (t.notes ?? '').toLowerCase().includes(s) ||
        ((t as InventoryTransaction & { transaction_no?: string }).transaction_no ?? '').toLowerCase().includes(s)
      );
    }
    setTransactions(txns);
    setLoading(false);
  }, [search, typeFilter, partFilter]);

  useEffect(() => { load(); }, [load]);

  function openTransaction(type: TxKind) {
    setTxKind(type);
    setForm({ spare_part_id: '', quantity: 0, reference: '', notes: '', source: '', destination: '' });
    setShowForm(true);
  }

  async function submitTransaction() {
    if (!profile || !form.spare_part_id || form.quantity <= 0) {
      alert('Spare part dan quantity wajib diisi.');
      return;
    }
    const part = parts.find((p) => p.id === form.spare_part_id);
    if (!part) return;
    if (txKind === 'stock_out' && form.quantity > part.current_stock) {
      alert(`Stok tidak mencukupi. Stok tersedia: ${part.current_stock} ${part.unit}.`);
      return;
    }
    setActing(true);
    const { error } = await supabase.rpc('apply_inventory_transaction', {
      p_spare_part_id: form.spare_part_id,
      p_type: txKind,
      p_quantity: form.quantity,
      p_reference: form.reference || null,
      p_notes: form.notes || null,
      p_work_order_id: null,
      p_source: form.source || null,
      p_destination: form.destination || null,
    });
    setActing(false);
    if (error) {
      alert('Transaksi gagal: ' + error.message);
      return;
    }
    setShowForm(false);
    await load();
  }

  async function openStockCard(part: SparePart) {
    setStockCardPart(part);
    const { data } = await supabase
      .from('inventory_transactions')
      .select('*, spare_part:spare_parts(*)')
      .eq('spare_part_id', part.id)
      .order('created_at', { ascending: false });
    setStockCard((data as unknown as InventoryTransaction[]) ?? []);
  }

  const selectedPart = parts.find((p) => p.id === form.spare_part_id);

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input placeholder="Cari no. transaksi, part, referensi..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10" />
        </div>
        {canTransact && (
          <div className="flex gap-2">
            <Button onClick={() => openTransaction('stock_in')} variant="success">
              <ArrowDownToLine className="w-4 h-4" /> Pemasukan
            </Button>
            <Button onClick={() => openTransaction('stock_out')} variant="danger">
              <ArrowUpFromLine className="w-4 h-4" /> Pengeluaran
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="sm:w-44">
          <option value="all">Semua Transaksi</option>
          <option value="stock_in">Pemasukan</option>
          <option value="stock_out">Pengeluaran</option>
          <option value="adjustment">Adjustment</option>
          <option value="opname">Stock Opname</option>
        </Select>
        <Select value={partFilter} onChange={(e) => setPartFilter(e.target.value)} className="sm:w-64">
          <option value="all">Semua Spare Part</option>
          {parts.map((p) => <option key={p.id} value={p.id}>{p.code} - {p.name}</option>)}
        </Select>
        <Button variant="secondary" onClick={load}><RefreshCw className="w-4 h-4" /> Refresh</Button>
      </div>

      <Card className="overflow-hidden">
        {transactions.length === 0 ? <EmptyState message="Belum ada transaksi inventory." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-4 py-3">Transaksi</th>
                  <th className="text-left px-4 py-3">Tanggal</th>
                  <th className="text-left px-4 py-3">Spare Part</th>
                  <th className="text-left px-4 py-3">Jenis</th>
                  <th className="text-right px-4 py-3">Qty</th>
                  <th className="text-right px-4 py-3">Saldo</th>
                  <th className="text-left px-4 py-3">Referensi</th>
                  <th className="text-left px-4 py-3">Keterangan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {transactions.map((tx) => {
                  const extended = tx as InventoryTransaction & { transaction_no?: string; stock_before?: number | null };
                  return (
                    <tr key={tx.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-700 whitespace-nowrap">{extended.transaction_no ?? '-'}</td>
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{new Date(tx.created_at).toLocaleString('id-ID')}</td>
                      <td className="px-4 py-3"><b>{tx.spare_part?.code}</b><div className="text-xs text-slate-500">{tx.spare_part?.name}</div></td>
                      <td className="px-4 py-3"><Badge className={TX_TYPE_COLORS[tx.type]}>{TX_TYPE_LABELS[tx.type]}</Badge></td>
                      <td className="px-4 py-3 text-right font-medium">{tx.type === 'stock_out' ? '-' : tx.type === 'stock_in' ? '+' : ''}{tx.quantity} {tx.spare_part?.unit}</td>
                      <td className="px-4 py-3 text-right text-slate-600">{tx.balance_after ?? '-'}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{tx.reference ?? '-'}</td>
                      <td className="px-4 py-3 text-xs text-slate-500 max-w-xs">{tx.notes ?? '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3"><PackageSearch className="w-4 h-4 text-blue-600" /><h2 className="font-semibold">Stock Card</h2></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {parts.slice(0, 12).map((p) => (
            <button key={p.id} onClick={() => openStockCard(p)} className="text-left border border-slate-200 rounded-lg p-3 hover:bg-slate-50">
              <div className="font-medium text-sm">{p.code}</div><div className="text-xs text-slate-500 truncate">{p.name}</div>
              <div className="mt-1 text-sm font-semibold">{p.current_stock} {p.unit}</div>
            </button>
          ))}
        </div>
      </Card>

      <Modal open={showForm} onClose={() => !acting && setShowForm(false)} title={txKind === 'stock_in' ? 'Pemasukan Barang' : 'Pengeluaran Barang'} maxWidth="max-w-2xl">
        <div className="space-y-4">
          <div className="p-3 rounded-lg bg-slate-50 text-sm text-slate-600">Transaksi langsung diproses oleh <b>Inventory Control/Admin</b>. Tidak menggunakan approval.</div>
          <div><Label>Spare Part *</Label><Select value={form.spare_part_id} onChange={(e) => setForm((f) => ({ ...f, spare_part_id: e.target.value }))}><option value="">Pilih spare part...</option>{parts.map((p) => <option key={p.id} value={p.id}>{p.code} - {p.name} (stok: {p.current_stock} {p.unit})</option>)}</Select></div>
          <div className="grid grid-cols-2 gap-4">
            <div><Label>Quantity *</Label><Input type="number" min="0.01" step="any" value={form.quantity || ''} onChange={(e) => setForm((f) => ({ ...f, quantity: Number(e.target.value) }))} /></div>
            <div><Label>Satuan</Label><Input value={selectedPart?.unit ?? '-'} disabled className="bg-slate-50" /></div>
          </div>
          {txKind === 'stock_in' ? <div><Label>Sumber Barang</Label><Input placeholder="Supplier / retur / transfer / lainnya" value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} /></div> : <div><Label>Tujuan Pengeluaran</Label><Input placeholder="WO / Produksi / Transfer / lainnya" value={form.destination} onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value }))} /></div>}
          <div><Label>Referensi</Label><Input placeholder="PO, invoice, nomor WO, dokumen, dll." value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} /></div>
          <div><Label>Keterangan</Label><Textarea rows={3} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></div>
          {selectedPart && <div className="p-3 border rounded-lg text-sm"><div>Stok saat ini: <b>{selectedPart.current_stock} {selectedPart.unit}</b></div><div>Stok setelah transaksi: <b>{txKind === 'stock_in' ? selectedPart.current_stock + form.quantity : selectedPart.current_stock - form.quantity} {selectedPart.unit}</b></div></div>}
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setShowForm(false)} disabled={acting}>Batal</Button><Button onClick={submitTransaction} disabled={acting}>{acting ? 'Memproses...' : 'Simpan Transaksi'}</Button></div>
        </div>
      </Modal>

      <Modal open={!!stockCardPart} onClose={() => setStockCardPart(null)} title={`Stock Card - ${stockCardPart?.code ?? ''}`} maxWidth="max-w-4xl">
        {stockCardPart && <div className="space-y-3"><div className="text-sm text-slate-600">{stockCardPart.name} • Saldo sekarang <b>{stockCardPart.current_stock} {stockCardPart.unit}</b></div><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2 text-left">Tanggal</th><th className="px-3 py-2 text-left">No. Transaksi</th><th className="px-3 py-2 text-left">Jenis</th><th className="px-3 py-2 text-right">Masuk</th><th className="px-3 py-2 text-right">Keluar</th><th className="px-3 py-2 text-right">Saldo</th><th className="px-3 py-2 text-left">Ref</th></tr></thead><tbody className="divide-y">{stockCard.map((tx) => { const ext = tx as InventoryTransaction & { transaction_no?: string }; return <tr key={tx.id}><td className="px-3 py-2 text-xs">{new Date(tx.created_at).toLocaleString('id-ID')}</td><td className="px-3 py-2 text-xs font-medium">{ext.transaction_no ?? '-'}</td><td className="px-3 py-2"><Badge className={TX_TYPE_COLORS[tx.type]}>{TX_TYPE_LABELS[tx.type]}</Badge></td><td className="px-3 py-2 text-right">{tx.type === 'stock_in' ? tx.quantity : ''}</td><td className="px-3 py-2 text-right">{tx.type === 'stock_out' ? tx.quantity : ''}</td><td className="px-3 py-2 text-right font-medium">{tx.balance_after ?? '-'}</td><td className="px-3 py-2 text-xs">{tx.reference ?? '-'}</td></tr>; })}</tbody></table></div></div>}
      </Modal>
    </div>
  );
}
