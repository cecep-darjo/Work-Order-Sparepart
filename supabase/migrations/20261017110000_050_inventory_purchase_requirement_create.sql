-- Izinkan user Inventory membuat Purchase Requirement melalui RPC yang sama
-- dengan admin dan SS. Otorisasi tetap diperiksa di database.

CREATE OR REPLACE FUNCTION public.create_purchase_requirement_items(
  p_items jsonb,
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
  v_count integer;
BEGIN
  SELECT role INTO v_role
   FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;

  IF v_role IS NULL OR v_role NOT IN ('admin', 'ss', 'inventory') THEN
    RAISE EXCEPTION 'Hanya admin, SS, atau Inventory yang dapat membuat Purchase Requirement.';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Daftar spare part tidak boleh kosong.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric, uom text)
     WHERE i.quantity IS NULL OR i.quantity <= 0
  ) THEN
    RAISE EXCEPTION 'Setiap item harus memiliki quantity lebih besar dari 0.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric, uom text)
     WHERE i.spare_part_id IS NULL
       AND (i.service_key IS NULL OR i.description IS NULL OR btrim(i.description) = '')
  ) THEN
    RAISE EXCEPTION 'Item jasa harus memiliki uraian yang jelas.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric, uom text)
     WHERE i.spare_part_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.spare_parts s WHERE s.id = i.spare_part_id)
  ) THEN
    RAISE EXCEPTION 'Ada spare part yang tidak ditemukan di master.';
  END IF;

  IF p_requester_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = p_requester_id
  ) THEN
    RAISE EXCEPTION 'Pemesan tidak valid.';
  END IF;

  IF p_supplier_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.inventory_suppliers s WHERE s.id = p_supplier_id
  ) THEN
    RAISE EXCEPTION 'Supplier tidak valid.';
  END IF;

  INSERT INTO public.purchase_requirements (requester_id, machine_name, supplier_id, created_by)
  VALUES (p_requester_id, NULLIF(btrim(p_machine_name), ''), p_supplier_id, auth.uid())
  RETURNING * INTO v_row;

  -- Barang dengan spare_part_id yang sama digabung.
  INSERT INTO public.purchase_requirement_items (pr_id, spare_part_id, spare_part_name, quantity)
  SELECT v_row.id, s.id, s.name, x.quantity
    FROM (
      SELECT i.spare_part_id, SUM(i.quantity) AS quantity
        FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, quantity numeric)
       WHERE i.spare_part_id IS NOT NULL
       GROUP BY i.spare_part_id
    ) x
    JOIN public.spare_parts s ON s.id = x.spare_part_id;

  -- Item jasa disimpan tanpa spare part master dan tidak memengaruhi stok.
  INSERT INTO public.purchase_requirement_items (
    pr_id, spare_part_id, spare_part_name, quantity, is_service, service_key, uom
  )
  SELECT v_row.id, NULL, btrim(i.description), i.quantity, true, i.service_key, NULLIF(btrim(i.uom), '')
    FROM jsonb_to_recordset(p_items) AS i(spare_part_id uuid, service_key uuid, description text, quantity numeric, uom text)
   WHERE i.spare_part_id IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'create_purchase_requirement', 'purchase_requirement', v_row.id, 'PR baru: ' || v_count::text || ' item');

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_purchase_requirement_items(jsonb, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_purchase_requirement_items(jsonb, uuid, text, uuid) TO authenticated;

-- User Inventory dapat mengunggah lampiran saat membuat PR.
DROP POLICY IF EXISTS "purchase_requirement_files_insert" ON storage.objects;
CREATE POLICY "purchase_requirement_files_insert" ON storage.objects FOR INSERT
TO authenticated WITH CHECK (
  bucket_id = 'purchase-requirement-files'
  AND (
    public.is_admin_or_ss()
    OR EXISTS (
      SELECT 1
        FROM public.profiles p
       WHERE p.id = auth.uid()
         AND p.role = 'inventory'
         AND p.is_active = true
    )
  )
);
