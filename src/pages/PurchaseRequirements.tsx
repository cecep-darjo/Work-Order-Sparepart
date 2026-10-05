import { uuid } from '@/lib/uuid';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase, type Profile } from '@/lib/supabase';
import { Badge, Button, Card, Input, Label, Modal, Select, Spinner, Textarea } from '@/components/ui';
import { SearchablePicker } from '@/components/Pickers';
import type { PageKey } from '@/components/Layout';
import { ClipboardCheck, Paperclip, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';

type PurchaseRequirementStatus = 'pending_numbering' | 'numbered';

type PrItem = {
  id: string;
  spare_part_id: string | null;
  spare_part_name: string;
  quantity: number;
  received_qty: number;
  spare_part?: { code: string; unit: string } | null;
};

type PartOption = {
  id: string;
  code: string;
  name: string;
  unit: string;
  category: string | null;
  location: string | null;
  current_stock: number;
};

type PurchaseRequirement = {
  id: string;
  requester_id: string;
  machine_name: string | null;
  supplier_id: string;
  sap_no: string | null;
  pr_no: string | null;
  attachment_files: string[] | null;
  status: PurchaseRequirementStatus;
  created_by: string;
  created_at: string;
  numbered_by: string | null;
  numbered_at: string | null;
  requester?: { full_name: string } | null;
  supplier?: { id: string; code: string; name: string } | null;
  creator?: { full_name: string } | null;
  numberer?: { full_name: string } | null;
  items: PrItem[];
};

type NumberingDraft = { sap_no: string; pr_no: string };

const PR_SELECT =
  'id, requester_id, machine_name, supplier_id, sap_no, pr_no, attachment_files, status, created_by, created_at, numbered_by, numbered_at, requester:profiles!requester_id(full_name), supplier:inventory_suppliers(id, code, name), creator:profiles!created_by(full_name), numberer:profiles!numbered_by(full_name), items:purchase_requirement_items(id, spare_part_id, spare_part_name, quantity, received_qty, spare_part:spare_parts(code, unit))';

const STATUS_LABELS: Record<PurchaseRequirementStatus, string> = {
  pending_numbering: 'Menunggu Nomor SAP/PR',
  numbered: 'Sudah Dinomori',
};

const STATUS_COLORS: Record<PurchaseRequirementStatus, string> = {
  pending_numbering: 'bg-amber-100 text-amber-700 border-amber-200',
  numbered: 'bg-emerald-100 text-emerald-700 border-emerald-200',
};

const MAX_PR_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_PR_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

function fmtDate(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

function currentPrPrefix(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `TK/${yy}/${mm}/`;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Saring file pilihan: ukuran, tipe, dan duplikat. */
function filterPrFiles(selected: File[], existing: File[]): File[] {
  const next: File[] = [];
  for (const f of selected) {
    if (f.size > MAX_PR_FILE_SIZE) {
      alert(`File ${f.name} melebihi 5MB.`);
      continue;
    }
    if (!ALLOWED_PR_MIME.includes(f.type)) {
      alert(`Tipe file ${f.name} tidak didukung. Hanya JPG/PNG/WEBP/PDF.`);
      continue;
    }
    const duplicate = [...existing, ...next].some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified);
    if (!duplicate) next.push(f);
  }
  return next;
}

async function uploadAttachmentFiles(prId: string, files: File[]): Promise<string[]> {
  const urls: string[] = [];
  for (const file of files) {
    const ext = file.name.includes('.') ? file.name.split('.').pop() : '';
    const safeBase = file.name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'file';
    const objectPath = `pr/${new Date().getFullYear()}/${prId}/${Date.now()}-${uuid()}-${safeBase}${ext ? `.${ext}` : ''}`;
    const { error: uploadError } = await supabase.storage
      .from('purchase-requirement-files')
      .upload(objectPath, file, { upsert: false, contentType: file.type });
    if (uploadError) throw uploadError;
    const { data } = supabase.storage.from('purchase-requirement-files').getPublicUrl(objectPath);
    urls.push(data.publicUrl);
  }
  return urls;
}

function PrItemsList({ row }: { row: PurchaseRequirement }) {
  const items = [...(row.items ?? [])].sort((a, b) => a.spare_part_name.localeCompare(b.spare_part_name));
  const showProgress = row.status === 'numbered';
  if (items.length === 0) return <p className="text-xs text-slate-400">Tidak ada item.</p>;
  return (
    <div className="rounded-lg bg-slate-50 divide-y divide-slate-100">
      {items.map((it) => {
        const unit = it.spare_part?.unit ?? '';
        const complete = Number(it.received_qty) >= Number(it.quantity);
        return (
          <div key={it.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
            <div className="min-w-0">
              <p className="text-sm text-slate-800 truncate">{it.spare_part_name}</p>
              {it.spare_part?.code && <p className="text-xs text-slate-400">{it.spare_part.code}</p>}
            </div>
            <div className="text-sm text-right flex-shrink-0">
              {showProgress ? (
                <>
                  <span className="font-semibold text-slate-900">{it.received_qty}/{it.quantity}</span> {unit}
                  <p className={`text-xs ${complete ? 'text-emerald-600' : 'text-slate-400'}`}>{complete ? 'Lengkap' : 'Diterima / dipesan'}</p>
                </>
              ) : (
                <span className="font-semibold text-slate-900">{it.quantity} {unit}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function PurchaseRequirementsInbox({
  onNavigate,
}: {
  onNavigate?: (page: PageKey) => void;
}) {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<PurchaseRequirement[]>([]);
  const [drafts, setDrafts] = useState<Record<string, NumberingDraft>>({});
  const [actingId, setActingId] = useState<string | null>(null);

  const canNumber = profile?.role === 'admin' || profile?.role === 'inventory';

  const load = useCallback(async () => {
    if (!canNumber) return;
    setLoading(true);
    const { data } = await supabase
      .from('purchase_requirements')
      .select(PR_SELECT)
      .eq('status', 'pending_numbering')
      .order('created_at', { ascending: true })
      .limit(8);
    setRows((data as unknown as PurchaseRequirement[]) ?? []);
    setLoading(false);
  }, [canNumber]);

  useEffect(() => {
    if (!canNumber) return;
    load();
  }, [canNumber, load]);

  if (!canNumber) return null;

  async function saveNumbering(id: string) {
    const draft = drafts[id];
    if (!draft?.sap_no?.trim() || !draft?.pr_no?.trim()) {
      alert('Nomor SAP dan nomor PR wajib diisi.');
      return;
    }

    setActingId(id);
    const { error } = await supabase.rpc('set_purchase_requirement_numbers', {
      p_pr_id: id,
      p_sap_no: draft.sap_no.trim(),
      p_pr_no: draft.pr_no.trim(),
    });
    setActingId(null);

    if (error) {
      alert('Gagal menyimpan nomor: ' + error.message);
      return;
    }

    setDrafts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    await load();
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4 gap-2">
        <h2 className="font-semibold text-slate-900 flex items-center gap-2">
          <ClipboardCheck className="w-4 h-4 text-blue-600" />
          Purchase Requirement - Menunggu Nomor
          {rows.length > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-amber-500 text-white text-xs font-bold">
              {rows.length}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {onNavigate && (
            <Button size="sm" variant="secondary" onClick={() => onNavigate('purchase_requirements')}>
              Buka Halaman PR
            </Button>
          )}
          <button onClick={load} className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400 py-4 text-center">Tidak ada PR yang menunggu pengisian nomor.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const draft = drafts[row.id] ?? { sap_no: '', pr_no: currentPrPrefix() };
            return (
              <div key={row.id} className="rounded-lg border border-slate-200 p-3 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{(row.items ?? []).length} item spare part</p>
                    <p className="text-xs text-slate-500">
                      Supplier: {row.supplier?.name ?? '-'} • Pemesan: {row.requester?.full_name ?? '-'}
                    </p>
                    <p className="text-xs text-slate-400">Dibuat {fmtDate(row.created_at)}</p>
                    <p className="text-xs text-slate-400">Lampiran: {(row.attachment_files ?? []).length} file</p>
                  </div>
                  <Badge className={STATUS_COLORS[row.status]}>{STATUS_LABELS[row.status]}</Badge>
                </div>

                <PrItemsList row={row} />


                {(row.attachment_files ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {(row.attachment_files ?? []).map((url, idx) => (
                      <a
                        key={`${row.id}-${idx}`}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                      >
                        <Paperclip className="w-3 h-3" /> Lampiran {idx + 1}
                      </a>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input
                    value={draft.sap_no}
                    placeholder="Nomor SAP (16xxxxxxxx)"
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [row.id]: { ...draft, sap_no: e.target.value } }))
                    }
                  />
                  <Input
                    value={draft.pr_no}
                    placeholder="Nomor PR (TK/aa/bb/ccccc)"
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [row.id]: { ...draft, pr_no: e.target.value } }))
                    }
                  />
                </div>

                <div className="flex justify-end">
                  <Button size="sm" onClick={() => saveNumbering(row.id)} disabled={actingId === row.id}>
                    {actingId === row.id ? 'Menyimpan...' : 'Simpan Nomor'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function EditPrModal({
  row,
  parts,
  requesters,
  suppliers,
  canEditNumbers,
  onClose,
  onSaved,
}: {
  row: PurchaseRequirement;
  parts: PartOption[];
  requesters: Profile[];
  suppliers: { id: string; code: string; name: string }[];
  canEditNumbers: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const received = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of row.items ?? []) if (it.spare_part_id) m.set(it.spare_part_id, Number(it.received_qty));
    return m;
  }, [row]);
  const legacy = (row.items ?? []).filter((i) => !i.spare_part_id);
  const supplierLocked = (row.items ?? []).some((i) => Number(i.received_qty) > 0);

  const [items, setItems] = useState<{ spare_part_id: string; quantity: number }[]>(() =>
    (row.items ?? [])
      .filter((i) => i.spare_part_id)
      .map((i) => ({ spare_part_id: i.spare_part_id as string, quantity: Number(i.quantity) }))
  );
  const [form, setForm] = useState({
    requester_id: row.requester_id,
    supplier_id: row.supplier_id,
    machine_name: row.machine_name ?? '',
  });
  const [itemPart, setItemPart] = useState('');
  const [itemQty, setItemQty] = useState(1);
  const [keptFiles, setKeptFiles] = useState<string[]>(row.attachment_files ?? []);
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  // Koreksi nomor SAP/PR (khusus admin, hanya untuk PR yang sudah bernomor)
  const [sapNo, setSapNo] = useState(row.sap_no ?? '');
  const [prNo, setPrNo] = useState(row.pr_no ?? '');
  const [numReason, setNumReason] = useState('');
  const numbersEditable = canEditNumbers && row.status === 'numbered';
  const numbersChanged = numbersEditable && (sapNo.trim() !== (row.sap_no ?? '') || prNo.trim() !== (row.pr_no ?? ''));

  function addItem() {
    if (!itemPart) return;
    if (!Number.isFinite(itemQty) || itemQty <= 0) {
      alert('Quantity harus lebih besar dari 0.');
      return;
    }
    setItems((prev) =>
      prev.some((i) => i.spare_part_id === itemPart)
        ? prev.map((i) => (i.spare_part_id === itemPart ? { ...i, quantity: i.quantity + itemQty } : i))
        : [...prev, { spare_part_id: itemPart, quantity: itemQty }]
    );
    setItemPart('');
    setItemQty(1);
  }

  async function save() {
    if (items.length === 0) {
      alert('Tambahkan minimal satu spare part.');
      return;
    }
    for (const i of items) {
      const name = parts.find((p) => p.id === i.spare_part_id)?.name ?? 'spare part';
      if (!Number.isFinite(i.quantity) || i.quantity <= 0) {
        alert(`Quantity ${name} harus lebih besar dari 0.`);
        return;
      }
      const rec = received.get(i.spare_part_id) ?? 0;
      if (i.quantity < rec) {
        alert(`Qty ${name} tidak boleh lebih kecil dari yang sudah diterima (${rec}).`);
        return;
      }
    }
    if (!form.requester_id || !form.supplier_id) {
      alert('Pemesan dan supplier wajib dipilih.');
      return;
    }
    if (numbersChanged) {
      if (!/^16[0-9]{8}$/.test(sapNo.trim())) {
        alert('Format SAP harus 16xxxxxxxx (10 digit, awalan 16).');
        return;
      }
      if (!/^TK\/[0-9]{2}\/[0-9]{2}\/[0-9]{5}$/.test(prNo.trim())) {
        alert('Format PR harus TK/aa/bb/ccccc.');
        return;
      }
      if (numReason.trim().length < 3) {
        alert('Alasan koreksi nomor wajib diisi.');
        return;
      }
    }

    const sig = (list: { spare_part_id: string | null; quantity: number }[]) =>
      list.filter((i) => i.spare_part_id).map((i) => `${i.spare_part_id}:${Number(i.quantity)}`).sort().join('|');
    const mainChanged =
      sig(items) !== sig(row.items ?? []) ||
      legacy.length > 0 ||
      form.requester_id !== row.requester_id ||
      form.supplier_id !== row.supplier_id ||
      form.machine_name.trim() !== (row.machine_name ?? '').trim();
    const filesChanged = newFiles.length > 0 || keptFiles.length !== (row.attachment_files ?? []).length;
    if (!mainChanged && !filesChanged && !numbersChanged) {
      alert('Tidak ada perubahan untuk disimpan.');
      return;
    }

    setSaving(true);
    if (mainChanged) {
      const { error } = await supabase.rpc('update_purchase_requirement_items', {
        p_pr_id: row.id,
        p_items: items,
        p_requester_id: form.requester_id,
        p_machine_name: form.machine_name.trim() || null,
        p_supplier_id: form.supplier_id,
      });
      if (error) {
        setSaving(false);
        alert('Gagal menyimpan perubahan PR: ' + error.message);
        return;
      }
    }

    const originalFiles = row.attachment_files ?? [];
    if (newFiles.length > 0 || keptFiles.length !== originalFiles.length) {
      try {
        const uploaded = newFiles.length > 0 ? await uploadAttachmentFiles(row.id, newFiles) : [];
        const { error: attachError } = await supabase.rpc('set_purchase_requirement_attachments', {
          p_pr_id: row.id,
          p_attachments: [...keptFiles, ...uploaded],
        });
        if (attachError) alert('PR tersimpan, tetapi lampiran gagal disimpan: ' + attachError.message);
      } catch (e) {
        alert('PR tersimpan, tetapi upload lampiran gagal: ' + (e instanceof Error ? e.message : String(e)));
      }
    }

    if (numbersChanged) {
      const { error: numError } = await supabase.rpc('admin_update_purchase_requirement_numbers', {
        p_pr_id: row.id,
        p_sap_no: sapNo.trim(),
        p_pr_no: prNo.trim(),
        p_reason: numReason.trim(),
      });
      if (numError) {
        setSaving(false);
        alert((mainChanged || filesChanged ? 'Perubahan lain sudah tersimpan, tetapi koreksi nomor gagal: ' : 'Koreksi nomor gagal: ') + numError.message);
        if (mainChanged || filesChanged) await onSaved();
        return;
      }
    }

    setSaving(false);
    await onSaved();
  }

  return (
    <Modal open onClose={() => !saving && onClose()} title={`Edit Purchase Requirement${row.pr_no ? ` - ${row.pr_no}` : ''}`} maxWidth="max-w-3xl">
      <div className="space-y-4">
        {row.status === 'numbered' && (
          <div className="p-3 rounded-lg bg-slate-50 text-sm text-slate-600">
            PR ini sudah bernomor ({row.pr_no}). Perubahan tetap boleh, tetapi item yang sudah diterima tidak bisa dihapus dan
            qty-nya tidak bisa lebih kecil dari jumlah yang sudah diterima. Setiap perubahan tercatat di Activity Log.
          </div>
        )}
        {legacy.length > 0 && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
            Item lama belum terhubung ke master spare part dan <b>akan dihapus saat disimpan</b> kecuali diganti dengan part master:{' '}
            {legacy.map((i) => `${i.spare_part_name} (${i.quantity})`).join(', ')}.
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Pemesan *</Label>
            <Select value={form.requester_id} onChange={(e) => setForm((f) => ({ ...f, requester_id: e.target.value }))}>
              {!requesters.some((u) => u.id === form.requester_id) && (
                <option value={form.requester_id}>{row.requester?.full_name ?? '(pemesan)'}</option>
              )}
              {requesters.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Supplier *</Label>
            <Select value={form.supplier_id} onChange={(e) => setForm((f) => ({ ...f, supplier_id: e.target.value }))} disabled={supplierLocked}>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.code} - {s.name}</option>
              ))}
            </Select>
            {supplierLocked && <p className="text-xs text-slate-400 mt-1">Supplier terkunci karena sudah ada penerimaan barang.</p>}
          </div>
          <div className="sm:col-span-2">
            <Label>Mesin (opsional)</Label>
            <Input value={form.machine_name} onChange={(e) => setForm((f) => ({ ...f, machine_name: e.target.value }))} />
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 p-3 space-y-3">
          <div className="flex flex-col sm:flex-row gap-2 items-end">
            <div className="flex-1 w-full">
              <Label>Tambah Spare Part (dari master)</Label>
              <SearchablePicker
                inline
                value={itemPart}
                onChange={(v) => { setItemPart(v); setItemQty(1); }}
                placeholder="Cari & pilih spare part..."
                emptyText="Spare part tidak ditemukan di master."
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
              <Input type="number" min={0.01} step="any" value={itemQty || ''} onChange={(e) => setItemQty(Number(e.target.value))} />
            </div>
            <Button size="sm" variant="secondary" onClick={addItem} disabled={!itemPart}>
              <Plus className="w-4 h-4" /> Tambah
            </Button>
          </div>

          {items.length === 0 ? (
            <p className="text-sm text-slate-400">Belum ada spare part di daftar PR</p>
          ) : (
            <div className="rounded-lg bg-slate-50 divide-y divide-slate-100">
              {items.map((i) => {
                const part = parts.find((p) => p.id === i.spare_part_id);
                const rec = received.get(i.spare_part_id) ?? 0;
                return (
                  <div key={i.spare_part_id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">{part?.name}</p>
                      <p className="text-xs text-slate-400">
                        {part?.code}
                        {rec > 0 && <span className="ml-1 text-emerald-600">• sudah diterima {rec} (qty minimal {rec})</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Input
                        type="number"
                        min={rec > 0 ? rec : 0.01}
                        step="any"
                        value={i.quantity || ''}
                        onChange={(e) => {
                          const q = Number(e.target.value);
                          setItems((prev) => prev.map((x) => (x.spare_part_id === i.spare_part_id ? { ...x, quantity: q } : x)));
                        }}
                        className="w-24"
                      />
                      <span className="text-xs text-slate-500 w-10">{part?.unit}</span>
                      <button
                        type="button"
                        disabled={rec > 0}
                        title={rec > 0 ? 'Sudah ada penerimaan, tidak bisa dihapus' : 'Hapus dari daftar'}
                        onClick={() => setItems((prev) => prev.filter((x) => x.spare_part_id !== i.spare_part_id))}
                        className="text-red-500 hover:text-red-700 p-1 disabled:opacity-30 disabled:cursor-not-allowed"
                        aria-label="Hapus dari daftar"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {numbersEditable && (
          <div className="rounded-lg border border-slate-200 p-3 space-y-3">
            <p className="text-sm font-semibold text-slate-800">Nomor SAP &amp; PR (koreksi admin)</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Nomor SAP</Label>
                <Input value={sapNo} onChange={(e) => setSapNo(e.target.value)} placeholder="16xxxxxxxx" disabled={saving} />
              </div>
              <div>
                <Label>Nomor PR</Label>
                <Input value={prNo} onChange={(e) => setPrNo(e.target.value)} placeholder="TK/aa/bb/ccccc" disabled={saving} />
              </div>
            </div>
            {numbersChanged && (
              <div>
                <Label>Alasan koreksi nomor *</Label>
                <Textarea rows={2} value={numReason} onChange={(e) => setNumReason(e.target.value)} placeholder="Mis. salah ketik nomor SAP" disabled={saving} />
              </div>
            )}
            <p className="text-xs text-slate-400">Referensi pada penerimaan barang yang tertaut ke PR ini ikut diperbarui. Tercatat di Activity Log.</p>
          </div>
        )}

        <div>
          <Label>Lampiran (foto/pdf, maks 5MB per file)</Label>
          {keptFiles.length > 0 && (
            <div className="mb-2 space-y-1">
              {keptFiles.map((url, idx) => (
                <div key={`${url}-${idx}`} className="flex items-center justify-between text-xs bg-slate-50 rounded px-2 py-1">
                  <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                    <Paperclip className="w-3 h-3" /> Lampiran {idx + 1}
                  </a>
                  <button
                    type="button"
                    className="text-slate-500 hover:text-red-600"
                    onClick={() => setKeptFiles((prev) => prev.filter((_, i) => i !== idx))}
                    disabled={saving}
                    title="Lepas lampiran"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <Input
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={(e) => {
              const next = filterPrFiles(Array.from(e.target.files ?? []), newFiles);
              if (next.length > 0) setNewFiles((prev) => [...prev, ...next]);
              e.currentTarget.value = '';
            }}
          />
          {newFiles.length > 0 && (
            <div className="mt-2 space-y-1">
              {newFiles.map((file, idx) => (
                <div key={`${file.name}-${file.lastModified}-${idx}`} className="flex items-center justify-between text-xs bg-slate-50 rounded px-2 py-1">
                  <span className="truncate pr-2">{file.name} ({fmtSize(file.size)})</span>
                  <button
                    type="button"
                    className="text-slate-500 hover:text-red-600"
                    onClick={() => setNewFiles((prev) => prev.filter((_, i) => i !== idx))}
                    disabled={saving}
                    title="Hapus file"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Batal</Button>
          <Button onClick={save} disabled={saving || items.length === 0 || (numbersChanged && numReason.trim().length < 3)}>
            {saving ? 'Menyimpan...' : 'Simpan Perubahan'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function PurchaseRequirements() {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<PurchaseRequirement[]>([]);
  const [requesters, setRequesters] = useState<Profile[]>([]);
  const [suppliers, setSuppliers] = useState<{ id: string; code: string; name: string }[]>([]);
  const [acting, setActing] = useState(false);
  const [editingRow, setEditingRow] = useState<PurchaseRequirement | null>(null);
  const [numberingId, setNumberingId] = useState<string | null>(null);
  const [numbering, setNumbering] = useState<Record<string, NumberingDraft>>({});
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');

  const [form, setForm] = useState({
    requester_id: '',
    machine_name: '',
    supplier_id: '',
  });
  const [parts, setParts] = useState<PartOption[]>([]);
  const [items, setItems] = useState<{ spare_part_id: string; quantity: number }[]>([]);
  const [itemPart, setItemPart] = useState('');
  const [itemQty, setItemQty] = useState(1);

  const canCreate = profile?.role === 'admin' || profile?.role === 'ss';
  const canNumber = profile?.role === 'admin' || profile?.role === 'inventory';

  const filteredRows = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    const fromTs = createdFrom ? new Date(`${createdFrom}T00:00:00`).getTime() : null;
    const toTs = createdTo ? new Date(`${createdTo}T23:59:59.999`).getTime() : null;

    return rows.filter((row) => {
      const createdTs = new Date(row.created_at).getTime();
      if (fromTs !== null && createdTs < fromTs) return false;
      if (toTs !== null && createdTs > toTs) return false;

      if (!keyword) return true;
      const haystack = [
        ...(row.items ?? []).flatMap((i) => [i.spare_part_name, i.spare_part?.code ?? '', String(i.quantity)]),
        row.machine_name ?? '',
        row.sap_no ?? '',
        row.pr_no ?? '',
        row.requester?.full_name ?? '',
        row.supplier?.code ?? '',
        row.supplier?.name ?? '',
        row.creator?.full_name ?? '',
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(keyword);
    });
  }, [rows, searchTerm, createdFrom, createdTo]);

  const pendingCount = useMemo(() => filteredRows.filter((r) => r.status === 'pending_numbering').length, [filteredRows]);
  const hasFilter = Boolean(searchTerm.trim() || createdFrom || createdTo);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: req }, { data: users }, { data: sups }, { data: sp }] = await Promise.all([
      supabase.from('purchase_requirements').select(PR_SELECT).order('created_at', { ascending: false }),
      supabase.from('profiles').select('*').eq('is_active', true).order('full_name'),
      supabase.from('inventory_suppliers').select('id, code, name').order('name'),
      supabase.from('spare_parts').select('id, code, name, unit, category, location, current_stock').order('name'),
    ]);

    const requesterRows = (users as Profile[]) ?? [];
    const supplierRows = (sups as { id: string; code: string; name: string }[]) ?? [];
    setRows((req as unknown as PurchaseRequirement[]) ?? []);
    setRequesters(requesterRows);
    setSuppliers(supplierRows);
    setParts((sp as PartOption[]) ?? []);

    if (!form.requester_id && requesterRows.length > 0) {
      setForm((f) => ({ ...f, requester_id: requesterRows[0].id }));
    }
    if (!form.supplier_id && supplierRows.length > 0) {
      setForm((f) => ({ ...f, supplier_id: supplierRows[0].id }));
    }

    setLoading(false);
  }, [form.requester_id, form.supplier_id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!profile) return null;

  function handlePickAttachmentFiles(files: FileList | null) {
    if (!files) return;
    const next = filterPrFiles(Array.from(files), attachmentFiles);
    if (next.length > 0) setAttachmentFiles((prev) => [...prev, ...next]);
  }

  function removeAttachmentFile(index: number) {
    setAttachmentFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function addItem() {
    if (!itemPart) return;
    if (!Number.isFinite(itemQty) || itemQty <= 0) {
      alert('Quantity harus lebih besar dari 0.');
      return;
    }
    setItems((prev) =>
      prev.some((i) => i.spare_part_id === itemPart)
        ? prev.map((i) => (i.spare_part_id === itemPart ? { ...i, quantity: i.quantity + itemQty } : i))
        : [...prev, { spare_part_id: itemPart, quantity: itemQty }]
    );
    setItemPart('');
    setItemQty(1);
  }

  function updateItemQty(sparePartId: string, quantity: number) {
    setItems((prev) => prev.map((i) => (i.spare_part_id === sparePartId ? { ...i, quantity } : i)));
  }

  async function createPR() {
    if (!canCreate) return;
    if (items.length === 0) {
      alert('Tambahkan minimal satu spare part.');
      return;
    }
    const bad = items.find((i) => !Number.isFinite(i.quantity) || i.quantity <= 0);
    if (bad) {
      const name = parts.find((p) => p.id === bad.spare_part_id)?.name ?? 'spare part';
      alert(`Quantity ${name} harus lebih besar dari 0.`);
      return;
    }
    if (!form.requester_id) {
      alert('Pemesan wajib dipilih.');
      return;
    }
    if (!form.supplier_id) {
      alert('Supplier wajib dipilih.');
      return;
    }

    setActing(true);
    const { data, error } = await supabase.rpc('create_purchase_requirement_items', {
      p_items: items,
      p_requester_id: form.requester_id,
      p_machine_name: form.machine_name.trim() || null,
      p_supplier_id: form.supplier_id,
    });

    if (error) {
      setActing(false);
      alert('Gagal membuat PR: ' + error.message);
      return;
    }

    const created = data as { id: string } | null;
    if (created?.id && attachmentFiles.length > 0) {
      try {
        const urls = await uploadAttachmentFiles(created.id, attachmentFiles);
        const { error: attachError } = await supabase.rpc('set_purchase_requirement_attachments', {
          p_pr_id: created.id,
          p_attachments: urls,
        });
        if (attachError) {
          alert('PR berhasil dibuat, tetapi lampiran gagal disimpan: ' + attachError.message);
        }
      } catch (e) {
        alert('PR berhasil dibuat, tetapi upload lampiran gagal: ' + (e instanceof Error ? e.message : String(e)));
      }
    }

    setActing(false);
    setForm({
      requester_id: form.requester_id,
      machine_name: '',
      supplier_id: form.supplier_id,
    });
    setItems([]);
    setItemPart('');
    setItemQty(1);
    setAttachmentFiles([]);
    await load();
  }

  async function saveNumbering(row: PurchaseRequirement) {
    if (!canNumber) return;
    const draft = numbering[row.id];
    if (!draft?.sap_no?.trim() || !draft?.pr_no?.trim()) {
      alert('Nomor SAP dan nomor PR wajib diisi.');
      return;
    }

    setNumberingId(row.id);
    const { error } = await supabase.rpc('set_purchase_requirement_numbers', {
      p_pr_id: row.id,
      p_sap_no: draft.sap_no.trim(),
      p_pr_no: draft.pr_no.trim(),
    });
    setNumberingId(null);

    if (error) {
      alert('Gagal menyimpan nomor: ' + error.message);
      return;
    }

    setNumbering((prev) => {
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
    await load();
  }

  return (
    <div className="space-y-4">
      {canCreate && (
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold text-slate-900">Buat Purchase Requirement</h2>
            <Button variant="secondary" onClick={load}>
              <RefreshCw className="w-4 h-4" /> Refresh
            </Button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2 rounded-lg border border-slate-200 p-3 space-y-3">
              <div className="flex flex-col sm:flex-row gap-2 items-end">
                <div className="flex-1 w-full">
                  <Label>Spare Part * (dari master, cari nama/kode)</Label>
                  <SearchablePicker
                    inline
                    value={itemPart}
                    onChange={(v) => { setItemPart(v); setItemQty(1); }}
                    placeholder="Cari & pilih spare part..."
                    emptyText="Spare part tidak ditemukan di master. Tambahkan dulu di menu Spare Parts."
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
                  <Input type="number" min={0.01} step="any" value={itemQty || ''} onChange={(e) => setItemQty(Number(e.target.value))} />
                </div>
                <Button size="sm" variant="secondary" onClick={addItem} disabled={!itemPart}>
                  <Plus className="w-4 h-4" /> Tambah
                </Button>
              </div>

              {items.length === 0 ? (
                <p className="text-sm text-slate-400">Belum ada spare part di daftar PR</p>
              ) : (
                <div className="rounded-lg bg-slate-50 divide-y divide-slate-100">
                  {items.map((i) => {
                    const part = parts.find((p) => p.id === i.spare_part_id);
                    return (
                      <div key={i.spare_part_id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-900 truncate">{part?.name}</p>
                          <p className="text-xs text-slate-400">{part?.code} • stok {part?.current_stock} {part?.unit}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <Input
                            type="number"
                            min={0.01}
                            step="any"
                            value={i.quantity || ''}
                            onChange={(e) => updateItemQty(i.spare_part_id, Number(e.target.value))}
                            className="w-24"
                          />
                          <span className="text-xs text-slate-500 w-10">{part?.unit}</span>
                          <button
                            type="button"
                            onClick={() => setItems((prev) => prev.filter((x) => x.spare_part_id !== i.spare_part_id))}
                            className="text-red-500 hover:text-red-700 p-1"
                            aria-label="Hapus dari daftar"
                          >
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
              <Label>Pemesan *</Label>
              <Select value={form.requester_id} onChange={(e) => setForm((f) => ({ ...f, requester_id: e.target.value }))}>
                <option value="">Pilih pemesan...</option>
                {requesters.map((u) => (
                  <option key={u.id} value={u.id}>{u.full_name}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Supplier *</Label>
              <Select value={form.supplier_id} onChange={(e) => setForm((f) => ({ ...f, supplier_id: e.target.value }))}>
                <option value="">Pilih supplier...</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} - {s.name}</option>
                ))}
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label>Mesin (opsional)</Label>
              <Input
                value={form.machine_name}
                onChange={(e) => setForm((f) => ({ ...f, machine_name: e.target.value }))}
                placeholder="Contoh: Press Line 2"
              />
            </div>
            <div className="sm:col-span-2">
              <Label>Lampiran (foto/pdf, maks 5MB per file)</Label>
              <Input
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => {
                  handlePickAttachmentFiles(e.target.files);
                  e.currentTarget.value = '';
                }}
              />
              {attachmentFiles.length > 0 && (
                <div className="mt-2 space-y-1">
                  {attachmentFiles.map((file, idx) => (
                    <div key={`${file.name}-${file.lastModified}-${idx}`} className="flex items-center justify-between text-xs bg-slate-50 rounded px-2 py-1">
                      <span className="truncate pr-2">{file.name} ({fmtSize(file.size)})</span>
                      <button
                        type="button"
                        className="text-slate-500 hover:text-red-600"
                        onClick={() => removeAttachmentFile(idx)}
                        disabled={acting}
                        title="Hapus file"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={createPR} disabled={acting}>
              {acting ? 'Menyimpan...' : `Buat PR (${items.length} item)`}
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="font-semibold text-slate-900">Daftar Purchase Requirement</h2>
          <div className="text-xs text-slate-500">Pending (hasil filter): <b>{pendingCount}</b></div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Cari: spare part, supplier, pemesan, no SAP/PR"
            className="sm:col-span-2"
          />
          <Input type="date" value={createdFrom} onChange={(e) => setCreatedFrom(e.target.value)} />
          <Input type="date" value={createdTo} onChange={(e) => setCreatedTo(e.target.value)} />
        </div>

        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>Menampilkan {filteredRows.length} dari {rows.length} data</span>
          {hasFilter && (
            <button
              type="button"
              className="text-blue-600 hover:text-blue-700 font-medium"
              onClick={() => {
                setSearchTerm('');
                setCreatedFrom('');
                setCreatedTo('');
              }}
            >
              Reset filter
            </button>
          )}
        </div>

        {loading ? (
          <Spinner />
        ) : filteredRows.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center">
            {rows.length === 0 ? 'Belum ada data PR.' : 'Tidak ada data PR sesuai pencarian/periode.'}
          </p>
        ) : (
          <div className="space-y-3">
            {filteredRows.map((row) => {
              const draft = numbering[row.id] ?? { sap_no: '', pr_no: currentPrPrefix() };
              const canFill = canNumber && row.status === 'pending_numbering';
              return (
                <div key={row.id} className="rounded-lg border border-slate-200 p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{(row.items ?? []).length} item spare part</p>
                      <p className="text-xs text-slate-500">
                        Supplier: {row.supplier?.name ?? '-'} • Pemesan: {row.requester?.full_name ?? '-'}
                      </p>
                      {row.machine_name && <p className="text-xs text-slate-500">Mesin: {row.machine_name}</p>}
                      <p className="text-xs text-slate-400">
                        Dibuat {fmtDate(row.created_at)} oleh {row.creator?.full_name ?? '-'}
                      </p>
                      <p className="text-xs text-slate-400">Lampiran: {(row.attachment_files ?? []).length} file</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {(profile.role === 'admin' || (profile.role === 'ss' && row.created_by === profile.id)) && (
                        <Button size="sm" variant="secondary" onClick={() => setEditingRow(row)}>
                          <Pencil className="w-3.5 h-3.5" /> Edit
                        </Button>
                      )}
                      <Badge className={STATUS_COLORS[row.status]}>{STATUS_LABELS[row.status]}</Badge>
                    </div>
                  </div>

                  <PrItemsList row={row} />


                  {(row.attachment_files ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {(row.attachment_files ?? []).map((url, idx) => (
                        <a
                          key={`${row.id}-att-${idx}`}
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                        >
                          <Paperclip className="w-3 h-3" /> Lampiran {idx + 1}
                        </a>
                      ))}
                    </div>
                  )}

                  {row.status === 'numbered' ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                      <div className="rounded-lg bg-slate-50 p-2">
                        <p className="text-xs text-slate-400">No. SAP</p>
                        <p className="font-medium text-slate-800">{row.sap_no ?? '-'}</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-2">
                        <p className="text-xs text-slate-400">No. PR</p>
                        <p className="font-medium text-slate-800">{row.pr_no ?? '-'}</p>
                        <p className="text-xs text-slate-400 mt-1">
                          Oleh {row.numberer?.full_name ?? '-'} • {fmtDate(row.numbered_at)}
                        </p>
                      </div>
                    </div>
                  ) : canFill ? (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <Input
                          value={draft.sap_no}
                          placeholder="Nomor SAP (16xxxxxxxx)"
                          onChange={(e) =>
                            setNumbering((prev) => ({ ...prev, [row.id]: { ...draft, sap_no: e.target.value } }))
                          }
                        />
                        <Input
                          value={draft.pr_no}
                          placeholder="Nomor PR (TK/aa/bb/ccccc)"
                          onChange={(e) =>
                            setNumbering((prev) => ({ ...prev, [row.id]: { ...draft, pr_no: e.target.value } }))
                          }
                        />
                      </div>
                      <p className="text-xs text-slate-400">Format SAP: 16xxxxxxxx • Format PR: TK/aa/bb/ccccc (aa/bb harus bulan berjalan).</p>
                      <div className="flex justify-end">
                        <Button size="sm" onClick={() => saveNumbering(row)} disabled={numberingId === row.id}>
                          {numberingId === row.id ? 'Menyimpan...' : 'Simpan Nomor'}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-slate-400">Menunggu PIC Inventory/Admin mengisi nomor SAP dan nomor PR.</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {editingRow && (
        <EditPrModal
          row={editingRow}
          parts={parts}
          requesters={requesters}
          suppliers={suppliers}
          canEditNumbers={profile.role === 'admin'}
          onClose={() => setEditingRow(null)}
          onSaved={async () => {
            setEditingRow(null);
            await load();
          }}
        />
      )}
    </div>
  );
}
