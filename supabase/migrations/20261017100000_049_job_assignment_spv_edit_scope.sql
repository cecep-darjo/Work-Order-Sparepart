-- Batasi seluruh perubahan penugasan oleh SPV pada tugas yang dibuatnya sendiri.
-- SS dan admin tetap dapat mengubah semua tugas.

CREATE OR REPLACE FUNCTION public.ja_guard_spv_edit_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.ja_role() = 'spv'
     AND OLD.created_by IS DISTINCT FROM auth.uid()
     AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.description IS DISTINCT FROM OLD.description
       OR NEW.location IS DISTINCT FROM OLD.location
       OR NEW.technician_id IS DISTINCT FROM OLD.technician_id
       OR NEW.deadline IS DISTINCT FROM OLD.deadline
       OR NEW.priority IS DISTINCT FROM OLD.priority
     ) THEN
    RAISE EXCEPTION 'SPV hanya dapat mengubah detail penugasan yang dibuatnya sendiri. Hubungi SS atau admin untuk mengubah tugas ini.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.ja_guard_spv_edit_scope() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS ja_spv_edit_scope ON public.job_assignments;
CREATE TRIGGER ja_spv_edit_scope
  BEFORE UPDATE ON public.job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.ja_guard_spv_edit_scope();
