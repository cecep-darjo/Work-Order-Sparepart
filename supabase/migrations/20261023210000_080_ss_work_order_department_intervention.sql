-- SS may continue to read all Work Orders for monitoring, but edits and status
-- interventions must stay inside departments assigned to that SS profile.
-- Admin retains cross-department access. Preserve the existing SPV and technician rules.

DROP POLICY IF EXISTS "update_work_orders" ON public.work_orders;
CREATE POLICY "update_work_orders" ON public.work_orders FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR (
      EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'ss')
      AND EXISTS (
        SELECT 1 FROM public.profile_departments pd
        WHERE pd.profile_id = auth.uid() AND pd.department_id = work_orders.department_id
      )
    )
    OR work_orders.spv_id = auth.uid()
    OR (
      EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'spv')
      AND public.profile_has_department(auth.uid(), work_orders.department_id)
    )
    OR public.is_wo_technician(work_orders.id)
  )
  WITH CHECK (
    public.is_admin()
    OR (
      EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'ss')
      AND EXISTS (
        SELECT 1 FROM public.profile_departments pd
        WHERE pd.profile_id = auth.uid() AND pd.department_id = work_orders.department_id
      )
    )
    OR work_orders.spv_id = auth.uid()
    OR (
      EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'spv')
      AND public.profile_has_department(auth.uid(), work_orders.department_id)
    )
    OR public.is_wo_technician(work_orders.id)
  );

NOTIFY pgrst, 'reload schema';
