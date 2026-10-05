/*
# Perbaiki riwayat WO & activity log yang kosong

Masalah:
  Aplikasi memuat riwayat dengan `performer:profiles!performed_by(*)` (dan activity log dengan
  `user:profiles!user_id(*)`). PostgREST hanya bisa menggabungkan tabel bila ada foreign key
  langsung ke `profiles`, sedangkan work_order_history.performed_by dan activity_log.user_id
  hanya mengarah ke auth.users. Akibatnya query gagal (PGRST200 "Could not find a relationship")
  dan layar menampilkan "No history yet".

Perbaikan:
  Tambah FK ke public.profiles(id) pada kedua kolom. profiles.id = auth.users.id, jadi data
  lama tetap sah. FK ke auth.users yang sudah ada dibiarkan.

Catatan:
- Aman dijalankan ulang.
- FK ditambahkan NOT VALID lebih dulu agar baris lama tidak membuat migration gagal, lalu dicoba
  divalidasi. PostgREST sudah memakai FK walau belum tervalidasi.
*/

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_order_history_performed_by_profiles_fkey') THEN
    ALTER TABLE public.work_order_history
      ADD CONSTRAINT work_order_history_performed_by_profiles_fkey
      FOREIGN KEY (performed_by) REFERENCES public.profiles(id) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_user_id_profiles_fkey') THEN
    ALTER TABLE public.activity_log
      ADD CONSTRAINT activity_log_user_id_profiles_fkey
      FOREIGN KEY (user_id) REFERENCES public.profiles(id) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE public.work_order_history VALIDATE CONSTRAINT work_order_history_performed_by_profiles_fkey;
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'work_order_history: ada baris lama tanpa profil; FK tetap aktif tetapi belum tervalidasi.';
END $$;

DO $$
BEGIN
  ALTER TABLE public.activity_log VALIDATE CONSTRAINT activity_log_user_id_profiles_fkey;
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'activity_log: ada baris lama tanpa profil; FK tetap aktif tetapi belum tervalidasi.';
END $$;

-- Muat ulang cache skema PostgREST agar relasi baru langsung dikenali.
NOTIFY pgrst, 'reload schema';
