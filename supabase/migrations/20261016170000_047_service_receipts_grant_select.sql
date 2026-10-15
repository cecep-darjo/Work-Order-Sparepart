/*
# Perbaikan: izin SELECT tabel penerimaan jasa

Migrasi 046 menjalankan `REVOKE ALL ... FROM anon, authenticated` pada
`purchase_requirement_service_receipts` lalu hanya membuat policy RLS, tanpa GRANT SELECT.
Akibatnya role `authenticated` tidak punya hak baca tabel (permission denied) sehingga
penerimaan jasa tidak muncul di Inventory Transactions / Daftar GR.

RLS tetap berlaku: hanya admin/ss/inventory yang lolos policy `read_service_receipts`.
Penulisan tetap hanya lewat RPC `receive_stock_multi` (SECURITY DEFINER).
Aman dijalankan ulang.
*/
GRANT SELECT ON public.purchase_requirement_service_receipts TO authenticated;
