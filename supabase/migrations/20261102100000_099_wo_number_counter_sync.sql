-- Keep the yearly WO counter aligned with issued numbers. This covers edits and
-- direct inserts, and makes automatic numbering skip every suffix already issued
-- for the same year even when the counter was previously behind.

CREATE OR REPLACE FUNCTION public.sync_wo_number_counter_from_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year integer;
  v_suffix integer;
BEGIN
  IF NEW.wo_number !~ '^WO[0-9]{2}/[A-Za-z0-9]+/[0-9]{2}/[0-9]{1,9}$' THEN
    RETURN NEW;
  END IF;

  v_year := 2000 + substring(NEW.wo_number FROM 3 FOR 2)::integer;
  v_suffix := split_part(NEW.wo_number, '/', 4)::integer;

  PERFORM pg_advisory_xact_lock(hashtext('woseq:' || v_year::text));
  INSERT INTO public.wo_number_counters (year, last_no)
  VALUES (v_year, v_suffix)
  ON CONFLICT (year) DO UPDATE
    SET last_no = GREATEST(public.wo_number_counters.last_no, EXCLUDED.last_no);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_wo_number_counter_after_write ON public.work_orders;
CREATE TRIGGER sync_wo_number_counter_after_write
AFTER INSERT OR UPDATE OF wo_number ON public.work_orders
FOR EACH ROW
EXECUTE FUNCTION public.sync_wo_number_counter_from_row();

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
  v_issued_max integer := 0;
  v_seq integer;
BEGIN
  SELECT upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'))
    INTO v_code
  FROM public.departments
  WHERE id = p_department_id;

  IF v_code IS NULL OR v_code = '' THEN
    RAISE EXCEPTION 'Departemen tidak valid atau kode departemen kosong.';
  END IF;

  -- Serialize automatic allocation with number edits and other allocations.
  PERFORM pg_advisory_xact_lock(hashtext('woseq:' || v_year::text));

  SELECT COALESCE(max(split_part(wo_number, '/', 4)::integer), 0)
    INTO v_issued_max
  FROM public.work_orders
  WHERE wo_number ~ ('^WO' || v_yy || '/[A-Za-z0-9]+/[0-9]{2}/[0-9]{1,9}$');

  -- Bring a stale counter forward past every number already issued this year.
  INSERT INTO public.wo_number_counters (year, last_no)
  VALUES (v_year, v_issued_max)
  ON CONFLICT (year) DO UPDATE
    SET last_no = GREATEST(public.wo_number_counters.last_no, EXCLUDED.last_no);

  -- Allocate the next suffix atomically. Starting above the issued maximum means
  -- no already-issued number can be handed out again after a manual edit.
  INSERT INTO public.wo_number_counters (year, last_no)
  VALUES (v_year, 1)
  ON CONFLICT (year) DO UPDATE
    SET last_no = public.wo_number_counters.last_no + 1
  RETURNING last_no INTO v_seq;

  RETURN 'WO' || to_char(p_at, 'YY')
    || '/' || v_code
    || '/' || to_char(p_at, 'MM')
    || '/' || CASE WHEN v_seq > 99999 THEN v_seq::text ELSE lpad(v_seq::text, 5, '0') END;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_wo_number_counter_from_row() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wo_number_at(uuid, timestamp) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_wo_number(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
