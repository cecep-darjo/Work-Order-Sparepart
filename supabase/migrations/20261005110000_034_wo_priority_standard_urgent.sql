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

-- 1) Lepaskan constraint lama DULU, supaya step-2 (migrasi data ke 'standard')
--    tidak menabrak check constraint lama yang hanya menerima low/medium/high/urgent.
ALTER TABLE public.work_orders
  DROP CONSTRAINT IF EXISTS work_orders_priority_check;

-- 2) Sesuaikan data lama.
UPDATE public.work_orders
SET priority = 'standard'
WHERE priority IN ('low', 'medium', 'high');

-- 3) Ubah default.
ALTER TABLE public.work_orders
  ALTER COLUMN priority SET DEFAULT 'standard';

-- 4) Terapkan constraint dua nilai saja.
ALTER TABLE public.work_orders
  ADD CONSTRAINT work_orders_priority_check
  CHECK (priority IN ('standard', 'urgent'));