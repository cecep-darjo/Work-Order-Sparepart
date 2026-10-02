import { useAuth } from '@/context/AuthContext';
import { Card, Spinner } from '@/components/ui';
import type { PageKey } from '@/components/Layout';
import { useActionItemsContext } from '@/context/ActionItemsContext';
import { TONE_CLASSES, type ActionGroup, type ActionRow } from '@/lib/actionItems';
import { CheckCircle2, ChevronRight, RefreshCw } from 'lucide-react';

const PREVIEW_ROWS = 3;

/**
 * Dashboard hanya menampilkan hal yang MENUNGGU AKSI dari user yang login.
 * - Klik judul/“Lihat semua” -> halaman terkait.
 * - Klik satu baris WO / permintaan part -> langsung ke detail WO-nya.
 */
export default function Dashboard({
  onNavigate,
  onOpenWO,
}: {
  onNavigate: (page: PageKey) => void;
  onOpenWO: (woId: string) => void;
}) {
  const { profile } = useAuth();
  const { groups, total, loading, reload } = useActionItemsContext();

  if (!profile) return null;

  function openGroup(g: ActionGroup) {
    onNavigate(g.page);
  }

  function openRow(g: ActionGroup, row: ActionRow) {
    if (row.woId) onOpenWO(row.woId);
    else onNavigate(g.page);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Perlu Tindakan Anda</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {loading
              ? 'Memuat...'
              : total > 0
                ? `${total} item menunggu aksi dari Anda.`
                : 'Tidak ada yang perlu ditindaklanjuti saat ini.'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => reload()}
            className="p-2.5 rounded-xl border border-slate-200 bg-white text-slate-500 hover:text-slate-900 hover:bg-slate-50 transition"
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        </div>
      </div>

      {loading && groups.length === 0 ? (
        <Spinner />
      ) : groups.length === 0 ? (
        <Card className="p-10 flex flex-col items-center text-center">
          <div className="w-14 h-14 rounded-full bg-emerald-50 flex items-center justify-center mb-3">
            <CheckCircle2 className="w-7 h-7 text-emerald-600" />
          </div>
          <p className="font-semibold text-slate-900">Semua sudah beres</p>
          <p className="text-sm text-slate-500 mt-1">Item baru yang butuh aksi Anda akan muncul di sini dan di lonceng pada header.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {groups.map((g) => (
            <Card key={g.key} className={`overflow-hidden transition-colors ${TONE_CLASSES[g.tone].ring}`}>
              <button
                onClick={() => openGroup(g)}
                className="w-full flex items-center gap-3 p-4 text-left hover:bg-slate-50 transition"
              >
                <span
                  className={`min-w-[2.5rem] h-10 px-2 rounded-xl flex items-center justify-center text-lg font-bold flex-shrink-0 ${TONE_CLASSES[g.tone].icon}`}
                >
                  {g.count}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-slate-900 truncate">{g.title}</span>
                  <span className="block text-xs text-slate-500">{g.description}</span>
                </span>
                <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0" />
              </button>

              <ul className="border-t border-slate-100 divide-y divide-slate-100">
                {g.rows.slice(0, PREVIEW_ROWS).map((row) => (
                  <li key={row.id}>
                    <button
                      onClick={() => openRow(g, row)}
                      className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-slate-50 transition"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-800 truncate">{row.title}</span>
                        {row.subtitle && <span className="block text-xs text-slate-500 truncate">{row.subtitle}</span>}
                      </span>
                      <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>

              {g.count > PREVIEW_ROWS && (
                <button
                  onClick={() => openGroup(g)}
                  className="w-full px-4 py-2.5 text-xs font-medium text-blue-600 hover:bg-slate-50 border-t border-slate-100 text-left"
                >
                  +{g.count - PREVIEW_ROWS} lainnya · Lihat semua →
                </button>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
