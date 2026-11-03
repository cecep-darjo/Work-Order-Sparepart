-- Reusable checklist templates, assignment snapshots, technician completion,
-- and private photo evidence for standalone PM assignments.

ALTER TABLE public.pm_schedules
  ADD COLUMN IF NOT EXISTS checklist_items jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.pm_assignments
  ADD COLUMN IF NOT EXISTS checklist_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS evidence_photos text[] NOT NULL DEFAULT ARRAY[]::text[];

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_schedules_checklist_items_array') THEN
    ALTER TABLE public.pm_schedules ADD CONSTRAINT pm_schedules_checklist_items_array
      CHECK (jsonb_typeof(checklist_items) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pm_assignments_checklist_items_array') THEN
    ALTER TABLE public.pm_assignments ADD CONSTRAINT pm_assignments_checklist_items_array
      CHECK (jsonb_typeof(checklist_items) = 'array');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pm_validate_schedule_checklist()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item jsonb;
  v_id text;
  v_description text;
  v_ids text[] := ARRAY[]::text[];
  v_clean jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(NEW.checklist_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Checklist PM harus berupa daftar dengan maksimal 50 item.';
  END IF;
  IF jsonb_array_length(NEW.checklist_items) > 50 THEN
    RAISE EXCEPTION 'Checklist PM harus berupa daftar dengan maksimal 50 item.';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(NEW.checklist_items) AS entries(value) LOOP
    v_id := btrim(COALESCE(v_item->>'id', ''));
    v_description := btrim(COALESCE(v_item->>'description', ''));
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' OR v_id = '' OR length(v_id) > 80
       OR v_description = '' OR length(v_description) > 500 OR v_id = ANY(v_ids) THEN
      RAISE EXCEPTION 'Setiap item checklist PM harus memiliki ID unik dan deskripsi (maksimal 500 karakter).';
    END IF;
    v_ids := array_append(v_ids, v_id);
    v_clean := v_clean || jsonb_build_array(jsonb_build_object('id', v_id, 'description', v_description));
  END LOOP;
  NEW.checklist_items := v_clean;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pm_validate_schedule_checklist ON public.pm_schedules;
CREATE TRIGGER pm_validate_schedule_checklist
BEFORE INSERT OR UPDATE OF checklist_items ON public.pm_schedules
FOR EACH ROW EXECUTE FUNCTION public.pm_validate_schedule_checklist();

CREATE OR REPLACE FUNCTION public.pm_snapshot_assignment_checklist()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_template jsonb;
BEGIN
  IF COALESCE(NEW.checklist_items, '[]'::jsonb) = '[]'::jsonb THEN
    SELECT s.checklist_items INTO v_template
    FROM public.pm_occurrences o
    JOIN public.pm_schedules s ON s.id = o.schedule_id
    WHERE o.id = NEW.occurrence_id;
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object('id', item->>'id', 'description', item->>'description', 'checked', false)
      ORDER BY ordinal
    ), '[]'::jsonb)
    INTO NEW.checklist_items
    FROM jsonb_array_elements(COALESCE(v_template, '[]'::jsonb)) WITH ORDINALITY AS entry(item, ordinal);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pm_snapshot_assignment_checklist ON public.pm_assignments;
CREATE TRIGGER pm_snapshot_assignment_checklist
BEFORE INSERT ON public.pm_assignments
FOR EACH ROW EXECUTE FUNCTION public.pm_snapshot_assignment_checklist();

-- Checklists are copied at assignment time so later edits to a template do not
-- rewrite the technician's historical work. Existing assignments get a snapshot.
UPDATE public.pm_assignments a
SET checklist_items = COALESCE((
  SELECT jsonb_agg(jsonb_build_object('id', item->>'id', 'description', item->>'description', 'checked', false) ORDER BY ordinal)
  FROM public.pm_occurrences o
  JOIN public.pm_schedules s ON s.id = o.schedule_id
  CROSS JOIN LATERAL jsonb_array_elements(s.checklist_items) WITH ORDINALITY AS entry(item, ordinal)
  WHERE o.id = a.occurrence_id
), '[]'::jsonb)
WHERE a.checklist_items = '[]'::jsonb;

CREATE OR REPLACE FUNCTION public.pm_guard_checklist_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done'
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.checklist_items, '[]'::jsonb)) AS entries(item)
       WHERE COALESCE((item->>'checked')::boolean, false) IS NOT TRUE
     ) THEN
    RAISE EXCEPTION 'Centang semua item checklist PM sebelum menyelesaikan penugasan.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pm_guard_checklist_completion ON public.pm_assignments;
CREATE TRIGGER pm_guard_checklist_completion
BEFORE UPDATE OF status ON public.pm_assignments
FOR EACH ROW EXECUTE FUNCTION public.pm_guard_checklist_completion();

CREATE OR REPLACE FUNCTION public.pm_user_can_read_assignment(p_assignment_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.pm_assignments a
    JOIN public.pm_occurrences o ON o.id = a.occurrence_id
    JOIN public.pm_schedules s ON s.id = o.schedule_id
    WHERE a.id = p_assignment_id AND (
      public.ja_role() IN ('admin','ss')
      OR (public.ja_role() = 'spv' AND public.pm_profile_has_department(auth.uid(), s.department_id))
      OR EXISTS (SELECT 1 FROM public.pm_assignment_technicians t WHERE t.assignment_id = a.id AND t.technician_id = auth.uid())
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.pm_user_is_assignment_technician(p_assignment_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.pm_assignment_technicians t
    WHERE t.assignment_id = p_assignment_id AND t.technician_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.pm_set_assignment_checklist_item(
  p_assignment_id uuid, p_item_id text, p_checked boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_assignment public.pm_assignments%ROWTYPE;
  v_role text := public.ja_role();
  v_can_manage boolean;
  v_is_assignee boolean;
  v_description text;
  v_updated jsonb;
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
  SELECT item->>'description' INTO v_description
  FROM jsonb_array_elements(v_assignment.checklist_items) AS entries(item)
  WHERE item->>'id' = p_item_id;
  IF v_description IS NULL THEN RAISE EXCEPTION 'Item checklist PM tidak ditemukan.'; END IF;
  SELECT jsonb_agg(
    CASE WHEN item->>'id' = p_item_id THEN item || jsonb_build_object('checked', p_checked) ELSE item END
    ORDER BY ordinal
  ) INTO v_updated
  FROM jsonb_array_elements(v_assignment.checklist_items) WITH ORDINALITY AS entry(item, ordinal);
  UPDATE public.pm_assignments SET checklist_items = COALESCE(v_updated, '[]'::jsonb), updated_at = now()
  WHERE id = v_assignment.id;
  INSERT INTO public.pm_assignment_history(assignment_id, status, action, notes, performed_by)
  VALUES (v_assignment.id, v_assignment.status, 'Checklist PM diperbarui',
    (CASE WHEN p_checked THEN 'Selesai: ' ELSE 'Belum selesai: ' END) || v_description, auth.uid());
END;
$$;

INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES ('pm-evidence', 'pm-evidence', false, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

DROP POLICY IF EXISTS pm_evidence_read ON storage.objects;
CREATE POLICY pm_evidence_read ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'pm-evidence' AND public.pm_user_can_read_assignment((storage.foldername(name))[1]::uuid));
DROP POLICY IF EXISTS pm_evidence_upload ON storage.objects;
CREATE POLICY pm_evidence_upload ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'pm-evidence'
  AND public.pm_user_is_assignment_technician((storage.foldername(name))[1]::uuid)
  AND (storage.foldername(name))[2] IS NULL
);
DROP POLICY IF EXISTS pm_evidence_delete ON storage.objects;
CREATE POLICY pm_evidence_delete ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'pm-evidence'
  AND public.pm_user_is_assignment_technician((storage.foldername(name))[1]::uuid)
);

CREATE OR REPLACE FUNCTION public.pm_add_assignment_evidence(p_assignment_id uuid, p_storage_path text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_assignment public.pm_assignments%ROWTYPE;
BEGIN
  SELECT * INTO v_assignment FROM public.pm_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Penugasan PM tidak ditemukan.'; END IF;
  IF NOT public.pm_user_is_assignment_technician(p_assignment_id) THEN RAISE EXCEPTION 'Hanya teknisi yang ditugaskan dapat menambahkan foto bukti.'; END IF;
  IF v_assignment.status NOT IN ('assigned','on_the_way','in_progress') THEN RAISE EXCEPTION 'Foto bukti hanya dapat ditambahkan saat PM berjalan.'; END IF;
  IF p_storage_path IS NULL OR p_storage_path NOT LIKE p_assignment_id::text || '/%' OR position('..' IN p_storage_path) > 0 THEN
    RAISE EXCEPTION 'Lokasi file bukti PM tidak valid.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'pm-evidence' AND name = p_storage_path) THEN
    RAISE EXCEPTION 'File foto bukti PM tidak ditemukan.';
  END IF;
  IF cardinality(v_assignment.evidence_photos) >= 10 THEN RAISE EXCEPTION 'Maksimal 10 foto bukti per penugasan PM.'; END IF;
  IF p_storage_path = ANY(v_assignment.evidence_photos) THEN RETURN; END IF;
  UPDATE public.pm_assignments
  SET evidence_photos = array_append(evidence_photos, p_storage_path), updated_at = now()
  WHERE id = p_assignment_id;
  INSERT INTO public.pm_assignment_history(assignment_id, status, action, notes, performed_by)
  VALUES (p_assignment_id, v_assignment.status, 'Foto bukti PM ditambahkan', p_storage_path, auth.uid());
END;
$$;

REVOKE ALL ON FUNCTION public.pm_validate_schedule_checklist() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pm_snapshot_assignment_checklist() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pm_guard_checklist_completion() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pm_user_can_read_assignment(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pm_user_is_assignment_technician(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pm_set_assignment_checklist_item(uuid,text,boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pm_add_assignment_evidence(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_user_can_read_assignment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pm_user_is_assignment_technician(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pm_set_assignment_checklist_item(uuid,text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pm_add_assignment_evidence(uuid,text) TO authenticated;

NOTIFY pgrst, 'reload schema';
