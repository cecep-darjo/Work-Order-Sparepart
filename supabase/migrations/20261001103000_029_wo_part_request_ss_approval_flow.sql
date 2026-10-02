/*
# WO Part Request: Approval SS -> Process Inventory

Perubahan alur:
1) Teknisi mengajukan permintaan (status: pending).
2) Persetujuan awal oleh SS/Admin (status: ss_approved).
3) Setelah itu Inventory/Admin memproses pengeluaran stok (status: approved).

Aman dijalankan ulang.
*/

-- Tambah status transisi baru: ss_approved
ALTER TABLE public.wo_part_requests DROP CONSTRAINT IF EXISTS wo_part_requests_status_check;
ALTER TABLE public.wo_part_requests
  ADD CONSTRAINT wo_part_requests_status_check
  CHECK (status IN ('pending','ss_approved','approved','rejected','cancelled'));

-- Approve tahap 1: oleh SS/Admin, belum potong stok
CREATE OR REPLACE FUNCTION public.approve_part_request(p_request_id uuid)
RETURNS public.wo_part_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_req public.wo_part_requests%ROWTYPE;
  v_wo public.work_orders%ROWTYPE;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','ss') THEN
    RAISE EXCEPTION 'Hanya admin atau SS yang dapat menyetujui permintaan spare part.';
  END IF;

  SELECT * INTO v_req FROM public.wo_part_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Permintaan tidak ditemukan.'; END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Permintaan % sudah diproses (status: %).', v_req.request_no, v_req.status;
  END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = v_req.work_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work order tidak ditemukan.'; END IF;
  IF v_wo.status IN ('closed','verified') THEN
    RAISE EXCEPTION 'WO % sudah % sehingga permintaan tidak dapat disetujui.', v_wo.wo_number, v_wo.status;
  END IF;

  UPDATE public.wo_part_requests
  SET status = 'ss_approved', decided_by = auth.uid(), decided_at = now(), decision_note = NULL
  WHERE id = p_request_id
  RETURNING * INTO v_req;

  INSERT INTO public.work_order_history (work_order_id, status, action, notes, performed_by)
  VALUES (v_req.work_order_id, v_wo.status, 'Spare part request approved by SS', v_req.request_no, auth.uid());

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'approve_part_request_ss', 'work_order', v_req.work_order_id,
          v_req.request_no || ' disetujui SS/admin; menunggu proses inventory');

  RETURN v_req;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_part_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_part_request(uuid) TO authenticated;

-- Proses tahap 2: oleh Inventory/Admin, potong stok atomik + final approved
CREATE OR REPLACE FUNCTION public.process_part_request(p_request_id uuid)
RETURNS public.wo_part_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_req public.wo_part_requests%ROWTYPE;
  v_wo public.work_orders%ROWTYPE;
  v_item record;
  v_part public.spare_parts%ROWTYPE;
  v_wop public.work_order_parts%ROWTYPE;
  v_before numeric;
  v_after numeric;
  v_tx_no text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Hanya admin atau inventory yang dapat memproses pengeluaran spare part.';
  END IF;

  SELECT * INTO v_req FROM public.wo_part_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Permintaan tidak ditemukan.'; END IF;
  IF v_req.status <> 'ss_approved' THEN
    RAISE EXCEPTION 'Permintaan % belum disetujui SS/admin (status: %).', v_req.request_no, v_req.status;
  END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = v_req.work_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work order tidak ditemukan.'; END IF;
  IF v_wo.status IN ('closed','verified') THEN
    RAISE EXCEPTION 'WO % sudah % sehingga permintaan tidak dapat diproses.', v_wo.wo_number, v_wo.status;
  END IF;

  FOR v_item IN
    SELECT * FROM public.wo_part_request_items WHERE request_id = p_request_id ORDER BY spare_part_id
  LOOP
    SELECT * INTO v_part FROM public.spare_parts WHERE id = v_item.spare_part_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Spare part tidak ditemukan.'; END IF;

    v_before := v_part.current_stock;
    v_after := v_before - v_item.quantity;
    IF v_after < 0 THEN
      RAISE EXCEPTION 'Stok % (%) tidak mencukupi. Tersedia: % %, diminta: %.',
        v_part.name, v_part.code, v_before, v_part.unit, v_item.quantity;
    END IF;

    v_tx_no := public.next_inventory_transaction_no('stock_out');
    PERFORM set_config('app.inventory_tx', '1', true);
    UPDATE public.spare_parts SET current_stock = v_after, updated_at = now() WHERE id = v_part.id;

    INSERT INTO public.work_order_parts (work_order_id, spare_part_id, quantity)
    VALUES (v_req.work_order_id, v_part.id, v_item.quantity)
    RETURNING * INTO v_wop;

    UPDATE public.wo_part_request_items SET work_order_part_id = v_wop.id WHERE id = v_item.id;

    INSERT INTO public.inventory_transactions (
      spare_part_id, type, quantity, balance_after, reference, notes,
      work_order_id, created_by, transaction_no, stock_before, destination
    ) VALUES (
      v_part.id, 'stock_out', v_item.quantity, v_after, v_req.request_no,
      'Permintaan ' || v_req.request_no || ' untuk ' || v_wo.wo_number,
      v_req.work_order_id, auth.uid(), v_tx_no, v_before, 'Work Order'
    );

    INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
    VALUES (auth.uid(), 'wo_spare_part_out', 'work_order', v_req.work_order_id,
            v_tx_no || ' | ' || v_part.code || ' x' || v_item.quantity::text || ' | ' || v_req.request_no);
  END LOOP;

  UPDATE public.wo_part_requests
  SET status = 'approved'
  WHERE id = p_request_id
  RETURNING * INTO v_req;

  INSERT INTO public.work_order_history (work_order_id, status, action, notes, performed_by)
  VALUES (v_req.work_order_id, v_wo.status, 'Spare part request processed by inventory', v_req.request_no, auth.uid());

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'process_part_request_inventory', 'work_order', v_req.work_order_id,
          v_req.request_no || ' diproses pengeluaran inventory');

  RETURN v_req;
END;
$$;

REVOKE ALL ON FUNCTION public.process_part_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_part_request(uuid) TO authenticated;

-- Reject hanya oleh SS/Admin, sebelum final diproses inventory
CREATE OR REPLACE FUNCTION public.reject_part_request(p_request_id uuid, p_reason text)
RETURNS public.wo_part_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_req public.wo_part_requests%ROWTYPE;
  v_wo_status text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','ss') THEN
    RAISE EXCEPTION 'Hanya admin atau SS yang dapat menolak permintaan spare part.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Alasan penolakan wajib diisi.';
  END IF;

  SELECT * INTO v_req FROM public.wo_part_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Permintaan tidak ditemukan.'; END IF;
  IF v_req.status NOT IN ('pending','ss_approved') THEN
    RAISE EXCEPTION 'Permintaan % sudah diproses final (status: %).', v_req.request_no, v_req.status;
  END IF;

  UPDATE public.wo_part_requests
  SET status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = btrim(p_reason)
  WHERE id = p_request_id
  RETURNING * INTO v_req;

  SELECT status INTO v_wo_status FROM public.work_orders WHERE id = v_req.work_order_id;
  INSERT INTO public.work_order_history (work_order_id, status, action, notes, performed_by)
  VALUES (v_req.work_order_id, COALESCE(v_wo_status, 'new'), 'Spare part request rejected',
          v_req.request_no || ': ' || btrim(p_reason), auth.uid());

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
  VALUES (auth.uid(), 'reject_part_request', 'work_order', v_req.work_order_id,
          v_req.request_no || ' ditolak', btrim(p_reason));

  RETURN v_req;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_part_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_part_request(uuid, text) TO authenticated;
