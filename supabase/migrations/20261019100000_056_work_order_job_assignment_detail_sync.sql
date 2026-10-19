-- Keep the linked Work Order in sync with its Jobs Assignment details and timeline.
ALTER TABLE public.work_order_history
  ADD COLUMN IF NOT EXISTS job_assignment_history_id uuid
  REFERENCES public.job_assignment_history(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_order_history_job_assignment_history
  ON public.work_order_history(job_assignment_history_id)
  WHERE job_assignment_history_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.wo_copy_job_assignment_history(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.work_order_history (
    work_order_id, status, action, notes, performed_by, performed_at, job_assignment_history_id
  )
  SELECT
    wo.id,
    jh.status,
    'Jobs Assignment: ' || jh.action,
    jh.notes,
    jh.performed_by,
    jh.performed_at,
    jh.id
  FROM public.job_assignment_history jh
  JOIN public.work_orders wo ON wo.job_assignment_id = jh.job_id
  WHERE jh.job_id = p_job_id
  ON CONFLICT DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.wo_copy_job_assignment_history(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.wo_sync_job_assignment_details()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.job_assignments%ROWTYPE;
  v_area_id uuid;
  v_job_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'work_orders' THEN
    IF NEW.job_assignment_id IS NULL THEN
      RETURN NEW;
    END IF;
    v_job_id := NEW.job_assignment_id;
  ELSE
    v_job_id := NEW.id;
  END IF;

  SELECT * INTO v_job
  FROM public.job_assignments
  WHERE id = v_job_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT area_id INTO v_area_id
  FROM public.equipment
  WHERE id = v_job.equipment_id;
  IF v_area_id IS NULL THEN
    SELECT id INTO v_area_id
    FROM public.areas
    WHERE lower(btrim(name)) = lower(btrim(v_job.location))
    LIMIT 1;
  END IF;

  UPDATE public.work_orders wo
  SET area_id = v_area_id,
      equipment_id = v_job.equipment_id,
      problem_description = concat_ws(E'\n', NULLIF(btrim(v_job.title), ''), NULLIF(btrim(v_job.description), '')),
      analysis = NULLIF(btrim(v_job.report_notes), ''),
      updated_at = now()
  WHERE wo.job_assignment_id = v_job_id
    AND (TG_TABLE_NAME <> 'work_orders' OR wo.id = NEW.id);

  PERFORM public.wo_copy_job_assignment_history(v_job_id);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.wo_sync_job_assignment_details() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS wo_sync_job_assignment_details_after_insert ON public.work_orders;
CREATE TRIGGER wo_sync_job_assignment_details_after_insert
  AFTER INSERT ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.wo_sync_job_assignment_details();

DROP TRIGGER IF EXISTS wo_sync_job_assignment_details_after_link ON public.work_orders;
CREATE TRIGGER wo_sync_job_assignment_details_after_link
  AFTER UPDATE OF job_assignment_id ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.wo_sync_job_assignment_details();

DROP TRIGGER IF EXISTS wo_sync_job_assignment_details_after_job_update ON public.job_assignments;
CREATE TRIGGER wo_sync_job_assignment_details_after_job_update
  AFTER UPDATE OF title, description, location, equipment_id, report_notes ON public.job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.wo_sync_job_assignment_details();

CREATE OR REPLACE FUNCTION public.wo_sync_new_job_assignment_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.wo_copy_job_assignment_history(NEW.job_id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.wo_sync_new_job_assignment_history() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS wo_sync_new_job_assignment_history ON public.job_assignment_history;
CREATE TRIGGER wo_sync_new_job_assignment_history
  AFTER INSERT ON public.job_assignment_history
  FOR EACH ROW EXECUTE FUNCTION public.wo_sync_new_job_assignment_history();

-- Bring links created before this migration up to date as well.
UPDATE public.work_orders wo
SET area_id = COALESCE(e.area_id, a.id),
    equipment_id = j.equipment_id,
    problem_description = concat_ws(E'\n', NULLIF(btrim(j.title), ''), NULLIF(btrim(j.description), '')),
    analysis = NULLIF(btrim(j.report_notes), ''),
    updated_at = now()
FROM public.job_assignments j
LEFT JOIN public.equipment e ON e.id = j.equipment_id
LEFT JOIN public.areas a ON lower(btrim(a.name)) = lower(btrim(j.location))
WHERE wo.job_assignment_id = j.id;

SELECT public.wo_copy_job_assignment_history(j.id)
FROM public.job_assignments j
WHERE EXISTS (SELECT 1 FROM public.work_orders wo WHERE wo.job_assignment_id = j.id);
