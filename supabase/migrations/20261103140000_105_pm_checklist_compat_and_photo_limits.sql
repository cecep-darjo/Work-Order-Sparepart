-- Accept both legacy checkbox entries and current explicit OK / Not OK results,
-- while preserving the required note for a Not OK item.
CREATE OR REPLACE FUNCTION public.pm_guard_checklist_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done'
     AND EXISTS (
       SELECT 1
       FROM jsonb_array_elements(COALESCE(NEW.checklist_items, '[]'::jsonb)) AS entries(item)
       WHERE (item->>'result' = 'not_ok' AND length(btrim(COALESCE(item->>'note', ''))) = 0)
          OR (
            COALESCE(item->>'result', '') NOT IN ('ok','not_ok')
            AND COALESCE(item->>'checked', 'false') <> 'true'
          )
     ) THEN
    RAISE EXCEPTION 'Simpan hasil OK atau Not OK untuk semua item checklist; keterangan wajib untuk Not OK.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pm_guard_checklist_completion ON public.pm_assignments;
CREATE TRIGGER pm_guard_checklist_completion
BEFORE UPDATE OF status ON public.pm_assignments
FOR EACH ROW EXECUTE FUNCTION public.pm_guard_checklist_completion();

INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES ('pm-evidence', 'pm-evidence', false, 204800, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 204800,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

NOTIFY pgrst, 'reload schema';
