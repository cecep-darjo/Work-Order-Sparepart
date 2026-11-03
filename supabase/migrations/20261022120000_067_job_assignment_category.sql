ALTER TABLE public.job_assignments
  ADD COLUMN IF NOT EXISTS work_category text NOT NULL DEFAULT 'perbaikan'
  CHECK (work_category IN ('perbaikan', 'modifikasi', 'tugas_lain'));
