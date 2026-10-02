import { useEffect, useRef, useState } from 'react';
import { Bell, CheckCircle2, ChevronRight } from 'lucide-react';
import { TONE_CLASSES, type ActionGroup } from '@/lib/actionItems';

/**
 * Lonceng notifikasi: badge = jumlah item yang menunggu aksi user.
 * Klik sebuah grup untuk menuju halaman yang dimaksud.
 */
export default function NotificationBell({
  groups,
  total,
  onSelect,
}: {
  groups: ActionGroup[];
  total: number;
  onSelect: (group: ActionGroup) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
        aria-label={total > 0 ? `Notifikasi: ${total} menunggu aksi` : 'Notifikasi'}
        aria-expanded={open}
      >
        <Bell className="w-5 h-5" />
        {total > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[1.25rem] h-5 px-1 rounded-full bg-red-500 text-white text-[11px] font-bold flex items-center justify-center ring-2 ring-white">
            {total > 99 ? '99+' : total}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] bg-white rounded-xl border border-slate-200 shadow-xl z-30 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100">
            <p className="text-sm font-semibold text-slate-900">Menunggu aksi Anda</p>
            <p className="text-xs text-slate-500">{total > 0 ? `${total} item perlu ditindaklanjuti` : 'Semua sudah beres'}</p>
          </div>

          {groups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-slate-400">
              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
              <p className="text-sm">Tidak ada yang perlu ditindaklanjuti.</p>
            </div>
          ) : (
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
          )}
        </div>
      )}
    </div>
  );
}
