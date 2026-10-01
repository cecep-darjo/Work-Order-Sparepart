/*
# Perbaikan: panggilan apply_inventory_transaction "not unique"

Masalah:
Migration 011, 018 dan 019 masing-masing membuat versi `apply_inventory_transaction` dengan
jumlah parameter berbeda (8, 10 dan 11) tanpa menghapus versi sebelumnya. Panggilan yang tidak
menyebut semua parameter (mis. `issue_stock_manual` untuk Pengeluaran multi-item dan
penyesuaian stok di halaman Spare Parts) cocok dengan lebih dari satu versi sehingga PostgreSQL
menolak dengan "function ... is not unique".

Perbaikan:
Hapus dua versi lama yang hanya berperan sebagai pembungkus. Versi 11 parameter (semua parameter
tambahan memiliki DEFAULT) tetap ada dan melayani semua pemanggil. Tidak ada perubahan perilaku.

Aman dijalankan ulang (DROP IF EXISTS).
*/

DROP FUNCTION IF EXISTS public.apply_inventory_transaction(uuid, text, numeric, text, text, uuid, text, text);
DROP FUNCTION IF EXISTS public.apply_inventory_transaction(uuid, text, numeric, text, text, uuid, text, text, text, text[]);
