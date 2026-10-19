-- Let SPV create WOs only for assigned departments and keep the WO PIC as that SPV.
DROP POLICY IF EXISTS "insert_work_orders" ON public.work_orders;
CREATE POLICY "insert_work_orders" ON public.work_orders FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR (
      EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'ss')
      AND public.profile_has_department(auth.uid(), department_id)
    )
    OR (
      EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'spv')
      AND public.profile_has_department(auth.uid(), department_id)
      AND spv_id = auth.uid()
    )
  );

-- Reserve a system-formatted WO number while allowing an authorized user to choose
-- only its trailing numeric sequence. The shared counter advances to at least this value.
CREATE OR REPLACE FUNCTION public.reserve_manual_wo_number(p_department_id uuid, p_suffix integer)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_code text;
  v_at timestamp := now() AT TIME ZONE 'Asia/Jakarta';
  v_year integer;
  v_number text;
BEGIN
  SELECT role INTO v_role
  FROM public.profiles
  WHERE id = auth.uid() AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'ss', 'spv') THEN
    RAISE EXCEPTION 'Hanya Admin, SS, atau SPV aktif yang dapat membuat Work Order.';
  END IF;
  IF v_role <> 'admin' AND NOT public.profile_has_department(auth.uid(), p_department_id) THEN
    RAISE EXCEPTION 'Anda hanya dapat membuat WO untuk departemen yang ditugaskan.';
  END IF;
  IF p_suffix IS NULL OR p_suffix < 1 THEN
    RAISE EXCEPTION 'Nomor urut WO harus lebih besar dari 0.';
  END IF;

  SELECT upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'))
  INTO v_code
  FROM public.departments
  WHERE id = p_department_id;
  IF v_code IS NULL OR v_code = '' THEN
    RAISE EXCEPTION 'Departemen tidak valid atau kode departemen kosong.';
  END IF;

  v_year := extract(year FROM v_at)::integer;
  v_number := 'WO' || to_char(v_at, 'YY') || '/' || v_code || '/' || to_char(v_at, 'MM') || '/'
    || CASE WHEN p_suffix > 99999 THEN p_suffix::text ELSE lpad(p_suffix::text, 5, '0') END;

  INSERT INTO public.wo_number_counters (year, last_no)
  VALUES (v_year, p_suffix)
  ON CONFLICT (year) DO UPDATE
    SET last_no = GREATEST(public.wo_number_counters.last_no, EXCLUDED.last_no);

  IF EXISTS (SELECT 1 FROM public.work_orders WHERE wo_number = v_number) THEN
    RAISE EXCEPTION 'Nomor WO % sudah digunakan. Pilih nomor urut lain.', v_number USING ERRCODE = '23505';
  END IF;
  RETURN v_number;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_manual_wo_number(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_manual_wo_number(uuid, integer) TO authenticated;
