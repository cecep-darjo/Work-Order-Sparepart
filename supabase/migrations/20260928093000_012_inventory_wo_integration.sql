-- Integrasi transaksi inventory dengan Work Order.
-- Menjaga konsumsi/return spare part WO tetap atomik.

CREATE OR REPLACE FUNCTION public.consume_work_order_part(
  p_work_order_id uuid,
  p_spare_part_id uuid,
  p_quantity numeric
)
RETURNS public.work_order_parts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_wo public.work_orders%ROWTYPE;
  v_part public.spare_parts%ROWTYPE;
  v_wop public.work_order_parts%ROWTYPE;
  v_before numeric;
  v_after numeric;
  v_tx_no text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','spv','teknisi','inventory') THEN
    RAISE EXCEPTION 'User tidak memiliki akses menggunakan spare part WO.';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity harus lebih besar dari 0.';
  END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work order tidak ditemukan.'; END IF;

  SELECT * INTO v_part FROM public.spare_parts WHERE id = p_spare_part_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Spare part tidak ditemukan.'; END IF;

  v_before := v_part.current_stock;
  v_after := v_before - p_quantity;
  IF v_after < 0 THEN
    RAISE EXCEPTION 'Stok tidak mencukupi. Stok tersedia: % %.', v_before, v_part.unit;
  END IF;

  v_tx_no := public.next_inventory_transaction_no('stock_out');
  PERFORM set_config('app.inventory_tx', '1', true);
  UPDATE public.spare_parts SET current_stock = v_after, updated_at = now() WHERE id = p_spare_part_id;

  INSERT INTO public.work_order_parts(work_order_id, spare_part_id, quantity)
  VALUES (p_work_order_id, p_spare_part_id, p_quantity)
  RETURNING * INTO v_wop;

  INSERT INTO public.inventory_transactions (
    spare_part_id, type, quantity, balance_after, reference, notes,
    work_order_id, created_by, transaction_no, stock_before, destination
  ) VALUES (
    p_spare_part_id, 'stock_out', p_quantity, v_after, v_wo.wo_number,
    'Used on ' || v_wo.wo_number, p_work_order_id, auth.uid(), v_tx_no,
    v_before, 'Work Order'
  );

  INSERT INTO public.activity_log(user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'wo_spare_part_out', 'work_order', p_work_order_id,
          v_tx_no || ' | ' || v_part.code || ' x' || p_quantity::text);

  RETURN v_wop;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_work_order_part(uuid,uuid,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_work_order_part(uuid,uuid,numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.return_work_order_part(p_work_order_part_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_wop public.work_order_parts%ROWTYPE;
  v_wo public.work_orders%ROWTYPE;
  v_part public.spare_parts%ROWTYPE;
  v_before numeric;
  v_after numeric;
  v_tx_no text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','spv','teknisi','inventory') THEN
    RAISE EXCEPTION 'User tidak memiliki akses mengembalikan spare part WO.';
  END IF;

  SELECT * INTO v_wop FROM public.work_order_parts WHERE id = p_work_order_part_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pemakaian spare part WO tidak ditemukan.'; END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = v_wop.work_order_id;
  SELECT * INTO v_part FROM public.spare_parts WHERE id = v_wop.spare_part_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Spare part tidak ditemukan.'; END IF;

  v_before := v_part.current_stock;
  v_after := v_before + v_wop.quantity;
  v_tx_no := public.next_inventory_transaction_no('stock_in');

  PERFORM set_config('app.inventory_tx', '1', true);
  UPDATE public.spare_parts SET current_stock = v_after, updated_at = now() WHERE id = v_part.id;

  DELETE FROM public.work_order_parts WHERE id = p_work_order_part_id;

  INSERT INTO public.inventory_transactions (
    spare_part_id, type, quantity, balance_after, reference, notes,
    work_order_id, created_by, transaction_no, stock_before, source
  ) VALUES (
    v_part.id, 'stock_in', v_wop.quantity, v_after,
    COALESCE(v_wo.wo_number, v_wop.work_order_id::text),
    'Returned from ' || COALESCE(v_wo.wo_number, 'WO') || ' (part removed)',
    v_wop.work_order_id, auth.uid(), v_tx_no, v_before, 'Work Order Return'
  );

  INSERT INTO public.activity_log(user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'wo_spare_part_return', 'work_order', v_wop.work_order_id,
          v_tx_no || ' | ' || v_part.code || ' x' || v_wop.quantity::text);
END;
$$;

REVOKE ALL ON FUNCTION public.return_work_order_part(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.return_work_order_part(uuid) TO authenticated;

-- Existing admin WO deletion must be allowed to restore stock through the protected trigger.
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
  v_before numeric;
  v_tx_no text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Hanya admin yang dapat menghapus WO.'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'Alasan penghapusan wajib diisi.'; END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work order tidak ditemukan.'; END IF;

  FOR r IN SELECT spare_part_id, sum(quantity) AS qty FROM public.work_order_parts WHERE work_order_id = p_wo_id GROUP BY spare_part_id LOOP
    SELECT current_stock INTO v_before FROM public.spare_parts WHERE id = r.spare_part_id FOR UPDATE;
    v_tx_no := public.next_inventory_transaction_no('stock_in');
    PERFORM set_config('app.inventory_tx', '1', true);
    UPDATE public.spare_parts SET current_stock = current_stock + r.qty, updated_at = now() WHERE id = r.spare_part_id RETURNING current_stock INTO v_balance;
    INSERT INTO public.inventory_transactions
      (spare_part_id, type, quantity, balance_after, reference, notes, work_order_id, created_by, transaction_no, stock_before, source)
    VALUES
      (r.spare_part_id, 'stock_in', r.qty, v_balance, v_wo.wo_number,
       'Returned from ' || v_wo.wo_number || ' (WO deleted)', p_wo_id, auth.uid(), v_tx_no, v_before, 'WO deleted');
  END LOOP;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
  VALUES (auth.uid(), 'delete_wo', 'work_order', p_wo_id, 'Deleted ' || v_wo.wo_number, btrim(p_reason));

  DELETE FROM public.work_orders WHERE id = p_wo_id;
END;
$$;
