-- PM access for supervisors follows the single primary department on profiles.
-- Other modules may still use the broader multi-department assignment helper.
CREATE OR REPLACE FUNCTION public.pm_profile_has_department(p_profile_id uuid, p_department_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_profile_id AND p.department_id = p_department_id
  );
$$;
REVOKE ALL ON FUNCTION public.pm_profile_has_department(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_profile_has_department(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS department_pm_settings_read ON public.department_pm_settings;
CREATE POLICY department_pm_settings_read ON public.department_pm_settings FOR SELECT TO authenticated
  USING (public.ja_role() IN ('admin','ss') OR (public.ja_role() = 'spv' AND public.pm_profile_has_department(auth.uid(), department_id)));

DROP POLICY IF EXISTS department_scope_read ON public.department_equipment_scope;
CREATE POLICY department_scope_read ON public.department_equipment_scope FOR SELECT TO authenticated
  USING (public.ja_role() IN ('admin','ss') OR (public.ja_role() = 'spv' AND public.pm_profile_has_department(auth.uid(), department_id)));

DROP POLICY IF EXISTS pm_schedule_read ON public.pm_schedules;
CREATE POLICY pm_schedule_read ON public.pm_schedules FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss')
  OR (public.ja_role() = 'spv' AND department_id IS NOT NULL AND public.pm_profile_has_department(auth.uid(), department_id))
  OR EXISTS (
    SELECT 1 FROM public.pm_occurrences o
    JOIN public.job_assignments j ON j.id = o.job_assignment_id
    JOIN public.job_assignment_technicians jt ON jt.job_id = j.id
    WHERE o.schedule_id = pm_schedules.id AND jt.technician_id = auth.uid()
  )
);

DROP POLICY IF EXISTS pm_schedule_manage ON public.pm_schedules;
CREATE POLICY pm_schedule_manage ON public.pm_schedules FOR ALL TO authenticated
  USING (public.ja_role() IN ('admin','ss') OR (public.ja_role() = 'spv' AND department_id IS NOT NULL AND public.pm_profile_has_department(auth.uid(), department_id)))
  WITH CHECK (
    department_id IS NOT NULL
    AND (NOT pm_schedules.is_active OR (
      EXISTS (SELECT 1 FROM public.department_pm_settings s WHERE s.department_id = pm_schedules.department_id AND s.pm_enabled)
      AND EXISTS (SELECT 1 FROM public.department_equipment_scope s WHERE s.department_id = pm_schedules.department_id AND s.equipment_id = pm_schedules.equipment_id)
    ))
    AND (public.ja_role() IN ('admin','ss') OR (public.ja_role() = 'spv' AND public.pm_profile_has_department(auth.uid(), pm_schedules.department_id)))
  );

DROP POLICY IF EXISTS pm_occurrence_read ON public.pm_occurrences;
CREATE POLICY pm_occurrence_read ON public.pm_occurrences FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss')
  OR (public.ja_role() = 'spv' AND EXISTS (SELECT 1 FROM public.pm_schedules s WHERE s.id = pm_occurrences.schedule_id AND s.department_id IS NOT NULL AND public.pm_profile_has_department(auth.uid(), s.department_id)))
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
    WHERE o.id = pm_occurrence_history.occurrence_id AND s.department_id IS NOT NULL AND public.pm_profile_has_department(auth.uid(), s.department_id)
  ))
);

DROP POLICY IF EXISTS pm_schedule_history_read ON public.pm_schedule_history;
CREATE POLICY pm_schedule_history_read ON public.pm_schedule_history FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss')
  OR (public.ja_role() = 'spv' AND EXISTS (SELECT 1 FROM public.pm_schedules s WHERE s.id = pm_schedule_history.schedule_id AND s.department_id IS NOT NULL AND public.pm_profile_has_department(auth.uid(), s.department_id)))
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
  IF v_role = 'spv' AND NOT public.pm_profile_has_department(auth.uid(), v_schedule.department_id) THEN
    RAISE EXCEPTION 'Departemen PM berada di luar cakupan Anda.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.pm_validate_occurrence_assignment_scope() FROM PUBLIC, anon, authenticated;
