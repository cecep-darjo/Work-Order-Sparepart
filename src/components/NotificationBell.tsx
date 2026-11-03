import { useEffect, useRef, useState } from 'react';
import { Bell, CheckCircle2, ChevronRight, MessageCircle, Smartphone } from 'lucide-react';
import { TONE_CLASSES, type ActionGroup } from '@/lib/actionItems';
import { canUseBrowserNotifications, canUseWebPush, disableWebPush, enableWebPush, requestBrowserNotificationPermission, syncExistingWebPush } from '@/lib/browserNotifications';
import { supabase } from '@/lib/supabase';

/**
 * Lonceng notifikasi: badge = jumlah item yang menunggu aksi user.
 * Klik sebuah grup untuk menuju halaman yang dimaksud.
 */
export default function NotificationBell({
  groups,
  total,
  onSelect,
  onOpenChat,
  profileId,
}: {
  groups: ActionGroup[];
  total: number;
  onSelect: (group: ActionGroup) => void;
  onOpenChat: () => void;
  profileId: string;
}) {
  const [open, setOpen] = useState(false);
  const [pushActive, setPushActive] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    typeof Notification === 'undefined' ? 'default' : Notification.permission,
  );
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [unreadChats, setUnreadChats] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const notificationTotal = total + unreadChats;

  useEffect(() => {
    let cancelled = false;
    void syncExistingWebPush(profileId)
      .then((active) => { if (!cancelled) setPushActive(active); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [profileId]);

  useEffect(() => {
    let active = true;
    const loadUnreadChats = async () => {
      const { data, error } = await supabase.rpc('chat_inbox');
      if (active && !error) {
        setUnreadChats(((data ?? []) as { unread_count?: number | string }[])
          .reduce((sum, conversation) => sum + Number(conversation.unread_count ?? 0), 0));
      }
    };
    void loadUnreadChats();
    const channel = supabase.channel(`chat-bell:${profileId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, () => { void loadUnreadChats(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_reads', filter: `user_id=eq.${profileId}` }, () => { void loadUnreadChats(); })
      .subscribe();
    const refreshTimer = window.setInterval(() => { void loadUnreadChats(); }, 60000);
    return () => {
      active = false;
      window.clearInterval(refreshTimer);
      void supabase.removeChannel(channel);
    };
  }, [profileId]);

  async function enableNotifications() {
    setPermissionError(null);
    setPushBusy(true);
    try {
      const result = await requestBrowserNotificationPermission();
      setPermission(result);
      if (result !== 'granted') {
        setPermissionError(result === 'denied'
          ? 'Izin diblokir. Aktifkan notifikasi EngWO dari pengaturan situs di browser.'
          : 'Browser ini belum mendukung notifikasi.');
        return;
      }
      await enableWebPush(profileId);
      setPushActive(true);
    } catch {
      setPermissionError('Gagal mengaktifkan push. Pastikan migrasi database dan kunci VAPID sudah dikonfigurasi.');
    } finally {
      setPushBusy(false);
    }
  }

  async function turnOffNotifications() {
    setPushBusy(true);
    setPermissionError(null);
    try {
      await disableWebPush(profileId);
      setPushActive(false);
    } catch {
      setPermissionError('Gagal menonaktifkan push notification untuk perangkat ini.');
    } finally {
      setPushBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-2.5 rounded-xl border border-slate-200 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition"
        aria-label={notificationTotal > 0 ? `Notifikasi: ${notificationTotal}, termasuk ${unreadChats} pesan belum dibaca` : 'Notifikasi'}
        aria-expanded={open}
      >
        <Bell className="w-5 h-5" />
        {notificationTotal > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[1.25rem] h-5 px-1 rounded-full bg-red-500 text-white text-[11px] font-bold flex items-center justify-center ring-2 ring-white">
            {notificationTotal > 99 ? '99+' : notificationTotal}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] bg-white rounded-xl border border-slate-200 shadow-xl z-30 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100">
            <p className="text-sm font-semibold text-slate-900">Notifikasi</p>
            <p className="text-xs text-slate-500">{notificationTotal > 0 ? `${notificationTotal} notifikasi belum dibaca atau ditindaklanjuti` : 'Semua sudah beres'}</p>
          </div>

          {unreadChats > 0 && <button type="button" onClick={() => { setOpen(false); onOpenChat(); }} className="flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left hover:bg-blue-50">
            <span className="flex h-8 min-w-8 items-center justify-center rounded-full bg-blue-600 px-2 text-xs font-bold text-white">{unreadChats > 99 ? '99+' : unreadChats}</span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-slate-900">Pesan chat baru</span><span className="block text-xs text-slate-500">Buka percakapan yang belum dibaca</span></span>
            <MessageCircle className="h-4 w-4 text-blue-600" />
          </button>}

          {canUseBrowserNotifications() && canUseWebPush() && (
            <div className="px-4 py-3 border-b border-slate-100">
              <button
                type="button"
                onClick={() => void (pushActive ? turnOffNotifications() : enableNotifications())}
                disabled={pushBusy}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-default disabled:bg-emerald-50 disabled:text-emerald-700"
              >
                <Smartphone className="w-4 h-4" />
                {pushBusy ? 'Memproses...' : pushActive ? 'Matikan push perangkat ini' : 'Aktifkan push notification'}
              </button>
              {permissionError && <p role="status" className="mt-2 text-xs text-red-600">{permissionError}</p>}
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">Push tetap dapat diterima saat aplikasi ditutup. Item baru diperiksa server setiap menit.</p>
            </div>
          )}

          {canUseBrowserNotifications() && !canUseWebPush() && (
            <div className="px-4 py-3 border-b border-slate-100 text-xs leading-relaxed text-amber-700">
              Push saat aplikasi tertutup belum dikonfigurasi. Atur kunci VAPID publik pada build aplikasi.
            </div>
          )}

          {groups.length === 0 && unreadChats === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-slate-400">
              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
              <p className="text-sm">Tidak ada yang perlu ditindaklanjuti.</p>
            </div>
          ) : groups.length > 0 ? (
            <ul className="max-h-96 overflow-y-auto divide-y divide-slate-100">
              {groups.map((g) => (
                <li key={g.key}>
                  <button
                    onClick={() => {
                      setOpen(false);
                      onSelect(g);
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition"
                  >
                    <span
                      className={`min-w-[1.75rem] h-7 px-1.5 rounded-full text-white text-xs font-bold flex items-center justify-center flex-shrink-0 ${TONE_CLASSES[g.tone].badge}`}
                    >
                      {g.count}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-slate-900 truncate">{g.title}</span>
                      <span className="block text-xs text-slate-500 truncate">{g.description}</span>
                    </span>
                    <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}
