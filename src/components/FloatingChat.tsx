import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { MessageCircle, Plus, Search, Send, Users, X, Minus, ChevronLeft } from 'lucide-react';
import { Badge, Button, Input, Textarea } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { rememberSenders, resolveSender, useChatInbox, useChatMessageEvents, type ChatMessageRow as MessageRow } from '@/lib/chatHub';

type ChatUser = { id: string; full_name: string; role: string };
type ChatDepartment = { id: string; name: string };

const timeLabel = (value: string) => new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));

export default function FloatingChat() {
  const { profile } = useAuth();
  const { inbox, unreadTotal, refresh: refreshInbox, markRead } = useChatInbox(profile?.id);
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [departments, setDepartments] = useState<ChatDepartment[]>([]);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastDepartments, setBroadcastDepartments] = useState<string[]>([]);
  const [broadcastDraft, setBroadcastDraft] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshMessages = useCallback(async (conversationId: string) => {
    await supabase.rpc('chat_mark_read', { p_conversation_id: conversationId });
    const { data, error: messageError } = await supabase.from('chat_messages')
      .select('id,conversation_id,sender_id,body,created_at,sender:profiles!sender_id(full_name)')
      .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(100);
    if (messageError) setError(messageError.message);
    else {
      const rows = ((data ?? []) as unknown as MessageRow[]).reverse();
      rememberSenders(rows);
      setMessages(rows);
    }
    markRead(conversationId);
  }, [markRead]);

  useEffect(() => {
    if (!open) return;
    void supabase.rpc('chat_my_departments').then(({ data }) => setDepartments((data ?? []) as ChatDepartment[]));
  }, [open]);

  useEffect(() => {
    if (open && selected) void refreshMessages(selected);
    if (!selected) setMessages([]);
  }, [open, refreshMessages, selected]);
  useEffect(() => { scrollRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const active = inbox.find((item) => item.conversation_id === selected);
  const list = inbox.filter((item) => `${item.department_name ?? ''} ${item.peer_name ?? ''}`.toLowerCase().includes(query.toLowerCase()));

  // Pesan baru datang lewat channel bersama (payload realtime): cukup ditambahkan ke daftar,
  // tanpa mengunduh ulang 100 pesan. Inbox/badge diperbarui oleh hub.
  useChatMessageEvents(profile?.id, (message) => {
    if (!open || !selected || message.conversation_id !== selected) return;
    if (!message.id) { void refreshMessages(selected); return; }
    const mine = message.sender_id === profile?.id;
    void (async () => {
      const sender = !mine && active?.conversation_type === 'department' ? await resolveSender(message.sender_id) : null;
      setMessages((current) => (current.some((item) => item.id === message.id) ? current : [...current, { ...message, sender }]));
      if (!mine) void supabase.rpc('chat_mark_read', { p_conversation_id: message.conversation_id });
    })();
  });

  async function findUsers() {
    const { data, error: searchError } = await supabase.rpc('chat_search_users', { p_query: query });
    if (searchError) setError(searchError.message); else setUsers((data ?? []) as ChatUser[]);
  }
  async function startConversation(rpc: 'chat_open_direct' | 'chat_open_department', args: Record<string, string>) {
    const { data, error: openError } = await supabase.rpc(rpc, args);
    if (openError) { setError(openError.message); return; }
    setCreating(false); setUsers([]); setQuery(''); setSelected(data as string); await refreshInbox();
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!selected || !draft.trim() || busy) return;
    setBusy(true); setError(null);
    const { error: sendError } = await supabase.rpc('chat_send_message', { p_conversation_id: selected, p_body: draft.trim() });
    setBusy(false);
    if (sendError) setError(sendError.message);
    else { setDraft(''); await refreshMessages(selected); }
  }

  async function sendBroadcast(event: FormEvent) {
    event.preventDefault();
    if (!broadcastDepartments.length || !broadcastDraft.trim() || busy) return;
    setBusy(true); setError(null);
    const { error: sendError } = await supabase.rpc('chat_send_to_departments', {
      p_department_ids: broadcastDepartments,
      p_body: broadcastDraft.trim(),
    });
    setBusy(false);
    if (sendError) setError(sendError.message);
    else {
      setBroadcastDraft(''); setBroadcastDepartments([]); setBroadcasting(false); setCreating(false);
      await refreshInbox();
    }
  }

  if (!profile) return null;
  return <div className="fixed bottom-5 right-5 z-[60] sm:bottom-6 sm:right-6">
    {open && !minimized && <section className="mb-3 flex h-[min(38rem,78vh)] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
      <header className="flex items-center gap-2 bg-blue-600 px-4 py-3 text-white"><MessageCircle className="h-5 w-5" /><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">Chat</h2><p className="text-[11px] text-blue-100">Pesan pribadi dan departemen</p></div>{selected && <button title="Daftar percakapan" onClick={() => setSelected(null)} className="rounded p-1 hover:bg-blue-500"><ChevronLeft className="h-4 w-4" /></button>}{creating && !selected && <button title="Kembali ke percakapan" onClick={() => { setCreating(false); setUsers([]); setQuery(''); }} className="rounded p-1 hover:bg-blue-500"><ChevronLeft className="h-4 w-4" /></button>}<button title="Minimalkan" onClick={() => setMinimized(true)} className="rounded p-1 hover:bg-blue-500"><Minus className="h-4 w-4" /></button><button title="Tutup" onClick={() => setOpen(false)} className="rounded p-1 hover:bg-blue-500"><X className="h-4 w-4" /></button></header>
      {error && <div className="border-b border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}<button className="float-right" onClick={() => setError(null)}>×</button></div>}
      {!selected ? <>
        <div className="flex gap-2 border-b border-slate-100 p-3"><Input aria-label="Cari percakapan atau pengguna" placeholder={creating ? 'Cari pengguna' : 'Cari percakapan'} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && creating) { event.preventDefault(); void findUsers(); } }} /><Button size="sm" variant="secondary" aria-label={creating ? 'Cari pengguna' : 'Chat baru'} onClick={() => creating ? void findUsers() : (setCreating(true), setQuery(''))}>{creating ? <Search className="h-4 w-4" /> : <Plus className="h-4 w-4" />}</Button></div>
        <div className="flex-1 overflow-y-auto">
          {creating ? <>
            <div className="px-3 pt-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Chat pribadi</p></div>
            {users.map((user) => <button key={user.id} onClick={() => void startConversation('chat_open_direct', { p_other_user_id: user.id })} className="flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-left hover:bg-slate-50"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 text-sm font-semibold text-blue-700">{user.full_name.slice(0, 1)}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{user.full_name}</span><span className="block text-xs text-slate-500">{user.role}</span></span></button>)}
            <div className="px-3 pb-2 pt-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Grup departemen</p></div>
            {departments.map((department) => <button key={department.id} onClick={() => void startConversation('chat_open_department', { p_department_id: department.id })} className="flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-left hover:bg-slate-50"><Users className="h-4 w-4 text-blue-600" /><span className="text-sm font-medium">{department.name}</span></button>)}
            {departments.length > 1 && <div className="border-t border-slate-200 p-3"><button type="button" onClick={() => setBroadcasting((value) => !value)} className="text-sm font-semibold text-blue-700 hover:underline">{broadcasting ? 'Tutup kirim ke beberapa departemen' : 'Kirim ke beberapa departemen'}</button>{broadcasting && <form onSubmit={(event) => void sendBroadcast(event)} className="mt-2 space-y-2"><div className="max-h-28 space-y-1 overflow-y-auto">{departments.map((department) => <label key={department.id} className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={broadcastDepartments.includes(department.id)} onChange={(event) => setBroadcastDepartments((ids) => event.target.checked ? [...new Set([...ids, department.id])] : ids.filter((id) => id !== department.id))} />{department.name}</label>)}</div><Textarea rows={2} maxLength={4000} placeholder="Pesan untuk semua departemen terpilih" value={broadcastDraft} onChange={(event) => setBroadcastDraft(event.target.value)} /><Button type="submit" size="sm" disabled={busy || !broadcastDepartments.length || !broadcastDraft.trim()}><Send className="h-3.5 w-3.5" />Kirim ke {broadcastDepartments.length} departemen</Button></form>}</div>}
            {users.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">Cari nama untuk memulai chat pribadi.</p>}
          </> : list.map((item) => { const title = item.conversation_type === 'department' ? item.department_name : item.peer_name; return <button key={item.conversation_id} onClick={() => setSelected(item.conversation_id)} className="flex w-full items-center gap-3 border-b border-slate-100 px-3 py-3 text-left hover:bg-slate-50"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600">{item.conversation_type === 'department' ? <Users className="h-4 w-4" /> : (title ?? '?').slice(0, 1)}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-800">{title ?? 'Chat pribadi'}</span><span className="block truncate text-xs text-slate-500">{item.last_message ?? 'Mulai percakapan'}</span></span>{item.unread_count > 0 && <Badge className="bg-blue-600 text-white">{item.unread_count}</Badge>}</button>; })}
          {!creating && list.length === 0 && <div className="p-8 text-center text-sm text-slate-400">Belum ada percakapan.<button onClick={() => setCreating(true)} className="ml-1 text-blue-600 hover:underline">Mulai chat</button></div>}
        </div>
      </> : <>
        <div className="border-b border-slate-100 px-4 py-2"><p className="truncate text-sm font-semibold text-slate-800">{active?.conversation_type === 'department' ? active.department_name : active?.peer_name ?? 'Percakapan'}</p>{active?.conversation_type === 'department' && <p className="text-[11px] text-slate-500">Grup departemen</p>}</div>
        <div className="flex-1 space-y-2 overflow-y-auto bg-slate-50 p-3">{messages.map((message) => { const mine = message.sender_id === profile.id; return <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[85%] rounded-xl px-3 py-2 ${mine ? 'bg-blue-600 text-white' : 'border border-slate-200 bg-white text-slate-800'}`}>{active?.conversation_type === 'department' && !mine && <p className="mb-1 text-[10px] font-semibold text-blue-700">{message.sender?.full_name ?? 'Pengguna'}</p>}<p className="whitespace-pre-wrap break-words text-sm">{message.body}</p><p className={`mt-1 text-right text-[10px] ${mine ? 'text-blue-100' : 'text-slate-400'}`}>{timeLabel(message.created_at)}</p></div></div>; })}{messages.length === 0 && <p className="py-8 text-center text-xs text-slate-400">Belum ada pesan. Mulai percakapan.</p>}<div ref={scrollRef} /></div>
        <form onSubmit={(event) => void send(event)} className="flex items-end gap-2 border-t border-slate-100 p-2"><Textarea rows={2} maxLength={4000} aria-label="Tulis pesan" placeholder="Tulis pesan..." value={draft} onChange={(event) => setDraft(event.target.value)} /><Button type="submit" size="sm" disabled={busy || !draft.trim()} aria-label="Kirim pesan"><Send className="h-4 w-4" /></Button></form>
      </>}
    </section>}
    {open && minimized && <button onClick={() => setMinimized(false)} className="mb-3 flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-lg ring-1 ring-slate-200"><MessageCircle className="h-4 w-4 text-blue-600" />Chat{unreadTotal > 0 && <Badge className="bg-red-600 text-white">{unreadTotal}</Badge>}</button>}
    {!open && <button onClick={() => { setOpen(true); setMinimized(false); }} aria-label={unreadTotal > 0 ? `Buka chat, ${unreadTotal} pesan belum dibaca` : 'Buka chat'} className="relative flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-white shadow-xl ring-4 ring-white transition hover:scale-105 hover:bg-blue-700"><MessageCircle className="h-6 w-6" />{unreadTotal > 0 && <span className="absolute -right-1 -top-1 flex h-6 min-w-6 items-center justify-center rounded-full bg-red-600 px-1 text-xs font-bold text-white ring-2 ring-white">{unreadTotal > 99 ? '99+' : unreadTotal}</span>}</button>}
  </div>;
}
