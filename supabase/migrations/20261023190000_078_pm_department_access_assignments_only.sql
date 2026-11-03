-- Do not infer PM access from the legacy primary department column.
-- Supervisors can access only departments explicitly assigned in
-- profile_departments.
CREATE OR REPLACE FUNCTION public.pm_profile_has_department(p_profile_id uuid, p_department_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profile_departments pd
    WHERE pd.profile_id = p_profile_id
      AND pd.department_id = p_department_id
  );
$$;
REVOKE ALL ON FUNCTION public.pm_profile_has_department(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_profile_has_department(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
