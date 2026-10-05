/*
# Kolom tipe pekerjaan (checkpoint) pada work_orders

Kebutuhan:
  Saat membuat/mengedit WO, pengguna bisa menandai jenis pekerjaan yang dapat
  diisi lebih dari satu (checklist multi):
    - Pembuatan
    - Perbaikan
    - Modifikasi
    - Pengadaan

Perubahan:
  1) Tambah kolom `work_types text[]` di `public.work_orders`
     (default array kosong, wajib ada).
  2) Constraint CHECK agar isi array hanya dari nilai yang diizinkan
     (atau kosong). Aman dijalankan ulang.
*/

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS work_types text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.work_orders
  DROP CONSTRAINT IF EXISTS work_orders_work_types_check;

ALTER TABLE public.work_orders
  ADD CONSTRAINT work_orders_work_types_check
  CHECK (
    work_types <@ ARRAY['pembuatan', 'perbaikan', 'modifikasi', 'pengadaan']::text[]
  );