/*
# GR Numbering + Lampiran penerimaan barang

Kebutuhan:
1) Pemasukan (stock_in) dapat menghasilkan nomor GR:
   - credit: aa/SKSB/bb/ccccc
   - cash:   aa/STSB/bb/ccccc
   - import: aa/SKIS/bb/ccccc
   aa=2 digit tahun, bb=2 digit bulan, ccccc=urut 5 digit.
2) Nomor urut reset saat ganti tahun.
3) Admin dapat mengatur nomor awal urut (global untuk semua jenis GR).
4) Penerimaan dapat menyimpan lampiran (foto/pdf) max 5MB/file.

Aman dijalankan ulang.
*/

ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS gr_no text,
  ADD COLUMN IF NOT EXISTS gr_kind text CHECK (gr_kind IN ('credit','cash','import')),
  ADD COLUMN IF NOT EXISTS gr_attachments text[];

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transactions_gr_no
  ON public.inventory_transactions(gr_no)
  WHERE gr_no IS NOT NULL;

-- ---------- Konfigurasi nomor awal GR (global) ----------
CREATE TABLE IF NOT EXISTS public.gr_number_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  start_no integer NOT NULL DEFAULT 1 CHECK (start_no BETWEEN 1 AND 99999),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

INSERT INTO public.gr_number_settings (id, start_no)
VALUES (true, 1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.gr_number_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gr_number_settings FROM PUBLIC, anon, authenticated;

-- ---------- Counter GR per tahun + jenis ----------
CREATE TABLE IF NOT EXISTS public.gr_number_counters (
  gr_year integer NOT NULL,
  gr_kind text NOT NULL CHECK (gr_kind IN ('credit','cash','import')),
  last_no integer NOT NULL CHECK (last_no BETWEEN 1 AND 99999),
  PRIMARY KEY (gr_year, gr_kind)
);

ALTER TABLE public.gr_number_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gr_number_counters FROM PUBLIC, anon, authenticated;

-- ---------- Helper: ambil nomor awal ----------
CREATE OR REPLACE FUNCTION public.get_gr_start_number()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start integer;
BEGIN
  SELECT start_no INTO v_start FROM public.gr_number_settings WHERE id = true;
  IF v_start IS NULL THEN
    INSERT INTO public.gr_number_settings (id, start_no)
    VALUES (true, 1)
    ON CONFLICT (id) DO NOTHING;
    v_start := 1;
  END IF;
  RETURN v_start;
END;
$$;

REVOKE ALL ON FUNCTION public.get_gr_start_number() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gr_start_number() TO authenticated;

-- ---------- Admin: set nomor awal ----------
CREATE OR REPLACE FUNCTION public.set_gr_start_number(p_start_no integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengatur nomor awal GR.';
  END IF;

  IF p_start_no IS NULL OR p_start_no < 1 OR p_start_no > 99999 THEN
    RAISE EXCEPTION 'Nomor awal harus di antara 1 sampai 99999.';
  END IF;

  INSERT INTO public.gr_number_settings (id, start_no, updated_at, updated_by)
  VALUES (true, p_start_no, now(), auth.uid())
  ON CONFLICT (id) DO UPDATE
    SET start_no = EXCLUDED.start_no,
        updated_at = now(),
        updated_by = auth.uid();

  INSERT INTO public.activity_log (user_id, action, entity_type, details)
  VALUES (auth.uid(), 'set_gr_start_number', 'inventory_transaction', 'Nomor awal GR diatur ke ' || p_start_no::text);

  RETURN p_start_no;
END;
$$;

REVOKE ALL ON FUNCTION public.set_gr_start_number(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_gr_start_number(integer) TO authenticated;

-- ---------- Generator nomor GR ----------
CREATE OR REPLACE FUNCTION public.next_gr_number(p_gr_kind text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_code text;
  v_year integer := EXTRACT(YEAR FROM current_date)::integer;
  v_no integer;
  v_start integer;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Hanya admin atau inventory yang dapat membuat nomor GR.';
  END IF;

  IF p_gr_kind NOT IN ('credit','cash','import') THEN
    RAISE EXCEPTION 'Jenis GR tidak valid. Gunakan credit/cash/import.';
  END IF;

  SELECT start_no INTO v_start FROM public.gr_number_settings WHERE id = true;
  IF v_start IS NULL THEN
    v_start := 1;
  END IF;

  INSERT INTO public.gr_number_counters (gr_year, gr_kind, last_no)
  VALUES (v_year, p_gr_kind, v_start)
  ON CONFLICT (gr_year, gr_kind) DO UPDATE
    SET last_no = public.gr_number_counters.last_no + 1
  RETURNING last_no INTO v_no;

  v_code := CASE p_gr_kind
    WHEN 'credit' THEN 'SKSB'
    WHEN 'cash' THEN 'STSB'
    WHEN 'import' THEN 'SKIS'
    ELSE 'GR'
  END;

  RETURN to_char(current_date, 'YY') || '/' || v_code || '/' || to_char(current_date, 'MM') || '/' || lpad(v_no::text, 5, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.next_gr_number(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_gr_number(text) TO authenticated;

-- ---------- Upgrade RPC transaksi inventory ----------
-- Catatan kompatibilitas:
-- Jangan drop signature lama (8 parameter), karena bisa sudah direferensikan fungsi lain
-- seperti issue_stock_manual. Kita tambah signature baru (10 parameter) dan nanti
-- rewire signature lama sebagai wrapper ke signature baru.

CREATE OR REPLACE FUNCTION public.apply_inventory_transaction(
  p_spare_part_id uuid,
  p_type text,
  p_quantity numeric,
  p_reference text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_work_order_id uuid DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_destination text DEFAULT NULL,
  p_gr_kind text DEFAULT NULL,
  p_gr_attachments text[] DEFAULT NULL
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
  v_gr_no text;
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

  IF p_gr_kind IS NOT NULL AND p_gr_kind NOT IN ('credit','cash','import') THEN
    RAISE EXCEPTION 'Jenis GR tidak valid. Gunakan credit/cash/import.';
  END IF;

  IF p_type <> 'stock_in' AND p_gr_kind IS NOT NULL THEN
    RAISE EXCEPTION 'Jenis GR hanya berlaku untuk transaksi pemasukan (stock_in).';
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
    v_gr_no := CASE WHEN p_gr_kind IS NOT NULL THEN public.next_gr_number(p_gr_kind) ELSE NULL END;
  ELSIF p_type = 'stock_out' THEN
    v_qty := p_quantity;
    v_after := v_before - p_quantity;
    IF v_after < 0 THEN
      RAISE EXCEPTION 'Stok tidak mencukupi. Stok tersedia: % %.', v_before, v_part.unit;
    END IF;
  ELSIF p_type = 'adjustment' THEN
    v_qty := p_quantity;
    v_after := v_before + p_quantity;
  ELSE
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
    work_order_id, created_by, transaction_no, stock_before, source, destination,
    gr_no, gr_kind, gr_attachments
  ) VALUES (
    p_spare_part_id, p_type, v_qty, v_after, NULLIF(btrim(p_reference), ''),
    NULLIF(btrim(p_notes), ''), p_work_order_id, auth.uid(), v_tx_no,
    v_before, NULLIF(btrim(p_source), ''), NULLIF(btrim(p_destination), ''),
    v_gr_no,
    CASE WHEN p_type = 'stock_in' THEN p_gr_kind ELSE NULL END,
    CASE WHEN p_type = 'stock_in' THEN p_gr_attachments ELSE NULL END
  ) RETURNING * INTO v_tx;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    'inventory_' || p_type,
    'inventory_transaction',
    v_tx.id,
    v_tx_no ||
      CASE WHEN v_gr_no IS NOT NULL THEN ' | GR ' || v_gr_no ELSE '' END ||
      ' | ' || v_part.code ||
      ' | qty ' || p_quantity::text ||
      ' | saldo ' || v_before::text || ' -> ' || v_after::text
  );

  RETURN v_tx;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_inventory_transaction(uuid,text,numeric,text,text,uuid,text,text,text,text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_inventory_transaction(uuid,text,numeric,text,text,uuid,text,text,text,text[]) TO authenticated;

-- Signature lama (8 parameter) dipertahankan sebagai wrapper kompatibilitas.
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
BEGIN
  RETURN public.apply_inventory_transaction(
    p_spare_part_id,
    p_type,
    p_quantity,
    p_reference,
    p_notes,
    p_work_order_id,
    p_source,
    p_destination,
    NULL,
    NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_inventory_transaction(uuid,text,numeric,text,text,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_inventory_transaction(uuid,text,numeric,text,text,uuid,text,text) TO authenticated;

-- ---------- Storage bucket untuk lampiran GR ----------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'inventory-gr-files',
  'inventory-gr-files',
  true,
  5242880,
  ARRAY['image/jpeg','image/png','image/webp','application/pdf']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "inventory_gr_files_read" ON storage.objects;
CREATE POLICY "inventory_gr_files_read" ON storage.objects FOR SELECT
TO authenticated USING (bucket_id = 'inventory-gr-files');

DROP POLICY IF EXISTS "inventory_gr_files_insert" ON storage.objects;
CREATE POLICY "inventory_gr_files_insert" ON storage.objects FOR INSERT
TO authenticated WITH CHECK (
  bucket_id = 'inventory-gr-files'
  AND (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'inventory' AND p.is_active = true
    )
  )
);

DROP POLICY IF EXISTS "inventory_gr_files_update" ON storage.objects;
CREATE POLICY "inventory_gr_files_update" ON storage.objects FOR UPDATE
TO authenticated USING (
  bucket_id = 'inventory-gr-files'
  AND (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'inventory' AND p.is_active = true
    )
  )
) WITH CHECK (
  bucket_id = 'inventory-gr-files'
  AND (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'inventory' AND p.is_active = true
    )
  )
);

DROP POLICY IF EXISTS "inventory_gr_files_delete" ON storage.objects;
CREATE POLICY "inventory_gr_files_delete" ON storage.objects FOR DELETE
TO authenticated USING (
  bucket_id = 'inventory-gr-files'
  AND (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'inventory' AND p.is_active = true
    )
  )
);
