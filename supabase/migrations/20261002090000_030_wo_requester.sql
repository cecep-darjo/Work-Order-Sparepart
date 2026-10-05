/*
# Peminta (requester) pada Work Order

Kebutuhan:
1) Saat membuat WO, admin/SS dapat mengisi "Nama Peminta" dan "Departemen Peminta".
2) Boleh dipilih dari user terdaftar (username) -> requester_id terisi, atau diketik manual.
3) Ikut tampil di detail WO dan PDF report.

Catatan:
- Departemen peminta dibuat teks bebas (bisa berbeda dari work_orders.department_id, yaitu
  departemen tujuan WO / pemilik area-equipment).
- Kolom opsional; WO lama tetap valid (tampil "-").
- Tidak ada perubahan RLS: policy insert/update work_orders yang ada sudah mencakup kolom baru.

Aman dijalankan ulang.
*/

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS requester_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS requester_name text,
  ADD COLUMN IF NOT EXISTS requester_department text;
