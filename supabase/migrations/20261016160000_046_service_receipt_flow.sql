/*
# Penyelesaian jasa lewat Pemasukan (GR) + satuan jasa (uom)

Perubahan terhadap Skenario C (migrasi 045):
1) Kolom `uom` (satuan) pada `purchase_requirement_items` untuk item jasa. Satuan diambil dari
   master `units_of_measure`.
2) `complete_service_items` DIHAPUS. Penerimaan jasa kini mengikuti alur Pemasukan yang sama
   seperti barang: memakai nomor GR yang sama (`receive_stock_multi`), TETAPI tidak mengubah
   stok/inventory. Riwayat jasa tersimpan di tabel baru `purchase_requirement_service_receipts`.
3) `receive_stock_multi` diperluas: item yang menunjuk PR `is_service` (spare_part_id NULL)
   dicatat sebagai penerimaan jasa (update received_qty PR + insert service_receipts), dan TIDAK
   memanggil `apply_inventory_transaction`. Barang tetap memakai inventory seperti biasa. Satu GR
   bisa berisi campuran barang & jasa.
4) `gr_next_sequence` (penomoran GR) ikut memperhitungkan `service_receipts.gr_no` agar nomor GR
   untuk jasa tidak duplikat/bertabrakan dengan penerimaan lain.

Aman dijalankan ulang.
*/

-- =========================================================
-- 1) Satuan jasa
-- =========================================================
ALTER TABLE public.purchase_requirement_items
  ADD COLUMN IF NOT EXISTS uom text;

-- =========================================================
-- 2) Tabel riwayat penerimaan jasa (terhubung nomor GR)
-- =========================================================
CREATE TABLE IF NOT EXISTS public.purchase_requirement_service_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_item_id uuid NOT NULL REFERENCES public.purchase_requirement_items(id) ON DELETE CASCADE,
  gr_no text NOT NULL,
  gr_kind text NOT NULL,
  received_qty numeric NOT NULL CHECK (received_qty > 0),
  reference text,
  notes text,
  gr_attachments text[],
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_receipts_pr_item
  ON public.purchase_requirement_service_receipts(pr_item_id);
CREATE INDEX IF NOT EXISTS idx_service_receipts_gr_no
  ON public.purchase_requirement_service_receipts(gr_no);

ALTER TABLE public.purchase_requirement_service_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.purchase_requirement_service_receipts FROM anon, authenticated;

DROP POLICY IF EXISTS "read_service_receipts" ON public.purchase_requirement_service_receipts;
CREATE POLICY "read_service_receipts" ON public.purchase_requirement_service_receipts FOR SELECT
  TO authenticated USING (
    public.is_admin_or_ss()
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'inventory')
  );

-- =========================================================
-- 3) Buat PR: item jasa menyimpan satuan (uom)
--    Format p_items:
--      barang: { spare_part_id: uuid, quantity: numeric }
--      jasa  : { service_key: uuid, description: text, quantity: numeric, uom: text }
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
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric, uom text)
    WHERE i.quantity IS NULL OR i.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Setiap item harus memiliki quantity lebih besar dari 0.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric, uom text)
    WHERE i.spare_part_id IS NULL
      AND (i.service_key IS NULL OR i.description IS NULL OR btrim(i.description) = '')
  ) THEN
    RAISE EXCEPTION 'Item jasa harus memiliki uraian yang jelas.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric, uom text)
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
  INSERT INTO public.purchase_requirement_items (pr_id, spare_part_id, spare_part_name, quantity, is_service, service_key, uom)
  SELECT v_row.id, NULL, btrim(i.description), i.quantity, true, i.service_key, NULLIF(btrim(i.uom), '')
  FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric, uom text)
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
-- 4) Ubah PR: item jasa menyimpan satuan (uom)
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
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric, uom text)
    WHERE i.quantity IS NULL OR i.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Setiap item harus memiliki quantity lebih besar dari 0.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric, uom text)
    WHERE i.spare_part_id IS NULL
      AND (i.service_key IS NULL OR i.description IS NULL OR btrim(i.description) = '')
  ) THEN
    RAISE EXCEPTION 'Item jasa harus memiliki uraian yang jelas.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric, uom text)
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
    SELECT i.service_key, btrim(i.description) AS description, i.quantity, NULLIF(btrim(i.uom), '') AS uom
    FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric, uom text)
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
      SET quantity = v_want.quantity, spare_part_name = v_want.description, uom = v_want.uom
      WHERE id = v_old.id;
    ELSE
      INSERT INTO public.purchase_requirement_items
        (pr_id, spare_part_id, spare_part_name, quantity, is_service, service_key, uom)
      VALUES (p_pr_id, NULL, v_want.description, v_want.quantity, true, v_want.service_key, v_want.uom);
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
-- 5) Penomoran GR ikut memperhitungkan penerimaan jasa
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

  SELECT max(u.seq) INTO v_max
  FROM (
    SELECT split_part(t.gr_no, '/', 4)::integer AS seq
    FROM public.inventory_transactions t
    WHERE t.gr_no IS NOT NULL AND t.gr_no ~ '^[0-9]{2}/[A-Z]+/[0-9]{2}/[0-9]{1,9}$'
      AND split_part(t.gr_no, '/', 1) = v_yy
      AND split_part(t.gr_no, '/', 2) = v_code
    UNION
    SELECT split_part(s.gr_no, '/', 4)::integer
    FROM public.purchase_requirement_service_receipts s
    WHERE s.gr_no ~ '^[0-9]{2}/[A-Z]+/[0-9]{2}/[0-9]{1,9}$'
      AND split_part(s.gr_no, '/', 1) = v_yy
      AND split_part(s.gr_no, '/', 2) = v_code
  ) u;

  RETURN GREATEST(v_start, COALESCE(v_max, 0) + 1);
END;
$$;

REVOKE ALL ON FUNCTION public.gr_next_sequence(text) FROM PUBLIC, anon, authenticated;

-- =========================================================
-- 6) Pemasukan multi-item: barang + jasa dalam SATU GR
--    p_items: [{ spare_part_id | null, quantity, pr_item_id | null }]
--    - Barang: spare_part_id diisi -> update stok (inventory_transactions) seperti biasa.
--    - Jasa  : spare_part_id NULL + pr_item_id menunjuk PR is_service -> catat
--      service_receipts + update received_qty PR, TANPA menyentuh stok.
-- =========================================================
CREATE OR REPLACE FUNCTION public.receive_stock_multi(
  p_items jsonb,
  p_gr_kind text,
  p_gr_no text DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_reference text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_gr_attachments text[] DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_item record;
  v_pri public.purchase_requirement_items%ROWTYPE;
  v_pr_status text;
  v_tx public.inventory_transactions%ROWTYPE;
  v_gr_no text := NULLIF(btrim(p_gr_no), '');
  v_count integer := 0;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Hanya role admin atau inventory yang dapat melakukan pemasukan barang.';
  END IF;

  IF p_gr_kind IS NULL OR p_gr_kind NOT IN ('credit','cash','import') THEN
    RAISE EXCEPTION 'Jenis GR tidak valid. Gunakan credit/cash/import.';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Daftar barang tidak boleh kosong.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric, pr_item_id uuid)
    WHERE i.quantity IS NULL OR i.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Setiap barang harus memiliki quantity lebih besar dari 0.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric, pr_item_id uuid)
    WHERE i.spare_part_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.spare_parts s WHERE s.id = i.spare_part_id)
  ) THEN
    RAISE EXCEPTION 'Ada spare part yang tidak ditemukan di master.';
  END IF;

  -- Satu nomor GR untuk seluruh baris.
  IF v_gr_no IS NULL THEN
    v_gr_no := public.next_gr_number(p_gr_kind);
  ELSE
    -- Nomor manual/hasil generate: tolak bila sudah dipakai penerimaan lain (mis. klik ganda).
    PERFORM pg_advisory_xact_lock(hashtext('gr:' || v_gr_no));
    IF EXISTS (SELECT 1 FROM public.inventory_transactions WHERE gr_no = v_gr_no)
       OR EXISTS (SELECT 1 FROM public.purchase_requirement_service_receipts WHERE gr_no = v_gr_no) THEN
      RAISE EXCEPTION 'Nomor GR % sudah dipakai penerimaan lain. Generate nomor GR baru.', v_gr_no;
    END IF;
  END IF;

  -- Urutan tetap (part id, lalu item PR) agar tidak deadlock antar-transaksi.
  FOR v_item IN
    SELECT i.spare_part_id, i.quantity, i.pr_item_id
    FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric, pr_item_id uuid)
    ORDER BY i.spare_part_id NULLS LAST, i.pr_item_id NULLS LAST
  LOOP
    IF v_item.pr_item_id IS NOT NULL THEN
      SELECT * INTO v_pri
      FROM public.purchase_requirement_items
      WHERE id = v_item.pr_item_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Item PR tidak ditemukan.';
      END IF;

      SELECT status INTO v_pr_status FROM public.purchase_requirements WHERE id = v_pri.pr_id;
      IF v_pr_status IS DISTINCT FROM 'numbered' THEN
        RAISE EXCEPTION 'PR untuk % belum memiliki nomor SAP/PR, belum bisa diterima.', v_pri.spare_part_name;
      END IF;

      IF v_pri.received_qty + v_item.quantity > v_pri.quantity THEN
        RAISE EXCEPTION 'Qty terima % (%) melebihi sisa PR. Dipesan: %, sudah diterima: %, sisa: %.',
          v_pri.spare_part_name, v_item.quantity, v_pri.quantity, v_pri.received_qty,
          v_pri.quantity - v_pri.received_qty;
      END IF;

      UPDATE public.purchase_requirement_items
      SET received_qty = received_qty + v_item.quantity
      WHERE id = v_pri.id;

      -- Item jasa: catat riwayat GR, TANPA menyentuh stok/inventory.
      IF v_pri.is_service THEN
        INSERT INTO public.purchase_requirement_service_receipts (
          pr_item_id, gr_no, gr_kind, received_qty, reference, notes, gr_attachments, created_by
        ) VALUES (
          v_pri.id, v_gr_no, p_gr_kind, v_item.quantity, p_reference, p_notes, p_gr_attachments, auth.uid()
        );
        v_count := v_count + 1;
        CONTINUE;
      END IF;

      IF v_pri.spare_part_id IS DISTINCT FROM v_item.spare_part_id THEN
        RAISE EXCEPTION 'Spare part tidak sesuai dengan item PR (%).', v_pri.spare_part_name;
      END IF;
    ELSE
      -- Tanpa item PR: wajib barang (jalur manual).
      IF v_item.spare_part_id IS NULL THEN
        RAISE EXCEPTION 'Barang tidak punya spare part atau item PR.';
      END IF;
    END IF;

    v_tx := public.apply_inventory_transaction(
      v_item.spare_part_id, 'stock_in', v_item.quantity,
      p_reference, p_notes, NULL, p_source, NULL,
      p_gr_kind, v_gr_no, p_gr_attachments
    );

    IF v_item.pr_item_id IS NOT NULL THEN
      UPDATE public.inventory_transactions
      SET pr_item_id = v_item.pr_item_id
      WHERE id = v_tx.id;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'inventory_receipt', 'inventory_transaction', v_tx.id,
          'GR ' || v_gr_no || ' | ' || v_count::text || ' barang/jasa');

  RETURN v_gr_no;
END;
$$;

REVOKE ALL ON FUNCTION public.receive_stock_multi(jsonb, text, text, text, text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_stock_multi(jsonb, text, text, text, text, text, text[]) TO authenticated;

-- =========================================================
-- 7) RPC lama complete_service_items dihapus (alur dipindah ke Pemasukan/GR)
-- =========================================================
DROP FUNCTION IF EXISTS public.complete_service_items(uuid, jsonb);