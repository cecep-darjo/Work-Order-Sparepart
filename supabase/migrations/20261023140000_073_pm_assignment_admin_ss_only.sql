-- Restrict PM technician assignment and reassignment to SS/Admin, including
-- direct table writes, while preserving scheduled carry-over updates.
CREATE OR REPLACE FUNCTION public.pm_guard_assignment_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND COALESCE(public.ja_role(), '') NOT IN ('admin', 'ss')
     AND (
       NEW.job_assignment_id IS DISTINCT FROM OLD.job_assignment_id
       OR (NEW.job_assignment_id IS NOT NULL AND NEW.planned_execution_date IS NOT NULL AND NEW.planned_execution_date IS DISTINCT FROM OLD.planned_execution_date)
     ) THEN
    RAISE EXCEPTION 'Hanya SS atau Admin yang dapat membuat atau mengubah penugasan teknisi PM.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.pm_guard_assignment_role() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS pm_guard_assignment_role ON public.pm_occurrences;
CREATE TRIGGER pm_guard_assignment_role
  BEFORE UPDATE OF job_assignment_id, planned_execution_date ON public.pm_occurrences
  FOR EACH ROW EXECUTE FUNCTION public.pm_guard_assignment_role();

NOTIFY pgrst, 'reload schema';
