import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  supabase,
  ROLE_LABELS,
  GR_KIND_LABELS,
  type Role,
  type Department,
  type Area,
  type Equipment,
  type Profile,
  type PartCategory,
  type UnitOfMeasure,
  type PartLocation,
  type InventorySupplier,
} from '@/lib/supabase';
import { normalizeUsername, validatePassword, validateUsername } from '@/lib/authUsername';
import { Card, Badge, Button, Input, Select, Label, Modal, Spinner } from '@/components/ui';
import { Building2, MapPin, Cpu, Users, Plus, Pencil, Trash2, Tag, Ruler, Warehouse, Hash } from 'lucide-react';

type Tab = 'departments' | 'areas' | 'equipment' | 'users' | 'categories' | 'units' | 'locations' | 'suppliers' | 'gr_numbers';
type MasterScope = 'wo' | 'inventory';
type SimpleMaster = 'categories' | 'units' | 'locations' | 'suppliers';
type GRKind = 'credit' | 'cash' | 'import';
const WO_TABS: Tab[] = ['departments', 'areas', 'equipment', 'users'];
const INVENTORY_TABS: Tab[] = ['categories', 'units', 'locations', 'suppliers', 'gr_numbers'];
const SIMPLE_TABLE: Record<SimpleMaster, string> = {
  categories: 'part_categories',
  units: 'units_of_measure',
  locations: 'part_locations',
  suppliers: 'inventory_suppliers',
};
function isSimpleMaster(t: Tab): t is SimpleMaster {
  return t === 'categories' || t === 'units' || t === 'locations' || t === 'suppliers';
}

export default function AdminPanel({ scope }: { scope: MasterScope }) {
  const { profile } = useAuth();
  const [tab, setTab] = useState<Tab>(scope === 'wo' ? 'departments' : 'categories');
  const [loading, setLoading] = useState(true);

  const [departments, setDepartments] = useState<Department[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [equipment, setEquipment] = useState<(Equipment & { area?: Area })[]>([]);
  const [users, setUsers] = useState<Profile[]>([]);
  const [categories, setCategories] = useState<PartCategory[]>([]);
  const [units, setUnits] = useState<UnitOfMeasure[]>([]);
  const [locations, setLocations] = useState<PartLocation[]>([]);
  const [suppliers, setSuppliers] = useState<InventorySupplier[]>([]);
  const [grForm, setGrForm] = useState<Record<GRKind, number>>({ credit: 1, cash: 1, import: 1 });

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<{ type: Tab; id?: string; data?: Record<string, unknown> } | null>(null);
  const [acting, setActing] = useState(false);
  const canEditGrStart = profile?.role === 'admin' || profile?.role === 'ss';

  // Form state
  const [deptForm, setDeptForm] = useState({ name: '', code: '' });
  const [areaForm, setAreaForm] = useState({ name: '' });
  const [equipForm, setEquipForm] = useState({ area_id: '', name: '', code: '' });
  const [userForm, setUserForm] = useState({
    username: '',
    full_name: '',
    role: 'teknisi' as Role,
    department_id: '',
    password: '',
  });
  const [simpleForm, setSimpleForm] = useState({ name: '', code: '' });

  useEffect(() => {
    setTab(scope === 'wo' ? 'departments' : 'categories');
    loadAll();
  }, [scope]);

  async function loadAll() {
    setLoading(true);

    if (scope === 'wo') {
      const [{ data: d }, { data: a }, { data: e }, { data: u }] = await Promise.all([
        supabase.from('departments').select('*').order('name'),
        supabase.from('areas').select('*').order('name'),
        supabase.from('equipment').select('*, area:areas(*)').order('name'),
        supabase.from('profiles').select('*').order('full_name'),
      ]);
      setDepartments((d as Department[]) ?? []);
      setAreas((a as unknown as Area[]) ?? []);
      setEquipment((e as unknown as (Equipment & { area?: Area })[]) ?? []);
      setUsers((u as Profile[]) ?? []);
    } else {
      const [{ data: cat }, { data: un }, { data: loc }, { data: sup }, { data: gr }] = await Promise.all([
        supabase.from('part_categories').select('*').order('name'),
        supabase.from('units_of_measure').select('*').order('name'),
        supabase.from('part_locations').select('*').order('name'),
        supabase.from('inventory_suppliers').select('*').order('name'),
        supabase.rpc('get_gr_start_numbers'),
      ]);
      setCategories((cat as PartCategory[]) ?? []);
      setUnits((un as UnitOfMeasure[]) ?? []);
      setLocations((loc as PartLocation[]) ?? []);
      setSuppliers((sup as InventorySupplier[]) ?? []);

      const next: Record<GRKind, number> = { credit: 1, cash: 1, import: 1 };
      ((gr as { gr_kind: GRKind; start_no: number }[] | null) ?? []).forEach((r) => {
        if (r?.gr_kind && ['credit', 'cash', 'import'].includes(r.gr_kind) && Number.isFinite(r.start_no)) {
          next[r.gr_kind] = r.start_no;
        }
      });
      setGrForm(next);
    }

    setLoading(false);
  }

  function openCreate(type: Tab) {
    if (type === 'departments') setDeptForm({ name: '', code: '' });
    if (type === 'areas') setAreaForm({ name: '' });
    if (type === 'equipment') setEquipForm({ area_id: '', name: '', code: '' });
    if (type === 'users') setUserForm({ username: '', full_name: '', role: 'teknisi', department_id: '', password: '' });
    if (isSimpleMaster(type)) setSimpleForm({ name: '', code: '' });
    setEditing({ type });
    setShowForm(true);
  }

  function openEdit(type: Tab, id: string, data: Record<string, unknown>) {
    if (type === 'departments') setDeptForm({ name: data.name as string, code: data.code as string });
    if (type === 'areas') setAreaForm({ name: data.name as string });
    if (type === 'equipment') setEquipForm({ area_id: data.area_id as string, name: data.name as string, code: (data.code as string) ?? '' });
    if (type === 'users') {
      setUserForm({
        username: (data.username as string) ?? '',
        full_name: data.full_name as string,
        role: data.role as Role,
        department_id: (data.department_id as string) ?? '',
        password: '',
      });
    }
    if (isSimpleMaster(type)) setSimpleForm({ name: data.name as string, code: data.code as string });
    setEditing({ type, id, data });
    setShowForm(true);
  }

  async function handleSave() {
    if (!editing || !profile) return;
    setActing(true);

    if (editing.type === 'departments') {
      if (editing.id) {
        await supabase.from('departments').update(deptForm).eq('id', editing.id);
      } else {
        await supabase.from('departments').insert(deptForm);
      }
    } else if (editing.type === 'areas') {
      if (editing.id) {
        await supabase.from('areas').update({ name: areaForm.name.trim() }).eq('id', editing.id);
      } else {
        await supabase.from('areas').insert({ name: areaForm.name.trim() });
      }
    } else if (editing.type === 'equipment') {
      if (editing.id) {
        await supabase.from('equipment').update({ area_id: equipForm.area_id, name: equipForm.name, code: equipForm.code || null }).eq('id', editing.id);
      } else {
        await supabase.from('equipment').insert({ area_id: equipForm.area_id, name: equipForm.name, code: equipForm.code || null });
      }
    } else if (editing.type === 'users') {
      if (editing.id) {
        if (userForm.password) {
          const passwordError = validatePassword(userForm.password);
          if (passwordError) {
            alert(passwordError);
            setActing(false);
            return;
          }
        }
        const { error: updateError } = await supabase
          .from('profiles')
          .update({
            full_name: userForm.full_name,
            role: userForm.role,
            department_id: userForm.department_id || null,
          })
          .eq('id', editing.id);
        if (updateError) {
          alert(updateError.message);
          setActing(false);
          return;
        }
        if (userForm.password) {
          const { error: pwError } = await supabase.rpc('admin_set_password', {
            p_user_id: editing.id,
            p_password: userForm.password,
          });
          if (pwError) {
            alert('Data user tersimpan, tetapi password gagal diganti: ' + pwError.message);
            setActing(false);
            return;
          }
        }
      } else {
        const uname = normalizeUsername(userForm.username);
        const validationError = validateUsername(uname) ?? validatePassword(userForm.password);
        if (validationError) {
          alert(validationError);
          setActing(false);
          return;
        }
        const { error } = await supabase.rpc('admin_create_user', {
          p_username: uname,
          p_password: userForm.password,
          p_full_name: userForm.full_name,
          p_role: userForm.role,
          p_department_id: userForm.department_id || null,
        });
        if (error) {
          alert(error.message);
          setActing(false);
          return;
        }
      }
    } else if (isSimpleMaster(editing.type)) {
      const table = SIMPLE_TABLE[editing.type];
      if (!simpleForm.name.trim() || !simpleForm.code.trim()) {
        alert('Nama dan kode wajib diisi.');
        setActing(false);
        return;
      }
      const payload = { name: simpleForm.name.trim(), code: simpleForm.code.trim().toUpperCase() };
      const { error } = editing.id
        ? await supabase.from(table).update(payload).eq('id', editing.id)
        : await supabase.from(table).insert(payload);
      if (error) {
        alert(error.message);
        setActing(false);
        return;
      }
    }

    // Log activity
    await supabase.from('activity_log').insert({
      user_id: profile.id,
      action: `manage_${editing.type}`,
      entity_type: editing.type,
      entity_id: editing.id,
      details: `${editing.id ? 'Updated' : 'Created'} ${editing.type}`,
    });

    setActing(false);
    setShowForm(false);
    setEditing(null);
    loadAll();
  }

  async function handleDelete(type: Tab, id: string) {
    if (!confirm(`Delete this ${type.slice(0, -1)}?`)) return;
    if (type === 'departments') await supabase.from('departments').delete().eq('id', id);
    if (type === 'areas') await supabase.from('areas').delete().eq('id', id);
    if (type === 'equipment') await supabase.from('equipment').delete().eq('id', id);
    if (type === 'users') await supabase.from('profiles').delete().eq('id', id);
    if (isSimpleMaster(type)) await supabase.from(SIMPLE_TABLE[type]).delete().eq('id', id);
    loadAll();
  }

  async function saveGrStartNumbers() {
    if (!canEditGrStart) {
      alert('Hanya admin/SS yang dapat mengatur nomor awal GR.');
      return;
    }

    const kinds: GRKind[] = ['credit', 'cash', 'import'];
    for (const kind of kinds) {
      const value = grForm[kind];
      if (!Number.isFinite(value) || value < 1 || value > 99999) {
        alert(`Nomor awal ${GR_KIND_LABELS[kind]} harus antara 1 sampai 99999.`);
        return;
      }
    }

    setActing(true);
    try {
      for (const kind of kinds) {
        const { error } = await supabase.rpc('set_gr_start_number', {
          p_gr_kind: kind,
          p_start_no: Math.floor(grForm[kind]),
        });
        if (error) {
          alert(`Gagal simpan nomor awal ${GR_KIND_LABELS[kind]}: ${error.message}`);
          return;
        }
      }
      alert('Nomor awal GR per jenis berhasil disimpan.');
      await loadAll();
    } finally {
      setActing(false);
    }
  }

  if (loading) return <Spinner />;

  const tabs: { key: Tab; label: string; icon: typeof Building2 }[] = [
    { key: 'departments', label: 'Departments', icon: Building2 },
    { key: 'areas', label: 'Areas', icon: MapPin },
    { key: 'equipment', label: 'Equipment', icon: Cpu },
    { key: 'users', label: 'Users', icon: Users },
    { key: 'categories', label: 'Categories', icon: Tag },
    { key: 'units', label: 'Units', icon: Ruler },
    { key: 'locations', label: 'Locations', icon: Warehouse },
    { key: 'suppliers', label: 'Suppliers', icon: Building2 },
    { key: 'gr_numbers', label: 'GR Numbering', icon: Hash },
  ];
  const visibleTabs = scope === 'wo'
    ? (profile?.role === 'ss' ? WO_TABS.filter((t) => t !== 'users') : WO_TABS)
    : INVENTORY_TABS;

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-slate-100 rounded-lg w-fit overflow-x-auto">
        {tabs.filter((t) => visibleTabs.includes(t.key)).map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-md text-sm font-medium transition whitespace-nowrap ${
                tab === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span className="hidden sm:inline">{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-900">{tabs.find((t) => t.key === tab)?.label}</h3>
          {tab !== 'gr_numbers' && (
            <Button size="sm" onClick={() => openCreate(tab)}>
              <Plus className="w-4 h-4" /> Add
            </Button>
          )}
        </div>

        {tab === 'departments' && (
          <div className="space-y-2">
            {departments.map((d) => (
              <div key={d.id} className="flex items-center justify-between p-3 rounded-lg bg-slate-50">
                <div>
                  <p className="text-sm font-medium text-slate-900">{d.name}</p>
                  <p className="text-xs text-slate-400">{d.code}</p>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => openEdit('departments', d.id, d)} className="p-2 text-slate-500 hover:bg-slate-200 rounded-lg">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete('departments', d.id)} className="p-2 text-red-500 hover:bg-red-100 rounded-lg">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
            {departments.length === 0 && <p className="text-sm text-slate-400 py-4 text-center">No departments yet</p>}
          </div>
        )}

        {tab === 'areas' && (
          <div className="space-y-2">
            {areas.map((a) => (
              <div key={a.id} className="flex items-center justify-between p-3 rounded-lg bg-slate-50">
                <p className="text-sm font-medium text-slate-900">{a.name}</p>
                <div className="flex gap-1">
                  <button onClick={() => openEdit('areas', a.id, a)} className="p-2 text-slate-500 hover:bg-slate-200 rounded-lg">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete('areas', a.id)} className="p-2 text-red-500 hover:bg-red-100 rounded-lg">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
            {areas.length === 0 && <p className="text-sm text-slate-400 py-4 text-center">No areas yet</p>}
          </div>
        )}

        {tab === 'equipment' && (
          <div className="space-y-2">
            {equipment.map((eq) => (
              <div key={eq.id} className="flex items-center justify-between p-3 rounded-lg bg-slate-50">
                <div>
                  <p className="text-sm font-medium text-slate-900">{eq.name}</p>
                  <p className="text-xs text-slate-400">
                    {eq.area?.name ?? '-'}
                  </p>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => openEdit('equipment', eq.id, eq)} className="p-2 text-slate-500 hover:bg-slate-200 rounded-lg">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete('equipment', eq.id)} className="p-2 text-red-500 hover:bg-red-100 rounded-lg">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
            {equipment.length === 0 && <p className="text-sm text-slate-400 py-4 text-center">No equipment yet</p>}
          </div>
        )}

        {tab === 'users' && (
          <div className="space-y-2">
            {users.map((u) => (
              <div key={u.id} className="flex items-center justify-between p-3 rounded-lg bg-slate-50">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-slate-900">{u.full_name || '(no name)'}</p>
                    <Badge className={
                      u.role === 'admin' ? 'bg-red-100 text-red-700 border-red-200' :
                      u.role === 'ss' ? 'bg-purple-100 text-purple-700 border-purple-200' :
                      u.role === 'spv' ? 'bg-blue-100 text-blue-700 border-blue-200' :
                      u.role === 'inventory' ? 'bg-teal-100 text-teal-700 border-teal-200' :
                      'bg-slate-100 text-slate-600 border-slate-200'
                    }>
                      {ROLE_LABELS[u.role]}
                    </Badge>
                    {!u.is_active && <Badge className="bg-gray-200 text-gray-500 border-gray-300">Inactive</Badge>}
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5 truncate">{u.username ? `@${u.username}` : u.id}</p>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <button onClick={() => openEdit('users', u.id, u)} className="p-2 text-slate-500 hover:bg-slate-200 rounded-lg">
                    <Pencil className="w-4 h-4" />
                  </button>
                  {u.id !== profile?.id && (
                    <button onClick={() => handleDelete('users', u.id)} className="p-2 text-red-500 hover:bg-red-100 rounded-lg">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
            {users.length === 0 && <p className="text-sm text-slate-400 py-4 text-center">No users yet</p>}
          </div>
        )}

        {(tab === 'categories' || tab === 'units' || tab === 'locations' || tab === 'suppliers') && (() => {
          const list = tab === 'categories' ? categories : tab === 'units' ? units : tab === 'locations' ? locations : suppliers;
          return (
            <div className="space-y-2">
              {list.map((m) => (
                <div key={m.id} className="flex items-center justify-between p-3 rounded-lg bg-slate-50">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{m.name}</p>
                    <p className="text-xs text-slate-400">{m.code}</p>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(tab, m.id, m as unknown as Record<string, unknown>)} className="p-2 text-slate-500 hover:bg-slate-200 rounded-lg">
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleDelete(tab, m.id)} className="p-2 text-red-500 hover:bg-red-100 rounded-lg">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
              {list.length === 0 && <p className="text-sm text-slate-400 py-4 text-center">Belum ada data</p>}
            </div>
          );
        })()}

        {tab === 'gr_numbers' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">Nomor awal GR diatur terpisah untuk setiap jenis. Nomor GR berikutnya = nomor GR tersimpan tertinggi tahun ini + 1; nomor awal hanya berlaku jika lebih besar dari itu (mis. untuk melanjutkan dari dokumen kertas), jadi tidak akan menabrak nomor yang sudah ada.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(['credit', 'cash', 'import'] as GRKind[]).map((kind) => (
                <div key={kind}>
                  <Label>{GR_KIND_LABELS[kind]}</Label>
                  <Input
                    type="number"
                    min={1}
                    max={99999}
                    value={grForm[kind]}
                    disabled={!canEditGrStart || acting}
                    onChange={(e) => setGrForm((prev) => ({ ...prev, [kind]: Number(e.target.value || 1) }))}
                  />
                </div>
              ))}
            </div>
            {!canEditGrStart && <p className="text-xs text-slate-400">Hanya admin/SS yang dapat mengubah setting nomor awal GR.</p>}
            <div className="flex justify-end">
              <Button onClick={saveGrStartNumbers} disabled={!canEditGrStart || acting}>
                {acting ? 'Saving...' : 'Simpan Nomor Awal GR'}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Form Modal */}
      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editing?.id ? `Edit ${editing.type.slice(0, -1)}` : `Add ${editing?.type.slice(0, -1)}`}
      >
        <div className="space-y-4">
          {editing?.type === 'departments' && (
            <>
              <div>
                <Label>Name *</Label>
                <Input value={deptForm.name} onChange={(e) => setDeptForm((f) => ({ ...f, name: e.target.value }))} placeholder="MTC" />
              </div>
              <div>
                <Label>Code *</Label>
                <Input value={deptForm.code} onChange={(e) => setDeptForm((f) => ({ ...f, code: e.target.value }))} placeholder="MTC" />
              </div>
            </>
          )}

          {editing && isSimpleMaster(editing.type) && (
            <>
              <div>
                <Label>Name *</Label>
                <Input value={simpleForm.name} onChange={(e) => setSimpleForm((f) => ({ ...f, name: e.target.value }))} placeholder="Bearing" />
              </div>
              <div>
                <Label>Code *</Label>
                <Input value={simpleForm.code} onChange={(e) => setSimpleForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} placeholder="BRG" />
                <p className="text-xs text-slate-400 mt-1">Kode ini dipakai sebagai awalan nomor kode part otomatis.</p>
              </div>
            </>
          )}

          {editing?.type === 'areas' && (
            <>
              <div>
                <Label>Area Name *</Label>
                <Input value={areaForm.name} onChange={(e) => setAreaForm((f) => ({ ...f, name: e.target.value }))} placeholder="Plant 1 Area A" />
              </div>
            </>
          )}

          {editing?.type === 'equipment' && (
            <>
              <div>
                <Label>Area *</Label>
                <Select value={equipForm.area_id} onChange={(e) => setEquipForm((f) => ({ ...f, area_id: e.target.value }))}>
                  <option value="">Select area...</option>
                  {areas.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>Equipment Name *</Label>
                <Input value={equipForm.name} onChange={(e) => setEquipForm((f) => ({ ...f, name: e.target.value }))} placeholder="Motor 1" />
              </div>
              <div>
                <Label>Code</Label>
                <Input value={equipForm.code} onChange={(e) => setEquipForm((f) => ({ ...f, code: e.target.value }))} placeholder="MTR-001" />
              </div>
            </>
          )}

          {editing?.type === 'users' && (
            <>
              {!editing.id && (
                <div>
                  <Label>Username *</Label>
                  <Input value={userForm.username} onChange={(e) => setUserForm((f) => ({ ...f, username: e.target.value }))} placeholder="budi.teknisi" autoCapitalize="none" />
                </div>
              )}
              <div>
                <Label>Full Name *</Label>
                <Input value={userForm.full_name} onChange={(e) => setUserForm((f) => ({ ...f, full_name: e.target.value }))} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Role</Label>
                  <Select value={userForm.role} onChange={(e) => setUserForm((f) => ({ ...f, role: e.target.value as Role }))}>
                    <option value="admin">Admin</option>
                    <option value="ss">Senior Supervisor</option>
                    <option value="spv">SPV</option>
                    <option value="teknisi">Teknisi</option>
                    <option value="inventory">Inventory Control</option>
                  </Select>
                </div>
                <div>
                  <Label>Department</Label>
                  <Select value={userForm.department_id} onChange={(e) => setUserForm((f) => ({ ...f, department_id: e.target.value }))}>
                    <option value="">None</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </Select>
                </div>
              </div>
              <div>
                <Label>{editing.id ? 'Password baru (kosongkan jika tidak diganti)' : 'Password *'}</Label>
                <Input type="password" value={userForm.password} onChange={(e) => setUserForm((f) => ({ ...f, password: e.target.value }))} placeholder="Min 6 karakter, huruf dan angka" autoComplete="new-password" />
              </div>
            </>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={acting}>
              {acting ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
