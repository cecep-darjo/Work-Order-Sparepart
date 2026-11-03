-- Allow active SPV users to be assigned alongside technicians in Work Orders
-- and Jobs Assignment. The WO trigger was created outside the tracked migration
-- history and still rejected every role except 'teknisi'.
CREATE OR REPLACE FUNCTION public.check_wo_technician_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = NEW.technician_id
      AND role IN ('teknisi', 'spv')
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'User yang dipilih harus teknisi atau SPV aktif.';
  END IF;
  RETURN NEW;
END;
$$;

-- Reuse the same allowed roles for Jobs Assignment validation.
CREATE OR REPLACE FUNCTION public.ja_assert_technician(p_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = p_id
      AND p.role::text IN ('teknisi', 'spv')
      AND p.is_active = true
  ) THEN
    RAISE EXCEPTION 'Teknisi atau SPV tidak valid atau tidak aktif.';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.check_wo_technician_role() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ja_assert_technician(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ja_assert_technician(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
