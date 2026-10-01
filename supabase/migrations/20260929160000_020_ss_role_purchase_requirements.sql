/*
# Senior Supervisor (SS) + Purchase Requirement (PR)

Perubahan utama:
1) Tambah role baru `ss` (Senior Supervisor).
2) SS mendapat akses admin untuk modul Work Order + Master WO + Master Inventory.
3) Tambah master supplier inventory (`inventory_suppliers`).
4) Tambah fitur Purchase Requirement:
   - SS membuat PR (spare part, qty, pemesan, mesin opsional, supplier).
   - PIC inventory/admin mengisi no SAP + no PR (manual, tervalidasi format).

Catatan format:
- SAP: `16xxxxxxxx` (10 digit, diawali 16, 8 digit manual).
- PR : `TK/aa/bb/ccccc` (aa tahun 2 digit, bb bulan 2 digit, ccccc digit manual).
*/

-- =========================================================
-- 1) Role baru: ss
-- =========================================================
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin','ss','spv','teknisi','inventory'));

CREATE OR REPLACE FUNCTION public.is_admin_or_ss()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role IN ('admin','ss')
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin_or_ss() TO authenticated;

-- Sinkronkan validasi role di fungsi create user admin.
CREATE OR REPLACE FUNCTION public._create_app_user(
  p_username text,
  p_password text,
  p_full_name text DEFAULT '',
  p_role text DEFAULT 'teknisi',
  p_department_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, auth
AS $$
DECLARE
  v_username text := lower(btrim(p_username));
  v_email text;
  v_id uuid := gen_random_uuid();
BEGIN
  IF v_username !~ '^[a-z0-9][a-z0-9._-]{1,28}[a-z0-9]$' THEN
    RAISE EXCEPTION 'Username 3-30 karakter: huruf kecil, angka, titik, garis bawah atau strip.';
  END IF;
  IF p_password IS NULL OR length(p_password) < 6 OR p_password !~ '[A-Za-z]' OR p_password !~ '[0-9]' THEN
    RAISE EXCEPTION 'Password minimal 6 karakter dan harus berisi huruf dan angka.';
  END IF;
  IF p_role NOT IN ('admin', 'ss', 'spv', 'teknisi', 'inventory') THEN
    RAISE EXCEPTION 'Role tidak valid.';
  END IF;

  v_email := v_username || '@wo-sparepart.app';

  IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION 'Username sudah dipakai.';
  END IF;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    v_email, crypt(p_password, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', COALESCE(p_full_name, '')),
    now(), now(),
    '', '', '', ''
  );

  INSERT INTO auth.identities (
    id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_id, v_email,
    jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
    'email', now(), now(), now()
  );

  UPDATE public.profiles
  SET full_name = COALESCE(p_full_name, ''), role = p_role, department_id = p_department_id
  WHERE id = v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_user(
  p_username text,
  p_password text,
  p_full_name text DEFAULT '',
  p_role text DEFAULT 'teknisi',
  p_department_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Hanya admin yang dapat membuat user.';
  END IF;
  RETURN public._create_app_user(p_username, p_password, p_full_name, p_role, p_department_id);
END;
$$;

-- =========================================================
-- 2) Akses SS untuk Master WO (departments/areas/equipment)
-- =========================================================
DROP POLICY IF EXISTS "admin_insert_departments" ON public.departments;
CREATE POLICY "admin_insert_departments" ON public.departments FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
  );

DROP POLICY IF EXISTS "admin_update_departments" ON public.departments;
CREATE POLICY "admin_update_departments" ON public.departments FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
  );

DROP POLICY IF EXISTS "admin_delete_departments" ON public.departments;
CREATE POLICY "admin_delete_departments" ON public.departments FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
  );

DROP POLICY IF EXISTS "admin_insert_areas" ON public.areas;
CREATE POLICY "admin_insert_areas" ON public.areas FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
  );

DROP POLICY IF EXISTS "admin_update_areas" ON public.areas;
CREATE POLICY "admin_update_areas" ON public.areas FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
  );

DROP POLICY IF EXISTS "admin_delete_areas" ON public.areas;
CREATE POLICY "admin_delete_areas" ON public.areas FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
  );

DROP POLICY IF EXISTS "admin_insert_equipment" ON public.equipment;
CREATE POLICY "admin_insert_equipment" ON public.equipment FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
  );

DROP POLICY IF EXISTS "admin_update_equipment" ON public.equipment;
CREATE POLICY "admin_update_equipment" ON public.equipment FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
  );

DROP POLICY IF EXISTS "admin_delete_equipment" ON public.equipment;
CREATE POLICY "admin_delete_equipment" ON public.equipment FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
  );

-- =========================================================
-- 3) Akses SS untuk Work Order (setara admin di modul WO)
-- =========================================================
DROP POLICY IF EXISTS "read_work_orders" ON public.work_orders;
CREATE POLICY "read_work_orders" ON public.work_orders FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss','inventory'))
    OR work_orders.spv_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'spv' AND p.department_id = work_orders.department_id)
    OR public.is_wo_technician(work_orders.id)
  );

DROP POLICY IF EXISTS "insert_work_orders" ON public.work_orders;
CREATE POLICY "insert_work_orders" ON public.work_orders FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
  );

DROP POLICY IF EXISTS "update_work_orders" ON public.work_orders;
CREATE POLICY "update_work_orders" ON public.work_orders FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
    OR work_orders.spv_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'spv' AND p.department_id = work_orders.department_id)
    OR public.is_wo_technician(work_orders.id)
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
    OR work_orders.spv_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'spv' AND p.department_id = work_orders.department_id)
    OR public.is_wo_technician(work_orders.id)
  );

DROP POLICY IF EXISTS "delete_work_orders" ON public.work_orders;
CREATE POLICY "delete_work_orders" ON public.work_orders FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss'))
  );

DROP POLICY IF EXISTS "insert_wo_technicians" ON public.work_order_technicians;
CREATE POLICY "insert_wo_technicians" ON public.work_order_technicians FOR INSERT
  TO authenticated WITH CHECK (
    public.is_admin_or_ss()
    OR EXISTS (SELECT 1 FROM public.work_orders w WHERE w.id = work_order_technicians.work_order_id AND w.spv_id = auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      JOIN public.work_orders w ON w.id = work_order_technicians.work_order_id
      WHERE p.id = auth.uid() AND p.role = 'spv' AND p.department_id = w.department_id
    )
  );

DROP POLICY IF EXISTS "delete_wo_technicians" ON public.work_order_technicians;
CREATE POLICY "delete_wo_technicians" ON public.work_order_technicians FOR DELETE
  TO authenticated USING (
    public.is_admin_or_ss()
    OR EXISTS (SELECT 1 FROM public.work_orders w WHERE w.id = work_order_technicians.work_order_id AND w.spv_id = auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      JOIN public.work_orders w ON w.id = work_order_technicians.work_order_id
      WHERE p.id = auth.uid() AND p.role = 'spv' AND p.department_id = w.department_id
    )
  );

CREATE OR REPLACE FUNCTION public.admin_delete_work_order(p_wo_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo public.work_orders%ROWTYPE;
  r record;
  v_balance numeric;
  v_before numeric;
  v_tx_no text;
BEGIN
  IF NOT public.is_admin_or_ss() THEN RAISE EXCEPTION 'Hanya admin/SS yang dapat menghapus WO.'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'Alasan penghapusan wajib diisi.'; END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_wo_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work order tidak ditemukan.'; END IF;

  FOR r IN SELECT spare_part_id, sum(quantity) AS qty FROM public.work_order_parts WHERE work_order_id = p_wo_id GROUP BY spare_part_id LOOP
    SELECT current_stock INTO v_before FROM public.spare_parts WHERE id = r.spare_part_id FOR UPDATE;
    v_tx_no := public.next_inventory_transaction_no('stock_in');
    PERFORM set_config('app.inventory_tx', '1', true);
    UPDATE public.spare_parts SET current_stock = current_stock + r.qty, updated_at = now() WHERE id = r.spare_part_id RETURNING current_stock INTO v_balance;
    INSERT INTO public.inventory_transactions
      (spare_part_id, type, quantity, balance_after, reference, notes, work_order_id, created_by, transaction_no, stock_before, source)
    VALUES
      (r.spare_part_id, 'stock_in', r.qty, v_balance, v_wo.wo_number,
       'Returned from ' || v_wo.wo_number || ' (WO deleted)', p_wo_id, auth.uid(), v_tx_no, v_before, 'WO deleted');
  END LOOP;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
  VALUES (auth.uid(), 'delete_wo', 'work_order', p_wo_id, 'Deleted ' || v_wo.wo_number, btrim(p_reason));

  DELETE FROM public.work_orders WHERE id = p_wo_id;
END;
$$;

-- =========================================================
-- 4) Akses SS untuk Master Inventory
-- =========================================================
DROP POLICY IF EXISTS "manage_spare_parts_insert" ON public.spare_parts;
CREATE POLICY "manage_spare_parts_insert" ON public.spare_parts FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss','inventory'))
  );

DROP POLICY IF EXISTS "manage_spare_parts_update" ON public.spare_parts;
CREATE POLICY "manage_spare_parts_update" ON public.spare_parts FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss','inventory'))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss','inventory'))
  );

DROP POLICY IF EXISTS "manage_spare_parts_delete" ON public.spare_parts;
CREATE POLICY "manage_spare_parts_delete" ON public.spare_parts FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss','inventory'))
  );

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['part_categories','units_of_measure','part_locations']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "manage_%1$s_insert" ON public.%1$s', t);
    EXECUTE format($f$CREATE POLICY "manage_%1$s_insert" ON public.%1$s FOR INSERT
      TO authenticated WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss','inventory'))
      )$f$, t);

    EXECUTE format('DROP POLICY IF EXISTS "manage_%1$s_update" ON public.%1$s', t);
    EXECUTE format($f$CREATE POLICY "manage_%1$s_update" ON public.%1$s FOR UPDATE
      TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss','inventory'))
      ) WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss','inventory'))
      )$f$, t);

    EXECUTE format('DROP POLICY IF EXISTS "manage_%1$s_delete" ON public.%1$s', t);
    EXECUTE format($f$CREATE POLICY "manage_%1$s_delete" ON public.%1$s FOR DELETE
      TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss','inventory'))
      )$f$, t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.next_part_code(p_category_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket text;
  v_seq integer;
  v_code text;
BEGIN
  IF NOT (public.is_admin_or_ss() OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'inventory'
  )) THEN
    RAISE EXCEPTION 'Hanya admin/SS atau inventory yang dapat membuat kode part.';
  END IF;

  IF p_category_id IS NOT NULL THEN
    SELECT upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g')) INTO v_bucket
    FROM public.part_categories WHERE id = p_category_id;
  END IF;
  IF v_bucket IS NULL OR v_bucket = '' THEN
    v_bucket := 'SP';
  END IF;

  LOOP
    INSERT INTO public.part_code_counters (bucket, last_no)
    VALUES (v_bucket, 1)
    ON CONFLICT (bucket) DO UPDATE SET last_no = public.part_code_counters.last_no + 1
    RETURNING last_no INTO v_seq;

    v_code := v_bucket || '-' || lpad(v_seq::text, 5, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.spare_parts WHERE code = v_code);
  END LOOP;

  RETURN v_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_gr_start_number(p_gr_kind text, p_start_no integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind text;
BEGIN
  IF NOT public.is_admin_or_ss() THEN
    RAISE EXCEPTION 'Hanya admin/SS yang dapat mengatur nomor awal GR.';
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

-- =========================================================
-- 5) Master supplier inventory
-- =========================================================
CREATE TABLE IF NOT EXISTS public.inventory_suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.inventory_suppliers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_inventory_suppliers" ON public.inventory_suppliers;
CREATE POLICY "read_inventory_suppliers" ON public.inventory_suppliers FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "manage_inventory_suppliers_insert" ON public.inventory_suppliers;
CREATE POLICY "manage_inventory_suppliers_insert" ON public.inventory_suppliers FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss','inventory'))
  );

DROP POLICY IF EXISTS "manage_inventory_suppliers_update" ON public.inventory_suppliers;
CREATE POLICY "manage_inventory_suppliers_update" ON public.inventory_suppliers FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss','inventory'))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss','inventory'))
  );

DROP POLICY IF EXISTS "manage_inventory_suppliers_delete" ON public.inventory_suppliers;
CREATE POLICY "manage_inventory_suppliers_delete" ON public.inventory_suppliers FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','ss','inventory'))
  );

-- =========================================================
-- 6) Purchase Requirement
-- =========================================================
CREATE TABLE IF NOT EXISTS public.purchase_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spare_part_name text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  requester_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  machine_name text,
  supplier_id uuid NOT NULL REFERENCES public.inventory_suppliers(id) ON DELETE RESTRICT,
  sap_no text UNIQUE,
  pr_no text UNIQUE,
  status text NOT NULL DEFAULT 'pending_numbering'
    CHECK (status IN ('pending_numbering', 'numbered')),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  numbered_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  numbered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_requirements_status_created
  ON public.purchase_requirements(status, created_at DESC);

ALTER TABLE public.purchase_requirements ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.purchase_requirements FROM anon, authenticated;

DROP POLICY IF EXISTS "read_purchase_requirements" ON public.purchase_requirements;
CREATE POLICY "read_purchase_requirements" ON public.purchase_requirements FOR SELECT
  TO authenticated USING (
    public.is_admin_or_ss()
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'inventory')
    OR created_by = auth.uid()
    OR requester_id = auth.uid()
  );

CREATE OR REPLACE FUNCTION public.create_purchase_requirement(
  p_spare_part_name text,
  p_quantity numeric,
  p_requester_id uuid,
  p_machine_name text DEFAULT NULL,
  p_supplier_id uuid DEFAULT NULL
)
RETURNS public.purchase_requirements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_row public.purchase_requirements%ROWTYPE;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','ss') THEN
    RAISE EXCEPTION 'Hanya admin/SS yang dapat membuat Purchase Requirement.';
  END IF;

  IF p_spare_part_name IS NULL OR btrim(p_spare_part_name) = '' THEN
    RAISE EXCEPTION 'Nama spare part wajib diisi.';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Jumlah harus lebih besar dari 0.';
  END IF;
  IF p_requester_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = p_requester_id
  ) THEN
    RAISE EXCEPTION 'Pemesan tidak valid.';
  END IF;
  IF p_supplier_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.inventory_suppliers s WHERE s.id = p_supplier_id
  ) THEN
    RAISE EXCEPTION 'Supplier tidak valid.';
  END IF;

  INSERT INTO public.purchase_requirements (
    spare_part_name,
    quantity,
    requester_id,
    machine_name,
    supplier_id,
    created_by
  ) VALUES (
    btrim(p_spare_part_name),
    p_quantity,
    p_requester_id,
    NULLIF(btrim(p_machine_name), ''),
    p_supplier_id,
    auth.uid()
  )
  RETURNING * INTO v_row;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    'create_purchase_requirement',
    'purchase_requirement',
    v_row.id,
    'PR baru: ' || v_row.spare_part_name || ' qty ' || v_row.quantity::text
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_purchase_requirement(text,numeric,uuid,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_purchase_requirement(text,numeric,uuid,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_purchase_requirement_numbers(
  p_pr_id uuid,
  p_sap_no text,
  p_pr_no text
)
RETURNS public.purchase_requirements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_row public.purchase_requirements%ROWTYPE;
  v_sap text := NULLIF(btrim(p_sap_no), '');
  v_pr text := NULLIF(btrim(p_pr_no), '');
  v_now timestamp := (now() AT TIME ZONE 'Asia/Jakarta');
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin','inventory') THEN
    RAISE EXCEPTION 'Hanya admin/inventory yang dapat mengisi nomor SAP dan nomor PR.';
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

  IF split_part(v_pr, '/', 2) <> to_char(v_now, 'YY')
     OR split_part(v_pr, '/', 3) <> to_char(v_now, 'MM') THEN
    RAISE EXCEPTION 'Bagian aa/bb pada nomor PR harus sesuai tahun/bulan saat ini (%/%).', to_char(v_now, 'YY'), to_char(v_now, 'MM');
  END IF;

  SELECT * INTO v_row
  FROM public.purchase_requirements
  WHERE id = p_pr_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase Requirement tidak ditemukan.';
  END IF;

  IF v_row.status <> 'pending_numbering' THEN
    RAISE EXCEPTION 'PR sudah diproses (status: %).', v_row.status;
  END IF;

  UPDATE public.purchase_requirements
  SET sap_no = v_sap,
      pr_no = v_pr,
      status = 'numbered',
      numbered_by = auth.uid(),
      numbered_at = now(),
      updated_at = now()
  WHERE id = p_pr_id
  RETURNING * INTO v_row;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    'number_purchase_requirement',
    'purchase_requirement',
    v_row.id,
    'SAP ' || v_sap || ' | PR ' || v_pr
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.set_purchase_requirement_numbers(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_purchase_requirement_numbers(uuid,text,text) TO authenticated;
