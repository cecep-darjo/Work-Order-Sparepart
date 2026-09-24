/*
# Login berbasis username

Aplikasi memetakan username ke email internal <username>@wo-sparepart.app.
Migrasi ini:
1. Menambah kolom profiles.username (turunan dari bagian sebelum '@' pada email auth).
2. Mengisi username untuk profile yang sudah ada.
3. Memperbarui trigger handle_new_user agar mengisi username (role tetap selalu 'teknisi').
4. Memperbarui proteksi kolom: username hanya bisa diubah admin (atau SQL Editor).
*/

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username text;

UPDATE public.profiles p
SET username = lower(split_part(u.email, '@', 1))
FROM auth.users u
WHERE u.id = p.id AND p.username IS NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_username ON public.profiles (lower(username));

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role, username)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'teknisi',
    lower(split_part(NEW.email, '@', 1))
  );
  RETURN NEW;
END;
$$;

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
       OR NEW.department_id IS DISTINCT FROM OLD.department_id
       OR NEW.username IS DISTINCT FROM OLD.username THEN
      RAISE EXCEPTION 'Hanya admin yang dapat mengubah role, status aktif, departemen, atau username';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
