-- Preventive Maintenance: recurring schedules, monthly occurrences, technician roster, and JA linking.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS work_schedule_type text NOT NULL DEFAULT 'non_shift'
  CHECK (work_schedule_type IN ('shift', 'non_shift'));

ALTER TABLE public.job_assignments DROP CONSTRAINT IF EXISTS job_assignments_work_category_check;
ALTER TABLE public.job_assignments ADD CONSTRAINT job_assignments_work_category_check
  CHECK (work_category IN ('perbaikan', 'modifikasi', 'tugas_lain', 'preventive_maintenance'));

CREATE TABLE IF NOT EXISTS public.pm_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES public.equipment(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  description text,
  interval_months integer NOT NULL CHECK (interval_months > 0),
  schedule_mode text NOT NULL CHECK (schedule_mode IN ('fixed_calendar', 'execution_based')),
  anchor_due_date date NOT NULL,
  next_due_date date,
  end_date date,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= anchor_due_date),
  CHECK (schedule_mode <> 'execution_based' OR next_due_date IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_pm_schedules_equipment_active ON public.pm_schedules(equipment_id, is_active);
CREATE INDEX IF NOT EXISTS idx_pm_schedules_next_due ON public.pm_schedules(next_due_date) WHERE is_active;

CREATE TABLE IF NOT EXISTS public.pm_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.pm_schedules(id) ON DELETE RESTRICT,
  period_key text NOT NULL,
  due_date date NOT NULL,
  planned_month date NOT NULL,
  planned_execution_date date,
  reschedule_count integer NOT NULL DEFAULT 0 CHECK (reschedule_count BETWEEN 0 AND 1),
  execution_status text NOT NULL DEFAULT 'open'
    CHECK (execution_status IN ('open', 'completed', 'not_done', 'waived', 'canceled')),
  job_assignment_id uuid UNIQUE REFERENCES public.job_assignments(id) ON DELETE SET NULL,
  completed_at timestamptz,
  closed_by uuid REFERENCES public.profiles(id),
  closed_at timestamptz,
  close_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(schedule_id, period_key),
  CHECK (planned_month = date_trunc('month', planned_month)::date)
);

CREATE INDEX IF NOT EXISTS idx_pm_occurrences_month_status ON public.pm_occurrences(planned_month, execution_status);
CREATE INDEX IF NOT EXISTS idx_pm_occurrences_schedule_due ON public.pm_occurrences(schedule_id, due_date);

CREATE TABLE IF NOT EXISTS public.pm_occurrence_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id uuid NOT NULL REFERENCES public.pm_occurrences(id) ON DELETE CASCADE,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  performed_by uuid REFERENCES public.profiles(id),
  performed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pm_schedule_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.pm_schedules(id) ON DELETE CASCADE,
  action text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  performed_by uuid REFERENCES public.profiles(id),
  performed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.technician_shift_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  shift_date date NOT NULL,
  shift_name text NOT NULL,
  starts_at time NOT NULL,
  ends_at time NOT NULL,
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(technician_id, shift_date),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_technician_shifts_date ON public.technician_shift_assignments(shift_date, technician_id);

ALTER TABLE public.pm_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_occurrence_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_schedule_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.technician_shift_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pm_schedules, public.pm_occurrences, public.pm_occurrence_history, public.pm_schedule_history, public.technician_shift_assignments FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.pm_schedules TO authenticated;
GRANT SELECT ON public.pm_occurrences, public.pm_occurrence_history, public.pm_schedule_history, public.technician_shift_assignments TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.technician_shift_assignments TO authenticated;

CREATE POLICY pm_schedule_read ON public.pm_schedules FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss','spv') OR EXISTS (
    SELECT 1 FROM public.pm_occurrences o
    JOIN public.job_assignments j ON j.id = o.job_assignment_id
    JOIN public.job_assignment_technicians jt ON jt.job_id = j.id
    WHERE o.schedule_id = pm_schedules.id AND jt.technician_id = auth.uid()
  )
);
CREATE POLICY pm_schedule_manage ON public.pm_schedules FOR ALL TO authenticated
  USING (public.ja_role() IN ('admin','ss','spv')) WITH CHECK (public.ja_role() IN ('admin','ss','spv'));
CREATE POLICY pm_occurrence_read ON public.pm_occurrences FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss','spv') OR EXISTS (
    SELECT 1 FROM public.job_assignments j
    JOIN public.job_assignment_technicians jt ON jt.job_id = j.id
    WHERE j.id = pm_occurrences.job_assignment_id AND jt.technician_id = auth.uid()
  )
);
CREATE POLICY pm_history_read ON public.pm_occurrence_history FOR SELECT TO authenticated
  USING (public.ja_role() IN ('admin','ss','spv'));
CREATE POLICY pm_schedule_history_read ON public.pm_schedule_history FOR SELECT TO authenticated
  USING (public.ja_role() IN ('admin','ss','spv'));
CREATE POLICY technician_shift_read ON public.technician_shift_assignments FOR SELECT TO authenticated
  USING (public.ja_role() IN ('admin','ss','spv') OR technician_id = auth.uid());
CREATE POLICY technician_shift_manage ON public.technician_shift_assignments FOR ALL TO authenticated
  USING (public.ja_role() = 'admin') WITH CHECK (public.ja_role() = 'admin');

CREATE OR REPLACE FUNCTION public.pm_log_schedule_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.pm_schedule_history(schedule_id, action, before_data, after_data, performed_by)
  VALUES (
    NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'updated' END,
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
    to_jsonb(NEW),
    auth.uid()
  );
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.pm_log_schedule_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS pm_log_schedule_change ON public.pm_schedules;
CREATE TRIGGER pm_log_schedule_change AFTER INSERT OR UPDATE ON public.pm_schedules
  FOR EACH ROW EXECUTE FUNCTION public.pm_log_schedule_change();

CREATE OR REPLACE FUNCTION public.pm_add_months_clamped(p_date date, p_months integer)
RETURNS date LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT (date_trunc('month', p_date)::date + make_interval(months => p_months))::date
    + LEAST(EXTRACT(day FROM p_date)::integer,
      EXTRACT(day FROM (date_trunc('month', p_date)::date + make_interval(months => p_months + 1) - interval '1 day'))::integer) - 1
$$;

CREATE OR REPLACE FUNCTION public.pm_run_cycle(p_as_of date DEFAULT (now() AT TIME ZONE 'Asia/Jakarta')::date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role text;
  v_schedule public.pm_schedules%ROWTYPE;
  v_due date;
  v_target_month date := (date_trunc('month', p_as_of)::date + interval '1 month')::date;
  v_month date;
  v_month_index integer;
  v_created integer := 0;
  v_count integer;
  v_row public.pm_occurrences%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    v_role := public.ja_role();
    IF COALESCE(v_role, '') NOT IN ('admin','ss','spv') THEN RAISE EXCEPTION 'Tidak berwenang menjalankan siklus PM.'; END IF;
  END IF;

  FOR v_schedule IN SELECT * FROM public.pm_schedules WHERE is_active LOOP
    IF v_schedule.schedule_mode = 'fixed_calendar' THEN
      v_month := date_trunc('month', v_schedule.anchor_due_date)::date;
      v_month_index := GREATEST(0,
        (EXTRACT(year FROM date_trunc('month', p_as_of)::date)::integer - EXTRACT(year FROM v_month)::integer) * 12
        + EXTRACT(month FROM date_trunc('month', p_as_of)::date)::integer - EXTRACT(month FROM v_month)::integer - 1);
      v_month_index := v_month_index + ((v_schedule.interval_months - (v_month_index % v_schedule.interval_months)) % v_schedule.interval_months);
      v_month := (v_month + make_interval(months => v_month_index))::date;
      WHILE v_month <= v_target_month LOOP
        IF ((EXTRACT(year FROM v_month)::integer - EXTRACT(year FROM v_schedule.anchor_due_date)::integer) * 12
            + EXTRACT(month FROM v_month)::integer - EXTRACT(month FROM v_schedule.anchor_due_date)::integer) % v_schedule.interval_months = 0 THEN
          v_due := public.pm_add_months_clamped(v_schedule.anchor_due_date,
            ((EXTRACT(year FROM v_month)::integer - EXTRACT(year FROM v_schedule.anchor_due_date)::integer) * 12
             + EXTRACT(month FROM v_month)::integer - EXTRACT(month FROM v_schedule.anchor_due_date)::integer));
          IF (v_schedule.end_date IS NULL OR v_due <= v_schedule.end_date)
             AND v_due < v_target_month + interval '1 month'
             AND (v_due <= p_as_of OR p_as_of >= v_target_month - 7) THEN
            INSERT INTO public.pm_occurrences(schedule_id, period_key, due_date, planned_month)
            VALUES (v_schedule.id, to_char(v_due, 'YYYY-MM'), v_due, date_trunc('month', v_due)::date)
            ON CONFLICT (schedule_id, period_key) DO NOTHING;
            GET DIAGNOSTICS v_count = ROW_COUNT;
            v_created := v_created + v_count;
          END IF;
        END IF;
        v_month := (v_month + make_interval(months => v_schedule.interval_months))::date;
      END LOOP;
    ELSE
      v_due := v_schedule.next_due_date;
      IF v_due IS NOT NULL AND (v_schedule.end_date IS NULL OR v_due <= v_schedule.end_date)
         AND v_due < v_target_month + interval '1 month'
         AND (v_due <= p_as_of OR p_as_of >= v_target_month - 7) THEN
        INSERT INTO public.pm_occurrences(schedule_id, period_key, due_date, planned_month)
        VALUES (v_schedule.id, v_due::text, v_due, date_trunc('month', v_due)::date)
        ON CONFLICT (schedule_id, period_key) DO NOTHING;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        v_created := v_created + v_count;
      END IF;
    END IF;
  END LOOP;

  FOR v_row IN
    SELECT * FROM public.pm_occurrences
    WHERE execution_status = 'open' AND planned_month < date_trunc('month', p_as_of)::date
    FOR UPDATE
  LOOP
    IF v_row.reschedule_count = 0 THEN
      UPDATE public.pm_occurrences SET planned_month = date_trunc('month', p_as_of)::date,
        reschedule_count = 1, planned_execution_date = NULL WHERE id = v_row.id;
      INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
      VALUES (v_row.id, 'rescheduled', jsonb_build_object('from_month', v_row.planned_month, 'to_month', date_trunc('month', p_as_of)::date), auth.uid());
    ELSE
      UPDATE public.pm_occurrences SET execution_status = 'not_done', planned_execution_date = NULL WHERE id = v_row.id;
      INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
      VALUES (v_row.id, 'not_done', jsonb_build_object('reason', 'Tidak terlaksana pada bulan carry-over', 'planned_month', v_row.planned_month), auth.uid());
    END IF;
  END LOOP;
  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.pm_add_months_clamped(date, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pm_run_cycle(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_run_cycle(date) TO authenticated;

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
BEGIN
  IF COALESCE(v_role, '') NOT IN ('admin','ss','spv') THEN RAISE EXCEPTION 'Hanya Admin, SS, atau SPV yang dapat membuat penugasan PM.'; END IF;
  IF p_technician_ids IS NULL OR cardinality(p_technician_ids) = 0 THEN RAISE EXCEPTION 'Pilih minimal satu teknisi.'; END IF;
  SELECT * INTO v_occ FROM public.pm_occurrences WHERE id = p_occurrence_id FOR UPDATE;
  IF NOT FOUND OR v_occ.execution_status <> 'open' OR v_occ.job_assignment_id IS NOT NULL THEN
    RAISE EXCEPTION 'Occurrence PM sudah ditugaskan atau tidak aktif.';
  END IF;
  IF date_trunc('month', p_planned_date)::date <> v_occ.planned_month OR p_planned_date < (now() AT TIME ZONE 'Asia/Jakarta')::date THEN
    RAISE EXCEPTION 'Tanggal assignment harus berada pada bulan target dan belum lewat.';
  END IF;
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = v_occ.schedule_id;
  SELECT * INTO v_equipment FROM public.equipment WHERE id = v_schedule.equipment_id;
  SELECT * INTO v_area FROM public.areas WHERE id = v_equipment.area_id;
  IF v_role = 'spv' AND v_area.department_id IS NOT NULL AND NOT public.profile_has_department(auth.uid(), v_area.department_id) THEN
    RAISE EXCEPTION 'Mesin berada di luar departemen yang ditugaskan kepada Anda.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_technician_ids) requested(id)
    LEFT JOIN public.profiles p ON p.id = requested.id
    WHERE p.id IS NULL OR p.role <> 'teknisi' OR p.is_active IS DISTINCT FROM true
  ) THEN RAISE EXCEPTION 'Teknisi tidak aktif atau tidak valid.'; END IF;

  INSERT INTO public.job_assignments (
    title, description, location, technician_id, deadline, priority, status, created_by,
    work_category, equipment_id
  ) VALUES (
    v_schedule.title, v_schedule.description, concat_ws(' • ', v_area.name, v_equipment.name),
    p_technician_ids[1], (p_planned_date + time '17:00') AT TIME ZONE 'Asia/Jakarta',
    'normal', 'assigned', auth.uid(), 'preventive_maintenance', v_equipment.id
  ) RETURNING id INTO v_job_id;

  FOR v_idx IN 2..cardinality(p_technician_ids) LOOP
    v_tech := p_technician_ids[v_idx];
    INSERT INTO public.job_assignment_technicians(job_id, technician_id) VALUES (v_job_id, v_tech) ON CONFLICT DO NOTHING;
  END LOOP;
  UPDATE public.pm_occurrences SET job_assignment_id = v_job_id, planned_execution_date = p_planned_date WHERE id = v_occ.id;
  INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
  VALUES (v_occ.id, 'assigned', jsonb_build_object('job_assignment_id', v_job_id, 'technician_ids', p_technician_ids, 'planned_date', p_planned_date), auth.uid());
  RETURN v_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pm_create_assignment(uuid, uuid[], date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_create_assignment(uuid, uuid[], date) TO authenticated;

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
BEGIN
  IF COALESCE(v_role, '') NOT IN ('admin','ss','spv') THEN RAISE EXCEPTION 'Hanya Admin, SS, atau SPV yang dapat mengubah penugasan PM.'; END IF;
  IF p_technician_ids IS NULL OR cardinality(p_technician_ids) = 0 THEN RAISE EXCEPTION 'Pilih minimal satu teknisi.'; END IF;
  SELECT * INTO v_occ FROM public.pm_occurrences WHERE id = p_occurrence_id FOR UPDATE;
  IF NOT FOUND OR v_occ.execution_status <> 'open' OR v_occ.job_assignment_id IS NULL THEN RAISE EXCEPTION 'Occurrence PM belum memiliki assignment aktif.'; END IF;
  IF date_trunc('month', p_planned_date)::date <> v_occ.planned_month OR p_planned_date < (now() AT TIME ZONE 'Asia/Jakarta')::date THEN RAISE EXCEPTION 'Tanggal assignment harus berada pada bulan target dan belum lewat.'; END IF;
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = v_occ.schedule_id;
  SELECT * INTO v_equipment FROM public.equipment WHERE id = v_schedule.equipment_id;
  SELECT * INTO v_area FROM public.areas WHERE id = v_equipment.area_id;
  IF v_role = 'spv' AND v_area.department_id IS NOT NULL AND NOT public.profile_has_department(auth.uid(), v_area.department_id) THEN RAISE EXCEPTION 'Mesin berada di luar departemen yang ditugaskan kepada Anda.'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_technician_ids) requested(id)
    LEFT JOIN public.profiles p ON p.id = requested.id
    WHERE p.id IS NULL OR p.role <> 'teknisi' OR p.is_active IS DISTINCT FROM true
  ) THEN RAISE EXCEPTION 'Teknisi tidak aktif atau tidak valid.'; END IF;
  SELECT array_agg(technician_id) INTO v_old_ids FROM public.job_assignment_technicians WHERE job_id = v_occ.job_assignment_id;
  UPDATE public.job_assignments SET technician_id = p_technician_ids[1],
    deadline = (p_planned_date + time '17:00') AT TIME ZONE 'Asia/Jakarta',
    equipment_id = v_equipment.id, work_category = 'preventive_maintenance'
  WHERE id = v_occ.job_assignment_id;
  FOREACH v_tech IN ARRAY p_technician_ids LOOP
    INSERT INTO public.job_assignment_technicians(job_id, technician_id) VALUES (v_occ.job_assignment_id, v_tech) ON CONFLICT DO NOTHING;
  END LOOP;
  FOREACH v_tech IN ARRAY COALESCE(v_old_ids, ARRAY[]::uuid[]) LOOP
    IF NOT v_tech = ANY(p_technician_ids) AND v_tech <> p_technician_ids[1] THEN
      DELETE FROM public.job_assignment_technicians WHERE job_id = v_occ.job_assignment_id AND technician_id = v_tech;
    END IF;
  END LOOP;
  UPDATE public.pm_occurrences SET planned_execution_date = p_planned_date WHERE id = v_occ.id;
  INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
  VALUES (v_occ.id, 'reassigned', jsonb_build_object('old_technician_ids', v_old_ids, 'technician_ids', p_technician_ids, 'planned_date', p_planned_date), auth.uid());
  RETURN v_occ.job_assignment_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pm_reassign_assignment(uuid, uuid[], date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_reassign_assignment(uuid, uuid[], date) TO authenticated;

CREATE OR REPLACE FUNCTION public.pm_sync_job_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_occ public.pm_occurrences%ROWTYPE;
  v_schedule public.pm_schedules%ROWTYPE;
  v_done_date date;
BEGIN
  SELECT * INTO v_occ FROM public.pm_occurrences WHERE job_assignment_id = NEW.id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = v_occ.schedule_id FOR UPDATE;
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' THEN
    v_done_date := (NEW.done_at AT TIME ZONE 'Asia/Jakarta')::date;
    UPDATE public.pm_occurrences SET execution_status = 'completed', completed_at = NEW.done_at WHERE id = v_occ.id;
    IF v_schedule.schedule_mode = 'execution_based' THEN
      UPDATE public.pm_schedules SET next_due_date = public.pm_add_months_clamped(v_done_date, v_schedule.interval_months), updated_at = now()
      WHERE id = v_schedule.id;
    END IF;
    INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
    VALUES (v_occ.id, 'completed', jsonb_build_object('done_at', NEW.done_at, 'done_date_jakarta', v_done_date), NEW.technician_id);
  ELSIF OLD.status = 'done' AND NEW.status = 'in_progress' THEN
    UPDATE public.pm_occurrences SET execution_status = 'open', completed_at = NULL WHERE id = v_occ.id;
    IF v_schedule.schedule_mode = 'execution_based' THEN
      UPDATE public.pm_schedules SET next_due_date = v_occ.due_date, updated_at = now() WHERE id = v_schedule.id;
    END IF;
    INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
    VALUES (v_occ.id, 'reopened', jsonb_build_object('job_assignment_id', NEW.id), auth.uid());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pm_sync_job_completion ON public.job_assignments;
CREATE TRIGGER pm_sync_job_completion AFTER UPDATE OF status ON public.job_assignments
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION public.pm_sync_job_completion();

CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'pm-monthly-cycle';
SELECT cron.schedule('pm-monthly-cycle', '5 17 * * *', $$SELECT public.pm_run_cycle((now() AT TIME ZONE 'Asia/Jakarta')::date);$$);

NOTIFY pgrst, 'reload schema';
