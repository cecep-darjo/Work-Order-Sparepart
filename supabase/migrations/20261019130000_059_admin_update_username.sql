-- Allow administrators to change a user's username and keep Supabase Auth login
-- identity synchronized with profiles.username.
CREATE OR REPLACE FUNCTION public.admin_update_username(p_user_id uuid, p_username text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_username text := lower(btrim(p_username));
  v_email text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengubah username.';
  END IF;

  IF v_username !~ '^[a-z0-9][a-z0-9._-]{1,28}[a-z0-9]$' THEN
    RAISE EXCEPTION 'Username 3-30 karakter: huruf kecil, angka, titik, garis bawah atau strip.';
  END IF;

  v_email := v_username || '@wo-sparepart.app';

  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE lower(email) = v_email AND id <> p_user_id
  ) THEN
    RAISE EXCEPTION 'Username sudah dipakai.';
  END IF;

  UPDATE auth.users
  SET email = v_email, updated_at = now()
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User tidak ditemukan.';
  END IF;

  UPDATE auth.identities
  SET provider_id = v_email,
      identity_data = jsonb_set(COALESCE(identity_data, '{}'::jsonb), '{email}', to_jsonb(v_email), true),
      updated_at = now()
  WHERE user_id = p_user_id AND provider = 'email';

  UPDATE public.profiles
  SET username = v_username
  WHERE id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_username(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_username(uuid, text) TO authenticated;
