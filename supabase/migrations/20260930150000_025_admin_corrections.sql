/*
# Akses koreksi khusus admin: nomor PR, dokumen inventory, dan qty transaksi

Semua fungsi di bawah HANYA untuk role `admin`, wajib menyertakan alasan, dan tercatat di
activity_log (kolom reason).

1) `admin_update_purchase_requirement_numbers`
   Mengoreksi nomor SAP / nomor PR pada PR yang SUDAH bernomor (alur normal hanya bisa mengisi
   sekali). Format tetap divalidasi (SAP 16xxxxxxxx, PR TK/aa/bb/ccccc), tetapi bagian aa/bb
   tidak dipaksa sama dengan bulan berjalan karena yang dikoreksi bisa PR lama. Jika nomor PR
   berubah, teks referensi pada transaksi pemasukan yang ditautkan ke PR itu ikut diperbarui.

2) `admin_update_inventory_document`
   Mengubah data dokumen sebuah transaksi tanpa menyentuh stok: referensi, keterangan,
   sumber (pemasukan), tujuan (pengeluaran), penerima (slip pengeluaran) dan lampiran GR.
   Berlaku untuk seluruh baris dalam dokumen yang sama (satu nomor GR / satu nomor slip).

3) `admin_correct_transaction_qty`
   Mengoreksi qty satu transaksi (stock_in / stock_out / adjustment) dan menghitung ulang saldo
   transaksi sesudahnya serta stok saat ini secara atomik. Aturan pengaman:
   - transaksi opname tidak dapat dikoreksi (saldonya absolut);
   - transaksi yang terkait Work Order / permintaan part ditolak (ubah lewat modul WO);
   - koreksi ditolak bila membuat saldo negatif di titik mana pun;
   - koreksi ditolak bila riwayat saldo part itu sudah tidak konsisten (mis. ada baris yang
     pernah dihapus manual), agar tidak memperburuk data;
   - untuk pemasukan yang ditautkan ke item PR, qty diterima pada PR ikut disesuaikan
     (tidak boleh < 0 atau > qty dipesan).
   Saldo setelah sebuah opname tidak berubah (opname menyetel ulang saldo).

Aman dijalankan ulang.
*/

-- =========================================================
-- 1) Koreksi nomor SAP / PR pada PR yang sudah bernomor
-- =========================================================
CREATE OR REPLACE FUNCTION public.admin_update_purchase_requirement_numbers(
  p_pr_id uuid,
  p_sap_no text,
  p_pr_no text,
  p_reason text
)
RETURNS public.purchase_requirements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_old public.purchase_requirements%ROWTYPE;
  v_row public.purchase_requirements%ROWTYPE;
  v_sap text := NULLIF(btrim(p_sap_no), '');
  v_pr text := NULLIF(btrim(p_pr_no), '');
  v_reason text := NULLIF(btrim(p_reason), '');
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengoreksi nomor SAP/PR.';
  END IF;

  IF v_reason IS NULL OR length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Alasan koreksi wajib diisi.';
  END IF;

  IF v_sap IS NULL OR v_pr IS NULL THEN
    RAISE EXCEPTION 'Nomor SAP dan nomor PR wajib diisi.';
  END IF;
  IF v_sap !~ '^16[0-9]{8}$' THEN
    RAISE EXCEPTION 'Format SAP harus 16xxxxxxxx (10 digit, awalan 16).';
  END IF;
  IF v_pr !~ '^TK/[0-9]{2}/[0-9]{2}/[0-9]{5}$' THEN
    RAISE EXCEPTION 'Format PR harus TK/aa/bb/ccccc.';
  END IF;

  SELECT * INTO v_old FROM public.purchase_requirements WHERE id = p_pr_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase Requirement tidak ditemukan.';
  END IF;
  IF v_old.status <> 'numbered' THEN
    RAISE EXCEPTION 'PR belum bernomor. Isi nomor lewat alur normal.';
  END IF;

  IF v_old.sap_no IS NOT DISTINCT FROM v_sap AND v_old.pr_no IS NOT DISTINCT FROM v_pr THEN
    RAISE EXCEPTION 'Tidak ada perubahan nomor.';
  END IF;

  BEGIN
    UPDATE public.purchase_requirements
    SET sap_no = v_sap, pr_no = v_pr, updated_at = now()
    WHERE id = p_pr_id
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Nomor SAP atau nomor PR tersebut sudah dipakai PR lain.';
  END;

  -- Referensi teks pada penerimaan yang sudah tercatat ikut diperbarui.
  IF v_old.pr_no IS NOT NULL AND v_old.pr_no <> v_pr THEN
    UPDATE public.inventory_transactions t
    SET reference = replace(t.reference, v_old.pr_no, v_pr)
    WHERE t.reference IS NOT NULL
      AND position(v_old.pr_no in t.reference) > 0
      AND t.pr_item_id IN (SELECT i.id FROM public.purchase_requirement_items i WHERE i.pr_id = p_pr_id);
  END IF;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
  VALUES (
    auth.uid(),
    'admin_update_pr_numbers',
    'purchase_requirement',
    v_row.id,
    'SAP ' || coalesce(v_old.sap_no, '-') || ' -> ' || v_sap || ' | PR ' || coalesce(v_old.pr_no, '-') || ' -> ' || v_pr,
    v_reason
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_purchase_requirement_numbers(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_purchase_requirement_numbers(uuid, text, text, text) TO authenticated;

-- =========================================================
-- 2) Ubah data dokumen transaksi (stok tidak berubah)
-- =========================================================
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
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengubah dokumen transaksi inventory.';
  END IF;

  IF v_reason IS NULL OR length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Alasan perubahan wajib diisi.';
  END IF;

  SELECT * INTO v_tx FROM public.inventory_transactions WHERE id = p_tx_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaksi tidak ditemukan.';
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

-- =========================================================
-- 3) Koreksi qty satu transaksi + hitung ulang saldo sesudahnya
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
