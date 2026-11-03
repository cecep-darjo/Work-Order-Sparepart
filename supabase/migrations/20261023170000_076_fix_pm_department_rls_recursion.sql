-- Reuse SECURITY DEFINER lookup helpers inside PM policies. Direct subqueries
-- between pm_schedules and pm_occurrences recurse through their RLS policies.
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
      AND public.pm_profile_has_department(auth.uid(), s.department_id)
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
      AND public.pm_profile_has_department(auth.uid(), s.department_id)
  );
$$;

DROP POLICY IF EXISTS pm_schedule_read ON public.pm_schedules;
CREATE POLICY pm_schedule_read ON public.pm_schedules FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss')
  OR (public.ja_role() = 'spv' AND public.pm_user_has_schedule_department(id))
  OR (public.ja_role() = 'teknisi' AND public.pm_user_has_schedule_assignment(id))
);

DROP POLICY IF EXISTS pm_occurrence_read ON public.pm_occurrences;
CREATE POLICY pm_occurrence_read ON public.pm_occurrences FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss')
  OR (public.ja_role() = 'spv' AND public.pm_user_has_schedule_department(schedule_id))
  OR (public.ja_role() = 'teknisi' AND public.pm_user_has_occurrence_assignment(id))
);

DROP POLICY IF EXISTS pm_history_read ON public.pm_occurrence_history;
CREATE POLICY pm_history_read ON public.pm_occurrence_history FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss')
  OR (public.ja_role() = 'spv' AND public.pm_user_has_occurrence_department(occurrence_id))
);

DROP POLICY IF EXISTS pm_schedule_history_read ON public.pm_schedule_history;
CREATE POLICY pm_schedule_history_read ON public.pm_schedule_history FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss')
  OR (public.ja_role() = 'spv' AND public.pm_user_has_schedule_department(schedule_id))
);

NOTIFY pgrst, 'reload schema';
