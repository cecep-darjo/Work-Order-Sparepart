import { useEffect, useMemo, useState } from 'react';
import { supabase, TX_TYPE_LABELS, GR_KIND_LABELS } from '@/lib/supabase';
import { Button, Input, Label, Modal, Spinner, Textarea } from '@/components/ui';
import { Paperclip, X } from 'lucide-react';

type TxRow = {
  id: string;
  type: 'stock_in' | 'stock_out' | 'adjustment' | 'opname';
  quantity: number;
  reference: string | null;
  notes: string | null;
  source: string | null;
  destination: string | null;
  recipient: string | null;
  gr_no: string | null;
  gr_kind: 'credit' | 'cash' | 'import' | null;
  gr_attachments: string[] | null;
  issue_slip_no: string | null;
  work_order_id: string | null;
  transaction_no: string | null;
  created_at: string;
  spare_part: { code: string; name: string; unit: string; current_stock: number } | null;
};

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function uploadGrFiles(files: File[]): Promise<string[]> {
  const urls: string[] = [];
  for (const file of files) {
    const ext = file.name.includes('.') ? file.name.split('.').pop() : '';
    const safeBase = file.name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'file';
    const objectPath = `gr/${new Date().getFullYear()}/${Date.now()}-${crypto.randomUUID()}-${safeBase}${ext ? `.${ext}` : ''}`;
    const { error } = await supabase.storage.from('inventory-gr-files').upload(objectPath, file, { upsert: false, contentType: file.type });
    if (error) throw error;
    urls.push(supabase.storage.from('inventory-gr-files').getPublicUrl(objectPath).data.publicUrl);
  }
  return urls;
}

/**
 * Editor khusus admin untuk transaksi inventory yang sudah tersimpan.
 * - Data dokumen (referensi, keterangan, sumber/tujuan, penerima, lampiran GR) berlaku untuk seluruh
 *   baris dalam dokumen yang sama (satu no. GR / satu no. slip) dan tidak mengubah stok.
 * - Koreksi qty hanya untuk satu baris; saldo sesudahnya dihitung ulang oleh server.
 */
export default function EditTransactionModal({
  txId,
  onClose,
  onSaved,
}: {
  txId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [loading, setLoading] = useState(true);
  const [tx, setTx] = useState<TxRow | null>(null);
  const [docLines, setDocLines] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState({ reference: '', notes: '', source: '', destination: '', recipient: '' });
  const [newQty, setNewQty] = useState<number>(0);
  const [keptFiles, setKeptFiles] = useState<string[]>([]);
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('inventory_transactions')
        .select(
          'id, type, quantity, reference, notes, source, destination, recipient, gr_no, gr_kind, gr_attachments, issue_slip_no, work_order_id, transaction_no, created_at, spare_part:spare_parts(code, name, unit, current_stock)'
        )
        .eq('id', txId)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setLoadError(error?.message ?? 'Transaksi tidak ditemukan.');
        setLoading(false);
        return;
      }
      const row = data as unknown as TxRow;

      let lines = 1;
      if (row.gr_no || row.issue_slip_no) {
        const q = supabase.from('inventory_transactions').select('id', { count: 'exact', head: true });
        const { count } = row.gr_no ? await q.eq('gr_no', row.gr_no) : await q.eq('issue_slip_no', row.issue_slip_no as string);
        lines = count ?? 1;
      }
      if (cancelled) return;

      setTx(row);
      setDocLines(lines);
      setForm({
        reference: row.reference ?? '',
        notes: row.notes ?? '',
        source: row.source ?? '',
        destination: row.destination ?? '',
        recipient: row.recipient ?? '',
      });
      setNewQty(Number(row.quantity));
      setKeptFiles(row.gr_attachments ?? []);
      setNewFiles([]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [txId]);

  const qtyBlocked = useMemo(() => {
    if (!tx) return null;
    if (tx.type === 'opname') return 'Transaksi opname tidak dapat dikoreksi qty-nya (saldonya absolut). Buat opname baru bila perlu.';
    if (tx.work_order_id) return 'Transaksi ini terkait Work Order/permintaan part. Ubah qty lewat modul Work Order.';
    return null;
  }, [tx]);

  const qtyChanged = !!tx && !qtyBlocked && Number.isFinite(newQty) && newQty > 0 && newQty !== Number(tx.quantity);

  const docChanged = useMemo(() => {
    if (!tx) return false;
    const norm = (v: string | null) => (v ?? '').trim();
    const originalFiles = tx.gr_attachments ?? [];
    return (
      norm(form.reference) !== norm(tx.reference) ||
      norm(form.notes) !== norm(tx.notes) ||
      (tx.type === 'stock_in' && norm(form.source) !== norm(tx.source)) ||
      (tx.type === 'stock_out' && norm(form.destination) !== norm(tx.destination)) ||
      (!!tx.issue_slip_no && norm(form.recipient) !== norm(tx.recipient)) ||
      (!!tx.gr_no && (newFiles.length > 0 || keptFiles.length !== originalFiles.length))
    );
  }, [tx, form, newFiles, keptFiles]);

  const stockPreview = useMemo(() => {
    if (!tx || !tx.spare_part || !qtyChanged) return null;
    const sign = tx.type === 'stock_out' ? -1 : 1;
    const delta = sign * (newQty - Number(tx.quantity));
    return { from: Number(tx.spare_part.current_stock), to: Number(tx.spare_part.current_stock) + delta, delta };
  }, [tx, qtyChanged, newQty]);

  function pickFiles(list: FileList | null) {
    if (!list) return;
    const next: File[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_FILE_SIZE) { alert(`File ${f.name} melebihi 5MB.`); continue; }
      if (!ALLOWED_MIME.includes(f.type)) { alert(`Tipe file ${f.name} tidak didukung. Hanya JPG/PNG/WEBP/PDF.`); continue; }
      const dup = [...newFiles, ...next].some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified);
      if (!dup) next.push(f);
    }
    if (next.length > 0) setNewFiles((prev) => [...prev, ...next]);
  }

  async function save() {
    if (!tx) return;
    if (reason.trim().length < 3) {
      alert('Alasan perubahan wajib diisi.');
      return;
    }
    if (!qtyChanged && !docChanged) {
      alert('Tidak ada perubahan untuk disimpan.');
      return;
    }

    setSaving(true);
    let qtyDone = false;
    try {
      if (qtyChanged) {
        const { error } = await supabase.rpc('admin_correct_transaction_qty', {
          p_tx_id: tx.id,
          p_new_qty: newQty,
          p_reason: reason.trim(),
        });
        if (error) {
          alert('Koreksi qty gagal: ' + error.message);
          return;
        }
        qtyDone = true;
      }

      if (docChanged) {
        let attachments: string[] | null = null;
        if (tx.gr_no) {
          const uploaded = newFiles.length > 0 ? await uploadGrFiles(newFiles) : [];
          attachments = [...keptFiles, ...uploaded];
        }
        const { error } = await supabase.rpc('admin_update_inventory_document', {
          p_tx_id: tx.id,
          p_reference: form.reference,
          p_notes: form.notes,
          p_source: form.source,
          p_destination: form.destination,
          p_recipient: form.recipient,
          p_gr_attachments: attachments,
          p_reason: reason.trim(),
        });
        if (error) {
          alert((qtyDone ? 'Qty sudah dikoreksi, tetapi perubahan data dokumen gagal: ' : 'Gagal menyimpan perubahan dokumen: ') + error.message);
          if (qtyDone) await onSaved();
          return;
        }
      }

      await onSaved();
    } catch (e) {
      alert('Gagal menyimpan: ' + (e instanceof Error ? e.message : String(e)));
      if (qtyDone) await onSaved();
    } finally {
      setSaving(false);
    }
  }

  const title = tx ? `Edit ${tx.gr_no ?? tx.issue_slip_no ?? tx.transaction_no ?? 'Transaksi'}` : 'Edit Transaksi';

  return (
    <Modal open onClose={() => !saving && onClose()} title={title} maxWidth="max-w-2xl">
      {loading ? (
        <Spinner />
      ) : loadError || !tx ? (
        <div className="space-y-3">
          <p className="text-sm text-red-600">{loadError ?? 'Transaksi tidak ditemukan.'}</p>
          <div className="flex justify-end"><Button variant="secondary" onClick={onClose}>Tutup</Button></div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-400">Spare part</p>
              <p className="font-medium text-slate-800">{tx.spare_part?.code} - {tx.spare_part?.name}</p>
              <p className="text-xs text-slate-500">Stok sekarang {tx.spare_part?.current_stock} {tx.spare_part?.unit}</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-400">Transaksi</p>
              <p className="font-medium text-slate-800">{TX_TYPE_LABELS[tx.type]} • {tx.transaction_no ?? '-'}</p>
              <p className="text-xs text-slate-500">
                {new Date(tx.created_at).toLocaleString('id-ID')}
                {tx.gr_kind && ` • ${GR_KIND_LABELS[tx.gr_kind]}`}
              </p>
            </div>
          </div>

          {/* Koreksi qty (satu baris) */}
          <div className="rounded-lg border border-slate-200 p-3 space-y-2">
            <p className="text-sm font-semibold text-slate-800">Quantity</p>
            {qtyBlocked ? (
              <p className="text-sm text-slate-500">{qtyBlocked}</p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="0.01"
                    step="any"
                    value={newQty || ''}
                    onChange={(e) => setNewQty(Number(e.target.value))}
                    className="w-32"
                    disabled={saving}
                  />
                  <span className="text-sm text-slate-500">{tx.spare_part?.unit} (semula {tx.quantity})</span>
                </div>
                {stockPreview && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    Saldo transaksi sesudahnya dihitung ulang. Perkiraan stok {stockPreview.from} → {stockPreview.to} {tx.spare_part?.unit}
                    {' '}(tidak berubah bila sesudahnya ada opname). Ditolak otomatis bila membuat saldo negatif.
                  </p>
                )}
              </>
            )}
          </div>

          {/* Data dokumen */}
          <div className="rounded-lg border border-slate-200 p-3 space-y-3">
            <div>
              <p className="text-sm font-semibold text-slate-800">Data dokumen</p>
              {docLines > 1 && (
                <p className="text-xs text-slate-500">Perubahan di bawah berlaku untuk seluruh <b>{docLines} barang</b> pada dokumen ini.</p>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Referensi</Label>
                <Input value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} disabled={saving} />
              </div>
              {tx.type === 'stock_in' && (
                <div>
                  <Label>Sumber</Label>
                  <Input value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} disabled={saving} />
                </div>
              )}
              {tx.type === 'stock_out' && (
                <div>
                  <Label>Tujuan / keperluan</Label>
                  <Input value={form.destination} onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value }))} disabled={saving} />
                </div>
              )}
              {tx.issue_slip_no && (
                <div>
                  <Label>Penerima</Label>
                  <Input value={form.recipient} onChange={(e) => setForm((f) => ({ ...f, recipient: e.target.value }))} disabled={saving} />
                </div>
              )}
            </div>
            <div>
              <Label>Keterangan</Label>
              <Textarea rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} disabled={saving} />
            </div>

            {tx.gr_no && (
              <div>
                <Label>Lampiran GR (foto/pdf, maks 5MB per file)</Label>
                {keptFiles.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {keptFiles.map((url, idx) => (
                      <div key={`${url}-${idx}`} className="flex items-center justify-between text-xs bg-slate-50 rounded px-2 py-1">
                        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                          <Paperclip className="w-3 h-3" /> Lampiran {idx + 1}
                        </a>
                        <button type="button" className="text-slate-500 hover:text-red-600" disabled={saving} title="Lepas lampiran"
                          onClick={() => setKeptFiles((prev) => prev.filter((_, i) => i !== idx))}>
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <Input type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" disabled={saving}
                  onChange={(e) => { pickFiles(e.target.files); e.currentTarget.value = ''; }} />
                {newFiles.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {newFiles.map((f, idx) => (
                      <div key={`${f.name}-${f.lastModified}-${idx}`} className="flex items-center justify-between text-xs bg-slate-50 rounded px-2 py-1">
                        <span className="truncate pr-2">{f.name} ({fmtSize(f.size)})</span>
                        <button type="button" className="text-slate-500 hover:text-red-600" disabled={saving} title="Hapus file"
                          onClick={() => setNewFiles((prev) => prev.filter((_, i) => i !== idx))}>
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <Label>Alasan perubahan *</Label>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Mis. salah input qty saat penerimaan" disabled={saving} />
            <p className="text-xs text-slate-400 mt-1">Tercatat di Activity Log bersama isi perubahan.</p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={saving}>Batal</Button>
            <Button onClick={save} disabled={saving || reason.trim().length < 3 || (!qtyChanged && !docChanged)}>
              {saving ? 'Menyimpan...' : 'Simpan Perubahan'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
