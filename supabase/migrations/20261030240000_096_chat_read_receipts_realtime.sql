-- Broadcast per-user read receipt changes so the global bell clears unread counts immediately.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_reads') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_reads;
  END IF;
END $$;
