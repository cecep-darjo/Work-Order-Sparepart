-- Configure which departments run PM and which equipment belongs to each department's PM scope.
CREATE TABLE IF NOT EXISTS public.department_pm_settings (
  department_id uuid PRIMARY KEY REFERENCES public.departments(id) ON DELETE CASCADE,
  pm_enabled boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES public.profiles(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.department_equipment_scope (
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  equipment_id uuid NOT NULL REFERENCES public.equipment(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, equipment_id)
);
CREATE INDEX IF NOT EXISTS idx_department_equipment_scope_equipment
  ON public.department_equipment_scope(equipment_id, department_id);

ALTER TABLE public.pm_schedules ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES public.departments(id) ON DELETE RESTRICT;

-- Keep existing schedules visible and eligible where legacy area-to-department links exist.
UPDATE public.pm_schedules s
SET department_id = a.department_id
FROM public.equipment e
JOIN public.areas a ON a.id = e.area_id
WHERE s.equipment_id = e.id AND s.department_id IS NULL AND a.department_id IS NOT NULL;

INSERT INTO public.department_equipment_scope(department_id, equipment_id)
SELECT a.department_id, e.id
FROM public.equipment e
JOIN public.areas a ON a.id = e.area_id
WHERE a.department_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.department_equipment_scope(department_id, equipment_id)
SELECT DISTINCT s.department_id, s.equipment_id
FROM public.pm_schedules s
WHERE s.department_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.department_pm_settings(department_id, pm_enabled)
SELECT d.id, EXISTS (SELECT 1 FROM public.pm_schedules s WHERE s.department_id = d.id)
FROM public.departments d
ON CONFLICT (department_id) DO NOTHING;

ALTER TABLE public.department_pm_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_equipment_scope ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.department_pm_settings, public.department_equipment_scope FROM anon, authenticated;
GRANT SELECT ON public.department_pm_settings, public.department_equipment_scope TO authenticated;

CREATE POLICY department_pm_settings_read ON public.department_pm_settings FOR SELECT TO authenticated
  USING (public.ja_role() IN ('admin','ss') OR (public.ja_role() = 'spv' AND public.profile_has_department(auth.uid(), department_id)));
CREATE POLICY department_scope_read ON public.department_equipment_scope FOR SELECT TO authenticated
  USING (public.ja_role() IN ('admin','ss') OR (public.ja_role() = 'spv' AND public.profile_has_department(auth.uid(), department_id)));

CREATE OR REPLACE FUNCTION public.pm_save_department_scope(
  p_department_id uuid, p_pm_enabled boolean, p_equipment_ids uuid[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor_role text := public.ja_role();
  v_ids uuid[] := COALESCE(p_equipment_ids, ARRAY[]::uuid[]);
BEGIN
  IF COALESCE(v_actor_role, '') NOT IN ('admin','ss') THEN RAISE EXCEPTION 'Hanya Admin atau SS yang dapat mengatur cakupan PM departemen.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_department_id) THEN RAISE EXCEPTION 'Departemen tidak ditemukan.'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) requested(id)
    LEFT JOIN public.equipment e ON e.id = requested.id
    WHERE e.id IS NULL
  ) THEN RAISE EXCEPTION 'Daftar mesin berisi mesin yang tidak ditemukan.'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.department_equipment_scope current_scope
    JOIN public.pm_schedules s ON s.department_id = current_scope.department_id AND s.equipment_id = current_scope.equipment_id AND s.is_active
    WHERE current_scope.department_id = p_department_id AND NOT current_scope.equipment_id = ANY(v_ids)
  ) THEN RAISE EXCEPTION 'Nonaktifkan atau pindahkan jadwal PM aktif sebelum mengeluarkan mesinnya dari cakupan departemen.'; END IF;

  INSERT INTO public.department_pm_settings(department_id, pm_enabled, updated_by, updated_at)
  VALUES (p_department_id, p_pm_enabled, auth.uid(), now())
  ON CONFLICT (department_id) DO UPDATE SET pm_enabled = EXCLUDED.pm_enabled, updated_by = EXCLUDED.updated_by, updated_at = now();

  DELETE FROM public.department_equipment_scope WHERE department_id = p_department_id;
  INSERT INTO public.department_equipment_scope(department_id, equipment_id, created_by)
  SELECT p_department_id, selected.id, auth.uid() FROM unnest(v_ids) selected(id)
  ON CONFLICT DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.pm_save_department_scope(uuid, boolean, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_save_department_scope(uuid, boolean, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.pm_assign_legacy_schedule(p_schedule_id uuid, p_department_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_schedule public.pm_schedules%ROWTYPE;
BEGIN
  IF COALESCE(public.ja_role(), '') NOT IN ('admin','ss') THEN RAISE EXCEPTION 'Hanya Admin atau SS yang dapat memetakan jadwal lama.'; END IF;
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = p_schedule_id FOR UPDATE;
  IF NOT FOUND OR v_schedule.department_id IS NOT NULL THEN RAISE EXCEPTION 'Jadwal bukan jadwal lama yang belum dipetakan.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.department_pm_settings WHERE department_id = p_department_id AND pm_enabled) THEN RAISE EXCEPTION 'Aktifkan PM pada departemen tujuan terlebih dahulu.'; END IF;
  INSERT INTO public.department_equipment_scope(department_id, equipment_id, created_by)
  VALUES (p_department_id, v_schedule.equipment_id, auth.uid()) ON CONFLICT DO NOTHING;
  UPDATE public.pm_schedules SET department_id = p_department_id, updated_at = now() WHERE id = p_schedule_id;
END;
$$;
REVOKE ALL ON FUNCTION public.pm_assign_legacy_schedule(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_assign_legacy_schedule(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.pm_validate_schedule_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.department_id IS DISTINCT FROM OLD.department_id OR NEW.equipment_id IS DISTINCT FROM OLD.equipment_id THEN
    IF NEW.department_id IS NULL THEN RAISE EXCEPTION 'Departemen wajib dipilih untuk jadwal PM.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.department_pm_settings s WHERE s.department_id = NEW.department_id AND s.pm_enabled) THEN
      RAISE EXCEPTION 'Program PM departemen ini belum diaktifkan.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.department_equipment_scope s WHERE s.department_id = NEW.department_id AND s.equipment_id = NEW.equipment_id) THEN
      RAISE EXCEPTION 'Mesin tidak termasuk cakupan PM departemen yang dipilih.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pm_validate_schedule_scope ON public.pm_schedules;
CREATE TRIGGER pm_validate_schedule_scope BEFORE INSERT OR UPDATE OF department_id, equipment_id ON public.pm_schedules
  FOR EACH ROW EXECUTE FUNCTION public.pm_validate_schedule_scope();
REVOKE ALL ON FUNCTION public.pm_validate_schedule_scope() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pm_validate_occurrence_assignment_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_schedule public.pm_schedules%ROWTYPE;
  v_role text := public.ja_role();
BEGIN
  IF NEW.job_assignment_id IS NOT DISTINCT FROM OLD.job_assignment_id
     AND NEW.planned_execution_date IS NOT DISTINCT FROM OLD.planned_execution_date THEN RETURN NEW; END IF;
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = NEW.schedule_id;
  IF v_schedule.department_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.department_pm_settings s WHERE s.department_id = v_schedule.department_id AND s.pm_enabled)
     OR NOT EXISTS (SELECT 1 FROM public.department_equipment_scope s WHERE s.department_id = v_schedule.department_id AND s.equipment_id = v_schedule.equipment_id) THEN
    RAISE EXCEPTION 'Jadwal PM ini tidak berada pada cakupan aktif departemen.';
  END IF;
  IF v_role = 'spv' AND NOT public.profile_has_department(auth.uid(), v_schedule.department_id) THEN
    RAISE EXCEPTION 'Departemen PM berada di luar cakupan Anda.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pm_validate_occurrence_assignment_scope ON public.pm_occurrences;
CREATE TRIGGER pm_validate_occurrence_assignment_scope BEFORE UPDATE OF job_assignment_id, planned_execution_date ON public.pm_occurrences
  FOR EACH ROW EXECUTE FUNCTION public.pm_validate_occurrence_assignment_scope();
REVOKE ALL ON FUNCTION public.pm_validate_occurrence_assignment_scope() FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS pm_schedule_read ON public.pm_schedules;
CREATE POLICY pm_schedule_read ON public.pm_schedules FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss')
  OR (public.ja_role() = 'spv' AND department_id IS NOT NULL AND public.profile_has_department(auth.uid(), department_id))
  OR EXISTS (
    SELECT 1 FROM public.pm_occurrences o
    JOIN public.job_assignments j ON j.id = o.job_assignment_id
    JOIN public.job_assignment_technicians jt ON jt.job_id = j.id
    WHERE o.schedule_id = pm_schedules.id AND jt.technician_id = auth.uid()
  )
);
DROP POLICY IF EXISTS pm_schedule_manage ON public.pm_schedules;
CREATE POLICY pm_schedule_manage ON public.pm_schedules FOR ALL TO authenticated
  USING (public.ja_role() IN ('admin','ss') OR (public.ja_role() = 'spv' AND department_id IS NOT NULL AND public.profile_has_department(auth.uid(), department_id)))
  WITH CHECK (
    department_id IS NOT NULL
    AND (NOT pm_schedules.is_active OR (
      EXISTS (SELECT 1 FROM public.department_pm_settings s WHERE s.department_id = pm_schedules.department_id AND s.pm_enabled)
      AND EXISTS (SELECT 1 FROM public.department_equipment_scope s WHERE s.department_id = pm_schedules.department_id AND s.equipment_id = pm_schedules.equipment_id)
    ))
    AND (public.ja_role() IN ('admin','ss') OR (public.ja_role() = 'spv' AND public.profile_has_department(auth.uid(), pm_schedules.department_id)))
  );

DROP POLICY IF EXISTS pm_occurrence_read ON public.pm_occurrences;
CREATE POLICY pm_occurrence_read ON public.pm_occurrences FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss')
  OR (public.ja_role() = 'spv' AND EXISTS (SELECT 1 FROM public.pm_schedules s WHERE s.id = pm_occurrences.schedule_id AND s.department_id IS NOT NULL AND public.profile_has_department(auth.uid(), s.department_id)))
  OR EXISTS (
    SELECT 1 FROM public.job_assignments j
    JOIN public.job_assignment_technicians jt ON jt.job_id = j.id
    WHERE j.id = pm_occurrences.job_assignment_id AND jt.technician_id = auth.uid()
  )
);

DROP POLICY IF EXISTS pm_history_read ON public.pm_occurrence_history;
CREATE POLICY pm_history_read ON public.pm_occurrence_history FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss')
  OR (public.ja_role() = 'spv' AND EXISTS (
    SELECT 1 FROM public.pm_occurrences o JOIN public.pm_schedules s ON s.id = o.schedule_id
    WHERE o.id = pm_occurrence_history.occurrence_id AND s.department_id IS NOT NULL AND public.profile_has_department(auth.uid(), s.department_id)
  ))
);
DROP POLICY IF EXISTS pm_schedule_history_read ON public.pm_schedule_history;
CREATE POLICY pm_schedule_history_read ON public.pm_schedule_history FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss')
  OR (public.ja_role() = 'spv' AND EXISTS (SELECT 1 FROM public.pm_schedules s WHERE s.id = pm_schedule_history.schedule_id AND s.department_id IS NOT NULL AND public.profile_has_department(auth.uid(), s.department_id)))
);

-- Only enabled departments receive future recurring occurrences; null-department legacy rows are retained.
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
  FOR v_schedule IN SELECT * FROM public.pm_schedules s WHERE s.is_active AND (s.department_id IS NULL OR EXISTS (SELECT 1 FROM public.department_pm_settings cfg WHERE cfg.department_id = s.department_id AND cfg.pm_enabled)) LOOP
    IF v_schedule.schedule_mode = 'fixed_calendar' THEN
      v_month := date_trunc('month', v_schedule.anchor_due_date)::date;
      v_month_index := GREATEST(0, (EXTRACT(year FROM date_trunc('month', p_as_of)::date)::integer - EXTRACT(year FROM v_month)::integer) * 12 + EXTRACT(month FROM date_trunc('month', p_as_of)::date)::integer - EXTRACT(month FROM v_month)::integer - 1);
      v_month_index := v_month_index + ((v_schedule.interval_months - (v_month_index % v_schedule.interval_months)) % v_schedule.interval_months);
      v_month := (v_month + make_interval(months => v_month_index))::date;
      WHILE v_month <= v_target_month LOOP
        IF ((EXTRACT(year FROM v_month)::integer - EXTRACT(year FROM v_schedule.anchor_due_date)::integer) * 12 + EXTRACT(month FROM v_month)::integer - EXTRACT(month FROM v_schedule.anchor_due_date)::integer) % v_schedule.interval_months = 0 THEN
          v_due := public.pm_add_months_clamped(v_schedule.anchor_due_date, ((EXTRACT(year FROM v_month)::integer - EXTRACT(year FROM v_schedule.anchor_due_date)::integer) * 12 + EXTRACT(month FROM v_month)::integer - EXTRACT(month FROM v_schedule.anchor_due_date)::integer));
          IF (v_schedule.end_date IS NULL OR v_due <= v_schedule.end_date) AND v_due < v_target_month + interval '1 month' AND (v_due <= p_as_of OR p_as_of >= v_target_month - 7) THEN
            INSERT INTO public.pm_occurrences(schedule_id, period_key, due_date, planned_month) VALUES (v_schedule.id, to_char(v_due, 'YYYY-MM'), v_due, date_trunc('month', v_due)::date) ON CONFLICT (schedule_id, period_key) DO NOTHING;
            GET DIAGNOSTICS v_count = ROW_COUNT; v_created := v_created + v_count;
          END IF;
        END IF;
        v_month := (v_month + make_interval(months => v_schedule.interval_months))::date;
      END LOOP;
    ELSE
      v_due := v_schedule.next_due_date;
      IF v_due IS NOT NULL AND (v_schedule.end_date IS NULL OR v_due <= v_schedule.end_date) AND v_due < v_target_month + interval '1 month' AND (v_due <= p_as_of OR p_as_of >= v_target_month - 7) THEN
        INSERT INTO public.pm_occurrences(schedule_id, period_key, due_date, planned_month) VALUES (v_schedule.id, v_due::text, v_due, date_trunc('month', v_due)::date) ON CONFLICT (schedule_id, period_key) DO NOTHING;
        GET DIAGNOSTICS v_count = ROW_COUNT; v_created := v_created + v_count;
      END IF;
    END IF;
  END LOOP;
  FOR v_row IN SELECT * FROM public.pm_occurrences WHERE execution_status = 'open' AND planned_month < date_trunc('month', p_as_of)::date FOR UPDATE LOOP
    IF v_row.reschedule_count = 0 THEN
      UPDATE public.pm_occurrences SET planned_month = date_trunc('month', p_as_of)::date, reschedule_count = 1, planned_execution_date = NULL WHERE id = v_row.id;
      INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by) VALUES (v_row.id, 'rescheduled', jsonb_build_object('from_month', v_row.planned_month, 'to_month', date_trunc('month', p_as_of)::date), auth.uid());
    ELSE
      UPDATE public.pm_occurrences SET execution_status = 'not_done', planned_execution_date = NULL WHERE id = v_row.id;
      INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by) VALUES (v_row.id, 'not_done', jsonb_build_object('reason', 'Tidak terlaksana pada bulan carry-over', 'planned_month', v_row.planned_month), auth.uid());
    END IF;
  END LOOP;
  RETURN v_created;
END;
$$;
REVOKE ALL ON FUNCTION public.pm_run_cycle(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_run_cycle(date) TO authenticated;

NOTIFY pgrst, 'reload schema';
