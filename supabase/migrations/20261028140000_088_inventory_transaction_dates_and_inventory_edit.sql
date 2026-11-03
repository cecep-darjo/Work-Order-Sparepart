-- Operational transaction dates and editable inventory transactions for admin/inventory.
-- Stock chronology continues to use created_at; transaction_date is the user-facing date.

ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS transaction_date date;

UPDATE public.inventory_transactions
SET transaction_date = (created_at AT TIME ZONE 'Asia/Jakarta')::date
WHERE transaction_date IS NULL;

ALTER TABLE public.inventory_transactions
  ALTER COLUMN transaction_date SET DEFAULT (now() AT TIME ZONE 'Asia/Jakarta')::date,
  ALTER COLUMN transaction_date SET NOT NULL;

ALTER TABLE public.purchase_requirement_service_receipts
  ADD COLUMN IF NOT EXISTS transaction_date date;

UPDATE public.purchase_requirement_service_receipts
SET transaction_date = (created_at AT TIME ZONE 'Asia/Jakarta')::date
WHERE transaction_date IS NULL;

ALTER TABLE public.purchase_requirement_service_receipts
  ALTER COLUMN transaction_date SET DEFAULT (now() AT TIME ZONE 'Asia/Jakarta')::date,
  ALTER COLUMN transaction_date SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_tx_transaction_date
  ON public.inventory_transactions(transaction_date DESC);

CREATE OR REPLACE FUNCTION public.inventory_update_transaction_date(
  p_tx_id uuid,
  p_transaction_date date,
  p_reason text DEFAULT 'Tanggal transaksi ditetapkan saat proses pemasukan/pengeluaran',
  p_gr_no text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_tx public.inventory_transactions%ROWTYPE;
  v_count integer := 0;
  v_reason text := NULLIF(btrim(p_reason), '');
  v_doc text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Hanya role admin atau inventory yang dapat mengubah tanggal transaksi.';
  END IF;
  IF p_transaction_date IS NULL THEN RAISE EXCEPTION 'Tanggal transaksi wajib diisi.'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 3 THEN RAISE EXCEPTION 'Alasan perubahan wajib diisi.'; END IF;

  IF p_tx_id IS NOT NULL THEN
    SELECT * INTO v_tx FROM public.inventory_transactions WHERE id = p_tx_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Transaksi tidak ditemukan.'; END IF;
    IF v_tx.type NOT IN ('stock_in','stock_out') OR v_tx.work_order_id IS NOT NULL THEN
      RAISE EXCEPTION 'Tanggal hanya dapat diubah untuk transaksi pemasukan/pengeluaran manual.';
    END IF;

    UPDATE public.inventory_transactions t
    SET transaction_date = p_transaction_date
    WHERE (v_tx.gr_no IS NOT NULL AND t.gr_no = v_tx.gr_no)
       OR (v_tx.gr_no IS NULL AND v_tx.issue_slip_no IS NOT NULL AND t.issue_slip_no = v_tx.issue_slip_no)
       OR (v_tx.gr_no IS NULL AND v_tx.issue_slip_no IS NULL AND t.id = v_tx.id);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_doc := coalesce(CASE WHEN v_tx.gr_no IS NOT NULL THEN 'GR ' || v_tx.gr_no END,
                      CASE WHEN v_tx.issue_slip_no IS NOT NULL THEN 'Slip ' || v_tx.issue_slip_no END,
                      v_tx.transaction_no, v_tx.id::text);
  ELSIF NULLIF(btrim(p_gr_no), '') IS NOT NULL THEN
    UPDATE public.purchase_requirement_service_receipts
    SET transaction_date = p_transaction_date WHERE gr_no = btrim(p_gr_no);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count = 0 THEN RAISE EXCEPTION 'GR tidak ditemukan.'; END IF;
    v_doc := 'GR ' || btrim(p_gr_no);
  ELSE
    RAISE EXCEPTION 'Pilih transaksi atau nomor GR.';
  END IF;

  IF p_tx_id IS NOT NULL AND v_tx.gr_no IS NOT NULL THEN
    UPDATE public.purchase_requirement_service_receipts
    SET transaction_date = p_transaction_date
    WHERE gr_no = v_tx.gr_no;
  END IF;

  INSERT INTO public.activity_log(user_id, action, entity_type, entity_id, details, reason)
  VALUES (auth.uid(), 'inventory_update_transaction_date', 'inventory_transaction', v_tx.id,
          v_doc || ' | tanggal transaksi ' || coalesce(v_tx.transaction_date::text, '-') || ' -> ' || p_transaction_date::text,
          v_reason);
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.inventory_update_transaction_date(uuid, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_update_transaction_date(uuid, date, text, text) TO authenticated;
CREATE OR REPLACE FUNCTION public.admin_update_inventory_document(
  p_tx_id uuid,
  p_reference text,
  p_notes text,
  p_source text,
  p_destination text,
  p_recipient text,
  p_gr_attachments text[],
  p_reason text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_tx public.inventory_transactions%ROWTYPE;
  v_reason text := NULLIF(btrim(p_reason), '');
  v_count integer;
  v_doc text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengubah dokumen transaksi inventory.';
  END IF;

  IF v_reason IS NULL OR length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Alasan perubahan wajib diisi.';
  END IF;

  SELECT * INTO v_tx FROM public.inventory_transactions WHERE id = p_tx_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaksi tidak ditemukan.';
  END IF;
  IF v_role = 'inventory' AND (v_tx.type NOT IN ('stock_in','stock_out') OR v_tx.work_order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Role Inventory hanya dapat mengubah dokumen pemasukan/pengeluaran manual.';
  END IF;

  UPDATE public.inventory_transactions t
  SET reference = NULLIF(btrim(p_reference), ''),
      notes = NULLIF(btrim(p_notes), ''),
      source = CASE WHEN t.type = 'stock_in' THEN NULLIF(btrim(p_source), '') ELSE t.source END,
      destination = CASE WHEN t.type = 'stock_out' THEN NULLIF(btrim(p_destination), '') ELSE t.destination END,
      recipient = CASE WHEN t.issue_slip_no IS NOT NULL THEN NULLIF(btrim(p_recipient), '') ELSE t.recipient END,
      gr_attachments = CASE
        WHEN t.gr_no IS NOT NULL AND p_gr_attachments IS NOT NULL
          THEN CASE WHEN cardinality(p_gr_attachments) = 0 THEN NULL ELSE p_gr_attachments END
        ELSE t.gr_attachments
      END
  WHERE (v_tx.gr_no IS NOT NULL AND t.gr_no = v_tx.gr_no)
     OR (v_tx.gr_no IS NULL AND v_tx.issue_slip_no IS NOT NULL AND t.issue_slip_no = v_tx.issue_slip_no)
     OR (v_tx.gr_no IS NULL AND v_tx.issue_slip_no IS NULL AND t.id = v_tx.id);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  v_doc := coalesce(
    CASE WHEN v_tx.gr_no IS NOT NULL THEN 'GR ' || v_tx.gr_no END,
    CASE WHEN v_tx.issue_slip_no IS NOT NULL THEN 'Slip ' || v_tx.issue_slip_no END,
    v_tx.transaction_no,
    v_tx.id::text
  );

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
  VALUES (
    auth.uid(),
    'admin_update_inventory_document',
    'inventory_transaction',
    v_tx.id,
    'Edit dokumen ' || v_doc || ' (' || v_count::text || ' baris)',
    v_reason
  );

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_inventory_document(uuid, text, text, text, text, text, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_inventory_document(uuid, text, text, text, text, text, text[], text) TO authenticated;

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
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
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



-- Dated variants keep the chosen business date atomic with the stock and GR/slip operation.
CREATE OR REPLACE FUNCTION public.receive_stock_multi(
  p_items jsonb,
  p_gr_kind text,
  p_gr_no text,
  p_source text,
  p_reference text,
  p_notes text,
  p_gr_attachments text[],
  p_transaction_date date
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
  IF p_transaction_date IS NULL THEN RAISE EXCEPTION 'Tanggal pemasukan wajib diisi.'; END IF;
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
          pr_item_id, gr_no, gr_kind, received_qty, reference, notes, gr_attachments, created_by, transaction_date
        ) VALUES (
          v_pri.id, v_gr_no, p_gr_kind, v_item.quantity, p_reference, p_notes, p_gr_attachments, auth.uid(), p_transaction_date
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

    UPDATE public.inventory_transactions SET transaction_date = p_transaction_date WHERE id = v_tx.id;

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
REVOKE ALL ON FUNCTION public.receive_stock_multi(jsonb, text, text, text, text, text, text[], date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_stock_multi(jsonb, text, text, text, text, text, text[], date) TO authenticated;

CREATE OR REPLACE FUNCTION public.issue_stock_manual(
  p_items jsonb,
  p_recipient text,
  p_destination text,
  p_reference text,
  p_notes text,
  p_transaction_date date
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
  v_date date := p_transaction_date;
  v_slip_no text;
  v_count integer := 0;
  v_bon_ids uuid[] := ARRAY[]::uuid[];
  v_bon uuid;
BEGIN
  IF p_transaction_date IS NULL THEN RAISE EXCEPTION 'Tanggal pengeluaran wajib diisi.'; END IF;
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
    SET issue_slip_no = v_slip_no, recipient = btrim(p_recipient), bon_item_id = v_item.bon_item_id, transaction_date = p_transaction_date
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
REVOKE ALL ON FUNCTION public.issue_stock_manual(jsonb, text, text, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_stock_manual(jsonb, text, text, text, text, date) TO authenticated;

