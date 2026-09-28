-- Inventory transaction v2
-- Pemasukan/pengeluaran tanpa approval; hanya admin/inventory.
-- Semua perubahan stok dilakukan atomik melalui RPC.

ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS transaction_no text,
  ADD COLUMN IF NOT EXISTS stock_before numeric,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS destination text,
  ADD COLUMN IF NOT EXISTS reversed_transaction_id uuid REFERENCES public.inventory_transactions(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transactions_transaction_no
  ON public.inventory_transactions(transaction_no)
  WHERE transaction_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_tx_created_at ON public.inventory_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_tx_work_order ON public.inventory_transactions(work_order_id);

CREATE TABLE IF NOT EXISTS public.inventory_tx_counters (
  tx_date date PRIMARY KEY,
  last_no integer NOT NULL DEFAULT 0
);

ALTER TABLE public.inventory_tx_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_tx_counters FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.next_inventory_transaction_no(p_type text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix text;
  v_no integer;
  v_date date := current_date;
BEGIN
  IF NOT (public.is_admin() OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'inventory'
  )) THEN
    RAISE EXCEPTION 'Hanya admin atau inventory yang dapat membuat transaksi inventory.';
  END IF;

  v_prefix := CASE p_type
    WHEN 'stock_in' THEN 'IN'
    WHEN 'stock_out' THEN 'OUT'
    WHEN 'adjustment' THEN 'ADJ'
    WHEN 'opname' THEN 'OPN'
    ELSE 'TX'
  END;

  INSERT INTO public.inventory_tx_counters (tx_date, last_no)
  VALUES (v_date, 1)
  ON CONFLICT (tx_date) DO UPDATE SET last_no = public.inventory_tx_counters.last_no + 1
  RETURNING last_no INTO v_no;

  RETURN v_prefix || '-' || to_char(v_date, 'YYMMDD') || '-' || lpad(v_no::text, 5, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.next_inventory_transaction_no(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_inventory_transaction_no(text) TO authenticated;

-- Prevent direct current_stock manipulation from normal client updates.
CREATE OR REPLACE FUNCTION public.prevent_direct_stock_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_stock IS DISTINCT FROM OLD.current_stock
     AND current_setting('app.inventory_tx', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Perubahan stok harus dilakukan melalui transaksi inventory.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_direct_stock_change ON public.spare_parts;
CREATE TRIGGER trg_prevent_direct_stock_change
BEFORE UPDATE ON public.spare_parts
FOR EACH ROW EXECUTE FUNCTION public.prevent_direct_stock_change();

CREATE OR REPLACE FUNCTION public.apply_inventory_transaction(
  p_spare_part_id uuid,
  p_type text,
  p_quantity numeric,
  p_reference text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_work_order_id uuid DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_destination text DEFAULT NULL
)
RETURNS public.inventory_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_part public.spare_parts%ROWTYPE;
  v_tx public.inventory_transactions%ROWTYPE;
  v_before numeric;
  v_after numeric;
  v_qty numeric;
  v_tx_no text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Hanya role admin atau inventory yang dapat melakukan transaksi stock.';
  END IF;

  IF p_type NOT IN ('stock_in','stock_out','adjustment','opname') THEN
    RAISE EXCEPTION 'Jenis transaksi tidak valid.';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity harus lebih besar dari 0.';
  END IF;

  SELECT * INTO v_part
  FROM public.spare_parts
  WHERE id = p_spare_part_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Spare part tidak ditemukan.';
  END IF;

  v_before := v_part.current_stock;

  IF p_type = 'stock_in' THEN
    v_qty := p_quantity;
    v_after := v_before + p_quantity;
  ELSIF p_type = 'stock_out' THEN
    v_qty := p_quantity;
    v_after := v_before - p_quantity;
    IF v_after < 0 THEN
      RAISE EXCEPTION 'Stok tidak mencukupi. Stok tersedia: % %.', v_before, v_part.unit;
    END IF;
  ELSIF p_type = 'adjustment' THEN
    -- Adjustment menggunakan quantity sebagai nilai perubahan; positif menambah,
    -- negatif mengurangi. UI normal tidak memakai jenis ini untuk transaksi rutin.
    v_qty := p_quantity;
    v_after := v_before + p_quantity;
  ELSE
    -- Opname menggunakan quantity sebagai saldo fisik baru.
    v_qty := p_quantity;
    v_after := p_quantity;
  END IF;

  v_tx_no := public.next_inventory_transaction_no(p_type);

  PERFORM set_config('app.inventory_tx', '1', true);

  UPDATE public.spare_parts
  SET current_stock = v_after,
      updated_at = now()
  WHERE id = p_spare_part_id;

  INSERT INTO public.inventory_transactions (
    spare_part_id, type, quantity, balance_after, reference, notes,
    work_order_id, created_by, transaction_no, stock_before, source, destination
  ) VALUES (
    p_spare_part_id, p_type, v_qty, v_after, NULLIF(btrim(p_reference), ''),
    NULLIF(btrim(p_notes), ''), p_work_order_id, auth.uid(), v_tx_no,
    v_before, NULLIF(btrim(p_source), ''), NULLIF(btrim(p_destination), '')
  ) RETURNING * INTO v_tx;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    'inventory_' || p_type,
    'inventory_transaction',
    v_tx.id,
    v_tx_no || ' | ' || v_part.code || ' | qty ' || p_quantity::text ||
      ' | saldo ' || v_before::text || ' -> ' || v_after::text
  );

  RETURN v_tx;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_inventory_transaction(uuid,text,numeric,text,text,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_inventory_transaction(uuid,text,numeric,text,text,uuid,text,text) TO authenticated;

-- Existing transaction inserts remain available for legacy WO data, but routine UI
-- transactions use the atomic RPC above. Remove direct transaction deletion for
-- inventory users; admin can still delete legacy records if necessary.
DROP POLICY IF EXISTS "admin_delete_inventory_tx" ON public.inventory_transactions;
CREATE POLICY "admin_delete_inventory_tx" ON public.inventory_transactions FOR DELETE
TO authenticated USING (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
);
