/*
# 040 - Perbaikan Master Grup Inventory

Masalah yang diperbaiki:

1) Tambah grup gagal dengan error:
   null value in column "code" of relation "inventory_groups" violates not-null constraint
   Penyebab: database memiliki kolom `inventory_groups.code` NOT NULL yang tidak ada di migrasi
   repo dan tidak diisi aplikasi (aplikasi memakai kolom `kode`).
   Perbaikan: kolom `code` (jika ada) dibuat boleh NULL. Data lama tidak diubah/dihapus.

2) Trigger `generate_inventory_code` (migrasi 039) menghitung ulang kode setiap kali nama part
   diubah, padahal komentarnya menyatakan hanya aktif bila kode belum diisi manual.
   Akibatnya mengganti nama part bisa mengubah kode inventori dan memakai nomor urut baru.
   Perbaikan:
   - INSERT      : kode yang diisi manual dipertahankan; jika kosong, dibuat otomatis.
   - UPDATE      : kode dibuat ulang HANYA bila kode masih kosong, atau grup part berpindah
                   (dan kode tidak diubah manual pada update yang sama).
   - Ganti nama part TIDAK lagi mengubah kode (trigger tidak lagi memantau kolom name).
   - Pembuatan nomor urut dikunci per grup (advisory lock) agar dua insert bersamaan
     tidak mendapat nomor yang sama.
   - Jika nomor urut grup melebihi 9999, muncul error yang jelas (sebelumnya kembali ke 0
     sehingga bisa menabrak kode lain).

Aman dijalankan ulang.
*/

-- =========================================================
-- 1) inventory_groups.code boleh NULL (bila kolomnya ada)
-- =========================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventory_groups'
      AND column_name = 'code'
  ) THEN
    ALTER TABLE public.inventory_groups ALTER COLUMN code DROP NOT NULL;
  END IF;
END $$;

-- =========================================================
-- 2) Trigger kode inventori 9 digit (xxyyyzzzz)
-- =========================================================
CREATE OR REPLACE FUNCTION public.generate_inventory_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  g        public.inventory_groups%ROWTYPE;
  zzzz     text;
  next_zz  integer;
  v_regen  boolean;
BEGIN
  -- Tanpa grup: kode dikosongkan bila belum ada.
  IF NEW.group_id IS NULL THEN
    IF NEW.inventory_code IS NULL THEN
      NEW.inventory_code := '';
    END IF;
    RETURN NEW;
  END IF;

  -- Tentukan apakah kode perlu dibuat.
  IF TG_OP = 'INSERT' THEN
    v_regen := NEW.inventory_code IS NULL OR NEW.inventory_code = '';
  ELSE
    IF NEW.inventory_code IS NULL OR NEW.inventory_code = '' THEN
      v_regen := true;                                            -- kode masih kosong
    ELSIF NEW.group_id IS DISTINCT FROM OLD.group_id
          AND NEW.inventory_code IS NOT DISTINCT FROM OLD.inventory_code THEN
      v_regen := true;                                            -- pindah grup, kode tidak diubah manual
    ELSE
      v_regen := false;                                           -- ganti nama / kode manual: pertahankan
    END IF;
  END IF;

  IF NOT v_regen THEN
    RETURN NEW;
  END IF;

  SELECT * INTO g FROM public.inventory_groups WHERE id = NEW.group_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Kunci per grup agar nomor urut tidak bentrok pada insert bersamaan.
  PERFORM pg_advisory_xact_lock(hashtext('inventory_code_group_' || NEW.group_id::text));

  -- zzzz = nomor urut terbesar di grup + 1 (nomor milik baris ini sendiri tidak dihitung).
  SELECT COALESCE(MAX((substring(sp.inventory_code FROM 6 FOR 4))::integer), 0) + 1
    INTO next_zz
    FROM public.spare_parts sp
   WHERE sp.group_id = NEW.group_id
     AND sp.id IS DISTINCT FROM NEW.id
     AND sp.inventory_code ~ '^[0-9]{9}$';

  IF next_zz > 9999 THEN
    RAISE EXCEPTION 'Nomor urut grup "%" sudah penuh (maksimal 9999 item).', g.name;
  END IF;
  zzzz := LPAD(next_zz::text, 4, '0');

  IF g.use_abjad IS NOT FALSE THEN
    -- xx (2 digit kode grup) + yyy (urutan abjad huruf awal nama: a=001 ... z=026) + zzzz
    NEW.inventory_code := LPAD(COALESCE(LEFT(g.kode, 2), ''), 2, '0')
      || CASE
           WHEN LEFT(NEW.name, 1) ~ '[a-zA-Z]'
             THEN LPAD((ASCII(LOWER(LEFT(NEW.name, 1))) - 96)::text, 3, '0')
           ELSE '000'
         END
      || zzzz;
  ELSE
    -- kode manual 5 digit (xxyyy) + zzzz
    NEW.inventory_code := LPAD(COALESCE(g.kode, ''), 5, '0') || zzzz;
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger tidak lagi memantau kolom `name`.
DROP TRIGGER IF EXISTS trg_generate_inventory_code ON public.spare_parts;
CREATE TRIGGER trg_generate_inventory_code
  BEFORE INSERT OR UPDATE OF inventory_code, group_id ON public.spare_parts
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_inventory_code();

-- =========================================================
-- 3) Isi kode untuk part yang sudah punya grup tetapi kodenya masih kosong
-- =========================================================
UPDATE public.spare_parts
   SET inventory_code = ''
 WHERE group_id IS NOT NULL
   AND (inventory_code IS NULL OR inventory_code = '');
