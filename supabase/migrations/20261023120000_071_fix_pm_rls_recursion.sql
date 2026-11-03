-- Break the pm_schedules <-> pm_occurrences RLS dependency cycle.
-- SECURITY DEFINER helpers read the related rows as the function owner, while
-- the policies still enforce the caller's role and department/assignment scope.
CREATE OR REPLACE FUNCTION public.pm_user_has_schedule_assignment(p_schedule_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.pm_occurrences o
    JOIN public.job_assignment_technicians jt ON jt.job_id = o.job_assignment_id
    WHERE o.schedule_id = p_schedule_id
      AND jt.technician_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.pm_user_has_schedule_department(p_schedule_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.pm_schedules s
    WHERE s.id = p_schedule_id
      AND s.department_id IS NOT NULL
      AND public.profile_has_department(auth.uid(), s.department_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.pm_user_has_occurrence_assignment(p_occurrence_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.pm_occurrences o
    JOIN public.job_assignment_technicians jt ON jt.job_id = o.job_assignment_id
    WHERE o.id = p_occurrence_id
      AND jt.technician_id = auth.uid()
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
    SELECT 1
    FROM public.pm_occurrences o
    JOIN public.pm_schedules s ON s.id = o.schedule_id
    WHERE o.id = p_occurrence_id
      AND s.department_id IS NOT NULL
      AND public.profile_has_department(auth.uid(), s.department_id)
  );
$$;

REVOKE ALL ON FUNCTION public.pm_user_has_schedule_assignment(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pm_user_has_schedule_department(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pm_user_has_occurrence_assignment(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pm_user_has_occurrence_department(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_user_has_schedule_assignment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pm_user_has_schedule_department(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pm_user_has_occurrence_assignment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pm_user_has_occurrence_department(uuid) TO authenticated;

DROP POLICY IF EXISTS pm_schedule_read ON public.pm_schedules;
CREATE POLICY pm_schedule_read ON public.pm_schedules FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss')
  OR (public.ja_role() = 'spv' AND public.pm_user_has_schedule_department(id))
  OR public.pm_user_has_schedule_assignment(id)
);

DROP POLICY IF EXISTS pm_occurrence_read ON public.pm_occurrences;
CREATE POLICY pm_occurrence_read ON public.pm_occurrences FOR SELECT TO authenticated USING (
  public.ja_role() IN ('admin','ss')
  OR (public.ja_role() = 'spv' AND public.pm_user_has_schedule_department(schedule_id))
  OR public.pm_user_has_occurrence_assignment(id)
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
