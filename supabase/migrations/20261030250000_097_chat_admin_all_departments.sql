-- Admins can access every department chat; other users remain department-scoped.
CREATE OR REPLACE FUNCTION public.chat_is_department_member(p_department_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active
      AND (p.role = 'admin' OR p.department_id = p_department_id OR EXISTS (
        SELECT 1 FROM public.profile_departments pd WHERE pd.profile_id = p.id AND pd.department_id = p_department_id
      ))
  );
$$;

CREATE OR REPLACE FUNCTION public.chat_my_departments()
RETURNS TABLE(id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.name FROM public.departments d
  WHERE public.chat_is_department_member(d.id)
  ORDER BY d.name;
$$;

REVOKE ALL ON FUNCTION public.chat_is_department_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_my_departments() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_is_department_member(uuid), public.chat_my_departments() TO authenticated;
NOTIFY pgrst, 'reload schema';
