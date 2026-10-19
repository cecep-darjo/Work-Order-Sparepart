-- Allow a Jobs Assignment to store a manually entered target machine name
-- while retaining equipment_id when a master equipment record is selected.
ALTER TABLE public.job_assignments
  ADD COLUMN IF NOT EXISTS manual_equipment text;

-- Treat the manual target name with the same permissions as equipment_id.
CREATE OR REPLACE FUNCTION public.ja_guard_equipment_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  v_role := public.ja_role();
  IF v_role = 'teknisi' OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.equipment_id := OLD.equipment_id;
    NEW.manual_equipment := OLD.manual_equipment;
  ELSIF v_role = 'spv'
        AND OLD.created_by IS DISTINCT FROM auth.uid()
        AND (
          NEW.equipment_id IS DISTINCT FROM OLD.equipment_id
          OR NEW.manual_equipment IS DISTINCT FROM OLD.manual_equipment
        ) THEN
    RAISE EXCEPTION 'SPV hanya dapat mengubah detail penugasan yang dibuatnya sendiri. Hubungi SS atau admin untuk mengubah tugas ini.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.ja_guard_equipment_update() FROM PUBLIC, anon, authenticated;
