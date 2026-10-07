-- =====================================================================
-- IMPORT DATA SPAREPART dari CSV ke tabel spare_parts (upsert by code)
-- Cara pakai:
--   1) Letakkan file CSV kamu di folder yang bisa dibaca postgres,
--      mis. di dalam proyek supabase, lalu import secara manual:
--         COPY _import_spare_parts(...) FROM '/absolute/path/file.csv' WITH (FORMAT csv, HEADER true);
--      ATAU gunakan pgAdmin/psql `\copy` (baca dari client).
--   2) Jalankan script ini dengan menjalankan blok yang relevan.
--      Bagian staging & master perlu dijalankan dulu (bagian A-C).
-- =====================================================================

-- ---------- A. TABEL STAGING ----------
DROP TABLE IF EXISTS public._import_spare_parts;
CREATE TABLE public._import_spare_parts (
  code          text,
  name          text,
  category      text,
  unit          text,
  min_stock     numeric,
  max_stock     numeric,
  current_stock numeric,
  location      text,
  group_name    text      -- opsional: nama grup (bukan id) untuk cocok-kan
);
GRANT ALL ON public._import_spare_parts TO authenticated;

-- ---------- B. IMPORT CSV (contoh via psql \copy) ----------
-- Ganti sesuaikan 'C:/...' dengan path file kamu.
-- \copy public._import_spare_parts FROM 'D:/Monitoring/Work Order/project/import_templates/template_spare_parts.csv' WITH (FORMAT csv, HEADER true)

-- ---------- C. MASTER REFERENSI (opsional) ----------
-- Import/master tambahan: grup, kategori, satuan, lokasi.
-- Jalankan hanya jika kamu ingin mengisi tabel master.
/*
INSERT INTO public.inventory_groups (name, description)
SELECT DISTINCT name, NULL FROM <sumber grup>
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.part_categories (code, name) VALUES ('CAT-BRG','Bearing') ON CONFLICT DO NOTHING;
INSERT INTO public.units_of_measure (code, name) VALUES ('pcs','Pieces') ON CONFLICT DO NOTHING;
INSERT INTO public.part_locations (code, name) VALUES ('A-1','Rak A - Baris 1') ON CONFLICT DO NOTHING;
*/

-- =====================================================================
-- UPSERT ke spare_parts berdasar `code` (tidak membuat duplikat)
-- =====================================================================
WITH src AS (
  SELECT
    sp.code,
    sp.name,
    sp.category,
    COALESCE(sp.unit, 'pcs') AS unit,
    COALESCE(sp.min_stock, 0) AS min_stock,
    COALESCE(sp.max_stock, 0) AS max_stock,
    COALESCE(sp.current_stock, 0) AS current_stock,
    sp.location,
    COALESCE(g.id, NULL) AS group_id
  FROM public._import_spare_parts sp
  LEFT JOIN public.inventory_groups g ON g.name = sp.group_name
  WHERE sp.code IS NOT NULL AND sp.code <> '' AND sp.name IS NOT NULL
)
INSERT INTO public.spare_parts (
  code, name, category, unit, min_stock, max_stock, current_stock, location, group_id
)
SELECT
  code, name, category, unit, min_stock, max_stock, current_stock, location, group_id
FROM src
ON CONFLICT (code) DO UPDATE SET
  name          = EXCLUDED.name,
  category      = EXCLUDED.category,
  unit          = EXCLUDED.unit,
  min_stock     = EXCLUDED.min_stock,
  max_stock     = EXCLUDED.max_stock,
  current_stock = COALESCE(EXCLUDED.current_stock, spare_parts.current_stock),
  location      = EXCLUDED.location,
  group_id      = EXCLUDED.group_id,
  updated_at    = now();

-- ---------- laporan jumlah -------------
SELECT count(*) AS inserted_updated, min(code) AS first_code, max(code) AS last_code
FROM public._import_spare_parts;