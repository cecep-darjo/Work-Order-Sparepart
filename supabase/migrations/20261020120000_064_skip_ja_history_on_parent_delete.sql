-- The membership delete trigger writes a history row. During a parent cascade,
-- the parent may already be invisible, producing a NULL job_id. Skip that
-- synthetic event; the existing history rows are removed by their FK cascade.
CREATE OR REPLACE FUNCTION public.ja_team_member_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.job_assignments%ROWTYPE;
  v_technician uuid;
  v_name text;
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.delete_job_assignment', true) = '1' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT * INTO v_job FROM public.job_assignments j WHERE j.id = OLD.job_id;
    v_technician := OLD.technician_id;
  ELSE
    SELECT * INTO v_job FROM public.job_assignments j WHERE j.id = NEW.job_id;
    v_technician := NEW.technician_id;
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_technician;
  INSERT INTO public.job_assignment_history (job_id, status, action, notes, performed_by)
  VALUES (
    v_job.id,
    v_job.status,
    CASE WHEN TG_OP = 'DELETE' THEN 'Teknisi dilepas' ELSE 'Teknisi ditugaskan' END,
    COALESCE(v_name, '-'),
    COALESCE(auth.uid(), v_job.created_by)
  );

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.ja_team_member_history() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
