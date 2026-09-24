/*
# Kelola user tanpa email

Supabase Auth secara internal butuh sebuah identitas berbentuk email, jadi username
dipetakan ke <username>@wo-sparepart.app. Migrasi ini membuat semua proses berjalan
tanpa pernah mengetik, mengirim, atau memverifikasi email:

- _create_app_user  : pembuat user (internal). Hanya bisa dipanggil dari SQL Editor.
- admin_create_user : dipanggil Admin Panel; hanya admin.
- admin_set_password: admin mengganti password user; hanya admin.

User dibuat langsung sebagai terkonfirmasi, sehingga:
- Pengaturan "Confirm email" di Supabase tidak berpengaruh.
- "Allow new users to sign up" boleh dimatikan (pendaftaran publik ditutup).

Admin pertama, jalankan di SQL Editor:
  SELECT public._create_app_user('admin', 'GantiPassword1', 'Administrator', 'admin', NULL);
*/

CREATE OR REPLACE FUNCTION public._create_app_user(
  p_username text,
  p_password text,
  p_full_name text DEFAULT '',
  p_role text DEFAULT 'teknisi',
  p_department_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, auth
AS $$
DECLARE
  v_username text := lower(btrim(p_username));
  v_email text;
  v_id uuid := gen_random_uuid();
BEGIN
  IF v_username !~ '^[a-z0-9][a-z0-9._-]{1,28}[a-z0-9]$' THEN
    RAISE EXCEPTION 'Username 3-30 karakter: huruf kecil, angka, titik, garis bawah atau strip.';
  END IF;
  IF p_password IS NULL OR length(p_password) < 6 OR p_password !~ '[A-Za-z]' OR p_password !~ '[0-9]' THEN
    RAISE EXCEPTION 'Password minimal 6 karakter dan harus berisi huruf dan angka.';
  END IF;
  IF p_role NOT IN ('admin', 'spv', 'teknisi', 'inventory') THEN
    RAISE EXCEPTION 'Role tidak valid.';
  END IF;

  v_email := v_username || '@wo-sparepart.app';

  IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION 'Username sudah dipakai.';
  END IF;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    v_email, crypt(p_password, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', COALESCE(p_full_name, '')),
    now(), now(),
    '', '', '', ''
  );

  INSERT INTO auth.identities (
    id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_id, v_email,
    jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
    'email', now(), now(), now()
  );

  -- Trigger handle_new_user sudah membuat profile ('teknisi'); tetapkan data sebenarnya.
  UPDATE public.profiles
  SET full_name = COALESCE(p_full_name, ''), role = p_role, department_id = p_department_id
  WHERE id = v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_user(
  p_username text,
  p_password text,
  p_full_name text DEFAULT '',
  p_role text DEFAULT 'teknisi',
  p_department_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Hanya admin yang dapat membuat user.';
  END IF;
  RETURN public._create_app_user(p_username, p_password, p_full_name, p_role, p_department_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_password(p_user_id uuid, p_password text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, auth
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Hanya admin yang dapat mengganti password.';
  END IF;
  IF p_password IS NULL OR length(p_password) < 6 OR p_password !~ '[A-Za-z]' OR p_password !~ '[0-9]' THEN
    RAISE EXCEPTION 'Password minimal 6 karakter dan harus berisi huruf dan angka.';
  END IF;
  UPDATE auth.users
  SET encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now()
  WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User tidak ditemukan.';
  END IF;
END;
$$;

-- Fungsi internal tidak boleh dipanggil lewat API sama sekali.
REVOKE ALL ON FUNCTION public._create_app_user(text, text, text, text, uuid) FROM PUBLIC, anon, authenticated;

-- Fungsi admin hanya untuk user yang sudah login (dan di dalamnya dicek is_admin()).
REVOKE ALL ON FUNCTION public.admin_create_user(text, text, text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_password(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_user(text, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_password(uuid, text) TO authenticated;
