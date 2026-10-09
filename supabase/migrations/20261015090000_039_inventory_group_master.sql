-- Migration: Inventory Group Master
-- Menambahkan kolom untuk mendukung pembuatan kode inventori 9 digit (xxyyyzzzz)
-- di mana:
--   xx   = 2 digit inventaris dari grup (atau bagian dari kode manual)
--   yyy  = 3 digit urutan abjad huruf awal nama part (abjad ON)
--          atau bagian dari kode manual xxyyy (abjad OFF)
--   zzzz = 4 digit nomor urut item dalam grup
-- Kode final disimpan di spare_parts.inventory_code (9 digit).

-- 1) Kolom pada inventory_groups
ALTER TABLE inventory_groups
    ADD COLUMN IF NOT EXISTS use_abjad BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS kode VARCHAR(5) NOT NULL DEFAULT '';

-- isi kode otomatis dari data lama jika kosong (opsional, default 00)
UPDATE inventory_groups
   SET use_abjad = TRUE
 WHERE use_abjad IS NULL;

-- 2) Kolom pada spare_parts untuk menyimpan kode inventori 9 digit
ALTER TABLE spare_parts
    ADD COLUMN IF NOT EXISTS inventory_code VARCHAR(9);

-- 3) Pemicu SQL untuk menghasilkan kode inventori secara konsisten saat insert/update
--    Logika:
--      - hanya aktif bila inventory_code belum diisi manual
--      - bila grup.use_abjad TRUE : kode9 = xx(2) + yyy(3) + zzzz(4)
--      - bila grup.use_abjad FALSE: kode9 = kode_grup(5) + zzzz(4)
--      - zzzz = nomor urut terbesar yang sudah dipakai di grup + 1
CREATE OR REPLACE FUNCTION generate_inventory_code()
RETURNS TRIGGER AS $$
DECLARE
    g RECORD;
    zzzz TEXT;
    next_zz INT;
BEGIN
    IF NEW.group_id IS NULL THEN
        IF NEW.inventory_code IS NULL THEN
            NEW.inventory_code := '';
        END IF;
        RETURN NEW;
    END IF;

    SELECT * INTO g FROM inventory_groups WHERE id = NEW.group_id;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- zzzz = urutan terbesar saat ini di grup + 1
    SELECT COALESCE(MAX((substring(inventory_code FROM 6 FOR 4))::INT), 0) + 1
      INTO next_zz
      FROM spare_parts
     WHERE group_id = NEW.group_id
       AND inventory_code IS NOT NULL
       AND inventory_code ~ '^[0-9]{9}$';

    -- batasi maksimal 4 digit (9999); jika lebih, pakai 0 agar tetap unik
    IF next_zz > 9999 THEN
        next_zz := 0;
    END IF;
    zzzz := LPAD(next_zz::TEXT, 4, '0');

    -- bangun kode penuh
    IF g.use_abjad THEN
        -- xx = 2 digit dari kode grup (default '00' jika kosong)
        -- yyy = urutan abjad huruf awal nama (a=001 ... z=026)
        NEW.inventory_code := LPAD(COALESCE(LEFT(g.kode, 2), ''), 2, '0')
            || CASE
                 WHEN LEFT(NEW.name, 1) ~ '[a-zA-Z]'
                   THEN LPAD(((ASCII(LOWER(LEFT(NEW.name, 1))) - 96))::TEXT, 3, '0')
                 ELSE '000'
               END
            || zzzz;
    ELSE
        -- kode manual berupa 5 digit (xxyyy); pastikan panjang 5
        NEW.inventory_code := LPAD(COALESCE(g.kode, ''), 5, '0') || zzzz;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_generate_inventory_code ON spare_parts;
CREATE TRIGGER trg_generate_inventory_code
    BEFORE INSERT OR UPDATE OF inventory_code, group_id, name ON spare_parts
    FOR EACH ROW
    EXECUTE FUNCTION generate_inventory_code();

-- 4) Backfill kode inventori untuk data yang sudah ada (group_id sudah terisi & inventory_code kosong)
UPDATE spare_parts
   SET inventory_code = inventory_code -- memicu trigger untuk mengisi
 WHERE group_id IS NOT NULL
   AND (inventory_code IS NULL OR inventory_code = '');