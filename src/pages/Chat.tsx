import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { MessageCircle, Plus, Search, Send, Users } from 'lucide-react';
import { Badge, Button, Card, Input, Spinner, Textarea } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';

type InboxRow = {
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
type ChatMessage = { id: string; conversation_id: string; sender_id: string; body: string; created_at: string; sender?: { full_name: string } | null };
type ChatUser = { id: string; full_name: string; role: string; department_id: string | null };
type ChatDepartment = { id: string; name: string };

const formatTime = (value: string | null) => value
  ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
  : '';

export default function Chat() {
  const { profile } = useAuth();
  const [inbox, setInbox] = useState<InboxRow[]>([]);
  const [departments, setDepartments] = useState<ChatDepartment[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [broadcastDepartments, setBroadcastDepartments] = useState<string[]>([]);
  const [broadcastBody, setBroadcastBody] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadInbox = useCallback(async () => {
    const [{ data: inboxData, error: inboxError }, { data: deptData, error: deptError }] = await Promise.all([
      supabase.rpc('chat_inbox'),
      supabase.rpc('chat_my_departments'),
    ]);
    if (inboxError || deptError) setError(inboxError?.message ?? deptError?.message ?? 'Gagal memuat percakapan. Terapkan migrasi chat terlebih dahulu.');
    else {
      setInbox((inboxData ?? []) as InboxRow[]);
      setDepartments((deptData ?? []) as ChatDepartment[]);
    }
    setLoading(false);
  }, []);

  const loadMessages = useCallback(async (conversationId: string) => {
    const { error: markError } = await supabase.rpc('chat_mark_read', { p_conversation_id: conversationId });
    const { data, error: messageError } = await supabase.from('chat_messages')
      .select('id,conversation_id,sender_id,body,created_at,sender:profiles!sender_id(full_name)')
      .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(200);
    if (markError || messageError) setError(markError?.message ?? messageError?.message ?? 'Gagal memuat pesan.');
    else {
      setMessages(((data ?? []) as ChatMessage[]).reverse());
      setInbox((current) => current.map((row) => row.conversation_id === conversationId ? { ...row, unread_count: 0 } : row));
    }
  }, []);

  useEffect(() => { void loadInbox(); }, [loadInbox]);
  useEffect(() => {
    if (!selected) { setMessages([]); return; }
    void loadMessages(selected);
  }, [loadMessages, selected]);
  useEffect(() => {
    if (!profile?.id) return;
    const channel = supabase.channel(`chat:${profile.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (payload) => {
        const row = payload.new as ChatMessage;
        void loadInbox();
        if (row.conversation_id === selected) void loadMessages(row.conversation_id);
      }).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [loadInbox, loadMessages, profile?.id, selected]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const visibleInbox = useMemo(() => inbox.filter((row) => {
    const title = row.conversation_type === 'department' ? row.department_name : row.peer_name;
    return (title ?? '').toLowerCase().includes(search.trim().toLowerCase());
  }), [inbox, search]);

  async function searchUsers() {
    const { data, error: searchError } = await supabase.rpc('chat_search_users', { p_query: userSearch });
    if (searchError) setError(searchError.message); else setUsers((data ?? []) as ChatUser[]);
  }

  async function openDirect(user: ChatUser) {
    const { data, error: openError } = await supabase.rpc('chat_open_direct', { p_other_user_id: user.id });
    if (openError) { setError(openError.message); return; }
    setShowNew(false); setUsers([]); setUserSearch(''); setSelected(data as string); await loadInbox();
  }

  async function openDepartment(department: ChatDepartment) {
    const { data, error: openError } = await supabase.rpc('chat_open_department', { p_department_id: department.id });
    if (openError) { setError(openError.message); return; }
    setShowNew(false); setSelected(data as string); await loadInbox();
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!selected || !profile || !body || sending) return;
    setSending(true); setError(null);
    const { error: sendError } = await supabase.rpc('chat_send_message', { p_conversation_id: selected, p_body: body });
    setSending(false);
    if (sendError) { setError(sendError.message); return; }
    setDraft(''); await Promise.all([loadMessages(selected), loadInbox()]);
  }

  async function sendToDepartments(event: FormEvent) {
    event.preventDefault();
    if (!broadcastDepartments.length || !broadcastBody.trim()) return;
    const { error: sendError } = await supabase.rpc('chat_send_to_departments', {
      p_department_ids: broadcastDepartments,
      p_body: broadcastBody.trim(),
    });
    if (sendError) setError(sendError.message);
    else {
      setBroadcastDepartments([]); setBroadcastBody('');
      await loadInbox();
    }
  }

  if (loading) return <Spinner />;
  const activeRow = inbox.find((row) => row.conversation_id === selected);

  return <div className="mx-auto max-w-7xl space-y-4">
    <div className="flex items-center justify-between"><div><div className="flex items-center gap-2 text-blue-700"><MessageCircle className="h-5 w-5" /><span className="text-sm font-semibold">Komunikasi</span></div><h2 className="mt-1 text-2xl font-bold text-slate-900">Chat</h2><p className="text-sm text-slate-500">Percakapan pribadi dan grup departemen.</p></div><Button onClick={() => { setShowNew((value) => !value); setError(null); }}><Plus className="h-4 w-4" /> Chat baru</Button></div>
    {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}<button className="float-right" onClick={() => setError(null)}>×</button></div>}
    {showNew && <Card className="grid gap-5 p-4 md:grid-cols-2">
      <section className="space-y-3"><h3 className="font-semibold">Chat pribadi</h3><div className="flex gap-2"><Input placeholder="Cari nama pengguna" value={userSearch} onChange={(event) => setUserSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void searchUsers(); } }} /><Button variant="secondary" onClick={() => void searchUsers()}><Search className="h-4 w-4" /> Cari</Button></div><div className="max-h-48 divide-y overflow-y-auto">{users.map((user) => <button key={user.id} onClick={() => void openDirect(user)} className="flex w-full items-center gap-3 p-2 text-left hover:bg-slate-50"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700">{user.full_name.slice(0, 1).toUpperCase()}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{user.full_name}</span><span className="block text-xs text-slate-500">{user.role}</span></span></button>)}</div></section>
      <section className="space-y-3"><h3 className="font-semibold">Grup departemen</h3><p className="text-xs text-slate-500">Anggota grup mengikuti daftar departemen pada profil pengguna.</p><div className="space-y-2">{departments.map((department) => <button key={department.id} onClick={() => void openDepartment(department)} className="flex w-full items-center gap-3 rounded-lg border border-slate-200 p-3 text-left hover:border-blue-300 hover:bg-blue-50"><Users className="h-4 w-4 text-blue-600" /><span className="flex-1 text-sm font-medium">{department.name}</span><MessageCircle className="h-4 w-4 text-slate-400" /></button>)}{departments.length === 0 && <p className="text-sm text-slate-500">Profil Anda belum terhubung dengan departemen.</p>}</div>{departments.length > 1 && <form onSubmit={(event) => void sendToDepartments(event)} className="space-y-2 rounded-lg border border-blue-100 bg-blue-50/50 p-3"><p className="text-sm font-semibold text-slate-800">Kirim ke beberapa departemen</p><div className="max-h-28 space-y-1 overflow-y-auto">{departments.map((department) => <label key={department.id} className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={broadcastDepartments.includes(department.id)} onChange={(event) => setBroadcastDepartments((ids) => event.target.checked ? [...new Set([...ids, department.id])] : ids.filter((id) => id !== department.id))} />{department.name}</label>)}</div><Textarea rows={2} maxLength={4000} placeholder="Pesan untuk departemen terpilih" value={broadcastBody} onChange={(event) => setBroadcastBody(event.target.value)} /><Button type="submit" size="sm" disabled={!broadcastDepartments.length || !broadcastBody.trim()}><Send className="h-4 w-4" />Kirim ke {broadcastDepartments.length} departemen</Button></form>}</section>
    </Card>}
    <div className="grid min-h-[32rem] overflow-hidden rounded-xl border border-slate-200 bg-white md:grid-cols-[19rem_minmax(0,1fr)]">
      <aside className={`border-b border-slate-200 md:border-b-0 md:border-r ${selected ? 'hidden md:block' : ''}`}><div className="border-b border-slate-100 p-3"><Input aria-label="Cari percakapan" placeholder="Cari percakapan" value={search} onChange={(event) => setSearch(event.target.value)} /></div><div className="max-h-[38rem] overflow-y-auto">{visibleInbox.map((row) => { const title = row.conversation_type === 'department' ? row.department_name : row.peer_name; return <button key={row.conversation_id} onClick={() => setSelected(row.conversation_id)} className={`w-full border-b border-slate-100 p-3 text-left hover:bg-slate-50 ${selected === row.conversation_id ? 'bg-blue-50' : ''}`}><div className="flex items-center gap-2"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600">{row.conversation_type === 'department' ? <Users className="h-4 w-4" /> : (title ?? '?').slice(0, 1)}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-800">{title ?? 'Chat pribadi'}</span><span className="block truncate text-xs text-slate-500">{row.last_message ?? (row.conversation_type === 'department' ? 'Grup departemen' : 'Mulai percakapan')}</span></span>{row.unread_count > 0 && <Badge className="bg-blue-600 text-white">{row.unread_count > 99 ? '99+' : row.unread_count}</Badge>}</div><span className="mt-1 block pl-11 text-[10px] text-slate-400">{formatTime(row.last_message_at)}</span></button>; })}{visibleInbox.length === 0 && <p className="p-6 text-center text-sm text-slate-500">Belum ada percakapan. Mulai chat baru.</p>}</div></aside>
      <section className={`flex min-h-[32rem] flex-col ${!selected ? 'hidden md:flex' : ''}`}>
        {activeRow ? <><div className="flex items-center gap-3 border-b border-slate-100 p-4"><button onClick={() => setSelected(null)} className="text-sm text-blue-700 md:hidden">Kembali</button><span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 text-blue-700">{activeRow.conversation_type === 'department' ? <Users className="h-4 w-4" /> : (activeRow.peer_name ?? '?').slice(0, 1)}</span><div><h3 className="font-semibold text-slate-800">{activeRow.conversation_type === 'department' ? activeRow.department_name : activeRow.peer_name}</h3><p className="text-xs text-slate-500">{activeRow.conversation_type === 'department' ? 'Grup departemen' : 'Chat pribadi'}</p></div></div><div className="flex-1 space-y-3 overflow-y-auto bg-slate-50/70 p-4">{messages.map((message) => { const mine = message.sender_id === profile?.id; return <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[85%] rounded-2xl px-3 py-2 shadow-sm ${mine ? 'rounded-br-sm bg-blue-600 text-white' : 'rounded-bl-sm border border-slate-200 bg-white text-slate-800'}`}>{activeRow.conversation_type === 'department' && !mine && <p className="mb-1 text-[11px] font-semibold text-blue-700">{message.sender?.full_name ?? 'Pengguna'}</p>}<p className="whitespace-pre-wrap break-words text-sm">{message.body}</p><p className={`mt-1 text-right text-[10px] ${mine ? 'text-blue-100' : 'text-slate-400'}`}>{formatTime(message.created_at)}</p></div></div>; })}{messages.length === 0 && <p className="py-10 text-center text-sm text-slate-400">Kirim pesan pertama.</p>}<div ref={bottomRef} /></div><form onSubmit={(event) => void sendMessage(event)} className="flex items-end gap-2 border-t border-slate-100 p-3"><Textarea rows={2} maxLength={4000} aria-label="Tulis pesan" placeholder="Tulis pesan..." value={draft} onChange={(event) => setDraft(event.target.value)} /><Button type="submit" disabled={sending || !draft.trim()} aria-label="Kirim pesan"><Send className="h-4 w-4" />Kirim</Button></form></> : <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-slate-400"><MessageCircle className="h-10 w-10" /><p className="text-sm">Pilih percakapan atau mulai chat baru.</p></div>}
      </section>
    </div>
  </div>;
}
