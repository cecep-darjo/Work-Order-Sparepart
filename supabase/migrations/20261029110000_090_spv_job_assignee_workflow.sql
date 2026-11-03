-- Allow an SPV explicitly assigned to a Jobs Assignment to perform the same
-- execution/reporting actions as a technician, without granting manager actions
-- on assignments created by someone else.

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
  v_pending_reason text := NEW.pending_reason;
BEGIN
  NEW.id := OLD.id;
  NEW.job_no := OLD.job_no;
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  v_role := public.ja_role();
  v_assignee := v_role IN ('teknisi', 'spv') AND EXISTS (
    SELECT 1 FROM public.job_assignment_technicians t
    WHERE t.job_id = OLD.id AND t.technician_id = auth.uid()
  );
  v_boss := v_role IN ('admin', 'ss') OR (v_role = 'spv' AND OLD.created_by = auth.uid() AND NOT v_assignee);
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
    NEW.pending_reason := OLD.pending_reason;
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
    NEW.pending_reason := OLD.pending_reason;
    IF NEW.technician_id IS DISTINCT FROM OLD.technician_id THEN
      IF OLD.status = 'done' THEN RAISE EXCEPTION 'Tugas berstatus Done tidak dapat dipindahkan. Tolak laporan terlebih dahulu.'; END IF;
      IF NEW.technician_id IS NOT NULL THEN PERFORM public.ja_assert_technician(NEW.technician_id); END IF;
      NEW.status := 'assigned';
      NEW.on_the_way_at := NULL;
      NEW.started_at := NULL;
      NEW.done_at := NULL;
      NEW.report_notes := NULL;
      NEW.pending_reason := NULL;
    END IF;
    RETURN NEW;
  END IF;

  NEW.report_notes := OLD.report_notes;
  NEW.on_the_way_at := OLD.on_the_way_at;
  NEW.started_at := OLD.started_at;
  NEW.done_at := OLD.done_at;
  NEW.title := OLD.title;
  NEW.description := OLD.description;
  NEW.location := OLD.location;
  NEW.technician_id := OLD.technician_id;
  NEW.deadline := OLD.deadline;
  NEW.priority := OLD.priority;
  NEW.pending_reason := OLD.pending_reason;
  IF OLD.status = 'in_progress' AND NEW.status = 'pending' THEN
    IF v_role = 'spv' AND NOT v_boss THEN RAISE EXCEPTION 'Hanya atasan pengelola yang dapat menunda tugas.'; END IF;
    IF v_pending_reason IS NULL OR length(btrim(v_pending_reason)) = 0 THEN
      RAISE EXCEPTION 'Isi alasan saat mengubah tugas menjadi Pending.';
    END IF;
    NEW.pending_reason := btrim(v_pending_reason);
    NEW.reviewed_by := OLD.reviewed_by;
    NEW.reviewed_at := OLD.reviewed_at;
    NEW.review_note := OLD.review_note;
  ELSIF OLD.status = 'pending' AND NEW.status = 'in_progress' THEN
    IF v_role = 'spv' AND NOT v_boss THEN RAISE EXCEPTION 'Hanya atasan pengelola yang dapat melanjutkan tugas Pending.'; END IF;
    NEW.pending_reason := NULL;
    NEW.reviewed_by := OLD.reviewed_by;
    NEW.reviewed_at := OLD.reviewed_at;
    NEW.review_note := OLD.review_note;
  ELSIF OLD.status = 'done' AND NEW.status = 'approved' THEN
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
    NEW.pending_reason := NULL;
  ELSE
    RAISE EXCEPTION 'Perubahan status % -> % tidak diizinkan.', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS ja_photos_insert ON public.job_assignment_photos;
CREATE POLICY ja_photos_insert ON public.job_assignment_photos FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND public.ja_role() IN ('teknisi', 'spv')
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
    OR (uploaded_by = auth.uid() AND public.ja_role() IN ('teknisi', 'spv') AND EXISTS (
      SELECT 1 FROM public.job_assignments j
      JOIN public.job_assignment_technicians t ON t.job_id = j.id
      WHERE j.id = job_assignment_photos.job_id AND t.technician_id = auth.uid()
        AND j.status IN ('on_the_way', 'in_progress')
    ))
  );

DROP POLICY IF EXISTS job_photo_files_insert ON storage.objects;
CREATE POLICY job_photo_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'job-photo-files'
    AND public.ja_role() IN ('teknisi', 'spv')
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
      OR (public.ja_role() IN ('teknisi', 'spv') AND EXISTS (
        SELECT 1 FROM public.job_assignments j
        JOIN public.job_assignment_technicians t ON t.job_id = j.id
        WHERE j.id::text = (storage.foldername(name))[2]
          AND t.technician_id = auth.uid() AND j.status IN ('on_the_way', 'in_progress')
      ))
    )
  );

NOTIFY pgrst, 'reload schema';
