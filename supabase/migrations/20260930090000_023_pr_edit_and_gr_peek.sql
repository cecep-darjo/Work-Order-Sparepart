/*
# Edit Purchase Requirement + nomor GR tidak terpakai saat generate

Perubahan:
1) `peek_gr_number(p_gr_kind)`: hanya MELIHAT nomor GR berikutnya (perkiraan) tanpa menaikkan
   counter, sehingga tombol "Generate" di layar tidak lagi menghabiskan nomor. Nomor sebenarnya
   diambil di dalam transaksi `receive_stock_multi` (p_gr_no NULL) dan baru tersimpan bila
   pemasukan berhasil disimpan; jika gagal, counter ikut dibatalkan.
2) `update_purchase_requirement_items(...)`: PR dapat diedit oleh pembuatnya (SS) atau admin,
   baik sebelum maupun sesudah diberi nomor SAP/PR. Pengaman:
   - item yang sudah ada penerimaan (received_qty > 0) tidak boleh dihapus dan qty-nya tidak
     boleh diturunkan di bawah jumlah yang sudah diterima;
   - supplier tidak boleh diganti jika sudah ada penerimaan;
   - item lama yang belum terhubung ke master part akan terhapus bila tidak diganti dengan
     part master (belum pernah bisa diterima).

Aman dijalankan ulang.
*/

-- =========================================================
-- 1) Lihat nomor GR berikutnya tanpa memakainya
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
  v_year integer := EXTRACT(YEAR FROM current_date)::integer;
  v_last integer;
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

  -- Sama dengan next_gr_number: baris counter belum ada -> mulai dari nomor awal; sudah ada -> +1.
  SELECT last_no INTO v_last
  FROM public.gr_number_counters
  WHERE gr_year = v_year AND gr_kind = v_kind;

  IF v_last IS NULL THEN
    v_no := public.get_gr_start_number(v_kind);
  ELSE
    v_no := v_last + 1;
  END IF;

  v_code := CASE v_kind
    WHEN 'credit' THEN 'SKSB'
    WHEN 'cash' THEN 'STSB'
    WHEN 'import' THEN 'SKIS'
    ELSE 'GR'
  END;

  RETURN to_char(current_date, 'YY') || '/' || v_code || '/' || to_char(current_date, 'MM') || '/' || lpad(v_no::text, 5, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.peek_gr_number(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.peek_gr_number(text) TO authenticated;

-- =========================================================
-- 2) Edit PR (pembuat atau admin)
-- =========================================================
CREATE OR REPLACE FUNCTION public.update_purchase_requirement_items(
  p_pr_id uuid,
  p_items jsonb,
  p_requester_id uuid,
  p_machine_name text DEFAULT NULL,
  p_supplier_id uuid DEFAULT NULL
)
RETURNS public.purchase_requirements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_row public.purchase_requirements%ROWTYPE;
  v_old public.purchase_requirement_items%ROWTYPE;
  v_want record;
  v_count integer;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','ss') THEN
    RAISE EXCEPTION 'Hanya pembuat PR atau admin yang dapat mengubah Purchase Requirement.';
  END IF;

  SELECT * INTO v_row
  FROM public.purchase_requirements
  WHERE id = p_pr_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase Requirement tidak ditemukan.';
  END IF;

  IF v_role <> 'admin' AND v_row.created_by <> auth.uid() THEN
    RAISE EXCEPTION 'Anda hanya dapat mengubah PR yang Anda buat sendiri.';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Daftar spare part tidak boleh kosong.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric)
    WHERE i.spare_part_id IS NULL OR i.quantity IS NULL OR i.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Setiap item harus memiliki spare part dan quantity lebih besar dari 0.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric)
    WHERE NOT EXISTS (SELECT 1 FROM public.spare_parts s WHERE s.id = i.spare_part_id)
  ) THEN
    RAISE EXCEPTION 'Ada spare part yang tidak ditemukan di master.';
  END IF;

  IF p_requester_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = p_requester_id
  ) THEN
    RAISE EXCEPTION 'Pemesan tidak valid.';
  END IF;

  IF p_supplier_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.inventory_suppliers s WHERE s.id = p_supplier_id
  ) THEN
    RAISE EXCEPTION 'Supplier tidak valid.';
  END IF;

  IF p_supplier_id <> v_row.supplier_id AND EXISTS (
    SELECT 1 FROM public.purchase_requirement_items i WHERE i.pr_id = p_pr_id AND i.received_qty > 0
  ) THEN
    RAISE EXCEPTION 'Supplier tidak dapat diganti karena PR ini sudah ada penerimaan barang.';
  END IF;

  -- Kunci semua item PR ini lebih dulu (urut tetap) agar konsisten dengan receive_stock_multi.
  PERFORM 1 FROM public.purchase_requirement_items WHERE pr_id = p_pr_id ORDER BY id FOR UPDATE;

  -- Hapus item yang tidak ada lagi di daftar baru (tolak bila sudah ada penerimaan).
  FOR v_old IN
    SELECT * FROM public.purchase_requirement_items
    WHERE pr_id = p_pr_id
      AND (
        spare_part_id IS NULL
        OR spare_part_id NOT IN (
          SELECT i.spare_part_id FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric)
        )
      )
  LOOP
    IF v_old.received_qty > 0 THEN
      RAISE EXCEPTION 'Item % tidak dapat dihapus karena sudah diterima % (ada penerimaan barang).',
        v_old.spare_part_name, v_old.received_qty;
    END IF;
    DELETE FROM public.purchase_requirement_items WHERE id = v_old.id;
  END LOOP;

  -- Tambah / ubah item (part yang sama digabung).
  FOR v_want IN
    SELECT i.spare_part_id, SUM(i.quantity) AS quantity
    FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric)
    GROUP BY i.spare_part_id
  LOOP
    SELECT * INTO v_old
    FROM public.purchase_requirement_items
    WHERE pr_id = p_pr_id AND spare_part_id = v_want.spare_part_id;

    IF FOUND THEN
      IF v_want.quantity < v_old.received_qty THEN
        RAISE EXCEPTION 'Qty % tidak boleh lebih kecil dari yang sudah diterima (%).',
          v_old.spare_part_name, v_old.received_qty;
      END IF;
      UPDATE public.purchase_requirement_items
      SET quantity = v_want.quantity
      WHERE id = v_old.id;
    ELSE
      INSERT INTO public.purchase_requirement_items (pr_id, spare_part_id, spare_part_name, quantity)
      SELECT p_pr_id, s.id, s.name, v_want.quantity
      FROM public.spare_parts s WHERE s.id = v_want.spare_part_id;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_count FROM public.purchase_requirement_items WHERE pr_id = p_pr_id;

  UPDATE public.purchase_requirements
  SET requester_id = p_requester_id,
      machine_name = NULLIF(btrim(p_machine_name), ''),
      supplier_id = p_supplier_id,
      updated_at = now()
  WHERE id = p_pr_id
  RETURNING * INTO v_row;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    'update_purchase_requirement',
    'purchase_requirement',
    v_row.id,
    'PR diubah: ' || v_count::text || ' item' ||
      CASE WHEN v_row.pr_no IS NOT NULL THEN ' | PR ' || v_row.pr_no ELSE '' END
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.update_purchase_requirement_items(uuid, jsonb, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_purchase_requirement_items(uuid, jsonb, uuid, text, uuid) TO authenticated;
