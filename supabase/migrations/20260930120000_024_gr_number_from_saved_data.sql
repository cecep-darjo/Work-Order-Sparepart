/*
# Penomoran GR: dihitung dari GR yang TERSIMPAN (tanpa lompat, tanpa duplikat)

Masalah lama:
- Nomor GR diambil dari tabel counter (`gr_number_counters`) yang naik setiap kali
  `next_gr_number` dipanggil, termasuk saat tombol Generate diklik tanpa menyimpan. Akibatnya
  nomor "terbakar" dan melompat.
- "Nomor awal GR" hanya dipakai bila baris counter (tahun + jenis) belum ada, jadi mengatur
  ulang nomor awal tidak berpengaruh setelah counter terlanjur naik.

Perbaikan:
1) Nomor berikutnya = MAX(nomor awal, nomor tersimpan tertinggi pada tahun + jenis itu + 1),
   dihitung dari `inventory_transactions.gr_no`. Nomor hanya "terpakai" bila pemasukan benar-benar
   tersimpan; generate/peek atau simpan yang gagal tidak menghabiskan nomor.
   - Nomor awal yang lebih besar dari nomor tersimpan tertinggi akan dipakai (mis. melanjutkan
     dari dokumen kertas). Nomor awal yang lebih kecil diabaikan agar tidak menabrak nomor lama.
   - Tabel `gr_number_counters` tidak dipakai lagi (dibiarkan, tidak dihapus).
2) `next_gr_number` mengunci per (jenis, tahun) sampai transaksi selesai, sehingga dua simpan
   bersamaan tidak mendapat nomor sama dan tidak ada lubang.
3) Trigger keunikan dokumen: satu nomor GR hanya boleh dipakai oleh satu penerimaan (banyak baris
   dalam satu transaksi tetap boleh). Berlaku untuk semua jalur, termasuk nomor manual.

Catatan: jika GR dengan nomor tertinggi dihapus admin, nomor itu akan dipakai lagi oleh GR
berikutnya (itulah yang membuat urutan tidak berlubang).

Aman dijalankan ulang.
*/

-- =========================================================
-- 1) Hitung nomor urut berikutnya dari data tersimpan
-- =========================================================
CREATE OR REPLACE FUNCTION public.gr_next_sequence(p_gr_kind text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
  v_yy text := to_char(current_date, 'YY');
  v_start integer;
  v_max integer;
BEGIN
  v_code := CASE p_gr_kind
    WHEN 'credit' THEN 'SKSB'
    WHEN 'cash' THEN 'STSB'
    WHEN 'import' THEN 'SKIS'
    ELSE NULL
  END;
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'Jenis GR tidak valid. Gunakan credit/cash/import.';
  END IF;

  v_start := public.get_gr_start_number(p_gr_kind);

  SELECT max(split_part(t.gr_no, '/', 4)::integer) INTO v_max
  FROM public.inventory_transactions t
  WHERE t.gr_no ~ '^[0-9]{2}/[A-Z]+/[0-9]{2}/[0-9]{1,9}$'
    AND split_part(t.gr_no, '/', 1) = v_yy
    AND split_part(t.gr_no, '/', 2) = v_code;

  RETURN GREATEST(v_start, COALESCE(v_max, 0) + 1);
END;
$$;

REVOKE ALL ON FUNCTION public.gr_next_sequence(text) FROM PUBLIC, anon, authenticated;

-- =========================================================
-- 2) Nomor yang benar-benar dipakai (dipanggil di dalam transaksi simpan)
-- =========================================================
CREATE OR REPLACE FUNCTION public.next_gr_number(p_gr_kind text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_kind text;
  v_code text;
  v_no integer;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Hanya admin atau inventory yang dapat membuat nomor GR.';
  END IF;

  v_kind := lower(coalesce(p_gr_kind, ''));
  IF v_kind NOT IN ('credit','cash','import') THEN
    RAISE EXCEPTION 'Jenis GR tidak valid. Gunakan credit/cash/import.';
  END IF;

  -- Serialisasi per (jenis, tahun) sampai transaksi selesai: penyimpan berikutnya menunggu,
  -- lalu melihat GR yang baru tersimpan dan mengambil nomor sesudahnya.
  PERFORM pg_advisory_xact_lock(hashtext('grseq:' || v_kind || ':' || to_char(current_date, 'YY')));

  v_no := public.gr_next_sequence(v_kind);
  IF v_no > 99999 THEN
    RAISE EXCEPTION 'Nomor GR % tahun ini sudah mencapai batas 99999.', v_kind;
  END IF;

  v_code := CASE v_kind WHEN 'credit' THEN 'SKSB' WHEN 'cash' THEN 'STSB' ELSE 'SKIS' END;

  RETURN to_char(current_date, 'YY') || '/' || v_code || '/' || to_char(current_date, 'MM') || '/' || lpad(v_no::text, 5, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.next_gr_number(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_gr_number(text) TO authenticated;

-- =========================================================
-- 3) Lihat nomor berikutnya (tanpa mengunci / memakai)
-- =========================================================
CREATE OR REPLACE FUNCTION public.peek_gr_number(p_gr_kind text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_kind text;
  v_code text;
  v_no integer;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Hanya admin atau inventory yang dapat melihat nomor GR.';
  END IF;

  v_kind := lower(coalesce(p_gr_kind, ''));
  IF v_kind NOT IN ('credit','cash','import') THEN
    RAISE EXCEPTION 'Jenis GR tidak valid. Gunakan credit/cash/import.';
  END IF;

  v_no := public.gr_next_sequence(v_kind);
  v_code := CASE v_kind WHEN 'credit' THEN 'SKSB' WHEN 'cash' THEN 'STSB' ELSE 'SKIS' END;

  RETURN to_char(current_date, 'YY') || '/' || v_code || '/' || to_char(current_date, 'MM') || '/' || lpad(v_no::text, 5, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.peek_gr_number(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.peek_gr_number(text) TO authenticated;

-- =========================================================
-- 4) Keunikan nomor GR per DOKUMEN (bukan per baris)
--    Baris milik penerimaan yang sama selalu satu transaksi (created_at sama).
-- =========================================================
CREATE OR REPLACE FUNCTION public.enforce_gr_document_unique()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.gr_no IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('gr:' || NEW.gr_no));

  IF EXISTS (
    SELECT 1 FROM public.inventory_transactions t
    WHERE t.gr_no = NEW.gr_no AND t.created_at <> NEW.created_at
  ) THEN
    RAISE EXCEPTION 'Nomor GR % sudah dipakai penerimaan lain.', NEW.gr_no;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_tx_gr_document_unique ON public.inventory_transactions;
CREATE TRIGGER trg_inventory_tx_gr_document_unique
  BEFORE INSERT ON public.inventory_transactions
  FOR EACH ROW
  WHEN (NEW.gr_no IS NOT NULL)
  EXECUTE FUNCTION public.enforce_gr_document_unique();
