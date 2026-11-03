-- Rejecting a completed PM returns its existing assignment to the assignee.
-- Schedule deletion is an admin-only soft delete to preserve execution history.

ALTER TABLE public.pm_schedules
  ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.pm_guard_schedule_soft_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_deleted AND public.ja_role() IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'Hanya Admin yang dapat menghapus atau memulihkan jadwal PM.';
    END IF;
    IF NEW.is_deleted THEN NEW.is_active := false; END IF;
  ELSIF NEW.is_deleted IS DISTINCT FROM OLD.is_deleted THEN
    IF public.ja_role() IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'Hanya Admin yang dapat menghapus atau memulihkan jadwal PM.';
    END IF;
    IF NEW.is_deleted THEN NEW.is_active := false; END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pm_guard_schedule_soft_delete ON public.pm_schedules;
DROP TRIGGER IF EXISTS pm_guard_schedule_soft_delete_insert ON public.pm_schedules;
CREATE TRIGGER pm_guard_schedule_soft_delete_insert
BEFORE INSERT ON public.pm_schedules
FOR EACH ROW EXECUTE FUNCTION public.pm_guard_schedule_soft_delete();
CREATE TRIGGER pm_guard_schedule_soft_delete
BEFORE UPDATE OF is_deleted ON public.pm_schedules
FOR EACH ROW EXECUTE FUNCTION public.pm_guard_schedule_soft_delete();

CREATE OR REPLACE FUNCTION public.pm_set_schedule_active(p_schedule_id uuid, p_is_active boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role text := public.ja_role();
  v_schedule public.pm_schedules%ROWTYPE;
BEGIN
  IF COALESCE(v_role, '') NOT IN ('admin','ss','spv') THEN
    RAISE EXCEPTION 'Anda tidak berwenang mengubah aktivasi jadwal PM.';
  END IF;
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = p_schedule_id FOR UPDATE;
  IF NOT FOUND OR v_schedule.is_deleted THEN RAISE EXCEPTION 'Jadwal PM tidak ditemukan atau sudah dihapus.'; END IF;
  IF v_role <> 'admin' AND NOT public.pm_current_user_has_department(v_schedule.department_id) THEN
    RAISE EXCEPTION 'Jadwal PM berada di luar cakupan departemen Anda.';
  END IF;
  IF p_is_active AND (
    NOT EXISTS (SELECT 1 FROM public.department_pm_settings s WHERE s.department_id = v_schedule.department_id AND s.pm_enabled)
    OR NOT EXISTS (SELECT 1 FROM public.department_equipment_scope s WHERE s.department_id = v_schedule.department_id AND s.equipment_id = v_schedule.equipment_id)
  ) THEN
    RAISE EXCEPTION 'Aktifkan PM departemen dan masukkan mesin ke cakupan terlebih dahulu.';
  END IF;
  UPDATE public.pm_schedules SET is_active = p_is_active, updated_at = now() WHERE id = v_schedule.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.pm_admin_delete_schedule(p_schedule_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_schedule public.pm_schedules%ROWTYPE;
  v_canceled record;
BEGIN
  IF public.ja_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Hanya Admin yang dapat menghapus jadwal PM.';
  END IF;
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = p_schedule_id FOR UPDATE;
  IF NOT FOUND OR v_schedule.is_deleted THEN RAISE EXCEPTION 'Jadwal PM tidak ditemukan atau sudah dihapus.'; END IF;

  -- Stop pending occurrences that have never been assigned. Existing assigned
  -- work and completed history remain available to technicians and reviewers.
  FOR v_canceled IN
    UPDATE public.pm_occurrences
    SET execution_status = 'canceled', completed_at = NULL
    WHERE schedule_id = p_schedule_id AND execution_status = 'open'
      AND pm_assignment_id IS NULL AND job_assignment_id IS NULL
    RETURNING id
  LOOP
    INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
    VALUES (v_canceled.id, 'canceled', jsonb_build_object('reason', 'Jadwal PM dihapus oleh Admin'), auth.uid());
  END LOOP;

  UPDATE public.pm_schedules SET is_active = false, is_deleted = true, updated_at = now()
  WHERE id = p_schedule_id;
  INSERT INTO public.activity_log(user_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), 'delete_pm_schedule', 'pm_schedule', p_schedule_id,
    'Jadwal PM diarsipkan/dihapus: ' || v_schedule.title || ' · ' || COALESCE(v_schedule.department_id::text, 'tanpa departemen'));
END;
$$;

CREATE OR REPLACE FUNCTION public.pm_update_assignment_status(
  p_assignment_id uuid, p_next_status text, p_report_notes text DEFAULT NULL,
  p_pending_reason text DEFAULT NULL, p_review_note text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_assignment public.pm_assignments%ROWTYPE;
  v_occ public.pm_occurrences%ROWTYPE;
  v_schedule public.pm_schedules%ROWTYPE;
  v_role text := public.ja_role();
  v_is_assignee boolean;
  v_is_manager boolean;
  v_notes text;
  v_done_date date;
BEGIN
  SELECT * INTO v_assignment FROM public.pm_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Penugasan PM tidak ditemukan.'; END IF;
  SELECT * INTO v_occ FROM public.pm_occurrences WHERE id = v_assignment.occurrence_id FOR UPDATE;
  SELECT * INTO v_schedule FROM public.pm_schedules WHERE id = v_occ.schedule_id;
  v_is_assignee := EXISTS (SELECT 1 FROM public.pm_assignment_technicians t WHERE t.assignment_id = v_assignment.id AND t.technician_id = auth.uid());
  v_is_manager := v_role IN ('admin','ss') OR (v_role = 'spv' AND public.pm_profile_has_department(auth.uid(), v_schedule.department_id));
  IF NOT v_is_assignee AND NOT v_is_manager THEN RAISE EXCEPTION 'Anda tidak berwenang mengubah penugasan PM ini.'; END IF;
  IF v_assignment.status IN ('approved','canceled') THEN RAISE EXCEPTION 'Penugasan PM sudah final.'; END IF;

  IF v_is_assignee AND NOT v_is_manager THEN
    IF NOT ((v_assignment.status = 'assigned' AND p_next_status IN ('on_the_way','in_progress'))
      OR (v_assignment.status = 'on_the_way' AND p_next_status = 'in_progress')
      OR (v_assignment.status = 'in_progress' AND p_next_status IN ('in_progress','done'))) THEN
      RAISE EXCEPTION 'Perubahan status penugasan PM tidak diizinkan.';
    END IF;
    IF p_next_status = 'done' AND length(btrim(coalesce(p_report_notes, ''))) = 0 THEN RAISE EXCEPTION 'Isi laporan pekerjaan sebelum menyelesaikan PM.'; END IF;
  ELSE
    IF NOT ((v_assignment.status = 'in_progress' AND p_next_status = 'pending')
      OR (v_assignment.status = 'pending' AND p_next_status = 'in_progress')
      OR (v_assignment.status = 'done' AND p_next_status IN ('approved','in_progress','assigned'))) THEN
      RAISE EXCEPTION 'Perubahan status penugasan PM tidak diizinkan.';
    END IF;
    IF p_next_status = 'pending' AND length(btrim(coalesce(p_pending_reason, ''))) = 0 THEN RAISE EXCEPTION 'Alasan pending wajib diisi.'; END IF;
    IF v_assignment.status = 'done' AND p_next_status IN ('in_progress','assigned')
       AND length(btrim(coalesce(p_review_note, ''))) = 0 THEN
      RAISE EXCEPTION 'Catatan wajib diisi saat menolak PM atau meminta perbaikan.';
    END IF;
  END IF;

  UPDATE public.pm_assignments SET
    status = p_next_status,
    report_notes = CASE WHEN v_is_assignee AND NOT v_is_manager THEN coalesce(nullif(btrim(p_report_notes), ''), report_notes) ELSE report_notes END,
    pending_reason = CASE WHEN p_next_status = 'pending' THEN btrim(p_pending_reason) WHEN p_next_status = 'in_progress' AND v_assignment.status = 'pending' THEN NULL ELSE pending_reason END,
    on_the_way_at = CASE WHEN p_next_status = 'assigned' AND v_assignment.status = 'done' THEN NULL WHEN p_next_status = 'on_the_way' THEN coalesce(on_the_way_at, now()) ELSE on_the_way_at END,
    started_at = CASE WHEN p_next_status = 'assigned' AND v_assignment.status = 'done' THEN NULL WHEN p_next_status = 'in_progress' THEN coalesce(started_at, now()) ELSE started_at END,
    done_at = CASE WHEN p_next_status = 'done' THEN now() WHEN v_assignment.status = 'done' AND p_next_status IN ('in_progress','assigned') THEN NULL ELSE done_at END,
    review_note = CASE WHEN p_next_status IN ('approved','in_progress','assigned') AND v_assignment.status = 'done' THEN nullif(btrim(p_review_note), '') ELSE review_note END,
    reviewed_by = CASE WHEN v_assignment.status = 'done' AND p_next_status IN ('approved','in_progress','assigned') THEN auth.uid() ELSE reviewed_by END,
    reviewed_at = CASE WHEN v_assignment.status = 'done' AND p_next_status IN ('approved','in_progress','assigned') THEN now() ELSE reviewed_at END,
    updated_at = now()
  WHERE id = v_assignment.id;

  v_notes := CASE
    WHEN p_next_status = 'done' THEN nullif(btrim(p_report_notes), '')
    WHEN p_next_status = 'pending' THEN btrim(p_pending_reason)
    WHEN v_assignment.status = 'done' THEN nullif(btrim(p_review_note), '')
    ELSE NULL
  END;
  INSERT INTO public.pm_assignment_history(assignment_id, status, action, notes, performed_by)
  VALUES (v_assignment.id, p_next_status,
    CASE WHEN v_assignment.status = 'done' AND p_next_status = 'assigned' THEN 'PM ditolak dan dikembalikan ke teknisi' ELSE 'Status penugasan PM diubah' END,
    v_notes, auth.uid());

  IF p_next_status = 'done' THEN
    v_done_date := (now() AT TIME ZONE 'Asia/Jakarta')::date;
    UPDATE public.pm_occurrences SET execution_status = 'completed', completed_at = now() WHERE id = v_occ.id;
    IF v_schedule.schedule_mode = 'execution_based' THEN
      UPDATE public.pm_schedules SET next_due_date = public.pm_add_months_clamped(v_done_date, v_schedule.interval_months), updated_at = now() WHERE id = v_schedule.id;
    END IF;
    INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
    VALUES (v_occ.id, 'completed', jsonb_build_object('pm_assignment_id', v_assignment.id, 'done_at', now(), 'done_date_jakarta', v_done_date), auth.uid());
  ELSIF v_assignment.status = 'done' AND p_next_status IN ('in_progress','assigned') THEN
    UPDATE public.pm_occurrences SET execution_status = 'open', completed_at = NULL WHERE id = v_occ.id;
    IF v_schedule.schedule_mode = 'execution_based' THEN
      UPDATE public.pm_schedules SET next_due_date = v_occ.due_date, updated_at = now() WHERE id = v_schedule.id;
    END IF;
    INSERT INTO public.pm_occurrence_history(occurrence_id, action, details, performed_by)
    VALUES (v_occ.id, CASE WHEN p_next_status = 'assigned' THEN 'rejected_and_reassigned' ELSE 'reopened' END,
      jsonb_build_object('pm_assignment_id', v_assignment.id, 'reason', v_notes, 'status', p_next_status), auth.uid());
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.pm_admin_delete_schedule(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pm_guard_schedule_soft_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pm_admin_delete_schedule(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.pm_update_assignment_status(uuid,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_update_assignment_status(uuid,text,text,text,text) TO authenticated;

NOTIFY pgrst, 'reload schema';
