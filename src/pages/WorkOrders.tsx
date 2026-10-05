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
  type WorkOrder,
  type WOStatus,
  type Profile,
  type Department,
  type Area,
  type Equipment,
} from '@/lib/supabase';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { buildIlikeOr } from '@/lib/search';
import { Card, Badge, Button, Input, Select, Label, Modal, Textarea, Spinner, EmptyState } from '@/components/ui';
import { BellRing, Plus, Search } from 'lucide-react';
import {
  WO_ACTION_META,
  fetchPartRequestCounts,
  woActionsFor,
  type WoActionKind,
  type WoPartRequestCounts,
} from '@/lib/actionItems';

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
  const search = useDebouncedValue(searchInput.trim(), 300);
  const [refreshing, setRefreshing] = useState(false);
  const reqSeq = useRef(0);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showCreate, setShowCreate] = useState(false);

  // Create form state
  const [departments, setDepartments] = useState<Department[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [equipmentList, setEquipmentList] = useState<Equipment[]>([]);
  const [spvList, setSpvList] = useState<Profile[]>([]);
  const [userList, setUserList] = useState<Profile[]>([]); // pilihan username untuk peminta
  const [createForm, setCreateForm] = useState({
    department_id: '',
    area_id: '',
    equipment_id: '',
    problem_description: '',
    priority: 'standard' as 'standard' | 'urgent',
    spv_id: '',
    requester_id: '',
    requester_name: '',
    requester_department: '',
  });
  const [creating, setCreating] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false); // SPV: hanya WO dengan dirinya sebagai PIC
  const [onlyAction, setOnlyAction] = useState(false); // hanya WO yang menunggu aksi user
  const [partReqs, setPartReqs] = useState<Record<string, WoPartRequestCounts>>({});

  const loadWorkOrders = useCallback(async () => {
    if (!profile) return;
    // Hanya pemuatan pertama yang menampilkan spinner layar penuh. Spinner pada setiap pencarian
    // membongkar seluruh halaman (termasuk kolom pencarian) sehingga ketikan terputus-putus.
    const seq = ++reqSeq.current;
    setRefreshing(true);

    let query = supabase
      .from('work_orders')
      .select(WO_SELECT)
      .order('created_at', { ascending: false });

    // SPV: filter tambahan hanya saat "PIC Saya". Pada "Semua Departemen" tidak ada filter tambahan
    // karena RLS (migration 033) kini mengizinkan SPV membaca semua WO lintas departemen.
    if (profile.role === 'spv' && onlyMine) {
      query = query.eq('spv_id', profile.id);
    }
    // Teknisi: RLS hanya mengembalikan WO tempat dia ditugaskan (termasuk penugasan bersama).

    if (statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }

    if (search) {
      query = query.or(buildIlikeOr(['wo_number', 'problem_description'], search));
    }

    const [{ data }, reqCounts] = await Promise.all([query, fetchPartRequestCounts(profile)]);
    if (seq !== reqSeq.current) return; // sudah ada permintaan yang lebih baru; abaikan jawaban usang
    setWorkOrders((data as unknown as WorkOrder[]) ?? []);
    setPartReqs(reqCounts);
    setLoading(false);
    setRefreshing(false);
  }, [profile, statusFilter, search, onlyMine]);

  useEffect(() => {
    loadWorkOrders();
  }, [loadWorkOrders]);

  async function loadCreateData() {
    const [{ data: depts }, { data: spvs }, { data: users }] = await Promise.all([
      supabase.from('departments').select('*').order('name'),
      supabase.from('profiles').select('*').in('role', ['spv', 'ss']).eq('is_active', true).order('full_name'),
      supabase.from('profiles').select('*').eq('is_active', true).not('username', 'is', null).order('full_name'),
    ]);
    setDepartments((depts as Department[]) ?? []);
    setSpvList((spvs as Profile[]) ?? []);
    setUserList((users as Profile[]) ?? []);
  }

  async function loadAreas(deptId: string) {
    const { data } = await supabase.from('areas').select('*').eq('department_id', deptId).order('name');
    setAreas((data as Area[]) ?? []);
    setEquipmentList([]);
    setCreateForm((f) => ({ ...f, area_id: '', equipment_id: '' }));
  }

  async function loadEquipment(areaId: string) {
    const { data } = await supabase.from('equipment').select('*').eq('area_id', areaId).order('name');
    setEquipmentList((data as Equipment[]) ?? []);
    setCreateForm((f) => ({ ...f, equipment_id: '' }));
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
    setCreating(true);

    // Nomor WO dibuat di server: WOaa/bbbb/cc/ddddd (tahun/departemen/bulan/urut)
    const { data: woNumber, error: numberError } = await supabase.rpc('next_wo_number', {
      p_department_id: createForm.department_id,
    });
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
      status: createForm.spv_id ? 'assigned' : 'new',
    };
    if (createForm.area_id) insertData.area_id = createForm.area_id;
    if (createForm.equipment_id) insertData.equipment_id = createForm.equipment_id;
    if (createForm.spv_id) insertData.spv_id = createForm.spv_id;
    const reqName = createForm.requester_name.trim();
    const reqDept = createForm.requester_department.trim();
    if (reqName) insertData.requester_name = reqName;
    if (reqDept) insertData.requester_department = reqDept;
    if (createForm.requester_id && reqName) insertData.requester_id = createForm.requester_id;

    const { data, error } = await supabase.from('work_orders').insert(insertData).select().single();

    if (!error && data) {
      // Log history
      await supabase.from('work_order_history').insert({
        work_order_id: data.id,
        status: data.status,
        action: 'WO created',
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
    }

    setCreating(false);
    setShowCreate(false);
    setCreateForm({
      department_id: '',
      area_id: '',
      equipment_id: '',
      problem_description: '',
      priority: 'standard',
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

  // WO yang butuh aksi tampil paling atas; urutan lain tetap (terbaru dulu).
  const visibleWorkOrders = useMemo(() => {
    const list = onlyAction ? workOrders.filter((w) => actionsByWo.has(w.id)) : workOrders;
    return [...list].sort((a, b) => Number(actionsByWo.has(b.id)) - Number(actionsByWo.has(a.id)));
  }, [workOrders, actionsByWo, onlyAction]);

  if (loading) return <Spinner />;

  const canCreate = profile?.role === 'admin' || profile?.role === 'ss';

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search WO number or description..."
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
          <option value="all">All Status</option>
          {(Object.keys(STATUS_LABELS) as WOStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
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
          <Button onClick={() => { loadCreateData(); setShowCreate(true); }}>
            <Plus className="w-4 h-4" />
            New WO
          </Button>
        )}
      </div>

      {/* List */}
      {visibleWorkOrders.length === 0 ? (
        <Card className="p-6">
          <EmptyState message={onlyAction ? 'Tidak ada WO yang menunggu aksi Anda' : 'No work orders found'} />
        </Card>
      ) : (
        <div className={`grid gap-3 transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
          {visibleWorkOrders.map((wo) => {
            const actions = actionsByWo.get(wo.id) ?? [];
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
                    </div>
                    <p className="text-sm text-slate-600 mt-1 line-clamp-2">{wo.problem_description}</p>
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
                  <Badge className={STATUS_COLORS[wo.status] + ' flex-shrink-0'}>
                    {STATUS_LABELS[wo.status]}
                  </Badge>
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-400 flex-wrap">
                  {wo.department && <span>{wo.department.name}</span>}
                  {wo.equipment && <span>• {wo.equipment.name}</span>}
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
              onChange={(e) => {
                setCreateForm((f) => ({ ...f, department_id: e.target.value }));
                loadAreas(e.target.value);
              }}
            >
              <option value="">Select department...</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </Select>
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
                  setCreateForm((f) => ({ ...f, area_id: e.target.value }));
                  loadEquipment(e.target.value);
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
              <Label>Equipment</Label>
              <Select
                value={createForm.equipment_id}
                onChange={(e) => setCreateForm((f) => ({ ...f, equipment_id: e.target.value }))}
                disabled={!equipmentList.length}
              >
                <option value="">Select equipment...</option>
                {equipmentList.map((eq) => (
                  <option key={eq.id} value={eq.id}>{eq.name}</option>
                ))}
              </Select>
            </div>
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
