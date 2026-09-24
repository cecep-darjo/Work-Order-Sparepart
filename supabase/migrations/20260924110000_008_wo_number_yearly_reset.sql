/*
# Nomor urut WO reset setiap tahun

Format tetap WOaa/bbbb/cc/ddddd. Bagian ddddd sekarang dimulai lagi dari 00001
setiap awal tahun (tahun dihitung menurut waktu WIB / Asia/Jakarta).
Satu urutan dipakai bersama oleh semua departemen dalam tahun yang sama.

- Tabel wo_number_counters menyimpan nomor terakhir per tahun.
- Increment dilakukan atomik (INSERT ... ON CONFLICT DO UPDATE), aman dari nomor
  ganda walau beberapa orang membuat WO bersamaan.
- Counter diisi awal dari WO berformat baru yang sudah ada, agar tidak bentrok.
*/

CREATE TABLE IF NOT EXISTS public.wo_number_counters (
  year integer PRIMARY KEY,
  last_no integer NOT NULL DEFAULT 0
);

ALTER TABLE public.wo_number_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wo_number_counters FROM PUBLIC, anon, authenticated;

-- Isi awal dari nomor WO berformat baru yang sudah ada (format lama WO-YYYY-nnnnn diabaikan).
INSERT INTO public.wo_number_counters (year, last_no)
SELECT 2000 + substr(wo_number, 3, 2)::int,
       max(split_part(wo_number, '/', 4)::int)
FROM public.work_orders
WHERE wo_number ~ '^WO[0-9]{2}/[A-Za-z0-9]+/[0-9]{2}/[0-9]+$'
GROUP BY 1
ON CONFLICT (year) DO UPDATE
SET last_no = GREATEST(public.wo_number_counters.last_no, EXCLUDED.last_no);

-- Inti pembuat nomor; menerima waktu agar bisa diuji. Tidak bisa dipanggil lewat API.
CREATE OR REPLACE FUNCTION public._wo_number_at(p_department_id uuid, p_at timestamp)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
  v_year integer := extract(year FROM p_at)::int;
  v_seq integer;
BEGIN
  SELECT upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g'))
  INTO v_code
  FROM public.departments
  WHERE id = p_department_id;

  IF v_code IS NULL OR v_code = '' THEN
    RAISE EXCEPTION 'Departemen tidak valid atau kode departemen kosong.';
  END IF;

  INSERT INTO public.wo_number_counters (year, last_no)
  VALUES (v_year, 1)
  ON CONFLICT (year) DO UPDATE SET last_no = public.wo_number_counters.last_no + 1
  RETURNING last_no INTO v_seq;

  RETURN 'WO' || to_char(p_at, 'YY')
    || '/' || v_code
    || '/' || to_char(p_at, 'MM')
    || '/' || CASE WHEN v_seq > 99999 THEN v_seq::text ELSE lpad(v_seq::text, 5, '0') END;
END;
$$;

CREATE OR REPLACE FUNCTION public.next_wo_number(p_department_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public._wo_number_at(p_department_id, (now() AT TIME ZONE 'Asia/Jakarta'));
END;
$$;

REVOKE ALL ON FUNCTION public._wo_number_at(uuid, timestamp) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.next_wo_number(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_wo_number(uuid) TO authenticated;
