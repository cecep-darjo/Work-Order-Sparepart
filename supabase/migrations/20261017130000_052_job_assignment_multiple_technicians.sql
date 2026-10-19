-- Satu Jobs Assignment dapat dimiliki beberapa teknisi dengan status/laporan bersama.
CREATE TABLE IF NOT EXISTS public.job_assignment_technicians (
  job_id uuid NOT NULL REFERENCES public.job_assignments(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, technician_id)
);

CREATE INDEX IF NOT EXISTS idx_job_assignment_technicians_user
  ON public.job_assignment_technicians(technician_id, job_id);

INSERT INTO public.job_assignment_technicians (job_id, technician_id)
SELECT id, technician_id FROM public.job_assignments
ON CONFLICT DO NOTHING;

ALTER TABLE public.job_assignment_technicians ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_assignment_technicians FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.job_assignment_technicians TO authenticated;

DROP POLICY IF EXISTS ja_team_select ON public.job_assignment_technicians;
CREATE POLICY ja_team_select ON public.job_assignment_technicians FOR SELECT TO authenticated
  USING (COALESCE(public.ja_role(), '') IN ('admin', 'ss', 'spv') OR technician_id = auth.uid());

DROP POLICY IF EXISTS ja_team_insert ON public.job_assignment_technicians;
CREATE POLICY ja_team_insert ON public.job_assignment_technicians FOR INSERT TO authenticated
  WITH CHECK (
    COALESCE(public.ja_role(), '') IN ('admin', 'ss', 'spv')
    AND EXISTS (
      SELECT 1 FROM public.job_assignments j
      WHERE j.id = job_id
        AND (public.ja_role() IN ('admin', 'ss') OR j.created_by = auth.uid())
    )
  );

DROP POLICY IF EXISTS ja_team_delete ON public.job_assignment_technicians;
CREATE POLICY ja_team_delete ON public.job_assignment_technicians FOR DELETE TO authenticated
  USING (
    COALESCE(public.ja_role(), '') IN ('admin', 'ss', 'spv')
    AND EXISTS (
      SELECT 1 FROM public.job_assignments j
      WHERE j.id = job_id
        AND (public.ja_role() IN ('admin', 'ss') OR j.created_by = auth.uid())
    )
  );

CREATE OR REPLACE FUNCTION public.ja_validate_team_technician()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.ja_assert_technician(NEW.technician_id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.ja_validate_team_technician() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ja_validate_team_technician ON public.job_assignment_technicians;
CREATE TRIGGER ja_validate_team_technician
  BEFORE INSERT ON public.job_assignment_technicians
  FOR EACH ROW EXECUTE FUNCTION public.ja_validate_team_technician();

CREATE OR REPLACE FUNCTION public.ja_guard_team_member_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_primary uuid;
  v_member_count int;
BEGIN
  SELECT technician_id INTO v_primary FROM public.job_assignments WHERE id = OLD.job_id;
  SELECT count(*) INTO v_member_count FROM public.job_assignment_technicians WHERE job_id = OLD.job_id;
  IF OLD.technician_id = v_primary THEN
    RAISE EXCEPTION 'Ubah teknisi utama terlebih dahulu sebelum melepas teknisi ini.';
  END IF;
  IF v_member_count <= 1 THEN
    RAISE EXCEPTION 'Penugasan harus memiliki minimal satu teknisi.';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.ja_guard_team_member_delete() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ja_guard_team_member_delete ON public.job_assignment_technicians;
CREATE TRIGGER ja_guard_team_member_delete
  BEFORE DELETE ON public.job_assignment_technicians
  FOR EACH ROW EXECUTE FUNCTION public.ja_guard_team_member_delete();

-- Keep the legacy primary technician as a member for old callers and records.
CREATE OR REPLACE FUNCTION public.ja_sync_primary_technician()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.job_assignment_technicians (job_id, technician_id)
  VALUES (NEW.id, NEW.technician_id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.ja_sync_primary_technician() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ja_sync_primary_technician ON public.job_assignments;
CREATE TRIGGER ja_sync_primary_technician
  AFTER INSERT OR UPDATE ON public.job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.ja_sync_primary_technician();

CREATE OR REPLACE FUNCTION public.ja_team_member_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.job_assignments%ROWTYPE;
  v_technician uuid;
  v_name text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO v_job FROM public.job_assignments j WHERE j.id = OLD.job_id;
    v_technician := OLD.technician_id;
  ELSE
    SELECT * INTO v_job FROM public.job_assignments j WHERE j.id = NEW.job_id;
    v_technician := NEW.technician_id;
  END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_technician;
  INSERT INTO public.job_assignment_history (job_id, status, action, notes, performed_by)
  VALUES (
    v_job.id,
    v_job.status,
    CASE WHEN TG_OP = 'DELETE' THEN 'Teknisi dilepas' ELSE 'Teknisi ditugaskan' END,
    COALESCE(v_name, '-'),
    COALESCE(auth.uid(), v_job.created_by)
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.ja_team_member_history() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ja_team_member_history ON public.job_assignment_technicians;
CREATE TRIGGER ja_team_member_history
  AFTER INSERT OR DELETE ON public.job_assignment_technicians
  FOR EACH ROW EXECUTE FUNCTION public.ja_team_member_history();

-- Every member can view and update the shared job row.
DROP POLICY IF EXISTS ja_select ON public.job_assignments;
CREATE POLICY ja_select ON public.job_assignments FOR SELECT TO authenticated
  USING (
    COALESCE(public.ja_role(), '') IN ('admin', 'ss', 'spv')
    OR EXISTS (
      SELECT 1 FROM public.job_assignment_technicians t
      WHERE t.job_id = id AND t.technician_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS ja_update ON public.job_assignments;
CREATE POLICY ja_update ON public.job_assignments FOR UPDATE TO authenticated
  USING (
    COALESCE(public.ja_role(), '') IN ('admin', 'ss', 'spv')
    OR EXISTS (
      SELECT 1 FROM public.job_assignment_technicians t
      WHERE t.job_id = id AND t.technician_id = auth.uid()
    )
  )
  WITH CHECK (
    COALESCE(public.ja_role(), '') IN ('admin', 'ss', 'spv')
    OR EXISTS (
      SELECT 1 FROM public.job_assignment_technicians t
      WHERE t.job_id = id AND t.technician_id = auth.uid()
    )
  );

-- Apply the same workflow guard, allowing any member to report on the shared job.
CREATE OR REPLACE FUNCTION public.ja_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_boss boolean;
  v_assignee boolean;
  v_photos int;
BEGIN
  NEW.id := OLD.id;
  NEW.job_no := OLD.job_no;
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  v_role := public.ja_role();
  v_boss := COALESCE(v_role, '') IN ('admin', 'ss', 'spv');
  v_assignee := v_role = 'teknisi' AND EXISTS (
    SELECT 1 FROM public.job_assignment_technicians t
    WHERE t.job_id = OLD.id AND t.technician_id = auth.uid()
  );
  IF NOT v_boss AND NOT v_assignee THEN
    RAISE EXCEPTION 'Anda tidak berwenang mengubah tugas ini.';
  END IF;
  IF OLD.status IN ('approved', 'canceled') THEN
    RAISE EXCEPTION 'Tugas sudah final (%) dan tidak dapat diubah.', OLD.status;
  END IF;

  IF v_assignee THEN
    NEW.title := OLD.title;
    NEW.description := OLD.description;
    NEW.location := OLD.location;
    NEW.technician_id := OLD.technician_id;
    NEW.deadline := OLD.deadline;
    NEW.priority := OLD.priority;
    NEW.reviewed_by := OLD.reviewed_by;
    NEW.reviewed_at := OLD.reviewed_at;
    NEW.review_note := OLD.review_note;
    NEW.on_the_way_at := OLD.on_the_way_at;
    NEW.started_at := OLD.started_at;
    NEW.done_at := OLD.done_at;
    IF NEW.status = OLD.status THEN
      IF OLD.status NOT IN ('on_the_way', 'in_progress') THEN NEW.report_notes := OLD.report_notes; END IF;
      RETURN NEW;
    END IF;
    IF NOT (
         (OLD.status = 'assigned' AND NEW.status IN ('on_the_way', 'in_progress'))
      OR (OLD.status = 'on_the_way' AND NEW.status = 'in_progress')
      OR (OLD.status = 'in_progress' AND NEW.status = 'done')
    ) THEN
      RAISE EXCEPTION 'Perubahan status % -> % tidak diizinkan.', OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'on_the_way' THEN
      NEW.on_the_way_at := now();
    ELSIF NEW.status = 'in_progress' THEN
      NEW.started_at := COALESCE(OLD.started_at, now());
    ELSIF NEW.status = 'done' THEN
      SELECT count(*) INTO v_photos FROM public.job_assignment_photos WHERE job_id = OLD.id;
      IF v_photos < 1 THEN RAISE EXCEPTION 'Unggah minimal 1 foto bukti kerja sebelum menyelesaikan tugas.'; END IF;
      IF NEW.report_notes IS NULL OR length(btrim(NEW.report_notes)) = 0 THEN
        RAISE EXCEPTION 'Isi catatan laporan pekerjaan sebelum menyelesaikan tugas.';
      END IF;
      NEW.done_at := now();
      NEW.reviewed_by := NULL;
      NEW.reviewed_at := NULL;
      NEW.review_note := NULL;
    END IF;
    RETURN NEW;
  END IF;

  NEW.report_notes := OLD.report_notes;
  NEW.on_the_way_at := OLD.on_the_way_at;
  NEW.started_at := OLD.started_at;
  NEW.done_at := OLD.done_at;
  IF NEW.status = OLD.status THEN
    NEW.reviewed_by := OLD.reviewed_by;
    NEW.reviewed_at := OLD.reviewed_at;
    NEW.review_note := OLD.review_note;
    IF NEW.technician_id IS DISTINCT FROM OLD.technician_id THEN
      IF OLD.status = 'done' THEN RAISE EXCEPTION 'Tugas berstatus Done tidak dapat dipindahkan. Tolak laporan terlebih dahulu.'; END IF;
      PERFORM public.ja_assert_technician(NEW.technician_id);
      NEW.status := 'assigned';
      NEW.on_the_way_at := NULL;
      NEW.started_at := NULL;
      NEW.done_at := NULL;
      NEW.report_notes := NULL;
    END IF;
    RETURN NEW;
  END IF;

  NEW.title := OLD.title;
  NEW.description := OLD.description;
  NEW.location := OLD.location;
  NEW.technician_id := OLD.technician_id;
  NEW.deadline := OLD.deadline;
  NEW.priority := OLD.priority;
  IF OLD.status = 'done' AND NEW.status = 'approved' THEN
    NEW.reviewed_by := auth.uid();
    NEW.reviewed_at := now();
  ELSIF OLD.status = 'done' AND NEW.status = 'in_progress' THEN
    IF NEW.review_note IS NULL OR length(btrim(NEW.review_note)) = 0 THEN
      RAISE EXCEPTION 'Catatan wajib diisi saat menolak laporan.';
    END IF;
    NEW.reviewed_by := auth.uid();
    NEW.reviewed_at := now();
    NEW.done_at := NULL;
  ELSIF NEW.status = 'canceled' THEN
    IF NEW.review_note IS NULL OR length(btrim(NEW.review_note)) = 0 THEN
      RAISE EXCEPTION 'Alasan wajib diisi saat membatalkan tugas.';
    END IF;
    NEW.reviewed_by := auth.uid();
    NEW.reviewed_at := now();
  ELSE
    RAISE EXCEPTION 'Perubahan status % -> % tidak diizinkan.', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

-- History dan foto dapat diakses oleh seluruh teknisi yang ditugaskan.
DROP POLICY IF EXISTS ja_history_select ON public.job_assignment_history;
CREATE POLICY ja_history_select ON public.job_assignment_history FOR SELECT TO authenticated
  USING (
    COALESCE(public.ja_role(), '') IN ('admin', 'ss', 'spv')
    OR EXISTS (
      SELECT 1 FROM public.job_assignment_technicians t
      WHERE t.job_id = job_assignment_history.job_id AND t.technician_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS ja_photos_select ON public.job_assignment_photos;
CREATE POLICY ja_photos_select ON public.job_assignment_photos FOR SELECT TO authenticated
  USING (
    COALESCE(public.ja_role(), '') IN ('admin', 'ss', 'spv')
    OR EXISTS (
      SELECT 1 FROM public.job_assignment_technicians t
      WHERE t.job_id = job_assignment_photos.job_id AND t.technician_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS ja_photos_insert ON public.job_assignment_photos;
CREATE POLICY ja_photos_insert ON public.job_assignment_photos FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND public.ja_role() = 'teknisi'
    AND EXISTS (
      SELECT 1 FROM public.job_assignments j
      JOIN public.job_assignment_technicians t ON t.job_id = j.id
      WHERE j.id = job_assignment_photos.job_id AND t.technician_id = auth.uid()
        AND j.status IN ('on_the_way', 'in_progress')
    )
  );

DROP POLICY IF EXISTS ja_photos_delete ON public.job_assignment_photos;
CREATE POLICY ja_photos_delete ON public.job_assignment_photos FOR DELETE TO authenticated
  USING (
    public.ja_role() = 'admin'
    OR (
      uploaded_by = auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.job_assignments j
        JOIN public.job_assignment_technicians t ON t.job_id = j.id
        WHERE j.id = job_assignment_photos.job_id AND t.technician_id = auth.uid()
          AND j.status IN ('on_the_way', 'in_progress')
      )
    )
  );

DROP POLICY IF EXISTS job_photo_files_insert ON storage.objects;
CREATE POLICY job_photo_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'job-photo-files'
    AND public.ja_role() = 'teknisi'
    AND EXISTS (
      SELECT 1 FROM public.job_assignments j
      JOIN public.job_assignment_technicians t ON t.job_id = j.id
      WHERE j.id::text = (storage.foldername(name))[2]
        AND t.technician_id = auth.uid() AND j.status IN ('on_the_way', 'in_progress')
    )
  );

DROP POLICY IF EXISTS job_photo_files_delete ON storage.objects;
CREATE POLICY job_photo_files_delete ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'job-photo-files'
    AND (
      public.ja_role() = 'admin'
      OR EXISTS (
        SELECT 1 FROM public.job_assignments j
        JOIN public.job_assignment_technicians t ON t.job_id = j.id
        WHERE j.id::text = (storage.foldername(name))[2]
          AND t.technician_id = auth.uid() AND j.status IN ('on_the_way', 'in_progress')
      )
    )
  );

NOTIFY pgrst, 'reload schema';
