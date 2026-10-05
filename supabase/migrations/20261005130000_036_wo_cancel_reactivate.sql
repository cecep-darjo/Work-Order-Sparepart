/*
# Cancel WO (pengganti hapus) + reaktivasi

Kebutuhan:
  Aksi "hapus WO" diubah menjadi "cancel". WO yang di-cancel TIDAK hilang,
  hanya tidak perlu diproses lebih lanjut (status = 'canceled'). Admin dapat
  mengaktifkan kembali WO yang di-cancel (reaktivasi -> status 'new').
  Alasan cancel & reaktivasi disimpan dan dicatat di Activity Log.

Perubahan:
  1) Tambah kolom `work_orders.cancel_reason text` (alasan cancel WO).
  2) Tambah nilai 'canceled' pada CHECK constraint status (idempotent, urut
     sebelum migrasi data apa pun agar nilai baru diizinkan).
  3) RPC `admin_cancel_work_order(p_wo_id, p_reason)`:
     - hanya admin; alasan wajib.
     - set status='canceled' + cancel_reason (data & stok TIDAK disentuh).
     - catat activity log 'cancel_wo'.
  4) RPC `admin_reactivate_work_order(p_wo_id, p_reason)`:
     - hanya admin; alasan wajib.
     - set status='new', bersihkan cancel_reason, beri cancel_reason null.
     - catat activity log 'reactivate_wo'.
  5) Hapus fungsi lama `admin_delete_work_order` (tidak dipakai lagi).

Aman dijalankan ulang.
*/

-- 1) Kolom alasan cancel.
ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS cancel_reason text;

-- 2) Perluas daftar status yang diizinkan dengan 'canceled'.
ALTER TABLE public.work_orders
  DROP CONSTRAINT IF EXISTS work_orders_status_check;

ALTER TABLE public.work_orders
  ADD CONSTRAINT work_orders_status_check
  CHECK (status IN ('new','assigned','analysis','on_progress','pending','done','verified','closed','canceled'));

-- 3) RPC cancel.
CREATE OR REPLACE FUNCTION public.admin_cancel_work_order(p_wo_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo public.work_orders%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Hanya admin yang dapat membatalkan (cancel) WO.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Alasan pembatalan wajib diisi.';
  END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Work order tidak ditemukan.';
  END IF;

  IF v_wo.status = 'canceled' THEN
    RAISE EXCEPTION 'Work order sudah berstatus canceled.';
  END IF;

  UPDATE public.work_orders
     SET status = 'canceled',
         cancel_reason = btrim(p_reason),
         updated_at = now()
   WHERE id = p_wo_id;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
  VALUES (auth.uid(), 'cancel_wo', 'work_order', p_wo_id,
          'Canceled ' || v_wo.wo_number, btrim(p_reason));
END;
$$;

REVOKE ALL ON FUNCTION public.admin_cancel_work_order(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_cancel_work_order(uuid, text) TO authenticated;

-- 4) RPC reactivate.
CREATE OR REPLACE FUNCTION public.admin_reactivate_work_order(p_wo_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo public.work_orders%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengaktifkan kembali WO.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Alasan reaktivasi wajib diisi.';
  END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Work order tidak ditemukan.';
  END IF;

  IF v_wo.status <> 'canceled' THEN
    RAISE EXCEPTION 'Hanya WO berstatus canceled yang dapat diaktifkan kembali.';
  END IF;

  UPDATE public.work_orders
     SET status = 'new',
         cancel_reason = NULL,
         pending_reason = NULL,
         updated_at = now()
   WHERE id = p_wo_id;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
  VALUES (auth.uid(), 'reactivate_wo', 'work_order', p_wo_id,
          'Reactivated ' || v_wo.wo_number, btrim(p_reason));
END;
$$;

REVOKE ALL ON FUNCTION public.admin_reactivate_work_order(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reactivate_work_order(uuid, text) TO authenticated;

-- 5) Hapus fungsi delete lama (digantikan cancel).
DROP FUNCTION IF EXISTS public.admin_delete_work_order(uuid, text);