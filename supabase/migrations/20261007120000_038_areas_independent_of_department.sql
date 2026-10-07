/*
# Master Area terlepas dari Departemen

Sebelumnya setiap area wajib terikat ke satu departemen (areas.department_id NOT NULL,
UNIQUE(department_id, name)). Sekarang area didaftar tanpa keterkaitan departemen:
- areas.department_id boleh NULL (kolom dipertahankan agar data lama tidak hilang; tidak lagi dipakai aplikasi).
- Constraint UNIQUE(department_id, name) dilepas.
- Nama area dibuat unik (tanpa memedulikan huruf besar/kecil) HANYA bila data yang ada belum
  memiliki nama kembar. Jika ada nama kembar lintas departemen, indeks tidak dibuat dan muncul NOTICE;
  rapikan/gabungkan nama kembar itu lalu jalankan ulang migration ini.

Foreign key ON DELETE CASCADE ke departments dilepas: menghapus departemen tidak lagi
menghapus area (dan equipment/WO yang terkait) secara berantai.

Aman dijalankan ulang.
*/

ALTER TABLE public.areas ALTER COLUMN department_id DROP NOT NULL;

ALTER TABLE public.areas DROP CONSTRAINT IF EXISTS areas_department_id_name_key;

DO $$
DECLARE
  v_fk text;
BEGIN
  FOR v_fk IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.areas'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.departments'::regclass
  LOOP
    EXECUTE format('ALTER TABLE public.areas DROP CONSTRAINT %I', v_fk);
  END LOOP;

  ALTER TABLE public.areas
    ADD CONSTRAINT areas_department_id_fkey
    FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE SET NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.areas GROUP BY lower(btrim(name)) HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'Ada nama area kembar; indeks unik nama area TIDAK dibuat. Rapikan data lalu jalankan ulang.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS areas_name_unique_idx ON public.areas (lower(btrim(name)));
  END IF;
END $$;
