-- Give PM executions their own assignment workflow and data model. Legacy PM
-- Jobs Assignments are copied for continuity; new PM assignments never create JA.

CREATE SEQUENCE IF NOT EXISTS public.pm_assignment_no_seq;

CREATE TABLE IF NOT EXISTS public.pm_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_no text NOT NULL UNIQUE,
  occurrence_id uuid NOT NULL UNIQUE REFERENCES public.pm_occurrences(id) ON DELETE RESTRICT,
  title text NOT NULL,
  description text,
  location text NOT NULL,
  equipment_id uuid NOT NULL REFERENCES public.equipment(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  technician_id uuid NOT NULL REFERENCES public.profiles(id),
  planned_date date,
  deadline timestamptz NOT NULL,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','on_the_way','in_progress','pending','done','approved','canceled')),
  pending_reason text,
  on_the_way_at timestamptz,
  started_at timestamptz,
  done_at timestamptz,
  report_notes text,
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pm_assignments_status_deadline ON public.pm_assignments(status, deadline);
CREATE INDEX IF NOT EXISTS idx_pm_assignments_equipment ON public.pm_assignments(equipment_id);

CREATE TABLE IF NOT EXISTS public.pm_assignment_technicians (
  assignment_id uuid NOT NULL REFERENCES public.pm_assignments(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, technician_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_assignment_technicians_user ON public.pm_assignment_technicians(technician_id, assignment_id);

CREATE TABLE IF NOT EXISTS public.pm_assignment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES public.pm_assignments(id) ON DELETE CASCADE,
  status text NOT NULL,
  action text NOT NULL,
  notes text,
  performed_by uuid REFERENCES public.profiles(id),
  performed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pm_assignment_history_assignment ON public.pm_assignment_history(assignment_id, performed_at);

ALTER TABLE public.pm_occurrences
  ADD COLUMN IF NOT EXISTS pm_assignment_id uuid UNIQUE REFERENCES public.pm_assignments(id) ON DELETE SET NULL;

-- Preserve existing PM work, while moving it into the dedicated PM assignment model.
INSERT INTO public.pm_assignments (
  id, assignment_no, occurrence_id, title, description, location, equipment_id,
  created_by, technician_id, planned_date, deadline, priority, status, pending_reason,
  on_the_way_at, started_at, done_at, report_notes, reviewed_by, reviewed_at, review_note,
  created_at, updated_at
)
SELECT j.id,
       'PMA-' || to_char(j.created_at AT TIME ZONE 'Asia/Jakarta', 'YYMMDD') || '-' || lpad(nextval('public.pm_assignment_no_seq')::text, 5, '0'),
       o.id, j.title, j.description, j.location, j.equipment_id, j.created_by, j.technician_id,
       o.planned_execution_date, j.deadline, j.priority, j.status, j.pending_reason,
       j.on_the_way_at, j.started_at, j.done_at, j.report_notes, j.reviewed_by, j.reviewed_at, j.review_note,
       j.created_at, j.updated_at
FROM public.pm_occurrences o
JOIN public.job_assignments j ON j.id = o.job_assignment_id
WHERE o.pm_assignment_id IS NULL
ON CONFLICT (occurrence_id) DO NOTHING;

INSERT INTO public.pm_assignment_technicians(assignment_id, technician_id)
SELECT pm.id, team.technician_id
FROM public.pm_assignments pm
JOIN public.pm_occurrences o ON o.id = pm.occurrence_id
JOIN public.job_assignment_technicians team ON team.job_id = o.job_assignment_id
ON CONFLICT DO NOTHING;

INSERT INTO public.pm_assignment_technicians(assignment_id, technician_id)
SELECT id, technician_id FROM public.pm_assignments
ON CONFLICT DO NOTHING;

UPDATE public.pm_occurrences o
SET pm_assignment_id = pm.id
FROM public.pm_assignments pm
WHERE pm.occurrence_id = o.id AND o.pm_assignment_id IS NULL;

INSERT INTO public.pm_assignment_history(assignment_id, status, action, notes, performed_by, performed_at)
SELECT pm.id, pm.status, 'PM assignment imported from legacy JA', 'Riwayat PM dipindahkan dari Jobs Assignment lama ' || j.job_no, j.created_by, j.created_at
FROM public.pm_assignments pm
JOIN public.pm_occurrences o ON o.id = pm.occurrence_id
JOIN public.job_assignments j ON j.id = o.job_assignment_id
WHERE NOT EXISTS (SELECT 1 FROM public.pm_assignment_history h WHERE h.assignment_id = pm.id);

ALTER TABLE public.pm_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_assignment_technicians ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_assignment_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pm_assignments, public.pm_assignment_technicians, public.pm_assignment_history FROM anon, authenticated;
GRANT SELECT ON public.pm_assignments, public.pm_assignment_technicians, public.pm_assignment_history TO authenticated;

CREATE POLICY pm_assignments_read ON public.pm_assignments FOR SELECT TO authenticated USING (
  public.ja_role() = 'admin'
  OR (public.ja_role() IN ('ss','spv') AND EXISTS (
    SELECT 1 FROM public.pm_occurrences o JOIN public.pm_schedules s ON s.id = o.schedule_id
    WHERE o.id = pm_assignments.occurrence_id AND (
      public.ja_role() = 'ss' OR public.pm_profile_has_department(auth.uid(), s.department_id)
    )
  ))
  OR EXISTS (SELECT 1 FROM public.pm_assignment_technicians t WHERE t.assignment_id = pm_assignments.id AND t.technician_id = auth.uid())
);

CREATE POLICY pm_assignment_technicians_read ON public.pm_assignment_technicians FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss')
  OR EXISTS (
    SELECT 1 FROM public.pm_assignments a
    JOIN public.pm_occurrences o ON o.id = a.occurrence_id
    JOIN public.pm_schedules s ON s.id = o.schedule_id
    WHERE a.id = pm_assignment_technicians.assignment_id
      AND ((public.ja_role() = 'spv' AND public.pm_profile_has_department(auth.uid(), s.department_id))
        OR public.pm_user_has_occurrence_assignment(o.id))
  )
);

CREATE POLICY pm_assignment_history_read ON public.pm_assignment_history FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.pm_assignments a WHERE a.id = pm_assignment_history.assignment_id)
);

-- Technicians can now read PM schedule/occurrence data through the dedicated assignment.
CREATE OR REPLACE FUNCTION public.pm_user_has_schedule_assignment(p_schedule_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.pm_occurrences o
    JOIN public.pm_assignments a ON a.id = o.pm_assignment_id
    JOIN public.pm_assignment_technicians t ON t.assignment_id = a.id
    WHERE o.schedule_id = p_schedule_id AND t.technician_id = auth.uid()
  );
$$;
CREATE OR REPLACE FUNCTION public.pm_user_has_occurrence_assignment(p_occurrence_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.pm_occurrences o
    JOIN public.pm_assignments a ON a.id = o.pm_assignment_id
    JOIN public.pm_assignment_technicians t ON t.assignment_id = a.id
    WHERE o.id = p_occurrence_id AND t.technician_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.pm_create_pm_assignment(
  p_occurrence_id uuid, p_technician_ids uuid[], p_planned_date date, p_priority text DEFAULT 'normal'
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role text := public.ja_role();
  v_occ public.pm_occurrences%ROWTYPE;
  v_schedule public.pm_schedules%ROWTYPE;
  v_equipment public.equipment%ROWTYPE;
  v_area public.areas%ROWTYPE;
  v_assignment_id uuid;
  v_assignment_no text;
  v_deadline date;
  v_technician uuid;
BEGIN
  IF COALESCE(v_role, '') NOT IN ('admin','ss','spv') THEN RAISE EXCEPTION 'Hanya Admin, SS, atau SPV yang dapat membuat penugasan PM.'; END IF;
  IF p_technician_ids IS NULL OR cardinality(p_technician_ids) = 0 THEN RAISE EXCEPTION 'Pilih minimal satu teknisi.'; END IF;
  IF p_priority NOT IN ('low','normal','high','urgent') THEN RAISE EXCEPTION 'Prioritas tidak valid.'; END IF;
  SELECT * INTO v_occ FROM public.pm_occurrences WHERE id = p_occurrence_id FOR UPDATE;
  IF NOT FOUND OR v_occ.execution_status <> 'open' OR v_occ.pm_assignment_id IS NOT NULL OR v_occ.job_assignment_id IS NOT NULL THEN
    RAISE EXCEPTION 'Occurrence PM sudah ditugaskan atau tidak aktif.';
  END IF;
  IF p_planned_date IS NOT NULL AND (date_trunc('month', p_planned_date)::date <> v_occ.planned_month OR p_planned_date < (now() AT TIME ZONE 'Asia/Jakarta')::date) THEN
    RAISE EXCEPTION 'Tanggal assignment harus berada pada bulan target dan belum lewat.';
  END IF;
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = v_occ.schedule_id;
  IF v_role = 'spv' AND (v_schedule.department_id IS NULL OR NOT public.pm_profile_has_department(auth.uid(), v_schedule.department_id)) THEN
    RAISE EXCEPTION 'Departemen PM berada di luar cakupan Anda.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.department_pm_settings s WHERE s.department_id = v_schedule.department_id AND s.pm_enabled)
     OR NOT EXISTS (SELECT 1 FROM public.department_equipment_scope s WHERE s.department_id = v_schedule.department_id AND s.equipment_id = v_schedule.equipment_id) THEN
    RAISE EXCEPTION 'Jadwal PM tidak berada pada cakupan aktif departemen.';
  END IF;
  SELECT * INTO v_equipment FROM public.equipment WHERE id = v_schedule.equipment_id;
  SELECT * INTO v_area FROM public.areas WHERE id = v_equipment.area_id;
  IF EXISTS (
    SELECT 1 FROM unnest(p_technician_ids) requested(id)
    LEFT JOIN public.profiles p ON p.id = requested.id
    WHERE p.id IS NULL OR p.role <> 'teknisi' OR p.is_active IS DISTINCT FROM true
      OR NOT public.pm_profile_has_department(p.id, v_schedule.department_id)
  ) THEN RAISE EXCEPTION 'Teknisi harus aktif dan terdaftar pada departemen PM.'; END IF;

  v_deadline := COALESCE(p_planned_date, (v_occ.planned_month + interval '1 month')::date - 1);
  v_assignment_no := 'PMA-' || to_char(now() AT TIME ZONE 'Asia/Jakarta', 'YYMMDD') || '-' || lpad(nextval('public.pm_assignment_no_seq')::text, 5, '0');
  INSERT INTO public.pm_assignments(
    assignment_no, occurrence_id, title, description, location, equipment_id,
    created_by, technician_id, planned_date, deadline, priority
  ) VALUES (
    v_assignment_no, v_occ.id, v_schedule.title, v_schedule.description,
    concat_ws(' • ', v_area.name, v_equipment.name), v_equipment.id,
    auth.uid(), p_technician_ids[1], p_planned_date,
    (v_deadline + time '17:00') AT TIME ZONE 'Asia/Jakarta', p_priority
  ) RETURNING id INTO v_assignment_id;

  FOREACH v_technician IN ARRAY p_technician_ids LOOP
    INSERT INTO public.pm_assignment_technicians(assignment_id, technician_id) VALUES (v_assignment_id, v_technician);
  END LOOP;
  UPDATE public.pm_occurrences SET pm_assignment_id = v_assignment_id, planned_execution_date = p_planned_date WHERE id = v_occ.id;
  INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
  VALUES (v_occ.id, 'pm_assigned', jsonb_build_object('pm_assignment_id', v_assignment_id, 'assignment_no', v_assignment_no, 'technician_ids', p_technician_ids, 'planned_date', p_planned_date), auth.uid());
  INSERT INTO public.pm_assignment_history(assignment_id, status, action, notes, performed_by)
  VALUES (v_assignment_id, 'assigned', 'Penugasan PM dibuat', 'Ditugaskan oleh ' || coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''), auth.uid());
  RETURN v_assignment_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.pm_reassign_pm_assignment(
  p_occurrence_id uuid, p_technician_ids uuid[], p_planned_date date, p_priority text DEFAULT 'normal'
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role text := public.ja_role();
  v_occ public.pm_occurrences%ROWTYPE;
  v_schedule public.pm_schedules%ROWTYPE;
  v_assignment public.pm_assignments%ROWTYPE;
  v_old_ids uuid[];
  v_deadline date;
  v_technician uuid;
BEGIN
  IF COALESCE(v_role, '') NOT IN ('admin','ss','spv') THEN RAISE EXCEPTION 'Hanya Admin, SS, atau SPV yang dapat mengubah penugasan PM.'; END IF;
  IF p_technician_ids IS NULL OR cardinality(p_technician_ids) = 0 THEN RAISE EXCEPTION 'Pilih minimal satu teknisi.'; END IF;
  SELECT * INTO v_occ FROM public.pm_occurrences WHERE id = p_occurrence_id FOR UPDATE;
  IF NOT FOUND OR v_occ.execution_status <> 'open' OR v_occ.pm_assignment_id IS NULL THEN RAISE EXCEPTION 'Occurrence PM belum memiliki penugasan aktif.'; END IF;
  SELECT * INTO v_assignment FROM public.pm_assignments WHERE id = v_occ.pm_assignment_id FOR UPDATE;
  IF v_assignment.status IN ('done','approved','canceled') THEN RAISE EXCEPTION 'Penugasan PM sudah selesai atau final.'; END IF;
  IF p_planned_date IS NOT NULL AND (date_trunc('month', p_planned_date)::date <> v_occ.planned_month OR p_planned_date < (now() AT TIME ZONE 'Asia/Jakarta')::date) THEN RAISE EXCEPTION 'Tanggal assignment harus berada pada bulan target dan belum lewat.'; END IF;
  IF p_priority NOT IN ('low','normal','high','urgent') THEN RAISE EXCEPTION 'Prioritas tidak valid.'; END IF;
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = v_occ.schedule_id;
  IF v_role = 'spv' AND (v_schedule.department_id IS NULL OR NOT public.pm_profile_has_department(auth.uid(), v_schedule.department_id)) THEN RAISE EXCEPTION 'Departemen PM berada di luar cakupan Anda.'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_technician_ids) requested(id)
    LEFT JOIN public.profiles p ON p.id = requested.id
    WHERE p.id IS NULL OR p.role <> 'teknisi' OR p.is_active IS DISTINCT FROM true
      OR NOT public.pm_profile_has_department(p.id, v_schedule.department_id)
  ) THEN RAISE EXCEPTION 'Teknisi harus aktif dan terdaftar pada departemen PM.'; END IF;

  SELECT array_agg(technician_id) INTO v_old_ids FROM public.pm_assignment_technicians WHERE assignment_id = v_assignment.id;
  DELETE FROM public.pm_assignment_technicians WHERE assignment_id = v_assignment.id;
  FOREACH v_technician IN ARRAY p_technician_ids LOOP
    INSERT INTO public.pm_assignment_technicians(assignment_id, technician_id) VALUES (v_assignment.id, v_technician);
  END LOOP;
  v_deadline := COALESCE(p_planned_date, (v_occ.planned_month + interval '1 month')::date - 1);
  UPDATE public.pm_assignments SET technician_id = p_technician_ids[1], planned_date = p_planned_date,
    deadline = (v_deadline + time '17:00') AT TIME ZONE 'Asia/Jakarta', priority = p_priority, updated_at = now()
  WHERE id = v_assignment.id;
  UPDATE public.pm_occurrences SET planned_execution_date = p_planned_date WHERE id = v_occ.id;
  INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
  VALUES (v_occ.id, 'pm_reassigned', jsonb_build_object('old_technician_ids', v_old_ids, 'technician_ids', p_technician_ids, 'planned_date', p_planned_date), auth.uid());
  INSERT INTO public.pm_assignment_history(assignment_id, status, action, notes, performed_by)
  VALUES (v_assignment.id, v_assignment.status, 'Penugasan PM diubah', jsonb_build_object('old_technician_ids', v_old_ids, 'technician_ids', p_technician_ids, 'planned_date', p_planned_date, 'priority', p_priority)::text, auth.uid());
  RETURN v_assignment.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.pm_update_assignment_status(
  p_assignment_id uuid, p_next_status text, p_report_notes text DEFAULT NULL,
  p_pending_reason text DEFAULT NULL, p_review_note text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_assignment public.pm_assignments%ROWTYPE;
  v_occ public.pm_occurrences%ROWTYPE;
  v_schedule public.pm_schedules%ROWTYPE;
  v_role text := public.ja_role();
  v_is_assignee boolean;
  v_is_manager boolean;
  v_notes text;
  v_done_date date;
BEGIN
  SELECT * INTO v_assignment FROM public.pm_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Penugasan PM tidak ditemukan.'; END IF;
  SELECT * INTO v_occ FROM public.pm_occurrences WHERE id = v_assignment.occurrence_id FOR UPDATE;
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = v_occ.schedule_id;
  v_is_assignee := EXISTS (SELECT 1 FROM public.pm_assignment_technicians t WHERE t.assignment_id = v_assignment.id AND t.technician_id = auth.uid());
  v_is_manager := v_role IN ('admin','ss') OR (v_role = 'spv' AND public.pm_profile_has_department(auth.uid(), v_schedule.department_id));
  IF NOT v_is_assignee AND NOT v_is_manager THEN RAISE EXCEPTION 'Anda tidak berwenang mengubah penugasan PM ini.'; END IF;
  IF v_assignment.status IN ('approved','canceled') THEN RAISE EXCEPTION 'Penugasan PM sudah final.'; END IF;

  IF v_is_assignee AND NOT v_is_manager THEN
    IF NOT ((v_assignment.status = 'assigned' AND p_next_status IN ('on_the_way','in_progress'))
      OR (v_assignment.status = 'on_the_way' AND p_next_status = 'in_progress')
      OR (v_assignment.status = 'in_progress' AND p_next_status IN ('in_progress','done'))) THEN
      RAISE EXCEPTION 'Perubahan status penugasan PM tidak diizinkan.';
    END IF;
    IF p_next_status = 'done' AND length(btrim(coalesce(p_report_notes, ''))) = 0 THEN RAISE EXCEPTION 'Isi laporan pekerjaan sebelum menyelesaikan PM.'; END IF;
  ELSE
    IF NOT ((v_assignment.status = 'in_progress' AND p_next_status = 'pending')
      OR (v_assignment.status = 'pending' AND p_next_status = 'in_progress')
      OR (v_assignment.status = 'done' AND p_next_status = 'approved')
      OR (v_assignment.status = 'done' AND p_next_status = 'in_progress')) THEN
      RAISE EXCEPTION 'Perubahan status penugasan PM tidak diizinkan.';
    END IF;
    IF p_next_status = 'pending' AND length(btrim(coalesce(p_pending_reason, ''))) = 0 THEN RAISE EXCEPTION 'Alasan pending wajib diisi.'; END IF;
    IF v_assignment.status = 'done' AND p_next_status = 'in_progress' AND length(btrim(coalesce(p_review_note, ''))) = 0 THEN RAISE EXCEPTION 'Komentar wajib diisi saat meminta perbaikan.'; END IF;
  END IF;

  UPDATE public.pm_assignments SET
    status = p_next_status,
    report_notes = CASE WHEN v_is_assignee AND NOT v_is_manager THEN coalesce(nullif(btrim(p_report_notes), ''), report_notes) ELSE report_notes END,
    pending_reason = CASE WHEN p_next_status = 'pending' THEN btrim(p_pending_reason) WHEN p_next_status = 'in_progress' AND v_assignment.status = 'pending' THEN NULL ELSE pending_reason END,
    on_the_way_at = CASE WHEN p_next_status = 'on_the_way' THEN coalesce(on_the_way_at, now()) ELSE on_the_way_at END,
    started_at = CASE WHEN p_next_status = 'in_progress' THEN coalesce(started_at, now()) ELSE started_at END,
    done_at = CASE WHEN p_next_status = 'done' THEN now() WHEN v_assignment.status = 'done' AND p_next_status = 'in_progress' THEN NULL ELSE done_at END,
    review_note = CASE WHEN p_next_status IN ('approved','in_progress') AND v_assignment.status = 'done' THEN nullif(btrim(p_review_note), '') ELSE review_note END,
    reviewed_by = CASE WHEN v_assignment.status = 'done' AND p_next_status IN ('approved','in_progress') THEN auth.uid() ELSE reviewed_by END,
    reviewed_at = CASE WHEN v_assignment.status = 'done' AND p_next_status IN ('approved','in_progress') THEN now() ELSE reviewed_at END,
    updated_at = now()
  WHERE id = v_assignment.id;

  v_notes := CASE
    WHEN p_next_status = 'done' THEN nullif(btrim(p_report_notes), '')
    WHEN p_next_status = 'pending' THEN btrim(p_pending_reason)
    WHEN v_assignment.status = 'done' THEN nullif(btrim(p_review_note), '')
    ELSE NULL
  END;
  INSERT INTO public.pm_assignment_history(assignment_id, status, action, notes, performed_by)
  VALUES (v_assignment.id, p_next_status, 'Status penugasan PM diubah', v_notes, auth.uid());

  IF p_next_status = 'done' THEN
    v_done_date := (now() AT TIME ZONE 'Asia/Jakarta')::date;
    UPDATE public.pm_occurrences SET execution_status = 'completed', completed_at = now() WHERE id = v_occ.id;
    IF v_schedule.schedule_mode = 'execution_based' THEN
      UPDATE public.pm_schedules SET next_due_date = public.pm_add_months_clamped(v_done_date, v_schedule.interval_months), updated_at = now() WHERE id = v_schedule.id;
    END IF;
    INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
    VALUES (v_occ.id, 'completed', jsonb_build_object('pm_assignment_id', v_assignment.id, 'done_at', now(), 'done_date_jakarta', v_done_date), auth.uid());
  ELSIF v_assignment.status = 'done' AND p_next_status = 'in_progress' THEN
    UPDATE public.pm_occurrences SET execution_status = 'open', completed_at = NULL WHERE id = v_occ.id;
    IF v_schedule.schedule_mode = 'execution_based' THEN UPDATE public.pm_schedules SET next_due_date = v_occ.due_date, updated_at = now() WHERE id = v_schedule.id; END IF;
    INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
    VALUES (v_occ.id, 'reopened', jsonb_build_object('pm_assignment_id', v_assignment.id, 'reason', v_notes), auth.uid());
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.pm_create_pm_assignment(uuid,uuid[],date,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pm_reassign_pm_assignment(uuid,uuid[],date,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pm_update_assignment_status(uuid,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_create_pm_assignment(uuid,uuid[],date,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pm_reassign_pm_assignment(uuid,uuid[],date,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pm_update_assignment_status(uuid,text,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.pm_sync_assignment_deadline_on_carryover()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.planned_month IS DISTINCT FROM OLD.planned_month AND NEW.pm_assignment_id IS NOT NULL
     AND NEW.execution_status = 'open' AND NEW.planned_execution_date IS NULL THEN
    UPDATE public.pm_assignments
    SET deadline = ((((NEW.planned_month + interval '1 month')::date - 1) + time '17:00') AT TIME ZONE 'Asia/Jakarta'), updated_at = now()
    WHERE id = NEW.pm_assignment_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Keep the existing calendar occurrence policies, changing technician lookup
-- from JA membership to the new PM team table.
REVOKE ALL ON FUNCTION public.pm_user_has_schedule_assignment(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pm_user_has_occurrence_assignment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_user_has_schedule_assignment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pm_user_has_occurrence_assignment(uuid) TO authenticated;

-- New assignments do not create or update Jobs Assignment records.
DROP TRIGGER IF EXISTS pm_sync_job_completion ON public.job_assignments;

NOTIFY pgrst, 'reload schema';
