-- Admins own PM activation in Master Data WO. PM scope editors can manage
-- equipment only within departments explicitly assigned to their profiles.
CREATE OR REPLACE FUNCTION public.pm_current_user_has_department(p_department_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profile_departments pd
    WHERE pd.profile_id = auth.uid() AND pd.department_id = p_department_id
  );
$$;
REVOKE ALL ON FUNCTION public.pm_current_user_has_department(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_current_user_has_department(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.pm_set_department_enabled(
  p_department_id uuid,
  p_pm_enabled boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(public.ja_role(), '') <> 'admin' THEN
    RAISE EXCEPTION 'Hanya Admin yang dapat mengubah aktivasi PM departemen.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.id = p_department_id) THEN
    RAISE EXCEPTION 'Departemen tidak ditemukan.';
  END IF;

  INSERT INTO public.department_pm_settings(department_id, pm_enabled, updated_by, updated_at)
  VALUES (p_department_id, p_pm_enabled, auth.uid(), now())
  ON CONFLICT (department_id) DO UPDATE
  SET pm_enabled = EXCLUDED.pm_enabled, updated_by = EXCLUDED.updated_by, updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION public.pm_set_department_enabled(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_set_department_enabled(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.pm_save_department_equipment_scope(
  p_department_id uuid,
  p_equipment_ids uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.ja_role();
  v_ids uuid[] := COALESCE(p_equipment_ids, ARRAY[]::uuid[]);
BEGIN
  IF COALESCE(v_role, '') NOT IN ('admin','ss','spv') THEN
    RAISE EXCEPTION 'Anda tidak berwenang mengatur cakupan mesin PM.';
  END IF;
  IF v_role <> 'admin' AND NOT public.pm_current_user_has_department(p_department_id) THEN
    RAISE EXCEPTION 'Departemen PM berada di luar cakupan profil Anda.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.id = p_department_id) THEN
    RAISE EXCEPTION 'Departemen tidak ditemukan.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) requested(id)
    LEFT JOIN public.equipment e ON e.id = requested.id
    LEFT JOIN public.areas a ON a.id = e.area_id
    WHERE e.id IS NULL OR a.department_id IS DISTINCT FROM p_department_id
  ) THEN
    RAISE EXCEPTION 'Daftar mesin harus berada pada area departemen yang dipilih.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.department_equipment_scope current_scope
    JOIN public.pm_schedules s
      ON s.department_id = current_scope.department_id
     AND s.equipment_id = current_scope.equipment_id
     AND s.is_active
    WHERE current_scope.department_id = p_department_id
      AND NOT (current_scope.equipment_id = ANY(v_ids))
  ) THEN
    RAISE EXCEPTION 'Nonaktifkan atau pindahkan jadwal PM aktif sebelum mengeluarkan mesinnya dari cakupan departemen.';
  END IF;

  DELETE FROM public.department_equipment_scope WHERE department_id = p_department_id;
  INSERT INTO public.department_equipment_scope(department_id, equipment_id, created_by)
  SELECT p_department_id, selected.id, auth.uid()
  FROM unnest(v_ids) selected(id)
  ON CONFLICT DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.pm_save_department_equipment_scope(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_save_department_equipment_scope(uuid, uuid[]) TO authenticated;

-- Remove the old combined switch-and-scope API so it cannot bypass Admin-only activation.
REVOKE ALL ON FUNCTION public.pm_save_department_scope(uuid, boolean, uuid[]) FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS department_pm_settings_read ON public.department_pm_settings;
CREATE POLICY department_pm_settings_read ON public.department_pm_settings FOR SELECT TO authenticated
  USING (
    public.ja_role() = 'admin'
    OR (public.ja_role() IN ('ss','spv') AND public.pm_current_user_has_department(department_id))
  );

DROP POLICY IF EXISTS department_scope_read ON public.department_equipment_scope;
CREATE POLICY department_scope_read ON public.department_equipment_scope FOR SELECT TO authenticated
  USING (
    public.ja_role() = 'admin'
    OR (public.ja_role() IN ('ss','spv') AND public.pm_current_user_has_department(department_id))
  );

CREATE OR REPLACE FUNCTION public.pm_user_has_schedule_department(p_schedule_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.pm_schedules s
    WHERE s.id = p_schedule_id
      AND s.department_id IS NOT NULL
      AND public.pm_current_user_has_department(s.department_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.pm_user_has_occurrence_department(p_occurrence_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.pm_occurrences o
    JOIN public.pm_schedules s ON s.id = o.schedule_id
    WHERE o.id = p_occurrence_id
      AND s.department_id IS NOT NULL
      AND public.pm_current_user_has_department(s.department_id)
  );
$$;

DROP POLICY IF EXISTS pm_schedule_read ON public.pm_schedules;
CREATE POLICY pm_schedule_read ON public.pm_schedules FOR SELECT TO authenticated USING (
  public.ja_role() = 'admin'
  OR (public.ja_role() IN ('ss','spv') AND public.pm_user_has_schedule_department(id))
  OR (public.ja_role() = 'teknisi' AND public.pm_user_has_schedule_assignment(id))
);

DROP POLICY IF EXISTS pm_schedule_manage ON public.pm_schedules;
CREATE POLICY pm_schedule_manage ON public.pm_schedules FOR ALL TO authenticated
  USING (
    public.ja_role() = 'admin'
    OR (public.ja_role() IN ('ss','spv') AND public.pm_user_has_schedule_department(id))
  )
  WITH CHECK (
    department_id IS NOT NULL
    AND (NOT pm_schedules.is_active OR (
      EXISTS (SELECT 1 FROM public.department_pm_settings s WHERE s.department_id = pm_schedules.department_id AND s.pm_enabled)
      AND EXISTS (SELECT 1 FROM public.department_equipment_scope s WHERE s.department_id = pm_schedules.department_id AND s.equipment_id = pm_schedules.equipment_id)
    ))
    AND (
      public.ja_role() = 'admin'
      OR (public.ja_role() IN ('ss','spv') AND public.pm_current_user_has_department(pm_schedules.department_id))
    )
  );

DROP POLICY IF EXISTS pm_occurrence_read ON public.pm_occurrences;
CREATE POLICY pm_occurrence_read ON public.pm_occurrences FOR SELECT TO authenticated USING (
  public.ja_role() = 'admin'
  OR (public.ja_role() IN ('ss','spv') AND public.pm_user_has_schedule_department(schedule_id))
  OR (public.ja_role() = 'teknisi' AND public.pm_user_has_occurrence_assignment(id))
);

DROP POLICY IF EXISTS pm_history_read ON public.pm_occurrence_history;
CREATE POLICY pm_history_read ON public.pm_occurrence_history FOR SELECT TO authenticated USING (
  public.ja_role() = 'admin'
  OR (public.ja_role() IN ('ss','spv') AND public.pm_user_has_occurrence_department(occurrence_id))
);

DROP POLICY IF EXISTS pm_schedule_history_read ON public.pm_schedule_history;
CREATE POLICY pm_schedule_history_read ON public.pm_schedule_history FOR SELECT TO authenticated USING (
  public.ja_role() = 'admin'
  OR (public.ja_role() IN ('ss','spv') AND public.pm_user_has_schedule_department(schedule_id))
);

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
  IF v_role IN ('ss','spv') AND NOT public.pm_current_user_has_department(v_schedule.department_id) THEN
    RAISE EXCEPTION 'Departemen PM berada di luar cakupan Anda.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.pm_validate_occurrence_assignment_scope() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pm_assign_legacy_schedule(p_schedule_id uuid, p_department_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_schedule public.pm_schedules%ROWTYPE;
  v_role text := public.ja_role();
BEGIN
  IF COALESCE(v_role, '') NOT IN ('admin','ss') THEN RAISE EXCEPTION 'Hanya Admin atau SS yang dapat memetakan jadwal lama.'; END IF;
  IF v_role <> 'admin' AND NOT public.pm_current_user_has_department(p_department_id) THEN
    RAISE EXCEPTION 'Departemen PM berada di luar cakupan profil Anda.';
  END IF;
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = p_schedule_id FOR UPDATE;
  IF NOT FOUND OR v_schedule.department_id IS NOT NULL THEN RAISE EXCEPTION 'Jadwal bukan jadwal lama yang belum dipetakan.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.department_pm_settings WHERE department_id = p_department_id AND pm_enabled) THEN RAISE EXCEPTION 'Aktifkan PM pada departemen tujuan terlebih dahulu.'; END IF;
  IF v_role <> 'admin' AND NOT EXISTS (
    SELECT 1 FROM public.equipment e JOIN public.areas a ON a.id = e.area_id
    WHERE e.id = v_schedule.equipment_id AND a.department_id = p_department_id
  ) THEN
    RAISE EXCEPTION 'Mesin jadwal lama berada di luar departemen tujuan.';
  END IF;
  INSERT INTO public.department_equipment_scope(department_id, equipment_id, created_by)
  VALUES (p_department_id, v_schedule.equipment_id, auth.uid()) ON CONFLICT DO NOTHING;
  UPDATE public.pm_schedules SET department_id = p_department_id, updated_at = now() WHERE id = p_schedule_id;
END;
$$;
REVOKE ALL ON FUNCTION public.pm_assign_legacy_schedule(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_assign_legacy_schedule(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
