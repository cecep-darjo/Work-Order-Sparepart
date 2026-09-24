/*
# Format nomor WO: WOaa/bbbb/cc/ddddd

- aa    : tahun 2 digit          (mis. 26)
- bbbb  : kode departemen        (mis. MTC, huruf besar, tanpa simbol)
- cc    : bulan 2 digit          (mis. 09)
- ddddd : nomor urut WO 5 digit  (mis. 00001)

Contoh: WO26/MTC/09/00001

Tanggal dihitung dengan zona waktu Asia/Jakarta (WIB), bukan UTC.
Nomor urut memakai sequence wo_number_seq yang sudah ada: berjalan terus dan aman
dari nomor ganda walau beberapa orang membuat WO bersamaan.
*/

CREATE OR REPLACE FUNCTION public.next_wo_number(p_department_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
  v_now timestamp := (now() AT TIME ZONE 'Asia/Jakarta');
  v_seq bigint;
BEGIN
  SELECT upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'))
  INTO v_code
  FROM public.departments
  WHERE id = p_department_id;

  IF v_code IS NULL OR v_code = '' THEN
    RAISE EXCEPTION 'Departemen tidak valid atau kode departemen kosong.';
  END IF;

  v_seq := nextval('public.wo_number_seq');

  RETURN 'WO' || to_char(v_now, 'YY')
    || '/' || v_code
    || '/' || to_char(v_now, 'MM')
    || '/' || CASE WHEN v_seq > 99999 THEN v_seq::text ELSE lpad(v_seq::text, 5, '0') END;
END;
$$;

REVOKE ALL ON FUNCTION public.next_wo_number(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_wo_number(uuid) TO authenticated;
