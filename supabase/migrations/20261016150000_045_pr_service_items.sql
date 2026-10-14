/*
# Skenario C: Item Jasa/Service pada Purchase Requirement

Konsep ringan (tanpa tabel baru & tanpa menyentuh stok):
- `purchase_requirement_items` diberi kolom `is_service` (boolean) dan `service_key` (uuid
  unik untuk mengidentifikasi tiap baris jasa, karena jasa tidak punya spare_part_id).
- Item jasa diisi `spare_part_id = NULL`, nama disimpan di `spare_part_name` (deskripsi jasa),
  dan `quantity` dipakai sebagai volume/perkiraan (mis. jam, paket).
- "Penerimaan" jasa TIDAK lewat `receive_stock_multi` (yang menambah stok fisik). Cukup
  menaikkan `received_qty` PR + catat di activity_log lewat RPC `complete_service_items`.
- PR bisa berisi campuran barang & jasa. PR yang berisi hanya jasa tetap bisa dibuat/dinamori.

Aman dijalankan ulang.
*/

-- =========================================================
-- 1) Kolom baru
-- =========================================================
ALTER TABLE public.purchase_requirement_items
  ADD COLUMN IF NOT EXISTS is_service boolean NOT NULL DEFAULT false;

ALTER TABLE public.purchase_requirement_items
  ADD COLUMN IF NOT EXISTS service_key uuid;

-- Satu jasa unik per baris (jasa tidak bisa digabung secara otomatis seperti barang).
DROP INDEX IF EXISTS uq_pr_items_service_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pr_items_service_key
  ON public.purchase_requirement_items(service_key)
  WHERE service_key IS NOT NULL;

-- =========================================================
-- 2) Buat PR: dukung item barang + jasa
--    Format p_items:
--      barang: { spare_part_id: uuid, quantity: numeric }
--      jasa  : { service_key: uuid, description: text, quantity: numeric }
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
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric)
    WHERE i.quantity IS NULL OR i.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Setiap item harus memiliki quantity lebih besar dari 0.';
  END IF;

  -- Item tanpa spare_part_id dianggap jasa: wajib punya service_key + deskripsi.
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric)
    WHERE i.spare_part_id IS NULL
      AND (i.service_key IS NULL OR i.description IS NULL OR btrim(i.description) = '')
  ) THEN
    RAISE EXCEPTION 'Item jasa harus memiliki uraian yang jelas.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric)
    WHERE i.spare_part_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.spare_parts s WHERE s.id = i.spare_part_id)
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

  -- Barang (spare_part_id sama digabung).
  INSERT INTO public.purchase_requirement_items (pr_id, spare_part_id, spare_part_name, quantity)
  SELECT v_row.id, s.id, s.name, x.quantity
  FROM (
    SELECT i.spare_part_id, SUM(i.quantity) AS quantity
    FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric)
    WHERE i.spare_part_id IS NOT NULL
    GROUP BY i.spare_part_id
  ) x
  JOIN public.spare_parts s ON s.id = x.spare_part_id;

  -- Jasa (tiap baris jadi satu item, is_service = true).
  INSERT INTO public.purchase_requirement_items (pr_id, spare_part_id, spare_part_name, quantity, is_service, service_key)
  SELECT v_row.id, NULL, btrim(i.description), i.quantity, true, i.service_key
  FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric)
  WHERE i.spare_part_id IS NULL;

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
-- 3) Ubah PR: dukung edit barang + jasa
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
    RAISE EXCEPTION 'Daftar item tidak boleh kosong.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric)
    WHERE i.quantity IS NULL OR i.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Setiap item harus memiliki quantity lebih besar dari 0.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric)
    WHERE i.spare_part_id IS NULL
      AND (i.service_key IS NULL OR i.description IS NULL OR btrim(i.description) = '')
  ) THEN
    RAISE EXCEPTION 'Item jasa harus memiliki uraian yang jelas.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric)
    WHERE i.spare_part_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.spare_parts s WHERE s.id = i.spare_part_id)
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

  IF (p_supplier_id IS DISTINCT FROM v_row.supplier_id) AND EXISTS (
    SELECT 1 FROM public.purchase_requirement_items i WHERE i.pr_id = p_pr_id AND i.received_qty > 0
  ) THEN
    RAISE EXCEPTION 'Supplier tidak dapat diganti karena PR ini sudah ada penerimaan.';
  END IF;

  -- Kunci semua item PR ini lebih dulu (urut tetap) agar konsisten.
  PERFORM 1 FROM public.purchase_requirement_items WHERE pr_id = p_pr_id ORDER BY id FOR UPDATE;

  -- Hapus barang/legacy yang tidak ada di daftar baru, dan jasa yang tidak ada lagi.
  FOR v_old IN
    SELECT * FROM public.purchase_requirement_items
    WHERE pr_id = p_pr_id
      AND (
        (NOT is_service AND (spare_part_id IS NULL OR spare_part_id NOT IN (
            SELECT i.spare_part_id FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid) WHERE i.spare_part_id IS NOT NULL
          )))
        OR
        (is_service AND service_key IS NOT NULL AND service_key NOT IN (
            SELECT i.service_key FROM jsonb_to_recordset(p_items) AS i(service_key uuid) WHERE i.service_key IS NOT NULL
          ))
      )
  LOOP
    IF v_old.received_qty > 0 THEN
      RAISE EXCEPTION 'Item % tidak dapat dihapus karena sudah diterima/terpenuhi %.',
        v_old.spare_part_name, v_old.received_qty;
    END IF;
    DELETE FROM public.purchase_requirement_items WHERE id = v_old.id;
  END LOOP;

  -- Barang (part sama digabung).
  FOR v_want IN
    SELECT i.spare_part_id, SUM(i.quantity) AS quantity
    FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric)
    WHERE i.spare_part_id IS NOT NULL
    GROUP BY i.spare_part_id
  LOOP
    SELECT * INTO v_old
    FROM public.purchase_requirement_items
    WHERE pr_id = p_pr_id AND spare_part_id = v_want.spare_part_id AND NOT is_service;

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

  -- Jasa (dikenali lewat service_key).
  FOR v_want IN
    SELECT i.service_key, btrim(i.description) AS description, i.quantity
    FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric)
    WHERE i.spare_part_id IS NULL AND i.service_key IS NOT NULL
  LOOP
    SELECT * INTO v_old
    FROM public.purchase_requirement_items
    WHERE pr_id = p_pr_id AND service_key = v_want.service_key;

    IF FOUND THEN
      IF v_want.quantity < v_old.received_qty THEN
        RAISE EXCEPTION 'Qty jasa % tidak boleh lebih kecil dari yang sudah terpenuhi (%).',
          v_old.spare_part_name, v_old.received_qty;
      END IF;
      UPDATE public.purchase_requirement_items
      SET quantity = v_want.quantity, spare_part_name = v_want.description
      WHERE id = v_old.id;
    ELSE
      INSERT INTO public.purchase_requirement_items
        (pr_id, spare_part_id, spare_part_name, quantity, is_service, service_key)
      VALUES (p_pr_id, NULL, v_want.description, v_want.quantity, true, v_want.service_key);
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

-- =========================================================
-- 4) Penerimaan/penuntasan jasa (TIDAK menyentuh stok)
--    p_completions: [{ service_key: uuid, received_qty: numeric }]
-- =========================================================
CREATE OR REPLACE FUNCTION public.complete_service_items(
  p_pr_id uuid,
  p_completions jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_status text;
  v_row public.purchase_requirement_items%ROWTYPE;
  v_c integer := 0;
  v_j record;
  v_total numeric := 0;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Hanya role inventory/admin yang dapat menuntaskan item jasa.';
  END IF;

  IF p_completions IS NULL OR jsonb_typeof(p_completions) <> 'array' THEN
    RAISE EXCEPTION 'Daftar penuntasan jasa tidak valid.';
  END IF;

  SELECT status INTO v_status FROM public.purchase_requirements WHERE id = p_pr_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'numbered' THEN
    RAISE EXCEPTION 'PR belum memiliki nomor SAP/PR, belum bisa dituntaskan.';
  END IF;

  FOR v_j IN
    SELECT service_key, received_qty
    FROM jsonb_to_recordset(p_completions) AS j(service_key uuid, received_qty numeric)
  LOOP
    SELECT * INTO v_row
    FROM public.purchase_requirement_items
    WHERE pr_id = p_pr_id AND service_key = v_j.service_key
    FOR UPDATE;

    IF NOT FOUND OR NOT v_row.is_service THEN
      RAISE EXCEPTION 'Item jasa tidak ditemukan pada PR ini.';
    END IF;

    IF v_j.received_qty < 0 OR v_j.received_qty > v_row.quantity THEN
      RAISE EXCEPTION 'Jumlah penuntasan jasa % melebihi volume permintaan (%).',
        v_row.spare_part_name, v_row.quantity;
    END IF;

    IF v_j.received_qty < v_row.received_qty THEN
      RAISE EXCEPTION 'Jumlah penuntasan jasa % tidak boleh dikurangi (sudah %).',
        v_row.spare_part_name, v_row.received_qty;
    END IF;

    UPDATE public.purchase_requirement_items
    SET received_qty = v_j.received_qty
    WHERE id = v_row.id;

    v_c := v_c + 1;
    v_total := v_total + v_j.received_qty;
  END LOOP;

  IF v_c > 0 THEN
    INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
    VALUES (auth.uid(), 'complete_service', 'purchase_requirement', p_pr_id,
            'Penyelesaian jasa: ' || v_c::text || ' item jasa dituntaskan.');
  END IF;

  RETURN v_c;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_service_items(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_service_items(uuid, jsonb) TO authenticated;