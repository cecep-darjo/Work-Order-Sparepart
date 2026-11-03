-- Copy an optional JA approval comment into the linked Work Order close history.
CREATE OR REPLACE FUNCTION public.wo_close_when_job_assignment_approved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo record;
  v_actor uuid;
  v_notes text;
  v_comment text := NULLIF(btrim(NEW.review_note), '');
BEGIN
  IF NEW.status <> 'approved' OR OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  v_actor := COALESCE(auth.uid(), NEW.reviewed_by, NEW.created_by);
  FOR v_wo IN
    SELECT id, wo_number
    FROM public.work_orders
    WHERE job_assignment_id = NEW.id
      AND status NOT IN ('closed', 'canceled')
  LOOP
    UPDATE public.work_orders
    SET status = 'closed', closed_at = COALESCE(closed_at, now()), updated_at = now()
    WHERE id = v_wo.id;

    v_notes := 'Jobs Assignment ' || NEW.job_no || ' disetujui; WO ditutup otomatis.'
      || CASE WHEN v_comment IS NOT NULL THEN E'\nKomentar: ' || v_comment ELSE '' END;
    INSERT INTO public.work_order_history (work_order_id, status, action, notes, performed_by)
    VALUES (v_wo.id, 'closed', 'WO closed automatically after Jobs Assignment approval', v_notes, v_actor);

    IF v_actor IS NOT NULL THEN
      INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
      VALUES (v_actor, 'close_wo_from_job_assignment', 'work_order', v_wo.id, 'Closed ' || v_wo.wo_number, v_notes);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.wo_close_when_job_assignment_approved() FROM PUBLIC, anon, authenticated;
