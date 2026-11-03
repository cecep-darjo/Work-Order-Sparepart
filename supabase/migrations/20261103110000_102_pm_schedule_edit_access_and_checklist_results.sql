-- Restrict PM schedule edits to Admin/SS, retain scoped activation for SPV,
-- and record explicit OK / Not OK checklist results with required comments.

DROP POLICY IF EXISTS pm_schedule_manage ON public.pm_schedules;
DROP POLICY IF EXISTS pm_schedule_manage_admin_ss ON public.pm_schedules;
CREATE POLICY pm_schedule_manage_admin_ss ON public.pm_schedules FOR ALL TO authenticated
  USING (
    public.ja_role() = 'admin'
    OR (public.ja_role() = 'ss' AND public.pm_current_user_has_department(department_id))
  )
  WITH CHECK (
    department_id IS NOT NULL
    AND (NOT is_active OR (
      EXISTS (SELECT 1 FROM public.department_pm_settings s WHERE s.department_id = pm_schedules.department_id AND s.pm_enabled)
      AND EXISTS (SELECT 1 FROM public.department_equipment_scope s WHERE s.department_id = pm_schedules.department_id AND s.equipment_id = pm_schedules.equipment_id)
    ))
    AND (
      public.ja_role() = 'admin'
      OR (public.ja_role() = 'ss' AND public.pm_current_user_has_department(pm_schedules.department_id))
    )
  );

DROP POLICY IF EXISTS pm_schedule_create_spv ON public.pm_schedules;
CREATE POLICY pm_schedule_create_spv ON public.pm_schedules FOR INSERT TO authenticated
  WITH CHECK (
    public.ja_role() = 'spv'
    AND department_id IS NOT NULL
    AND public.pm_current_user_has_department(department_id)
    AND (NOT is_active OR (
      EXISTS (SELECT 1 FROM public.department_pm_settings s WHERE s.department_id = pm_schedules.department_id AND s.pm_enabled)
      AND EXISTS (SELECT 1 FROM public.department_equipment_scope s WHERE s.department_id = pm_schedules.department_id AND s.equipment_id = pm_schedules.equipment_id)
    ))
  );

CREATE OR REPLACE FUNCTION public.pm_set_schedule_active(p_schedule_id uuid, p_is_active boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role text := public.ja_role();
  v_schedule public.pm_schedules%ROWTYPE;
BEGIN
  IF COALESCE(v_role, '') NOT IN ('admin','ss','spv') THEN
    RAISE EXCEPTION 'Anda tidak berwenang mengubah aktivasi jadwal PM.';
  END IF;
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = p_schedule_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Jadwal PM tidak ditemukan.'; END IF;
  IF v_role <> 'admin' AND NOT public.pm_current_user_has_department(v_schedule.department_id) THEN
    RAISE EXCEPTION 'Jadwal PM berada di luar cakupan departemen Anda.';
  END IF;
  IF p_is_active AND (
    NOT EXISTS (SELECT 1 FROM public.department_pm_settings s WHERE s.department_id = v_schedule.department_id AND s.pm_enabled)
    OR NOT EXISTS (SELECT 1 FROM public.department_equipment_scope s WHERE s.department_id = v_schedule.department_id AND s.equipment_id = v_schedule.equipment_id)
  ) THEN
    RAISE EXCEPTION 'Aktifkan PM departemen dan masukkan mesin ke cakupan terlebih dahulu.';
  END IF;
  UPDATE public.pm_schedules SET is_active = p_is_active, updated_at = now() WHERE id = v_schedule.id;
END;
$$;

UPDATE public.pm_assignments a
SET checklist_items = COALESCE((
  SELECT jsonb_agg(
    (item - 'checked') || jsonb_build_object(
      'result', CASE WHEN COALESCE((item->>'checked')::boolean, false) THEN 'ok' ELSE NULL END,
      'note', NULL
    ) ORDER BY ordinal
  )
  FROM jsonb_array_elements(a.checklist_items) WITH ORDINALITY AS entry(item, ordinal)
), '[]'::jsonb)
WHERE jsonb_array_length(a.checklist_items) > 0
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.checklist_items) AS entries(item) WHERE item ? 'checked');

CREATE OR REPLACE FUNCTION public.pm_guard_checklist_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done'
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.checklist_items, '[]'::jsonb)) AS entries(item)
       WHERE COALESCE(item->>'result', '') NOT IN ('ok','not_ok')
          OR (item->>'result' = 'not_ok' AND length(btrim(COALESCE(item->>'note',''))) = 0)
     ) THEN
    RAISE EXCEPTION 'Pilih OK atau Not OK untuk semua item; keterangan wajib untuk hasil Not OK.';
  END IF;
  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS public.pm_set_assignment_checklist_item(uuid, text, boolean);
CREATE OR REPLACE FUNCTION public.pm_set_assignment_checklist_item(
  p_assignment_id uuid, p_item_id text, p_result text, p_note text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_assignment public.pm_assignments%ROWTYPE;
  v_role text := public.ja_role();
  v_can_manage boolean;
  v_is_assignee boolean;
  v_description text;
  v_updated jsonb;
  v_note text := NULLIF(btrim(p_note), '');
BEGIN
  SELECT * INTO v_assignment FROM public.pm_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Penugasan PM tidak ditemukan.'; END IF;
  v_is_assignee := public.pm_user_is_assignment_technician(v_assignment.id);
  SELECT (v_role IN ('admin','ss')) OR (v_role = 'spv' AND public.pm_profile_has_department(auth.uid(), s.department_id))
    INTO v_can_manage
  FROM public.pm_occurrences o JOIN public.pm_schedules s ON s.id = o.schedule_id
  WHERE o.id = v_assignment.occurrence_id;
  IF NOT v_is_assignee AND NOT COALESCE(v_can_manage, false) THEN RAISE EXCEPTION 'Anda tidak berwenang mengubah checklist PM ini.'; END IF;
  IF v_assignment.status IN ('done','approved','canceled') THEN RAISE EXCEPTION 'Checklist tidak dapat diubah setelah penugasan selesai.'; END IF;
  IF p_result IS NULL OR p_result NOT IN ('ok','not_ok') THEN RAISE EXCEPTION 'Pilih hasil checklist OK atau Not OK.'; END IF;
  IF p_result = 'not_ok' AND length(COALESCE(v_note, '')) = 0 THEN RAISE EXCEPTION 'Keterangan wajib diisi untuk hasil Not OK.'; END IF;
  IF length(COALESCE(v_note, '')) > 1000 THEN RAISE EXCEPTION 'Keterangan checklist maksimal 1000 karakter.'; END IF;

  SELECT item->>'description' INTO v_description
  FROM jsonb_array_elements(v_assignment.checklist_items) AS entries(item)
  WHERE item->>'id' = p_item_id;
  IF v_description IS NULL THEN RAISE EXCEPTION 'Item checklist PM tidak ditemukan.'; END IF;
  SELECT jsonb_agg(
    CASE WHEN item->>'id' = p_item_id
      THEN (item - 'checked') || jsonb_build_object('result', p_result, 'note', CASE WHEN p_result = 'not_ok' THEN v_note ELSE NULL END)
      ELSE item
    END
    ORDER BY ordinal
  ) INTO v_updated
  FROM jsonb_array_elements(v_assignment.checklist_items) WITH ORDINALITY AS entry(item, ordinal);
  UPDATE public.pm_assignments SET checklist_items = COALESCE(v_updated, '[]'::jsonb), updated_at = now()
  WHERE id = v_assignment.id;
  INSERT INTO public.pm_assignment_history(assignment_id, status, action, notes, performed_by)
  VALUES (v_assignment.id, v_assignment.status, 'Checklist PM diperbarui',
    p_result || ': ' || v_description || CASE WHEN p_result = 'not_ok' THEN ' — ' || v_note ELSE '' END, auth.uid());
END;
$$;

REVOKE ALL ON FUNCTION public.pm_set_schedule_active(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pm_set_assignment_checklist_item(uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_set_schedule_active(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pm_set_assignment_checklist_item(uuid,text,text,text) TO authenticated;

NOTIFY pgrst, 'reload schema';
