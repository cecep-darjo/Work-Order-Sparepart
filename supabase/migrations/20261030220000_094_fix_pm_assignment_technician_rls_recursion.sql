-- Avoid a recursive RLS policy chain between pm_assignments and its team table.
CREATE OR REPLACE FUNCTION public.pm_user_can_read_assignment_technicians(p_assignment_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.ja_role();
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  IF v_role IN ('admin','ss') THEN RETURN true; END IF;
  IF v_role = 'spv' THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.pm_assignments a
      JOIN public.pm_occurrences o ON o.id = a.occurrence_id
      JOIN public.pm_schedules s ON s.id = o.schedule_id
      WHERE a.id = p_assignment_id
        AND public.pm_profile_has_department(auth.uid(), s.department_id)
    );
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.pm_assignment_technicians t
    WHERE t.assignment_id = p_assignment_id AND t.technician_id = auth.uid()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pm_user_can_read_assignment_technicians(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_user_can_read_assignment_technicians(uuid) TO authenticated;

DROP POLICY IF EXISTS pm_assignment_technicians_read ON public.pm_assignment_technicians;
CREATE POLICY pm_assignment_technicians_read
ON public.pm_assignment_technicians
FOR SELECT TO authenticated
USING (public.pm_user_can_read_assignment_technicians(assignment_id));

NOTIFY pgrst, 'reload schema';
