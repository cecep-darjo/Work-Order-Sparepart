-- Equipment adalah mesin target perbaikan dan setiap equipment sudah terikat ke Area.
-- Simpan mesin target terpilih pada Jobs Assignment tanpa mengubah data penugasan lama.
ALTER TABLE public.job_assignments
  ADD COLUMN IF NOT EXISTS equipment_id uuid
  REFERENCES public.equipment(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_job_assignments_equipment
  ON public.job_assignments(equipment_id);

-- Teknisi tidak boleh mengganti mesin target, dan perubahan status oleh atasan
-- tidak boleh sekaligus mengubah detail equipment.
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
  ELSIF v_role = 'spv'
        AND OLD.created_by IS DISTINCT FROM auth.uid()
        AND NEW.equipment_id IS DISTINCT FROM OLD.equipment_id THEN
    RAISE EXCEPTION 'SPV hanya dapat mengubah detail penugasan yang dibuatnya sendiri. Hubungi SS atau admin untuk mengubah tugas ini.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.ja_guard_equipment_update() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ja_equipment_guard ON public.job_assignments;
CREATE TRIGGER ja_equipment_guard
  BEFORE UPDATE ON public.job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.ja_guard_equipment_update();
