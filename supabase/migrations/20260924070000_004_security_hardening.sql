/*
# Security hardening: cegah privilege escalation lewat role

Masalah sebelumnya:
1. Trigger handle_new_user mempercayai role dari raw_user_meta_data, sehingga siapa pun
   bisa mendaftar sebagai 'admin' langsung dari browser (anon key bersifat publik).
2. Policy update_own_profile hanya memeriksa id, sehingga user bisa mengubah role sendiri.
3. Admin tidak punya policy untuk mengubah profile user lain.

Perbaikan:
- Semua signup baru selalu berperan 'teknisi'.
- Kolom role / is_active / department_id hanya bisa diubah oleh admin
  (atau lewat SQL Editor / service role, di mana auth.uid() bernilai NULL).
- Admin boleh meng-update semua profile.

Admin pertama: jalankan manual di SQL Editor
  UPDATE public.profiles SET role = 'admin' WHERE id = (SELECT id FROM auth.users WHERE email = 'EMAIL_ANDA');
*/

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'teknisi'
  );
  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS "admin_update_profiles" ON public.profiles;
CREATE POLICY "admin_update_profiles" ON public.profiles FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE OR REPLACE FUNCTION public.protect_profile_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.is_active IS DISTINCT FROM OLD.is_active
       OR NEW.department_id IS DISTINCT FROM OLD.department_id THEN
      RAISE EXCEPTION 'Hanya admin yang dapat mengubah role, status aktif, atau departemen';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_profile_privileged_columns ON public.profiles;
CREATE TRIGGER protect_profile_privileged_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privileged_columns();
