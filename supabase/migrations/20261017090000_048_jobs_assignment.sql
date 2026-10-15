/*
# JOBS ASSIGNMENT — penugasan teknisi

Kebutuhan:
1) Atasan (admin / ss / spv): buat penugasan (judul, lokasi, teknisi, deadline, prioritas),
   pantau status tugas, dan approve / tolak laporan.
2) Teknisi: lihat tugas miliknya, ubah status (On the Way -> In Progress -> Done), dan unggah
   foto bukti kerja.

Alur status:
  assigned ──► on_the_way ──► in_progress ──► done ──► approved
       └────────────────────► in_progress      │
                                  ▲            └─► (ditolak atasan) kembali ke in_progress
  Atasan dapat membatalkan (canceled) selama tugas belum final.

Keamanan (semua dijaga di database, bukan hanya di UI):
- Teknisi hanya melihat tugas miliknya; atasan melihat semua tugas.
- Teknisi hanya boleh mengubah status mengikuti alur di atas + catatan laporan.
  Selesai (Done) WAJIB punya >= 1 foto bukti dan catatan laporan.
- Hanya atasan yang bisa approve / tolak / batalkan / ubah detail / ganti teknisi.
- Tugas yang sudah approved / canceled bersifat final.
- Riwayat (job_assignment_history) dan activity_log diisi otomatis oleh trigger.
- Tidak ada akses DELETE dari aplikasi (kecuali hapus foto oleh pemiliknya / admin).

Penulisan dari SQL Editor (auth.uid() NULL) tidak dibatasi guard agar admin database
tetap bisa memperbaiki data.

Aman dijalankan ulang.
*/

-- ============================================================================
-- Helper: role user aktif yang sedang login (NULL bila tidak aktif / tidak login)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ja_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.role::text FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active = true
$$;

REVOKE ALL ON FUNCTION public.ja_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ja_role() TO authenticated;

CREATE OR REPLACE FUNCTION public.ja_assert_technician(p_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_id AND p.role::text = 'teknisi' AND p.is_active = true
  ) THEN
    RAISE EXCEPTION 'Teknisi tidak valid atau tidak aktif.';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.ja_assert_technician(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ja_assert_technician(uuid) TO authenticated;

-- ============================================================================
-- Tabel
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.job_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_no         text UNIQUE,
  title          text NOT NULL CHECK (length(btrim(title)) > 0),
  description    text,
  location       text NOT NULL CHECK (length(btrim(location)) > 0),
  technician_id  uuid NOT NULL REFERENCES public.profiles(id),
  deadline       timestamptz NOT NULL,
  priority       text NOT NULL DEFAULT 'normal'
                   CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status         text NOT NULL DEFAULT 'assigned'
                   CHECK (status IN ('assigned', 'on_the_way', 'in_progress', 'done', 'approved', 'canceled')),
  created_by     uuid NOT NULL REFERENCES public.profiles(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  on_the_way_at  timestamptz,
  started_at     timestamptz,
  done_at        timestamptz,
  report_notes   text,
  reviewed_by    uuid REFERENCES public.profiles(id),
  reviewed_at    timestamptz,
  review_note    text
);

CREATE INDEX IF NOT EXISTS idx_job_assignments_technician ON public.job_assignments(technician_id);
CREATE INDEX IF NOT EXISTS idx_job_assignments_status ON public.job_assignments(status);
CREATE INDEX IF NOT EXISTS idx_job_assignments_deadline ON public.job_assignments(deadline);

CREATE TABLE IF NOT EXISTS public.job_assignment_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid NOT NULL REFERENCES public.job_assignments(id) ON DELETE CASCADE,
  storage_path  text NOT NULL,
  url           text NOT NULL,
  uploaded_by   uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_photo_path_matches_job CHECK (storage_path LIKE 'jobs/' || job_id::text || '/%')
);

CREATE INDEX IF NOT EXISTS idx_job_photos_job ON public.job_assignment_photos(job_id);

CREATE TABLE IF NOT EXISTS public.job_assignment_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid NOT NULL REFERENCES public.job_assignments(id) ON DELETE CASCADE,
  status        text NOT NULL,
  action        text NOT NULL,
  notes         text,
  performed_by  uuid NOT NULL REFERENCES public.profiles(id),
  performed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_history_job ON public.job_assignment_history(job_id);

-- ============================================================================
-- Trigger: BEFORE INSERT — nomor tugas, nilai awal, validasi
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ja_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_yy  text;
  v_seq int;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF COALESCE(public.ja_role(), '') NOT IN ('admin', 'ss', 'spv') THEN
      RAISE EXCEPTION 'Hanya Admin, SS, atau SPV yang dapat membuat penugasan.';
    END IF;
    NEW.created_by := auth.uid();
  END IF;

  PERFORM public.ja_assert_technician(NEW.technician_id);

  NEW.status := 'assigned';
  NEW.on_the_way_at := NULL;
  NEW.started_at := NULL;
  NEW.done_at := NULL;
  NEW.report_notes := NULL;
  NEW.reviewed_by := NULL;
  NEW.reviewed_at := NULL;
  NEW.review_note := NULL;
  NEW.created_at := now();
  NEW.updated_at := now();

  -- Nomor tugas: JAyy/nnnn, urutan reset tiap tahun (zona waktu Jakarta).
  PERFORM pg_advisory_xact_lock(hashtext('job_assignments_job_no'));
  v_yy := to_char(now() AT TIME ZONE 'Asia/Jakarta', 'YY');
  SELECT COALESCE(MAX(substring(j.job_no FROM '/(\d+)$')::int), 0) + 1
    INTO v_seq
    FROM public.job_assignments j
   WHERE j.job_no LIKE 'JA' || v_yy || '/%';
  NEW.job_no := 'JA' || v_yy || '/' || lpad(v_seq::text, 4, '0');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ja_before_insert ON public.job_assignments;
CREATE TRIGGER ja_before_insert
  BEFORE INSERT ON public.job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.ja_before_insert();

-- ============================================================================
-- Trigger: BEFORE UPDATE — penjaga alur status & hak ubah per kolom
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ja_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     text;
  v_boss     boolean;
  v_assignee boolean;
  v_photos   int;
BEGIN
  -- Kolom yang tidak pernah boleh berubah
  NEW.id := OLD.id;
  NEW.job_no := OLD.job_no;
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();

  -- SQL Editor / service role: tanpa pembatasan
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  v_role := public.ja_role();
  v_boss := COALESCE(v_role, '') IN ('admin', 'ss', 'spv');
  v_assignee := (v_role = 'teknisi' AND OLD.technician_id = auth.uid());

  IF NOT v_boss AND NOT v_assignee THEN
    RAISE EXCEPTION 'Anda tidak berwenang mengubah tugas ini.';
  END IF;

  IF OLD.status IN ('approved', 'canceled') THEN
    RAISE EXCEPTION 'Tugas sudah final (%) dan tidak dapat diubah.', OLD.status;
  END IF;

  -- ------------------------------------------------------------------ TEKNISI
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
      -- Catatan laporan hanya bisa diubah saat tugas sedang dikerjakan
      IF OLD.status NOT IN ('on_the_way', 'in_progress') THEN
        NEW.report_notes := OLD.report_notes;
      END IF;
      RETURN NEW;
    END IF;

    IF NOT (
         (OLD.status = 'assigned'    AND NEW.status IN ('on_the_way', 'in_progress'))
      OR (OLD.status = 'on_the_way'  AND NEW.status = 'in_progress')
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
      IF v_photos < 1 THEN
        RAISE EXCEPTION 'Unggah minimal 1 foto bukti kerja sebelum menyelesaikan tugas.';
      END IF;
      IF NEW.report_notes IS NULL OR length(btrim(NEW.report_notes)) = 0 THEN
        RAISE EXCEPTION 'Isi catatan laporan pekerjaan sebelum menyelesaikan tugas.';
      END IF;
      NEW.done_at := now();
      -- Hasil review sebelumnya (mis. penolakan) tidak berlaku untuk laporan baru
      NEW.reviewed_by := NULL;
      NEW.reviewed_at := NULL;
      NEW.review_note := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- ------------------------------------------------------------------- ATASAN
  -- Kolom milik teknisi tidak boleh diubah atasan
  NEW.report_notes := OLD.report_notes;
  NEW.on_the_way_at := OLD.on_the_way_at;
  NEW.started_at := OLD.started_at;
  NEW.done_at := OLD.done_at;

  IF NEW.status = OLD.status THEN
    -- Ubah detail tugas
    NEW.reviewed_by := OLD.reviewed_by;
    NEW.reviewed_at := OLD.reviewed_at;
    NEW.review_note := OLD.review_note;

    IF NEW.technician_id IS DISTINCT FROM OLD.technician_id THEN
      IF OLD.status = 'done' THEN
        RAISE EXCEPTION 'Tugas berstatus Done tidak dapat dipindahkan. Tolak laporan terlebih dahulu.';
      END IF;
      PERFORM public.ja_assert_technician(NEW.technician_id);
      -- Teknisi baru mulai dari awal
      NEW.status := 'assigned';
      NEW.on_the_way_at := NULL;
      NEW.started_at := NULL;
      NEW.done_at := NULL;
      NEW.report_notes := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- Atasan mengubah status: detail tugas dikunci
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

DROP TRIGGER IF EXISTS ja_guard_update ON public.job_assignments;
CREATE TRIGGER ja_guard_update
  BEFORE UPDATE ON public.job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.ja_guard_update();

-- ============================================================================
-- Trigger: AFTER INSERT/UPDATE — riwayat tugas + activity_log (otomatis)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ja_after_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor  uuid := COALESCE(auth.uid(), NEW.created_by);
  v_action text;
  v_notes  text;
  v_log    text;
  v_old    text;
  v_new    text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT full_name INTO v_new FROM public.profiles WHERE id = NEW.technician_id;
    v_action := 'Tugas dibuat';
    v_notes := 'Ditugaskan ke ' || COALESCE(v_new, '-');
    v_log := 'job_create';

  ELSIF NEW.technician_id IS DISTINCT FROM OLD.technician_id THEN
    SELECT full_name INTO v_old FROM public.profiles WHERE id = OLD.technician_id;
    SELECT full_name INTO v_new FROM public.profiles WHERE id = NEW.technician_id;
    v_action := 'Teknisi diganti';
    v_notes := COALESCE(v_old, '-') || ' -> ' || COALESCE(v_new, '-');
    v_log := 'job_reassign';

  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'on_the_way' THEN
      v_action := 'On the Way';
    ELSIF NEW.status = 'in_progress' AND OLD.status = 'done' THEN
      v_action := 'Laporan ditolak, dikerjakan ulang';
      v_notes := NEW.review_note;
      v_log := 'job_reject';
    ELSIF NEW.status = 'in_progress' THEN
      v_action := 'In Progress (mulai dikerjakan)';
    ELSIF NEW.status = 'done' THEN
      v_action := 'Done, menunggu approval';
      v_notes := NEW.report_notes;
    ELSIF NEW.status = 'approved' THEN
      v_action := 'Laporan disetujui';
      v_notes := NEW.review_note;
      v_log := 'job_approve';
    ELSIF NEW.status = 'canceled' THEN
      v_action := 'Tugas dibatalkan';
      v_notes := NEW.review_note;
      v_log := 'job_cancel';
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
    RETURN NEW; -- mis. hanya catatan laporan: tidak perlu dicatat
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

DROP TRIGGER IF EXISTS ja_after_write ON public.job_assignments;
CREATE TRIGGER ja_after_write
  AFTER INSERT OR UPDATE ON public.job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.ja_after_write();

-- Batas foto per tugas
CREATE OR REPLACE FUNCTION public.ja_photo_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (SELECT count(*) FROM public.job_assignment_photos WHERE job_id = NEW.job_id) >= 10 THEN
    RAISE EXCEPTION 'Maksimal 10 foto per tugas.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ja_photo_limit ON public.job_assignment_photos;
CREATE TRIGGER ja_photo_limit
  BEFORE INSERT ON public.job_assignment_photos
  FOR EACH ROW EXECUTE FUNCTION public.ja_photo_limit();

-- ============================================================================
-- Hak akses tabel + RLS
-- ============================================================================
ALTER TABLE public.job_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_assignment_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_assignment_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.job_assignments, public.job_assignment_photos, public.job_assignment_history
  FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.job_assignments TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.job_assignment_photos TO authenticated;
GRANT SELECT ON public.job_assignment_history TO authenticated;

-- job_assignments
DROP POLICY IF EXISTS "ja_select" ON public.job_assignments;
CREATE POLICY "ja_select" ON public.job_assignments FOR SELECT TO authenticated
  USING (
    COALESCE(public.ja_role(), '') IN ('admin', 'ss', 'spv')
    OR (public.ja_role() = 'teknisi' AND technician_id = auth.uid())
  );

DROP POLICY IF EXISTS "ja_insert" ON public.job_assignments;
CREATE POLICY "ja_insert" ON public.job_assignments FOR INSERT TO authenticated
  WITH CHECK (
    COALESCE(public.ja_role(), '') IN ('admin', 'ss', 'spv')
    AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS "ja_update" ON public.job_assignments;
CREATE POLICY "ja_update" ON public.job_assignments FOR UPDATE TO authenticated
  USING (
    COALESCE(public.ja_role(), '') IN ('admin', 'ss', 'spv')
    OR (public.ja_role() = 'teknisi' AND technician_id = auth.uid())
  )
  WITH CHECK (
    COALESCE(public.ja_role(), '') IN ('admin', 'ss', 'spv')
    OR (public.ja_role() = 'teknisi' AND technician_id = auth.uid())
  );

-- job_assignment_history (hanya baca; ditulis oleh trigger)
DROP POLICY IF EXISTS "ja_history_select" ON public.job_assignment_history;
CREATE POLICY "ja_history_select" ON public.job_assignment_history FOR SELECT TO authenticated
  USING (
    COALESCE(public.ja_role(), '') IN ('admin', 'ss', 'spv')
    OR EXISTS (
      SELECT 1 FROM public.job_assignments j
      WHERE j.id = job_assignment_history.job_id AND j.technician_id = auth.uid()
    )
  );

-- job_assignment_photos
DROP POLICY IF EXISTS "ja_photos_select" ON public.job_assignment_photos;
CREATE POLICY "ja_photos_select" ON public.job_assignment_photos FOR SELECT TO authenticated
  USING (
    COALESCE(public.ja_role(), '') IN ('admin', 'ss', 'spv')
    OR EXISTS (
      SELECT 1 FROM public.job_assignments j
      WHERE j.id = job_assignment_photos.job_id AND j.technician_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "ja_photos_insert" ON public.job_assignment_photos;
CREATE POLICY "ja_photos_insert" ON public.job_assignment_photos FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND public.ja_role() = 'teknisi'
    AND EXISTS (
      SELECT 1 FROM public.job_assignments j
      WHERE j.id = job_assignment_photos.job_id
        AND j.technician_id = auth.uid()
        AND j.status IN ('on_the_way', 'in_progress')
    )
  );

DROP POLICY IF EXISTS "ja_photos_delete" ON public.job_assignment_photos;
CREATE POLICY "ja_photos_delete" ON public.job_assignment_photos FOR DELETE TO authenticated
  USING (
    public.ja_role() = 'admin'
    OR (
      uploaded_by = auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.job_assignments j
        WHERE j.id = job_assignment_photos.job_id
          AND j.technician_id = auth.uid()
          AND j.status IN ('on_the_way', 'in_progress')
      )
    )
  );

-- ============================================================================
-- Storage: bucket foto bukti kerja
-- Foto dikompres di browser hingga <= 500KB; batas bucket 1MB sebagai pengaman.
-- Bucket public (pola sama dengan wo-photo-files) agar foto bisa tampil langsung & masuk PDF.
-- ============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'job-photo-files',
  'job-photo-files',
  true,
  1048576,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "job_photo_files_read" ON storage.objects;
CREATE POLICY "job_photo_files_read" ON storage.objects FOR SELECT
  TO authenticated USING (bucket_id = 'job-photo-files');

-- Path wajib: jobs/<job_id>/<file>. Hanya teknisi penerima tugas (saat on_the_way / in_progress).
DROP POLICY IF EXISTS "job_photo_files_insert" ON storage.objects;
CREATE POLICY "job_photo_files_insert" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (
    bucket_id = 'job-photo-files'
    AND public.ja_role() = 'teknisi'
    AND EXISTS (
      SELECT 1 FROM public.job_assignments j
      WHERE j.id::text = (storage.foldername(name))[2]
        AND j.technician_id = auth.uid()
        AND j.status IN ('on_the_way', 'in_progress')
    )
  );

DROP POLICY IF EXISTS "job_photo_files_delete" ON storage.objects;
CREATE POLICY "job_photo_files_delete" ON storage.objects FOR DELETE
  TO authenticated USING (
    bucket_id = 'job-photo-files'
    AND (
      public.ja_role() = 'admin'
      OR EXISTS (
        SELECT 1 FROM public.job_assignments j
        WHERE j.id::text = (storage.foldername(name))[2]
          AND j.technician_id = auth.uid()
          AND j.status IN ('on_the_way', 'in_progress')
      )
    )
  );

NOTIFY pgrst, 'reload schema';
