-- A PM assignment may have a confirmed execution date or remain date-flexible
-- for its planned month. In the latter case the job deadline is month-end.
CREATE OR REPLACE FUNCTION public.pm_create_assignment(
  p_occurrence_id uuid, p_technician_ids uuid[], p_planned_date date
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role text := public.ja_role();
  v_occ public.pm_occurrences%ROWTYPE;
  v_schedule public.pm_schedules%ROWTYPE;
  v_equipment public.equipment%ROWTYPE;
  v_area public.areas%ROWTYPE;
  v_job_id uuid;
  v_tech uuid;
  v_idx integer;
  v_deadline date;
BEGIN
  IF COALESCE(v_role, '') NOT IN ('admin','ss') THEN RAISE EXCEPTION 'Hanya Admin atau SS yang dapat membuat penugasan PM.'; END IF;
  IF p_technician_ids IS NULL OR cardinality(p_technician_ids) = 0 THEN RAISE EXCEPTION 'Pilih minimal satu teknisi.'; END IF;
  SELECT * INTO v_occ FROM public.pm_occurrences WHERE id = p_occurrence_id FOR UPDATE;
  IF NOT FOUND OR v_occ.execution_status <> 'open' OR v_occ.job_assignment_id IS NOT NULL THEN RAISE EXCEPTION 'Occurrence PM sudah ditugaskan atau tidak aktif.'; END IF;
  IF p_planned_date IS NOT NULL AND (date_trunc('month', p_planned_date)::date <> v_occ.planned_month OR p_planned_date < (now() AT TIME ZONE 'Asia/Jakarta')::date) THEN
    RAISE EXCEPTION 'Tanggal assignment harus berada pada bulan target dan belum lewat.';
  END IF;
  v_deadline := COALESCE(p_planned_date, (v_occ.planned_month + interval '1 month')::date - 1);
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = v_occ.schedule_id;
  SELECT * INTO v_equipment FROM public.equipment WHERE id = v_schedule.equipment_id;
  SELECT * INTO v_area FROM public.areas WHERE id = v_equipment.area_id;
  IF EXISTS (SELECT 1 FROM unnest(p_technician_ids) requested(id) LEFT JOIN public.profiles p ON p.id = requested.id WHERE p.id IS NULL OR p.role <> 'teknisi' OR p.is_active IS DISTINCT FROM true) THEN RAISE EXCEPTION 'Teknisi tidak aktif atau tidak valid.'; END IF;
  INSERT INTO public.job_assignments (title, description, location, technician_id, deadline, priority, status, created_by, work_category, equipment_id)
  VALUES (v_schedule.title, v_schedule.description, concat_ws(' • ', v_area.name, v_equipment.name), p_technician_ids[1], (v_deadline + time '17:00') AT TIME ZONE 'Asia/Jakarta', 'normal', 'assigned', auth.uid(), 'preventive_maintenance', v_equipment.id)
  RETURNING id INTO v_job_id;
  FOR v_idx IN 2..cardinality(p_technician_ids) LOOP
    v_tech := p_technician_ids[v_idx];
    INSERT INTO public.job_assignment_technicians(job_id, technician_id) VALUES (v_job_id, v_tech) ON CONFLICT DO NOTHING;
  END LOOP;
  UPDATE public.pm_occurrences SET job_assignment_id = v_job_id, planned_execution_date = p_planned_date WHERE id = v_occ.id;
  INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
  VALUES (v_occ.id, 'assigned', jsonb_build_object('job_assignment_id', v_job_id, 'technician_ids', p_technician_ids, 'planned_date', p_planned_date, 'date_flexible', p_planned_date IS NULL), auth.uid());
  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.pm_reassign_assignment(
  p_occurrence_id uuid, p_technician_ids uuid[], p_planned_date date
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role text := public.ja_role();
  v_occ public.pm_occurrences%ROWTYPE;
  v_schedule public.pm_schedules%ROWTYPE;
  v_equipment public.equipment%ROWTYPE;
  v_area public.areas%ROWTYPE;
  v_old_ids uuid[];
  v_tech uuid;
  v_deadline date;
BEGIN
  IF COALESCE(v_role, '') NOT IN ('admin','ss') THEN RAISE EXCEPTION 'Hanya Admin atau SS yang dapat mengubah penugasan PM.'; END IF;
  IF p_technician_ids IS NULL OR cardinality(p_technician_ids) = 0 THEN RAISE EXCEPTION 'Pilih minimal satu teknisi.'; END IF;
  SELECT * INTO v_occ FROM public.pm_occurrences WHERE id = p_occurrence_id FOR UPDATE;
  IF NOT FOUND OR v_occ.execution_status <> 'open' OR v_occ.job_assignment_id IS NULL THEN RAISE EXCEPTION 'Occurrence PM belum memiliki assignment aktif.'; END IF;
  IF p_planned_date IS NOT NULL AND (date_trunc('month', p_planned_date)::date <> v_occ.planned_month OR p_planned_date < (now() AT TIME ZONE 'Asia/Jakarta')::date) THEN
    RAISE EXCEPTION 'Tanggal assignment harus berada pada bulan target dan belum lewat.';
  END IF;
  v_deadline := COALESCE(p_planned_date, (v_occ.planned_month + interval '1 month')::date - 1);
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = v_occ.schedule_id;
  SELECT * INTO v_equipment FROM public.equipment WHERE id = v_schedule.equipment_id;
  SELECT * INTO v_area FROM public.areas WHERE id = v_equipment.area_id;
  IF EXISTS (SELECT 1 FROM unnest(p_technician_ids) requested(id) LEFT JOIN public.profiles p ON p.id = requested.id WHERE p.id IS NULL OR p.role <> 'teknisi' OR p.is_active IS DISTINCT FROM true) THEN RAISE EXCEPTION 'Teknisi tidak aktif atau tidak valid.'; END IF;
  SELECT array_agg(technician_id) INTO v_old_ids FROM public.job_assignment_technicians WHERE job_id = v_occ.job_assignment_id;
  UPDATE public.job_assignments SET technician_id = p_technician_ids[1], deadline = (v_deadline + time '17:00') AT TIME ZONE 'Asia/Jakarta', equipment_id = v_equipment.id, work_category = 'preventive_maintenance' WHERE id = v_occ.job_assignment_id;
  FOREACH v_tech IN ARRAY p_technician_ids LOOP
    INSERT INTO public.job_assignment_technicians(job_id, technician_id) VALUES (v_occ.job_assignment_id, v_tech) ON CONFLICT DO NOTHING;
  END LOOP;
  FOREACH v_tech IN ARRAY COALESCE(v_old_ids, ARRAY[]::uuid[]) LOOP
    IF NOT v_tech = ANY(p_technician_ids) AND v_tech <> p_technician_ids[1] THEN DELETE FROM public.job_assignment_technicians WHERE job_id = v_occ.job_assignment_id AND technician_id = v_tech; END IF;
  END LOOP;
  UPDATE public.pm_occurrences SET planned_execution_date = p_planned_date WHERE id = v_occ.id;
  INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
  VALUES (v_occ.id, 'reassigned', jsonb_build_object('old_technician_ids', v_old_ids, 'technician_ids', p_technician_ids, 'planned_date', p_planned_date, 'date_flexible', p_planned_date IS NULL), auth.uid());
  RETURN v_occ.job_assignment_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pm_create_assignment(uuid, uuid[], date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pm_reassign_assignment(uuid, uuid[], date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_create_assignment(uuid, uuid[], date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pm_reassign_assignment(uuid, uuid[], date) TO authenticated;

-- When an unfinished PM is carried into the next month, extend its JA deadline
-- to that month's end so technicians can still complete it during the carry-over.
CREATE OR REPLACE FUNCTION public.pm_sync_assignment_deadline_on_carryover()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.planned_month IS DISTINCT FROM OLD.planned_month AND NEW.job_assignment_id IS NOT NULL
     AND NEW.execution_status = 'open' AND NEW.planned_execution_date IS NULL THEN
    UPDATE public.job_assignments
    SET deadline = (((NEW.planned_month + interval '1 month')::date - 1) + time '17:00') AT TIME ZONE 'Asia/Jakarta'
    WHERE id = NEW.job_assignment_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.pm_sync_assignment_deadline_on_carryover() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS pm_sync_assignment_deadline_on_carryover ON public.pm_occurrences;
CREATE TRIGGER pm_sync_assignment_deadline_on_carryover
  AFTER UPDATE OF planned_month ON public.pm_occurrences
  FOR EACH ROW EXECUTE FUNCTION public.pm_sync_assignment_deadline_on_carryover();

NOTIFY pgrst, 'reload schema';
