-- SPV can be assigned as an executing member in Work Orders and Jobs Assignment.
-- Keep active-user validation; department access remains enforced by existing RLS.
CREATE OR REPLACE FUNCTION public.ja_assert_technician(p_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_id
      AND p.role::text IN ('teknisi', 'spv')
      AND p.is_active = true
  ) THEN
    RAISE EXCEPTION 'Teknisi atau SPV tidak valid atau tidak aktif.';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.ja_assert_technician(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ja_assert_technician(uuid) TO authenticated;
