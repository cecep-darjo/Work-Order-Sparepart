/*
# WO Part Request: Approval perubahan SS -> SPV ke atas

Perubahan kewenangan tahap 1 approval permintaan part:
- Sebelumnya: hanya Admin / SS yang dapat menyetujui (approve) permintaan part.
- Sekarang: SPV, SS, dan Admin (SPV ke atas).

Aturan SPV: hanya boleh menyetujui/menolak untuk WO yang merupakan PIC-nya (work_orders.spv_id = auth.uid()).
Admin/SS tetap boleh untuk semua WO.

Reject juga diperluas ke SPV ke atas dengan aturan PIC yang sama.
Tahap 2 (process_part_request, potong stok) tetap hanya Inventory/Admin.

Aman dijalankan ulang.
*/

-- ---------------------------------------------------------------
-- Approve tahap 1: oleh SPV (PIC-nya)/SS/Admin, belum potong stok
-- ---------------------------------------------------------------
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
  IF v_role IS NULL OR v_role NOT IN ('admin','ss','spv') THEN
    RAISE EXCEPTION 'Hanya admin, SS, atau SPV yang dapat menyetujui permintaan spare part.';
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

  -- SPV hanya boleh menyetujui WO yang menjadi PIC-nya.
  IF v_role = 'spv' AND v_wo.spv_id <> auth.uid() THEN
    RAISE EXCEPTION 'Hanya SPV yang menjadi PIC WO ini yang dapat menyetujuinya.';
  END IF;

  UPDATE public.wo_part_requests
  SET status = 'ss_approved', decided_by = auth.uid(), decided_at = now(), decision_note = NULL
  WHERE id = p_request_id
  RETURNING * INTO v_req;

  INSERT INTO public.work_order_history (work_order_id, status, action, notes, performed_by)
  VALUES (v_req.work_order_id, v_wo.status, 'Spare part request approved by SPV/SS/Admin', v_req.request_no, auth.uid());

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'approve_part_request_ss', 'work_order', v_req.work_order_id,
          v_req.request_no || ' disetujui SPV/SS/admin; menunggu proses inventory');

  RETURN v_req;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_part_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_part_request(uuid) TO authenticated;

-- ---------------------------------------------------------------
-- Reject: oleh SPV (PIC-nya)/SS/Admin, sebelum final diproses inventory
-- ---------------------------------------------------------------
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
  v_spv_id uuid;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','ss','spv') THEN
    RAISE EXCEPTION 'Hanya admin, SS, atau SPV yang dapat menolak permintaan spare part.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Alasan penolakan wajib diisi.';
  END IF;

  SELECT * INTO v_req FROM public.wo_part_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Permintaan tidak ditemukan.'; END IF;
  IF v_req.status NOT IN ('pending','ss_approved') THEN
    RAISE EXCEPTION 'Permintaan % sudah diproses final (status: %).', v_req.request_no, v_req.status;
  END IF;

  -- SPV hanya boleh menolak untuk WO yang menjadi PIC-nya.
  SELECT spv_id INTO v_spv_id FROM public.work_orders WHERE id = v_req.work_order_id;
  IF v_role = 'spv' AND v_spv_id <> auth.uid() THEN
    RAISE EXCEPTION 'Hanya SPV yang menjadi PIC WO ini yang dapat menolak permintaannya.';
  END IF;

  UPDATE public.wo_part_requests
  SET status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = btrim(p_reason)
  WHERE id = p_request_id
  RETURNING * INTO v_req;

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