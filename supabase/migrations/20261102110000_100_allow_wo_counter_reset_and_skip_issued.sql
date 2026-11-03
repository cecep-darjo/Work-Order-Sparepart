-- Allow admins/SS to set the configured WO sequence independently of already
-- issued numbers. Automatic numbering then walks forward and skips issued suffixes.

-- A trigger that always raises the counter to the highest issued suffix prevents
-- a deliberate reset (for example, setting the next sequence after 607).
DROP TRIGGER IF EXISTS sync_wo_number_counter_after_write ON public.work_orders;
DROP FUNCTION IF EXISTS public.sync_wo_number_counter_from_row();

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
  v_last_issued text;
BEGIN
  SELECT role INTO v_role
  FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'ss') THEN
    RAISE EXCEPTION 'Hanya Admin atau SS yang dapat melihat pengaturan penomoran WO.';
  END IF;

  SELECT COALESCE(last_no, 0) INTO v_counter
  FROM public.wo_number_counters
  WHERE year = v_year;

  SELECT wo_number INTO v_last_issued
  FROM public.work_orders
  WHERE wo_number ~ ('^WO' || v_yy || '/[A-Za-z0-9]+/[0-9]{2}/[0-9]{1,9}$')
  ORDER BY split_part(wo_number, '/', 4)::integer DESC, created_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'year', v_year,
    'last_no', COALESCE(v_counter, 0),
    'last_wo_number', v_last_issued
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_wo_last_number(p_last_no integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_year integer := extract(year FROM (now() AT TIME ZONE 'Asia/Jakarta'))::integer;
  v_result integer;
BEGIN
  SELECT role INTO v_role
  FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'ss') THEN
    RAISE EXCEPTION 'Hanya Admin atau SS yang dapat mengubah penomoran WO.';
  END IF;
  IF p_last_no IS NULL OR p_last_no < 0 THEN
    RAISE EXCEPTION 'Nomor terakhir WO harus 0 atau lebih besar.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('woseq:' || v_year::text));
  INSERT INTO public.wo_number_counters (year, last_no)
  VALUES (v_year, p_last_no)
  ON CONFLICT (year) DO UPDATE SET last_no = EXCLUDED.last_no
  RETURNING last_no INTO v_result;

  INSERT INTO public.activity_log (user_id, action, entity_type, details)
  VALUES (
    auth.uid(),
    'set_wo_last_number',
    'work_order',
    'Nomor urut terakhir WO diatur ke ' || v_result::text || ' untuk tahun ' || v_year::text
  );

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public._wo_number_at(p_department_id uuid, p_at timestamp)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
  v_year integer := extract(year FROM p_at)::integer;
  v_yy text := to_char(p_at, 'YY');
  v_seq integer;
BEGIN
  SELECT upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'))
    INTO v_code
  FROM public.departments
  WHERE id = p_department_id;

  IF v_code IS NULL OR v_code = '' THEN
    RAISE EXCEPTION 'Departemen tidak valid atau kode departemen kosong.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('woseq:' || v_year::text));
  INSERT INTO public.wo_number_counters (year, last_no)
  VALUES (v_year, 0)
  ON CONFLICT (year) DO NOTHING;

  SELECT last_no INTO v_seq
  FROM public.wo_number_counters
  WHERE year = v_year
  FOR UPDATE;

  LOOP
    IF v_seq >= 2147483647 THEN
      RAISE EXCEPTION 'Nomor urut WO tahun % sudah mencapai batas maksimum.', v_year;
    END IF;
    v_seq := v_seq + 1;

    EXIT WHEN NOT EXISTS (
      SELECT 1
      FROM public.work_orders
      WHERE wo_number ~ ('^WO' || v_yy || '/[A-Za-z0-9]+/[0-9]{2}/[0-9]{1,9}$')
        AND split_part(wo_number, '/', 4)::integer = v_seq
    );
  END LOOP;

  UPDATE public.wo_number_counters
  SET last_no = v_seq
  WHERE year = v_year;

  RETURN 'WO' || to_char(p_at, 'YY')
    || '/' || v_code
    || '/' || to_char(p_at, 'MM')
    || '/' || CASE WHEN v_seq > 99999 THEN v_seq::text ELSE lpad(v_seq::text, 5, '0') END;
END;
$$;

REVOKE ALL ON FUNCTION public.get_wo_numbering_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_wo_last_number(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._wo_number_at(uuid, timestamp) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_wo_numbering_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_wo_last_number(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.next_wo_number(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
