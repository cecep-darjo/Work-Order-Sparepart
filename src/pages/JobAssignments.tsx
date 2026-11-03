import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useActionItemsContext } from '@/context/ActionItemsContext';
import { supabase } from '@/lib/supabase';
import { Badge, Button, Card, EmptyState, Input, Select, Spinner } from '@/components/ui';
import { EquipmentTypeBadges } from '@/components/EquipmentTypeCheckboxes';
import PageControls from '@/components/PageControls';
import JobAssignmentForm from '@/components/JobAssignmentForm';
import JobAssignmentDetail from '@/components/JobAssignmentDetail';
import {
  JOB_LIST_SELECT,
  JOB_PHOTO_BUCKET,
  JOB_PRIORITY_BAR,
  JOB_PRIORITY_COLORS,
  JOB_PRIORITY_LABELS,
  JOB_PRIORITY_WEIGHT,
  JOB_STATUS_COLORS,
  JOB_STATUS_LABELS,
  deadlineCountdown,
  fmtJobDateTime,
  isJobActive,
  isJobOpen,
  isJobManager,
  isJobOverdue,
  jobErrorMessage,
  wasFinishedLate,
  type JobAssignment,
  type JobPerson,
  type JobPriority,
  type JobStatus,
} from '@/lib/jobAssignments';
import { Camera, Clock, MapPin, Navigation, Play, Plus, RefreshCw, Search, User, Trash2 } from 'lucide-react';

const POLL_MS = 60000;
const PAGE_SIZE = 10;

type StatusFilter = 'open' | 'running' | 'overdue' | 'all' | JobStatus;
type TechTab = 'active' | 'today' | 'review' | 'history';
type JobSort = 'default' | 'created_newest' | 'created_oldest' | 'deadline_soonest' | 'deadline_latest' | 'done_waiting' | 'done_newest' | 'priority';

function isCompletedToday(job: JobAssignment, now: number): boolean {
  if (!job.done_at || !['done', 'approved'].includes(job.status)) return false;
  const dayInJakarta = (value: Date) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value);
  return dayInJakarta(new Date(job.done_at)) === dayInJakarta(new Date(now));
}

function dateValue(value: string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function compareByDate(a: string | null | undefined, b: string | null | undefined, direction: 'asc' | 'desc'): number {
  const left = dateValue(a);
  const right = dateValue(b);
  return direction === 'asc' ? left - right : right - left;
}

function sortJobs(list: JobAssignment[], sortBy: JobSort, reviewQueue: boolean): JobAssignment[] {
  const sorted = [...list];
  sorted.sort((a, b) => {
    let result = 0;
    if (sortBy === 'default' && reviewQueue) {
      // Prioritize jobs that have waited longest for approval.
      result = compareByDate(a.done_at, b.done_at, 'asc');
    } else if (sortBy === 'default' || sortBy === 'created_newest') {
      result = compareByDate(a.created_at, b.created_at, 'desc');
    } else if (sortBy === 'created_oldest') {
      result = compareByDate(a.created_at, b.created_at, 'asc');
    } else if (sortBy === 'deadline_soonest') {
      result = compareByDate(a.deadline, b.deadline, 'asc');
    } else if (sortBy === 'deadline_latest') {
      result = compareByDate(a.deadline, b.deadline, 'desc');
    } else if (sortBy === 'done_waiting') {
      result = compareByDate(a.done_at, b.done_at, 'asc');
    } else if (sortBy === 'done_newest') {
      result = compareByDate(a.done_at, b.done_at, 'desc');
    } else if (sortBy === 'priority') {
      result = JOB_PRIORITY_WEIGHT[a.priority] - JOB_PRIORITY_WEIGHT[b.priority];
    }
    if (result !== 0) return result;
    return compareByDate(a.created_at, b.created_at, 'desc');
  });
  return sorted;
}

function photoCount(job: JobAssignment): number {
  return job.photos?.[0]?.count ?? 0;
}

function StatCard({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left bg-white rounded-xl border p-4 transition hover:shadow-sm ${
        active ? 'border-blue-400 ring-1 ring-blue-300' : 'border-slate-200'
      }`}
    >
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${tone}`}>{value}</p>
    </button>
  );
}

function JobCard({
  job,
  now,
  showTechnician,
  quickAction,
  onOpen,
  showDelete,
  deleting,
  onDelete,
}: {
  job: JobAssignment;
  now: number;
  showTechnician: boolean;
  quickAction?: { label: string; icon: 'navigation' | 'play' | 'open'; busy: boolean; onClick: () => void };
  onOpen: () => void;
  showDelete: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const overdue = isJobOverdue(job, now);
  const active = isJobActive(job.status);
  const photos = photoCount(job);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      className="relative bg-white rounded-xl border border-slate-200 hover:border-blue-300 hover:shadow-sm transition cursor-pointer overflow-hidden"
    >
      <span className={`absolute left-0 top-0 bottom-0 w-1.5 ${JOB_PRIORITY_BAR[job.priority]}`} />
      {showDelete && (
        <button
          type="button"
          title="Hapus Jobs Assignment"
          aria-label={`Hapus Jobs Assignment ${job.job_no}`}
          disabled={deleting}
          onClick={(event) => { event.stopPropagation(); onDelete(); }}
          onKeyDown={(event) => event.stopPropagation()}
          className="absolute top-2 right-2 z-10 rounded-lg p-2 text-red-600 hover:bg-red-50 disabled:opacity-40"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
      <div className={`pl-5 ${showDelete ? 'pr-14' : 'pr-4'} py-3.5`}>
        <div className="flex flex-wrap items-center gap-2 mb-1.5">
          <span className="text-xs font-mono text-slate-400">{job.job_no}</span>
          <Badge className={JOB_STATUS_COLORS[job.status]}>{JOB_STATUS_LABELS[job.status]}</Badge>
          {!(job.assigned_technicians?.length || job.technician_id) && (
            <Badge className="bg-amber-100 text-amber-800 border-amber-200">Menunggu Assignment Teknisi</Badge>
          )}
          <Badge className={JOB_PRIORITY_COLORS[job.priority]}>{JOB_PRIORITY_LABELS[job.priority]}</Badge>
          {overdue && <Badge className="bg-red-100 text-red-700 border-red-200">Terlambat</Badge>}
          {wasFinishedLate(job) && <Badge className="bg-orange-100 text-orange-700 border-orange-200">Selesai terlambat</Badge>}
        </div>

        <p className="font-semibold text-slate-900 leading-snug">{job.title}</p>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1 min-w-0">
            <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate max-w-[14rem]">{job.location}</span>
          </span>
          {(job.equipment || job.manual_equipment) && (
            <span className="inline-flex max-w-[28rem] flex-wrap items-center gap-1">Mesin target: {job.equipment?.name ?? job.manual_equipment} · {job.equipment?.area?.name ?? job.location}{job.equipment && <EquipmentTypeBadges types={job.equipment.equipment_types} />}</span>
          )}
          {showTechnician && (
            <span className="inline-flex items-center gap-1">
              <User className="w-3.5 h-3.5" />
              {job.assigned_technicians?.map((member) => member.technician?.full_name).filter(Boolean).join(', ') || job.technician?.full_name || 'Menunggu Assignment Teknisi'}
            </span>
          )}
          <span className={`inline-flex items-center gap-1 ${overdue ? 'text-red-600 font-medium' : ''}`}>
            <Clock className="w-3.5 h-3.5" />
            {fmtJobDateTime(job.deadline)}
            {active && <span className="opacity-80">({deadlineCountdown(job.deadline, now)})</span>}
          </span>
          {photos > 0 && (
            <span className="inline-flex items-center gap-1">
              <Camera className="w-3.5 h-3.5" />
              {photos}
            </span>
          )}
        </div>

        {quickAction && (
          <div className="mt-3" onClick={(e) => e.stopPropagation()}>
            <Button
              size="sm"
              variant={quickAction.icon === 'open' ? 'secondary' : 'primary'}
              onClick={quickAction.onClick}
              disabled={quickAction.busy}
            >
              {quickAction.icon === 'navigation' && <Navigation className="w-4 h-4" />}
              {quickAction.icon === 'play' && <Play className="w-4 h-4" />}
              {quickAction.label}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function JobAssignments() {
  const { profile } = useAuth();
  const { reload: reloadActionItems } = useActionItemsContext();
  const isManager = isJobManager(profile?.role);

  const [jobs, setJobs] = useState<JobAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [toast, setToast] = useState<string | null>(null);

  // filter (atasan)
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [priorityFilter, setPriorityFilter] = useState<'all' | JobPriority>('all');
  const [departmentFilter, setDepartmentFilter] = useState('all');
  const [sortBy, setSortBy] = useState<JobSort>('default');
  // tab (teknisi)
  const [tab, setTab] = useState<TechTab>('active');

  const [technicians, setTechnicians] = useState<JobPerson[]>([]);
  const [departmentOptions, setDepartmentOptions] = useState<{ id: string; name: string }[]>([]);
  const [technicianDepartments, setTechnicianDepartments] = useState<Record<string, string[]>>({});

  const [detailId, setDetailId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<JobAssignment | null>(null);
  const [quickBusy, setQuickBusy] = useState<string | null>(null);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const seq = useRef(0);

  const load = useCallback(async (silent = false) => {
    const mySeq = ++seq.current;
    if (!silent) setLoading(true);
    const { data, error } = await supabase
      .from('job_assignments')
      .select(JOB_LIST_SELECT)
      .neq('work_category', 'preventive_maintenance')
      .order('created_at', { ascending: false })
      .limit(500);
    if (mySeq !== seq.current) return; // ada permintaan yang lebih baru
    if (error) {
      setLoadError(error.message);
    } else {
      setLoadError(null);
      setJobs((data as unknown as JobAssignment[]) ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 60000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        load(true);
        setNow(Date.now());
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // Daftar teknisi (hanya atasan yang membuat penugasan); Area dimuat di form.
  useEffect(() => {
    if (!isManager) return;
    (async () => {
      const [techRes, deptRes, ownAssignments] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, full_name, username, role, is_active, department_id, department_assignments:profile_departments(department_id)')
          .in('role', ['teknisi', 'spv'])
          .order('full_name'),
        supabase.from('departments').select('id,name').order('name'),
        profile?.role === 'admin'
          ? Promise.resolve({ data: [] as { department_id: string }[] })
          : supabase.from('profile_departments').select('department_id').eq('profile_id', profile!.id),
      ]);
      const rows = (techRes.data ?? []) as unknown as (JobPerson & { role: string; is_active: boolean; department_id: string | null; department_assignments?: { department_id: string }[] })[];
      const activeRows = rows.filter((tech) => tech.is_active);
      setTechnicianDepartments(Object.fromEntries(rows.map((tech) => [
        tech.id,
        [...new Set([...(tech.department_id ? [tech.department_id] : []), ...(tech.department_assignments ?? []).map((assignment) => assignment.department_id)])],
      ])));
      if (profile?.role === 'admin') {
        setTechnicians(activeRows);
        setDepartmentOptions((deptRes.data ?? []) as { id: string; name: string }[]);
      } else {
        const allowedIds = new Set([...(ownAssignments.data ?? []).map((row) => row.department_id as string), ...(profile?.department_id ? [profile.department_id] : [])]);
        setTechnicians(activeRows.filter((tech) => allowedIds.has(tech.department_id ?? '') || tech.department_assignments?.some((assignment) => allowedIds.has(assignment.department_id))));
        setDepartmentOptions(((deptRes.data ?? []) as { id: string; name: string }[]).filter((department) => allowedIds.has(department.id)));
      }
    })();
  }, [isManager, profile]);

  const afterChange = useCallback(async () => {
    await load(true);
    await reloadActionItems(true);
  }, [load, reloadActionItems]);

  async function deleteJobAssignment(job: JobAssignment) {
    if (profile?.role !== 'admin' || deletingJobId) return;
    if (!window.confirm(`Hapus Jobs Assignment ${job.job_no} secara permanen? Riwayat, daftar teknisi, dan foto akan ikut dihapus.`)) return;
    if (!window.confirm(`Konfirmasi kedua: hapus ${job.job_no}? Work Order yang tertaut akan tetap ada tanpa tautan Jobs Assignment.`)) return;

    setDeletingJobId(job.id);
    try {
      const { data: photos, error: photoLoadError } = await supabase
        .from('job_assignment_photos')
        .select('storage_path')
        .eq('job_id', job.id);
      if (photoLoadError) throw photoLoadError;

      const { error } = await supabase.rpc('admin_delete_job_assignment', {
        p_job_id: job.id,
        p_reason: 'Disetujui Admin setelah dua kali konfirmasi.',
      });
      if (error) throw error;

      const photoPaths = (photos ?? []).map((photo) => photo.storage_path as string);
      const { error: storageError } = photoPaths.length
        ? await supabase.storage.from(JOB_PHOTO_BUCKET).remove(photoPaths)
        : { error: null };
      if (detailId === job.id) setDetailId(null);
      await afterChange();
      flash(storageError
        ? `Jobs Assignment ${job.job_no} terhapus, tetapi file foto gagal dibersihkan.`
        : `Jobs Assignment ${job.job_no} berhasil dihapus.`);
    } catch (error) {
      const details = error && typeof error === 'object'
        ? error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown }
        : null;
      const message = [details?.message, details?.details, details?.hint]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' — ')
        || (error instanceof Error ? error.message : typeof error === 'string' ? error : 'Terjadi kesalahan yang tidak diketahui.');
      const code = typeof details?.code === 'string' ? ` (kode: ${details.code})` : '';
      alert(`Gagal menghapus Jobs Assignment: ${message}${code}`);
    } finally {
      setDeletingJobId(null);
    }
  }

  function flash(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 3500);
  }

  const activeCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const j of jobs) {
      if (!isJobActive(j.status)) continue;
      const ids = j.assigned_technicians?.map((member) => member.technician_id) ?? (j.technician_id ? [j.technician_id] : []);
      for (const id of new Set(ids)) m[id] = (m[id] ?? 0) + 1;
    }
    return m;
  }, [jobs]);

  const stats = useMemo(
    () => ({
      running: jobs.filter((j) => isJobActive(j.status)).length,
    pending: jobs.filter((j) => j.status === 'pending').length,
      review: jobs.filter((j) => j.status === 'done').length,
      overdue: jobs.filter((j) => isJobOverdue(j, now)).length,
      approved: jobs.filter((j) => j.status === 'approved').length,
    }),
    [jobs, now],
  );

  const visibleJobs = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = jobs;

    if (isManager) {
      list = list.filter((j) => {
        if (statusFilter === 'open' && (j.status === 'approved' || j.status === 'canceled')) return false;
        if (statusFilter === 'running' && !isJobActive(j.status)) return false;
        if (statusFilter === 'overdue' && !isJobOverdue(j, now)) return false;
        if (!['open', 'running', 'overdue', 'all'].includes(statusFilter) && j.status !== statusFilter) return false;
        if (priorityFilter !== 'all' && j.priority !== priorityFilter) return false;
        if (departmentFilter !== 'all') {
          const technicianIds = new Set([
            ...(j.assigned_technicians ?? []).map((member) => member.technician_id),
            ...(j.technician_id ? [j.technician_id] : []),
          ]);
          if (![...technicianIds].some((id) => technicianDepartments[id]?.includes(departmentFilter))) return false;
        }
        return true;
      });
    } else {
      list = list.filter((j) => {
        if (tab === 'active') return isJobOpen(j.status);
        if (tab === 'today') return isCompletedToday(j, now);
        if (tab === 'review') return j.status === 'done';
        return j.status === 'approved' || j.status === 'canceled';
      });
    }

    if (q) {
      list = list.filter(
        (j) =>
          j.title.toLowerCase().includes(q) ||
          j.job_no.toLowerCase().includes(q) ||
          j.location.toLowerCase().includes(q) ||
          (j.assigned_technicians?.map((member) => member.technician?.full_name ?? '').join(' ') ?? j.technician?.full_name ?? '').toLowerCase().includes(q),
      );
    }
    return sortJobs(list, sortBy, isManager ? statusFilter === 'done' : tab === 'review');
  }, [jobs, isManager, statusFilter, priorityFilter, departmentFilter, technicianDepartments, tab, search, now, sortBy]);

  const totalPages = Math.max(1, Math.ceil(visibleJobs.length / PAGE_SIZE));
  const pagedJobs = useMemo(
    () => visibleJobs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [visibleJobs, page],
  );

  useEffect(() => {
    setPage(1);
  }, [isManager, search, statusFilter, priorityFilter, departmentFilter, tab, sortBy]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const techCounts = useMemo(
    () => ({
      active: jobs.filter((j) => isJobOpen(j.status)).length,
      today: jobs.filter((j) => isCompletedToday(j, now)).length,
      review: jobs.filter((j) => j.status === 'done').length,
      history: jobs.filter((j) => j.status === 'approved' || j.status === 'canceled').length,
    }),
    [jobs, now],
  );

  /** Satu ketukan dari kartu: On the Way / Mulai Kerja (teknisi). */
  async function quickStatus(job: JobAssignment, next: JobStatus) {
    setQuickBusy(job.id);
    try {
      const { data, error } = await supabase
        .from('job_assignments')
        .update({ status: next })
        .eq('id', job.id)
        .eq('status', job.status)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) alert('Status tugas sudah berubah. Data dimuat ulang.');
      await afterChange();
    } catch (e) {
      alert(jobErrorMessage(e));
    } finally {
      setQuickBusy(null);
    }
  }

  function quickActionFor(job: JobAssignment) {
    const isAssignedToCurrentUser = (profile?.role === 'teknisi' || profile?.role === 'spv') && (
      job.assigned_technicians?.some((member) => member.technician_id === profile.id) ?? job.technician_id === profile.id
    );
    if (isManager && !isAssignedToCurrentUser) return undefined;
    const busy = quickBusy === job.id;
    if (job.status === 'assigned')
      return { label: 'On the Way', icon: 'navigation' as const, busy, onClick: () => quickStatus(job, 'on_the_way') };
    if (job.status === 'on_the_way')
      return { label: 'Mulai Kerja', icon: 'play' as const, busy, onClick: () => quickStatus(job, 'in_progress') };
    if (job.status === 'in_progress')
      return { label: 'Isi Laporan & Foto', icon: 'open' as const, busy, onClick: () => setDetailId(job.id) };
    return undefined;
  }

  if (!profile) return null;

  const missingMigration =
    !!loadError && /job_assignments|relation|schema cache|does not exist|permission denied/i.test(loadError);

  return (
    <div className="space-y-5">
      {/* Header halaman */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900">
            {isManager ? 'Penugasan Teknisi' : 'Tugas Saya'}
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {isManager
              ? 'Buat penugasan, pantau progres, dan approve laporan teknisi.'
              : 'Update status pekerjaan dan unggah foto bukti kerja.'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => load()}
            className="p-2.5 rounded-xl border border-slate-200 bg-white text-slate-500 hover:text-slate-900 hover:bg-slate-50 transition"
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
          {isManager && (
            <Button
              onClick={() => {
                setEditingJob(null);
                setFormOpen(true);
              }}
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Buat Penugasan</span>
              <span className="sm:hidden">Baru</span>
            </Button>
          )}
        </div>
      </div>

      {toast && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-2.5">{toast}</div>
      )}

      {loadError && (
        <Card className="p-4 border-red-200 bg-red-50">
          <p className="text-sm font-medium text-red-800">Gagal memuat penugasan</p>
          <p className="text-xs text-red-700 mt-1 break-words">{loadError}</p>
          {missingMigration && (
            <p className="text-xs text-red-700 mt-2">
              Pastikan migration <code>20261017090000_048_jobs_assignment.sql</code> sudah dijalankan di Supabase (SQL Editor).
            </p>
          )}
        </Card>
      )}

      {/* ---------------------------- ATASAN ---------------------------- */}
      {isManager && !loadError && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="Sedang berjalan" value={stats.running} tone="text-blue-600" active={statusFilter === 'running'} onClick={() => setStatusFilter('running')} />
            <StatCard label="Pending" value={stats.pending} tone="text-orange-600" active={statusFilter === 'pending'} onClick={() => setStatusFilter('pending')} />
            <StatCard label="Menunggu approval" value={stats.review} tone="text-amber-600" active={statusFilter === 'done'} onClick={() => setStatusFilter('done')} />
            <StatCard label="Terlambat" value={stats.overdue} tone="text-red-600" active={statusFilter === 'overdue'} onClick={() => setStatusFilter('overdue')} />
            <StatCard label="Disetujui" value={stats.approved} tone="text-emerald-600" active={statusFilter === 'approved'} onClick={() => setStatusFilter('approved')} />
          </div>

          <div className="flex flex-col lg:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Cari judul, nomor, lokasi, atau teknisi..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} className="lg:w-48">
              <option value="open">Belum final</option>
              <option value="running">Sedang berjalan</option>
              <option value="overdue">Terlambat</option>
              <option value="assigned">Ditugaskan</option>
              <option value="on_the_way">On the Way</option>
              <option value="in_progress">In Progress</option>
              <option value="pending">Pending</option>
              <option value="done">Done (menunggu approval)</option>
              <option value="approved">Disetujui</option>
              <option value="canceled">Dibatalkan</option>
              <option value="all">Semua status</option>
            </Select>
            <Select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value as 'all' | JobPriority)} className="lg:w-40">
              <option value="all">Semua prioritas</option>
              <option value="urgent">Urgent</option>
              <option value="high">Tinggi</option>
              <option value="normal">Normal</option>
              <option value="low">Rendah</option>
            </Select>
            <Select aria-label="Filter departemen Jobs Assignment" value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)} className="lg:w-48">
              <option value="all">Semua departemen</option>
              {departmentOptions.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
            <Select aria-label="Urutkan Jobs Assignment" value={sortBy} onChange={(e) => setSortBy(e.target.value as JobSort)} className="lg:w-56">
              <option value="default">Default: {statusFilter === 'done' ? 'paling lama menunggu approval' : 'dibuat terbaru'}</option>
              <option value="created_newest">Tanggal dibuat · terbaru</option>
              <option value="created_oldest">Tanggal dibuat · terlama</option>
              <option value="deadline_soonest">Deadline · terdekat</option>
              <option value="deadline_latest">Deadline · terjauh</option>
              <option value="done_waiting">Selesai · paling lama menunggu</option>
              <option value="done_newest">Selesai · terbaru</option>
              <option value="priority">Prioritas · tinggi ke rendah</option>
            </Select>
          </div>
        </>
      )}

      {/* ---------------------------- TEKNISI --------------------------- */}
      {!isManager && !loadError && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 bg-slate-100 p-1 rounded-xl">
            {(
              [
                ['active', 'Aktif', techCounts.active],
                ['today', 'Selesai hari ini', techCounts.today],
                ['review', 'Menunggu approval', techCounts.review],
                ['history', 'Riwayat', techCounts.history],
              ] as [TechTab, string, number][]
            ).map(([key, label, count]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`py-2 px-2 rounded-lg text-xs sm:text-sm font-medium transition ${
                  tab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {label} <span className="opacity-60">({count})</span>
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input placeholder="Cari tugas..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10" />
            </div>
            <Select aria-label="Urutkan Jobs Assignment" value={sortBy} onChange={(e) => setSortBy(e.target.value as JobSort)} className="sm:w-64">
              <option value="default">Default: {tab === 'review' ? 'paling lama menunggu approval' : 'dibuat terbaru'}</option>
              <option value="created_newest">Tanggal dibuat · terbaru</option>
              <option value="created_oldest">Tanggal dibuat · terlama</option>
              <option value="deadline_soonest">Deadline · terdekat</option>
              <option value="deadline_latest">Deadline · terjauh</option>
              <option value="done_waiting">Selesai · paling lama menunggu</option>
              <option value="done_newest">Selesai · terbaru</option>
              <option value="priority">Prioritas · tinggi ke rendah</option>
            </Select>
          </div>
        </>
      )}

      {/* ----------------------------- DAFTAR --------------------------- */}
      {loading ? (
        <Spinner />
      ) : loadError ? null : visibleJobs.length === 0 ? (
        <Card>
          <EmptyState
            message={
              jobs.length === 0
                ? isManager
                  ? 'Belum ada penugasan. Klik "Buat Penugasan" untuk memulai.'
                  : 'Belum ada tugas yang ditugaskan kepada Anda.'
                : 'Tidak ada tugas yang cocok dengan filter ini.'
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {pagedJobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              now={now}
              showTechnician={isManager}
              quickAction={quickActionFor(job)}
              onOpen={() => setDetailId(job.id)}
              showDelete={profile?.role === 'admin'}
              deleting={deletingJobId === job.id}
              onDelete={() => void deleteJobAssignment(job)}
            />
          ))}
          <PageControls page={page} totalItems={visibleJobs.length} onPageChange={setPage} />
        </div>
      )}

      {/* ------------------------------ MODAL --------------------------- */}
      {detailId && (
        <JobAssignmentDetail
          jobId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={afterChange}
          onEdit={(j) => {
            setDetailId(null);
            setEditingJob(j);
            setFormOpen(true);
          }}
        />
      )}

      {formOpen && isManager && (
        <JobAssignmentForm
          job={editingJob}
          technicians={technicians}
          activeCounts={activeCounts}
          onClose={() => setFormOpen(false)}
          onSaved={async (message) => {
            setFormOpen(false);
            flash(message);
            await afterChange();
          }}
        />
      )}
    </div>
  );
}
