/*
# Auto-profile trigger + default departments + WO number sequence

## Changes
1. Creates a `handle_new_user` function that auto-inserts a profile row when a new auth.user is created.
2. Attaches it as a trigger on auth.users.
3. Seeds default departments: MTC, UTL, Otomasi, HVAC.
4. Creates a sequence for WO number generation.
*/

-- ============ AUTO PROFILE ON SIGNUP ============
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
    COALESCE(NEW.raw_user_meta_data->>'role', 'teknisi')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ DEFAULT DEPARTMENTS ============
INSERT INTO departments (name, code) VALUES
  ('MTC', 'MTC'),
  ('UTL', 'UTL'),
  ('Otomasi', 'OTM'),
  ('HVAC', 'HVC')
ON CONFLICT (code) DO NOTHING;

-- ============ WO NUMBER SEQUENCE ============
CREATE SEQUENCE IF NOT EXISTS wo_number_seq START 1;
