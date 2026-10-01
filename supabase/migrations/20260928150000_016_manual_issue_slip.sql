/*
# Pengeluaran manual multi-barang + nomor dokumen (Lembar Pengeluaran Barang)

- inventory_transactions.issue_slip_no : nomor dokumen (BPB-YYMMDD-00001) yang mengelompokkan
  beberapa barang dalam satu pengeluaran manual.
- inventory_transactions.recipient     : nama penerima barang.
- issue_stock_manual(...)              : mengeluarkan beberapa barang sekaligus, ATOMIK.
  Jika stok salah satu barang kurang, seluruh pengeluaran dibatalkan (tidak ada stok
  yang berkurang sebagian). Tiap barang tetap tercatat sebagai transaksi stock_out
  (OUT-...) lewat apply_inventory_transaction, sehingga stock card tidak berubah.

Data lama tidak diubah. Aman dijalankan ulang.
*/

ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS issue_slip_no text,
  ADD COLUMN IF NOT EXISTS recipient text;

CREATE INDEX IF NOT EXISTS idx_inventory_tx_issue_slip
  ON public.inventory_transactions(issue_slip_no)
  WHERE issue_slip_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.issue_slip_counters (
  slip_date date PRIMARY KEY,
  last_no integer NOT NULL DEFAULT 0
);
ALTER TABLE public.issue_slip_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.issue_slip_counters FROM PUBLIC, anon, authenticated;

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
  v_no integer;
  v_date date := current_date;
  v_slip_no text;
  v_count integer := 0;
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
    SELECT 1 FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric)
    WHERE i.spare_part_id IS NULL OR i.quantity IS NULL OR i.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Setiap barang harus memiliki spare part dan quantity lebih besar dari 0.';
  END IF;

  INSERT INTO public.issue_slip_counters (slip_date, last_no)
  VALUES (v_date, 1)
  ON CONFLICT (slip_date) DO UPDATE SET last_no = public.issue_slip_counters.last_no + 1
  RETURNING last_no INTO v_no;
  v_slip_no := 'BPB-' || to_char(v_date, 'YYMMDD') || '-' || lpad(v_no::text, 5, '0');

  -- Barang yang sama digabung; urutan tetap (by id) agar tidak deadlock antar-transaksi.
  FOR v_item IN
    SELECT i.spare_part_id, SUM(i.quantity) AS quantity
    FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric)
    GROUP BY i.spare_part_id
    ORDER BY i.spare_part_id
  LOOP
    SELECT * INTO v_part FROM public.spare_parts WHERE id = v_item.spare_part_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Spare part tidak ditemukan.'; END IF;

    IF v_part.current_stock < v_item.quantity THEN
      RAISE EXCEPTION 'Stok % (%) tidak mencukupi. Tersedia: % %, diminta: %.',
        v_part.name, v_part.code, v_part.current_stock, v_part.unit, v_item.quantity;
    END IF;

    v_tx := public.apply_inventory_transaction(
      v_item.spare_part_id, 'stock_out', v_item.quantity,
      p_reference, p_notes, NULL, NULL, p_destination
    );

    UPDATE public.inventory_transactions
    SET issue_slip_no = v_slip_no, recipient = btrim(p_recipient)
    WHERE id = v_tx.id;

    v_count := v_count + 1;
  END LOOP;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'inventory_issue_slip', 'inventory_transaction', v_tx.id,
          v_slip_no || ' | ' || v_count::text || ' barang | penerima ' || btrim(p_recipient));

  RETURN v_slip_no;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_stock_manual(jsonb, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_stock_manual(jsonb, text, text, text, text) TO authenticated;
