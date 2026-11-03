-- Repair active PM assignments that predate a schedule checklist or were
-- created before a checklist template was copied to the assignment.
UPDATE public.pm_assignments a
SET checklist_items = COALESCE((
  SELECT jsonb_agg(
    jsonb_build_object('id', item->>'id', 'description', item->>'description', 'result', NULL, 'note', NULL)
    ORDER BY ordinal
  )
  FROM public.pm_occurrences o
  JOIN public.pm_schedules s ON s.id = o.schedule_id
  CROSS JOIN LATERAL jsonb_array_elements(s.checklist_items) WITH ORDINALITY AS entry(item, ordinal)
  WHERE o.id = a.occurrence_id
), '[]'::jsonb)
WHERE a.status IN ('assigned','on_the_way','in_progress','pending')
  AND a.checklist_items = '[]'::jsonb
  AND EXISTS (
    SELECT 1 FROM public.pm_occurrences o
    JOIN public.pm_schedules s ON s.id = o.schedule_id
    WHERE o.id = a.occurrence_id AND jsonb_array_length(s.checklist_items) > 0
  );

-- If an old empty assignment is encountered later, seed its snapshot from the
-- schedule on the first checklist save, then update the requested result.
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
  v_template jsonb;
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

  IF COALESCE(v_assignment.checklist_items, '[]'::jsonb) = '[]'::jsonb THEN
    SELECT s.checklist_items INTO v_template
    FROM public.pm_occurrences o
    JOIN public.pm_schedules s ON s.id = o.schedule_id
    WHERE o.id = v_assignment.occurrence_id;
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object('id', item->>'id', 'description', item->>'description', 'result', NULL, 'note', NULL)
      ORDER BY ordinal
    ), '[]'::jsonb)
    INTO v_assignment.checklist_items
    FROM jsonb_array_elements(COALESCE(v_template, '[]'::jsonb)) WITH ORDINALITY AS entry(item, ordinal);
  END IF;

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

REVOKE ALL ON FUNCTION public.pm_set_assignment_checklist_item(uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_set_assignment_checklist_item(uuid,text,text,text) TO authenticated;

NOTIFY pgrst, 'reload schema';
