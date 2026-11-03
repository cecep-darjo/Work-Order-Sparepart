-- SPV may manage only the Area and Mesin Target sections in Master Data WO.
-- Admin and SS retain their existing access to these tables.
DROP POLICY IF EXISTS "admin_insert_areas" ON public.areas;
CREATE POLICY "admin_insert_areas" ON public.areas FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'ss', 'spv')
    )
  );

DROP POLICY IF EXISTS "admin_update_areas" ON public.areas;
CREATE POLICY "admin_update_areas" ON public.areas FOR UPDATE
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'ss', 'spv')
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'ss', 'spv')
    )
  );

DROP POLICY IF EXISTS "admin_delete_areas" ON public.areas;
CREATE POLICY "admin_delete_areas" ON public.areas FOR DELETE
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'ss', 'spv')
    )
  );

DROP POLICY IF EXISTS "admin_insert_equipment" ON public.equipment;
CREATE POLICY "admin_insert_equipment" ON public.equipment FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'ss', 'spv')
    )
  );

DROP POLICY IF EXISTS "admin_update_equipment" ON public.equipment;
CREATE POLICY "admin_update_equipment" ON public.equipment FOR UPDATE
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'ss', 'spv')
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'ss', 'spv')
    )
  );

DROP POLICY IF EXISTS "admin_delete_equipment" ON public.equipment;
CREATE POLICY "admin_delete_equipment" ON public.equipment FOR DELETE
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'ss', 'spv')
    )
  );
