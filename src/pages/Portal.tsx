import { useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import type { PageKey } from '@/components/Layout';
import {
  ClipboardList, HardHat, Settings, ClipboardCheck, Package, Boxes, FileText,
  CircleAlert, ShoppingCart, ArrowUpRight, Search, Wrench,
  CalendarDays,
} from 'lucide-react';

type PortalLink = { key: PageKey; label: string; description: string; icon: typeof ClipboardList; roles: string[] };
const WORK_ORDER: PortalLink[] = [
  { key: 'workorders', label: 'Work Order', description: 'Kelola preventive maintenance dan permintaan pekerjaan', icon: ClipboardList, roles: ['admin', 'ss', 'spv', 'teknisi'] },
  { key: 'job_assignments', label: 'Jobs Assignment', description: 'Atur pekerjaan dan penugasan teknisi', icon: HardHat, roles: ['admin', 'ss', 'spv', 'teknisi'] },
  { key: 'preventive_maintenance', label: 'Preventive Maintenance', description: 'Kalender PM, jadwal mesin, dan beban carry-over', icon: CalendarDays, roles: ['admin', 'ss', 'spv', 'teknisi'] },
  { key: 'master_wo', label: 'Master Data WO', description: 'Kelola data referensi Work Order', icon: Settings, roles: ['admin', 'ss', 'spv'] },
];
const INVENTORY: PortalLink[] = [
  { key: 'bons', label: 'Bon Sparepart', description: 'Permintaan dan pengeluaran sparepart', icon: ClipboardCheck, roles: ['admin', 'ss', 'spv', 'teknisi', 'inventory'] },
  { key: 'spareparts', label: 'Spareparts', description: 'Lihat dan kelola katalog sparepart', icon: Package, roles: ['admin', 'ss', 'inventory'] },
  { key: 'transactions', label: 'Inventory Transactions', description: 'Riwayat pergerakan stok', icon: Boxes, roles: ['admin', 'inventory'] },
  { key: 'goods_receipts', label: 'Daftar GR', description: 'Penerimaan barang dan dokumen GR', icon: FileText, roles: ['admin', 'inventory'] },
  { key: 'inventory', label: 'Low Stock Alert', description: 'Pantau sparepart dengan stok rendah', icon: CircleAlert, roles: ['admin', 'inventory'] },
  { key: 'purchase_requirements', label: 'Purchase Requirement', description: 'Daftar kebutuhan pembelian sparepart', icon: ShoppingCart, roles: ['admin', 'ss', 'inventory'] },
  { key: 'pr_list', label: 'Daftar PR', description: 'Lihat, edit, dan kelola penomoran SAP serta PR', icon: FileText, roles: ['admin', 'ss', 'inventory'] },
  { key: 'master_inventory', label: 'Master Inventory', description: 'Kelola data referensi inventori', icon: Settings, roles: ['admin', 'ss', 'inventory'] },
];

export default function Portal({ onNavigate }: { onNavigate: (page: PageKey) => void }) {
  const { profile } = useAuth();
  const [search, setSearch] = useState('');
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('id');
    const canSee = (link: PortalLink) => !!profile && link.roles.includes(profile.role);
    const matches = (link: PortalLink) => !query || `${link.label} ${link.description}`.toLocaleLowerCase('id').includes(query);
    return { work: WORK_ORDER.filter((link) => canSee(link) && matches(link)), inventory: INVENTORY.filter((link) => canSee(link) && matches(link)) };
  }, [profile, search]);

  const renderGroup = (title: string, subtitle: string, links: PortalLink[], style: 'cyan' | 'orange') => {
    const colors = style === 'cyan'
      ? { panel: 'from-cyan-500 to-emerald-400', icon: 'bg-white/20', accent: 'text-cyan-700', ring: 'hover:ring-cyan-300' }
      : { panel: 'from-orange-500 to-amber-400', icon: 'bg-white/20', accent: 'text-orange-700', ring: 'hover:ring-orange-300' };
    return <section className="overflow-hidden rounded-2xl bg-white shadow-xl shadow-slate-950/10 ring-1 ring-white/10">
      <div className={`bg-gradient-to-r ${colors.panel} p-5 text-white sm:p-6`}>
        <div className="flex items-center gap-3">
          <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${colors.icon}`}><Wrench className="h-6 w-6" /></div>
          <div className="min-w-0 flex-1"><h2 className="text-xl font-bold">{title}</h2><p className="mt-0.5 text-sm text-white/85">{subtitle}</p></div>
          <span className="rounded-full bg-white/20 px-3 py-1 text-xs font-semibold">{links.length} aplikasi</span>
        </div>
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
        {links.map((link) => { const Icon = link.icon; return <button key={link.key} onClick={() => onNavigate(link.key)} className={`group flex min-h-[92px] items-center gap-3 rounded-xl border border-slate-200 p-3.5 text-left transition hover:-translate-y-0.5 hover:shadow-md ${colors.ring}`}>
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 ${colors.accent}`}><Icon className="h-5 w-5" /></span>
          <span className="min-w-0 flex-1"><span className="block font-semibold text-slate-800">{link.label}</span><span className="mt-0.5 block text-xs leading-relaxed text-slate-500">{link.description}</span></span>
          <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-slate-600" />
        </button>; })}
        {links.length === 0 && <p className="col-span-full py-6 text-center text-sm text-slate-500">Tidak ada aplikasi yang cocok dengan pencarian.</p>}
      </div>
    </section>;
  };

  return <div className="-m-4 min-h-[calc(100vh-4rem)] bg-[#101827] px-4 py-7 sm:-m-6 sm:px-8 sm:py-9">
    <div className="mx-auto max-w-6xl">
      <div className="mb-7 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div><div className="mb-3 inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800/70 px-3 py-1.5 text-xs font-medium text-cyan-300"><Wrench className="h-3.5 w-3.5" /> Engineering Workspace</div>
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Engineering Application Portal</h1>
          <p className="mt-2 text-sm text-slate-400 sm:text-base">Pilih aplikasi untuk mengelola Work Order dan Inventory.</p>
        </div>
        <label className="flex h-11 w-full items-center gap-2.5 rounded-xl border border-slate-700 bg-slate-800/80 px-3.5 text-slate-400 focus-within:border-cyan-500 sm:max-w-xs"><Search className="h-4 w-4 shrink-0" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari aplikasi..." className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-500" /></label>
      </div>
      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        {renderGroup('Preventive Maintenance and Work Order', 'Kelola preventive maintenance, pekerjaan, dan penugasan engineering', visible.work, 'cyan')}
        {renderGroup('Inventory', 'Kelola sparepart, stok, dan pengadaan', visible.inventory, 'orange')}
      </div>
      <div className="mt-6 flex justify-end"><button onClick={() => onNavigate('dashboard')} className="text-xs font-medium text-slate-400 hover:text-white">Buka Dashboard operasional →</button></div>
    </div>
  </div>;
}
