import { supabase } from '@/lib/supabase';

const PNG_PREFIX = 'data:image/png;base64,';

const isPngDataUrl = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PNG_PREFIX);

/** Tanda tangan milik sendiri (PNG data URL), atau null bila belum didaftarkan. */
export async function fetchMySignature(userId: string): Promise<string | null> {
  const { data, error } = await supabase.from('user_signatures').select('signature_png').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  const png = (data as { signature_png: string } | null)?.signature_png;
  return isPngDataUrl(png) ? png : null;
}

export async function saveMySignature(userId: string, pngDataUrl: string): Promise<void> {
  if (!isPngDataUrl(pngDataUrl)) throw new Error('Format tanda tangan tidak valid.');
  const { error } = await supabase
    .from('user_signatures')
    .upsert({ user_id: userId, signature_png: pngDataUrl, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
}

export async function deleteMySignature(userId: string): Promise<void> {
  const { error } = await supabase.from('user_signatures').delete().eq('user_id', userId);
  if (error) throw new Error(error.message);
}

/**
 * Tanda tangan para penanda tangan sebuah dokumen, dikunci per user id (lihat aturan akses di
 * migration 031). Tidak pernah melempar error: bila gagal (mis. migration belum dijalankan),
 * dokumen tetap dicetak tanpa gambar tanda tangan.
 */
export async function fetchSlipSignatures(userIds: (string | null | undefined)[]): Promise<Record<string, string>> {
  const ids = [...new Set(userIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return {};
  try {
    const { data, error } = await supabase.rpc('get_slip_signatures', { p_user_ids: ids });
    if (error) throw new Error(error.message);
    const out: Record<string, string> = {};
    for (const row of (data as { user_id: string; signature_png: string }[] | null) ?? []) {
      if (isPngDataUrl(row.signature_png)) out[row.user_id] = row.signature_png;
    }
    return out;
  } catch (e) {
    console.warn('Tanda tangan tidak dapat dimuat, dokumen dicetak tanpa gambar tanda tangan:', e);
    return {};
  }
}
