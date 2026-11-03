-- Admin-only hard delete actions for Work Orders and Jobs Assignment.
-- Work Order spare-part usage is returned to stock before the record is removed.

DROP POLICY IF EXISTS "delete_work_orders" ON public.work_orders;
CREATE POLICY "delete_work_orders" ON public.work_orders FOR DELETE TO authenticated
  USING (public.is_admin());

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
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Hanya admin yang dapat menghapus Work Order.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Alasan penghapusan wajib dicatat.';
  END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work Order tidak ditemukan.'; END IF;

  FOR r IN
    SELECT spare_part_id, sum(quantity) AS qty
    FROM public.work_order_parts
    WHERE work_order_id = p_wo_id
    GROUP BY spare_part_id
  LOOP
    SELECT current_stock INTO v_before FROM public.spare_parts WHERE id = r.spare_part_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Spare part untuk Work Order tidak ditemukan.'; END IF;
    v_tx_no := public.next_inventory_transaction_no('stock_in');
    PERFORM set_config('app.inventory_tx', '1', true);
    UPDATE public.spare_parts
       SET current_stock = current_stock + r.qty, updated_at = now()
     WHERE id = r.spare_part_id
     RETURNING current_stock INTO v_balance;
    INSERT INTO public.inventory_transactions
      (spare_part_id, type, quantity, balance_after, reference, notes, work_order_id,
       created_by, transaction_no, stock_before, source)
    VALUES
      (r.spare_part_id, 'stock_in', r.qty, v_balance, v_wo.wo_number,
       'Returned from ' || v_wo.wo_number || ' (Work Order deleted)', p_wo_id,
       auth.uid(), v_tx_no, v_before, 'Work Order deleted');
  END LOOP;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
  VALUES (auth.uid(), 'delete_wo', 'work_order', p_wo_id,
          'Deleted Work Order ' || v_wo.wo_number, btrim(p_reason));

  DELETE FROM public.work_orders WHERE id = p_wo_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_delete_work_order(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_work_order(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_delete_job_assignment(p_job_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.job_assignments%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Hanya admin yang dapat menghapus Jobs Assignment.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Alasan penghapusan wajib dicatat.';
  END IF;

  SELECT * INTO v_job FROM public.job_assignments WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Jobs Assignment tidak ditemukan.'; END IF;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
  VALUES (auth.uid(), 'delete_job_assignment', 'job_assignment', p_job_id,
          'Deleted Jobs Assignment ' || COALESCE(v_job.job_no, v_job.title), btrim(p_reason));

  -- WO terkait tetap disimpan; FK akan melepas tautannya secara otomatis.
  DELETE FROM public.job_assignments WHERE id = p_job_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_delete_job_assignment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_job_assignment(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
