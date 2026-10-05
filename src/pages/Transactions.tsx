import { uuid } from '@/lib/uuid';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  supabase,
  TX_TYPE_LABELS,
  TX_TYPE_COLORS,
  GR_KIND_LABELS,
  type InventoryTransaction,
  type SparePart,
} from '@/lib/supabase';
import { Card, Badge, Button, Select, Input, Label, Modal, Textarea, Spinner, EmptyState } from '@/components/ui';
import { SearchablePicker } from '@/components/Pickers';
import EditTransactionModal from '@/components/EditTransactionModal';
import { BON_SELECT, bonRemaining, type Bon, type BonItem } from '@/lib/bons';
import { printIssueSlipByNo, printLegacyIssue } from '@/lib/manualIssue';
import { Search, ArrowDownToLine, ArrowUpFromLine, PackageSearch, RefreshCw, FileDown, Plus, Trash2, Paperclip, ClipboardCheck, Pencil } from 'lucide-react';

type GRKind = 'credit' | 'cash' | 'import';

/** Satu baris pada daftar pengeluaran. Baris dari bon membawa bon_item_id + batas sisa bon. */
type IssueLine = {
  key: string;
  spare_part_id: string;
  quantity: number;
  bon_item_id: string | null;
  bon_no: string | null;
  bon_notes: string | null;
  max: number | null;
};

/** Satu baris pada daftar pemasukan. Baris dari PR membawa pr_item_id + batas sisa PR. */
type ReceiptLine = {
  key: string;
  spare_part_id: string;
  quantity: number;
  pr_item_id: string | null;
  pr_no: string | null;
  supplier_name: string | null;
  max: number | null;
};

type RecallPR = {
  id: string;
  pr_no: string | null;
  sap_no: string | null;
  supplier_id: string;
  created_at: string;
  supplier: { id: string; code: string; name: string } | null;
  items: { id: string; spare_part_id: string | null; spare_part_name: string; quantity: number; received_qty: number }[];
};

type RecallItem = RecallPR['items'][number];

function remaining(i: RecallItem): number {
  return Math.round((Number(i.quantity) - Number(i.received_qty)) * 1000) / 1000;
}

const MAX_GR_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_GR_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export default function Transactions() {
  const { profile } = useAuth();
  const canTransact = profile?.role === 'admin' || profile?.role === 'inventory';
  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [parts, setParts] = useState<SparePart[]>([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [partFilter, setPartFilter] = useState('all');
  const [showReceipt, setShowReceipt] = useState(false);
  const [acting, setActing] = useState(false);
  const [showIssue, setShowIssue] = useState(false);
  const [issueItems, setIssueItems] = useState<IssueLine[]>([]);
  const [openBons, setOpenBons] = useState<Bon[]>([]);
  const [loadingBons, setLoadingBons] = useState(false);
  const [bonRequester, setBonRequester] = useState('');
  // Nilai Referensi/Keperluan yang terisi otomatis dari bon (supaya tidak menimpa ketikan manual user)
  const [issueAuto, setIssueAuto] = useState({ notes: '', reference: '' });
  const [issuePart, setIssuePart] = useState('');
  const [issueQty, setIssueQty] = useState(1);
  const [issueForm, setIssueForm] = useState({ recipient: '', destination: '', reference: '', notes: '' });
  const [busyPdf, setBusyPdf] = useState<string | null>(null);
  const [stockCardPart, setStockCardPart] = useState<SparePart | null>(null);
  const [stockCard, setStockCard] = useState<InventoryTransaction[]>([]);
  const [grFiles, setGrFiles] = useState<File[]>([]);
  // Perkiraan nomor GR berikutnya (hanya tampilan; nomor sebenarnya diambil server saat pemasukan disimpan).
  const [previewGrNo, setPreviewGrNo] = useState<string | null>(null);
  const [previewingGrNo, setPreviewingGrNo] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editTxId, setEditTxId] = useState<string | null>(null); // admin: edit transaksi/dokumen
  const [receiptLines, setReceiptLines] = useState<ReceiptLine[]>([]);
  const [receiptPart, setReceiptPart] = useState('');
  const [receiptQty, setReceiptQty] = useState(1);
  const [receiptForm, setReceiptForm] = useState({ gr_kind: 'credit' as GRKind, source: '', reference: '', notes: '' });
  const [openPrs, setOpenPrs] = useState<RecallPR[]>([]);
  const [loadingPrs, setLoadingPrs] = useState(false);
  const [recallSupplier, setRecallSupplier] = useState('');

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
        (t.gr_no ?? '').toLowerCase().includes(s) ||
        ((t as InventoryTransaction & { transaction_no?: string }).transaction_no ?? '').toLowerCase().includes(s)
      );
    }
    setTransactions(txns);
    setLoading(false);
  }, [search, typeFilter, partFilter]);

  useEffect(() => { load(); }, [load]);

  async function openReceipt() {
    setReceiptLines([]);
    setReceiptPart('');
    setReceiptQty(1);
    setReceiptForm({ gr_kind: 'credit', source: '', reference: '', notes: '' });
    setGrFiles([]);
    setPreviewGrNo(null);
    setRecallSupplier('');
    setOpenPrs([]);
    setShowReceipt(true);

    // PR yang sudah bernomor & masih punya sisa barang -> bisa dipanggil berdasarkan supplier.
    setLoadingPrs(true);
    const { data } = await supabase
      .from('purchase_requirements')
      .select(
        'id, pr_no, sap_no, supplier_id, created_at, supplier:inventory_suppliers(id, code, name), items:purchase_requirement_items(id, spare_part_id, spare_part_name, quantity, received_qty)'
      )
      .eq('status', 'numbered')
      .order('created_at', { ascending: true });
    const rows = ((data as unknown as RecallPR[]) ?? []).filter((pr) => (pr.items ?? []).some((i) => remaining(i) > 0));
    setOpenPrs(rows);
    setLoadingPrs(false);
  }

  function fmtSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  function handlePickGrFiles(files: FileList | null) {
    if (!files) return;
    const selected = Array.from(files);
    const next: File[] = [];

    for (const f of selected) {
      if (f.size > MAX_GR_FILE_SIZE) {
        alert(`File ${f.name} melebihi 5MB.`);
        continue;
      }
      if (!ALLOWED_GR_MIME.includes(f.type)) {
        alert(`Tipe file ${f.name} tidak didukung. Hanya JPG/PNG/WEBP/PDF.`);
        continue;
      }
      const duplicate = [...grFiles, ...next].some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified);
      if (!duplicate) next.push(f);
    }

    if (next.length > 0) setGrFiles((prev) => [...prev, ...next]);
  }

  function removeGrFile(index: number) {
    setGrFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function uploadGrFiles(files: File[]): Promise<string[]> {
    const urls: string[] = [];
    for (const file of files) {
      const ext = file.name.includes('.') ? file.name.split('.').pop() : '';
      const safeBase = file.name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'file';
      const objectPath = `gr/${new Date().getFullYear()}/${Date.now()}-${uuid()}-${safeBase}${ext ? `.${ext}` : ''}`;
      const { error: uploadError } = await supabase.storage
        .from('inventory-gr-files')
        .upload(objectPath, file, { upsert: false, contentType: file.type });
      if (uploadError) throw uploadError;
      const { data } = supabase.storage.from('inventory-gr-files').getPublicUrl(objectPath);
      urls.push(data.publicUrl);
    }
    return urls;
  }

  /** Hanya MELIHAT nomor GR berikutnya. Tidak ada nomor yang terpakai sampai pemasukan disimpan. */
  async function previewGrNumber() {
    setPreviewingGrNo(true);
    const { data, error } = await supabase.rpc('peek_gr_number', { p_gr_kind: receiptForm.gr_kind });
    setPreviewingGrNo(false);
    if (error || !data) {
      alert('Gagal mengambil nomor GR: ' + (error?.message ?? 'nomor kosong'));
      return;
    }
    setPreviewGrNo(String(data));
  }

  const recallSuppliers = useMemo(() => {
    const map = new Map<string, { id: string; label: string; count: number }>();
    for (const pr of openPrs) {
      const cur = map.get(pr.supplier_id);
      if (cur) cur.count += 1;
      else map.set(pr.supplier_id, { id: pr.supplier_id, label: pr.supplier ? `${pr.supplier.code} - ${pr.supplier.name}` : '(supplier tidak diketahui)', count: 1 });
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [openPrs]);

  const recallPrs = useMemo(() => openPrs.filter((pr) => pr.supplier_id === recallSupplier), [openPrs, recallSupplier]);

  /** Tambahkan item PR ke daftar pemasukan (qty awal = sisa PR, boleh diubah untuk penerimaan sebagian). */
  function recallItems(pr: RecallPR, items: RecallItem[]) {
    const added: ReceiptLine[] = [];
    let unlinked = 0;
    for (const it of items) {
      const rem = remaining(it);
      if (rem <= 0) continue;
      if (!it.spare_part_id) { unlinked += 1; continue; }
      if (receiptLines.some((l) => l.pr_item_id === it.id)) continue;
      added.push({
        key: uuid(),
        spare_part_id: it.spare_part_id,
        quantity: rem,
        pr_item_id: it.id,
        pr_no: pr.pr_no,
        supplier_name: pr.supplier?.name ?? null,
        max: rem,
      });
    }
    if (unlinked > 0) {
      alert(`${unlinked} item PR belum terhubung ke master spare part (PR lama), jadi tidak bisa dipanggil. Tambahkan manual lewat pencarian spare part.`);
    }
    if (added.length > 0) setReceiptLines((prev) => [...prev, ...added]);
  }

  function addReceiptLine() {
    const part = parts.find((p) => p.id === receiptPart);
    if (!part) return;
    if (!(receiptQty > 0)) { alert('Quantity harus lebih besar dari 0.'); return; }
    setReceiptLines((prev) => {
      const existing = prev.find((l) => l.spare_part_id === receiptPart && !l.pr_item_id);
      if (existing) return prev.map((l) => (l === existing ? { ...l, quantity: l.quantity + receiptQty } : l));
      return [...prev, { key: uuid(), spare_part_id: receiptPart, quantity: receiptQty, pr_item_id: null, pr_no: null, supplier_name: null, max: null }];
    });
    setReceiptPart('');
    setReceiptQty(1);
  }

  function updateReceiptQty(key: string, quantity: number) {
    setReceiptLines((prev) => prev.map((l) => (l.key === key ? { ...l, quantity } : l)));
  }

  async function submitReceipt() {
    if (receiptLines.length === 0) { alert('Tambahkan minimal satu barang.'); return; }
    for (const l of receiptLines) {
      const part = parts.find((p) => p.id === l.spare_part_id);
      const name = part?.name ?? 'barang';
      if (!(l.quantity > 0)) { alert(`Quantity ${name} harus lebih besar dari 0.`); return; }
      if (l.max !== null && l.quantity > l.max) {
        alert(`Qty ${name} melebihi sisa PR (${l.max} ${part?.unit ?? ''}).`);
        return;
      }
    }

    const uniq = (xs: (string | null)[]) => Array.from(new Set(xs.filter((x): x is string => Boolean(x))));
    const prNos = uniq(receiptLines.map((l) => l.pr_no));
    const supplierNames = uniq(receiptLines.map((l) => l.supplier_name));
    const reference = receiptForm.reference.trim() || prNos.join(', ');
    const source = receiptForm.source.trim() || supplierNames.join(', ');

    setActing(true);
    try {
      const uploaded = grFiles.length > 0 ? await uploadGrFiles(grFiles) : [];
      const { data, error } = await supabase.rpc('receive_stock_multi', {
        p_items: receiptLines.map((l) => ({ spare_part_id: l.spare_part_id, quantity: l.quantity, pr_item_id: l.pr_item_id })),
        p_gr_kind: receiptForm.gr_kind,
        p_gr_no: null, // nomor final dibuat server di dalam transaksi simpan
        p_source: source || null,
        p_reference: reference || null,
        p_notes: receiptForm.notes.trim() || null,
        p_gr_attachments: uploaded.length > 0 ? uploaded : null,
      });
      if (error) {
        alert('Pemasukan gagal: ' + error.message);
        return;
      }
      const finalNo = String(data ?? '');
      setNotice(
        `Pemasukan tersimpan dengan No. GR ${finalNo}` +
          (previewGrNo && previewGrNo !== finalNo ? ` (berbeda dari perkiraan ${previewGrNo} karena nomor itu sudah dipakai penerimaan lain).` : '.')
      );
      setShowReceipt(false);
      setReceiptLines([]);
      setGrFiles([]);
      setPreviewGrNo(null);
      await load();
    } catch (e) {
      alert('Gagal upload/simpan pemasukan: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setActing(false);
    }
  }

  async function openIssue() {
    setIssueItems([]);
    setIssuePart('');
    setIssueQty(1);
    setIssueForm({ recipient: '', destination: '', reference: '', notes: '' });
    setBonRequester('');
    setOpenBons([]);
    setIssueAuto({ notes: '', reference: '' });
    setShowIssue(true);

    // Bon sparepart yang masih menunggu / sebagian -> bisa dipanggil berdasarkan user pembuat bon.
    setLoadingBons(true);
    const { data } = await supabase
      .from('spare_part_bons')
      .select(BON_SELECT)
      .in('status', ['pending', 'partial'])
      .order('created_at', { ascending: true });
    setOpenBons(((data as unknown as Bon[]) ?? []).filter((b) => b.items.some((i) => bonRemaining(i) > 0)));
    setLoadingBons(false);
  }

  const bonRequesters = useMemo(() => {
    const map = new Map<string, { id: string; label: string; count: number }>();
    for (const b of openBons) {
      const cur = map.get(b.requester_id);
      if (cur) cur.count += 1;
      else map.set(b.requester_id, { id: b.requester_id, label: b.requester?.full_name ?? '(user tidak diketahui)', count: 1 });
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [openBons]);

  const recallBons = useMemo(() => openBons.filter((b) => b.requester_id === bonRequester), [openBons, bonRequester]);

  /**
   * Isi Referensi & Keperluan dari bon yang ada di daftar (nomor bon + keterangan bon).
   * Hanya mengisi/menggantikan bila kolomnya kosong atau masih berisi hasil isi otomatis sebelumnya,
   * jadi teks yang diketik manual tidak tertimpa.
   */
  function applyBonDefaults(lines: IssueLine[]) {
    const uniq = (xs: (string | null)[]) => Array.from(new Set(xs.filter((x): x is string => Boolean(x))));
    const nextNotes = uniq(lines.map((l) => l.bon_notes)).join('; ');
    const nextRef = uniq(lines.map((l) => l.bon_no)).join(', ');
    setIssueForm((f) => ({
      ...f,
      notes: f.notes.trim() === '' || f.notes === issueAuto.notes ? nextNotes : f.notes,
      reference: f.reference.trim() === '' || f.reference === issueAuto.reference ? nextRef : f.reference,
    }));
    setIssueAuto({ notes: nextNotes, reference: nextRef });
  }

  function removeIssueLine(key: string) {
    const next = issueItems.filter((x) => x.key !== key);
    setIssueItems(next);
    applyBonDefaults(next);
  }

  /** Tambahkan item bon ke daftar pengeluaran (qty awal = sisa bon, dibatasi stok; boleh diubah untuk pengeluaran sebagian). */
  function recallBonItems(bon: Bon, items: BonItem[]) {
    const added: IssueLine[] = [];
    let noStock = 0;
    for (const it of items) {
      const rem = bonRemaining(it);
      if (rem <= 0) continue;
      if (issueItems.some((l) => l.bon_item_id === it.id)) continue;
      const stock = Number(it.spare_part?.current_stock ?? 0);
      if (stock <= 0) { noStock += 1; continue; }
      added.push({
        key: uuid(),
        spare_part_id: it.spare_part_id,
        quantity: Math.min(rem, stock),
        bon_item_id: it.id,
        bon_no: bon.bon_no,
        bon_notes: bon.notes,
        max: rem,
      });
    }
    if (noStock > 0) alert(`${noStock} item tidak ditambahkan karena stok habis.`);
    if (added.length > 0) {
      setIssueItems((prev) => [...prev, ...added]);
      applyBonDefaults([...issueItems, ...added]);
      // Penerima otomatis = pembuat bon (tetap bisa diubah / diisi manual).
      setIssueForm((f) => (f.recipient.trim() ? f : { ...f, recipient: bon.requester?.full_name ?? '' }));
    }
  }

  function addIssueItem() {
    const part = parts.find((p) => p.id === issuePart);
    if (!part) return;
    if (issueQty <= 0) { alert('Quantity harus lebih besar dari 0.'); return; }
    const already = issueItems.filter((l) => l.spare_part_id === issuePart).reduce((sum, l) => sum + l.quantity, 0);
    if (already + issueQty > part.current_stock) {
      alert(`Stok tidak mencukupi. Tersedia ${part.current_stock} ${part.unit}${already ? ` (sudah ${already} di daftar)` : ''}.`);
      return;
    }
    setIssueItems((prev) => {
      const existing = prev.find((l) => l.spare_part_id === issuePart && !l.bon_item_id);
      if (existing) return prev.map((l) => (l === existing ? { ...l, quantity: l.quantity + issueQty } : l));
      return [
        ...prev,
        { key: uuid(), spare_part_id: issuePart, quantity: issueQty, bon_item_id: null, bon_no: null, bon_notes: null, max: null },
      ];
    });
    setIssuePart('');
    setIssueQty(1);
  }

  function updateIssueQty(key: string, quantity: number) {
    setIssueItems((prev) => prev.map((l) => (l.key === key ? { ...l, quantity } : l)));
  }

  async function submitIssue() {
    if (issueItems.length === 0) { alert('Tambahkan minimal satu barang.'); return; }
    if (!issueForm.recipient.trim()) { alert('Nama penerima wajib diisi.'); return; }

    const need = new Map<string, number>();
    for (const l of issueItems) {
      const part = parts.find((p) => p.id === l.spare_part_id);
      const name = part?.name ?? 'barang';
      if (!(l.quantity > 0)) { alert(`Quantity ${name} harus lebih besar dari 0.`); return; }
      if (l.max !== null && l.quantity > l.max) { alert(`Qty ${name} melebihi sisa bon (${l.max} ${part?.unit ?? ''}).`); return; }
      need.set(l.spare_part_id, (need.get(l.spare_part_id) ?? 0) + l.quantity);
    }
    for (const [partId, qty] of Array.from(need.entries())) {
      const part = parts.find((p) => p.id === partId);
      if (part && qty > part.current_stock) {
        alert(`Stok ${part.name} tidak mencukupi. Tersedia ${part.current_stock} ${part.unit}, diminta ${qty}.`);
        return;
      }
    }

    const uniq = (xs: (string | null)[]) => Array.from(new Set(xs.filter((x): x is string => Boolean(x))));
    const bonNos = uniq(issueItems.map((l) => l.bon_no));
    const bonNotes = uniq(issueItems.map((l) => l.bon_notes));
    const reference = issueForm.reference.trim() || bonNos.join(', ');
    const notes = issueForm.notes.trim() || bonNotes.join('; ');

    setActing(true);
    const { data, error } = await supabase.rpc('issue_stock_manual', {
      p_items: issueItems.map((l) => ({ spare_part_id: l.spare_part_id, quantity: l.quantity, bon_item_id: l.bon_item_id })),
      p_recipient: issueForm.recipient.trim(),
      p_destination: issueForm.destination.trim() || null,
      p_reference: reference || null,
      p_notes: notes || null,
    });
    if (error) {
      setActing(false);
      alert('Pengeluaran gagal: ' + error.message);
      return;
    }
    const slipNo = data as string;
    try {
      await printIssueSlipByNo(slipNo);
    } catch (e) {
      alert(`Pengeluaran ${slipNo} tersimpan, tetapi PDF gagal dibuat: ` + (e instanceof Error ? e.message : String(e)));
    }
    setActing(false);
    setShowIssue(false);
    setNotice(`Pengeluaran ${slipNo} tersimpan.` + (bonNos.length > 0 ? ` Bon terkait: ${bonNos.join(', ')}.` : ''));
    await load();
  }

  async function printRow(tx: InventoryTransaction) {
    setBusyPdf(tx.id);
    try {
      if (tx.issue_slip_no) await printIssueSlipByNo(tx.issue_slip_no);
      else await printLegacyIssue(tx.id);
    } catch (e) {
      alert('PDF gagal dibuat: ' + (e instanceof Error ? e.message : String(e)));
    }
    setBusyPdf(null);
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

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 px-4 py-3 text-sm flex items-center justify-between gap-3">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-emerald-700 hover:text-emerald-900 font-medium">Tutup</button>
        </div>
      )}
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input placeholder="Cari no. transaksi, part, referensi..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10" />
        </div>
        {canTransact && (
          <div className="flex gap-2">
            <Button onClick={openReceipt} variant="success">
              <ArrowDownToLine className="w-4 h-4" /> Pemasukan
            </Button>
            <Button onClick={openIssue} variant="danger">
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
                  <th className="text-left px-4 py-3">No. GR</th>
                  <th className="text-left px-4 py-3">Tanggal</th>
                  <th className="text-left px-4 py-3">Spare Part</th>
                  <th className="text-left px-4 py-3">Jenis</th>
                  <th className="text-right px-4 py-3">Qty</th>
                  <th className="text-right px-4 py-3">Saldo</th>
                  <th className="text-left px-4 py-3">Referensi</th>
                  <th className="text-left px-4 py-3">Keterangan</th>
                  <th className="text-right px-4 py-3">Dokumen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {transactions.map((tx) => {
                  const extended = tx as InventoryTransaction & { transaction_no?: string; stock_before?: number | null };
                  return (
                    <tr key={tx.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-700 whitespace-nowrap">{extended.transaction_no ?? '-'}{tx.issue_slip_no && <div className="text-xs font-normal text-slate-400">{tx.issue_slip_no}</div>}</td>
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                        {tx.gr_no ? (
                          <>
                            <div className="font-medium text-slate-700">{tx.gr_no}</div>
                            {tx.gr_kind && <div>{GR_KIND_LABELS[tx.gr_kind]}</div>}
                          </>
                        ) : '-'}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{new Date(tx.created_at).toLocaleString('id-ID')}</td>
                      <td className="px-4 py-3"><b>{tx.spare_part?.code}</b><div className="text-xs text-slate-500">{tx.spare_part?.name}</div></td>
                      <td className="px-4 py-3"><Badge className={TX_TYPE_COLORS[tx.type]}>{TX_TYPE_LABELS[tx.type]}</Badge></td>
                      <td className="px-4 py-3 text-right font-medium">{tx.type === 'stock_out' ? '-' : tx.type === 'stock_in' ? '+' : ''}{tx.quantity} {tx.spare_part?.unit}</td>
                      <td className="px-4 py-3 text-right text-slate-600">{tx.balance_after ?? '-'}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{tx.reference ?? '-'}</td>
                      <td className="px-4 py-3 text-xs text-slate-500 max-w-xs">{tx.notes ?? '-'}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <div className="flex flex-col items-end gap-1">
                          {(tx.gr_attachments ?? []).map((url, idx) => (
                            <a
                              key={`${tx.id}-${idx}`}
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                            >
                              <Paperclip className="w-3 h-3" /> Lampiran {idx + 1}
                            </a>
                          ))}
                          {profile?.role === 'admin' && (
                            <Button size="sm" variant="secondary" onClick={() => setEditTxId(tx.id)}>
                              <Pencil className="w-4 h-4" /> Edit
                            </Button>
                          )}
                          {/* Pengeluaran dari WO punya lembar sendiri (lihat permintaan di WO/Dashboard) */}
                          {tx.type === 'stock_out' && !tx.work_order_id && (
                            <Button size="sm" variant="secondary" onClick={() => printRow(tx)} disabled={busyPdf === tx.id}>
                              <FileDown className="w-4 h-4" /> {busyPdf === tx.id ? '...' : 'PDF'}
                            </Button>
                          )}
                        </div>
                      </td>
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

      {editTxId && (
        <EditTransactionModal
          txId={editTxId}
          onClose={() => setEditTxId(null)}
          onSaved={async () => {
            setEditTxId(null);
            setNotice('Perubahan transaksi tersimpan dan tercatat di Activity Log.');
            await load();
          }}
        />
      )}

      <Modal open={showReceipt} onClose={() => !acting && setShowReceipt(false)} title="Pemasukan Barang" maxWidth="max-w-3xl">
        <div className="space-y-4">
          <div className="p-3 rounded-lg bg-slate-50 text-sm text-slate-600">
            Diproses langsung oleh <b>Inventory Control/Admin</b>, tanpa approval. Semua barang dalam satu penerimaan memakai <b>satu nomor GR</b>.
            Barang bisa ditambah manual atau <b>dipanggil dari PR</b> berdasarkan supplier.
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Jenis Penerimaan (GR) *</Label>
              <Select
                value={receiptForm.gr_kind}
                onChange={(e) => {
                  setReceiptForm((f) => ({ ...f, gr_kind: e.target.value as GRKind }));
                  setPreviewGrNo(null);
                }}
              >
                <option value="credit">{GR_KIND_LABELS.credit}</option>
                <option value="cash">{GR_KIND_LABELS.cash}</option>
                <option value="import">{GR_KIND_LABELS.import}</option>
              </Select>
            </div>
            <div>
              <Label>Sumber Barang</Label>
              <Input
                placeholder="Kosong = otomatis nama supplier PR"
                value={receiptForm.source}
                onChange={(e) => setReceiptForm((f) => ({ ...f, source: e.target.value }))}
              />
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 p-3 space-y-2">
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <div className="flex-1">
                <Label>Nomor GR (perkiraan)</Label>
                <Input value={previewGrNo ?? ''} placeholder="Otomatis dibuat saat disimpan" readOnly className="bg-slate-50" />
              </div>
              <Button type="button" variant="secondary" onClick={previewGrNumber} disabled={acting || previewingGrNo}>
                {previewingGrNo ? 'Memuat...' : 'Generate No. GR'}
              </Button>
            </div>
            <p className="text-xs text-slate-400">Generate hanya menampilkan perkiraan nomor. Nomor baru tersimpan/terpakai saat pemasukan disimpan, dan bisa berbeda jika ada penerimaan lain yang tersimpan lebih dulu.</p>
          </div>

          {/* Recall dari PR */}
          <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <ClipboardCheck className="w-4 h-4 text-blue-600" /> Panggil dari Purchase Requirement
            </div>
            {loadingPrs ? (
              <p className="text-sm text-slate-400">Memuat PR...</p>
            ) : recallSuppliers.length === 0 ? (
              <p className="text-sm text-slate-400">Tidak ada PR bernomor yang masih menunggu barang.</p>
            ) : (
              <>
                <div>
                  <Label>Supplier</Label>
                  <Select value={recallSupplier} onChange={(e) => setRecallSupplier(e.target.value)}>
                    <option value="">Pilih supplier...</option>
                    {recallSuppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.label} ({s.count} PR)</option>
                    ))}
                  </Select>
                </div>
                {recallSupplier && (
                  <div className="space-y-2">
                    {recallPrs.map((pr) => (
                      <div key={pr.id} className="rounded-lg bg-white border border-slate-200 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">{pr.pr_no ?? '-'}</p>
                            <p className="text-xs text-slate-400">SAP {pr.sap_no ?? '-'} • dibuat {new Date(pr.created_at).toLocaleDateString('id-ID')}</p>
                          </div>
                          <Button size="sm" variant="secondary" onClick={() => recallItems(pr, pr.items)}>
                            <Plus className="w-4 h-4" /> Panggil semua item
                          </Button>
                        </div>
                        <div className="divide-y divide-slate-100">
                          {pr.items.filter((i) => remaining(i) > 0).map((it) => {
                            const already = receiptLines.some((l) => l.pr_item_id === it.id);
                            return (
                              <div key={it.id} className="flex items-center justify-between gap-2 py-1.5">
                                <div className="min-w-0">
                                  <p className="text-sm text-slate-800 truncate">{it.spare_part_name}</p>
                                  <p className="text-xs text-slate-400">
                                    Dipesan {it.quantity} • diterima {it.received_qty} • sisa <b>{remaining(it)}</b>
                                    {!it.spare_part_id && ' • belum terhubung ke master part'}
                                  </p>
                                </div>
                                <Button size="sm" variant="secondary" disabled={already || !it.spare_part_id} onClick={() => recallItems(pr, [it])}>
                                  {already ? 'Sudah ada' : 'Tambah'}
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Tambah manual */}
          <div className="rounded-lg border border-slate-200 p-3 space-y-3">
            <div className="flex flex-col sm:flex-row gap-2 items-end">
              <div className="flex-1 w-full">
                <Label>Tambah Manual (cari spare part)</Label>
                <SearchablePicker
                  inline
                  value={receiptPart}
                  onChange={(v) => { setReceiptPart(v); setReceiptQty(1); }}
                  placeholder="Cari & pilih spare part..."
                  emptyText="Spare part tidak ditemukan"
                  options={parts.map((p) => ({
                    value: p.id,
                    label: p.name,
                    sublabel: [p.code, p.category, p.location].filter(Boolean).join(' • '),
                    right: `${p.current_stock} ${p.unit}`,
                    search: [p.name, p.code, p.category, p.location].filter(Boolean).join(' '),
                  }))}
                />
              </div>
              <div className="w-24">
                <Label>Qty</Label>
                <Input type="number" min="0.01" step="any" value={receiptQty || ''} onChange={(e) => setReceiptQty(Number(e.target.value))} />
              </div>
              <Button size="sm" variant="secondary" onClick={addReceiptLine} disabled={!receiptPart}>
                <Plus className="w-4 h-4" /> Tambah
              </Button>
            </div>

            {receiptLines.length === 0 ? (
              <p className="text-sm text-slate-400">Belum ada barang di daftar</p>
            ) : (
              <div className="rounded-lg bg-slate-50 divide-y divide-slate-100">
                {receiptLines.map((l) => {
                  const part = parts.find((p) => p.id === l.spare_part_id);
                  const qty = Number(l.quantity) || 0;
                  return (
                    <div key={l.key} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900 truncate">{part?.name}</p>
                        <p className="text-xs text-slate-400">
                          {part?.code} • stok {part?.current_stock} → {(part?.current_stock ?? 0) + qty} {part?.unit}
                          {l.pr_no && <span className="ml-1 text-blue-600">• PR {l.pr_no}{l.max !== null && ` (maks ${l.max})`}</span>}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Input
                          type="number"
                          min="0.01"
                          step="any"
                          max={l.max ?? undefined}
                          value={l.quantity || ''}
                          onChange={(e) => updateReceiptQty(l.key, Number(e.target.value))}
                          className="w-24"
                        />
                        <span className="text-xs text-slate-500 w-10">{part?.unit}</span>
                        <button onClick={() => setReceiptLines((prev) => prev.filter((x) => x.key !== l.key))} className="text-red-500 hover:text-red-700 p-1" aria-label="Hapus dari daftar">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <Label>Lampiran (foto/pdf, maks 5MB per file)</Label>
            <Input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              multiple
              onChange={(e) => {
                handlePickGrFiles(e.target.files);
                e.currentTarget.value = '';
              }}
            />
            {grFiles.length > 0 && (
              <div className="mt-2 rounded-lg border border-slate-200 divide-y divide-slate-100">
                {grFiles.map((f, idx) => (
                  <div key={`${f.name}-${f.lastModified}-${idx}`} className="px-3 py-2 flex items-center justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <p className="truncate text-slate-700">{f.name}</p>
                      <p className="text-xs text-slate-400">{fmtSize(f.size)}</p>
                    </div>
                    <button type="button" onClick={() => removeGrFile(idx)} className="text-red-500 hover:text-red-700 p-1" aria-label="Hapus file">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div><Label>Referensi</Label><Input placeholder="Kosong = otomatis nomor PR yang dipanggil" value={receiptForm.reference} onChange={(e) => setReceiptForm((f) => ({ ...f, reference: e.target.value }))} /></div>
          <div><Label>Keterangan</Label><Textarea rows={2} value={receiptForm.notes} onChange={(e) => setReceiptForm((f) => ({ ...f, notes: e.target.value }))} /></div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setShowReceipt(false)} disabled={acting}>Batal</Button>
            <Button onClick={submitReceipt} disabled={acting || receiptLines.length === 0}>
              {acting ? 'Memproses...' : `Simpan Pemasukan (${receiptLines.length} barang)`}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={showIssue} onClose={() => !acting && setShowIssue(false)} title="Pengeluaran Barang" maxWidth="max-w-2xl">
        <div className="space-y-4">
          <div className="p-3 rounded-lg bg-slate-50 text-sm text-slate-600">
            Diproses langsung oleh <b>Inventory Control/Admin</b>. Semua barang dalam satu dokumen dikeluarkan bersamaan,
            lalu <b>Lembar Pengeluaran Barang (PDF)</b> otomatis diunduh.
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Nama Penerima *</Label>
              <Input value={issueForm.recipient} onChange={(e) => setIssueForm((f) => ({ ...f, recipient: e.target.value }))} placeholder="Nama yang menerima barang" />
            </div>
            <div>
              <Label>Tujuan Pengeluaran</Label>
              <Input value={issueForm.destination} onChange={(e) => setIssueForm((f) => ({ ...f, destination: e.target.value }))} placeholder="Produksi / Transfer / lainnya" />
            </div>
          </div>
          <div>
            <Label>Referensi</Label>
            <Input value={issueForm.reference} onChange={(e) => setIssueForm((f) => ({ ...f, reference: e.target.value }))} placeholder="Nomor dokumen, permintaan, dll." />
          </div>
          <div>
            <Label>Keperluan / Keterangan</Label>
            <Textarea rows={2} value={issueForm.notes} onChange={(e) => setIssueForm((f) => ({ ...f, notes: e.target.value }))} />
          </div>

          {/* Panggil dari Bon Sparepart (berdasarkan user pembuat bon) */}
          <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <ClipboardCheck className="w-4 h-4 text-amber-600" /> Panggil dari Bon Sparepart
            </div>
            {loadingBons ? (
              <p className="text-sm text-slate-400">Memuat bon...</p>
            ) : bonRequesters.length === 0 ? (
              <p className="text-sm text-slate-400">Tidak ada bon sparepart yang menunggu. Barang tetap bisa diisi manual di bawah.</p>
            ) : (
              <>
                <div>
                  <Label>User pembuat bon</Label>
                  <Select value={bonRequester} onChange={(e) => setBonRequester(e.target.value)}>
                    <option value="">Pilih user...</option>
                    {bonRequesters.map((u) => (
                      <option key={u.id} value={u.id}>{u.label} ({u.count} bon)</option>
                    ))}
                  </Select>
                </div>
                {bonRequester && (
                  <div className="space-y-2">
                    {recallBons.map((bon) => (
                      <div key={bon.id} className="rounded-lg bg-white border border-slate-200 p-3 space-y-2">
                        <div className="flex items-start justify-between gap-2 flex-wrap">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-slate-900">{bon.bon_no}</p>
                            <p className="text-xs text-slate-500">{bon.notes}</p>
                            <p className="text-xs text-slate-400">{new Date(bon.created_at).toLocaleDateString('id-ID')}</p>
                          </div>
                          <Button size="sm" variant="secondary" onClick={() => recallBonItems(bon, bon.items)}>
                            <Plus className="w-4 h-4" /> Panggil semua item
                          </Button>
                        </div>
                        <div className="divide-y divide-slate-100">
                          {bon.items.filter((i) => bonRemaining(i) > 0).map((it) => {
                            const already = issueItems.some((l) => l.bon_item_id === it.id);
                            const stock = Number(it.spare_part?.current_stock ?? 0);
                            return (
                              <div key={it.id} className="flex items-center justify-between gap-2 py-1.5">
                                <div className="min-w-0">
                                  <p className="text-sm text-slate-800 truncate">{it.spare_part?.name}</p>
                                  <p className="text-xs text-slate-400">
                                    Diminta {it.quantity} • keluar {it.issued_qty} • sisa <b>{bonRemaining(it)}</b> • stok {stock} {it.spare_part?.unit}
                                  </p>
                                </div>
                                <Button size="sm" variant="secondary" disabled={already || stock <= 0} onClick={() => recallBonItems(bon, [it])}>
                                  {already ? 'Sudah ada' : stock <= 0 ? 'Stok habis' : 'Tambah'}
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            <p className="text-xs text-slate-400">Penerima yang tidak punya user (bukan pembuat bon) tetap bisa diisi manual: isi nama penerima dan tambahkan barang di bawah.</p>
          </div>

          <div className="rounded-lg border border-slate-200 p-3 space-y-3">
            <div className="flex flex-col sm:flex-row gap-2 items-end">
              <div className="flex-1 w-full">
                <Label>Tambah Manual (cari spare part)</Label>
                <SearchablePicker
                  inline
                  value={issuePart}
                  onChange={(v) => { setIssuePart(v); setIssueQty(1); }}
                  placeholder="Cari & pilih spare part..."
                  emptyText="Spare part tidak ditemukan"
                  options={parts.map((p) => ({
                    value: p.id,
                    label: p.name,
                    sublabel: [p.code, p.category, p.location].filter(Boolean).join(' • '),
                    right: p.current_stock <= 0 ? 'Stok habis' : `${p.current_stock} ${p.unit}`,
                    search: [p.name, p.code, p.category, p.location].filter(Boolean).join(' '),
                    disabled: p.current_stock <= 0,
                  }))}
                />
              </div>
              <div className="w-24">
                <Label>Qty</Label>
                <Input type="number" min="0.01" step="any" value={issueQty || ''} onChange={(e) => setIssueQty(Number(e.target.value))} />
              </div>
              <Button size="sm" variant="secondary" onClick={addIssueItem} disabled={!issuePart}>
                <Plus className="w-4 h-4" /> Tambah
              </Button>
            </div>

            {issueItems.length === 0 ? (
              <p className="text-sm text-slate-400">Belum ada barang di daftar</p>
            ) : (
              <div className="rounded-lg bg-slate-50 divide-y divide-slate-100">
                {issueItems.map((l) => {
                  const part = parts.find((p) => p.id === l.spare_part_id);
                  const qty = Number(l.quantity) || 0;
                  return (
                    <div key={l.key} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900 truncate">{part?.name}</p>
                        <p className="text-xs text-slate-400">
                          {part?.code} • stok {part?.current_stock} → {(part?.current_stock ?? 0) - qty} {part?.unit}
                          {l.bon_no && <span className="ml-1 text-amber-700">• {l.bon_no}{l.max !== null && ` (maks ${l.max})`}</span>}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Input
                          type="number"
                          min="0.01"
                          step="any"
                          max={l.max ?? undefined}
                          value={l.quantity || ''}
                          onChange={(e) => updateIssueQty(l.key, Number(e.target.value))}
                          className="w-24"
                        />
                        <span className="text-xs text-slate-500 w-10">{part?.unit}</span>
                        <button onClick={() => removeIssueLine(l.key)} className="text-red-500 hover:text-red-700 p-1" aria-label="Hapus dari daftar">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setShowIssue(false)} disabled={acting}>Batal</Button>
            <Button onClick={submitIssue} disabled={acting || issueItems.length === 0 || !issueForm.recipient.trim()}>
              {acting ? 'Memproses...' : `Simpan & Cetak PDF (${issueItems.length} barang)`}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!stockCardPart} onClose={() => setStockCardPart(null)} title={`Stock Card - ${stockCardPart?.code ?? ''}`} maxWidth="max-w-4xl">
        {stockCardPart && <div className="space-y-3"><div className="text-sm text-slate-600">{stockCardPart.name} • Saldo sekarang <b>{stockCardPart.current_stock} {stockCardPart.unit}</b></div><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-3 py-2 text-left">Tanggal</th><th className="px-3 py-2 text-left">No. Transaksi</th><th className="px-3 py-2 text-left">Jenis</th><th className="px-3 py-2 text-right">Masuk</th><th className="px-3 py-2 text-right">Keluar</th><th className="px-3 py-2 text-right">Saldo</th><th className="px-3 py-2 text-left">Ref</th></tr></thead><tbody className="divide-y">{stockCard.map((tx) => { const ext = tx as InventoryTransaction & { transaction_no?: string }; return <tr key={tx.id}><td className="px-3 py-2 text-xs">{new Date(tx.created_at).toLocaleString('id-ID')}</td><td className="px-3 py-2 text-xs font-medium">{ext.transaction_no ?? '-'}</td><td className="px-3 py-2"><Badge className={TX_TYPE_COLORS[tx.type]}>{TX_TYPE_LABELS[tx.type]}</Badge></td><td className="px-3 py-2 text-right">{tx.type === 'stock_in' ? tx.quantity : ''}</td><td className="px-3 py-2 text-right">{tx.type === 'stock_out' ? tx.quantity : ''}</td><td className="px-3 py-2 text-right font-medium">{tx.balance_after ?? '-'}</td><td className="px-3 py-2 text-xs">{tx.reference ?? '-'}</td></tr>; })}</tbody></table></div></div>}
      </Modal>
    </div>
  );
}
