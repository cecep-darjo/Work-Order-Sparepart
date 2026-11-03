-- PM supervisors may access the departments explicitly assigned to their
-- profile. The legacy profiles.department_id is used only when no explicit
-- profile_departments rows exist.
CREATE OR REPLACE FUNCTION public.pm_profile_has_department(p_profile_id uuid, p_department_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.profile_departments pd WHERE pd.profile_id = p_profile_id)
      THEN EXISTS (
        SELECT 1 FROM public.profile_departments pd
        WHERE pd.profile_id = p_profile_id AND pd.department_id = p_department_id
      )
    ELSE EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = p_profile_id AND p.department_id = p_department_id
    )
  END;
$$;
REVOKE ALL ON FUNCTION public.pm_profile_has_department(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_profile_has_department(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
