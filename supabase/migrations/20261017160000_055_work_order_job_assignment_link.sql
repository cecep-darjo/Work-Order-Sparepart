-- Link a WO to at most one existing Jobs Assignment.
ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS job_assignment_id uuid
  REFERENCES public.job_assignments(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_orders_job_assignment_unique
  ON public.work_orders(job_assignment_id)
  WHERE job_assignment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.wo_validate_job_assignment_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_status text;
  v_link_changed boolean;
BEGIN
  IF NEW.job_assignment_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_link_changed := true;
  ELSE
    v_link_changed := NEW.job_assignment_id IS DISTINCT FROM OLD.job_assignment_id;
  END IF;

  IF v_link_changed THEN
    SELECT status INTO v_job_status
    FROM public.job_assignments
    WHERE id = NEW.job_assignment_id;

    IF v_job_status IS NULL OR v_job_status NOT IN ('assigned', 'on_the_way', 'in_progress', 'done', 'approved') THEN
      RAISE EXCEPTION 'Pilih Jobs Assignment yang sedang berjalan atau sudah selesai.';
    END IF;

    IF v_job_status = 'approved' AND NEW.status <> 'canceled' THEN
      NEW.status := 'closed';
      NEW.closed_at := COALESCE(NEW.closed_at, now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.wo_validate_job_assignment_link() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS wo_validate_job_assignment_link_insert ON public.work_orders;
CREATE TRIGGER wo_validate_job_assignment_link_insert
  BEFORE INSERT ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.wo_validate_job_assignment_link();

DROP TRIGGER IF EXISTS wo_validate_job_assignment_link_update ON public.work_orders;
CREATE TRIGGER wo_validate_job_assignment_link_update
  BEFORE UPDATE OF job_assignment_id ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.wo_validate_job_assignment_link();

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

    v_notes := 'Jobs Assignment ' || NEW.job_no || ' disetujui; WO ditutup otomatis.';
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

DROP TRIGGER IF EXISTS wo_close_when_job_assignment_approved ON public.job_assignments;
CREATE TRIGGER wo_close_when_job_assignment_approved
  AFTER UPDATE OF status ON public.job_assignments
  FOR EACH ROW EXECUTE FUNCTION public.wo_close_when_job_assignment_approved();
