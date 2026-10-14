import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase, GR_KIND_LABELS } from '@/lib/supabase';
import { Badge, Button, Card, EmptyState, Input, Label, Modal, Select, Spinner } from '@/components/ui';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { matchesQuery } from '@/components/Pickers';
import EditTransactionModal from '@/components/EditTransactionModal';
import { ArrowDown, ArrowUp, ArrowUpDown, FileText, Paperclip, Pencil, RefreshCw, Search } from 'lucide-react';

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
  spare_part: { code: string; name: string; unit: string; inventory_code?: string | null } | null;
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
// Daftar ditampilkan bertahap agar tetap ringan saat periode "Semua" memuat ribuan GR.
const LIST_STEP = 100;
const DEFAULT_PERIOD_DAYS = 90;

type SortKey = 'gr_no' | 'created_at' | 'source' | 'reference' | 'items' | 'created_by';

function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Tanggal awal untuk periode "N hari terakhir" (hari ini dihitung). */
function daysAgoInput(days: number): string {
  return toDateInput(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));
}

const PERIOD_PRESETS: { key: string; label: string; range: () => [string, string] }[] = [
  { key: '30', label: '30 hari', range: () => [daysAgoInput(30), toDateInput(new Date())] },
  { key: '90', label: '90 hari', range: () => [daysAgoInput(DEFAULT_PERIOD_DAYS), toDateInput(new Date())] },
  { key: 'year', label: 'Tahun ini', range: () => [`${new Date().getFullYear()}-01-01`, toDateInput(new Date())] },
  { key: 'all', label: 'Semua', range: () => ['', ''] },
];

/** Ikon urutan (sort) di header kolom tabel (sama dengan tabel Inventory Transactions). */
function SortIcon({ active, dir }: { active: boolean; dir: 1 | -1 }) {
  if (!active) return <ArrowUpDown className="w-3.5 h-3.5 text-slate-300" />;
  return dir === 1 ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />;
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
  // Input langsung berubah; penyaringan memakai nilai tertunda (debounce) dan dilakukan di klien.
  const [search, setSearch] = useState('');
  const searchTerm = useDebouncedValue(search.trim(), 250);
  const [kind, setKind] = useState('all');
  const [creator, setCreator] = useState('all');
  const [attach, setAttach] = useState<'all' | 'with' | 'without'>('all');
  const [dateFrom, setDateFrom] = useState(() => daysAgoInput(DEFAULT_PERIOD_DAYS));
  const [dateTo, setDateTo] = useState(() => toDateInput(new Date()));
  // Urutan bawaan: tanggal terbaru dulu.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'created_at', dir: -1 });
  const [shown, setShown] = useState(LIST_STEP);
  const [detail, setDetail] = useState<GR | null>(null);
  const reqSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setLoadError(null);

    const fromIso = dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : null;
    const toIso = dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : null;

    const rows: GRLine[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      let q = supabase
        .from('inventory_transactions')
        .select(
          'id, created_at, created_by, quantity, stock_before, balance_after, gr_no, gr_kind, source, reference, notes, gr_attachments, transaction_no, spare_part:spare_parts(code, name, unit, inventory_code)'
        )
        .eq('type', 'stock_in')
        .not('gr_no', 'is', null)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (fromIso) q = q.gte('created_at', fromIso);
      if (toIso) q = q.lte('created_at', toIso);
      const { data, error } = await q;
      if (seq !== reqSeq.current) return; // sudah ada permintaan yang lebih baru; abaikan jawaban usang
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
    if (seq !== reqSeq.current) return;
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

  // Teks pencarian tiap GR dihitung sekali per pemuatan data (bukan per ketikan). Mencakup: no. GR,
  // jenis GR (mis. "SKSB", "kredit"), sumber, referensi/PR, keterangan, pembuat, serta tiap barang
  // (kode, nama, kode inventori, no. transaksi).
  const haystacks = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of grs) {
      m.set(
        g.gr_no,
        [
          g.gr_no,
          g.gr_kind ? GR_KIND_LABELS[g.gr_kind] : '',
          g.source ?? '',
          g.reference ?? '',
          g.notes ?? '',
          g.created_by ? names[g.created_by] ?? '' : '',
          ...g.lines.flatMap((l) => [
            l.spare_part?.code ?? '',
            l.spare_part?.name ?? '',
            l.spare_part?.inventory_code ?? '',
            l.transaction_no ?? '',
          ]),
        ].join(' ')
      );
    }
    return m;
  }, [grs, names]);

  // Pilihan "Dibuat oleh" diambil dari GR yang sudah dimuat (tanpa query tambahan).
  const creatorOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const g of grs) if (g.created_by) ids.add(g.created_by);
    return [...ids]
      .map((id) => [id, names[id] ?? '(tanpa nama)'] as const)
      .sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: 'base' }));
  }, [grs, names]);

  // Semua filter KECUALI jenis GR; dipakai juga untuk hitungan per jenis di dropdown.
  const baseFiltered = useMemo(
    () =>
      grs.filter((g) => {
        if (creator !== 'all' && g.created_by !== creator) return false;
        if (attach === 'with' && g.attachments.length === 0) return false;
        if (attach === 'without' && g.attachments.length > 0) return false;
        // Metode sama dengan pencarian spare part: semua kata harus cocok, urutan bebas.
        if (searchTerm && !matchesQuery(haystacks.get(g.gr_no) ?? '', searchTerm)) return false;
        return true;
      }),
    [grs, haystacks, creator, attach, searchTerm]
  );

  const kindCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const g of baseFiltered) if (g.gr_kind) c[g.gr_kind] = (c[g.gr_kind] ?? 0) + 1;
    return c;
  }, [baseFiltered]);

  const sorted = useMemo(() => {
    const list = kind === 'all' ? baseFiltered : baseFiltered.filter((g) => g.gr_kind === kind);
    const { key, dir } = sort;
    const time = (iso: string) => new Date(iso).getTime();
    const text = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    const textOf = (g: GR): string =>
      key === 'created_by' ? (g.created_by ? names[g.created_by] ?? '' : '') : key === 'source' ? g.source ?? '' : g.reference ?? '';
    return [...list].sort((a, b) => {
      let r = 0;
      switch (key) {
        case 'created_at':
          r = time(a.created_at) - time(b.created_at);
          break;
        case 'items':
          r = a.lines.length - b.lines.length;
          break;
        case 'gr_no':
          r = text(a.gr_no, b.gr_no);
          break;
        default: {
          const av = textOf(a).trim();
          const bv = textOf(b).trim();
          // Nilai kosong selalu di paling bawah, apa pun arah urutannya.
          if (!av && bv) return 1;
          if (av && !bv) return -1;
          r = av && bv ? text(av, bv) : 0;
        }
      }
      // Seri: yang terbaru dulu.
      return r * dir || time(b.created_at) - time(a.created_at) || text(b.gr_no, a.gr_no);
    });
  }, [baseFiltered, kind, sort, names]);

  // Setiap pencarian/filter/urutan berubah, daftar kembali ke 100 baris pertama.
  useEffect(() => {
    setShown(LIST_STEP);
  }, [sorted]);

  function toggleSort(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 1 ? -1 : 1 }
        : { key, dir: key === 'created_at' || key === 'items' ? -1 : 1 } // tanggal & jumlah barang: terbesar/terbaru dulu
    );
  }

  const defaultFrom = daysAgoInput(DEFAULT_PERIOD_DAYS);
  const defaultTo = toDateInput(new Date());
  const hasFilter = Boolean(
    search.trim() || kind !== 'all' || creator !== 'all' || attach !== 'all' || dateFrom !== defaultFrom || dateTo !== defaultTo
  );

  function resetFilters() {
    setSearch('');
    setKind('all');
    setCreator('all');
    setAttach('all');
    setDateFrom(defaultFrom);
    setDateTo(defaultTo);
  }

  // Saat mencari, barang yang cocok dengan kata kunci ditampilkan lebih dulu di kolom "Barang"
  // supaya jelas kenapa GR itu muncul (baris hanya menampilkan 2 nama barang).
  const queryWords = useMemo(() => searchTerm.toLowerCase().split(/\s+/).filter(Boolean), [searchTerm]);
  function itemSummary(g: GR): string {
    const label = (l: GRLine) => l.spare_part?.name ?? '';
    const isRelevant = (l: GRLine) => {
      const t = [l.spare_part?.code, l.spare_part?.name, l.spare_part?.inventory_code].filter(Boolean).join(' ').toLowerCase();
      return queryWords.some((w) => t.includes(w));
    };
    const lines = queryWords.length ? [...g.lines].sort((a, b) => Number(isRelevant(b)) - Number(isRelevant(a))) : g.lines;
    const head = lines.slice(0, 2).map(label).filter(Boolean).join(', ');
    return head + (lines.length > 2 ? `, +${lines.length - 2} lainnya` : '');
  }

  const th = (label: string, key: SortKey, align: 'left' | 'right' = 'left') => (
    <th className={`${align === 'right' ? 'text-right' : 'text-left'} px-4 py-3`}>
      <button type="button" onClick={() => toggleSort(key)} className="inline-flex items-center gap-1 hover:text-slate-800 uppercase">
        {label} <SortIcon active={sort.key === key} dir={sort.dir} />
      </button>
    </th>
  );

  const periodLimited = Boolean(dateFrom || dateTo);

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Cari no. GR, jenis, sumber, referensi/PR, spare part, kode inventori, pembuat..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button variant="secondary" onClick={load} disabled={loading}>
          <RefreshCw className="w-4 h-4" /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 items-end">
        <div>
          <Label>Jenis GR</Label>
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">Semua ({baseFiltered.length})</option>
            {(['credit', 'cash', 'import'] as const).map((k) => (
              <option key={k} value={k}>
                {GR_KIND_LABELS[k]} ({kindCounts[k] ?? 0})
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Dibuat oleh</Label>
          <Select value={creator} onChange={(e) => setCreator(e.target.value)}>
            <option value="all">Semua</option>
            {creatorOptions.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Lampiran</Label>
          <Select value={attach} onChange={(e) => setAttach(e.target.value as 'all' | 'with' | 'without')}>
            <option value="all">Semua</option>
            <option value="with">Dengan lampiran</option>
            <option value="without">Tanpa lampiran</option>
          </Select>
        </div>
        <div>
          <Label>Dari tanggal</Label>
          <Input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div>
          <Label>Sampai tanggal</Label>
          <Input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">Periode:</span>
        {PERIOD_PRESETS.map((p) => {
          const [f, t] = p.range();
          const active = dateFrom === f && dateTo === t;
          return (
            <Button
              key={p.key}
              size="sm"
              variant={active ? 'primary' : 'secondary'}
              onClick={() => {
                setDateFrom(f);
                setDateTo(t);
              }}
            >
              {p.label}
            </Button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 text-xs text-slate-500 flex-wrap">
        <span>
          Menampilkan {Math.min(shown, sorted.length)} dari {sorted.length} GR hasil filter • total {grs.length} GR{' '}
          {periodLimited ? 'pada periode ini' : 'pada semua periode'}. Pemasukan lama tanpa nomor GR tidak termasuk dalam daftar.
        </span>
        {hasFilter && (
          <button type="button" className="text-blue-600 hover:text-blue-700 font-medium" onClick={resetFilters}>
            Reset filter
          </button>
        )}
      </div>

      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm px-4 py-3">Gagal memuat daftar GR: {loadError}</div>
      )}

      <Card className="overflow-hidden">
        {loading ? (
          <Spinner />
        ) : sorted.length === 0 ? (
          <div className="pb-4">
            <EmptyState
              message={grs.length === 0 ? 'Belum ada GR pada periode ini.' : 'Tidak ada GR yang cocok dengan pencarian/filter.'}
            />
            {periodLimited && (
              <div className="text-center">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setDateFrom('');
                    setDateTo('');
                  }}
                >
                  Cari di semua periode
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  {th('No. GR', 'gr_no')}
                  {th('Tanggal', 'created_at')}
                  {th('Sumber', 'source')}
                  {th('Referensi / PR', 'reference')}
                  {th('Barang', 'items')}
                  {th('Dibuat oleh', 'created_by')}
                  <th className="text-right px-4 py-3">Dokumen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sorted.slice(0, shown).map((g) => (
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
                      <div
                        className="text-xs text-slate-400 max-w-xs truncate"
                        title={g.lines.map((l) => l.spare_part?.name).filter(Boolean).join(', ')}
                      >
                        {itemSummary(g)}
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
            {sorted.length > shown && (
              <div className="border-t border-slate-100 p-3 text-center">
                <Button size="sm" variant="secondary" onClick={() => setShown((n) => n + LIST_STEP)}>
                  Tampilkan {Math.min(LIST_STEP, sorted.length - shown)} lagi (sisa {sorted.length - shown})
                </Button>
              </div>
            )}
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
