/*
# WO Photo Attachments (Teknisi / SPV)

Kebutuhan:
1) Teknisi/SPV dapat upload lampiran foto WO.
2) Maksimal ukuran file 500KB per foto.
3) Format yang diizinkan: JPG, PNG, WEBP.
4) URL foto disimpan pada `work_orders.attachments` (kolom sudah ada).

Catatan:
- Bucket dibuat public agar foto bisa ditarik langsung ke PDF report di frontend.
- Hak upload/update/delete dibatasi ke role terkait.

Aman dijalankan ulang.
*/

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'wo-photo-files',
  'wo-photo-files',
  true,
  512000,
  ARRAY['image/jpeg','image/png','image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "wo_photo_files_read" ON storage.objects;
CREATE POLICY "wo_photo_files_read" ON storage.objects FOR SELECT
TO authenticated USING (bucket_id = 'wo-photo-files');

DROP POLICY IF EXISTS "wo_photo_files_insert" ON storage.objects;
CREATE POLICY "wo_photo_files_insert" ON storage.objects FOR INSERT
TO authenticated WITH CHECK (
  bucket_id = 'wo-photo-files'
  AND EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active = true
      AND p.role IN ('admin','ss','spv','teknisi')
  )
);

DROP POLICY IF EXISTS "wo_photo_files_update" ON storage.objects;
CREATE POLICY "wo_photo_files_update" ON storage.objects FOR UPDATE
TO authenticated USING (
  bucket_id = 'wo-photo-files'
  AND EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active = true
      AND p.role IN ('admin','ss','spv','teknisi')
  )
) WITH CHECK (
  bucket_id = 'wo-photo-files'
  AND EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active = true
      AND p.role IN ('admin','ss','spv','teknisi')
  )
);

DROP POLICY IF EXISTS "wo_photo_files_delete" ON storage.objects;
CREATE POLICY "wo_photo_files_delete" ON storage.objects FOR DELETE
TO authenticated USING (
  bucket_id = 'wo-photo-files'
  AND EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active = true
      AND p.role IN ('admin','ss','spv','teknisi')
  )
);
