-- Synchronize the linked JA's assigned team and supervisor to the Work Order.
CREATE OR REPLACE FUNCTION public.wo_sync_job_assignment_people(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_primary_technician uuid;
  v_creator uuid;
  v_creator_role text;
BEGIN
  SELECT j.technician_id, j.created_by, p.role
  INTO v_primary_technician, v_creator, v_creator_role
  FROM public.job_assignments j
  LEFT JOIN public.profiles p ON p.id = j.created_by
  WHERE j.id = p_job_id;
  IF NOT FOUND THEN RETURN; END IF;

  DELETE FROM public.work_order_technicians wt
  USING public.work_orders wo
  WHERE wo.job_assignment_id = p_job_id
    AND wt.work_order_id = wo.id
    AND NOT EXISTS (
      SELECT 1 FROM public.job_assignment_technicians jat
      WHERE jat.job_id = p_job_id AND jat.technician_id = wt.technician_id
    );

  INSERT INTO public.work_order_technicians (work_order_id, technician_id)
  SELECT wo.id, jat.technician_id
  FROM public.work_orders wo
  JOIN public.job_assignment_technicians jat ON jat.job_id = p_job_id
  WHERE wo.job_assignment_id = p_job_id
    AND NOT EXISTS (
      SELECT 1 FROM public.work_order_technicians wt
      WHERE wt.work_order_id = wo.id AND wt.technician_id = jat.technician_id
    );

  UPDATE public.work_orders wo
  SET technician_id = COALESCE(
        v_primary_technician,
        (SELECT jat.technician_id
         FROM public.job_assignment_technicians jat
         WHERE jat.job_id = p_job_id
         ORDER BY jat.assigned_at, jat.technician_id
         LIMIT 1)
      ),
      spv_id = CASE WHEN v_creator_role = 'spv' THEN v_creator ELSE wo.spv_id END,
      updated_at = now()
  WHERE wo.job_assignment_id = p_job_id;
END;
$$;
REVOKE ALL ON FUNCTION public.wo_sync_job_assignment_people(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.wo_sync_job_assignment_people_from_wo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.job_assignment_id IS NOT NULL THEN
    PERFORM public.wo_sync_job_assignment_people(NEW.job_assignment_id);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.wo_sync_job_assignment_people_from_wo() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.wo_sync_job_assignment_people_from_ja()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.wo_sync_job_assignment_people(NEW.id);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.wo_sync_job_assignment_people_from_ja() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.wo_sync_job_assignment_people_from_team()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.wo_sync_job_assignment_people(CASE WHEN TG_OP = 'DELETE' THEN OLD.job_id ELSE NEW.job_id END);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.wo_sync_job_assignment_people_from_team() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS wo_sync_people_after_wo_insert ON public.work_orders;
CREATE TRIGGER wo_sync_people_after_wo_insert
  AFTER INSERT ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.wo_sync_job_assignment_people_from_wo();

DROP TRIGGER IF EXISTS wo_sync_people_after_wo_link ON public.work_orders;
CREATE TRIGGER wo_sync_people_after_wo_link
  AFTER UPDATE OF job_assignment_id ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.wo_sync_job_assignment_people_from_wo();

DROP TRIGGER IF EXISTS wo_sync_people_after_ja_update ON public.job_assignments;
CREATE TRIGGER wo_sync_people_after_ja_update
  AFTER UPDATE OF technician_id, created_by ON public.job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.wo_sync_job_assignment_people_from_ja();

DROP TRIGGER IF EXISTS wo_sync_people_after_ja_team_change ON public.job_assignment_technicians;
CREATE TRIGGER wo_sync_people_after_ja_team_change
  AFTER INSERT OR DELETE ON public.job_assignment_technicians
  FOR EACH ROW EXECUTE FUNCTION public.wo_sync_job_assignment_people_from_team();

-- Reuse the JA photo URLs in WO attachments so the WO page and completion PDF show the evidence.
CREATE OR REPLACE FUNCTION public.wo_import_job_assignment_photos(p_work_order_id uuid, p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.work_orders wo
  SET attachments = ARRAY(
        SELECT DISTINCT photos.photo_url
        FROM unnest(
          COALESCE(wo.attachments, ARRAY[]::text[]) ||
          COALESCE((SELECT array_agg(jp.url) FROM public.job_assignment_photos jp WHERE jp.job_id = p_job_id), ARRAY[]::text[])
        ) AS photos(photo_url)
        WHERE photos.photo_url IS NOT NULL
      ),
      updated_at = now()
  WHERE wo.id = p_work_order_id AND wo.job_assignment_id = p_job_id;
END;
$$;
REVOKE ALL ON FUNCTION public.wo_import_job_assignment_photos(uuid,uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.wo_sync_job_assignment_photos_from_wo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.job_assignment_id IS DISTINCT FROM NEW.job_assignment_id
     AND OLD.job_assignment_id IS NOT NULL THEN
    UPDATE public.work_orders wo
    SET attachments = COALESCE((
          SELECT array_agg(current_url)
          FROM unnest(COALESCE(wo.attachments, ARRAY[]::text[])) AS files(current_url)
          WHERE NOT EXISTS (
            SELECT 1 FROM public.job_assignment_photos jp
            WHERE jp.job_id = OLD.job_assignment_id AND jp.url = files.current_url
          )
        ), ARRAY[]::text[])
    WHERE wo.id = NEW.id;
  END IF;
  IF NEW.job_assignment_id IS NOT NULL THEN
    PERFORM public.wo_import_job_assignment_photos(NEW.id, NEW.job_assignment_id);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.wo_sync_job_assignment_photos_from_wo() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.wo_sync_job_assignment_photo_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id uuid;
  v_url text;
  v_work_order_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_job_id := OLD.job_id;
    v_url := OLD.url;
    UPDATE public.work_orders wo
    SET attachments = array_remove(COALESCE(wo.attachments, ARRAY[]::text[]), v_url), updated_at = now()
    WHERE wo.job_assignment_id = v_job_id;
  ELSE
    v_job_id := NEW.job_id;
    FOR v_work_order_id IN
      SELECT id FROM public.work_orders WHERE job_assignment_id = v_job_id
    LOOP
      PERFORM public.wo_import_job_assignment_photos(v_work_order_id, v_job_id);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.wo_sync_job_assignment_photo_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS wo_sync_photos_after_wo_insert ON public.work_orders;
CREATE TRIGGER wo_sync_photos_after_wo_insert
  AFTER INSERT ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.wo_sync_job_assignment_photos_from_wo();

DROP TRIGGER IF EXISTS wo_sync_photos_after_wo_link ON public.work_orders;
CREATE TRIGGER wo_sync_photos_after_wo_link
  AFTER UPDATE OF job_assignment_id ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.wo_sync_job_assignment_photos_from_wo();

DROP TRIGGER IF EXISTS wo_sync_photos_after_ja_photo_change ON public.job_assignment_photos;
CREATE TRIGGER wo_sync_photos_after_ja_photo_change
  AFTER INSERT OR DELETE ON public.job_assignment_photos
  FOR EACH ROW EXECUTE FUNCTION public.wo_sync_job_assignment_photo_change();

-- Backfill previously linked assignments.
DO $$
DECLARE
  v_job_id uuid;
  v_work_order_id uuid;
BEGIN
  FOR v_job_id, v_work_order_id IN
    SELECT job_assignment_id, id FROM public.work_orders WHERE job_assignment_id IS NOT NULL
  LOOP
    PERFORM public.wo_sync_job_assignment_people(v_job_id);
    PERFORM public.wo_import_job_assignment_photos(v_work_order_id, v_job_id);
  END LOOP;
END;
$$;
