/*
# GR numbering per jenis + generate dulu sebelum simpan

Perubahan:
1) Nomor awal GR dipisah per jenis (credit/cash/import), bukan global.
2) Tambah RPC setting per jenis:
   - get_gr_start_number(p_gr_kind)
   - get_gr_start_numbers()
   - set_gr_start_number(p_gr_kind, p_start_no)
3) next_gr_number memakai start number per jenis.
4) apply_inventory_transaction ditingkatkan:
   - signature utama 11 param (tambahan p_gr_no)
   - tetap sediakan wrapper signature 10 dan 8 param untuk kompatibilitas.
   - jika p_gr_no dikirim, dipakai apa adanya (nomor sudah di-generate sebelumnya).

Aman dijalankan ulang.
*/

-- ---------- Settings nomor awal GR per jenis ----------
CREATE TABLE IF NOT EXISTS public.gr_number_kind_settings (
  gr_kind text PRIMARY KEY CHECK (gr_kind IN ('credit','cash','import')),
  start_no integer NOT NULL DEFAULT 1 CHECK (start_no BETWEEN 1 AND 99999),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.gr_number_kind_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gr_number_kind_settings FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_start integer := 1;
BEGIN
  SELECT start_no INTO v_start
  FROM public.gr_number_settings
  WHERE id = true;

  v_start := COALESCE(v_start, 1);

  INSERT INTO public.gr_number_kind_settings (gr_kind, start_no)
  VALUES
    ('credit', v_start),
    ('cash', v_start),
    ('import', v_start)
  ON CONFLICT (gr_kind) DO NOTHING;
END;
$$;

-- ---------- Get nomor awal per jenis ----------
CREATE OR REPLACE FUNCTION public.get_gr_start_number(p_gr_kind text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind text;
  v_start integer;
BEGIN
  v_kind := lower(coalesce(p_gr_kind, ''));
  IF v_kind NOT IN ('credit','cash','import') THEN
    RAISE EXCEPTION 'Jenis GR tidak valid. Gunakan credit/cash/import.';
  END IF;

  SELECT start_no INTO v_start
  FROM public.gr_number_kind_settings
  WHERE gr_kind = v_kind;

  IF v_start IS NULL THEN
    INSERT INTO public.gr_number_kind_settings (gr_kind, start_no)
    VALUES (v_kind, 1)
    ON CONFLICT (gr_kind) DO NOTHING;

    SELECT start_no INTO v_start
    FROM public.gr_number_kind_settings
    WHERE gr_kind = v_kind;
  END IF;

  RETURN COALESCE(v_start, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.get_gr_start_number(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gr_start_number(text) TO authenticated;

-- ---------- Get semua nomor awal ----------
CREATE OR REPLACE FUNCTION public.get_gr_start_numbers()
RETURNS TABLE(gr_kind text, start_no integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.gr_number_kind_settings (gr_kind, start_no)
  VALUES ('credit', 1), ('cash', 1), ('import', 1)
  ON CONFLICT (gr_kind) DO NOTHING;

  RETURN QUERY
  SELECT s.gr_kind, s.start_no
  FROM public.gr_number_kind_settings s
  ORDER BY CASE s.gr_kind WHEN 'credit' THEN 1 WHEN 'cash' THEN 2 WHEN 'import' THEN 3 ELSE 9 END;
END;
$$;

REVOKE ALL ON FUNCTION public.get_gr_start_numbers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gr_start_numbers() TO authenticated;

-- ---------- Set nomor awal per jenis ----------
CREATE OR REPLACE FUNCTION public.set_gr_start_number(p_gr_kind text, p_start_no integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengatur nomor awal GR.';
  END IF;

  v_kind := lower(coalesce(p_gr_kind, ''));
  IF v_kind NOT IN ('credit','cash','import') THEN
    RAISE EXCEPTION 'Jenis GR tidak valid. Gunakan credit/cash/import.';
  END IF;

  IF p_start_no IS NULL OR p_start_no < 1 OR p_start_no > 99999 THEN
    RAISE EXCEPTION 'Nomor awal harus di antara 1 sampai 99999.';
  END IF;

  INSERT INTO public.gr_number_kind_settings (gr_kind, start_no, updated_at, updated_by)
  VALUES (v_kind, p_start_no, now(), auth.uid())
  ON CONFLICT (gr_kind) DO UPDATE
    SET start_no = EXCLUDED.start_no,
        updated_at = now(),
        updated_by = auth.uid();

  INSERT INTO public.activity_log (user_id, action, entity_type, details)
  VALUES (
    auth.uid(),
    'set_gr_start_number',
    'inventory_transaction',
    'Nomor awal GR ' || upper(v_kind) || ' diatur ke ' || p_start_no::text
  );

  RETURN p_start_no;
END;
$$;

REVOKE ALL ON FUNCTION public.set_gr_start_number(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_gr_start_number(text, integer) TO authenticated;

-- Wrapper lama: tetap ada untuk kompatibilitas (set semua jenis sekaligus)
CREATE OR REPLACE FUNCTION public.set_gr_start_number(p_start_no integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.set_gr_start_number('credit', p_start_no);
  PERFORM public.set_gr_start_number('cash', p_start_no);
  PERFORM public.set_gr_start_number('import', p_start_no);
  RETURN p_start_no;
END;
$$;

REVOKE ALL ON FUNCTION public.set_gr_start_number(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_gr_start_number(integer) TO authenticated;

-- ---------- Update generator nomor GR ----------
CREATE OR REPLACE FUNCTION public.next_gr_number(p_gr_kind text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_kind text;
  v_code text;
  v_year integer := EXTRACT(YEAR FROM current_date)::integer;
  v_no integer;
  v_start integer;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Hanya admin atau inventory yang dapat membuat nomor GR.';
  END IF;

  v_kind := lower(coalesce(p_gr_kind, ''));
  IF v_kind NOT IN ('credit','cash','import') THEN
    RAISE EXCEPTION 'Jenis GR tidak valid. Gunakan credit/cash/import.';
  END IF;

  v_start := public.get_gr_start_number(v_kind);

  INSERT INTO public.gr_number_counters (gr_year, gr_kind, last_no)
  VALUES (v_year, v_kind, v_start)
  ON CONFLICT (gr_year, gr_kind) DO UPDATE
    SET last_no = public.gr_number_counters.last_no + 1
  RETURNING last_no INTO v_no;

  v_code := CASE v_kind
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

-- ---------- Signature utama baru (11 parameter) ----------
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
  p_gr_no text DEFAULT NULL,
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
  v_gr_code text;
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

  IF p_type <> 'stock_in' AND (p_gr_kind IS NOT NULL OR p_gr_no IS NOT NULL) THEN
    RAISE EXCEPTION 'Data GR hanya berlaku untuk transaksi pemasukan (stock_in).';
  END IF;

  IF p_gr_no IS NOT NULL AND p_gr_kind IS NULL THEN
    RAISE EXCEPTION 'Jenis GR wajib diisi jika nomor GR sudah ditentukan.';
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

    v_gr_no := NULLIF(btrim(p_gr_no), '');
    IF p_gr_kind IS NOT NULL THEN
      v_gr_code := CASE p_gr_kind
        WHEN 'credit' THEN 'SKSB'
        WHEN 'cash' THEN 'STSB'
        WHEN 'import' THEN 'SKIS'
        ELSE NULL
      END;

      IF v_gr_no IS NULL THEN
        v_gr_no := public.next_gr_number(p_gr_kind);
      ELSE
        IF split_part(v_gr_no, '/', 2) <> v_gr_code THEN
          RAISE EXCEPTION 'Nomor GR (%) tidak sesuai jenis GR (%).', v_gr_no, p_gr_kind;
        END IF;
      END IF;
    END IF;
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
    CASE WHEN p_type = 'stock_in' THEN v_gr_no ELSE NULL END,
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

REVOKE ALL ON FUNCTION public.apply_inventory_transaction(uuid,text,numeric,text,text,uuid,text,text,text,text,text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_inventory_transaction(uuid,text,numeric,text,text,uuid,text,text,text,text,text[]) TO authenticated;

-- ---------- Wrapper 10 parameter (kompatibilitas) ----------
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
    p_gr_kind,
    NULL,
    p_gr_attachments
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_inventory_transaction(uuid,text,numeric,text,text,uuid,text,text,text,text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_inventory_transaction(uuid,text,numeric,text,text,uuid,text,text,text,text[]) TO authenticated;

-- ---------- Wrapper 8 parameter (kompatibilitas lama) ----------
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
    NULL,
    NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_inventory_transaction(uuid,text,numeric,text,text,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_inventory_transaction(uuid,text,numeric,text,text,uuid,text,text) TO authenticated;