/*
# Tanda tangan digital

Kebutuhan:
1) Setiap user mendaftarkan tanda tangannya sendiri lewat signature pad (disimpan sebagai PNG).
2) Tanda tangan dibubuhkan otomatis di PDF "Lembar Pengeluaran Barang" sesuai user pada dokumen.

Keamanan:
- Tabel user_signatures hanya bisa dibaca/ditulis/dihapus pemiliknya (RLS). Reset tanda tangan
  user lain (mis. user keluar) dilakukan admin database lewat SQL Editor Supabase.
- Untuk mencetak dokumen, get_slip_signatures() mengembalikan tanda tangan hanya bila:
    a) milik pemanggil sendiri, atau
    b) pemanggil berperan admin / ss / inventory, atau
    c) pemilik tanda tangan berperan admin / inventory (petugas spare part yang menandatangani lembar).
  Maksimal 4 user per panggilan agar tidak bisa dipakai mengunduh massal.

Aman dijalankan ulang.
*/

CREATE TABLE IF NOT EXISTS public.user_signatures (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  signature_png text NOT NULL
    CHECK (signature_png LIKE 'data:image/png;base64,%' AND length(signature_png) <= 300000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_signatures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_signatures FROM anon;

DROP POLICY IF EXISTS "own_signature_select" ON public.user_signatures;
CREATE POLICY "own_signature_select" ON public.user_signatures
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "own_signature_insert" ON public.user_signatures;
CREATE POLICY "own_signature_insert" ON public.user_signatures
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "own_signature_update" ON public.user_signatures;
CREATE POLICY "own_signature_update" ON public.user_signatures
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "own_signature_delete" ON public.user_signatures;
CREATE POLICY "own_signature_delete" ON public.user_signatures
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Ambil tanda tangan untuk dicetak di dokumen (lihat aturan akses di atas).
CREATE OR REPLACE FUNCTION public.get_slip_signatures(p_user_ids uuid[])
RETURNS TABLE (user_id uuid, signature_png text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Tidak berwenang.';
  END IF;

  IF p_user_ids IS NULL OR array_length(p_user_ids, 1) IS NULL THEN
    RETURN;
  END IF;
  IF array_length(p_user_ids, 1) > 4 THEN
    RAISE EXCEPTION 'Maksimal 4 user per permintaan.';
  END IF;

  RETURN QUERY
  SELECT s.user_id, s.signature_png
  FROM public.user_signatures s
  JOIN public.profiles p ON p.id = s.user_id
  WHERE s.user_id = ANY (p_user_ids)
    AND (
      s.user_id = auth.uid()
      OR v_role IN ('admin', 'ss', 'inventory')
      OR p.role IN ('admin', 'inventory')
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_slip_signatures(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_slip_signatures(uuid[]) TO authenticated;
