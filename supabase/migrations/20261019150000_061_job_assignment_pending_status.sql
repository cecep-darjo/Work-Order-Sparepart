-- Add a manager-controlled pause state for Jobs Assignment work in progress.
ALTER TABLE public.job_assignments
  DROP CONSTRAINT IF EXISTS job_assignments_status_check;

ALTER TABLE public.job_assignments
  ADD CONSTRAINT job_assignments_status_check
  CHECK (status IN ('assigned', 'on_the_way', 'in_progress', 'pending', 'done', 'approved', 'canceled'));

ALTER TABLE public.job_assignments
  ADD COLUMN IF NOT EXISTS pending_reason text;

-- Only SPV/SS/Admin can put a job into Pending or resume it.
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
    IF v_pending_reason IS NULL OR length(btrim(v_pending_reason)) = 0 THEN
      RAISE EXCEPTION 'Isi alasan saat mengubah tugas menjadi Pending.';
    END IF;
    NEW.pending_reason := btrim(v_pending_reason);
    NEW.reviewed_by := OLD.reviewed_by;
    NEW.reviewed_at := OLD.reviewed_at;
    NEW.review_note := OLD.review_note;
  ELSIF OLD.status = 'pending' AND NEW.status = 'in_progress' THEN
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

CREATE OR REPLACE FUNCTION public.ja_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := COALESCE(auth.uid(), NEW.created_by);
  v_action text;
  v_notes text;
  v_log text;
  v_old text;
  v_new text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT full_name INTO v_new FROM public.profiles WHERE id = NEW.technician_id;
    v_action := 'Tugas dibuat';
    v_notes := CASE WHEN NEW.technician_id IS NULL THEN 'Menunggu assignment teknisi' ELSE 'Ditugaskan ke ' || COALESCE(v_new, '-') END;
    v_log := 'job_create';
  ELSIF NEW.technician_id IS DISTINCT FROM OLD.technician_id THEN
    SELECT full_name INTO v_old FROM public.profiles WHERE id = OLD.technician_id;
    SELECT full_name INTO v_new FROM public.profiles WHERE id = NEW.technician_id;
    v_action := CASE WHEN NEW.technician_id IS NULL THEN 'Teknisi dilepas' WHEN OLD.technician_id IS NULL THEN 'Teknisi ditugaskan' ELSE 'Teknisi diganti' END;
    v_notes := COALESCE(v_old, 'Belum ditugaskan') || ' -> ' || COALESCE(v_new, 'Belum ditugaskan');
    v_log := 'job_reassign';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'on_the_way' THEN
      v_action := 'On the Way';
    ELSIF NEW.status = 'in_progress' AND OLD.status = 'done' THEN
      v_action := 'Laporan ditolak, dikerjakan ulang'; v_notes := NEW.review_note; v_log := 'job_reject';
    ELSIF NEW.status = 'in_progress' AND OLD.status = 'pending' THEN
      v_action := 'Pekerjaan dilanjutkan dari Pending'; v_notes := OLD.pending_reason; v_log := 'job_resume';
    ELSIF NEW.status = 'in_progress' THEN
      v_action := 'In Progress (mulai dikerjakan)';
    ELSIF NEW.status = 'pending' THEN
      v_action := 'Pekerjaan ditunda (Pending)'; v_notes := NEW.pending_reason; v_log := 'job_pending';
    ELSIF NEW.status = 'done' THEN
      v_action := 'Done, menunggu approval'; v_notes := NEW.report_notes;
    ELSIF NEW.status = 'approved' THEN
      v_action := 'Laporan disetujui'; v_notes := NEW.review_note; v_log := 'job_approve';
    ELSIF NEW.status = 'canceled' THEN
      v_action := 'Tugas dibatalkan'; v_notes := NEW.review_note; v_log := 'job_cancel';
    ELSE
      RETURN NEW;
    END IF;
  ELSIF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.location IS DISTINCT FROM OLD.location
     OR NEW.deadline IS DISTINCT FROM OLD.deadline
     OR NEW.priority IS DISTINCT FROM OLD.priority THEN
    v_action := 'Detail tugas diubah';
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.job_assignment_history (job_id, status, action, notes, performed_by)
  VALUES (NEW.id, NEW.status, v_action, v_notes, v_actor);
  IF v_log IS NOT NULL AND auth.uid() IS NOT NULL THEN
    INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
    VALUES (auth.uid(), v_log, 'job_assignment', NEW.id, NEW.job_no || ': ' || NEW.title, v_notes);
  END IF;
  RETURN NEW;
END;
$$;
