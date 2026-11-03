-- Admin/SS can inspect and advance the WO sequence for the current Jakarta year.
-- Existing saved numbers and reservations are preserved; the setting cannot move backwards.

CREATE OR REPLACE FUNCTION public.get_wo_numbering_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_year integer := extract(year FROM (now() AT TIME ZONE 'Asia/Jakarta'))::integer;
  v_yy text := to_char(now() AT TIME ZONE 'Asia/Jakarta', 'YY');
  v_counter integer := 0;
  v_saved_no integer := 0;
  v_last_wo text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'ss') THEN
    RAISE EXCEPTION 'Hanya Admin atau SS yang dapat melihat pengaturan penomoran WO.';
  END IF;

  SELECT COALESCE(last_no, 0) INTO v_counter
  FROM public.wo_number_counters WHERE year = v_year;

  SELECT COALESCE(max(split_part(wo_number, '/', 4)::integer), 0),
         (array_agg(wo_number ORDER BY split_part(wo_number, '/', 4)::integer DESC))[1]
    INTO v_saved_no, v_last_wo
  FROM public.work_orders
  WHERE wo_number ~ ('^WO' || v_yy || '/[A-Za-z0-9]+/[0-9]{2}/[0-9]+$');

  RETURN jsonb_build_object(
    'year', v_year,
    'last_no', GREATEST(COALESCE(v_counter, 0), COALESCE(v_saved_no, 0)),
    'last_wo_number', v_last_wo
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_wo_numbering_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_wo_numbering_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.set_wo_last_number(p_last_no integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_year integer := extract(year FROM (now() AT TIME ZONE 'Asia/Jakarta'))::integer;
  v_yy text := to_char(now() AT TIME ZONE 'Asia/Jakarta', 'YY');
  v_saved_no integer := 0;
  v_result integer;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'ss') THEN
    RAISE EXCEPTION 'Hanya Admin atau SS yang dapat mengubah penomoran WO.';
  END IF;
  IF p_last_no IS NULL OR p_last_no < 0 THEN
    RAISE EXCEPTION 'Nomor terakhir WO harus 0 atau lebih besar.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('woseq:' || v_year::text));

  SELECT COALESCE(max(split_part(wo_number, '/', 4)::integer), 0)
    INTO v_saved_no
  FROM public.work_orders
  WHERE wo_number ~ ('^WO' || v_yy || '/[A-Za-z0-9]+/[0-9]{2}/[0-9]+$');

  INSERT INTO public.wo_number_counters (year, last_no)
  VALUES (v_year, GREATEST(p_last_no, v_saved_no))
  ON CONFLICT (year) DO UPDATE
    SET last_no = GREATEST(public.wo_number_counters.last_no, EXCLUDED.last_no)
  RETURNING last_no INTO v_result;

  INSERT INTO public.activity_log (user_id, action, entity_type, details)
  VALUES (auth.uid(), 'set_wo_last_number', 'work_order', 'Nomor urut terakhir WO diatur ke ' || v_result::text || ' untuk tahun ' || v_year::text);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.set_wo_last_number(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_wo_last_number(integer) TO authenticated;
