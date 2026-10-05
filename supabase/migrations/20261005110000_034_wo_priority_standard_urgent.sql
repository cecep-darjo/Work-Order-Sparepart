/*
# Revisi priority Work Order: hanya "standard" dan "urgent"

Kebutuhan:
  Daftar prioritas disederhanakan dari `low/medium/high/urgent` menjadi hanya
  `standard` dan `urgent`, dengan default `standard`.

Perubahan:
  1) Data lama disesuaikan:
     - `low`, `medium`, `high` -> `standard`
     - `urgent` tetap `urgent`
  2) Default kolom `priority` diubah menjadi `'standard'`.
  3) Constraint CHECK diperbarui menjadi `priority IN ('standard','urgent')`.

Catatan:
  - Aman dijalankan ulang.
*/

-- 1) Sesuaikan data lama terlebih dahulu (sebelum menerapkan constraint baru).
UPDATE public.work_orders
SET priority = 'standard'
WHERE priority IN ('low', 'medium', 'high');

-- 2) Ubah default.
ALTER TABLE public.work_orders
  ALTER COLUMN priority SET DEFAULT 'standard';

-- 3) Ganti constraint ke dua nilai saja.
ALTER TABLE public.work_orders
  DROP CONSTRAINT IF EXISTS work_orders_priority_check;

ALTER TABLE public.work_orders
  ADD CONSTRAINT work_orders_priority_check
  CHECK (priority IN ('standard', 'urgent'));