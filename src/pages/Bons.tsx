import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Badge, Button, Card, EmptyState, Input, Label, Modal, Select, Spinner, Textarea } from '@/components/ui';
import { SearchablePicker, matchesQuery } from '@/components/Pickers';
import { BON_SELECT, BON_STATUS_COLORS, bonRemaining, bonStatusLabel, type Bon } from '@/lib/bons';
import { Pencil, Plus, RefreshCw, Search, Trash2, XCircle } from 'lucide-react';

type PartOption = {
  id: string;
  code: string;
  name: string;
  unit: string;
  category: string | null;
  location: string | null;
  current_stock: number;
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Form buat / ubah bon. Pada mode ubah, item yang sudah dikeluarkan tidak bisa dihapus dan qty >= yang sudah keluar. */
function BonFormModal({
  bon,
  parts,
  onClose,
  onSaved,
}: {
  bon: Bon | null;
  parts: PartOption[];
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
}) {
  const issuedByPart = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of bon?.items ?? []) m.set(it.spare_part_id, Number(it.issued_qty));
    return m;
  }, [bon]);

  const [items, setItems] = useState<{ spare_part_id: string; quantity: number }[]>(() =>
    (bon?.items ?? []).map((i) => ({ spare_part_id: i.spare_part_id, quantity: Number(i.quantity) }))
  );
  const [notes, setNotes] = useState(bon?.notes ?? '');
  const [itemPart, setItemPart] = useState('');
  const [itemQty, setItemQty] = useState(1);
  const [saving, setSaving] = useState(false);

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
    if (notes.trim().length < 3) {
      alert('Keterangan bon wajib diisi.');
      return;
    }
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
      const issued = issuedByPart.get(i.spare_part_id) ?? 0;
      if (i.quantity < issued) {
        alert(`Qty ${name} tidak boleh lebih kecil dari yang sudah dikeluarkan (${issued}).`);
        return;
      }
    }

    setSaving(true);
    const { data, error } = bon
      ? await supabase.rpc('update_spare_part_bon', { p_bon_id: bon.id, p_items: items, p_notes: notes.trim() })
      : await supabase.rpc('create_spare_part_bon', { p_items: items, p_notes: notes.trim() });
    setSaving(false);
    if (error) {
      alert((bon ? 'Gagal menyimpan perubahan bon: ' : 'Gagal membuat bon: ') + error.message);
      return;
    }
    const no = (data as { bon_no?: string } | null)?.bon_no ?? bon?.bon_no ?? '';
    await onSaved(bon ? `Bon ${no} berhasil diubah.` : `Bon ${no} berhasil dibuat. Inventory akan memprosesnya.`);
  }

  return (
    <Modal open onClose={() => !saving && onClose()} title={bon ? `Ubah Bon ${bon.bon_no}` : 'Buat Bon Sparepart'} maxWidth="max-w-2xl">
      <div className="space-y-4">
        <div>
          <Label>Keterangan / keperluan *</Label>
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Mis. penggantian bearing conveyor line 2"
            disabled={saving}
          />
        </div>

        <div className="rounded-lg border border-slate-200 p-3 space-y-3">
          <div className="flex flex-col sm:flex-row gap-2 items-end">
            <div className="flex-1 w-full">
              <Label>Cari Spare Part</Label>
              <SearchablePicker
                inline
                value={itemPart}
                onChange={(v) => { setItemPart(v); setItemQty(1); }}
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
              <Input type="number" min="0.01" step="any" value={itemQty || ''} onChange={(e) => setItemQty(Number(e.target.value))} />
            </div>
            <Button size="sm" variant="secondary" onClick={addItem} disabled={!itemPart || saving}>
              <Plus className="w-4 h-4" /> Tambah
            </Button>
          </div>

          {items.length === 0 ? (
            <p className="text-sm text-slate-400">Belum ada spare part di daftar bon</p>
          ) : (
            <div className="rounded-lg bg-slate-50 divide-y divide-slate-100">
              {items.map((i) => {
                const part = parts.find((p) => p.id === i.spare_part_id);
                const issued = issuedByPart.get(i.spare_part_id) ?? 0;
                return (
                  <div key={i.spare_part_id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">{part?.name}</p>
                      <p className="text-xs text-slate-400">
                        {part?.code} • stok {part?.current_stock} {part?.unit}
                        {issued > 0 && <span className="ml-1 text-emerald-600">• sudah dikeluarkan {issued}</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Input
                        type="number"
                        min={issued > 0 ? issued : 0.01}
                        step="any"
                        value={i.quantity || ''}
                        onChange={(e) => {
                          const q = Number(e.target.value);
                          setItems((prev) => prev.map((x) => (x.spare_part_id === i.spare_part_id ? { ...x, quantity: q } : x)));
                        }}
                        className="w-24"
                        disabled={saving}
                      />
                      <span className="text-xs text-slate-500 w-10">{part?.unit}</span>
                      <button
                        type="button"
                        disabled={issued > 0 || saving}
                        title={issued > 0 ? 'Sudah ada pengeluaran, tidak bisa dihapus' : 'Hapus dari daftar'}
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

        <p className="text-xs text-slate-400">Stok di atas hanya informasi. Inventory yang memproses pengeluarannya.</p>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Batal</Button>
          <Button onClick={save} disabled={saving || items.length === 0 || notes.trim().length < 3}>
            {saving ? 'Menyimpan...' : bon ? 'Simpan Perubahan' : `Kirim Bon (${items.length} item)`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CancelBonModal({
  bon,
  staff,
  onClose,
  onDone,
}: {
  bon: Bon;
  staff: boolean;
  onClose: () => void;
  onDone: (message: string) => void | Promise<void>;
}) {
  const closing = staff && bon.status === 'partial';
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (staff && reason.trim().length < 3) {
      alert('Alasan wajib diisi.');
      return;
    }
    setSaving(true);
    const { error } = await supabase.rpc('cancel_spare_part_bon', { p_bon_id: bon.id, p_reason: reason.trim() || null });
    setSaving(false);
    if (error) {
      alert('Gagal: ' + error.message);
      return;
    }
    await onDone(closing ? `Bon ${bon.bon_no} ditutup.` : `Bon ${bon.bon_no} dibatalkan.`);
  }

  return (
    <Modal open onClose={() => !saving && onClose()} title={closing ? `Tutup Bon ${bon.bon_no}` : `Batalkan Bon ${bon.bon_no}`} maxWidth="max-w-md">
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          {closing
            ? 'Sebagian barang sudah dikeluarkan. Menutup bon berarti sisa yang belum dikeluarkan tidak akan dipenuhi.'
            : 'Bon yang dibatalkan tidak akan diproses inventory.'}
        </p>
        <div>
          <Label>Alasan{staff ? ' *' : ' (opsional)'}</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} disabled={saving} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Kembali</Button>
          <Button variant="danger" onClick={submit} disabled={saving || (staff && reason.trim().length < 3)}>
            {saving ? 'Memproses...' : closing ? 'Tutup Bon' : 'Batalkan Bon'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function Bons() {
  const { profile } = useAuth();
  const role = profile?.role;
  const staff = role === 'admin' || role === 'inventory'; // melihat semua bon
  const canCreate = role !== 'inventory';

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bons, setBons] = useState<Bon[]>([]);
  const [parts, setParts] = useState<PartOption[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');
  const [formBon, setFormBon] = useState<Bon | 'new' | null>(null);
  const [cancelBon, setCancelBon] = useState<Bon | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [{ data: b, error }, { data: sp }] = await Promise.all([
      supabase.from('spare_part_bons').select(BON_SELECT).order('created_at', { ascending: false }).limit(500),
      supabase.from('spare_parts').select('id, code, name, unit, category, location, current_stock').order('name'),
    ]);
    if (error) setLoadError(error.message);
    setBons((b as unknown as Bon[]) ?? []);
    setParts((sp as PartOption[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    return bons.filter((b) => {
      if (status === 'active' && !['pending', 'partial'].includes(b.status)) return false;
      if (status !== 'active' && status !== 'all' && b.status !== status) return false;
      if (!search.trim()) return true;
      const hay = [
        b.bon_no,
        b.notes,
        b.requester?.full_name ?? '',
        ...b.items.flatMap((i) => [i.spare_part?.code ?? '', i.spare_part?.name ?? '']),
      ].join(' ');
      return matchesQuery(hay, search);
    });
  }, [bons, status, search]);

  if (!profile) return null;

  function canEdit(b: Bon): boolean {
    if (b.status === 'cancelled') return false;
    if (role === 'admin') return true;
    return canCreate && b.requester_id === profile!.id && b.status === 'pending';
  }

  function canCancel(b: Bon): boolean {
    if (b.status === 'pending') return staff || b.requester_id === profile!.id;
    if (b.status === 'partial') return staff;
    return false;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder={staff ? 'Cari no. bon, pembuat, keterangan, spare part...' : 'Cari no. bon, keterangan, spare part...'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="lg:w-52">
          <option value="active">Aktif (menunggu/sebagian)</option>
          <option value="all">Semua status</option>
          <option value="pending">Menunggu</option>
          <option value="partial">Sebagian</option>
          <option value="issued">Selesai</option>
          <option value="cancelled">Dibatalkan</option>
        </Select>
        <Button variant="secondary" onClick={load}>
          <RefreshCw className="w-4 h-4" /> Refresh
        </Button>
        {canCreate && (
          <Button onClick={() => setFormBon('new')}>
            <Plus className="w-4 h-4" /> Buat Bon
          </Button>
        )}
      </div>

      {!staff && <p className="text-xs text-slate-500">Anda hanya melihat bon yang Anda buat sendiri.</p>}
      {role === 'inventory' && (
        <p className="text-xs text-slate-500">Bon diproses di menu Inventory Transactions → Pengeluaran (Panggil dari Bon Sparepart).</p>
      )}

      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 px-4 py-3 text-sm flex items-center justify-between gap-3">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-emerald-700 hover:text-emerald-900 font-medium">Tutup</button>
        </div>
      )}
      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm px-4 py-3">Gagal memuat bon: {loadError}</div>
      )}

      {loading ? (
        <Spinner />
      ) : filtered.length === 0 ? (
        <Card><EmptyState message={status === 'active' ? 'Tidak ada bon yang sedang aktif.' : 'Tidak ada bon pada filter ini.'} /></Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((b) => (
            <Card key={b.id} className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <p className="font-semibold text-slate-900">{b.bon_no}</p>
                  <p className="text-xs text-slate-400">
                    {fmtDateTime(b.created_at)}
                    {staff && <> • oleh <b className="text-slate-600">{b.requester?.full_name ?? '-'}</b></>}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {canEdit(b) && (
                    <Button size="sm" variant="secondary" onClick={() => setFormBon(b)}>
                      <Pencil className="w-3.5 h-3.5" /> Ubah
                    </Button>
                  )}
                  {canCancel(b) && (
                    <Button size="sm" variant="secondary" onClick={() => setCancelBon(b)}>
                      <XCircle className="w-3.5 h-3.5" /> {b.status === 'partial' ? 'Tutup' : 'Batalkan'}
                    </Button>
                  )}
                  <Badge className={BON_STATUS_COLORS[b.status]}>{bonStatusLabel(b)}</Badge>
                </div>
              </div>

              <p className="text-sm text-slate-700 whitespace-pre-wrap">{b.notes}</p>

              <div className="rounded-lg bg-slate-50 divide-y divide-slate-100">
                {[...b.items].sort((x, y) => (x.spare_part?.name ?? '').localeCompare(y.spare_part?.name ?? '')).map((it) => {
                  const rem = bonRemaining(it);
                  return (
                    <div key={it.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                      <div className="min-w-0">
                        <p className="text-sm text-slate-800 truncate">{it.spare_part?.name}</p>
                        <p className="text-xs text-slate-400">{it.spare_part?.code}</p>
                      </div>
                      <div className="text-sm text-right flex-shrink-0">
                        <span className="font-semibold text-slate-900">{it.issued_qty}/{it.quantity}</span> {it.spare_part?.unit}
                        <p className={`text-xs ${rem <= 0 ? 'text-emerald-600' : 'text-slate-400'}`}>
                          {rem <= 0 ? 'Sudah dikeluarkan' : `Sisa ${rem}`}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {b.status === 'cancelled' && b.cancel_reason && (
                <p className="text-xs text-slate-500">Alasan pembatalan: {b.cancel_reason}</p>
              )}
              {b.status === 'issued' && b.closed_reason && (
                <p className="text-xs text-slate-500">Ditutup dengan sisa tidak dipenuhi: {b.closed_reason}</p>
              )}
            </Card>
          ))}
        </div>
      )}

      {formBon && (
        <BonFormModal
          bon={formBon === 'new' ? null : formBon}
          parts={parts}
          onClose={() => setFormBon(null)}
          onSaved={async (message) => {
            setFormBon(null);
            setNotice(message);
            await load();
          }}
        />
      )}
      {cancelBon && (
        <CancelBonModal
          bon={cancelBon}
          staff={staff}
          onClose={() => setCancelBon(null)}
          onDone={async (message) => {
            setCancelBon(null);
            setNotice(message);
            await load();
          }}
        />
      )}
    </div>
  );
}
