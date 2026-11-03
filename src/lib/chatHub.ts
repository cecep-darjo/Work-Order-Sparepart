import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

/**
 * Hub chat bersama: SATU channel realtime + SATU sumber data inbox untuk seluruh aplikasi.
 *
 * Sebelumnya NotificationBell, FloatingChat, dan halaman Chat masing-masing membuat channel sendiri
 * (tanpa filter pada chat_messages), lalu setiap pesan baru memicu 3x RPC chat_inbox dan memuat ulang
 * 100–200 pesan. Sekarang:
 *  - satu channel (dihitung per referensi, ditutup bila tidak ada pemakai),
 *  - event berdekatan digabung (coalesce) menjadi satu RPC chat_inbox,
 *  - pesan baru dikirim ke pendengar lewat payload realtime, jadi daftar pesan tidak perlu diunduh ulang,
 *  - polling 60 dtk diganti: refresh saat tab aktif kembali, saat channel tersambung ulang, dan jaring
 *    pengaman 5 menit (hanya saat tab terlihat).
 */

export type ChatInboxRow = {
  conversation_id: string;
  conversation_type: 'direct' | 'department';
  department_id: string | null;
  department_name: string | null;
  peer_id: string | null;
  peer_name: string | null;
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
};

export type ChatMessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  sender?: { full_name: string } | null;
};

type InboxState = { rows: ChatInboxRow[] | null; error: string | null };

const COALESCE_MS = 400;
const SAFETY_POLL_MS = 5 * 60_000;
const CLOSE_GRACE_MS = 1_500;

type Hub = {
  profileId: string;
  channel: RealtimeChannel;
  refs: number;
  state: InboxState;
  stateListeners: Set<(state: InboxState) => void>;
  messageListeners: Set<(message: ChatMessageRow) => void>;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  closeTimer: ReturnType<typeof setTimeout> | null;
  poll: ReturnType<typeof setInterval>;
  onVisible: () => void;
  inflight: Promise<void> | null;
  again: boolean;
};

let hub: Hub | null = null;

function publish(h: Hub, state: InboxState) {
  h.state = state;
  h.stateListeners.forEach((listener) => listener(state));
}

function refreshNow(h: Hub): Promise<void> {
  if (h.inflight) {
    h.again = true; // ada permintaan baru saat RPC berjalan: ulangi sekali setelah selesai
    return h.inflight;
  }
  h.inflight = (async () => {
    try {
      const { data, error } = await supabase.rpc('chat_inbox');
      if (hub !== h) return;
      if (error) publish(h, { rows: h.state.rows, error: error.message });
      else publish(h, { rows: (data ?? []) as ChatInboxRow[], error: null });
    } finally {
      h.inflight = null;
      if (h.again) {
        h.again = false;
        void refreshNow(h);
      }
    }
  })();
  return h.inflight;
}

function scheduleRefresh(h: Hub) {
  if (h.refreshTimer) return;
  h.refreshTimer = setTimeout(() => {
    h.refreshTimer = null;
    void refreshNow(h);
  }, COALESCE_MS);
}

function createHub(profileId: string): Hub {
  const h = {
    profileId,
    refs: 0,
    state: { rows: null, error: null },
    stateListeners: new Set(),
    messageListeners: new Set(),
    refreshTimer: null,
    closeTimer: null,
    inflight: null,
    again: false,
  } as unknown as Hub;

  let firstSubscribe = true;
  h.channel = supabase
    .channel(`chat-hub:${profileId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (payload) => {
      const row = payload.new as ChatMessageRow;
      h.messageListeners.forEach((listener) => listener(row));
      scheduleRefresh(h);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_reads', filter: `user_id=eq.${profileId}` }, () => {
      scheduleRefresh(h);
    })
    .subscribe((status) => {
      // Sambung ulang setelah putus = mungkin ada event terlewat. Subscribe pertama sudah ditangani pemuatan awal.
      if (status === 'SUBSCRIBED') {
        if (firstSubscribe) firstSubscribe = false;
        else scheduleRefresh(h);
      }
    });

  h.onVisible = () => {
    if (document.visibilityState === 'visible') scheduleRefresh(h);
  };
  document.addEventListener('visibilitychange', h.onVisible);
  h.poll = setInterval(() => {
    if (document.visibilityState === 'visible') scheduleRefresh(h);
  }, SAFETY_POLL_MS);
  return h;
}

function teardown(h: Hub) {
  if (h.refreshTimer) clearTimeout(h.refreshTimer);
  if (h.closeTimer) clearTimeout(h.closeTimer);
  clearInterval(h.poll);
  document.removeEventListener('visibilitychange', h.onVisible);
  void supabase.removeChannel(h.channel);
  if (hub === h) hub = null;
}

function acquire(profileId: string): Hub {
  if (hub && hub.profileId !== profileId) teardown(hub);
  if (!hub) hub = createHub(profileId);
  if (hub.closeTimer) {
    clearTimeout(hub.closeTimer);
    hub.closeTimer = null;
  }
  hub.refs += 1;
  return hub;
}

function release(h: Hub) {
  h.refs -= 1;
  if (h.refs > 0 || hub !== h) return;
  h.closeTimer = setTimeout(() => {
    if (h.refs <= 0) teardown(h);
  }, CLOSE_GRACE_MS);
}

/** Inbox percakapan (dibagi bersama) + jumlah pesan belum dibaca. */
export function useChatInbox(profileId: string | undefined) {
  const [state, setState] = useState<InboxState>(() =>
    hub && hub.profileId === profileId ? hub.state : { rows: null, error: null },
  );

  useEffect(() => {
    if (!profileId) return;
    const h = acquire(profileId);
    h.stateListeners.add(setState);
    if (h.state.rows) setState(h.state);
    else void refreshNow(h);
    return () => {
      h.stateListeners.delete(setState);
      release(h);
    };
  }, [profileId]);

  const refresh = useCallback(() => (hub ? refreshNow(hub) : Promise.resolve()), []);

  /** Nolkan badge percakapan secara lokal setelah chat_mark_read (event chat_reads menyusul dari server). */
  const markRead = useCallback((conversationId: string) => {
    if (!hub || !hub.state.rows) return;
    publish(hub, {
      ...hub.state,
      rows: hub.state.rows.map((row) => (row.conversation_id === conversationId ? { ...row, unread_count: 0 } : row)),
    });
  }, []);

  const inbox = useMemo(() => state.rows ?? [], [state.rows]);
  const unreadTotal = useMemo(() => inbox.reduce((sum, row) => sum + Number(row.unread_count ?? 0), 0), [inbox]);
  return { inbox, loaded: state.rows !== null || state.error !== null, error: state.error, unreadTotal, refresh, markRead };
}

/** Terima pesan baru lewat channel bersama. Handler selalu versi render terbaru (tanpa subscribe ulang). */
export function useChatMessageEvents(profileId: string | undefined, handler: (message: ChatMessageRow) => void) {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    if (!profileId) return;
    const h = acquire(profileId);
    const listener = (message: ChatMessageRow) => handlerRef.current(message);
    h.messageListeners.add(listener);
    return () => {
      h.messageListeners.delete(listener);
      release(h);
    };
  }, [profileId]);
}

/* ---- Nama pengirim: payload realtime tidak membawa join profiles ---------------------------------- */

const senderNames = new Map<string, string>();
const senderLookups = new Map<string, Promise<string | null>>();

export function rememberSenders(rows: ChatMessageRow[]) {
  for (const row of rows) if (row.sender?.full_name) senderNames.set(row.sender_id, row.sender.full_name);
}

export async function resolveSender(senderId: string): Promise<{ full_name: string } | null> {
  const cached = senderNames.get(senderId);
  if (cached) return { full_name: cached };
  let lookup = senderLookups.get(senderId);
  if (!lookup) {
    lookup = (async () => {
      const { data } = await supabase.from('profiles').select('full_name').eq('id', senderId).maybeSingle();
      const name = (data as { full_name?: string } | null)?.full_name ?? null;
      if (name) senderNames.set(senderId, name);
      return name;
    })().finally(() => senderLookups.delete(senderId));
    senderLookups.set(senderId, lookup);
  }
  const name = await lookup;
  return name ? { full_name: name } : null;
}
