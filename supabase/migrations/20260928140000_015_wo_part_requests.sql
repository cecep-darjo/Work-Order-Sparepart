/*
# Permintaan spare part dari Work Order + approval PIC Inventory

Alur baru:
1. Teknisi (yang ditugaskan) atau admin mengajukan permintaan spare part dari halaman WO.
   Satu permintaan bisa berisi beberapa barang + keperluan.  -> stok BELUM berubah.
2. Permintaan muncul di Dashboard admin / inventory. PIC Inventory tinggal Approve
   (atau Reject dengan alasan).
3. Saat di-approve, dalam SATU transaksi database: stok dipotong, baris work_order_parts
   dibuat, transaksi stock_out dicatat (referensi = nomor permintaan), dan permintaan
   ditandai approved. Jika stok salah satu barang kurang, seluruh approve dibatalkan.
4. Lembar Pengeluaran Barang (PDF) dibuat dari data permintaan yang sudah approved.

Keamanan:
- Tabel hanya bisa diubah lewat fungsi RPC di bawah (tidak ada policy INSERT/UPDATE/DELETE).
- consume_work_order_part (potong stok langsung tanpa approval) kini hanya untuk admin /
  inventory, supaya teknisi tidak bisa memintas approval lewat API.

Aman dijalankan ulang.
*/

-- ---------- Penomoran: REQ-YYMMDD-00001 (reset harian) ----------
CREATE TABLE IF NOT EXISTS public.part_request_counters (
  req_date date PRIMARY KEY,
  last_no integer NOT NULL DEFAULT 0
);
ALTER TABLE public.part_request_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.part_request_counters FROM PUBLIC, anon, authenticated;

-- ---------- Tabel ----------
CREATE TABLE IF NOT EXISTS public.wo_part_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no text NOT NULL UNIQUE,
  work_order_id uuid NOT NULL REFERENCES public.work_orders(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text
);

CREATE TABLE IF NOT EXISTS public.wo_part_request_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.wo_part_requests(id) ON DELETE CASCADE,
  spare_part_id uuid NOT NULL REFERENCES public.spare_parts(id) ON DELETE RESTRICT,
  quantity numeric NOT NULL CHECK (quantity > 0),
  note text,
  -- terisi saat approved; menjadi NULL bila part kemudian dikembalikan dari WO
  work_order_part_id uuid REFERENCES public.work_order_parts(id) ON DELETE SET NULL,
  UNIQUE (request_id, spare_part_id)
);

CREATE INDEX IF NOT EXISTS idx_wo_part_requests_status ON public.wo_part_requests(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_wo_part_requests_wo ON public.wo_part_requests(work_order_id);
CREATE INDEX IF NOT EXISTS idx_wo_part_request_items_req ON public.wo_part_request_items(request_id);

-- ---------- RLS: baca saja; tulis hanya lewat RPC ----------
ALTER TABLE public.wo_part_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wo_part_request_items ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.wo_part_requests FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.wo_part_request_items FROM anon, authenticated;

-- Siapa pun yang boleh melihat WO-nya (admin, inventory, SPV departemen, teknisi
-- yang ditugaskan) boleh melihat permintaannya; pengaju selalu boleh.
DROP POLICY IF EXISTS "read_wo_part_requests" ON public.wo_part_requests;
CREATE POLICY "read_wo_part_requests" ON public.wo_part_requests FOR SELECT
  TO authenticated USING (
    requested_by = auth.uid()
    OR EXISTS (SELECT 1 FROM public.work_orders w WHERE w.id = wo_part_requests.work_order_id)
  );

DROP POLICY IF EXISTS "read_wo_part_request_items" ON public.wo_part_request_items;
CREATE POLICY "read_wo_part_request_items" ON public.wo_part_request_items FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.wo_part_requests r WHERE r.id = wo_part_request_items.request_id)
  );

-- ---------- RPC: buat permintaan ----------
CREATE OR REPLACE FUNCTION public.create_part_request(
  p_work_order_id uuid,
  p_purpose text,
  p_items jsonb
)
RETURNS public.wo_part_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_wo public.work_orders%ROWTYPE;
  v_req public.wo_part_requests%ROWTYPE;
  v_no integer;
  v_date date := current_date;
  v_request_no text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'User tidak aktif atau tidak dikenal.';
  END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_work_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work order tidak ditemukan.'; END IF;

  IF NOT (v_role = 'admin' OR (v_role = 'teknisi' AND public.is_wo_technician(p_work_order_id))) THEN
    RAISE EXCEPTION 'Hanya admin atau teknisi yang ditugaskan pada WO ini yang dapat mengajukan spare part.';
  END IF;

  IF v_wo.status IN ('closed','verified') THEN
    RAISE EXCEPTION 'WO sudah % dan tidak dapat meminta spare part.', v_wo.status;
  END IF;

  IF p_purpose IS NULL OR btrim(p_purpose) = '' THEN
    RAISE EXCEPTION 'Keperluan wajib diisi.';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Daftar barang tidak boleh kosong.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric, note text)
    WHERE i.spare_part_id IS NULL OR i.quantity IS NULL OR i.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Setiap barang harus memiliki spare part dan quantity lebih besar dari 0.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric, note text)
    WHERE NOT EXISTS (SELECT 1 FROM public.spare_parts s WHERE s.id = i.spare_part_id)
  ) THEN
    RAISE EXCEPTION 'Ada spare part yang tidak ditemukan.';
  END IF;

  INSERT INTO public.part_request_counters (req_date, last_no)
  VALUES (v_date, 1)
  ON CONFLICT (req_date) DO UPDATE SET last_no = public.part_request_counters.last_no + 1
  RETURNING last_no INTO v_no;
  v_request_no := 'REQ-' || to_char(v_date, 'YYMMDD') || '-' || lpad(v_no::text, 5, '0');

  INSERT INTO public.wo_part_requests (request_no, work_order_id, purpose, requested_by)
  VALUES (v_request_no, p_work_order_id, btrim(p_purpose), auth.uid())
  RETURNING * INTO v_req;

  -- Barang ganda digabung (qty dijumlahkan).
  INSERT INTO public.wo_part_request_items (request_id, spare_part_id, quantity, note)
  SELECT v_req.id, i.spare_part_id, SUM(i.quantity), NULLIF(btrim(MAX(i.note)), '')
  FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric, note text)
  GROUP BY i.spare_part_id;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'wo_part_request', 'work_order', p_work_order_id,
          v_request_no || ' diajukan untuk ' || v_wo.wo_number);

  RETURN v_req;
END;
$$;

REVOKE ALL ON FUNCTION public.create_part_request(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_part_request(uuid, text, jsonb) TO authenticated;

-- ---------- RPC: approve (potong stok atomik) ----------
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
  v_item record;
  v_part public.spare_parts%ROWTYPE;
  v_wop public.work_order_parts%ROWTYPE;
  v_before numeric;
  v_after numeric;
  v_tx_no text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Hanya admin atau inventory yang dapat menyetujui permintaan spare part.';
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

  -- Urutan tetap (by spare_part_id) agar tidak deadlock antar-approval.
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
  SET status = 'approved', decided_by = auth.uid(), decided_at = now()
  WHERE id = p_request_id
  RETURNING * INTO v_req;

  INSERT INTO public.work_order_history (work_order_id, status, action, notes, performed_by)
  VALUES (v_req.work_order_id, v_wo.status, 'Spare part request approved', v_req.request_no, auth.uid());

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'approve_part_request', 'work_order', v_req.work_order_id,
          v_req.request_no || ' disetujui');

  RETURN v_req;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_part_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_part_request(uuid) TO authenticated;

-- ---------- RPC: reject ----------
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
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Hanya admin atau inventory yang dapat menolak permintaan spare part.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Alasan penolakan wajib diisi.';
  END IF;

  SELECT * INTO v_req FROM public.wo_part_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Permintaan tidak ditemukan.'; END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Permintaan % sudah diproses (status: %).', v_req.request_no, v_req.status;
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

-- ---------- RPC: batalkan (pengaju atau admin) ----------
CREATE OR REPLACE FUNCTION public.cancel_part_request(p_request_id uuid)
RETURNS public.wo_part_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.wo_part_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM public.wo_part_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Permintaan tidak ditemukan.'; END IF;

  IF NOT (v_req.requested_by = auth.uid() OR public.is_admin()) THEN
    RAISE EXCEPTION 'Hanya pengaju atau admin yang dapat membatalkan permintaan.';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Permintaan % sudah diproses (status: %).', v_req.request_no, v_req.status;
  END IF;

  UPDATE public.wo_part_requests
  SET status = 'cancelled', decided_by = auth.uid(), decided_at = now()
  WHERE id = p_request_id
  RETURNING * INTO v_req;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'cancel_part_request', 'work_order', v_req.work_order_id,
          v_req.request_no || ' dibatalkan');

  RETURN v_req;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_part_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_part_request(uuid) TO authenticated;

-- ---------- Potong stok langsung: hanya admin / inventory ----------
CREATE OR REPLACE FUNCTION public.consume_work_order_part(
  p_work_order_id uuid,
  p_spare_part_id uuid,
  p_quantity numeric
)
RETURNS public.work_order_parts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_wo public.work_orders%ROWTYPE;
  v_part public.spare_parts%ROWTYPE;
  v_wop public.work_order_parts%ROWTYPE;
  v_before numeric;
  v_after numeric;
  v_tx_no text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Pengeluaran spare part untuk WO harus melalui permintaan yang disetujui inventory.';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity harus lebih besar dari 0.';
  END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work order tidak ditemukan.'; END IF;

  SELECT * INTO v_part FROM public.spare_parts WHERE id = p_spare_part_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Spare part tidak ditemukan.'; END IF;

  v_before := v_part.current_stock;
  v_after := v_before - p_quantity;
  IF v_after < 0 THEN
    RAISE EXCEPTION 'Stok tidak mencukupi. Stok tersedia: % %.', v_before, v_part.unit;
  END IF;

  v_tx_no := public.next_inventory_transaction_no('stock_out');
  PERFORM set_config('app.inventory_tx', '1', true);
  UPDATE public.spare_parts SET current_stock = v_after, updated_at = now() WHERE id = p_spare_part_id;

  INSERT INTO public.work_order_parts(work_order_id, spare_part_id, quantity)
  VALUES (p_work_order_id, p_spare_part_id, p_quantity)
  RETURNING * INTO v_wop;

  INSERT INTO public.inventory_transactions (
    spare_part_id, type, quantity, balance_after, reference, notes,
    work_order_id, created_by, transaction_no, stock_before, destination
  ) VALUES (
    p_spare_part_id, 'stock_out', p_quantity, v_after, v_wo.wo_number,
    'Used on ' || v_wo.wo_number, p_work_order_id, auth.uid(), v_tx_no,
    v_before, 'Work Order'
  );

  INSERT INTO public.activity_log(user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'wo_spare_part_out', 'work_order', p_work_order_id,
          v_tx_no || ' | ' || v_part.code || ' x' || p_quantity::text);

  RETURN v_wop;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_work_order_part(uuid,uuid,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_work_order_part(uuid,uuid,numeric) TO authenticated;
