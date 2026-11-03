-- Allow administrators to correct the complete WO number while preserving a trace
-- and keeping inventory transaction references synchronized.
CREATE OR REPLACE FUNCTION public.admin_update_work_order_number(
  p_work_order_id uuid,
  p_new_wo_number text,
  p_reason text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_role text;
  v_wo public.work_orders%ROWTYPE;
  v_new_number text := btrim(COALESCE(p_new_wo_number, ''));
  v_number_year integer;
  v_number_sequence integer;
BEGIN
  SELECT role INTO v_actor_role
  FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;

  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Hanya Admin yang dapat mengubah nomor Work Order.';
  END IF;
  IF v_new_number = '' THEN
    RAISE EXCEPTION 'Nomor WO wajib diisi.';
  END IF;
  IF length(v_new_number) > 120 THEN
    RAISE EXCEPTION 'Nomor WO maksimal 120 karakter.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Alasan perubahan nomor WO wajib diisi.';
  END IF;

  SELECT * INTO v_wo
  FROM public.work_orders
  WHERE id = p_work_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Work Order tidak ditemukan.';
  END IF;
  IF v_new_number = v_wo.wo_number THEN
    RAISE EXCEPTION 'Nomor WO baru sama dengan nomor saat ini.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.work_orders WHERE wo_number = v_new_number AND id <> p_work_order_id) THEN
    RAISE EXCEPTION 'Nomor WO % sudah digunakan.', v_new_number USING ERRCODE = '23505';
  END IF;

  -- If the edited code follows the generated format, keep its yearly counter
  -- at least as high as this sequence to avoid generating a duplicate later.
  IF v_new_number ~ '^WO[0-9]{2}/[A-Za-z0-9]+/[0-9]{2}/[0-9]{1,9}$' THEN
    v_number_year := 2000 + substring(v_new_number FROM 3 FOR 2)::integer;
    v_number_sequence := split_part(v_new_number, '/', 4)::integer;
    PERFORM pg_advisory_xact_lock(hashtext('woseq:' || v_number_year::text));
    INSERT INTO public.wo_number_counters (year, last_no)
    VALUES (v_number_year, v_number_sequence)
    ON CONFLICT (year) DO UPDATE
      SET last_no = GREATEST(public.wo_number_counters.last_no, EXCLUDED.last_no);
  END IF;

  UPDATE public.work_orders SET wo_number = v_new_number WHERE id = p_work_order_id;

  UPDATE public.inventory_transactions
  SET reference = CASE WHEN reference IS NULL THEN NULL ELSE replace(reference, v_wo.wo_number, v_new_number) END,
  notes = CASE
    WHEN notes IS NULL THEN NULL
    ELSE replace(notes, v_wo.wo_number, v_new_number)
  END
  WHERE work_order_id = p_work_order_id;

  INSERT INTO public.work_order_history (work_order_id, status, action, notes, performed_by)
  VALUES (
    p_work_order_id,
    v_wo.status,
    'Nomor Work Order diubah',
    format('Nomor: %s → %s. Alasan: %s', v_wo.wo_number, v_new_number, btrim(p_reason)),
    auth.uid()
  );

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
  VALUES (
    auth.uid(),
    'update_work_order_number',
    'work_order',
    p_work_order_id,
    format('Nomor WO %s diubah menjadi %s', v_wo.wo_number, v_new_number),
    btrim(p_reason)
  );

  RETURN v_new_number;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_work_order_number(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_work_order_number(uuid, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
