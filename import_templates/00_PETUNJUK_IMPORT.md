# Petunjuk Upload Sparepart ke Supabase

> Tujuan: memasukkan data sparepart dari file Excel (`.xls`/`.xlsx`) ke database Supabase **tabel `spare_parts`**.
> Penting: format `.xls` (Excel biner lama) TIDAK bisa dibaca langsung oleh Supabase/PostgREST.
> Solusinya: salin/import isi Excel ke file **CSV** sesuai template di folder ini, lalu import via SQL.

---

## Kenapa import ke `spare_parts` (bukan tabel baru)?

Tabel `spare_parts` adalah tabel master yang **dipakai seluruh aplikasi** (Work Order, part request,
issue slip, transaksi stok, dashboard inventori). Semua RPC & policy di-build terhadap tabel ini.
Membuat tabel baru berarti harus mengubah banyak kode → tidak disarankan.

---

## Langkah singkat

### 1. Siapkan data di Excel sesuai kolom template
- Buka `template_spare_parts.csv` (bisa dibuka langsung di Excel).
- Isi kolom sesuai data kamu. Lihat tabel kolom di bawah.
- Simpan file berupa **CSV UTF-8** (Excel → Save As → CSV UTF-8 (Comma delimited)) atau biarkan `.xlsx` lalu export ke CSV.

> Kalau hanya ingin "stok awal", cukup isi `code`, `name`, `unit`, `current_stock`, `location`.
> `id`, `created_at`, `updated_at` dikosongkan (auto diisi DB).

### 2. Import ke Supabase
Dua opsi:

**Opsi A — via SQL (paling bersih, disarankan).** Taruh file CSV di database supabase lalu jalankan SQL `import_spare_parts.sql`. Saya siapkan script yang:
- membuat tabel staging `_import_spare_parts`,
- me-import file CSV,
- lalu **upsert** ke `spare_parts` berdasar `code` (tidak membuat duplikat).

**Opsi B — via Table Editor (manual).** Di studio Supabase → Table Editor → `spare_parts` → Insert → Import from CSV. Pilih file CSV. Cocok bila datanya sedikit (<ribuan baris) dan tanpa evaluasi duplikat.

---

## Kolom `spare_parts` & contoh

Kolom **ISIAN** — wajib/opsional:

| Kolom | Wajib? | Tipe | Contoh |
|-------|--------|------|--------|
| `code` | Wajib, unik | teks | `BRG-00001` |
| `name` | Wajib | teks | `Bearing SKF 6204` |
| `category` | Opsional | teks | `Bearing` |
| `unit` | Opsional (default `pcs`) | teks | `pcs` |
| `min_stock` | Opsional | angka | `2` |
| `max_stock` | Opsional | angka | `20` |
| `current_stock` | Opsional (default 0) | angka | `5` |
| `location` | Opsional | teks | `Rak A-3` |
| `group_id` | Opsional | angka (id grup) | `1` |

> `group_id` mengacu ke id di tabel `inventory_groups`. Kalau ingin isi lewat nama grup, isi kolom
> `group_name` di file master lalu script import akan mencocokkan otomatis.

---

## File template di folder ini
- `template_spare_parts.csv` → isi data sparepart (kolom persis `spare_parts`).
- `template_master.csv` → isi daftar grup/kategori/satuan/lokasi (opsional, untuk dimasukkan ke
  tabel master agar bisa dipakai referensi/dropdown).
- `import_spare_parts.sql` → script SQL untuk import dari CSV ke `spare_parts` (gunakan jika Opsi A).

---

## Perhatian
- `code` bersifat UNIQUE → baris dengan `code` sama akan **ditimpa** (upsert), bukan duplikat.
- Jangan isi kolom `id`, `created_at`, `updated_at` (auto).
- Pastikan value `current_stock` berupa angka (bukan teks dengan koma/format ribuan).