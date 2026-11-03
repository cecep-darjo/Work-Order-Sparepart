import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Card, Spinner } from '@/components/ui';
import type { PageKey } from '@/components/Layout';
import { useActionItemsContext } from '@/context/ActionItemsContext';
import { TONE_CLASSES, type ActionGroup, type ActionRow } from '@/lib/actionItems';
import { CheckCircle2, ChevronRight, RefreshCw } from 'lucide-react';

const PREVIEW_ROWS = 3;
const PIE_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0f9d78'];

type MachineMetric = { key: string; name: string; jobs: number; durationMs: number };
type TechnicianMetric = { id: string; name: string; jobs: number; durationMs: number; color: string };
type PersonRow = { id: string; full_name: string };
type AvailableTechnician = { id: string; full_name: string };
type TechnicianLink = { technician_id: string; technician: PersonRow | null };
type JobRow = {
  id: string; status: string; work_category: string; equipment_id: string | null; manual_equipment: string | null;
  technician_id: string | null; started_at: string | null; done_at: string | null;
  on_the_way_at: string | null; created_at: string; updated_at: string;
  technician: PersonRow | null; assigned_technicians: TechnicianLink[] | null;
  equipment: { id: string; name: string } | null;
};
type WorkOrderRow = {
  id: string; status: string; work_types: string[] | null; equipment_id: string | null; job_assignment_id: string | null; technician_id: string | null;
  created_at: string; closed_at: string | null; equipment: { id: string; name: string } | null;
  technicians: TechnicianLink[] | null;
};
type WoHistoryRow = {
  work_order_id: string; status: string; performed_at: string; job_assignment_history_id: string | null;
};
type JaHistoryRow = { job_id: string; status: string; performed_at: string };

function activeDuration(events: { status: string; performed_at: string }[], activeStatuses: string[], periodStart: number): number {
  const ordered = [...events].sort((a, b) => a.performed_at.localeCompare(b.performed_at));
  let previousStatus: string | null = null;
  let activeSince: number | null = null;
  let total = 0;
  const now = Date.now();
  for (const event of ordered) {
    if (event.status === previousStatus) continue;
    const at = new Date(event.performed_at).getTime();
    if (!Number.isFinite(at)) continue;
    if (activeSince !== null) {
      total += Math.max(0, Math.min(at, now) - Math.max(activeSince, periodStart));
      activeSince = null;
    }
    if (activeStatuses.includes(event.status)) activeSince = at;
    previousStatus = event.status;
  }
  if (activeSince !== null) total += Math.max(0, now - Math.max(activeSince, periodStart));
  return total;
}

function jakartaDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value),
    month: Number(parts.find((part) => part.type === 'month')?.value),
  };
}

function jakartaPeriodStart(kind: 'month' | 'year', now = new Date()): number {
  const { year, month } = jakartaDateParts(now);
  // Jakarta menggunakan UTC+7.
  return Date.UTC(year, kind === 'year' ? 0 : month - 1, 1) - 7 * 60 * 60 * 1000;
}

function nextJakartaPeriodStart(kind: 'month' | 'year'): number {
  const { year, month } = jakartaDateParts();
  return Date.UTC(year, kind === 'year' ? 12 : month, 1) - 7 * 60 * 60 * 1000;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days} hari ${hours} jam`;
  if (hours) return `${hours} jam ${minutes} mnt`;
  return `${minutes} mnt`;
}

function pieSlicePath(index: number, values: number[], total: number): string {
  const start = values.slice(0, index).reduce((sum, value) => sum + value, 0) / total * 2 * Math.PI - Math.PI / 2;
  const end = start + values[index] / total * 2 * Math.PI;
  const x1 = 50 + 45 * Math.cos(start);
  const y1 = 50 + 45 * Math.sin(start);
  const x2 = 50 + 45 * Math.cos(end);
  const y2 = 50 + 45 * Math.sin(end);
  const largeArc = end - start > Math.PI ? 1 : 0;
  if (values[index] === total) return 'M 50 50 m 0 -45 a 45 45 0 1 1 0 90 a 45 45 0 1 1 0 -90';
  return `M 50 50 L ${x1} ${y1} A 45 45 0 ${largeArc} 1 ${x2} ${y2} Z`;
}

function DashboardPie({ rows }: { rows: TechnicianMetric[] }) {
  const values = rows.map((row) => row.durationMs);
  const total = values.reduce((sum, value) => sum + value, 0);
  const chartValues = total > 0 ? values : rows.map((row) => row.jobs);
  const chartTotal = chartValues.reduce((sum, value) => sum + value, 0);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[minmax(9rem,0.7fr)_1.3fr] items-center gap-5">
      <svg viewBox="0 0 100 100" role="img" aria-label="Pie chart akumulasi waktu teknisi" className="w-36 h-36 mx-auto">
        {chartValues.map((value, index) => (
          <path key={rows[index].id} d={pieSlicePath(index, chartValues, chartTotal)} fill={rows[index].color} stroke="white" strokeWidth="1">
            <title>{rows[index].name}: {rows[index].jobs} tugas, {formatDuration(rows[index].durationMs)}</title>
          </path>
        ))}
      </svg>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id} className="flex items-start gap-2 text-sm">
            <span className="mt-1.5 w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: row.color }} />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-slate-800 truncate">{row.name}</span>
              <span className="block text-xs text-slate-500">{row.jobs} tugas · {formatDuration(row.durationMs)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  const [machineMetrics, setMachineMetrics] = useState<MachineMetric[]>([]);
  const [technicianMetrics, setTechnicianMetrics] = useState<TechnicianMetric[]>([]);
  const [availableTechnicians, setAvailableTechnicians] = useState<AvailableTechnician[]>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const canViewTechnicianChart = !!profile && ['admin', 'ss', 'spv'].includes(profile.role);
  const [periodNow, setPeriodNow] = useState(() => Date.now());
  const monthLabel = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', month: 'long', year: 'numeric' }).format(periodNow);
  const yearLabel = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', year: 'numeric' }).format(periodNow);

  const loadAnalytics = useCallback(async () => {
    if (!profile) return;
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    try {
      // Metrik hanya menghitung durasi sejak awal tahun ini (activeDuration(..., yearStart)), jadi WO/job
      // yang sudah selesai SEBELUM awal tahun tidak perlu diunduh beserta seluruh riwayatnya.
      const yearStart = jakartaPeriodStart('year');
      const monthStart = jakartaPeriodStart('month');
      const yearStartIso = new Date(yearStart).toISOString();
      const [woResult, jobResult, technicianResult] = await Promise.all([
        supabase.from('work_orders').select('id,status,work_types,equipment_id,job_assignment_id,technician_id,created_at,closed_at,equipment:equipment(id,name),technicians:work_order_technicians(technician_id,technician:profiles!technician_id(id,full_name))')
          .or(`closed_at.is.null,closed_at.gte.${yearStartIso}`),
        supabase.from('job_assignments').select('id,status,work_category,equipment_id,manual_equipment,technician_id,started_at,done_at,on_the_way_at,created_at,updated_at,technician:profiles!technician_id(id,full_name),assigned_technicians:job_assignment_technicians(technician_id,technician:profiles!technician_id(id,full_name)),equipment:equipment(id,name)')
          .or(`done_at.is.null,done_at.gte.${yearStartIso}`),
        canViewTechnicianChart
          ? supabase.from('profiles').select('id,full_name').eq('role', 'teknisi').eq('is_active', true).order('full_name')
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (woResult.error) throw woResult.error;
      if (jobResult.error) throw jobResult.error;
      if (technicianResult.error) throw technicianResult.error;
      const workOrders = (woResult.data ?? []) as unknown as WorkOrderRow[];
      const jobs = (jobResult.data ?? []) as unknown as JobRow[];
      const busyTechnicianIds = new Set<string>();
      const activeJaStatuses = new Set(['assigned', 'on_the_way', 'in_progress', 'pending']);
      const activeWoStatuses = new Set(['new', 'assigned', 'analysis', 'on_progress', 'pending']);
      for (const job of jobs) {
        if (!activeJaStatuses.has(job.status)) continue;
        for (const member of job.assigned_technicians ?? []) busyTechnicianIds.add(member.technician_id);
        if (job.technician_id) busyTechnicianIds.add(job.technician_id);
      }
      for (const wo of workOrders) {
        if (!activeWoStatuses.has(wo.status)) continue;
        for (const member of wo.technicians ?? []) busyTechnicianIds.add(member.technician_id);
        if (wo.technician_id) busyTechnicianIds.add(wo.technician_id);
      }
      setAvailableTechnicians(((technicianResult.data ?? []) as AvailableTechnician[])
        .filter((technician) => !busyTechnicianIds.has(technician.id)));
      const jobsById = new Map(jobs.map((job) => [job.id, job]));
      const linkedJobIds = new Set(workOrders.map((wo) => wo.job_assignment_id).filter((id): id is string => !!id));
      const historyByWo = new Map<string, WoHistoryRow[]>();
      if (workOrders.length) {
        const { data: histories, error } = await supabase.from('work_order_history')
          .select('work_order_id,status,performed_at,job_assignment_history_id')
          .in('work_order_id', workOrders.map((wo) => wo.id));
        if (error) throw error;
        for (const row of (histories ?? []) as WoHistoryRow[]) {
          const rows = historyByWo.get(row.work_order_id) ?? [];
          rows.push(row);
          historyByWo.set(row.work_order_id, rows);
        }
      }
      const jaHistoryByJob = new Map<string, JaHistoryRow[]>();
      if (jobs.length) {
        const { data: histories, error } = await supabase.from('job_assignment_history')
          .select('job_id,status,performed_at')
          .in('job_id', jobs.map((job) => job.id));
        if (error) throw error;
        for (const row of (histories ?? []) as JaHistoryRow[]) {
          const rows = jaHistoryByJob.get(row.job_id) ?? [];
          rows.push(row);
          jaHistoryByJob.set(row.job_id, rows);
        }
      }

      const machines = new Map<string, MachineMetric>();
      const technicians = new Map<string, { id: string; name: string; jobs: number; durationMs: number }>();
      const addWork = (args: {
        key: string | null; machineName: string | null; machineDurationMs: number; technicianDurationMs: number;
        members: { id: string; name: string }[]; includeMachine?: boolean;
      }) => {
        if (args.includeMachine !== false && args.key && args.machineName) {
          const machine = machines.get(args.key) ?? { key: args.key, name: args.machineName, jobs: 0, durationMs: 0 };
          if (args.machineDurationMs > 0) {
            machine.jobs += 1;
            machine.durationMs += args.machineDurationMs;
            machines.set(args.key, machine);
          }
        }
        for (const member of new Map(args.members.map((m) => [m.id, m])).values()) {
          if (args.technicianDurationMs <= 0) continue;
          const metric = technicians.get(member.id) ?? { ...member, jobs: 0, durationMs: 0 };
          metric.jobs += 1;
          metric.durationMs += args.technicianDurationMs;
          technicians.set(member.id, metric);
        }
      };

      for (const wo of workOrders) {
        if (wo.status === 'canceled') continue;
        const linkedJob = wo.job_assignment_id ? jobsById.get(wo.job_assignment_id) : undefined;
        if (linkedJob?.status === 'canceled') continue;
        const machineName = wo.equipment?.name ?? linkedJob?.equipment?.name ?? linkedJob?.manual_equipment ?? null;
        const machineKey = wo.equipment_id ?? linkedJob?.equipment_id ?? (machineName ? `manual:${machineName.trim().toLowerCase()}` : null);
        const histories = (historyByWo.get(wo.id) ?? []).sort((a, b) => a.performed_at.localeCompare(b.performed_at));
        let machineDurationMs = activeDuration(histories, ['on_progress', 'in_progress', 'analysis'], yearStart);
        let technicianDurationMs = activeDuration(histories, ['on_progress', 'in_progress', 'analysis'], monthStart);
        if (linkedJob?.started_at && histories.length === 0) {
          const end = new Date(linkedJob.done_at ?? Date.now()).getTime();
          const start = new Date(linkedJob.started_at).getTime();
          if (machineDurationMs === 0) machineDurationMs = Math.max(0, Math.min(end, Date.now()) - Math.max(start, yearStart));
          if (technicianDurationMs === 0) technicianDurationMs = Math.max(0, Math.min(end, Date.now()) - Math.max(start, monthStart));
        }
        const members = wo.technicians?.map((link) => ({ id: link.technician_id, name: link.technician?.full_name ?? 'Teknisi' }))
          ?? [];
        const jobMembers = linkedJob?.assigned_technicians?.map((link) => ({ id: link.technician_id, name: link.technician?.full_name ?? 'Teknisi' }))
          ?? (linkedJob?.technician ? [{ id: linkedJob.technician.id, name: linkedJob.technician.full_name }] : []);
        const isRepair = linkedJob ? linkedJob.work_category === 'perbaikan' : (wo.work_types ?? []).includes('perbaikan');
        addWork({ key: machineKey, machineName, machineDurationMs, technicianDurationMs, members: members.length ? members : jobMembers, includeMachine: isRepair });
      }

      for (const job of jobs) {
        if (linkedJobIds.has(job.id) || job.status === 'canceled') continue;
        const machineName = job.equipment?.name ?? job.manual_equipment ?? null;
        const machineKey = job.equipment_id ?? (machineName ? `manual:${machineName.trim().toLowerCase()}` : null);
        const members = job.assigned_technicians?.map((link) => ({ id: link.technician_id, name: link.technician?.full_name ?? 'Teknisi' }))
          ?? (job.technician ? [{ id: job.technician.id, name: job.technician.full_name }] : []);
        const jobHistory = jaHistoryByJob.get(job.id) ?? [];
        let machineDurationMs = activeDuration(jobHistory, ['in_progress'], yearStart);
        let technicianDurationMs = activeDuration(jobHistory, ['in_progress'], monthStart);
        if (job.started_at && jobHistory.length === 0) {
          const end = new Date(job.done_at ?? Date.now()).getTime();
          const start = new Date(job.started_at).getTime();
          if (machineDurationMs === 0) machineDurationMs = Math.max(0, Math.min(end, Date.now()) - Math.max(start, yearStart));
          if (technicianDurationMs === 0) technicianDurationMs = Math.max(0, Math.min(end, Date.now()) - Math.max(start, monthStart));
        }
        addWork({ key: machineKey, machineName, machineDurationMs, technicianDurationMs, members, includeMachine: job.work_category === 'perbaikan' });
      }

      setMachineMetrics([...machines.values()].filter((row) => row.durationMs > 0).sort((a, b) => b.jobs - a.jobs || b.durationMs - a.durationMs || a.name.localeCompare(b.name)).slice(0, 5));
      setTechnicianMetrics([...technicians.values()]
        .filter((row) => row.durationMs > 0)
        .sort((a, b) => b.jobs - a.jobs || b.durationMs - a.durationMs || a.name.localeCompare(b.name))
        .slice(0, 5)
        .map((row, index) => ({ ...row, color: PIE_COLORS[index] })));
    } catch (error) {
      console.error('Gagal memuat analitik dashboard:', error);
      setAnalyticsError('Ringkasan mesin dan teknisi gagal dimuat.');
    } finally {
      setAnalyticsLoading(false);
    }
  }, [profile]);

  useEffect(() => { void loadAnalytics(); }, [loadAnalytics]);

  // Dashboard reuses the action-item snapshot shared with the notification bell.
  // Refresh on entry so deletions made elsewhere cannot leave an old JA card visible.
  useEffect(() => { void reload(true); }, [reload]);

  useEffect(() => {
    const kind = canViewTechnicianChart ? 'month' : 'year';
    const delay = Math.max(1000, nextJakartaPeriodStart(kind) - Date.now() + 1000);
    const timer = window.setTimeout(() => {
      setPeriodNow(Date.now());
      void loadAnalytics();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [canViewTechnicianChart, loadAnalytics]);

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
            onClick={() => { setPeriodNow(Date.now()); void reload(); void loadAnalytics(); }}
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

      <div className={`grid grid-cols-1 ${canViewTechnicianChart ? 'xl:grid-cols-2' : ''} gap-4`}>
        <Card className="p-5">
          <div className="mb-4">
            <h3 className="font-semibold text-slate-900">Top 5 Mesin</h3>
            <p className="text-xs text-slate-500 mt-1">Periode {yearLabel} · WO dan Jobs Assignment kategori Perbaikan, diurutkan berdasarkan frekuensi.</p>
          </div>
          {analyticsLoading ? <Spinner /> : analyticsError ? <p className="text-sm text-rose-600">{analyticsError}</p> : machineMetrics.length === 0 ? (
            <p className="text-sm text-slate-500">Belum ada data pekerjaan dengan mesin target.</p>
          ) : (
            <ol className="space-y-3">
              {machineMetrics.map((machine, index) => (
                <li key={machine.key} className="flex items-center gap-3">
                  <span className="w-7 h-7 rounded-full bg-blue-50 text-blue-700 text-xs font-bold flex items-center justify-center shrink-0">{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-slate-800 truncate" title={machine.name}>{machine.name}</span>
                    <span className="block text-xs text-slate-500">{machine.jobs} pekerjaan · {formatDuration(machine.durationMs)}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        {canViewTechnicianChart && (
          <Card className="p-5">
            <div className="mb-4">
              <h3 className="font-semibold text-slate-900">Top 5 Teknisi</h3>
              <p className="text-xs text-slate-500 mt-1">Periode {monthLabel} · pie berdasarkan akumulasi waktu; jumlah tugas ditampilkan di samping.</p>
            </div>
            {analyticsLoading ? <Spinner /> : analyticsError ? <p className="text-sm text-rose-600">{analyticsError}</p> : technicianMetrics.length === 0 ? (
              <p className="text-sm text-slate-500">Belum ada data penugasan teknisi.</p>
            ) : <DashboardPie rows={technicianMetrics} />}
          </Card>
        )}
      </div>

      {canViewTechnicianChart && (
        <Card className="p-5">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h3 className="font-semibold text-slate-900">Teknisi Available</h3>
              <p className="text-xs text-slate-500 mt-1">Teknisi aktif yang belum memiliki WO atau Jobs Assignment berjalan.</p>
            </div>
            <span className="inline-flex items-center rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-xs font-semibold text-emerald-700">
              {availableTechnicians.length} teknisi
            </span>
          </div>
          {analyticsLoading ? <Spinner /> : analyticsError ? (
            <p className="text-sm text-rose-600">{analyticsError}</p>
          ) : availableTechnicians.length === 0 ? (
            <p className="text-sm text-slate-500">Tidak ada teknisi yang available saat ini.</p>
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {availableTechnicians.map((technician) => (
                <li key={technician.id} className="flex items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50/50 px-3 py-2.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                  <span className="text-sm font-medium text-slate-800 truncate">{technician.full_name || 'Tanpa nama'}</span>
                  <span className="ml-auto text-[11px] text-emerald-700">Available</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
