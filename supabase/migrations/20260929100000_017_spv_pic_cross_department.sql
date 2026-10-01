/*
# Perbaikan: SPV yang ditunjuk sebagai PIC (spv_id) tidak bisa melihat WO lintas departemen

Selama ini akses SPV ke work_orders (baca, ubah, kelola daftar teknisi) hanya dicek lewat
kecocokan departemen profil SPV dengan departemen WO. Padahal admin memilih SPV dari SEMUA
SPV aktif tanpa syarat departemen (lihat halaman Work Orders), sehingga seorang SPV yang
departemennya berbeda dari WO tetap bisa ditunjuk sebagai PIC (work_orders.spv_id) namun
tidak pernah bisa melihat WO tersebut sama sekali.

Migration ini menambahkan jalur akses baru: work_orders.spv_id = auth.uid(), berlaku di
samping (bukan menggantikan) pengecekan departemen yang sudah ada. Jadi:
- SPV yang departemennya cocok dengan WO tetap bisa melihat semua WO departemen tersebut
  (perilaku lama, dipertahankan).
- SPV yang ditunjuk langsung sebagai PIC (spv_id) kini SELALU bisa melihat & mengelola WO
  itu, walau departemennya berbeda.

Aman dijalankan ulang.
*/

DROP POLICY IF EXISTS "read_work_orders" ON public.work_orders;
CREATE POLICY "read_work_orders" ON public.work_orders FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','inventory'))
    OR
    work_orders.spv_id = auth.uid()
    OR
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'spv' AND p.department_id = work_orders.department_id)
    OR
    public.is_wo_technician(work_orders.id)
  );

DROP POLICY IF EXISTS "update_work_orders" ON public.work_orders;
CREATE POLICY "update_work_orders" ON public.work_orders FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    OR
    work_orders.spv_id = auth.uid()
    OR
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'spv' AND p.department_id = work_orders.department_id)
    OR
    public.is_wo_technician(work_orders.id)
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    OR
    work_orders.spv_id = auth.uid()
    OR
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'spv' AND p.department_id = work_orders.department_id)
    OR
    public.is_wo_technician(work_orders.id)
  );

DROP POLICY IF EXISTS "insert_wo_technicians" ON public.work_order_technicians;
CREATE POLICY "insert_wo_technicians" ON public.work_order_technicians FOR INSERT
  TO authenticated WITH CHECK (
    public.is_admin()
    OR EXISTS (SELECT 1 FROM public.work_orders w WHERE w.id = work_order_technicians.work_order_id AND w.spv_id = auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      JOIN public.work_orders w ON w.id = work_order_technicians.work_order_id
      WHERE p.id = auth.uid() AND p.role = 'spv' AND p.department_id = w.department_id
    )
  );

DROP POLICY IF EXISTS "delete_wo_technicians" ON public.work_order_technicians;
CREATE POLICY "delete_wo_technicians" ON public.work_order_technicians FOR DELETE
  TO authenticated USING (
    public.is_admin()
    OR EXISTS (SELECT 1 FROM public.work_orders w WHERE w.id = work_order_technicians.work_order_id AND w.spv_id = auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      JOIN public.work_orders w ON w.id = work_order_technicians.work_order_id
      WHERE p.id = auth.uid() AND p.role = 'spv' AND p.department_id = w.department_id
    )
  );
