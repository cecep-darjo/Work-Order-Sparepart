/*
# Bon Sparepart

Fasilitas permintaan spare part (bon) untuk semua user KECUALI inventory (admin, ss, spv, teknisi),
tidak terikat Work Order.

- `spare_part_bons`       : header bon (no. BON-YYMMDD-00001 per hari WIB, urut dari data tersimpan,
                            keterangan wajib, status pending/partial/issued/cancelled).
- `spare_part_bon_items`  : item bon (qty diminta + issued_qty = sudah dikeluarkan).
- `create_spare_part_bon` : buat bon (role admin/ss/spv/teknisi). Part yang sama digabung.
- `update_spare_part_bon` : ubah item/keterangan. Pembuat hanya selama bon masih pending (belum ada
                            yang dikeluarkan); admin kapan saja kecuali dibatalkan, dengan pengaman
                            qty >= yang sudah dikeluarkan dan item yang sudah dikeluarkan tidak boleh dihapus.
- `cancel_spare_part_bon` : pembuat membatalkan bon pending; admin/inventory (alasan wajib) membatalkan
                            bon pending atau menutup bon yang baru sebagian dikeluarkan (sisa tidak dipenuhi).
- `issue_stock_manual`    : DIPERLUAS (signature sama). Setiap item di p_items boleh membawa `bon_item_id`
                            untuk menautkan baris pengeluaran ke item bon: qty dibatasi sisa bon, issued_qty
                            bertambah, status bon diperbarui, semua atomik. Item tanpa bon_item_id berperilaku
                            seperti sebelumnya (Pengeluaran manual).
- `admin_correct_transaction_qty` : diperbarui agar koreksi qty pengeluaran yang tertaut bon ikut
                            menyesuaikan issued_qty.

Akses baca: pembuat bon, admin, dan inventory. Penulisan hanya lewat fungsi di atas.
Aman dijalankan ulang.
*/

-- =========================================================
-- 1) Tabel
-- =========================================================
CREATE TABLE IF NOT EXISTS public.spare_part_bons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bon_no text NOT NULL UNIQUE,
  requester_id uuid NOT NULL REFERENCES public.profiles(id),
  notes text NOT NULL CHECK (length(btrim(notes)) > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','partial','issued','cancelled')),
  cancel_reason text,
  cancelled_by uuid REFERENCES public.profiles(id),
  cancelled_at timestamptz,
  closed_reason text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bons_requester ON public.spare_part_bons(requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bons_status ON public.spare_part_bons(status, created_at);

CREATE TABLE IF NOT EXISTS public.spare_part_bon_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bon_id uuid NOT NULL REFERENCES public.spare_part_bons(id) ON DELETE CASCADE,
  spare_part_id uuid NOT NULL REFERENCES public.spare_parts(id) ON DELETE RESTRICT,
  quantity numeric NOT NULL CHECK (quantity > 0),
  issued_qty numeric NOT NULL DEFAULT 0 CHECK (issued_qty >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bon_id, spare_part_id)
);

CREATE INDEX IF NOT EXISTS idx_bon_items_bon ON public.spare_part_bon_items(bon_id);

ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS bon_item_id uuid REFERENCES public.spare_part_bon_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_tx_bon_item
  ON public.inventory_transactions(bon_item_id) WHERE bon_item_id IS NOT NULL;

ALTER TABLE public.spare_part_bons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spare_part_bon_items ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.spare_part_bons FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.spare_part_bon_items FROM anon, authenticated;

DROP POLICY IF EXISTS "read_spare_part_bons" ON public.spare_part_bons;
CREATE POLICY "read_spare_part_bons" ON public.spare_part_bons FOR SELECT TO authenticated USING (
  requester_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active = true AND p.role IN ('admin','inventory')
  )
);

DROP POLICY IF EXISTS "read_spare_part_bon_items" ON public.spare_part_bon_items;
CREATE POLICY "read_spare_part_bon_items" ON public.spare_part_bon_items FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.spare_part_bons b WHERE b.id = spare_part_bon_items.bon_id)
);

-- =========================================================
-- 2) Hitung ulang status bon dari item (internal)
-- =========================================================
CREATE OR REPLACE FUNCTION public.bon_refresh_status(p_bon_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_closed text;
  v_total integer;
  v_done integer;
  v_any boolean;
BEGIN
  SELECT status, closed_reason INTO v_status, v_closed FROM public.spare_part_bons WHERE id = p_bon_id;
  IF NOT FOUND OR v_status = 'cancelled' OR v_closed IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE issued_qty >= quantity), coalesce(bool_or(issued_qty > 0), false)
  INTO v_total, v_done, v_any
  FROM public.spare_part_bon_items WHERE bon_id = p_bon_id;

  UPDATE public.spare_part_bons
  SET status = CASE WHEN v_total > 0 AND v_done = v_total THEN 'issued' WHEN v_any THEN 'partial' ELSE 'pending' END,
      completed_at = CASE WHEN v_total > 0 AND v_done = v_total THEN coalesce(completed_at, now()) ELSE NULL END,
      updated_at = now()
  WHERE id = p_bon_id;
END;
$$;

REVOKE ALL ON FUNCTION public.bon_refresh_status(uuid) FROM PUBLIC, anon, authenticated;

-- =========================================================
-- 3) Buat bon
-- =========================================================
CREATE OR REPLACE FUNCTION public.create_spare_part_bon(p_items jsonb, p_notes text)
RETURNS public.spare_part_bons
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_notes text := NULLIF(btrim(p_notes), '');
  v_row public.spare_part_bons%ROWTYPE;
  v_date date := (now() AT TIME ZONE 'Asia/Jakarta')::date;
  v_prefix text;
  v_seq integer;
  v_count integer;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','ss','spv','teknisi') THEN
    RAISE EXCEPTION 'User inventory tidak dapat membuat bon sparepart.';
  END IF;

  IF v_notes IS NULL OR length(v_notes) < 3 THEN
    RAISE EXCEPTION 'Keterangan bon wajib diisi.';
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

  -- Nomor urut per hari (WIB) dari bon yang tersimpan; dikunci agar tidak ganda saat bersamaan.
  v_prefix := 'BON-' || to_char(v_date, 'YYMMDD') || '-';
  PERFORM pg_advisory_xact_lock(hashtext('bonno:' || v_prefix));
  SELECT coalesce(max(substr(b.bon_no, length(v_prefix) + 1)::integer), 0) + 1 INTO v_seq
  FROM public.spare_part_bons b
  WHERE b.bon_no ~ ('^' || v_prefix || '[0-9]+$');

  INSERT INTO public.spare_part_bons (bon_no, requester_id, notes)
  VALUES (v_prefix || lpad(v_seq::text, 5, '0'), auth.uid(), v_notes)
  RETURNING * INTO v_row;

  INSERT INTO public.spare_part_bon_items (bon_id, spare_part_id, quantity)
  SELECT v_row.id, i.spare_part_id, SUM(i.quantity)
  FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric)
  GROUP BY i.spare_part_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'create_spare_part_bon', 'spare_part_bon', v_row.id,
          v_row.bon_no || ' | ' || v_count::text || ' item | ' || left(v_notes, 80));

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_spare_part_bon(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_spare_part_bon(jsonb, text) TO authenticated;

-- =========================================================
-- 4) Ubah bon (pembuat selama pending; admin kapan saja kecuali dibatalkan)
-- =========================================================
CREATE OR REPLACE FUNCTION public.update_spare_part_bon(p_bon_id uuid, p_items jsonb, p_notes text)
RETURNS public.spare_part_bons
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_notes text := NULLIF(btrim(p_notes), '');
  v_row public.spare_part_bons%ROWTYPE;
  v_old public.spare_part_bon_items%ROWTYPE;
  v_want record;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role = 'inventory' THEN
    RAISE EXCEPTION 'Anda tidak dapat mengubah bon sparepart.';
  END IF;

  SELECT * INTO v_row FROM public.spare_part_bons WHERE id = p_bon_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bon tidak ditemukan.';
  END IF;
  IF v_row.status = 'cancelled' THEN
    RAISE EXCEPTION 'Bon sudah dibatalkan dan tidak dapat diubah.';
  END IF;
  IF v_role <> 'admin' THEN
    IF v_row.requester_id <> auth.uid() THEN
      RAISE EXCEPTION 'Anda hanya dapat mengubah bon milik Anda sendiri.';
    END IF;
    IF v_row.status <> 'pending' THEN
      RAISE EXCEPTION 'Bon sudah mulai diproses inventory dan tidak dapat diubah.';
    END IF;
  END IF;

  IF v_notes IS NULL OR length(v_notes) < 3 THEN
    RAISE EXCEPTION 'Keterangan bon wajib diisi.';
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

  PERFORM 1 FROM public.spare_part_bon_items WHERE bon_id = p_bon_id ORDER BY id FOR UPDATE;

  FOR v_old IN
    SELECT * FROM public.spare_part_bon_items
    WHERE bon_id = p_bon_id
      AND spare_part_id NOT IN (SELECT i.spare_part_id FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric))
  LOOP
    IF v_old.issued_qty > 0 THEN
      RAISE EXCEPTION 'Item tidak dapat dihapus karena sudah dikeluarkan % (ada pengeluaran barang).', v_old.issued_qty;
    END IF;
    DELETE FROM public.spare_part_bon_items WHERE id = v_old.id;
  END LOOP;

  FOR v_want IN
    SELECT i.spare_part_id, SUM(i.quantity) AS quantity
    FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric)
    GROUP BY i.spare_part_id
  LOOP
    SELECT * INTO v_old FROM public.spare_part_bon_items WHERE bon_id = p_bon_id AND spare_part_id = v_want.spare_part_id;
    IF FOUND THEN
      IF v_want.quantity < v_old.issued_qty THEN
        RAISE EXCEPTION 'Qty tidak boleh lebih kecil dari yang sudah dikeluarkan (%).', v_old.issued_qty;
      END IF;
      UPDATE public.spare_part_bon_items SET quantity = v_want.quantity WHERE id = v_old.id;
    ELSE
      INSERT INTO public.spare_part_bon_items (bon_id, spare_part_id, quantity)
      VALUES (p_bon_id, v_want.spare_part_id, v_want.quantity);
    END IF;
  END LOOP;

  UPDATE public.spare_part_bons SET notes = v_notes, updated_at = now() WHERE id = p_bon_id;
  PERFORM public.bon_refresh_status(p_bon_id);
  SELECT * INTO v_row FROM public.spare_part_bons WHERE id = p_bon_id;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'update_spare_part_bon', 'spare_part_bon', v_row.id,
          v_row.bon_no || ' diubah' || CASE WHEN v_role = 'admin' AND v_row.requester_id <> auth.uid() THEN ' oleh admin' ELSE '' END);

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.update_spare_part_bon(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_spare_part_bon(uuid, jsonb, text) TO authenticated;

-- =========================================================
-- 5) Batalkan / tutup bon
-- =========================================================
CREATE OR REPLACE FUNCTION public.cancel_spare_part_bon(p_bon_id uuid, p_reason text DEFAULT NULL)
RETURNS public.spare_part_bons
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_reason text := NULLIF(btrim(p_reason), '');
  v_row public.spare_part_bons%ROWTYPE;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Akses ditolak.';
  END IF;

  SELECT * INTO v_row FROM public.spare_part_bons WHERE id = p_bon_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bon tidak ditemukan.';
  END IF;
  IF v_row.status IN ('cancelled','issued') THEN
    RAISE EXCEPTION 'Bon sudah selesai/dibatalkan.';
  END IF;

  IF v_role IN ('admin','inventory') THEN
    IF v_reason IS NULL OR length(v_reason) < 3 THEN
      RAISE EXCEPTION 'Alasan wajib diisi.';
    END IF;
    IF v_row.status = 'pending' THEN
      UPDATE public.spare_part_bons
      SET status = 'cancelled', cancel_reason = v_reason, cancelled_by = auth.uid(), cancelled_at = now(), updated_at = now()
      WHERE id = p_bon_id RETURNING * INTO v_row;
    ELSE
      -- sebagian sudah dikeluarkan: tutup bon, sisa tidak dipenuhi
      UPDATE public.spare_part_bons
      SET status = 'issued', closed_reason = v_reason, completed_at = now(), updated_at = now()
      WHERE id = p_bon_id RETURNING * INTO v_row;
    END IF;
  ELSIF v_row.requester_id = auth.uid() THEN
    IF v_row.status <> 'pending' THEN
      RAISE EXCEPTION 'Bon sudah sebagian dikeluarkan. Hubungi inventory untuk menutupnya.';
    END IF;
    UPDATE public.spare_part_bons
    SET status = 'cancelled', cancel_reason = v_reason, cancelled_by = auth.uid(), cancelled_at = now(), updated_at = now()
    WHERE id = p_bon_id RETURNING * INTO v_row;
  ELSE
    RAISE EXCEPTION 'Anda hanya dapat membatalkan bon milik Anda sendiri.';
  END IF;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
  VALUES (auth.uid(), CASE WHEN v_row.status = 'cancelled' THEN 'cancel_spare_part_bon' ELSE 'close_spare_part_bon' END,
          'spare_part_bon', v_row.id, v_row.bon_no, v_reason);

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_spare_part_bon(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_spare_part_bon(uuid, text) TO authenticated;

-- =========================================================
-- 6) Pengeluaran manual + (opsional) tautan item bon.
--    p_items: [{"spare_part_id": "...", "quantity": 2, "bon_item_id": "..." | null}, ...]
-- =========================================================
CREATE OR REPLACE FUNCTION public.issue_stock_manual(
  p_items jsonb,
  p_recipient text,
  p_destination text DEFAULT NULL,
  p_reference text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_item record;
  v_part public.spare_parts%ROWTYPE;
  v_tx public.inventory_transactions%ROWTYPE;
  v_bi public.spare_part_bon_items%ROWTYPE;
  v_bon_status text;
  v_no integer;
  v_date date := current_date;
  v_slip_no text;
  v_count integer := 0;
  v_bon_ids uuid[] := ARRAY[]::uuid[];
  v_bon uuid;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Hanya role admin atau inventory yang dapat melakukan pengeluaran barang.';
  END IF;

  IF p_recipient IS NULL OR btrim(p_recipient) = '' THEN
    RAISE EXCEPTION 'Nama penerima wajib diisi.';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Daftar barang tidak boleh kosong.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric, bon_item_id uuid)
    WHERE i.spare_part_id IS NULL OR i.quantity IS NULL OR i.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Setiap barang harus memiliki spare part dan quantity lebih besar dari 0.';
  END IF;

  INSERT INTO public.issue_slip_counters (slip_date, last_no)
  VALUES (v_date, 1)
  ON CONFLICT (slip_date) DO UPDATE SET last_no = public.issue_slip_counters.last_no + 1
  RETURNING last_no INTO v_no;
  v_slip_no := 'BPB-' || to_char(v_date, 'YYMMDD') || '-' || lpad(v_no::text, 5, '0');

  -- Barang manual (tanpa bon) digabung per part; baris bon dipisah per item bon.
  -- Urutan tetap (part id, item bon) agar tidak deadlock antar-transaksi.
  FOR v_item IN
    SELECT i.spare_part_id, i.bon_item_id, SUM(i.quantity) AS quantity
    FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric, bon_item_id uuid)
    GROUP BY i.spare_part_id, i.bon_item_id
    ORDER BY i.spare_part_id, i.bon_item_id NULLS LAST
  LOOP
    SELECT * INTO v_part FROM public.spare_parts WHERE id = v_item.spare_part_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Spare part tidak ditemukan.'; END IF;

    IF v_item.bon_item_id IS NOT NULL THEN
      SELECT * INTO v_bi FROM public.spare_part_bon_items WHERE id = v_item.bon_item_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Item bon tidak ditemukan.';
      END IF;
      IF v_bi.spare_part_id <> v_item.spare_part_id THEN
        RAISE EXCEPTION 'Spare part tidak sesuai dengan item bon (%).', v_part.name;
      END IF;
      SELECT status INTO v_bon_status FROM public.spare_part_bons WHERE id = v_bi.bon_id;
      IF v_bon_status NOT IN ('pending','partial') THEN
        RAISE EXCEPTION 'Bon untuk % sudah selesai/dibatalkan.', v_part.name;
      END IF;
      IF v_bi.issued_qty + v_item.quantity > v_bi.quantity THEN
        RAISE EXCEPTION 'Qty keluar % (%) melebihi sisa bon. Diminta: %, sudah dikeluarkan: %, sisa: %.',
          v_part.name, v_item.quantity, v_bi.quantity, v_bi.issued_qty, v_bi.quantity - v_bi.issued_qty;
      END IF;
    END IF;

    IF v_part.current_stock < v_item.quantity THEN
      RAISE EXCEPTION 'Stok % (%) tidak mencukupi. Tersedia: % %, diminta: %.',
        v_part.name, v_part.code, v_part.current_stock, v_part.unit, v_item.quantity;
    END IF;

    v_tx := public.apply_inventory_transaction(
      v_item.spare_part_id, 'stock_out', v_item.quantity,
      p_reference, p_notes, NULL, NULL, p_destination
    );

    UPDATE public.inventory_transactions
    SET issue_slip_no = v_slip_no, recipient = btrim(p_recipient), bon_item_id = v_item.bon_item_id
    WHERE id = v_tx.id;

    IF v_item.bon_item_id IS NOT NULL THEN
      UPDATE public.spare_part_bon_items SET issued_qty = issued_qty + v_item.quantity WHERE id = v_item.bon_item_id;
      IF NOT (v_bi.bon_id = ANY (v_bon_ids)) THEN
        v_bon_ids := v_bon_ids || v_bi.bon_id;
      END IF;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  FOREACH v_bon IN ARRAY v_bon_ids LOOP
    PERFORM public.bon_refresh_status(v_bon);
  END LOOP;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'inventory_issue_slip', 'inventory_transaction', v_tx.id,
          v_slip_no || ' | ' || v_count::text || ' barang | penerima ' || btrim(p_recipient) ||
          CASE WHEN array_length(v_bon_ids, 1) > 0 THEN ' | dari ' || array_length(v_bon_ids, 1)::text || ' bon' ELSE '' END);

  RETURN v_slip_no;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_stock_manual(jsonb, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_stock_manual(jsonb, text, text, text, text) TO authenticated;

-- =========================================================
-- 7) Koreksi qty admin: ikut menyesuaikan issued_qty pada bon
-- =========================================================
CREATE OR REPLACE FUNCTION public.admin_correct_transaction_qty(
  p_tx_id uuid,
  p_new_qty numeric,
  p_reason text
)
RETURNS public.inventory_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_reason text := NULLIF(btrim(p_reason), '');
  v_tx public.inventory_transactions%ROWTYPE;
  v_part public.spare_parts%ROWTYPE;
  v_pri public.purchase_requirement_items%ROWTYPE;
  v_sign integer;
  v_delta numeric;
  v_shift numeric;
  v_prev_after numeric;
  v_new_after numeric;
  v_new_before numeric;
  v_new_received numeric;
  v_old_stock numeric;
  v_old_qty numeric;
  v_bon public.spare_part_bon_items%ROWTYPE;
  v_new_issued numeric;
  v_bon_id uuid;
  v_row record;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengoreksi qty transaksi.';
  END IF;

  IF v_reason IS NULL OR length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Alasan koreksi wajib diisi.';
  END IF;

  IF p_new_qty IS NULL OR p_new_qty <= 0 THEN
    RAISE EXCEPTION 'Quantity baru harus lebih besar dari 0.';
  END IF;

  SELECT * INTO v_tx FROM public.inventory_transactions WHERE id = p_tx_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaksi tidak ditemukan.';
  END IF;

  -- Kunci part lebih dulu (urutan sama dengan apply_inventory_transaction), lalu baca ulang transaksi.
  SELECT * INTO v_part FROM public.spare_parts WHERE id = v_tx.spare_part_id FOR UPDATE;
  SELECT * INTO v_tx FROM public.inventory_transactions WHERE id = p_tx_id FOR UPDATE;

  IF v_tx.type NOT IN ('stock_in','stock_out','adjustment') THEN
    RAISE EXCEPTION 'Transaksi opname tidak dapat dikoreksi qty-nya (saldo absolut). Buat opname baru.';
  END IF;
  IF v_tx.work_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'Transaksi ini terkait Work Order/permintaan part. Ubah lewat modul Work Order.';
  END IF;
  IF v_tx.reversed_transaction_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.inventory_transactions r WHERE r.reversed_transaction_id = v_tx.id) THEN
    RAISE EXCEPTION 'Transaksi ini sudah terkait pembatalan (reversal) dan tidak dapat dikoreksi.';
  END IF;
  v_old_qty := v_tx.quantity;
  IF p_new_qty = v_tx.quantity THEN
    RAISE EXCEPTION 'Quantity tidak berubah.';
  END IF;

  v_sign := CASE WHEN v_tx.type = 'stock_out' THEN -1 ELSE 1 END;
  v_delta := v_sign * (p_new_qty - v_tx.quantity);

  -- Riwayat saldo transaksi ini harus konsisten.
  IF v_tx.stock_before IS NULL OR v_tx.balance_after IS NULL
     OR v_tx.balance_after <> v_tx.stock_before + v_sign * v_tx.quantity THEN
    RAISE EXCEPTION 'Riwayat saldo transaksi % tidak konsisten; koreksi otomatis tidak dapat dilakukan.', coalesce(v_tx.transaction_no, v_tx.id::text);
  END IF;

  v_new_after := v_tx.stock_before + v_sign * p_new_qty;
  IF v_new_after < 0 THEN
    RAISE EXCEPTION 'Koreksi ini membuat saldo % negatif.', v_part.code;
  END IF;

  -- Item PR yang ditautkan: sesuaikan qty diterima.
  IF v_tx.pr_item_id IS NOT NULL THEN
    SELECT * INTO v_pri FROM public.purchase_requirement_items WHERE id = v_tx.pr_item_id FOR UPDATE;
    IF FOUND THEN
      v_new_received := v_pri.received_qty + (p_new_qty - v_tx.quantity);
      IF v_new_received < 0 OR v_new_received > v_pri.quantity THEN
        RAISE EXCEPTION 'Koreksi ini membuat qty diterima PR (%) di luar batas 0..% (dipesan).', v_new_received, v_pri.quantity;
      END IF;
      UPDATE public.purchase_requirement_items SET received_qty = v_new_received WHERE id = v_pri.id;
    END IF;
  END IF;

  -- Item bon sparepart yang ditautkan: sesuaikan qty dikeluarkan pada bon.
  IF v_tx.bon_item_id IS NOT NULL AND v_tx.type = 'stock_out' THEN
    SELECT * INTO v_bon FROM public.spare_part_bon_items WHERE id = v_tx.bon_item_id FOR UPDATE;
    IF FOUND THEN
      v_new_issued := v_bon.issued_qty + (p_new_qty - v_tx.quantity);
      IF v_new_issued < 0 OR v_new_issued > v_bon.quantity THEN
        RAISE EXCEPTION 'Koreksi ini membuat qty dikeluarkan pada bon (%) di luar batas 0..% (diminta).', v_new_issued, v_bon.quantity;
      END IF;
      UPDATE public.spare_part_bon_items SET issued_qty = v_new_issued WHERE id = v_bon.id;
      v_bon_id := v_bon.bon_id;
    END IF;
  END IF;

  -- Telusuri transaksi sesudahnya: verifikasi rantai saldo, lalu geser sebesar delta
  -- (berhenti bergeser di opname karena opname menyetel ulang saldo).
  v_old_stock := v_part.current_stock;
  v_prev_after := v_tx.balance_after;
  v_shift := v_delta;

  FOR v_row IN
    SELECT id, type, stock_before, balance_after, transaction_no
    FROM public.inventory_transactions
    WHERE spare_part_id = v_tx.spare_part_id
      AND (created_at, coalesce(transaction_no, ''), id) > (v_tx.created_at, coalesce(v_tx.transaction_no, ''), v_tx.id)
    ORDER BY created_at, coalesce(transaction_no, ''), id
  LOOP
    IF v_row.stock_before IS DISTINCT FROM v_prev_after THEN
      RAISE EXCEPTION 'Riwayat saldo tidak konsisten pada transaksi %; koreksi otomatis dibatalkan.', coalesce(v_row.transaction_no, v_row.id::text);
    END IF;
    v_prev_after := v_row.balance_after;

    IF v_shift <> 0 THEN
      IF v_row.type = 'opname' THEN
        UPDATE public.inventory_transactions SET stock_before = stock_before + v_shift WHERE id = v_row.id;
        v_shift := 0;
      ELSE
        v_new_before := v_row.stock_before + v_shift;
        IF v_row.balance_after + v_shift < 0 OR v_new_before < 0 THEN
          RAISE EXCEPTION 'Koreksi ini membuat saldo negatif pada transaksi %.', coalesce(v_row.transaction_no, v_row.id::text);
        END IF;
        UPDATE public.inventory_transactions
        SET stock_before = v_new_before,
            balance_after = balance_after + v_shift
        WHERE id = v_row.id;
      END IF;
    END IF;
  END LOOP;

  IF v_prev_after IS DISTINCT FROM v_old_stock THEN
    RAISE EXCEPTION 'Stok saat ini (%) tidak sama dengan saldo terakhir riwayat (%); koreksi otomatis dibatalkan.', v_old_stock, v_prev_after;
  END IF;

  IF v_shift <> 0 THEN
    IF v_old_stock + v_shift < 0 THEN
      RAISE EXCEPTION 'Koreksi ini membuat stok % negatif.', v_part.code;
    END IF;
    PERFORM set_config('app.inventory_tx', '1', true);
    UPDATE public.spare_parts
    SET current_stock = current_stock + v_shift, updated_at = now()
    WHERE id = v_part.id;
  END IF;

  UPDATE public.inventory_transactions
  SET quantity = p_new_qty,
      balance_after = v_tx.stock_before + v_sign * p_new_qty
  WHERE id = v_tx.id
  RETURNING * INTO v_tx;

  IF v_bon_id IS NOT NULL THEN
    PERFORM public.bon_refresh_status(v_bon_id);
  END IF;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
  VALUES (
    auth.uid(),
    'admin_correct_transaction_qty',
    'inventory_transaction',
    v_tx.id,
    coalesce(v_tx.transaction_no, v_tx.id::text) || ' | ' || v_part.code ||
      ' | qty ' || v_old_qty::text || ' -> ' || p_new_qty::text ||
      ' | stok ' || v_old_stock::text || ' -> ' || (v_old_stock + v_shift)::text,
    v_reason
  );

  RETURN v_tx;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_correct_transaction_qty(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_correct_transaction_qty(uuid, numeric, text) TO authenticated;
