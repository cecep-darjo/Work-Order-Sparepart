-- Scope direct recipients to shared departments; admins may contact every active role.
CREATE OR REPLACE FUNCTION public.chat_can_direct_message(p_other_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles me
    WHERE me.id = auth.uid() AND me.is_active
      AND (me.role = 'admin' OR EXISTS (
        SELECT 1 FROM public.profiles other_profile, public.departments d
        WHERE other_profile.id = p_other_user_id
          AND (me.department_id = d.id OR EXISTS (
            SELECT 1 FROM public.profile_departments mypd WHERE mypd.profile_id = me.id AND mypd.department_id = d.id
          ))
          AND (other_profile.department_id = d.id OR EXISTS (
            SELECT 1 FROM public.profile_departments otherpd WHERE otherpd.profile_id = other_profile.id AND otherpd.department_id = d.id
          ))
      ))
  ) AND EXISTS (SELECT 1 FROM public.profiles other WHERE other.id = p_other_user_id AND other.is_active AND other.id <> auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.chat_search_users(p_query text DEFAULT '')
RETURNS TABLE(id uuid, full_name text, role text, department_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.full_name, p.role, p.department_id
  FROM public.profiles p
  WHERE p.is_active AND p.id <> auth.uid()
    AND (coalesce(btrim(p_query), '') = '' OR p.full_name ILIKE '%' || btrim(p_query) || '%')
    AND public.chat_can_direct_message(p.id)
  ORDER BY p.full_name LIMIT 30;
$$;

CREATE OR REPLACE FUNCTION public.chat_open_direct(p_other_user_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_conversation uuid;
  v_low uuid;
  v_high uuid;
BEGIN
  IF v_user IS NULL OR p_other_user_id IS NULL OR p_other_user_id = v_user
    OR NOT public.chat_can_direct_message(p_other_user_id) THEN
    RAISE EXCEPTION 'Penerima tidak ditemukan atau berada di luar cakupan departemen Anda.';
  END IF;
  v_low := least(v_user, p_other_user_id);
  v_high := greatest(v_user, p_other_user_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_low::text || ':' || v_high::text, 0));
  SELECT c.id INTO v_conversation
  FROM public.chat_conversations c
  WHERE c.conversation_type = 'direct'
    AND EXISTS (SELECT 1 FROM public.chat_conversation_members m WHERE m.conversation_id = c.id AND m.user_id = v_low)
    AND EXISTS (SELECT 1 FROM public.chat_conversation_members m WHERE m.conversation_id = c.id AND m.user_id = v_high)
    AND (SELECT count(*) FROM public.chat_conversation_members m WHERE m.conversation_id = c.id) = 2
  LIMIT 1;
  IF v_conversation IS NULL THEN
    INSERT INTO public.chat_conversations(conversation_type, created_by) VALUES ('direct', v_user) RETURNING id INTO v_conversation;
    INSERT INTO public.chat_conversation_members(conversation_id, user_id) VALUES (v_conversation, v_user), (v_conversation, p_other_user_id);
  END IF;
  RETURN v_conversation;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_send_to_departments(p_department_ids uuid[], p_body text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_department_id uuid;
  v_conversation_id uuid;
  v_sent integer := 0;
BEGIN
  IF auth.uid() IS NULL OR p_department_ids IS NULL OR cardinality(p_department_ids) = 0 OR cardinality(p_department_ids) > 30 THEN
    RAISE EXCEPTION 'Pilih 1 sampai 30 departemen.';
  END IF;
  IF length(btrim(coalesce(p_body, ''))) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'Pesan wajib diisi dan maksimal 4000 karakter.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_department_ids) requested(id)
    WHERE NOT public.chat_is_department_member(requested.id)
  ) THEN RAISE EXCEPTION 'Ada departemen yang berada di luar cakupan Anda.'; END IF;

  FOR v_department_id IN SELECT DISTINCT id FROM unnest(p_department_ids) requested(id) ORDER BY id LOOP
    v_conversation_id := public.chat_open_department(v_department_id);
    INSERT INTO public.chat_messages(conversation_id, sender_id, body)
      VALUES (v_conversation_id, auth.uid(), btrim(p_body));
    v_sent := v_sent + 1;
  END LOOP;
  RETURN v_sent;
END;
$$;

REVOKE ALL ON FUNCTION public.chat_can_direct_message(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_search_users(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_open_direct(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_send_to_departments(uuid[],text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_search_users(text), public.chat_open_direct(uuid), public.chat_send_to_departments(uuid[],text) TO authenticated;
NOTIFY pgrst, 'reload schema';
