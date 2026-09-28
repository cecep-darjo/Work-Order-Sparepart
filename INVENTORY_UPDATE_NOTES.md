# EngWO Inventory – Inventory Transaction Update

## Perubahan utama
- Pemasukan dan pengeluaran barang tersedia untuk role `inventory` dan `admin`.
- Tidak ada approval untuk transaksi rutin.
- Tidak ada harga/nilai barang.
- Nomor transaksi otomatis: `IN-YYMMDD-xxxxx` dan `OUT-YYMMDD-xxxxx`.
- Setiap transaksi menyimpan stok sebelum, qty, saldo sesudah, referensi, sumber/tujuan, user, dan timestamp.
- Stock Card tersedia dari halaman Inventory Transactions.
- Pengeluaran WO terhubung langsung ke Work Order dan transaksi inventory.
- Pengembalian spare part dari WO juga dicatat sebagai transaksi.
- Edit `current_stock` secara langsung pada master spare part dihilangkan.
- Perubahan stok dilakukan melalui RPC database yang atomik.
- Transaksi final tidak menggunakan mekanisme approval.

## Database migration
Jalankan migration secara berurutan setelah migration lama:
- `supabase/migrations/20260928090000_011_inventory_transactions_v2.sql`
- `supabase/migrations/20260928093000_012_inventory_wo_integration.sql`

Jika menggunakan Supabase CLI, jalankan migration sesuai workflow project Anda.

## Validasi
- `npm run typecheck` berhasil.
- Build belum dapat diverifikasi di environment ini karena `node_modules` bawaan ZIP tidak memiliki optional package platform Rollup. Pada environment development/deployment, jalankan `npm install` lalu `npm run build`.
