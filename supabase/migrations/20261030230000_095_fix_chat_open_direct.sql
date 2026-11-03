-- Correct the parameter reference in the direct chat opener.
CREATE OR REPLACE FUNCTION public.chat_open_direct(p_other_user_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_conversation uuid;
  v_low uuid;
  v_high uuid;
BEGIN
  IF v_user IS NULL OR p_other_user_id IS NULL OR p_other_user_id = v_user THEN
    RAISE EXCEPTION 'Pilih pengguna lain yang valid.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user AND is_active)
    OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_other_user_id AND is_active) THEN
    RAISE EXCEPTION 'Pengguna tidak aktif atau tidak ditemukan.';
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
    INSERT INTO public.chat_conversations(conversation_type, created_by)
      VALUES ('direct', v_user) RETURNING id INTO v_conversation;
    INSERT INTO public.chat_conversation_members(conversation_id, user_id)
      VALUES (v_conversation, v_user), (v_conversation, p_other_user_id);
  END IF;
  RETURN v_conversation;
END;
$$;

REVOKE ALL ON FUNCTION public.chat_open_direct(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_open_direct(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
