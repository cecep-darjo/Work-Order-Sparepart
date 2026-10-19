import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  supabase,
  WO_SELECT,
  woTechnicians,
  STATUS_LABELS,
  STATUS_COLORS,
  PRIORITY_LABELS,
  PRIORITY_COLORS,
  WORK_TYPES,
  WORK_TYPE_LABELS,
  type WorkOrder,
  type WOStatus,
  type Profile,
  type Department,
  type Area,
  type Equipment,
} from '@/lib/supabase';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { matchesQuery, SearchablePicker, type PickerOption } from '@/components/Pickers';
import { JOB_STATUS_LABELS, type JobStatus } from '@/lib/jobAssignments';
import { Card, Badge, Button, Input, Select, Label, Modal, Textarea, Spinner, EmptyState } from '@/components/ui';
import { ArrowDown, ArrowUp, BellRing, ClipboardCheck, Plus, Search } from 'lucide-react';
import {
  WO_ACTION_META,
  fetchPartRequestCounts,
  woActionsFor,
  type WoActionKind,
  type WoPartRequestCounts,
} from '@/lib/actionItems';

type SortKey = 'created_at' | 'updated_at' | 'wo_number' | 'status' | 'priority' | 'department';
type LinkableJob = {
  id: string;
  job_no: string;
  title: string;
  description: string | null;
  status: JobStatus;
  technician_id: string | null;
  equipment_id: string | null;
  report_notes: string | null;
  equipment?: { id: string; area_id: string | null } | null;
  assigned_technicians?: { technician_id: string; technician?: { full_name: string } | null }[];
};
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'created_at', label: 'Tanggal Dibuat' },
  { key: 'updated_at', label: 'Terakhir Diperbarui' },
  { key: 'wo_number', label: 'No. WO' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Prioritas' },
  { key: 'department', label: 'Departemen' },
];
// Urutan alur kerja WO (untuk sort Status) dan peringkat prioritas (urgent lebih dulu saat "naik").
const STATUS_ORDER: WOStatus[] = ['new', 'assigned', 'analysis', 'on_progress', 'pending', 'done', 'verified', 'closed', 'canceled'];
const PRIORITY_RANK: Record<string, number> = { urgent: 0, standard: 1 };

/**
 * Ambil SEMUA work order yang boleh dilihat user (RLS tetap berlaku), melewati batas ±1.000
 * baris/query PostgREST dengan pagination `.range()`. Urutan memakai created_at lalu id agar
 * pagination stabil (created_at kembar tidak membuat baris terlewat/ganda).
 */
async function fetchAllWorkOrders(): Promise<{ rows: WorkOrder[]; error: string | null }> {
  const chunk = 1000;
  const all: WorkOrder[] = [];
  for (let offset = 0; ; offset += chunk) {
    const { data, error } = await supabase
      .from('work_orders')
      .select(WO_SELECT)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + chunk - 1);
    if (error) return { rows: all, error: error.message };
    const rows = (data as unknown as WorkOrder[]) ?? [];
    all.push(...rows);
    if (rows.length < chunk) break;
  }
  return { rows: all, error: null };
}

export default function WorkOrders({
  onSelectWO,
}: {
  onSelectWO: (id: string) => void;
}) {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  // Teks di kolom pencarian langsung berubah; query ke server memakai nilai yang sudah ditunda (debounce).
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput.trim(), 250);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reqSeq = useRef(0);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  // Default: tanggal dibuat, terbaru dulu.
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [showCreate, setShowCreate] = useState(false);

  // Create form state
  const [departments, setDepartments] = useState<Department[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [equipmentList, setEquipmentList] = useState<Equipment[]>([]);
  const [linkableJobs, setLinkableJobs] = useState<LinkableJob[]>([]);
  const [spvList, setSpvList] = useState<Profile[]>([]);
  const [userList, setUserList] = useState<Profile[]>([]); // pilihan username untuk peminta
  const [createForm, setCreateForm] = useState({
    department_id: '',
    area_id: '',
    equipment_id: '',
    job_assignment_id: '',
    manual_wo_suffix: '',
    problem_description: '',
    priority: 'standard' as 'standard' | 'urgent',
    work_types: [] as string[],
    spv_id: '',
    requester_id: '',
    requester_name: '',
    requester_department: '',
  });
  const [creating, setCreating] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false); // SPV: hanya WO dengan dirinya sebagai PIC
  const [onlyAction, setOnlyAction] = useState(false); // hanya WO yang menunggu aksi user
  const [partReqs, setPartReqs] = useState<Record<string, WoPartRequestCounts>>({});
  // WO yang punya permintaan part berstatus 'pending' (menunggu approval); tampil untuk semua role.
  const [waitingPartWo, setWaitingPartWo] = useState<Set<string>>(new Set());

  const loadWorkOrders = useCallback(async () => {
    if (!profile) return;
    // Hanya pemuatan pertama yang menampilkan spinner layar penuh. Pencarian, filter, dan urutan
    // dikerjakan di sisi klien dari data yang sudah dimuat, jadi tidak ada query per ketikan.
    const seq = ++reqSeq.current;
    setRefreshing(true);

    // SPV melihat semua WO lintas departemen (RLS migration 033); teknisi hanya WO yang ditugaskan.
    const [{ rows, error }, reqCounts, { data: pendingRows }] = await Promise.all([
      fetchAllWorkOrders(),
      fetchPartRequestCounts(profile),
      // RLS tetap berlaku: user hanya mendapat permintaan pada WO yang boleh ia lihat.
      supabase.from('wo_part_requests').select('work_order_id').eq('status', 'pending').limit(1000),
    ]);
    if (seq !== reqSeq.current) return; // sudah ada permintaan yang lebih baru; abaikan jawaban usang
    setWorkOrders(rows);
    setLoadError(error);
    setPartReqs(reqCounts);
    setWaitingPartWo(new Set(((pendingRows as { work_order_id: string }[]) ?? []).map((r) => r.work_order_id)));
    setLoading(false);
    setRefreshing(false);
  }, [profile]);

  useEffect(() => {
    loadWorkOrders();
  }, [loadWorkOrders]);

  async function loadCreateData() {
    const [{ data: allDepts }, { data: spvs }, { data: users }, { data: areaRows }, { data: equipmentRows }, { data: jobs }, { data: linkedWos }] = await Promise.all([
      supabase.from('departments').select('*').order('name'),
      supabase.from('profiles').select('*').in('role', ['spv', 'ss']).eq('is_active', true).order('full_name'),
      supabase.from('profiles').select('*').eq('is_active', true).not('username', 'is', null).order('full_name'),
      supabase.from('areas').select('*').order('name'), // area terlepas dari departemen
      supabase.from('equipment').select('*').order('name'),
      supabase.from('job_assignments')
        .select('id, job_no, title, description, status, technician_id, equipment_id, report_notes, equipment:equipment(id, area_id), assigned_technicians:job_assignment_technicians(technician_id, technician:profiles!technician_id(full_name))')
        .in('status', ['assigned', 'on_the_way', 'in_progress', 'done', 'approved'])
        .order('created_at', { ascending: false })
        .limit(500),
      supabase.from('work_orders').select('job_assignment_id').not('job_assignment_id', 'is', null),
    ]);
    let depts = allDepts ?? [];
    if (profile?.role === 'ss' || profile?.role === 'spv') {
      const { data: assignments } = await supabase.from('profile_departments').select('department_id').eq('profile_id', profile.id);
      const allowedIds = new Set([...(assignments ?? []).map((row) => row.department_id as string), ...(profile.department_id ? [profile.department_id] : [])]);
      depts = depts.filter((department) => allowedIds.has(department.id));
    }
    setAreas((areaRows as Area[]) ?? []);
    setEquipmentList((equipmentRows as Equipment[]) ?? []);
    const linkedJobIds = new Set(((linkedWos ?? []) as { job_assignment_id: string }[]).map((row) => row.job_assignment_id));
    setLinkableJobs(((jobs ?? []) as unknown as LinkableJob[]).filter((job) => !linkedJobIds.has(job.id)));
    setDepartments((depts as Department[]) ?? []);
    setSpvList((spvs as Profile[]) ?? []);
    setUserList((users as Profile[]) ?? []);
  }

  // Pilih peminta dari username -> nama & departemen terisi otomatis (tetap bisa diubah manual).
  function pickRequester(userId: string) {
    const u = userList.find((x) => x.id === userId);
    if (!u) {
      setCreateForm((f) => ({ ...f, requester_id: '' })); // "Isi manual": nilai yang sudah diketik dipertahankan
      return;
    }
    const deptName = departments.find((d) => d.id === u.department_id)?.name ?? '';
    setCreateForm((f) => ({ ...f, requester_id: u.id, requester_name: u.full_name, requester_department: deptName }));
  }

  async function handleCreate() {
    if (!profile || !createForm.department_id || !createForm.problem_description) return;
    const manualSuffix = createForm.manual_wo_suffix.trim();
    if (manualSuffix && (!/^\d+$/.test(manualSuffix) || Number(manualSuffix) < 1 || Number(manualSuffix) > 2147483647)) {
      alert('Nomor urut WO harus berupa angka lebih besar dari 0.');
      return;
    }
    setCreating(true);

    // Prefix tetap dibuat server; admin/SS/SPV boleh mengisi angka urut terakhir secara manual.
    const { data: woNumber, error: numberError } = manualSuffix
      ? await supabase.rpc('reserve_manual_wo_number', {
          p_department_id: createForm.department_id,
          p_suffix: Number(manualSuffix),
        })
      : await supabase.rpc('next_wo_number', { p_department_id: createForm.department_id });
    if (numberError || !woNumber) {
      alert('Gagal membuat nomor WO: ' + (numberError?.message ?? 'nomor kosong'));
      setCreating(false);
      return;
    }

    const insertData: Record<string, unknown> = {
      wo_number: woNumber,
      department_id: createForm.department_id,
      problem_description: createForm.problem_description,
      priority: createForm.priority,
      work_types: createForm.work_types,
      status: createForm.spv_id ? 'assigned' : 'new',
    };
    if (createForm.job_assignment_id) insertData.job_assignment_id = createForm.job_assignment_id;
    if (createForm.area_id) insertData.area_id = createForm.area_id;
    if (createForm.equipment_id) insertData.equipment_id = createForm.equipment_id;
    if (createForm.spv_id) insertData.spv_id = createForm.spv_id;
    const reqName = createForm.requester_name.trim();
    const reqDept = createForm.requester_department.trim();
    if (reqName) insertData.requester_name = reqName;
    if (reqDept) insertData.requester_department = reqDept;
    if (createForm.requester_id && reqName) insertData.requester_id = createForm.requester_id;

    const { data, error } = await supabase.from('work_orders').insert(insertData).select().single();

    if (error || !data) {
      alert(error?.code === '23505' && manualSuffix
        ? `Nomor WO dengan urutan ${manualSuffix} sudah digunakan. Pilih angka lain.`
        : 'Gagal membuat Work Order: ' + (error?.message ?? 'data WO tidak tersimpan'));
      setCreating(false);
      return;
    }

    // Log history
    await supabase.from('work_order_history').insert({
      work_order_id: data.id,
      status: data.status,
      action: data.status === 'closed' ? 'WO created and closed from approved Jobs Assignment' : 'WO created',
      notes: createForm.job_assignment_id ? `Jobs Assignment terkait: ${linkableJobs.find((job) => job.id === createForm.job_assignment_id)?.job_no ?? ''}` : null,
      performed_by: profile.id,
    });
    // Activity log
    await supabase.from('activity_log').insert({
      user_id: profile.id,
      action: 'create_wo',
      entity_type: 'work_order',
      entity_id: data.id,
      details: `Created ${woNumber}`,
    });

    setCreating(false);
    setShowCreate(false);
    setCreateForm({
      department_id: '',
      area_id: '',
      equipment_id: '',
      job_assignment_id: '',
      manual_wo_suffix: '',
      problem_description: '',
      priority: 'standard',
      work_types: [],
      spv_id: '',
      requester_id: '',
      requester_name: '',
      requester_department: '',
    });
    loadWorkOrders();
  }

  // Aksi yang menunggu user ini pada tiap WO (assignment, approval part, verifikasi, dst.).
  const actionsByWo = useMemo(() => {
    const map = new Map<string, WoActionKind[]>();
    if (!profile) return map;
    for (const wo of workOrders) {
      const acts = woActionsFor(wo, profile, partReqs[wo.id]);
      if (acts.length) map.set(wo.id, acts);
    }
    return map;
  }, [workOrders, partReqs, profile]);

  // Teks pencarian tiap WO dihitung sekali per pemuatan data (bukan per ketikan).
  // Mencakup: no. WO, deskripsi, departemen, area, mesin, peminta, PIC, teknisi, jenis kerja,
  // prioritas, status, alasan pending/cancel, serta analisis/tindakan/hasil pengerjaan.
  const haystacks = useMemo(() => {
    const m = new Map<string, string>();
    for (const wo of workOrders) {
      m.set(
        wo.id,
        [
          wo.wo_number,
          wo.problem_description,
          wo.department?.name,
          wo.department?.code,
          wo.area?.name,
          wo.equipment?.name,
          wo.equipment?.code,
          wo.requester_name,
          wo.requester_department,
          wo.spv?.full_name,
          ...woTechnicians(wo).map((t) => t.full_name),
          ...(wo.work_types ?? []).map((t) => WORK_TYPE_LABELS[t] ?? t),
          PRIORITY_LABELS[wo.priority],
          STATUS_LABELS[wo.status],
          wo.pending_reason,
          wo.cancel_reason,
          wo.analysis,
          wo.action_taken,
          wo.result,
        ]
          .filter(Boolean)
          .join(' ')
      );
    }
    return m;
  }, [workOrders]);

  // Pilihan departemen diambil dari WO yang sudah dimuat (tanpa query tambahan).
  const deptOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const wo of workOrders) if (wo.department) m.set(wo.department.id, wo.department.name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: 'base' }));
  }, [workOrders]);

  // Semua filter KECUALI status; dipakai juga untuk hitungan per status di dropdown.
  const baseFiltered = useMemo(() => {
    const fromTs = createdFrom ? new Date(`${createdFrom}T00:00:00`).getTime() : null;
    const toTs = createdTo ? new Date(`${createdTo}T23:59:59.999`).getTime() : null;
    return workOrders.filter((wo) => {
      if (profile?.role === 'spv' && onlyMine && wo.spv_id !== profile.id) return false;
      if (onlyAction && !actionsByWo.has(wo.id)) return false;
      if (priorityFilter !== 'all' && wo.priority !== priorityFilter) return false;
      if (typeFilter !== 'all' && !(wo.work_types ?? []).includes(typeFilter)) return false;
      if (deptFilter !== 'all' && wo.department_id !== deptFilter) return false;
      if (fromTs !== null || toTs !== null) {
        const ts = new Date(wo.created_at).getTime();
        if (fromTs !== null && ts < fromTs) return false;
        if (toTs !== null && ts > toTs) return false;
      }
      // Metode sama dengan pencarian spare part: semua kata harus cocok, urutan bebas.
      if (search && !matchesQuery(haystacks.get(wo.id) ?? '', search)) return false;
      return true;
    });
  }, [workOrders, haystacks, actionsByWo, profile, onlyMine, onlyAction, priorityFilter, typeFilter, deptFilter, createdFrom, createdTo, search]);

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const wo of baseFiltered) c[wo.status] = (c[wo.status] ?? 0) + 1;
    return c;
  }, [baseFiltered]);

  // Urutan tampilan. Pada urutan bawaan (Tanggal Dibuat, terbaru dulu) WO yang butuh aksi user
  // tetap tampil paling atas; bila user memilih urutan lain, urutan mengikuti pilihan itu saja.
  const visibleWorkOrders = useMemo(() => {
    const list = statusFilter === 'all' ? baseFiltered : baseFiltered.filter((w) => w.status === statusFilter);
    const dir = sortDir === 'asc' ? 1 : -1;
    const pinActions = sortKey === 'created_at' && sortDir === 'desc';
    const time = (v: string | null | undefined) => (v ? new Date(v).getTime() : 0);
    const text = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    return [...list].sort((a, b) => {
      if (pinActions) {
        const pin = Number(actionsByWo.has(b.id)) - Number(actionsByWo.has(a.id));
        if (pin !== 0) return pin;
      }
      let r = 0;
      switch (sortKey) {
        case 'created_at':
          r = time(a.created_at) - time(b.created_at);
          break;
        case 'updated_at':
          r = time(a.updated_at) - time(b.updated_at);
          break;
        case 'wo_number':
          r = text(a.wo_number, b.wo_number);
          break;
        case 'status':
          r = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
          break;
        case 'priority':
          r = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
          break;
        case 'department':
          r = text(a.department?.name ?? '', b.department?.name ?? '');
          break;
      }
      // Seri: yang terbaru dibuat lebih dulu.
      return r * dir || time(b.created_at) - time(a.created_at);
    });
  }, [baseFiltered, statusFilter, sortKey, sortDir, actionsByWo]);

  const hasFilter = Boolean(
    search || statusFilter !== 'all' || priorityFilter !== 'all' || typeFilter !== 'all' ||
      deptFilter !== 'all' || createdFrom || createdTo || onlyAction
  );

  function resetFilters() {
    setSearchInput('');
    setStatusFilter('all');
    setPriorityFilter('all');
    setTypeFilter('all');
    setDeptFilter('all');
    setCreatedFrom('');
    setCreatedTo('');
    setOnlyAction(false);
  }

  const equipmentPickerOptions = useMemo<PickerOption[]>(() => equipmentList
    .filter((equipment) => !createForm.area_id || equipment.area_id === createForm.area_id)
    .map((equipment) => {
      const areaName = areas.find((area) => area.id === equipment.area_id)?.name;
      return {
        value: equipment.id,
        label: equipment.name,
        sublabel: [equipment.code, areaName].filter(Boolean).join(' • '),
        search: [equipment.name, equipment.code, areaName].filter(Boolean).join(' '),
      };
    }), [areas, createForm.area_id, equipmentList]);
  const jobAssignmentPickerOptions = useMemo<PickerOption[]>(() => linkableJobs.map((job) => {
    const technicianNames = job.assigned_technicians?.map((member) => member.technician?.full_name).filter(Boolean).join(', ')
      || (job.technician_id ? 'Teknisi ditugaskan' : 'Menunggu teknisi');
    const statusLabel = JOB_STATUS_LABELS[job.status];
    return {
      value: job.id,
      label: `${job.job_no} — ${job.title}`,
      sublabel: `${statusLabel} · ${technicianNames}`,
      search: `${job.job_no} ${job.title} ${statusLabel} ${technicianNames}`,
    };
  }), [linkableJobs]);

  if (loading) return <Spinner />;

  const canCreate = profile?.role === 'admin' || profile?.role === 'ss' || profile?.role === 'spv';
  const woDateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta', year: '2-digit', month: '2-digit',
  }).formatToParts(new Date());
  const woYear = woDateParts.find((part) => part.type === 'year')?.value ?? '';
  const woMonth = woDateParts.find((part) => part.type === 'month')?.value ?? '';
  const selectedDepartmentCode = (departments.find((department) => department.id === createForm.department_id)?.code ?? '')
    .replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const woNumberPrefix = selectedDepartmentCode ? `WO${woYear}/${selectedDepartmentCode}/${woMonth}/` : '';
  const woSuffixPreview = createForm.manual_wo_suffix
    ? String(Number(createForm.manual_wo_suffix)).padStart(5, '0')
    : 'otomatis';

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Cari no. WO, deskripsi, departemen, mesin, peminta, teknisi..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="sm:w-48"
        >
          <option value="all">All Status ({baseFiltered.length})</option>
          {(Object.keys(STATUS_LABELS) as WOStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]} ({statusCounts[s] ?? 0})
            </option>
          ))}
        </Select>
        {profile?.role === 'spv' && (
          <Button variant={onlyMine ? 'primary' : 'secondary'} onClick={() => setOnlyMine((v) => !v)}>
            {onlyMine ? 'PIC Saya' : 'Semua Departemen'}
          </Button>
        )}
        {(actionsByWo.size > 0 || onlyAction) && (
          <Button variant={onlyAction ? 'primary' : 'secondary'} onClick={() => setOnlyAction((v) => !v)}>
            <BellRing className="w-4 h-4" />
            Perlu Tindakan ({actionsByWo.size})
          </Button>
        )}
        {canCreate && (
          <Button onClick={() => {
            loadCreateData();
            if (profile?.role === 'spv') setCreateForm((form) => ({ ...form, spv_id: profile.id }));
            setShowCreate(true);
          }}>
            <Plus className="w-4 h-4" />
            New WO
          </Button>
        )}
      </div>

      {/* Filter lanjutan & urutan */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-2 items-end">
        <div>
          <Label>Prioritas</Label>
          <Select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
            <option value="all">Semua</option>
            {Object.keys(PRIORITY_LABELS).map((k) => (
              <option key={k} value={k}>{PRIORITY_LABELS[k]}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Jenis Kerja</Label>
          <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">Semua</option>
            {WORK_TYPES.map((t) => (
              <option key={t} value={t}>{WORK_TYPE_LABELS[t]}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Departemen</Label>
          <Select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
            <option value="all">Semua</option>
            {deptOptions.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Dibuat dari</Label>
          <Input type="date" value={createdFrom} max={createdTo || undefined} onChange={(e) => setCreatedFrom(e.target.value)} />
        </div>
        <div>
          <Label>Dibuat sampai</Label>
          <Input type="date" value={createdTo} min={createdFrom || undefined} onChange={(e) => setCreatedTo(e.target.value)} />
        </div>
        <div>
          <Label>Urutkan</Label>
          <div className="flex gap-1">
            <Select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} aria-label="Urutkan berdasarkan">
              {SORT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </Select>
            <button
              type="button"
              onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
              className="px-3 border border-slate-300 rounded-lg bg-white text-slate-600 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              title={sortDir === 'asc' ? 'Naik (A-Z / terlama) — klik untuk membalik' : 'Turun (Z-A / terbaru) — klik untuk membalik'}
              aria-label="Balik arah urutan"
            >
              {sortDir === 'asc' ? <ArrowUp className="w-4 h-4" /> : <ArrowDown className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 text-xs text-slate-500 flex-wrap">
        <span>Menampilkan {visibleWorkOrders.length} dari {workOrders.length} WO</span>
        <span className="flex items-center gap-3">
          {hasFilter && (
            <button type="button" className="text-blue-600 hover:text-blue-700 font-medium" onClick={resetFilters}>
              Reset filter
            </button>
          )}
          <button
            type="button"
            className="text-slate-500 hover:text-slate-800 font-medium disabled:opacity-50"
            onClick={loadWorkOrders}
            disabled={refreshing}
          >
            {refreshing ? 'Memuat...' : 'Muat ulang'}
          </button>
        </span>
      </div>

      {loadError && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          Sebagian data WO gagal dimuat ({loadError}). Daftar di bawah mungkin belum lengkap — coba "Muat ulang".
        </div>
      )}

      {/* List */}
      {visibleWorkOrders.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            message={
              workOrders.length === 0
                ? 'No work orders found'
                : onlyAction && !search && statusFilter === 'all'
                ? 'Tidak ada WO yang menunggu aksi Anda'
                : 'Tidak ada WO yang cocok dengan pencarian/filter'
            }
          />
        </Card>
      ) : (
        <div className={`grid gap-3 transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
          {visibleWorkOrders.map((wo) => {
            const actions = actionsByWo.get(wo.id) ?? [];
            // WO yang sudah selesai/dibatalkan tidak lagi menunggu approval part.
            const waitingPart =
              waitingPartWo.has(wo.id) && !['verified', 'closed', 'canceled'].includes(wo.status);
            return (
            <Card
              key={wo.id}
              className={`p-4 hover:shadow-md transition-shadow cursor-pointer ${
                actions.length > 0 ? 'border-l-4 border-l-amber-400 bg-amber-50/30' : ''
              }`}
            >
              <button onClick={() => onSelectWO(wo.id)} className="w-full text-left">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-900 text-sm">{wo.wo_number}</span>
                      <Badge className={PRIORITY_COLORS[wo.priority]}>
                        {PRIORITY_LABELS[wo.priority]}
                      </Badge>
                      {(wo.work_types ?? []).map((t) => (
                        <Badge key={t} className="bg-indigo-100 text-indigo-700 border-indigo-200">
                          {WORK_TYPE_LABELS[t] ?? t}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-sm text-slate-600 mt-1 line-clamp-2">{wo.problem_description}</p>
                    {wo.status === 'pending' && wo.pending_reason && (
                      <p className="text-xs text-orange-600 bg-orange-50 border border-orange-200 rounded-md px-2.5 py-1.5 mt-2">
                        <span className="font-semibold">Alasan Pending:</span> {wo.pending_reason}
                      </p>
                    )}
                    {wo.status === 'canceled' && wo.cancel_reason && (
                      <p className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-2.5 py-1.5 mt-2">
                        <span className="font-semibold">Alasan Cancel:</span> {wo.cancel_reason}
                      </p>
                    )}
                    {actions.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {actions.map((kind) => {
                          const meta = WO_ACTION_META[kind];
                          const Icon = meta.icon;
                          return (
                            <span
                              key={kind}
                              className="inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-300 text-amber-800 px-2.5 py-0.5 text-xs font-semibold"
                            >
                              <Icon className="w-3 h-3" />
                              {meta.chip}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-end gap-2 flex-wrap flex-shrink-0">
                    {waitingPart && (
                      <Badge className="bg-amber-100 text-amber-800 border-amber-300 inline-flex items-center gap-1">
                        <ClipboardCheck className="w-3 h-3" />
                        Menunggu Approval Part
                      </Badge>
                    )}
                    <Badge className={STATUS_COLORS[wo.status] + ' flex-shrink-0'}>
                      {STATUS_LABELS[wo.status]}
                    </Badge>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-400 flex-wrap">
                  {wo.department && <span>{wo.department.name}</span>}
                  {wo.area && <span>• {wo.area.name}</span>}
                  {wo.equipment && <span>• {wo.equipment.name}</span>}
                  {wo.job_assignment && <span>• JA: {wo.job_assignment.job_no}</span>}
                  {wo.requester_name && <span>• Peminta: {wo.requester_name}</span>}
                  {profile?.role === 'spv' && (
                    <span>
                      • PIC: {wo.spv_id === profile.id ? <b className="text-blue-600">Anda</b> : (wo.spv?.full_name ?? '-')}
                    </span>
                  )}
                  {woTechnicians(wo).length > 0 && (
                    <span>• Tech: {woTechnicians(wo).map((t) => t.full_name).join(', ')}</span>
                  )}
                  <span>• {new Date(wo.created_at).toLocaleDateString()}</span>
                </div>
              </button>
            </Card>
            );
          })}
        </div>
      )}

      {/* Create Modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create Work Order" maxWidth="max-w-2xl">
        <div className="space-y-4">
          <div>
            <Label>Department *</Label>
            <Select
              value={createForm.department_id}
              onChange={(e) => setCreateForm((f) => ({ ...f, department_id: e.target.value }))}
            >
              <option value="">Select department...</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </Select>
          </div>

          <div>
            <Label>Nomor urut belakang (opsional)</Label>
            <Input
              value={createForm.manual_wo_suffix}
              onChange={(e) => setCreateForm((form) => ({ ...form, manual_wo_suffix: e.target.value.replace(/\D/g, '').slice(0, 10) }))}
              inputMode="numeric"
              placeholder="Kosongkan untuk nomor otomatis"
            />
            <p className="mt-1 text-xs text-slate-500">
              Hanya angka bagian akhir yang dapat diisi. Preview: {woNumberPrefix || 'pilih departemen untuk melihat prefix'}{woSuffixPreview}
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 p-3 space-y-3">
            <div>
              <Label>Peminta</Label>
              <Select value={createForm.requester_id} onChange={(e) => pickRequester(e.target.value)}>
                <option value="">Isi manual (tanpa username)</option>
                {userList.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name} (@{u.username})
                  </option>
                ))}
              </Select>
              <p className="text-xs text-slate-400 mt-1">Pilih username untuk mengisi otomatis, atau ketik langsung di bawah.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Nama Peminta</Label>
                <Input
                  value={createForm.requester_name}
                  onChange={(e) =>
                    setCreateForm((f) => {
                      const linked = userList.find((u) => u.id === f.requester_id);
                      // Nama diubah manual -> tidak lagi sama dengan user terpilih, lepas keterkaitannya.
                      const keep = linked && linked.full_name === e.target.value;
                      return { ...f, requester_name: e.target.value, requester_id: keep ? f.requester_id : '' };
                    })
                  }
                  placeholder="Nama orang yang meminta WO"
                />
              </div>
              <div>
                <Label>Departemen Peminta</Label>
                <Input
                  value={createForm.requester_department}
                  onChange={(e) => setCreateForm((f) => ({ ...f, requester_department: e.target.value }))}
                  placeholder="Departemen asal peminta"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Area</Label>
              <Select
                value={createForm.area_id}
                onChange={(e) => {
                  setCreateForm((f) => ({ ...f, area_id: e.target.value, equipment_id: '' }));
                }}
                disabled={!areas.length}
              >
                <option value="">Select area...</option>
                {areas.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Mesin Target</Label>
              <SearchablePicker
                inline
                value={createForm.equipment_id}
                options={equipmentPickerOptions}
                placeholder="Cari & pilih mesin target..."
                searchPlaceholder="Cari nama, kode, atau area mesin..."
                emptyText="Mesin target tidak ditemukan."
                disabled={equipmentPickerOptions.length === 0}
                onChange={(equipmentId) => {
                  const selectedEquipment = equipmentList.find((equipment) => equipment.id === equipmentId);
                  setCreateForm((form) => ({
                    ...form,
                    equipment_id: equipmentId,
                    ...(selectedEquipment && !form.area_id ? { area_id: selectedEquipment.area_id } : {}),
                  }));
                }}
              />
              {equipmentPickerOptions.length === 0 && (
                <p className="mt-1 text-xs text-slate-500">Belum ada mesin target untuk area ini.</p>
              )}
            </div>
          </div>

          <div>
            <Label>Jobs Assignment (opsional)</Label>
            <SearchablePicker
              inline
              value={createForm.job_assignment_id}
              options={jobAssignmentPickerOptions}
              placeholder="Cari & pilih Jobs Assignment..."
              searchPlaceholder="Cari nomor, judul, status, atau teknisi..."
              emptyText="Tidak ada Jobs Assignment aktif atau selesai yang tersedia."
              onChange={(job_assignment_id) => {
                const job = linkableJobs.find((item) => item.id === job_assignment_id);
                setCreateForm((form) => ({
                  ...form,
                  job_assignment_id,
                  ...(job ? {
                    area_id: job.equipment?.area_id ?? '',
                    equipment_id: job.equipment_id ?? '',
                    problem_description: [job.title, job.description].filter((part) => part?.trim()).join('\n'),
                  } : {}),
                }));
              }}
            />
            <p className="mt-1 text-xs text-slate-500">WO akan otomatis ditutup setelah Jobs Assignment terkait disetujui.</p>
          </div>

          <div>
            <Label>Problem Description *</Label>
            <Textarea
              rows={3}
              value={createForm.problem_description}
              onChange={(e) => setCreateForm((f) => ({ ...f, problem_description: e.target.value }))}
              placeholder="Describe the problem..."
            />
          </div>

          <div>
            <Label>Jenis Pekerjaan</Label>
            <div className="flex flex-wrap gap-3 mt-2">
              {WORK_TYPES.map((t) => (
                <label key={t} className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createForm.work_types.includes(t)}
                    onChange={(e) =>
                      setCreateForm((f) => ({
                        ...f,
                        work_types: e.target.checked
                          ? [...f.work_types, t]
                          : f.work_types.filter((x) => x !== t),
                      }))
                    }
                    className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  {WORK_TYPE_LABELS[t] ?? t}
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-1">Boleh pilih lebih dari satu.</p>
          </div>

          <div>
            <Label>Priority</Label>
            <Select
              value={createForm.priority}
              onChange={(e) => setCreateForm((f) => ({ ...f, priority: e.target.value as 'standard' | 'urgent' }))}
            >
              <option value="standard">Standard</option>
              <option value="urgent">Urgent</option>
            </Select>
          </div>

          <div>
            <Label>SPV</Label>
            <Select
              value={createForm.spv_id}
              onChange={(e) => setCreateForm((f) => ({ ...f, spv_id: e.target.value }))}
              disabled={profile?.role === 'spv'}
            >
              <option value="">Select SPV...</option>
              {spvList.map((s) => (
                <option key={s.id} value={s.id}>{s.full_name}</option>
              ))}
            </Select>
            <p className="text-xs text-slate-400 mt-1">
              Penugasan teknisi dilakukan oleh SPV yang ditunjuk, dari halaman detail WO.
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || !createForm.department_id || !createForm.problem_description}>
              {creating ? 'Creating...' : 'Create WO'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
