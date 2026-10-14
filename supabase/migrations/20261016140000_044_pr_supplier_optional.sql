/*
# Supplier pada Purchase Requirement menjadi OPSIONAL

Perubahan:
1) purchase_requirements.supplier_id dilepas NOT NULL (opsional).
2) create_purchase_requirement_items & update_purchase_requirement_items
   kini menerima p_supplier_id NULL (tidak lagi wajib ada di inventory_suppliers).

Aman dijalankan ulang.
*/

-- =========================================================
-- 1) Kolom supplier opsional
-- =========================================================
ALTER TABLE public.purchase_requirements ALTER COLUMN supplier_id DROP NOT NULL;

-- =========================================================
-- 2) Buat PR: supplier opsional
-- =========================================================
CREATE OR REPLACE FUNCTION public.create_purchase_requirement_items(
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
  v_count integer;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','ss') THEN
    RAISE EXCEPTION 'Hanya admin/SS yang dapat membuat Purchase Requirement.';
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

  IF p_supplier_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.inventory_suppliers s WHERE s.id = p_supplier_id
  ) THEN
    RAISE EXCEPTION 'Supplier tidak valid.';
  END IF;

  INSERT INTO public.purchase_requirements (
    requester_id, machine_name, supplier_id, created_by
  ) VALUES (
    p_requester_id, NULLIF(btrim(p_machine_name), ''), p_supplier_id, auth.uid()
  )
  RETURNING * INTO v_row;

  -- Part yang sama digabung menjadi satu item.
  INSERT INTO public.purchase_requirement_items (pr_id, spare_part_id, spare_part_name, quantity)
  SELECT v_row.id, s.id, s.name, x.quantity
  FROM (
    SELECT i.spare_part_id, SUM(i.quantity) AS quantity
    FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric)
    GROUP BY i.spare_part_id
  ) x
  JOIN public.spare_parts s ON s.id = x.spare_part_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    'create_purchase_requirement',
    'purchase_requirement',
    v_row.id,
    'PR baru: ' || v_count::text || ' item'
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_purchase_requirement_items(jsonb, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_purchase_requirement_items(jsonb, uuid, text, uuid) TO authenticated;

-- =========================================================
-- 3) Ubah PR: supplier opsional
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

  IF p_supplier_id IS NOT NULL AND NOT EXISTS (
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