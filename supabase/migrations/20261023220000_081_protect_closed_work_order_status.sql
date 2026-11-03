-- Closed Work Orders cannot be status-intervened. Only the Admin Reopen WO
-- operation may transition a closed Work Order back to verified.

CREATE OR REPLACE FUNCTION public.prevent_closed_work_order_intervention()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT public.is_admin()
      OR current_setting('app.allow_closed_wo_reopen', true) IS DISTINCT FROM '1'
    THEN
      RAISE EXCEPTION 'Work Order berstatus Closed hanya dapat dibuka kembali oleh Admin melalui aksi Reopen WO.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.prevent_closed_work_order_intervention() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS prevent_closed_work_order_intervention ON public.work_orders;
CREATE TRIGGER prevent_closed_work_order_intervention
  BEFORE UPDATE OF status ON public.work_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_closed_work_order_intervention();

CREATE OR REPLACE FUNCTION public.admin_reopen_work_order(p_wo_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Hanya Admin yang dapat melakukan Reopen WO.';
  END IF;

  SELECT status INTO v_status
  FROM public.work_orders
  WHERE id = p_wo_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Work Order tidak ditemukan.';
  END IF;
  IF v_status <> 'closed' THEN
    RAISE EXCEPTION 'Reopen WO hanya berlaku untuk Work Order berstatus Closed.';
  END IF;

  PERFORM set_config('app.allow_closed_wo_reopen', '1', true);
  UPDATE public.work_orders
  SET status = 'verified', closed_at = NULL, updated_at = now()
  WHERE id = p_wo_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_reopen_work_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reopen_work_order(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
