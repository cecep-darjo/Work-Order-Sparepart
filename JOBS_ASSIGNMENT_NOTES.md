# Jobs Assignment — Penugasan Teknisi

Menu baru **Jobs Assignment** (sidebar, setelah Work Orders) untuk Admin, SS, SPV, dan Teknisi.
Terpisah dari Work Order: dipakai untuk penugasan lapangan cepat (judul, lokasi, teknisi, deadline,
prioritas) dengan bukti foto dan approval atasan.

## Cara pasang

1. Salin isi paket ini ke root proyek (timpa `src/App.tsx`, `src/components/Layout.tsx`,
   `src/lib/actionItems.ts`, `src/pages/ActivityLogPage.tsx`; file lainnya baru).
2. Jalankan **`supabase/migrations/20261017090000_048_jobs_assignment.sql`** di Supabase → SQL Editor.
   Aman dijalankan ulang. Migrasi ini membuat 3 tabel, trigger, RLS, dan bucket `job-photo-files`.
3. `npm run build` lalu deploy seperti biasa (`npm run deploy`, atau build offline proxy).

> Sebelum migrasi dijalankan, aplikasi tetap normal. Halaman Jobs Assignment hanya menampilkan
> pesan error dengan petunjuk menjalankan migrasi, dan lonceng notifikasi tidak terpengaruh.

## Alur status

```
Ditugaskan ──► On the Way ──► In Progress ──► Done ──► Disetujui
     └──────────────────────► In Progress      │
                                  ▲            └─ ditolak atasan (wajib catatan) → kembali In Progress
Atasan dapat Membatalkan (wajib alasan) selama belum Disetujui/Dibatalkan.
```

## Hak akses

| Aksi | Admin / SS / SPV | Teknisi (penerima tugas) | Role lain |
|---|---|---|---|
| Lihat tugas | Semua | Hanya miliknya | — |
| Buat / ubah / ganti teknisi | ✅ | ❌ | ❌ |
| On the Way → In Progress → Done | ❌ | ✅ | ❌ |
| Unggah / hapus foto bukti | ❌ | ✅ (saat On the Way / In Progress) | ❌ |
| Approve / tolak laporan | ✅ | ❌ | ❌ |
| Batalkan tugas | ✅ | ❌ | ❌ |

Aturan ditegakkan di **database** (trigger + RLS), bukan hanya UI.

## Aturan penting

- **Done** wajib punya ≥ 1 foto bukti dan catatan laporan.
- Foto dari kamera HP dikecilkan otomatis di browser hingga ≤ 500KB (JPG/PNG/WEBP, maks. 10 foto/tugas).
- Mengganti teknisi mengembalikan status ke *Ditugaskan* dan menghapus catatan laporan teknisi lama
  (foto tetap). Tugas berstatus Done tidak bisa dipindahkan; tolak laporannya dulu.
- Tugas **Disetujui / Dibatalkan** bersifat final.
- Nomor tugas otomatis `JAyy/nnnn`, reset tiap tahun.
- Riwayat tiap tugas dan entri **Activity Log** (`job_create`, `job_reassign`, `job_approve`,
  `job_reject`, `job_cancel`) dicatat otomatis oleh database.

## Notifikasi (lonceng & Dashboard)

- Teknisi: "Tugas penugasan aktif" (merah bila ada yang lewat deadline).
- Atasan: "Laporan tugas menunggu approval" dan "Tugas melewati deadline".

## File

Baru: `supabase/migrations/…048_jobs_assignment.sql`, `src/lib/jobAssignments.ts`,
`src/pages/JobAssignments.tsx`, `src/components/JobAssignmentForm.tsx`, `src/components/JobAssignmentDetail.tsx`.
Diubah (penambahan kecil): `App.tsx`, `Layout.tsx`, `actionItems.ts`, `ActivityLogPage.tsx`.
