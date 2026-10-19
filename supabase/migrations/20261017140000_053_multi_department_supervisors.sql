-- Supervisors may cover more than one department. Keep profiles.department_id
-- as the legacy/primary department and store the complete assignment set here.
CREATE TABLE IF NOT EXISTS public.profile_departments (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, department_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_departments_department
  ON public.profile_departments(department_id, profile_id);

INSERT INTO public.profile_departments(profile_id, department_id)
SELECT id, department_id FROM public.profiles WHERE department_id IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE public.profile_departments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_departments FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.profile_departments TO authenticated;

DROP POLICY IF EXISTS profile_departments_read ON public.profile_departments;
CREATE POLICY profile_departments_read ON public.profile_departments FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'ss', 'spv'))
  );

DROP POLICY IF EXISTS profile_departments_insert ON public.profile_departments;
CREATE POLICY profile_departments_insert ON public.profile_departments FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS profile_departments_delete ON public.profile_departments;
CREATE POLICY profile_departments_delete ON public.profile_departments FOR DELETE TO authenticated
  USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.profile_has_department(p_profile_id uuid, p_department_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_profile_id AND p.department_id = p_department_id
  ) OR EXISTS (
    SELECT 1 FROM public.profile_departments pd
    WHERE pd.profile_id = p_profile_id AND pd.department_id = p_department_id
  );
$$;
REVOKE ALL ON FUNCTION public.profile_has_department(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profile_has_department(uuid, uuid) TO authenticated;

-- Work order creation and supervisor edits are limited to assigned departments.
DROP POLICY IF EXISTS "insert_work_orders" ON public.work_orders;
CREATE POLICY "insert_work_orders" ON public.work_orders FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'ss')
      AND public.profile_has_department(auth.uid(), department_id))
  );

DROP POLICY IF EXISTS "update_work_orders" ON public.work_orders;
CREATE POLICY "update_work_orders" ON public.work_orders FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'ss')
    OR spv_id = auth.uid()
    OR (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'spv')
      AND public.profile_has_department(auth.uid(), department_id))
    OR public.is_wo_technician(id)
  )
  WITH CHECK (
    public.is_admin()
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'ss')
    OR spv_id = auth.uid()
    OR (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'spv')
      AND public.profile_has_department(auth.uid(), department_id))
    OR public.is_wo_technician(id)
  );

DROP POLICY IF EXISTS "delete_work_orders" ON public.work_orders;
CREATE POLICY "delete_work_orders" ON public.work_orders FOR DELETE TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'ss')
  );

DROP POLICY IF EXISTS "insert_wo_technicians" ON public.work_order_technicians;
CREATE POLICY "insert_wo_technicians" ON public.work_order_technicians FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.work_orders w
      WHERE w.id = work_order_technicians.work_order_id
        AND public.profile_has_department(work_order_technicians.technician_id, w.department_id)
        AND (
          (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'ss')
            AND public.profile_has_department(auth.uid(), w.department_id))
          OR (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'spv')
            AND (w.spv_id = auth.uid() OR public.profile_has_department(auth.uid(), w.department_id)))
        )
    )
  );

DROP POLICY IF EXISTS "delete_wo_technicians" ON public.work_order_technicians;
CREATE POLICY "delete_wo_technicians" ON public.work_order_technicians FOR DELETE TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.work_orders w
      WHERE w.id = work_order_technicians.work_order_id
        AND (
          (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'ss')
            AND public.profile_has_department(auth.uid(), w.department_id))
          OR (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'spv')
            AND (w.spv_id = auth.uid() OR public.profile_has_department(auth.uid(), w.department_id)))
        )
    )
  );

-- Validate Jobs Assignment technicians against the creator's assigned sections.
CREATE OR REPLACE FUNCTION public.ja_validate_team_technician()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_user uuid;
  v_matches boolean;
BEGIN
  PERFORM public.ja_assert_technician(NEW.technician_id);
  v_role := public.ja_role();
  v_user := auth.uid();
  IF v_role = 'admin' THEN
    RETURN NEW;
  END IF;
  IF v_role NOT IN ('spv', 'ss') THEN
    RAISE EXCEPTION 'Hanya atasan yang dapat memilih teknisi.';
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles tech
    WHERE tech.id = NEW.technician_id
      AND (
        (tech.department_id IS NOT NULL AND public.profile_has_department(v_user, tech.department_id))
        OR EXISTS (
          SELECT 1 FROM public.profile_departments tech_dept
          JOIN public.profile_departments manager_dept ON manager_dept.department_id = tech_dept.department_id
          WHERE tech_dept.profile_id = tech.id AND manager_dept.profile_id = v_user
        )
      )
  ) INTO v_matches;
  IF NOT v_matches THEN
    RAISE EXCEPTION 'Teknisi harus berasal dari bagian yang ditugaskan kepada Anda.';
  END IF;
  RETURN NEW;
END;
$$;

-- Avoid re-inserting an existing primary membership during unrelated updates.
CREATE OR REPLACE FUNCTION public.ja_sync_primary_technician()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.job_assignment_technicians t
    WHERE t.job_id = NEW.id AND t.technician_id = NEW.technician_id
  ) THEN
    INSERT INTO public.job_assignment_technicians (job_id, technician_id)
    VALUES (NEW.id, NEW.technician_id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
