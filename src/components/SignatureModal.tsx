import { useEffect, useRef, useState } from 'react';
import { Eraser, PenLine, Trash2, Undo2 } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { Button, Modal, Spinner } from '@/components/ui';
import SignaturePad, { type SignaturePadHandle } from '@/components/SignaturePad';
import { deleteMySignature, fetchMySignature, saveMySignature } from '@/lib/signatures';

const errMsg = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return /user_signatures|schema cache|does not exist/i.test(m)
    ? 'Fitur tanda tangan belum aktif di database. Jalankan migration 031_user_signatures.sql terlebih dulu.'
    : m;
};

/** Daftarkan / ganti / hapus tanda tangan milik user yang sedang login. */
export default function SignatureModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { profile } = useAuth();
  const userId = profile?.id;
  const padRef = useRef<SignaturePadHandle>(null);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [valid, setValid] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !userId) return;
    let alive = true;
    setLoading(true);
    setError('');
    setValid(false);
    setHasInk(false);
    fetchMySignature(userId)
      .then((s) => {
        if (!alive) return;
        setSaved(s);
        setEditing(!s);
      })
      .catch((e) => {
        if (!alive) return;
        setError(errMsg(e));
        setEditing(true);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, userId]);

  async function handleSave() {
    if (!userId) return;
    const png = padRef.current?.toPng();
    if (!png) {
      setError('Goresan terlalu pendek. Tanda tangan sekali lagi dengan lebih jelas.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await saveMySignature(userId, png);
      setSaved(png);
      setEditing(false);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!userId || !confirm('Hapus tanda tangan Anda? Dokumen berikutnya akan dicetak tanpa gambar tanda tangan.')) return;
    setBusy(true);
    setError('');
    try {
      await deleteMySignature(userId);
      setSaved(null);
      setEditing(true);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Tanda Tangan Digital" maxWidth="max-w-xl">
      {loading ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Tanda tangan ini dibubuhkan otomatis atas nama Anda pada <strong>Lembar Pengeluaran Barang</strong> yang memuat
            nama Anda. Hanya Anda yang dapat mengubah atau menghapusnya.
          </p>

          {editing ? (
            <>
              <SignaturePad
                ref={padRef}
                onChange={({ valid: v, hasInk: h }) => {
                  setValid(v);
                  setHasInk(h);
                  if (v) setError('');
                }}
              />
              <p className="text-xs text-slate-400">
                Tanda tangani di kotak dengan mouse, jari, atau pena layar. Gunakan landscape bila di HP.
              </p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => padRef.current?.undo()} disabled={!hasInk || busy}>
                    <Undo2 className="w-4 h-4" /> Urungkan
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => padRef.current?.clear()} disabled={!hasInk || busy}>
                    <Eraser className="w-4 h-4" /> Hapus coretan
                  </Button>
                </div>
                <div className="flex gap-2">
                  {saved && (
                    <Button variant="secondary" onClick={() => { setEditing(false); setError(''); }} disabled={busy}>
                      Batal
                    </Button>
                  )}
                  <Button onClick={handleSave} disabled={!valid || busy}>
                    <PenLine className="w-4 h-4" /> {busy ? 'Menyimpan...' : 'Simpan Tanda Tangan'}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-lg border border-slate-200 bg-white p-4 flex items-center justify-center min-h-[9rem]">
                {saved && <img src={saved} alt="Tanda tangan Anda" className="max-h-32 max-w-full object-contain" />}
              </div>
              <div className="flex justify-between gap-2">
                <Button variant="danger" onClick={handleDelete} disabled={busy}>
                  <Trash2 className="w-4 h-4" /> Hapus
                </Button>
                <Button onClick={() => { setEditing(true); setValid(false); setHasInk(false); }} disabled={busy}>
                  <PenLine className="w-4 h-4" /> Ganti Tanda Tangan
                </Button>
              </div>
            </>
          )}

          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
