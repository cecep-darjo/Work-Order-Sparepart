# Rancangan Teknis — Preventive Maintenance Berbasis Bulan dan Toleransi Hari

## 1. Tujuan dan batas modul

Modul **Preventive Maintenance (PM)** menjadi bagian aplikasi **Work Order**. Modul menyediakan kalender tahunan, pengelolaan beberapa program PM per mesin, pembuatan daftar pekerjaan bulanan, penugasan Admin/SS/SPV, pemantauan jendela toleransi, serta riwayat penyelesaian.

PM memakai **Mesin Target** dari Master Data WO. Eksekusi dicatat sebagai **Penugasan PM** di modul tersendiri dan ditautkan ke kejadian PM (occurrence). Penugasan PM tidak membuat Work Order atau Jobs Assignment.

## 2. Keputusan aturan bisnis

1. Satu mesin boleh memiliki banyak rencana PM dengan interval, pekerjaan, dan aturan tanggal yang berbeda.
2. Interval adalah bilangan bulat positif dalam bulan, misalnya 2, 4, 6, atau 12.
3. Semua tanggal kalender memakai **Asia/Jakarta**. Due date disimpan sebagai tipe `date`, bukan timestamp.
4. Generator harian menyiapkan occurrence bulan berikutnya mulai 7 hari sebelum bulan dimulai (umumnya sekitar satu minggu sebelum akhir bulan berjalan). Proses idempotent dan melakukan catch-up jika jadwal otomatis sempat gagal.
5. Toleransi mengikuti **bulan kalender jadwal**, bukan lagi ±7 hari. Pekerjaan dapat dilakukan selama bulan rencana. Jika belum selesai pada akhir bulan, occurrence menjadi `OVERDUE` dan otomatis dibawa satu kali ke bulan berikutnya. Carry-over menambah beban bulan depan; occurrence reguler pada bulan depan tetap dibuat dan tidak digeser. Jika tetap belum terlaksana pada akhir bulan carry-over, tutup dengan status `NOT_DONE` / **Tidak Dilakukan**; jangan terus menggesernya.
   - Sebelum bulan rencana: `UPCOMING`.
   - Selama bulan rencana: `DUE_THIS_MONTH`.
   - Bulan due terlewati: `OVERDUE_RESCHEDULED` pada bulan carry-over.
   - Bulan carry-over juga terlewati tanpa selesai: `NOT_DONE` / **Tidak Dilakukan** (terminal).
   - Setelah pekerjaan selesai: `COMPLETED` (terminal, tidak lagi overdue).
6. **Fixed Calendar** mempertahankan hari jangkar. Jika tanggal tidak tersedia (misalnya tanggal 31 di Februari), gunakan hari terakhir bulan itu. Tiap due dihitung dari anchor asli agar tidak terjadi drift.
7. **Execution-Based / Floating** menghitung due berikutnya dari tanggal aktual teknisi menyelesaikan pekerjaan ditambah interval bulan. Hari aktual menjadi anchor baru.
8. Occurrence Floating yang belum selesai tidak membuat occurrence berikutnya; overdue dibawa satu kali ke bulan berikutnya. Jika tetap tidak selesai, status menjadi `NOT_DONE` dan tidak ada reschedule lanjutan.
9. Kalender tahun untuk Floating menampilkan due yang terkonfirmasi dan due berikutnya sebagai **Proyeksi**. Proyeksi diperbarui setelah pekerjaan selesai.
10. Admin mengelola penanda tipe kerja teknisi (`shift`/`non_shift`) melalui profil. Kalender teknisi menampilkan assignment dan shift; batasan shift hanya berlaku bagi teknisi bertipe shift. Teknisi non-shift tidak divalidasi terhadap roster shift. Untuk keduanya, periksa ketidakhadiran dan konflik pekerjaan.
11. User **SS, SPV, dan Admin** memilih tanggal pelaksanaan saat membuat assignment. Tanggal yang dipilih harus berada pada bulan rencana aktif (termasuk carry-over); untuk teknisi shift tanggal/jam itu harus sesuai roster.

## 3. Pengalaman pengguna dan navigasi

Tambahkan halaman **Preventive Maintenance** pada grup **Work Order**, dengan tab:

- **Kalender Tahunan** — 12 bulan, navigasi tahun, filter departemen/area/mesin/status/teknisi, status dan penanda occurrence proyeksi.
- **Kalender Teknisi** — kalender minggu/bulan per teknisi atau tim, berisi assignment dan shift. Roster dan aturan shift hanya berlaku untuk teknisi bertipe shift; non-shift tetap memiliki kalender tugas dan validasi bentrok/ketidakhadiran.
- Admin mengelola tipe shift pada profil; SS/SPV/Admin memilih tanggal assignment pada kalender teknisi.
- **Jadwal PM** — tambah/edit/nonaktifkan program: mesin, nama, instruksi/checklist, interval, mode tanggal, tanggal mulai, dan tanggal akhir opsional.
- **Penugasan PM** — occurrence bulan berjalan/berikutnya yang memiliki penugasan mandiri, termasuk teknisi, tanggal, prioritas, status, dan laporan.
- **Overdue** — pekerjaan dari bulan sebelumnya yang otomatis dibawa satu kali ke bulan aktif, menampilkan bulan asal serta opsi assign/re-assign. Yang tidak selesai sampai akhir bulan carry-over menjadi **Tidak Dilakukan**.
- **Riwayat** — occurrence, Penugasan PM, teknisi, tanggal aktual, hasil, dan audit perubahan.

Kartu occurrence menampilkan mesin/kode, program, due date asli, bulan rencana saat ini, indikator carry-over/bulan asal, mode, status, teknisi/shift, nomor Penugasan PM, dan tindakan.

## 4. Model data yang disarankan

### `pm_schedules` — definisi program PM berulang

| Kolom | Makna |
|---|---|
| `id uuid PK` | ID jadwal |
| `equipment_id uuid FK equipment` | Mesin Target |
| `title`, `description text` | Nama program dan instruksi kerja |
| `interval_months int CHECK > 0` | Jarak dalam bulan |
| `schedule_mode text` | `fixed_calendar` atau `execution_based` |
| `anchor_due_date date` | Tanggal mulai/jangkar |
| `next_due_date date` | Due yang terkonfirmasi berikutnya |
| `end_date date NULL` | Batas jadwal opsional |
| `is_active boolean DEFAULT true` | Jadwal aktif |
| `created_by`, `created_at`, `updated_at` | Audit |

Indeks yang disarankan: `(equipment_id, is_active)` dan `(next_due_date, is_active)`. Perubahan interval/mode/anchor tidak boleh mengubah occurrence yang sudah diterbitkan diam-diam. Berlakukan perubahan pada tanggal efektif atau minta user memilih apakah occurrence mendatang ikut dihitung ulang.

### `pm_occurrences` — satu kejadian terjadwal

| Kolom | Makna |
|---|---|
| `id uuid PK` | ID occurrence |
| `schedule_id uuid FK pm_schedules` | Jadwal sumber |
| `period_key text` | Kunci periode asli, misalnya `2027-03` (Fixed) atau key due-date (Floating) |
| `due_date date` | Tanggal jatuh tempo asli; tidak berubah saat carry-over |
| `planned_month date` | Bulan target eksekusi; maju otomatis saat occurrence overdue |
| `planned_execution_date date NULL` | Tanggal yang dipilih SS/SPV/Admin untuk pelaksanaan |
| `reschedule_count int DEFAULT 0 CHECK (0..1)` | Maksimal satu carry-over |
| `execution_status text` | `open`, `completed`, `not_done`, `waived`, `canceled` |
| `pm_assignment_id uuid NULL FK pm_assignments UNIQUE` | Assignment eksekusi mandiri; `job_assignment_id` lama hanya dipertahankan untuk riwayat migrasi |
| `completed_at timestamptz NULL` | Waktu selesai aktual |
| `closed_by`, `closed_at`, `close_reason` | Penutupan non-completion |
| `created_at` | Waktu dibuat |

Constraint `UNIQUE(schedule_id, period_key)` mencegah duplikasi occurrence reguler. Indeks: `(planned_month, execution_status)` dan `(schedule_id, due_date)`. Carry-over memperbarui `planned_month` pada occurrence yang sama; jangan membuat salinan karena akan menggandakan pekerjaan overdue.

### Shift dan ketersediaan teknisi

Aplikasi mendukung teknisi pada Jobs Assignment, tetapi belum mempunyai roster shift/ketidakhadiran atau penanda tipe teknisi. Tambahkan model:

- `profiles.work_schedule_type`: `shift` / `non_shift`, dikelola Admin pada profil/Users.
- `technician_shift_patterns`: teknisi bertipe shift, hari, jam mulai/selesai, zona waktu, masa berlaku.
- `technician_shift_assignments`: roster aktual per tanggal untuk rotasi harian/mingguan.
- `technician_absences`: teknisi, waktu mulai/selesai, jenis (cuti/libur/sakit), status persetujuan.

Kalender menampilkan semua assignment dan meng-overlay roster hanya untuk teknisi shift. Pemeriksaan assignment mewajibkan teknisi shift masuk roster pada tanggal/jam itu; teknisi non-shift melewati pemeriksaan roster. Untuk keduanya, cek absensi dan konflik pekerjaan. Admin mengelola tipe kerja di profil. `activeCounts` hanya indikator beban, bukan kalender availability.

## 5. Pembuatan occurrence bulanan

Jalankan fungsi terjadwal harian pada waktu tetap zona Jakarta, misalnya Supabase Cron/`pg_cron`. Pilih jadwal aktif yang due date-nya pada bulan berikutnya dan sudah masuk jendela pembuatan (`today >= next_month_start - 7 days`). Job harian lebih tahan terhadap kegagalan dibanding hanya dijalankan satu kali tanggal 24/25. Pada pergantian bulan, fungsi yang sama membawa occurrence terbuka ke bulan berikutnya satu kali; jika occurrence itu sudah pernah dibawa dan bulan carry-over berakhir, fungsi menetapkan `NOT_DONE`. Kedua langkah mencatat event history.

```text
for each active schedule:
  if fixed_calendar:
    hitung tanggal due pada bulan depan dari anchor dan interval
  else:
    gunakan next_due_date hanya jika jatuh pada bulan depan

  untuk tiap tanggal yang memenuhi:
    INSERT occurrence(period_key, due_date, planned_month=month(due_date))
    ON CONFLICT (schedule_id, period_key) DO NOTHING

at month boundary:
  for each open occurrence whose planned_month just ended:
    if reschedule_count == 0:
      planned_month = next_month
      reschedule_count = 1
      append reschedule event to history
    else:
      execution_status = not_done
      append not-done event to history
```

Catch-up membuat seluruh occurrence yang sudah memasuki jendela pembuatan dan belum ada. Due date asli tidak digeser. Jadwal baru yang dibuat terlambat dapat diterbitkan sebagai catch-up dengan audit. Unique constraint mengamankan generator; reschedule harus transaksional dan idempotent per bulan. Satu occurrence hanya mendapat satu carry-over. Bila masih terbuka pada akhir bulan carry-over, ubah status menjadi `not_done` dan hentikan reschedule.

Untuk Fixed Calendar:

```text
month_index = (year - anchor_year) * 12 + (month - anchor_month)
eligible    = month_index >= 0 AND month_index % interval_months = 0
due_day     = min(anchor_day, days_in_target_month)
due_date    = target_year_month + due_day
```

Untuk Floating, saat teknisi menyelesaikan Penugasan PM mandiri (status `done`):

```text
actual_date = local_date(pm_assignment.done_at, 'Asia/Jakarta')
next_due_date = add_months_clamped(actual_date, interval_months)
update pm_schedules.next_due_date
```

Aturan yang dipilih: gunakan `done_at` (tanggal lokal Asia/Jakarta saat teknisi menyatakan selesai). Approval SPV tidak menggeser jadwal. Jika occurrence overdue dibawa ke bulan berikutnya, penyelesaian di bulan itu menjadi dasar `done_at + interval`; tidak dibuat due berikutnya sebelum pekerjaan selesai.

## 6. Penugasan PM mandiri

1. SS/SPV/Admin memilih occurrence, satu atau beberapa teknisi, tanggal pelaksanaan opsional di bulan target, dan prioritas.
2. RPC membuat baris `pm_assignments`, anggota tim, tautan occurrence, dan riwayat secara atomik. Tidak ada WO atau JA yang dibuat.
3. Validasi server memeriksa role/cakupan departemen SPV, teknisi aktif yang terdaftar pada departemen, tanggal target, dan prioritas.
4. Teknisi memulai tugas dan mengirim laporan; laporan wajib diisi sebelum status `done`.
5. Admin/SS/SPV sesuai cakupan dapat menyetujui hasil. Saat status berubah menjadi `done`, occurrence diselesaikan dan jadwal Floating dihitung ulang.
6. Penugasan JA PM lama disalin ke model PM tersendiri saat migrasi agar histori dan anggota tim tetap tersedia. JA lama disembunyikan dari daftar operasional JA.

## 7. Status kalender

Hitung `today` di Asia/Jakarta, secara inklusif:

```text
if execution_status in (completed, not_done, waived, canceled): return execution_status
if current_month < planned_month: return UPCOMING
if reschedule_count > 0 and current_month == planned_month: return OVERDUE_RESCHEDULED
if current_month == planned_month: return DUE_THIS_MONTH
if current_month > planned_month and execution_status == open and reschedule_count == 0:
  return OVERDUE_RESCHEDULED
if current_month > planned_month and execution_status == open and reschedule_count == 1:
  return NOT_DONE
```

Pada akhir bulan due, occurrence belum selesai mempertahankan due asli dan maju satu bulan target. Pada akhir bulan carry-over, occurrence yang tetap terbuka ditutup sebagai `NOT_DONE`. Status PM dan status Penugasan PM terpisah; overdue tidak mengubah status assignment.

## 8. Hak akses dan keamanan

- **Admin/SS**: kelola jadwal, lihat semua departemen, assign/re-assign, tutup/waive dengan alasan.
- **SPV**: lihat jadwal departemennya, assign/re-assign dalam cakupan.
- **Teknisi**: lihat occurrence/assignment miliknya, update progres/laporan; tidak mengubah rencana atau assignee.
- **Kalender teknisi**: tampilkan assignment semua teknisi; overlay dan validasi roster hanya pada tipe shift. Non-shift tetap dicek konflik tugas dan ketidakhadiran.
- Terapkan RLS dan pemeriksaan role/cakupan di RPC/database, bukan hanya menyembunyikan tombol.
- Cron memakai fungsi service/definer dengan hak minimum dan mencatat waktu proses, jumlah occurrence, serta error.

## 9. Validasi dan edge cases

- Interval integer `>= 1`; tanggal mulai wajib; due tidak melewati `end_date`.
- Tahun kabisat, lintas tahun, dan bulan 29/30/31 mengikuti aturan clamp.
- Beberapa jadwal pada mesin yang sama tetap dibedakan oleh `schedule_id`.
- Retry, klik ulang, dan generator paralel tidak menggandakan occurrence.
- Jadwal nonaktif menghentikan occurrence baru; yang sudah dibuat tetap bisa dikerjakan/ditutup.
- Cegah hapus mesin yang memiliki jadwal/riwayat; nonaktifkan jadwal dan simpan snapshot nama/kode pada occurrence atau gunakan soft-delete.
- Perubahan cadence berlaku pada tanggal efektif; occurrence terbit tetap tersimpan.
- Occurrence overdue mempertahankan due asli dan otomatis maju satu planned month; bila tidak selesai pada akhir bulan itu, status terminal menjadi `NOT_DONE` / **Tidak Dilakukan**.
- `waived`/`canceled` wajib memiliki alasan dan audit trail.

## 10. Tahapan implementasi

1. **Skema & keamanan** — tabel PM, constraint/index, RLS, audit, penanda shift pada profil yang dikelola Admin, roster/absence, RPC assignment, cron.
2. **Master Jadwal PM** — CRUD, validasi, preview kalender tahunan dan hak akses.
3. **Occurrence & kalender** — generator idempotent, catch-up, status per bulan, carry-over otomatis, kalender teknisi dan overdue.
4. **Penugasan PM** — tabel, teknisi, progres, laporan, persetujuan, serta riwayat PM terpisah dari Work Order dan Jobs Assignment.
5. **Completion & laporan** — sinkronisasi status, Floating next due, reopen behavior, histori dan kepatuhan PM.

### Kriteria penerimaan utama

- Interval 2/4/6/12 bulan menghasilkan bulan yang tepat; tanggal 29/30/31 di-clamp dengan benar.
- Generator mulai tujuh hari sebelum bulan due dan idempotent sekalipun dijalankan ulang/paralel.
- Status bergeser pada batas bulan kalender Jakarta; overdue menambah beban satu bulan berikutnya tanpa menghapus occurrence reguler, lalu menjadi Tidak Dilakukan bila tetap terbuka.
- Fixed Calendar tidak bergeser karena pekerjaan terlambat/lebih awal.
- Floating memakai tanggal penyelesaian aktual dan tidak menjadwalkan ulang sebelum tugas selesai.
- Satu mesin dapat memiliki beberapa program PM, dan setiap occurrence hanya punya satu assignment.
- Admin mengelola penanda shift/non-shift di profil; kalender menerapkan roster hanya untuk teknisi shift.
- SS/SPV/Admin dapat memilih tanggal assignment di bulan target, dan kalender teknisi menampilkannya.
- Carry-over yang belum terlaksana pada bulan berikutnya berakhir sebagai **Tidak Dilakukan**, tanpa reschedule lanjutan.
- Assignment/re-assignment teknisi shift ditolak bila shift tidak cocok; semua assignment ditolak bila teknisi cuti atau bentrok.
- SPV tidak dapat melampaui cakupan departemen lewat API.
- Perubahan status dan assignee tercatat di history.

## 11. Keputusan yang sudah ditetapkan

1. Admin mengelola penanda teknisi shift/non-shift lewat profil.
2. SS, SPV, dan Admin memilih tanggal pelaksanaan pada bulan target.
3. Overdue dibawa satu kali ke bulan berikutnya dan menambah bebannya. Jika tidak terlaksana pada akhir bulan carry-over, occurrence diberi status **Tidak Dilakukan** dan tidak di-reschedule lagi.


