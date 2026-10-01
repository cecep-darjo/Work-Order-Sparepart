/*
# Purchase Requirement Attachments

Kebutuhan:
1) PR mendukung lampiran foto/PDF (maks 5MB per file).
2) Lampiran dapat disimpan setelah PR dibuat.
3) Storage policy dibatasi untuk role terkait.

Aman dijalankan ulang.
*/

ALTER TABLE public.purchase_requirements
  ADD COLUMN IF NOT EXISTS attachment_files text[];

CREATE OR REPLACE FUNCTION public.set_purchase_requirement_attachments(
  p_pr_id uuid,
  p_attachments text[]
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
    RAISE EXCEPTION 'Hanya admin/SS yang dapat mengatur lampiran PR.';
  END IF;

  SELECT * INTO v_row
  FROM public.purchase_requirements
  WHERE id = p_pr_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase Requirement tidak ditemukan.';
  END IF;

  IF v_role = 'ss' AND v_row.created_by <> auth.uid() THEN
    RAISE EXCEPTION 'SS hanya dapat mengatur lampiran PR yang dibuat sendiri.';
  END IF;

  UPDATE public.purchase_requirements
  SET attachment_files = CASE
      WHEN p_attachments IS NULL OR coalesce(array_length(p_attachments, 1), 0) = 0 THEN NULL
      ELSE p_attachments
    END,
    updated_at = now()
  WHERE id = p_pr_id
  RETURNING * INTO v_row;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(),
    'set_purchase_requirement_attachments',
    'purchase_requirement',
    v_row.id,
    'Jumlah lampiran: ' || coalesce(array_length(v_row.attachment_files, 1), 0)::text
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.set_purchase_requirement_attachments(uuid,text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_purchase_requirement_attachments(uuid,text[]) TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'purchase-requirement-files',
  'purchase-requirement-files',
  true,
  5242880,
  ARRAY['image/jpeg','image/png','image/webp','application/pdf']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "purchase_requirement_files_read" ON storage.objects;
CREATE POLICY "purchase_requirement_files_read" ON storage.objects FOR SELECT
TO authenticated USING (bucket_id = 'purchase-requirement-files');

DROP POLICY IF EXISTS "purchase_requirement_files_insert" ON storage.objects;
CREATE POLICY "purchase_requirement_files_insert" ON storage.objects FOR INSERT
TO authenticated WITH CHECK (
  bucket_id = 'purchase-requirement-files'
  AND public.is_admin_or_ss()
);

DROP POLICY IF EXISTS "purchase_requirement_files_update" ON storage.objects;
CREATE POLICY "purchase_requirement_files_update" ON storage.objects FOR UPDATE
TO authenticated USING (
  bucket_id = 'purchase-requirement-files'
  AND public.is_admin_or_ss()
) WITH CHECK (
  bucket_id = 'purchase-requirement-files'
  AND public.is_admin_or_ss()
);

DROP POLICY IF EXISTS "purchase_requirement_files_delete" ON storage.objects;
CREATE POLICY "purchase_requirement_files_delete" ON storage.objects FOR DELETE
TO authenticated USING (
  bucket_id = 'purchase-requirement-files'
  AND public.is_admin_or_ss()
);
