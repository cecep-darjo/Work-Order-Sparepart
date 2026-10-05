/*
# SPV dapat melihat SEMUA Work Order (Semua Departemen)

Kebutuhan:
  Pada halaman daftar Work Order, role SPV memilih "Semua Departemen" namun hanya WO
  yang menjadi PIC-nya yang tampil. Permintaan user: SPV harus bisa melihat SEMUA WO
  di semua departemen (akses baca penuh untuk monitoring), sehingga tombol
  "Semua Departemen" benar-benar menampilkan seluruh WO.

Perubahan:
  1) Policy `read_work_orders` diperluas: role SPV dapat membaca semua WO lintas
     departemen (sebelumnya dibatasi ke departemen profil + WO yang jadi PIC).
  2) Policy UPDATE/DELETE tidak diubah: SPV tetap hanya bisa mengubah WO di
     departemennya sendiri atau yang menjadi PIC-nya (spv_id). Perluasan ini murni
     menambah akses BACA, bukan ubah/hapus.

Catatan:
  - Aman dijalankan ulang (DROP POLICY IF EXISTS lalu CREATE).
  - Akses role lain (admin, inventory, teknisi) tidak berubah.
*/

DROP POLICY IF EXISTS "read_work_orders" ON public.work_orders;
CREATE POLICY "read_work_orders" ON public.work_orders FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','inventory'))
    OR
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'spv')
    OR
    work_orders.spv_id = auth.uid()
    OR
    public.is_wo_technician(work_orders.id)
  );