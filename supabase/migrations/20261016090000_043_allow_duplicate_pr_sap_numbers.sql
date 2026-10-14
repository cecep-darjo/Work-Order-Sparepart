/*
# 043 - Nomor SAP dan nomor PR boleh sama pada beberapa Purchase Requirement

Latar belakang:
  Nomor SAP (16xxxxxxxx) dan nomor PR (TK/aa/bb/ccccc) hanya informasi yang diketik user dari
  sistem lain. Tabel `purchase_requirements` mendefinisikan `sap_no` dan `pr_no` sebagai UNIQUE
  (migrasi 020), sehingga database menolak nomor yang sama pada PR lain.

Perubahan:
  - Menghapus aturan UNIQUE pada kolom `sap_no` dan pada kolom `pr_no` (masing-masing berdiri
    sendiri). Aturan unik yang melibatkan beberapa kolom atau kolom lain TIDAK disentuh.
  - Format nomor tetap divalidasi oleh fungsi `set_purchase_requirement_numbers` dan
    `admin_update_purchase_requirement_numbers` (SAP 16xxxxxxxx, PR TK/aa/bb/ccccc, aa/bb = bulan
    berjalan untuk pengisian pertama). Hanya pemeriksaan "sudah dipakai PR lain" yang tidak berlaku lagi.
  - Tidak ada data yang diubah.

Aman dijalankan ulang.
*/

DO $$
DECLARE
  r record;
BEGIN
  -- 1) Constraint UNIQUE satu kolom pada sap_no / pr_no (nama otomatis biasanya
  --    purchase_requirements_sap_no_key dan purchase_requirements_pr_no_key).
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.conrelid = 'public.purchase_requirements'::regclass
       AND c.contype = 'u'
       AND array_length(c.conkey, 1) = 1
       AND a.attname IN ('sap_no', 'pr_no')
  LOOP
    EXECUTE format('ALTER TABLE public.purchase_requirements DROP CONSTRAINT %I', r.conname);
  END LOOP;

  -- 2) Unique index mandiri (bukan bagian dari constraint) pada sap_no / pr_no saja (termasuk yang parsial).
  FOR r IN
    SELECT n.nspname AS sch, ic.relname AS idx
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = ic.relnamespace
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indrelid = 'public.purchase_requirements'::regclass
       AND i.indisunique
       AND NOT i.indisprimary
       AND i.indnatts = 1
       AND a.attname IN ('sap_no', 'pr_no')
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
  LOOP
    EXECUTE format('DROP INDEX %I.%I', r.sch, r.idx);
  END LOOP;
END $$;
