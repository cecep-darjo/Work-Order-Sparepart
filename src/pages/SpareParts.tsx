import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  supabase,
  stockStatus,
  type SparePart,
} from '@/lib/supabase';
import { Card, Badge, Button, Input, Select, Label, Modal, Textarea, Spinner, EmptyState } from '@/components/ui';
import { Plus, Search, Pencil, Trash2, Package, AlertTriangle, TrendingUp, Sliders } from 'lucide-react';

type StockLevel = 'all' | 'low' | 'normal' | 'over';

export default function SpareParts({ lowStockOnly = false }: { lowStockOnly?: boolean }) {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [parts, setParts] = useState<SparePart[]>([]);
  const [search, setSearch] = useState('');
  const [stockFilter, setStockFilter] = useState<StockLevel>(lowStockOnly ? 'low' : 'all');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SparePart | null>(null);
  const [showTx, setShowTx] = useState<SparePart | null>(null);
  const [acting, setActing] = useState(false);

  const [form, setForm] = useState({
    code: '',
    name: '',
    category: '',
    unit: 'pcs',
    min_stock: 0,
    max_stock: 0,
    current_stock: 0,
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
    setLoading(true);
    let query = supabase.from('spare_parts').select('*').order('name');

    if (search) {
      query = query.or(`code.ilike.%${search}%,name.ilike.%${search}%,category.ilike.%${search}%`);
    }

    const { data } = await query;
    let filtered = (data as SparePart[]) ?? [];

    if (stockFilter === 'low') {
      filtered = filtered.filter((p) => stockStatus(p) === 'low');
    } else if (stockFilter === 'over') {
      filtered = filtered.filter((p) => stockStatus(p) === 'over');
    } else if (stockFilter === 'normal') {
      filtered = filtered.filter((p) => stockStatus(p) === 'normal');
    }

    setParts(filtered);
    setLoading(false);
  }, [search, stockFilter]);

  useEffect(() => {
    loadParts();
  }, [loadParts]);

  function openCreate() {
    setEditing(null);
    setForm({ code: '', name: '', category: '', unit: 'pcs', min_stock: 0, max_stock: 0, current_stock: 0, location: '' });
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
      current_stock: part.current_stock,
      location: part.location ?? '',
    });
    setShowForm(true);
  }

  async function handleSave() {
    setActing(true);
    const data = {
      code: form.code,
      name: form.name,
      category: form.category || null,
      unit: form.unit,
      min_stock: form.min_stock,
      max_stock: form.max_stock,
      current_stock: form.current_stock,
      location: form.location || null,
      updated_at: new Date().toISOString(),
    };

    if (editing) {
      await supabase.from('spare_parts').update(data).eq('id', editing.id);
    } else {
      await supabase.from('spare_parts').insert(data);
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
    setActing(true);

    let newStock = showTx.current_stock;
    if (txForm.type === 'stock_in') newStock += txForm.quantity;
    else if (txForm.type === 'stock_out') newStock -= txForm.quantity;
    else if (txForm.type === 'adjustment' || txForm.type === 'opname') newStock = txForm.quantity;

    await supabase.from('inventory_transactions').insert({
      spare_part_id: showTx.id,
      type: txForm.type,
      quantity: txForm.quantity,
      balance_after: newStock,
      reference: txForm.reference || null,
      notes: txForm.notes || null,
      created_by: profile.id,
    });

    await supabase
      .from('spare_parts')
      .update({ current_stock: newStock, updated_at: new Date().toISOString() })
      .eq('id', showTx.id);

    // Activity log
    await supabase.from('activity_log').insert({
      user_id: profile.id,
      action: `inventory_${txForm.type}`,
      entity_type: 'spare_part',
      entity_id: showTx.id,
      details: `${showTx.code}: ${txForm.type} qty ${txForm.quantity}`,
    });

    setActing(false);
    setShowTx(null);
    setTxForm({ type: 'stock_in', quantity: 0, reference: '', notes: '' });
    loadParts();
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
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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
        <div className="grid gap-3">
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

      {/* Create/Edit Modal */}
      <Modal open={showForm} onClose={() => setShowForm(false)} title={editing ? 'Edit Spare Part' : 'Add Spare Part'} maxWidth="max-w-2xl">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Code *</Label>
              <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} placeholder="SP-001" />
            </div>
            <div>
              <Label>Unit</Label>
              <Input value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} placeholder="pcs" />
            </div>
          </div>
          <div>
            <Label>Name *</Label>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Bearing 6204" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Category</Label>
              <Input value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} placeholder="Bearing" />
            </div>
            <div>
              <Label>Location</Label>
              <Input value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} placeholder="Rack A-3" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <Label>Min Stock</Label>
              <Input type="number" min={0} value={form.min_stock} onChange={(e) => setForm((f) => ({ ...f, min_stock: Number(e.target.value) }))} />
            </div>
            <div>
              <Label>Max Stock</Label>
              <Input type="number" min={0} value={form.max_stock} onChange={(e) => setForm((f) => ({ ...f, max_stock: Number(e.target.value) }))} />
            </div>
            <div>
              <Label>Current Stock</Label>
              <Input type="number" min={0} value={form.current_stock} onChange={(e) => setForm((f) => ({ ...f, current_stock: Number(e.target.value) }))} />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={acting || !form.code || !form.name}>
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
