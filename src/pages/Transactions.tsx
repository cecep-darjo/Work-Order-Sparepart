import { useEffect, useState, useCallback } from 'react';
import { supabase, TX_TYPE_LABELS, TX_TYPE_COLORS, type InventoryTransaction, type SparePart } from '@/lib/supabase';
import { Card, Badge, Select, Input, Spinner, EmptyState } from '@/components/ui';
import { Search } from 'lucide-react';

export default function Transactions() {
  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [partFilter, setPartFilter] = useState('all');
  const [parts, setParts] = useState<SparePart[]>([]);

  const load = useCallback(async () => {
    setLoading(true);

    const { data: sp } = await supabase.from('spare_parts').select('*').order('name');
    setParts((sp as SparePart[]) ?? []);

    let query = supabase
      .from('inventory_transactions')
      .select('*, spare_part:spare_parts(*)')
      .order('created_at', { ascending: false });

    if (typeFilter !== 'all') query = query.eq('type', typeFilter);
    if (partFilter !== 'all') query = query.eq('spare_part_id', partFilter);

    const { data } = await query;
    let txns = (data as unknown as InventoryTransaction[]) ?? [];

    if (search) {
      const s = search.toLowerCase();
      txns = txns.filter(
        (t) =>
          t.spare_part?.name.toLowerCase().includes(s) ||
          t.spare_part?.code.toLowerCase().includes(s) ||
          (t.reference ?? '').toLowerCase().includes(s) ||
          (t.notes ?? '').toLowerCase().includes(s)
      );
    }

    setTransactions(txns);
    setLoading(false);
  }, [search, typeFilter, partFilter]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search by part, reference, or notes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="sm:w-40">
          <option value="all">All Types</option>
          <option value="stock_in">Stock In</option>
          <option value="stock_out">Stock Out</option>
          <option value="adjustment">Adjustment</option>
          <option value="opname">Opname</option>
        </Select>
        <Select value={partFilter} onChange={(e) => setPartFilter(e.target.value)} className="sm:w-48">
          <option value="all">All Parts</option>
          {parts.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </div>

      {/* List */}
      {transactions.length === 0 ? (
        <Card className="p-6">
          <EmptyState message="No transactions found" />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Date</th>
                  <th className="text-left px-4 py-3 font-medium">Part</th>
                  <th className="text-left px-4 py-3 font-medium">Type</th>
                  <th className="text-right px-4 py-3 font-medium">Qty</th>
                  <th className="text-right px-4 py-3 font-medium">Balance</th>
                  <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Reference</th>
                  <th className="text-left px-4 py-3 font-medium hidden md:table-cell">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {transactions.map((tx) => (
                  <tr key={tx.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap text-xs">
                      {new Date(tx.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{tx.spare_part?.name}</p>
                      <p className="text-xs text-slate-400">{tx.spare_part?.code}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={TX_TYPE_COLORS[tx.type]}>{TX_TYPE_LABELS[tx.type]}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-slate-700">
                      {tx.type === 'stock_out' ? '-' : tx.type === 'stock_in' ? '+' : ''}{tx.quantity}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600">
                      {tx.balance_after ?? '-'}
                    </td>
                    <td className="px-4 py-3 text-slate-500 hidden sm:table-cell text-xs">
                      {tx.reference ?? '-'}
                    </td>
                    <td className="px-4 py-3 text-slate-500 hidden md:table-cell text-xs max-w-xs truncate">
                      {tx.notes ?? '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
