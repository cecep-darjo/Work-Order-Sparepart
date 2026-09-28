/*
# Master data spare part: kategori, satuan, lokasi + kode part otomatis

Tabel baru (pola sama seperti departments): kode + nama, dikelola dari Admin Panel.
- part_categories   : kategori part (mis. Bearing, Belt, Elektrikal)
- units_of_measure  : satuan (mis. PCS, MTR, LTR)
- part_locations    : lokasi penyimpanan (mis. Rack A-3, Gudang Utama)

spare_parts.category / .unit / .location TETAP kolom teks bebas (tidak diubah jadi
foreign key), supaya data lama tidak rusak dan halaman lain yang membaca .unit sebagai
teks tidak perlu diubah. Di form Tambah/Edit Part, field-field itu kini berupa pilihan
dari master data di atas, bukan ketik bebas.

Kode part (spare_parts.code) dibuat otomatis lewat next_part_code(category_id):
format <KODE_KATEGORI>-00001, nomor urut per kategori. Part tanpa kategori memakai
awalan 'SP'. Fungsi ini juga menghindari tabrakan dengan kode lama yang sudah ada.
*/

CREATE TABLE IF NOT EXISTS public.part_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.units_of_measure (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.part_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.part_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.units_of_measure ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.part_locations ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['part_categories','units_of_measure','part_locations']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "read_%1$s" ON public.%1$s', t);
    EXECUTE format('CREATE POLICY "read_%1$s" ON public.%1$s FOR SELECT TO authenticated USING (true)', t);

    EXECUTE format('DROP POLICY IF EXISTS "manage_%1$s_insert" ON public.%1$s', t);
    EXECUTE format($f$CREATE POLICY "manage_%1$s_insert" ON public.%1$s FOR INSERT
      TO authenticated WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','inventory'))
      )$f$, t);

    EXECUTE format('DROP POLICY IF EXISTS "manage_%1$s_update" ON public.%1$s', t);
    EXECUTE format($f$CREATE POLICY "manage_%1$s_update" ON public.%1$s FOR UPDATE
      TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','inventory'))
      ) WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','inventory'))
      )$f$, t);

    EXECUTE format('DROP POLICY IF EXISTS "manage_%1$s_delete" ON public.%1$s', t);
    EXECUTE format($f$CREATE POLICY "manage_%1$s_delete" ON public.%1$s FOR DELETE
      TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','inventory'))
      )$f$, t);
  END LOOP;
END $$;

-- Isi awal dari kategori/satuan yang sudah dipakai di data lama, supaya tidak hilang.
INSERT INTO public.part_categories (code, name)
SELECT upper(regexp_replace(left(category, 8), '[^A-Za-z0-9]', '', 'g')), category
FROM (SELECT DISTINCT category FROM public.spare_parts WHERE category IS NOT NULL AND btrim(category) <> '') s
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.units_of_measure (code, name)
SELECT upper(regexp_replace(unit, '[^A-Za-z0-9]', '', 'g')), unit
FROM (SELECT DISTINCT unit FROM public.spare_parts WHERE unit IS NOT NULL AND btrim(unit) <> '') s
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.part_locations (code, name)
SELECT upper(regexp_replace(left(location, 8), '[^A-Za-z0-9]', '', 'g')), location
FROM (SELECT DISTINCT location FROM public.spare_parts WHERE location IS NOT NULL AND btrim(location) <> '') s
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.part_code_counters (
  bucket text PRIMARY KEY,
  last_no integer NOT NULL DEFAULT 0
);
ALTER TABLE public.part_code_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.part_code_counters FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.next_part_code(p_category_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket text;
  v_seq integer;
  v_code text;
BEGIN
  IF NOT (public.is_admin() OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'inventory'
  )) THEN
    RAISE EXCEPTION 'Hanya admin atau inventory yang dapat membuat kode part.';
  END IF;

  IF p_category_id IS NOT NULL THEN
    SELECT upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g')) INTO v_bucket
    FROM public.part_categories WHERE id = p_category_id;
  END IF;
  IF v_bucket IS NULL OR v_bucket = '' THEN
    v_bucket := 'SP';
  END IF;

  LOOP
    INSERT INTO public.part_code_counters (bucket, last_no)
    VALUES (v_bucket, 1)
    ON CONFLICT (bucket) DO UPDATE SET last_no = public.part_code_counters.last_no + 1
    RETURNING last_no INTO v_seq;

    v_code := v_bucket || '-' || lpad(v_seq::text, 5, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.spare_parts WHERE code = v_code);
  END LOOP;

  RETURN v_code;
END;
$$;

REVOKE ALL ON FUNCTION public.next_part_code(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_part_code(uuid) TO authenticated;
