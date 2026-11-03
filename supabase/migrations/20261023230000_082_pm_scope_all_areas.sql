-- Areas are independent of departments. PM scope is assigned to a department,
-- but the selected machines may come from any area in the equipment catalog.
CREATE OR REPLACE FUNCTION public.pm_save_department_equipment_scope(
  p_department_id uuid,
  p_equipment_ids uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.ja_role();
  v_ids uuid[] := COALESCE(p_equipment_ids, ARRAY[]::uuid[]);
BEGIN
  IF COALESCE(v_role, '') NOT IN ('admin','ss','spv') THEN
    RAISE EXCEPTION 'Anda tidak berwenang mengatur cakupan mesin PM.';
  END IF;
  IF v_role <> 'admin' AND NOT public.pm_current_user_has_department(p_department_id) THEN
    RAISE EXCEPTION 'Departemen PM berada di luar cakupan profil Anda.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.id = p_department_id) THEN
    RAISE EXCEPTION 'Departemen tidak ditemukan.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) requested(id)
    LEFT JOIN public.equipment e ON e.id = requested.id
    WHERE e.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Daftar mesin berisi mesin yang tidak ditemukan.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.department_equipment_scope current_scope
    JOIN public.pm_schedules s
      ON s.department_id = current_scope.department_id
     AND s.equipment_id = current_scope.equipment_id
     AND s.is_active
    WHERE current_scope.department_id = p_department_id
      AND NOT (current_scope.equipment_id = ANY(v_ids))
  ) THEN
    RAISE EXCEPTION 'Nonaktifkan atau pindahkan jadwal PM aktif sebelum mengeluarkan mesinnya dari cakupan departemen.';
  END IF;

  DELETE FROM public.department_equipment_scope WHERE department_id = p_department_id;
  INSERT INTO public.department_equipment_scope(department_id, equipment_id, created_by)
  SELECT p_department_id, selected.id, auth.uid()
  FROM unnest(v_ids) selected(id)
  ON CONFLICT DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.pm_save_department_equipment_scope(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_save_department_equipment_scope(uuid, uuid[]) TO authenticated;

-- Legacy schedules can also be mapped to the selected department regardless of
-- the machine area's optional legacy department_id value.
CREATE OR REPLACE FUNCTION public.pm_assign_legacy_schedule(p_schedule_id uuid, p_department_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_schedule public.pm_schedules%ROWTYPE;
  v_role text := public.ja_role();
BEGIN
  IF COALESCE(v_role, '') NOT IN ('admin','ss') THEN RAISE EXCEPTION 'Hanya Admin atau SS yang dapat memetakan jadwal lama.'; END IF;
  IF v_role <> 'admin' AND NOT public.pm_current_user_has_department(p_department_id) THEN
    RAISE EXCEPTION 'Departemen PM berada di luar cakupan profil Anda.';
  END IF;
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = p_schedule_id FOR UPDATE;
  IF NOT FOUND OR v_schedule.department_id IS NOT NULL THEN RAISE EXCEPTION 'Jadwal bukan jadwal lama yang belum dipetakan.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.department_pm_settings WHERE department_id = p_department_id AND pm_enabled) THEN RAISE EXCEPTION 'Aktifkan PM pada departemen tujuan terlebih dahulu.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.equipment WHERE id = v_schedule.equipment_id) THEN RAISE EXCEPTION 'Mesin jadwal lama tidak ditemukan.'; END IF;
  INSERT INTO public.department_equipment_scope(department_id, equipment_id, created_by)
  VALUES (p_department_id, v_schedule.equipment_id, auth.uid()) ON CONFLICT DO NOTHING;
  UPDATE public.pm_schedules SET department_id = p_department_id, updated_at = now() WHERE id = p_schedule_id;
END;
$$;
REVOKE ALL ON FUNCTION public.pm_assign_legacy_schedule(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_assign_legacy_schedule(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
