# Panduan Pengguna — Inventory Control

Panduan ini untuk akun dengan role **Inventory Control** pada aplikasi EngWO Inventory. Nama menu mengikuti tampilan aplikasi; sebagian label tombol masih berbahasa Inggris.

## 1. Masuk dan navigasi

1. Buka alamat aplikasi yang diberikan administrator.
2. Masukkan **username** dan password, lalu tekan **Sign In**.
3. Gunakan menu di sisi kiri untuk berpindah halaman. Pada ponsel, buka menu dengan tombol ☰.
4. Tekan **Refresh** bila halaman perlu memuat data terbaru.

Akun Inventory dapat membuka Dashboard, Bon Sparepart, Spare Parts, Inventory Transactions, Daftar GR, Low Stock Alerts, Purchase Requirements, Master Data Inventory, dan User Settings. Menu Work Orders dan Jobs Assignment dikelola role operasional lain.

## 2. Alur kerja umum

Alur pengadaan dan penerimaan biasanya seperti berikut:

1. **Purchase Requirements:** buat PR dan isi barang atau jasa yang dibutuhkan.
2. **Nomori PR:** isi nomor SAP dan nomor PR pada PR yang berstatus *Menunggu Nomor SAP/PR*.
3. **Inventory Transactions → Pemasukan:** terima barang/jasa dari PR, atau masukkan barang secara manual.
4. **Daftar GR:** cari kembali GR yang sudah dibuat dan periksa rinciannya.

Untuk pengeluaran, proses bon atau permintaan spare part WO melalui **Inventory Transactions → Pengeluaran** agar stok dan riwayat transaksi tercatat.

## 3. Dashboard dan notifikasi

Dashboard merangkum hal yang perlu diperhatikan akun Anda. Ikon lonceng di kanan atas menampilkan notifikasi; pilih notifikasi untuk membuka halaman terkait.

## 4. Purchase Requirements

Inventory dapat membuat PR dan mengisi nomor SAP/PR.

### Membuat PR

1. Buka **Purchase Requirements**.
2. Di bagian **Buat Purchase Requirement**, cari spare part dari master berdasarkan nama atau kode, masukkan jumlah, lalu tekan **Tambah**. Ulangi untuk item lain.
3. Untuk jasa yang tidak memakai stok master, isi uraian jasa dan satuannya, lalu tambahkan ke PR.
4. Lengkapi pemesan, supplier bila diketahui, nama mesin bila diperlukan, dan lampiran bila ada.
5. Periksa item dan jumlah, lalu simpan PR. Lampiran menerima JPG, PNG, WEBP, atau PDF dengan ukuran maksimal 5 MB per file.

### Mengisi nomor SAP dan PR

PR baru yang belum bernomor muncul dengan status **Menunggu Nomor SAP/PR**. Isi nomor SAP dan nomor PR pada baris PR tersebut, kemudian tekan **Simpan Nomor**. Setelah berhasil, status menjadi **Sudah Dinomori** dan PR dapat dipanggil saat penerimaan.

Gunakan pencarian atau rentang tanggal untuk menemukan PR. Jumlah diterima dan sisa pemenuhan dapat diperiksa pada detail item.

## 5. Inventory Transactions

Halaman ini mencatat pergerakan stok. Gunakan filter jenis transaksi, pencarian, filter spare part, dan tombol **Refresh** untuk menemukan data. Tabel dapat diurutkan dengan menekan judul kolom yang memiliki ikon sort.

### Pemasukan barang atau jasa

1. Tekan **Pemasukan**.
2. Pilih jenis GR:
   - **Kredit (SKSB)**
   - **Cash (STSB)**
   - **Import (SKIS)**
3. Isi supplier bila tersedia.
4. Isi nomor GR secara manual, atau tekan **Generate No. GR** lalu ubah nomor yang muncul bila diperlukan. Nomor harus belum pernah dipakai. Jika kolom dikosongkan, sistem membuat nomor otomatis saat disimpan.
5. Untuk menerima dari PR, pilih pemesan lalu tambahkan seluruh atau sebagian item PR yang masih tersisa. Jumlah tidak boleh melebihi sisa PR.
6. Untuk penerimaan yang tidak berasal dari PR, cari spare part pada bagian **Tambah Manual**, masukkan jumlah, lalu tekan **Tambah**.
7. Item barang dan jasa dapat berada dalam satu penerimaan. Barang memperbarui stok; jasa dicatat pada riwayat GR tanpa mengubah stok.
8. Lengkapi referensi dan keterangan, tambahkan lampiran bila diperlukan, periksa daftar item, lalu tekan **Simpan Pemasukan**.

Jika nomor GR sudah digunakan, sistem menolak penyimpanan. Masukkan nomor lain atau tekan **Generate No. GR** untuk mendapatkan nomor berikutnya.

### Pengeluaran barang

1. Tekan **Pengeluaran**.
2. Isi **Nama Penerima**. Tujuan, referensi, dan keterangan dapat dilengkapi sesuai kebutuhan.
3. Pilih sumber pengeluaran yang sesuai:
   - **Panggil dari Bon Sparepart:** pilih user pembuat bon lalu tambahkan item bon yang masih tersisa.
   - **Panggil dari Permintaan WO:** tekan **Proses Pengeluaran** pada permintaan yang telah disetujui. Jika stok belum cukup, permintaan tidak dapat diproses.
   - **Tambah Manual:** cari spare part dan masukkan jumlah.
4. Periksa jumlah dan stok yang tersedia, lalu simpan. Sistem mengurangi stok dan membuat lembar pengeluaran PDF. Simpan PDF sebagai bukti distribusi.

Penerimaan dari bon akan memperbarui status bon menjadi sebagian atau selesai sesuai jumlah yang dikeluarkan. Permintaan WO yang diproses tertaut ke WO terkait.

### Riwayat transaksi dan Stock Card

Gunakan pencarian untuk nomor dokumen, spare part, atau referensi. Filter untuk mempersempit jenis transaksi. Bagian **Stock Card** menampilkan riwayat pergerakan untuk spare part yang dipilih.

## 6. Daftar GR

Buka **Daftar GR** untuk melihat penerimaan yang sudah tersimpan. Cari berdasarkan nomor GR, jenis, supplier/sumber, referensi atau PR, spare part, kode inventori, maupun pembuat. Gunakan filter yang tersedia untuk mempersempit daftar, lalu buka detail GR untuk memeriksa item dan lampirannya.

Pemasukan lama yang tidak memiliki nomor GR tidak muncul sebagai GR bernomor.

## 7. Spare Parts dan Low Stock Alerts

### Mencari spare part

Di **Spare Parts**, cari berdasarkan nama, kode, kode inventori, grup, kategori, atau lokasi. Gunakan filter status stok dan tekan judul kolom untuk mengurutkan daftar. Status stok ditentukan dari batas minimum dan maksimum part:

- **Low Stock:** stok berada di bawah batas minimum.
- **Normal:** stok berada dalam rentang yang ditetapkan.
- **Over Stock:** stok melebihi batas maksimum.

**Low Stock Alerts** membuka daftar part dengan stok rendah secara langsung.

### Mengelola spare part dan stok

Inventory dapat menambah atau mengubah informasi master spare part. Pastikan nama, kategori, satuan, lokasi, grup, serta kode inventori terisi dengan benar. Untuk mencatat perubahan stok, gunakan transaksi pemasukan, pengeluaran, atau adjustment agar saldo dan riwayatnya dapat ditelusuri.

Fasilitas **Stock Opname** pada Spare Parts membuat lembar hitung untuk diunduh dalam format PDF atau Excel. Lembar tersebut membantu penghitungan fisik; pembuatan lembar tidak dengan sendirinya mengubah saldo stok.

## 8. Bon Sparepart

Role Inventory dapat melihat semua bon, mencari bon, dan memfilter berdasarkan status. Role ini tidak membuat bon atas nama peminta. Untuk mengeluarkan item bon, buka **Inventory Transactions → Pengeluaran → Panggil dari Bon Sparepart**. Bon aktif mencakup bon yang menunggu atau baru diproses sebagian.

## 9. Master Data Inventory

Gunakan tab yang tersedia untuk mengelola data pendukung inventory:

- **Categories:** kategori spare part.
- **Units:** satuan.
- **Locations:** lokasi penyimpanan.
- **Suppliers:** pemasok. Daftar supplier dapat diurutkan berdasarkan nama atau kode.
- **Inventory Groups:** grup untuk pengelompokan dan pembentukan kode part. Daftar dapat diurutkan berdasarkan nama atau kode.
- **GR Numbering:** melihat nomor awal dan nomor GR terakhir per jenis. Pengubahan nomor awal hanya tersedia untuk Admin atau Senior Supervisor.

Sebelum menghapus data master, pastikan data tersebut tidak lagi diperlukan oleh spare part atau transaksi yang sudah tercatat.

## 10. User Settings dan tanda tangan

Di **User Settings**, akun dapat mengubah nama lengkapnya sendiri dan mengganti password. Penggantian password meminta password saat ini untuk verifikasi; password baru minimal 6 karakter dan harus memuat huruf serta angka.

Menu **Tanda Tangan** di bagian bawah sidebar digunakan untuk mendaftarkan atau mengganti tanda tangan akun. Tanda tangan dipakai pada dokumen yang mendukung tanda tangan.

## 11. Tips jika terjadi kendala

- **Data belum terlihat:** tekan **Refresh** dan pastikan filter/pencarian tidak membatasi hasil.
- **Stok tidak cukup:** periksa saldo di Spare Parts atau Stock Card sebelum menyimpan pengeluaran.
- **Nomor GR ditolak:** pastikan belum pernah dipakai; gunakan generator atau nomor lain.
- **PR tidak muncul saat penerimaan:** pastikan PR sudah diberi nomor dan itemnya masih memiliki sisa penerimaan.
- **Permintaan WO tidak dapat diproses:** periksa apakah stok cukup dan permintaan sudah disetujui.
- **Akses ditolak:** hubungi Admin untuk memeriksa role dan hak akses akun.
