/*
# Purchase Requirement multi-item + Pemasukan multi-item + recall dari PR

Perubahan:
1) Purchase Requirement kini satu dokumen (header) berisi banyak item.
   - Tabel baru `purchase_requirement_items` (pr_id, spare_part_id -> spare_parts, quantity,
     received_qty). Nama part diambil dari master spare_parts.
   - Data PR lama (1 baris = 1 part) otomatis dipindah menjadi 1 item. Item dihubungkan ke
     master part HANYA jika nama cocok persis dengan tepat satu spare part; jika tidak,
     spare_part_id dibiarkan NULL (nama lama tetap tersimpan) dan item itu tidak bisa dipanggil
     saat pemasukan.
   - Kolom lama purchase_requirements.spare_part_name & quantity dilepas NOT NULL (tidak dipakai
     lagi untuk PR baru).
   - RPC baru `create_purchase_requirement_items`; RPC lama `create_purchase_requirement`
     dihapus agar tidak ada PR tanpa item.
2) Pemasukan barang multi-item dalam SATU GR, atomik, lewat `receive_stock_multi`.
   - Satu nomor GR untuk semua baris (dibuat otomatis bila belum dikirim). Karena itu unique index
     lama pada gr_no (satu nomor = satu baris) diganti menjadi unik per (gr_no, spare_part_id).
     Nomor GR yang sudah dipakai penerimaan lain tetap ditolak oleh receive_stock_multi.
   - Tiap baris boleh menunjuk item PR (pr_item_id): qty diterima dicatat di
     purchase_requirement_items.received_qty (parsial boleh, tidak boleh melebihi sisa PR) dan
     transaksi tersimpan dengan inventory_transactions.pr_item_id.
   - Hanya PR berstatus `numbered` (sudah punya nomor SAP/PR) yang bisa diterima.
   - Jika satu baris gagal (mis. melebihi sisa PR), seluruh pemasukan dibatalkan.

Aman dijalankan ulang.
*/

-- =========================================================
-- 1) Item PR
-- =========================================================
CREATE TABLE IF NOT EXISTS public.purchase_requirement_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id uuid NOT NULL REFERENCES public.purchase_requirements(id) ON DELETE CASCADE,
  spare_part_id uuid REFERENCES public.spare_parts(id) ON DELETE RESTRICT,
  spare_part_name text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  received_qty numeric NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pr_items_pr ON public.purchase_requirement_items(pr_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pr_items_pr_part
  ON public.purchase_requirement_items(pr_id, spare_part_id)
  WHERE spare_part_id IS NOT NULL;

ALTER TABLE public.purchase_requirement_items ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.purchase_requirement_items FROM anon, authenticated;

-- Siapa yang boleh melihat header PR (lihat policy read_purchase_requirements) boleh melihat item-nya.
DROP POLICY IF EXISTS "read_purchase_requirement_items" ON public.purchase_requirement_items;
CREATE POLICY "read_purchase_requirement_items" ON public.purchase_requirement_items FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.purchase_requirements h WHERE h.id = purchase_requirement_items.pr_id)
  );

-- Header lama tidak lagi wajib berisi nama/qty (PR baru menyimpannya di item).
ALTER TABLE public.purchase_requirements ALTER COLUMN spare_part_name DROP NOT NULL;
ALTER TABLE public.purchase_requirements ALTER COLUMN quantity DROP NOT NULL;

-- Pindahkan PR lama -> 1 item per PR (hanya yang belum punya item).
INSERT INTO public.purchase_requirement_items (pr_id, spare_part_id, spare_part_name, quantity)
SELECT
  h.id,
  (
    SELECT (array_agg(s.id))[1]
    FROM public.spare_parts s
    WHERE lower(btrim(s.name)) = lower(btrim(h.spare_part_name))
    HAVING count(*) = 1
  ),
  h.spare_part_name,
  h.quantity
FROM public.purchase_requirements h
WHERE h.spare_part_name IS NOT NULL
  AND h.quantity IS NOT NULL
  AND h.quantity > 0
  AND NOT EXISTS (SELECT 1 FROM public.purchase_requirement_items i WHERE i.pr_id = h.id);

-- Jejak transaksi pemasukan -> item PR
ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS pr_item_id uuid REFERENCES public.purchase_requirement_items(id) ON DELETE SET NULL;

-- Satu GR boleh memuat banyak barang: unik per (no. GR, spare part), bukan per no. GR saja.
DROP INDEX IF EXISTS public.uq_inventory_transactions_gr_no;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transactions_gr_no_part
  ON public.inventory_transactions(gr_no, spare_part_id)
  WHERE gr_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_tx_pr_item
  ON public.inventory_transactions(pr_item_id)
  WHERE pr_item_id IS NOT NULL;

-- =========================================================
-- 2) Buat PR multi-item
-- =========================================================
DROP FUNCTION IF EXISTS public.create_purchase_requirement(text, numeric, uuid, text, uuid);

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

  IF p_supplier_id IS NULL OR NOT EXISTS (
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
-- 3) Pemasukan multi-item (opsional menautkan item PR)
--    p_items: [{"spare_part_id": "...", "quantity": 5, "pr_item_id": "..." | null}, ...]
--    Mengembalikan nomor GR yang dipakai.
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
    WHERE i.spare_part_id IS NULL OR i.quantity IS NULL OR i.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Setiap barang harus memiliki spare part dan quantity lebih besar dari 0.';
  END IF;

  -- Satu nomor GR untuk seluruh baris.
  IF v_gr_no IS NULL THEN
    v_gr_no := public.next_gr_number(p_gr_kind);
  ELSE
    -- Nomor manual/hasil generate: tolak bila sudah dipakai penerimaan lain (mis. klik ganda).
    PERFORM pg_advisory_xact_lock(hashtext('gr:' || v_gr_no));
    IF EXISTS (SELECT 1 FROM public.inventory_transactions WHERE gr_no = v_gr_no) THEN
      RAISE EXCEPTION 'Nomor GR % sudah dipakai penerimaan lain. Generate nomor GR baru.', v_gr_no;
    END IF;
  END IF;

  -- Urutan tetap (part id, lalu item PR) agar tidak deadlock antar-transaksi.
  FOR v_item IN
    SELECT i.spare_part_id, i.quantity, i.pr_item_id
    FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric, pr_item_id uuid)
    ORDER BY i.spare_part_id, i.pr_item_id NULLS LAST
  LOOP
    IF v_item.pr_item_id IS NOT NULL THEN
      SELECT * INTO v_pri
      FROM public.purchase_requirement_items
      WHERE id = v_item.pr_item_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Item PR tidak ditemukan.';
      END IF;

      IF v_pri.spare_part_id IS DISTINCT FROM v_item.spare_part_id THEN
        RAISE EXCEPTION 'Spare part tidak sesuai dengan item PR (%).', v_pri.spare_part_name;
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
          'GR ' || v_gr_no || ' | ' || v_count::text || ' barang');

  RETURN v_gr_no;
END;
$$;

REVOKE ALL ON FUNCTION public.receive_stock_multi(jsonb, text, text, text, text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_stock_multi(jsonb, text, text, text, text, text, text[]) TO authenticated;
