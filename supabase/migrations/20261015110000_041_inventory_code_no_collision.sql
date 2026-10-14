/*
# 041 - Kode inventori baru tidak boleh bentrok dengan kode yang sudah ada

Masalah:
  Trigger `generate_inventory_code` (040) menghitung nomor urut (zzzz) hanya dari part yang
  berada di grup yang SAMA. Part yang diimpor tanpa grup (mis. dari CSV dengan inventory_code
  manual) tidak ikut dihitung, sehingga part baru bisa mendapat kode yang sama dengan part hasil
  impor (contoh: grup 10 + huruf "A" + urutan 1 = 100010001 sudah dipakai).

Perbaikan:
  - Nomor urut baru = MAKS(nomor urut terbesar di grup, nomor urut terbesar pada awalan 5 digit
    yang sama [xxyyy], dari SEMUA part termasuk yang tanpa grup) + 1.
  - Penguncian per grup DAN per awalan, agar dua insert bersamaan tidak mendapat nomor sama.
  - Logika lain tidak berubah dari 040: kode manual dipertahankan; ganti nama tidak mengubah kode.

Jalankan SEBELUM 042 (unique index). Aman dijalankan ulang.
*/

CREATE OR REPLACE FUNCTION public.generate_inventory_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  g          public.inventory_groups%ROWTYPE;
  v_prefix   text;
  zzzz       text;
  group_max  integer;
  prefix_max integer;
  next_zz    integer;
  v_regen    boolean;
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

  -- Awalan 5 digit (xxyyy).
  IF g.use_abjad IS NOT FALSE THEN
    -- xx (2 digit kode grup) + yyy (urutan abjad huruf awal nama: a=001 ... z=026)
    v_prefix := LPAD(COALESCE(LEFT(g.kode, 2), ''), 2, '0')
      || CASE
           WHEN LEFT(NEW.name, 1) ~ '[a-zA-Z]'
             THEN LPAD((ASCII(LOWER(LEFT(NEW.name, 1))) - 96)::text, 3, '0')
           ELSE '000'
         END;
  ELSE
    -- kode manual 5 digit (xxyyy)
    v_prefix := LPAD(COALESCE(g.kode, ''), 5, '0');
  END IF;

  -- Kunci per grup dan per awalan (urutan kunci selalu sama agar tidak deadlock).
  PERFORM pg_advisory_xact_lock(hashtext('inventory_code_group_' || NEW.group_id::text));
  PERFORM pg_advisory_xact_lock(hashtext('inventory_code_prefix_' || v_prefix));

  -- Nomor urut terbesar di grup ini (kecuali baris ini sendiri).
  SELECT COALESCE(MAX((substring(sp.inventory_code FROM 6 FOR 4))::integer), 0)
    INTO group_max
    FROM public.spare_parts sp
   WHERE sp.group_id = NEW.group_id
     AND sp.id IS DISTINCT FROM NEW.id
     AND sp.inventory_code ~ '^[0-9]{9}$';

  -- Nomor urut terbesar pada awalan yang sama, dari SEMUA part (termasuk yang tanpa grup).
  SELECT COALESCE(MAX((substring(sp.inventory_code FROM 6 FOR 4))::integer), 0)
    INTO prefix_max
    FROM public.spare_parts sp
   WHERE sp.id IS DISTINCT FROM NEW.id
     AND sp.inventory_code ~ '^[0-9]{9}$'
     AND LEFT(sp.inventory_code, 5) = v_prefix;

  next_zz := GREATEST(group_max, prefix_max) + 1;
  IF next_zz > 9999 THEN
    RAISE EXCEPTION 'Nomor urut grup "%" awalan % sudah penuh (maksimal 9999 item).', g.name, v_prefix;
  END IF;
  zzzz := LPAD(next_zz::text, 4, '0');

  NEW.inventory_code := v_prefix || zzzz;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_generate_inventory_code ON public.spare_parts;
CREATE TRIGGER trg_generate_inventory_code
  BEFORE INSERT OR UPDATE OF inventory_code, group_id ON public.spare_parts
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_inventory_code();
