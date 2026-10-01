import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase, GR_KIND_LABELS } from '@/lib/supabase';
import { Badge, Button, Card, EmptyState, Input, Modal, Select, Spinner } from '@/components/ui';
import { matchesQuery } from '@/components/Pickers';
import EditTransactionModal from '@/components/EditTransactionModal';
import { FileText, Paperclip, Pencil, RefreshCw, Search } from 'lucide-react';

type GRKind = 'credit' | 'cash' | 'import';

type GRLine = {
  id: string;
  created_at: string;
  created_by: string | null;
  quantity: number;
  stock_before: number | null;
  balance_after: number | null;
  gr_no: string;
  gr_kind: GRKind | null;
  source: string | null;
  reference: string | null;
  notes: string | null;
  gr_attachments: string[] | null;
  transaction_no: string | null;
  spare_part: { code: string; name: string; unit: string } | null;
};

type GR = {
  gr_no: string;
  gr_kind: GRKind | null;
  created_at: string;
  created_by: string | null;
  source: string | null;
  reference: string | null;
  notes: string | null;
  attachments: string[];
  lines: GRLine[];
};

const KIND_COLORS: Record<GRKind, string> = {
  credit: 'bg-blue-100 text-blue-700 border-blue-200',
  cash: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  import: 'bg-violet-100 text-violet-700 border-violet-200',
};

const PAGE_SIZE = 1000;

function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function GoodsReceipts() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const [editTxId, setEditTxId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [grs, setGrs] = useState<GR[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [dateFrom, setDateFrom] = useState(() => toDateInput(new Date(Date.now() - 89 * 24 * 60 * 60 * 1000)));
  const [dateTo, setDateTo] = useState(() => toDateInput(new Date()));
  const [detail, setDetail] = useState<GR | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    const fromIso = dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : null;
    const toIso = dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : null;

    const rows: GRLine[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      let q = supabase
        .from('inventory_transactions')
        .select(
          'id, created_at, created_by, quantity, stock_before, balance_after, gr_no, gr_kind, source, reference, notes, gr_attachments, transaction_no, spare_part:spare_parts(code, name, unit)'
        )
        .eq('type', 'stock_in')
        .not('gr_no', 'is', null)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (fromIso) q = q.gte('created_at', fromIso);
      if (toIso) q = q.lte('created_at', toIso);
      const { data, error } = await q;
      if (error) {
        setLoadError(error.message);
        setLoading(false);
        return;
      }
      const chunk = (data as unknown as GRLine[]) ?? [];
      rows.push(...chunk);
      if (chunk.length < PAGE_SIZE) break;
    }

    const { data: profs } = await supabase.from('profiles').select('id, full_name');
    const map: Record<string, string> = {};
    for (const p of (profs as { id: string; full_name: string }[]) ?? []) map[p.id] = p.full_name;
    setNames(map);

    // Kelompokkan per nomor GR (satu GR bisa memuat banyak barang).
    const byNo = new Map<string, GR>();
    for (const r of rows) {
      let g = byNo.get(r.gr_no);
      if (!g) {
        g = {
          gr_no: r.gr_no,
          gr_kind: r.gr_kind,
          created_at: r.created_at,
          created_by: r.created_by,
          source: r.source,
          reference: r.reference,
          notes: r.notes,
          attachments: [],
          lines: [],
        };
        byNo.set(r.gr_no, g);
      }
      g.lines.push(r);
      for (const url of r.gr_attachments ?? []) if (!g.attachments.includes(url)) g.attachments.push(url);
    }
    const list = Array.from(byNo.values());
    for (const g of list) g.lines.sort((a, b) => (a.spare_part?.code ?? '').localeCompare(b.spare_part?.code ?? ''));
    list.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.gr_no.localeCompare(a.gr_no));
    setGrs(list);
    setLoading(false);
  }, [dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    return grs.filter((g) => {
      if (kind !== 'all' && g.gr_kind !== kind) return false;
      if (!search.trim()) return true;
      const hay = [
        g.gr_no,
        g.source ?? '',
        g.reference ?? '',
        g.notes ?? '',
        g.created_by ? names[g.created_by] ?? '' : '',
        ...g.lines.flatMap((l) => [l.spare_part?.code ?? '', l.spare_part?.name ?? '', l.transaction_no ?? '']),
      ].join(' ');
      return matchesQuery(hay, search);
    });
  }, [grs, kind, search, names]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Cari no. GR, sumber, referensi/PR, spare part, pembuat..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={kind} onChange={(e) => setKind(e.target.value)} className="lg:w-56">
          <option value="all">Semua Jenis GR</option>
          <option value="credit">{GR_KIND_LABELS.credit}</option>
          <option value="cash">{GR_KIND_LABELS.cash}</option>
          <option value="import">{GR_KIND_LABELS.import}</option>
        </Select>
        <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="lg:w-40" aria-label="Dari tanggal" />
        <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="lg:w-40" aria-label="Sampai tanggal" />
        <Button variant="secondary" onClick={load}>
          <RefreshCw className="w-4 h-4" /> Refresh
        </Button>
      </div>

      <p className="text-xs text-slate-500">
        Menampilkan {filtered.length} dari {grs.length} GR pada periode ini. Pemasukan lama tanpa nomor GR tidak termasuk dalam daftar.
      </p>

      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm px-4 py-3">Gagal memuat daftar GR: {loadError}</div>
      )}

      <Card className="overflow-hidden">
        {loading ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <EmptyState message="Belum ada GR pada periode/filter ini." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-4 py-3">No. GR</th>
                  <th className="text-left px-4 py-3">Tanggal</th>
                  <th className="text-left px-4 py-3">Sumber</th>
                  <th className="text-left px-4 py-3">Referensi / PR</th>
                  <th className="text-left px-4 py-3">Barang</th>
                  <th className="text-left px-4 py-3">Dibuat oleh</th>
                  <th className="text-right px-4 py-3">Dokumen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((g) => (
                  <tr key={g.gr_no} className="hover:bg-slate-50">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-medium text-slate-800">{g.gr_no}</div>
                      {g.gr_kind && <Badge className={KIND_COLORS[g.gr_kind]}>{GR_KIND_LABELS[g.gr_kind]}</Badge>}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{fmtDateTime(g.created_at)}</td>
                    <td className="px-4 py-3 text-xs text-slate-600">{g.source ?? '-'}</td>
                    <td className="px-4 py-3 text-xs text-slate-600 max-w-xs">{g.reference ?? '-'}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-700">{g.lines.length} barang</div>
                      <div className="text-xs text-slate-400 max-w-xs truncate">
                        {g.lines.slice(0, 2).map((l) => l.spare_part?.name).filter(Boolean).join(', ')}
                        {g.lines.length > 2 ? `, +${g.lines.length - 2} lainnya` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600 whitespace-nowrap">{g.created_by ? names[g.created_by] ?? '-' : '-'}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                        {g.attachments.length > 0 && (
                          <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                            <Paperclip className="w-3 h-3" /> {g.attachments.length}
                          </span>
                        )}
                        <Button size="sm" variant="secondary" onClick={() => setDetail(g)}>
                          <FileText className="w-4 h-4" /> Detail
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editTxId && (
        <EditTransactionModal
          txId={editTxId}
          onClose={() => setEditTxId(null)}
          onSaved={async () => {
            setEditTxId(null);
            await load();
          }}
        />
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title={`Detail GR ${detail?.gr_no ?? ''}`} maxWidth="max-w-3xl">
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-400">Jenis GR</p>
                <p className="font-medium text-slate-800">{detail.gr_kind ? GR_KIND_LABELS[detail.gr_kind] : '-'}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-400">Tanggal &amp; dibuat oleh</p>
                <p className="font-medium text-slate-800">{fmtDateTime(detail.created_at)}</p>
                <p className="text-xs text-slate-500">{detail.created_by ? names[detail.created_by] ?? '-' : '-'}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-400">Sumber</p>
                <p className="font-medium text-slate-800">{detail.source ?? '-'}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-400">Referensi / PR</p>
                <p className="font-medium text-slate-800">{detail.reference ?? '-'}</p>
              </div>
            </div>

            {detail.notes && (
              <div className="rounded-lg bg-slate-50 p-3 text-sm">
                <p className="text-xs text-slate-400">Keterangan</p>
                <p className="text-slate-700 whitespace-pre-wrap">{detail.notes}</p>
              </div>
            )}

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="text-left px-3 py-2">Spare Part</th>
                    <th className="text-right px-3 py-2">Qty</th>
                    <th className="text-right px-3 py-2">Stok Sebelum</th>
                    <th className="text-right px-3 py-2">Saldo</th>
                    <th className="text-left px-3 py-2">No. Transaksi</th>
                    {isAdmin && <th className="text-right px-3 py-2">Aksi</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detail.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-3 py-2">
                        <b>{l.spare_part?.code}</b>
                        <div className="text-xs text-slate-500">{l.spare_part?.name}</div>
                      </td>
                      <td className="px-3 py-2 text-right font-medium">+{l.quantity} {l.spare_part?.unit}</td>
                      <td className="px-3 py-2 text-right text-slate-500">{l.stock_before ?? '-'}</td>
                      <td className="px-3 py-2 text-right text-slate-600">{l.balance_after ?? '-'}</td>
                      <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">{l.transaction_no ?? '-'}</td>
                      {isAdmin && (
                        <td className="px-3 py-2 text-right">
                          <Button size="sm" variant="secondary" onClick={() => { setDetail(null); setEditTxId(l.id); }}>
                            <Pencil className="w-3.5 h-3.5" /> Edit
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {detail.attachments.length > 0 && (
              <div>
                <p className="text-xs text-slate-400 mb-1">Lampiran</p>
                <div className="flex flex-wrap gap-3">
                  {detail.attachments.map((url, idx) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline">
                      <Paperclip className="w-3.5 h-3.5" /> Lampiran {idx + 1}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
