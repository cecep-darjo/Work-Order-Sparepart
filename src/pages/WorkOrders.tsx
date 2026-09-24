import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  supabase,
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
import { Card, Badge, Button, Input, Select, Label, Modal, Textarea, Spinner, EmptyState } from '@/components/ui';
import { Plus, Search } from 'lucide-react';

export default function WorkOrders({
  onSelectWO,
}: {
  onSelectWO: (id: string) => void;
}) {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showCreate, setShowCreate] = useState(false);

  // Create form state
  const [departments, setDepartments] = useState<Department[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [equipmentList, setEquipmentList] = useState<Equipment[]>([]);
  const [spvList, setSpvList] = useState<Profile[]>([]);
  const [techList, setTechList] = useState<Profile[]>([]);
  const [createForm, setCreateForm] = useState({
    department_id: '',
    area_id: '',
    equipment_id: '',
    problem_description: '',
    priority: 'medium' as 'low' | 'medium' | 'high' | 'urgent',
    spv_id: '',
    technician_id: '',
  });
  const [creating, setCreating] = useState(false);

  const loadWorkOrders = useCallback(async () => {
    if (!profile) return;
    setLoading(true);

    let query = supabase
      .from('work_orders')
      .select('*, department:departments(*), area:areas(*), equipment:equipment(*), spv:profiles!spv_id(*), technician:profiles!technician_id(*)')
      .order('created_at', { ascending: false });

    if (profile.role === 'spv') {
      query = query.eq('department_id', profile.department_id);
    } else if (profile.role === 'teknisi') {
      query = query.eq('technician_id', profile.id);
    }

    if (statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }

    if (search) {
      query = query.or(`wo_number.ilike.%${search}%,problem_description.ilike.%${search}%`);
    }

    const { data } = await query;
    setWorkOrders((data as unknown as WorkOrder[]) ?? []);
    setLoading(false);
  }, [profile, statusFilter, search]);

  useEffect(() => {
    loadWorkOrders();
  }, [loadWorkOrders]);

  async function loadCreateData() {
    const [{ data: depts }, { data: spvs }, { data: techs }] = await Promise.all([
      supabase.from('departments').select('*').order('name'),
      supabase.from('profiles').select('*').eq('role', 'spv').eq('is_active', true).order('full_name'),
      supabase.from('profiles').select('*').eq('role', 'teknisi').eq('is_active', true).order('full_name'),
    ]);
    setDepartments((depts as Department[]) ?? []);
    setSpvList((spvs as Profile[]) ?? []);
    setTechList((techs as Profile[]) ?? []);
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
    if (createForm.technician_id) {
      insertData.technician_id = createForm.technician_id;
      insertData.status = 'assigned';
    }

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
      priority: 'medium',
      spv_id: '',
      technician_id: '',
    });
    loadWorkOrders();
  }

  if (loading) return <Spinner />;

  const canCreate = profile?.role === 'admin';

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search WO number or description..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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
        {canCreate && (
          <Button onClick={() => { loadCreateData(); setShowCreate(true); }}>
            <Plus className="w-4 h-4" />
            New WO
          </Button>
        )}
      </div>

      {/* List */}
      {workOrders.length === 0 ? (
        <Card className="p-6">
          <EmptyState message="No work orders found" />
        </Card>
      ) : (
        <div className="grid gap-3">
          {workOrders.map((wo) => (
            <Card key={wo.id} className="p-4 hover:shadow-md transition-shadow cursor-pointer" >
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
                  </div>
                  <Badge className={STATUS_COLORS[wo.status] + ' flex-shrink-0'}>
                    {STATUS_LABELS[wo.status]}
                  </Badge>
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-400 flex-wrap">
                  {wo.department && <span>{wo.department.name}</span>}
                  {wo.equipment && <span>• {wo.equipment.name}</span>}
                  {wo.technician && <span>• Tech: {wo.technician.full_name}</span>}
                  <span>• {new Date(wo.created_at).toLocaleDateString()}</span>
                </div>
              </button>
            </Card>
          ))}
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
              onChange={(e) => setCreateForm((f) => ({ ...f, priority: e.target.value as 'low' | 'medium' | 'high' | 'urgent' }))}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
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
            </div>
            <div>
              <Label>Technician</Label>
              <Select
                value={createForm.technician_id}
                onChange={(e) => setCreateForm((f) => ({ ...f, technician_id: e.target.value }))}
              >
                <option value="">Select technician...</option>
                {techList.map((t) => (
                  <option key={t.id} value={t.id}>{t.full_name}</option>
                ))}
              </Select>
            </div>
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
