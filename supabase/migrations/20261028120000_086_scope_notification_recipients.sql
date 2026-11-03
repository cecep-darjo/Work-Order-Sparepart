-- Align bell and background push recipients with each role's actual action scope.
-- SPVs review only assignments they created and approve part requests for their WO PICs.
-- SS recipients must have an explicit profile_departments assignment, matching the app.
-- Remove only queued push alerts that SPV recipients are not authorized to act on.
DELETE FROM public.web_push_outbox o
USING public.profiles p
WHERE o.profile_id = p.id
  AND p.role = 'spv'
  AND (
    (o.group_key IN ('job_review', 'job_overdue') AND NOT EXISTS (
      SELECT 1 FROM public.job_assignments j WHERE j.id = o.item_id AND j.created_by = p.id
    ))
    OR (o.group_key = 'req_pending' AND NOT EXISTS (
      SELECT 1 FROM public.wo_part_requests r
      JOIN public.work_orders w ON w.id = r.work_order_id
      WHERE r.id = o.item_id AND w.spv_id = p.id
    ))
  );
CREATE OR REPLACE FUNCTION public.queue_bell_push_notifications()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_initialized boolean;
BEGIN
  CREATE TEMP TABLE current_bell_push_items (
    profile_id uuid NOT NULL,
    group_key text NOT NULL,
    title text NOT NULL,
    item_id uuid NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO current_bell_push_items(profile_id, group_key, title, item_id)
  WITH active_profiles AS (
    SELECT id, role, department_id FROM public.profiles WHERE is_active = true
  ),
  bell_items AS (
    -- Work orders awaiting assignment, verification, close, or technician action.
    SELECT p.id AS profile_id, 'wo_assign_spv'::text AS group_key,
           'WO menunggu assignment SPV'::text AS title, w.id AS item_id
    FROM active_profiles p JOIN public.work_orders w ON w.status = 'new' AND w.spv_id IS NULL
    WHERE p.role = 'admin' OR (p.role = 'ss' AND EXISTS (SELECT 1 FROM public.profile_departments pd WHERE pd.profile_id = p.id AND pd.department_id = w.department_id))

    UNION ALL
    SELECT p.id, 'wo_assign_tech', 'WO menunggu assignment teknisi', w.id
    FROM active_profiles p JOIN public.work_orders w ON w.status = 'assigned'
    WHERE p.role = 'spv'
      AND (w.spv_id = p.id OR p.department_id = w.department_id OR EXISTS (
        SELECT 1 FROM public.profile_departments pd
        WHERE pd.profile_id = p.id AND pd.department_id = w.department_id
      ))
      AND NOT EXISTS (SELECT 1 FROM public.work_order_technicians wt WHERE wt.work_order_id = w.id)

    UNION ALL
    SELECT p.id, 'wo_verify', 'WO menunggu verifikasi Anda', w.id
    FROM active_profiles p JOIN public.work_orders w ON w.status = 'done'
    WHERE p.role = 'spv'
      AND (w.spv_id = p.id OR p.department_id = w.department_id OR EXISTS (
        SELECT 1 FROM public.profile_departments pd
        WHERE pd.profile_id = p.id AND pd.department_id = w.department_id
      ))

    UNION ALL
    SELECT p.id, 'wo_close', 'WO siap di-close', w.id
    FROM active_profiles p JOIN public.work_orders w ON w.status = 'verified'
    WHERE p.role = 'admin' OR (p.role = 'ss' AND EXISTS (SELECT 1 FROM public.profile_departments pd WHERE pd.profile_id = p.id AND pd.department_id = w.department_id))

    UNION ALL
    SELECT p.id, 'wo_start', 'WO baru ditugaskan', w.id
    FROM active_profiles p
    JOIN public.work_order_technicians wt ON wt.technician_id = p.id
    JOIN public.work_orders w ON w.id = wt.work_order_id AND w.status = 'assigned'
    WHERE p.role = 'teknisi'

    UNION ALL
    SELECT p.id, 'wo_work', 'WO sedang Anda kerjakan', w.id
    FROM active_profiles p
    JOIN public.work_order_technicians wt ON wt.technician_id = p.id
    JOIN public.work_orders w ON w.id = wt.work_order_id AND w.status IN ('analysis', 'on_progress')
    WHERE p.role = 'teknisi'

    -- Part request approval follows each user's role and WO department/PIC scope.
    UNION ALL
    SELECT p.id, 'req_pending', 'Permintaan part menunggu approval', r.id
    FROM active_profiles p
    JOIN public.wo_part_requests r ON r.status = 'pending'
    JOIN public.work_orders w ON w.id = r.work_order_id AND w.status NOT IN ('closed', 'verified')
    WHERE p.role = 'admin'
       OR (p.role = 'ss' AND EXISTS (SELECT 1 FROM public.profile_departments pd WHERE pd.profile_id = p.id AND pd.department_id = w.department_id))
       OR (p.role = 'spv' AND w.spv_id = p.id)

    UNION ALL
    SELECT p.id, 'req_ss_approved', 'Permintaan part siap diproses', r.id
    FROM active_profiles p JOIN public.wo_part_requests r ON r.status = 'ss_approved'
    WHERE p.role IN ('admin', 'inventory')

    -- Jobs Assignment action groups.
    UNION ALL
    SELECT p.id, 'job_active', 'Tugas penugasan aktif', j.id
    FROM active_profiles p
    JOIN public.job_assignment_technicians jt ON jt.technician_id = p.id
    JOIN public.job_assignments j ON j.id = jt.job_id AND j.status IN ('assigned', 'on_the_way', 'in_progress')
    WHERE p.role = 'teknisi'

    UNION ALL
    SELECT p.id, 'job_review', 'Laporan tugas menunggu approval', j.id
    FROM active_profiles p
    JOIN public.job_assignments j ON j.status = 'done'
    WHERE (p.role IN ('admin', 'ss') OR (p.role = 'spv' AND j.created_by = p.id))
      AND EXISTS (SELECT 1 FROM public.job_assignment_technicians jt WHERE jt.job_id = j.id)

    UNION ALL
    SELECT p.id, 'job_overdue', 'Tugas melewati deadline', j.id
    FROM active_profiles p
    JOIN public.job_assignments j
      ON j.status IN ('assigned', 'on_the_way', 'in_progress') AND j.deadline < now()
    WHERE (p.role IN ('admin', 'ss') OR (p.role = 'spv' AND j.created_by = p.id))
      AND EXISTS (SELECT 1 FROM public.job_assignment_technicians jt WHERE jt.job_id = j.id)

    -- Inventory and purchasing action groups.
    UNION ALL
    SELECT p.id, 'bon', 'Bon sparepart menunggu diproses', b.id
    FROM active_profiles p JOIN public.spare_part_bons b ON b.status IN ('pending', 'partial')
    WHERE p.role IN ('admin', 'inventory')

    UNION ALL
    SELECT p.id, 'pr_numbering', 'PR menunggu nomor SAP & PR', pr.id
    FROM active_profiles p JOIN public.purchase_requirements pr ON pr.status = 'pending_numbering'
    WHERE p.role IN ('admin', 'inventory')

    UNION ALL
    SELECT p.id, 'low_stock', 'Stok menipis', sp.id
    FROM active_profiles p CROSS JOIN public.spare_parts sp
    WHERE p.role IN ('admin', 'inventory') AND sp.min_stock > 0 AND sp.current_stock <= sp.min_stock
  )
  SELECT DISTINCT profile_id, group_key, title, item_id FROM bell_items;

  SELECT initialized INTO v_initialized
  FROM public.web_push_runtime WHERE singleton = true FOR UPDATE;

  IF NOT COALESCE(v_initialized, false) THEN
    UPDATE public.web_push_runtime SET initialized = true WHERE singleton = true;
    INSERT INTO public.web_push_action_state(profile_id, group_key, item_ids)
    SELECT profile_id, group_key, array_agg(DISTINCT item_id ORDER BY item_id)
    FROM current_bell_push_items GROUP BY profile_id, group_key
    ON CONFLICT (profile_id, group_key) DO UPDATE
      SET item_ids = EXCLUDED.item_ids, updated_at = now();
    RETURN;
  END IF;

  INSERT INTO public.web_push_outbox(profile_id, group_key, title, body)
  SELECT c.profile_id,
         c.group_key,
         c.title,
         CASE WHEN count(*) = 1 THEN 'Ada 1 item baru di lonceng notifikasi.'
              ELSE 'Ada ' || count(*)::text || ' item baru di lonceng notifikasi.' END
  FROM current_bell_push_items c
  LEFT JOIN public.web_push_action_state s
    ON s.profile_id = c.profile_id AND s.group_key = c.group_key
  WHERE NOT (c.item_id = ANY(COALESCE(s.item_ids, '{}'::uuid[])))
    AND EXISTS (SELECT 1 FROM public.web_push_subscriptions sub WHERE sub.profile_id = c.profile_id)
  GROUP BY c.profile_id, c.group_key, c.title;

  UPDATE public.web_push_action_state s SET item_ids = '{}', updated_at = now()
  WHERE NOT EXISTS (
    SELECT 1 FROM current_bell_push_items c
    WHERE c.profile_id = s.profile_id AND c.group_key = s.group_key
  );

  INSERT INTO public.web_push_action_state(profile_id, group_key, item_ids)
  SELECT profile_id, group_key, array_agg(DISTINCT item_id ORDER BY item_id)
  FROM current_bell_push_items GROUP BY profile_id, group_key
  ON CONFLICT (profile_id, group_key) DO UPDATE
    SET item_ids = EXCLUDED.item_ids, updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.queue_bell_push_notifications() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_bell_push_notifications() TO service_role;
NOTIFY pgrst, 'reload schema';