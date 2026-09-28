/*
# Hapus WO oleh admin (aman untuk stok)

Fungsi admin_delete_work_order(p_wo_id, p_reason) berjalan dalam satu transaksi:
1. Hanya admin; alasan wajib diisi.
2. Spare part yang sudah terpakai di WO dikembalikan ke stok, dan dicatat sebagai
   transaksi 'stock_in' (Returned from <no WO> (WO deleted)).
3. Penghapusan dicatat di Activity Log beserta alasannya (log tetap ada walau WO dihapus).
4. WO dihapus; riwayat dan daftar part WO ikut terhapus (ON DELETE CASCADE).
   Transaksi inventory lama tetap ada sebagai jejak audit (referensi berupa nomor WO).
*/

CREATE OR REPLACE FUNCTION public.admin_delete_work_order(p_wo_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo public.work_orders%ROWTYPE;
  r record;
  v_balance numeric;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Hanya admin yang dapat menghapus WO.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Alasan penghapusan wajib diisi.';
  END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Work order tidak ditemukan.';
  END IF;

  FOR r IN
    SELECT spare_part_id, sum(quantity) AS qty
    FROM public.work_order_parts
    WHERE work_order_id = p_wo_id
    GROUP BY spare_part_id
  LOOP
    UPDATE public.spare_parts
    SET current_stock = current_stock + r.qty, updated_at = now()
    WHERE id = r.spare_part_id
    RETURNING current_stock INTO v_balance;

    INSERT INTO public.inventory_transactions
      (spare_part_id, type, quantity, balance_after, reference, notes, work_order_id, created_by)
    VALUES
      (r.spare_part_id, 'stock_in', r.qty, v_balance, v_wo.wo_number,
       'Returned from ' || v_wo.wo_number || ' (WO deleted)', p_wo_id, auth.uid());
  END LOOP;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
  VALUES (auth.uid(), 'delete_wo', 'work_order', p_wo_id,
          'Deleted ' || v_wo.wo_number, btrim(p_reason));

  DELETE FROM public.work_orders WHERE id = p_wo_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_work_order(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_work_order(uuid, text) TO authenticated;
