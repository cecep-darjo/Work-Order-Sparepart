import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useActionItemsContext } from '@/context/ActionItemsContext';
import { supabase } from '@/lib/supabase';
import { Badge, Button, Card, EmptyState, Input, Select, Spinner } from '@/components/ui';
import JobAssignmentForm from '@/components/JobAssignmentForm';
import JobAssignmentDetail from '@/components/JobAssignmentDetail';
import {
  JOB_LIST_SELECT,
  JOB_PRIORITY_BAR,
  JOB_PRIORITY_COLORS,
  JOB_PRIORITY_LABELS,
  JOB_PRIORITY_WEIGHT,
  JOB_STATUS_COLORS,
  JOB_STATUS_LABELS,
  deadlineCountdown,
  fmtJobDateTime,
  isJobActive,
  isJobManager,
  isJobOverdue,
  jobErrorMessage,
  wasFinishedLate,
  type JobAssignment,
  type JobPerson,
  type JobPriority,
  type JobStatus,
} from '@/lib/jobAssignments';
import { Camera, Clock, MapPin, Navigation, Play, Plus, RefreshCw, Search, User } from 'lucide-react';

const POLL_MS = 30000;

type StatusFilter = 'open' | 'running' | 'overdue' | 'all' | JobStatus;
type TechTab = 'active' | 'review' | 'history';

function sortRank(status: JobStatus): number {
  if (status === 'done') return 0;
  if (isJobActive(status)) return 1;
  return 2;
}

/** Perlu perhatian dulu: Done (menunggu approval) -> aktif berdasarkan deadline -> final terbaru. */
function compareJobs(a: JobAssignment, b: JobAssignment): number {
  const ra = sortRank(a.status);
  const rb = sortRank(b.status);
  if (ra !== rb) return ra - rb;
  if (ra === 2) return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  const d = new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
  if (d !== 0) return d;
  return JOB_PRIORITY_WEIGHT[a.priority] - JOB_PRIORITY_WEIGHT[b.priority];
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
}: {
  job: JobAssignment;
  now: number;
  showTechnician: boolean;
  quickAction?: { label: string; icon: 'navigation' | 'play' | 'open'; busy: boolean; onClick: () => void };
  onOpen: () => void;
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
      <div className="pl-5 pr-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2 mb-1.5">
          <span className="text-xs font-mono text-slate-400">{job.job_no}</span>
          <Badge className={JOB_STATUS_COLORS[job.status]}>{JOB_STATUS_LABELS[job.status]}</Badge>
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
          {showTechnician && (
            <span className="inline-flex items-center gap-1">
              <User className="w-3.5 h-3.5" />
              {job.technician?.full_name ?? '-'}
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
  const [techFilter, setTechFilter] = useState('all');
  // tab (teknisi)
  const [tab, setTab] = useState<TechTab>('active');

  const [technicians, setTechnicians] = useState<JobPerson[]>([]);
  const [areaNames, setAreaNames] = useState<string[]>([]);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<JobAssignment | null>(null);
  const [quickBusy, setQuickBusy] = useState<string | null>(null);

  const seq = useRef(0);

  const load = useCallback(async (silent = false) => {
    const mySeq = ++seq.current;
    if (!silent) setLoading(true);
    const { data, error } = await supabase
      .from('job_assignments')
      .select(JOB_LIST_SELECT)
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
    const poll = setInterval(() => load(true), POLL_MS);
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

  // Daftar teknisi & saran lokasi (hanya atasan yang membuat penugasan)
  useEffect(() => {
    if (!isManager) return;
    (async () => {
      const [techRes, areaRes] = await Promise.all([
        supabase.from('profiles').select('id, full_name, username').eq('role', 'teknisi').eq('is_active', true).order('full_name'),
        supabase.from('areas').select('name').order('name'),
      ]);
      setTechnicians((techRes.data as JobPerson[] | null) ?? []);
      setAreaNames(((areaRes.data as { name: string }[] | null) ?? []).map((a) => a.name));
    })();
  }, [isManager]);

  const afterChange = useCallback(async () => {
    await load(true);
    await reloadActionItems(true);
  }, [load, reloadActionItems]);

  function flash(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 3500);
  }

  const activeCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const j of jobs) if (isJobActive(j.status)) m[j.technician_id] = (m[j.technician_id] ?? 0) + 1;
    return m;
  }, [jobs]);

  const locationSuggestions = useMemo(() => {
    const set = new Set<string>(areaNames);
    for (const j of jobs) set.add(j.location);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [areaNames, jobs]);

  const stats = useMemo(
    () => ({
      running: jobs.filter((j) => isJobActive(j.status)).length,
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
        if (techFilter !== 'all' && j.technician_id !== techFilter) return false;
        return true;
      });
    } else {
      list = list.filter((j) => {
        if (tab === 'active') return isJobActive(j.status);
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
          (j.technician?.full_name ?? '').toLowerCase().includes(q),
      );
    }
    return [...list].sort(compareJobs);
  }, [jobs, isManager, statusFilter, priorityFilter, techFilter, tab, search, now]);

  const techCounts = useMemo(
    () => ({
      active: jobs.filter((j) => isJobActive(j.status)).length,
      review: jobs.filter((j) => j.status === 'done').length,
      history: jobs.filter((j) => j.status === 'approved' || j.status === 'canceled').length,
    }),
    [jobs],
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
    if (isManager) return undefined;
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
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Sedang berjalan" value={stats.running} tone="text-blue-600" active={statusFilter === 'running'} onClick={() => setStatusFilter('running')} />
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
            <Select value={techFilter} onChange={(e) => setTechFilter(e.target.value)} className="lg:w-48">
              <option value="all">Semua teknisi</option>
              {technicians.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.full_name}
                </option>
              ))}
            </Select>
          </div>
        </>
      )}

      {/* ---------------------------- TEKNISI --------------------------- */}
      {!isManager && !loadError && (
        <>
          <div className="grid grid-cols-3 gap-1.5 bg-slate-100 p-1 rounded-xl">
            {(
              [
                ['active', 'Aktif', techCounts.active],
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
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input placeholder="Cari tugas..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10" />
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
          {visibleJobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              now={now}
              showTechnician={isManager}
              quickAction={quickActionFor(job)}
              onOpen={() => setDetailId(job.id)}
            />
          ))}
          <p className="text-xs text-slate-400 text-center pt-1">{visibleJobs.length} tugas ditampilkan</p>
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
          locationSuggestions={locationSuggestions}
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
