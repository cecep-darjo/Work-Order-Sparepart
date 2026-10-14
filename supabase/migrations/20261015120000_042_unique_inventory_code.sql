/*
# 042 - Kode inventori harus unik

Dua spare part tidak boleh memiliki `inventory_code` yang sama. Part tanpa kode (kosong / NULL)
boleh banyak, jadi memakai unique index PARSIAL.

Jalankan SETELAH 041. Jika sudah ada kode ganda di data, migrasi ini berhenti dengan pesan yang
menyebut jumlah dan contohnya; tidak ada data yang diubah. Lihat semua kode ganda dengan:

    SELECT inventory_code, COUNT(*) AS jumlah, array_agg(code ORDER BY code) AS code_part
      FROM public.spare_parts
     WHERE inventory_code IS NOT NULL AND inventory_code <> ''
     GROUP BY inventory_code
    HAVING COUNT(*) > 1
     ORDER BY inventory_code;

Perbaiki (mis. kosongkan atau ganti kode salah satunya), lalu jalankan ulang file ini.
Aman dijalankan ulang.
*/

DO $$
DECLARE
  v_groups integer;
  v_sample text;
BEGIN
  SELECT COUNT(*) INTO v_groups
    FROM (
      SELECT inventory_code
        FROM public.spare_parts
       WHERE inventory_code IS NOT NULL AND inventory_code <> ''
       GROUP BY inventory_code
      HAVING COUNT(*) > 1
    ) d;

  IF v_groups > 0 THEN
    SELECT string_agg(inventory_code || ' (' || codes || ')', '; ')
      INTO v_sample
      FROM (
        SELECT inventory_code, string_agg(code, ', ' ORDER BY code) AS codes
          FROM public.spare_parts
         WHERE inventory_code IS NOT NULL AND inventory_code <> ''
         GROUP BY inventory_code
        HAVING COUNT(*) > 1
         ORDER BY inventory_code
         LIMIT 10
      ) s;
    RAISE EXCEPTION 'Tidak bisa membuat unique index: ada % kode inventori ganda. Contoh: %. Jalankan query di komentar atas file ini untuk melihat semuanya, perbaiki, lalu jalankan ulang.', v_groups, v_sample;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_spare_parts_inventory_code
  ON public.spare_parts (inventory_code)
  WHERE inventory_code IS NOT NULL AND inventory_code <> '';
