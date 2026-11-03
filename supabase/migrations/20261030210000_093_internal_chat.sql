-- Internal direct and department chat with membership enforced by RLS/RPC.
CREATE TABLE IF NOT EXISTS public.chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_type text NOT NULL CHECK (conversation_type IN ('direct','department')),
  department_id uuid REFERENCES public.departments(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((conversation_type = 'department' AND department_id IS NOT NULL) OR (conversation_type = 'direct' AND department_id IS NULL))
);

CREATE TABLE IF NOT EXISTS public.chat_conversation_members (
  conversation_id uuid NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES public.profiles(id),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created ON public.chat_messages(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.chat_reads (
  conversation_id uuid NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_conversations, public.chat_conversation_members, public.chat_messages, public.chat_reads FROM anon, authenticated;
GRANT SELECT ON public.chat_conversations, public.chat_conversation_members, public.chat_messages, public.chat_reads TO authenticated;

CREATE OR REPLACE FUNCTION public.chat_is_department_member(p_department_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active
      AND (p.department_id = p_department_id OR EXISTS (
        SELECT 1 FROM public.profile_departments pd WHERE pd.profile_id = p.id AND pd.department_id = p_department_id
      ))
  );
$$;

CREATE OR REPLACE FUNCTION public.chat_can_access_conversation(p_conversation_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.chat_conversations c
    WHERE c.id = p_conversation_id
      AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active)
      AND ((c.conversation_type = 'department' AND public.chat_is_department_member(c.department_id))
        OR (c.conversation_type = 'direct' AND EXISTS (
          SELECT 1 FROM public.chat_conversation_members m WHERE m.conversation_id = c.id AND m.user_id = auth.uid()
        )))
  );
$$;

CREATE POLICY chat_conversations_read ON public.chat_conversations FOR SELECT TO authenticated
  USING (public.chat_can_access_conversation(id));
CREATE POLICY chat_members_read ON public.chat_conversation_members FOR SELECT TO authenticated
  USING (public.chat_can_access_conversation(conversation_id));
CREATE POLICY chat_messages_read ON public.chat_messages FOR SELECT TO authenticated
  USING (public.chat_can_access_conversation(conversation_id));
CREATE POLICY chat_messages_send ON public.chat_messages FOR INSERT TO authenticated
  WITH CHECK (sender_id = auth.uid() AND public.chat_can_access_conversation(conversation_id));
CREATE POLICY chat_reads_read ON public.chat_reads FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.chat_can_access_conversation(conversation_id));

CREATE OR REPLACE FUNCTION public.chat_open_direct(p_other_user_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_conversation uuid;
  v_low uuid;
  v_high uuid;
BEGIN
  IF v_user IS NULL OR p_other_user_id IS NULL OR p_other_user_id = v_user THEN RAISE EXCEPTION 'Pilih pengguna lain yang valid.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user AND is_active)
    OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_other_user_id AND is_active) THEN
    RAISE EXCEPTION 'Pengguna tidak aktif atau tidak ditemukan.';
  END IF;
  v_low := least(v_user, p_other_user_id); v_high := greatest(v_user, p_other_user_id);
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

CREATE OR REPLACE FUNCTION public.chat_open_department(p_department_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_conversation uuid;
BEGIN
  IF NOT public.chat_is_department_member(p_department_id) THEN RAISE EXCEPTION 'Anda tidak terdaftar pada departemen ini.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('department-chat:' || p_department_id::text, 0));
  SELECT id INTO v_conversation FROM public.chat_conversations WHERE conversation_type = 'department' AND department_id = p_department_id LIMIT 1;
  IF v_conversation IS NULL THEN
    INSERT INTO public.chat_conversations(conversation_type, department_id, created_by)
      VALUES ('department', p_department_id, auth.uid()) RETURNING id INTO v_conversation;
  END IF;
  RETURN v_conversation;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_mark_read(p_conversation_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.chat_can_access_conversation(p_conversation_id) THEN RAISE EXCEPTION 'Percakapan tidak ditemukan.'; END IF;
  INSERT INTO public.chat_reads(conversation_id, user_id, last_read_at)
  VALUES (p_conversation_id, auth.uid(), now())
  ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_send_message(p_conversation_id uuid, p_body text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_message_id uuid;
BEGIN
  IF NOT public.chat_can_access_conversation(p_conversation_id) THEN RAISE EXCEPTION 'Percakapan tidak ditemukan.'; END IF;
  IF length(btrim(coalesce(p_body, ''))) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'Pesan wajib diisi dan maksimal 4000 karakter.'; END IF;
  INSERT INTO public.chat_messages(conversation_id, sender_id, body)
    VALUES (p_conversation_id, auth.uid(), btrim(p_body)) RETURNING id INTO v_message_id;
  RETURN v_message_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.chat_inbox()
RETURNS TABLE(conversation_id uuid, conversation_type text, department_id uuid, department_name text,
  peer_id uuid, peer_name text, last_message text, last_message_at timestamptz, unread_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.conversation_type, c.department_id, d.name, peer.id, peer.full_name,
    latest.body, latest.created_at,
    (SELECT count(*) FROM public.chat_messages unread
      WHERE unread.conversation_id = c.id AND unread.sender_id <> auth.uid()
        AND unread.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz))
  FROM public.chat_conversations c
  LEFT JOIN public.departments d ON d.id = c.department_id
  LEFT JOIN LATERAL (
    SELECT p.id, p.full_name FROM public.chat_conversation_members m JOIN public.profiles p ON p.id = m.user_id
    WHERE m.conversation_id = c.id AND m.user_id <> auth.uid() LIMIT 1
  ) peer ON c.conversation_type = 'direct'
  LEFT JOIN LATERAL (SELECT m.body, m.created_at FROM public.chat_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) latest ON true
  LEFT JOIN public.chat_reads r ON r.conversation_id = c.id AND r.user_id = auth.uid()
  WHERE public.chat_can_access_conversation(c.id)
  ORDER BY latest.created_at DESC NULLS LAST, c.created_at DESC;
$$;

CREATE OR REPLACE FUNCTION public.chat_search_users(p_query text DEFAULT '')
RETURNS TABLE(id uuid, full_name text, role text, department_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.full_name, p.role, p.department_id FROM public.profiles p
  WHERE EXISTS (SELECT 1 FROM public.profiles me WHERE me.id = auth.uid() AND me.is_active)
    AND p.is_active AND p.id <> auth.uid() AND (coalesce(btrim(p_query), '') = '' OR p.full_name ILIKE '%' || btrim(p_query) || '%')
  ORDER BY p.full_name LIMIT 30;
$$;

CREATE OR REPLACE FUNCTION public.chat_my_departments()
RETURNS TABLE(id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT d.id, d.name FROM public.departments d
  WHERE public.chat_is_department_member(d.id) ORDER BY d.name;
$$;

REVOKE ALL ON FUNCTION public.chat_is_department_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_can_access_conversation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_open_direct(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_open_department(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_mark_read(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_send_message(uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_inbox() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_search_users(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_my_departments() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_is_department_member(uuid), public.chat_can_access_conversation(uuid),
  public.chat_open_direct(uuid), public.chat_open_department(uuid), public.chat_mark_read(uuid),
  public.chat_send_message(uuid,text), public.chat_inbox(), public.chat_search_users(text), public.chat_my_departments() TO authenticated;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
