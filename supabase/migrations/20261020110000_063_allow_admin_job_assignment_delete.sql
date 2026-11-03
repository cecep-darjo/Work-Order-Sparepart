-- Permit child technician rows to cascade only while the admin delete RPC
-- removes their parent Jobs Assignment. Normal technician removal rules remain.
CREATE OR REPLACE FUNCTION public.ja_guard_team_member_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_primary uuid;
BEGIN
  IF current_setting('app.delete_job_assignment', true) = '1' THEN
    RETURN OLD;
  END IF;

  SELECT technician_id INTO v_primary
  FROM public.job_assignments
  WHERE id = OLD.job_id;

  IF v_primary IS NOT NULL AND OLD.technician_id = v_primary THEN
    RAISE EXCEPTION 'Ubah teknisi utama terlebih dahulu sebelum melepas teknisi ini.';
  END IF;
  RETURN OLD;
END;
$$;

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

  -- Transaction-local flag lets the technician membership rows cascade safely.
  PERFORM set_config('app.delete_job_assignment', '1', true);
  DELETE FROM public.job_assignments WHERE id = p_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_job_assignment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_job_assignment(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
