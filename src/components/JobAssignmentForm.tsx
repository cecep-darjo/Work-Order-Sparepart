import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { STATUS_LABELS as WO_STATUS_LABELS, supabase, type Area, type Equipment, type WOStatus } from '@/lib/supabase';
import { Button, Input, Label, Modal, Select, Textarea } from '@/components/ui';
import { MultiPicker, SearchablePicker, type MultiOption, type PickerOption } from '@/components/Pickers';
import {
  JOB_PRIORITY_COLORS,
  JOB_PRIORITY_LABELS,
  JOB_STATUS_LABELS,
  defaultDeadlineValue,
  jobErrorMessage,
  toLocalInputValue,
  type JobAssignment,
  type JobPerson,
  type JobPriority,
  type JobStatus,
} from '@/lib/jobAssignments';

const PRIORITIES: JobPriority[] = ['low', 'normal', 'high', 'urgent'];
const ACTIVE_WO_STATUSES: WOStatus[] = ['assigned', 'analysis', 'on_progress', 'pending'];
const COMPLETED_JOB_STATUSES: JobStatus[] = ['done', 'approved'];

type ActiveWorkOrder = {
  id: string;
  wo_number: string;
  problem_description: string;
  status: WOStatus;
};

type CompletedJob = { id: string; job_no: string; title: string; status: JobStatus; done_at: string };

/**
 * Form penugasan. `job` terisi = mode ubah (hanya untuk tugas yang belum final);
 * mengganti teknisi mengembalikan status tugas ke "Ditugaskan" (diatur trigger database).
 */
export default function JobAssignmentForm({
  job,
  technicians,
  activeCounts,
  onClose,
  onSaved,
}: {
  job: JobAssignment | null;
  technicians: JobPerson[];
  /** technician_id -> jumlah tugas aktif, untuk membantu pemerataan beban. */
  activeCounts: Record<string, number>;
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
}) {
  const { profile } = useAuth();
  const editing = !!job;

  const [title, setTitle] = useState(job?.title ?? '');
  const [description, setDescription] = useState(job?.description ?? '');
  const [location, setLocation] = useState(job?.location ?? '');
  const [areaId, setAreaId] = useState('');
  const [areas, setAreas] = useState<Area[]>([]);
  const [equipmentId, setEquipmentId] = useState(job?.equipment_id ?? '');
  const [manualEquipment, setManualEquipment] = useState(job?.manual_equipment ?? '');
  const [equipmentOptions, setEquipmentOptions] = useState<(Equipment & { area?: { name: string } | null })[]>([]);
  const [loadingEquipment, setLoadingEquipment] = useState(true);
  const [technicianIds, setTechnicianIds] = useState<string[]>(() => {
    const ids = job?.assigned_technicians?.map((member) => member.technician_id) ?? [];
    if (job?.technician_id) return [job.technician_id, ...ids.filter((id) => id !== job.technician_id)];
    return ids;
  });
  const [deadline, setDeadline] = useState(job ? toLocalInputValue(job.deadline) : defaultDeadlineValue());
  const [priority, setPriority] = useState<JobPriority>(job?.priority ?? 'normal');
  const [saving, setSaving] = useState(false);
  const [activeWorkOrders, setActiveWorkOrders] = useState<ActiveWorkOrder[]>([]);
  const [loadingWorkOrders, setLoadingWorkOrders] = useState(false);
  const [workOrderError, setWorkOrderError] = useState<string | null>(null);
  const [completedTodayJobs, setCompletedTodayJobs] = useState<CompletedJob[]>([]);
  const [loadingCompletedToday, setLoadingCompletedToday] = useState(false);
  const [completedTodayError, setCompletedTodayError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      supabase.from('equipment').select('id, area_id, name, code, created_at, area:areas(name)').order('name'),
      supabase.from('areas').select('*').order('name'),
    ]).then(([equipmentRes, areaRes]) => {
      if (cancelled) return;
      if (equipmentRes.error) console.error('Gagal memuat daftar mesin target:', equipmentRes.error.message);
      const nextEquipment = (equipmentRes.data as unknown as (Equipment & { area?: { name: string } | null })[]) ?? [];
      const nextAreas = (areaRes.data as Area[] | null) ?? [];
      setEquipmentOptions(nextEquipment);
      setAreas(nextAreas);
      if (job) {
        const currentEquipment = nextEquipment.find((eq) => eq.id === job.equipment_id);
        const currentArea = nextAreas.find((area) => area.id === currentEquipment?.area_id || area.name === job.location);
        if (currentArea) setAreaId(currentArea.id);
      }
      setLoadingEquipment(false);
    });
    return () => { cancelled = true; };
  }, []);

  const equipmentPickerOptions = useMemo<PickerOption[]>(() => equipmentOptions
    .filter((eq) => !areaId || eq.area_id === areaId)
    .map((eq) => ({
      value: eq.id,
      label: eq.name,
      sublabel: [eq.code, eq.area?.name].filter(Boolean).join(' • '),
      search: [eq.name, eq.code, eq.area?.name].filter(Boolean).join(' '),
    })), [areaId, equipmentOptions]);

  useEffect(() => {
    if (technicianIds.length === 0) {
      setActiveWorkOrders([]);
      setWorkOrderError(null);
      setLoadingWorkOrders(false);
      return;
    }

    let cancelled = false;
    setLoadingWorkOrders(true);
    setWorkOrderError(null);
    supabase
      .from('work_orders')
      .select('id, wo_number, problem_description, status, technicians:work_order_technicians!inner(technician_id)')
      .in('status', ACTIVE_WO_STATUSES)
      .in('technicians.technician_id', technicianIds)
      .order('updated_at', { ascending: false })
      .limit(20)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setWorkOrderError(error.message);
          setActiveWorkOrders([]);
        } else {
          const unique = new Map<string, ActiveWorkOrder>();
          for (const wo of (data as unknown as ActiveWorkOrder[]) ?? []) unique.set(wo.id, wo);
          setActiveWorkOrders([...unique.values()]);
        }
        setLoadingWorkOrders(false);
      });

    return () => {
      cancelled = true;
    };
  }, [technicianIds]);

  useEffect(() => {
    if (technicianIds.length === 0) {
      setCompletedTodayJobs([]);
      setCompletedTodayError(null);
      setLoadingCompletedToday(false);
      return;
    }
    let cancelled = false;
    setLoadingCompletedToday(true);
    setCompletedTodayError(null);
    const jakartaDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
    const dayStart = new Date(`${jakartaDay}T00:00:00+07:00`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    supabase
      .from('job_assignments')
      .select('id, job_no, title, status, done_at, assigned_technicians:job_assignment_technicians!inner(technician_id)')
      .in('assigned_technicians.technician_id', technicianIds)
      .in('status', COMPLETED_JOB_STATUSES)
      .gte('done_at', dayStart.toISOString())
      .lt('done_at', dayEnd.toISOString())
      .order('done_at', { ascending: false })
      .limit(100)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setCompletedTodayError(error.message);
          setCompletedTodayJobs([]);
        } else {
          const unique = new Map<string, CompletedJob>();
          for (const completedJob of (data as unknown as CompletedJob[]) ?? []) unique.set(completedJob.id, completedJob);
          setCompletedTodayJobs([...unique.values()]);
        }
        setLoadingCompletedToday(false);
      });
    return () => { cancelled = true; };
  }, [technicianIds]);

  const technicianChanged = editing && (technicianIds[0] ?? null) !== job.technician_id;
  const resetsProgress = technicianChanged && job.status !== 'assigned';

  async function handleSave() {
    if (!profile) return;
    if (!title.trim()) return alert('Judul tugas wajib diisi.');
    if (!areaId || !location.trim()) return alert('Lokasi wajib diisi.');
    if (!deadline) return alert('Deadline wajib diisi.');
    const deadlineDate = new Date(deadline);
    if (Number.isNaN(deadlineDate.getTime())) return alert('Deadline tidak valid.');
    if (!editing && deadlineDate.getTime() < Date.now()) return alert('Deadline tidak boleh di masa lalu.');

    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        location: location.trim(),
        equipment_id: manualEquipment.trim() ? null : (equipmentId || null),
        manual_equipment: manualEquipment.trim() || null,
        technician_id: technicianIds[0] ?? null,
        deadline: deadlineDate.toISOString(),
        priority,
      };
      if (editing) {
        const { error } = await supabase.from('job_assignments').update(payload).eq('id', job.id);
        if (error) throw error;
        const { data: currentMembers, error: memberLoadError } = await supabase
          .from('job_assignment_technicians')
          .select('technician_id')
          .eq('job_id', job.id);
        if (memberLoadError) throw memberLoadError;
        const currentIds = ((currentMembers as { technician_id: string }[] | null) ?? []).map((member) => member.technician_id);
        const additions = technicianIds.filter((id) => !currentIds.includes(id));
        if (additions.length) {
          const { error: addError } = await supabase.from('job_assignment_technicians').insert(
            additions.map((technician_id) => ({ job_id: job.id, technician_id }))
          );
          if (addError) throw addError;
        }
        const removals = currentIds.filter((id) => !technicianIds.includes(id));
        for (const technician_id of removals) {
          const { error: removeError } = await supabase
            .from('job_assignment_technicians')
            .delete()
            .eq('job_id', job.id)
            .eq('technician_id', technician_id);
          if (removeError) throw removeError;
        }
        await onSaved('Penugasan berhasil diperbarui.');
      } else {
        const { data: created, error } = await supabase
          .from('job_assignments')
          .insert({ ...payload, created_by: profile.id })
          .select('id')
          .single();
        if (error) throw error;
        const remainingMembers = technicianIds.slice(1);
        if (remainingMembers.length) {
          const { error: memberError } = await supabase.from('job_assignment_technicians').insert(
            remainingMembers.map((technician_id) => ({ job_id: created.id, technician_id }))
          );
          if (memberError) throw memberError;
        }
        await onSaved('Penugasan berhasil dibuat.');
      }
    } catch (e) {
      alert('Gagal menyimpan penugasan: ' + jobErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={editing ? `Ubah Penugasan ${job.job_no}` : 'Buat Penugasan Baru'} maxWidth="max-w-xl">
      <div className="space-y-4">
        <div>
          <Label>Judul tugas *</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Mis. Ganti bearing motor conveyor" maxLength={150} autoFocus />
        </div>

        <div>
          <Label>Deskripsi / instruksi</Label>
          <Textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Detail pekerjaan, alat yang dibawa, catatan keselamatan..."
          />
        </div>

        <div>
          <Label>Lokasi / Area pekerjaan *</Label>
          <Select
            value={areaId}
            onChange={(e) => {
              const nextAreaId = e.target.value;
              setAreaId(nextAreaId);
              const selectedArea = areas.find((area) => area.id === nextAreaId);
              setLocation(selectedArea?.name ?? '');
              setEquipmentId('');
            }}
            disabled={loadingEquipment}
          >
            <option value="">— Pilih lokasi —</option>
            {areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
          </Select>
          <p className="mt-1 text-xs text-slate-500">Pilih lokasi untuk membatasi daftar mesin.</p>
        </div>

        <div>
          <Label>Mesin target yang akan diperbaiki (opsional)</Label>
          <SearchablePicker
            inline
            value={manualEquipment.trim() ? '' : equipmentId}
            options={equipmentPickerOptions}
            placeholder={loadingEquipment ? 'Memuat daftar mesin...' : areaId ? 'Cari & pilih mesin target...' : 'Pilih lokasi terlebih dahulu'}
            searchPlaceholder="Cari nama, kode, atau lokasi mesin..."
            emptyText="Mesin target tidak ditemukan. Anda dapat mengisi nama secara manual di bawah."
            disabled={loadingEquipment || !areaId || equipmentPickerOptions.length === 0}
            onChange={(selectedId) => {
              setEquipmentId(selectedId);
              setManualEquipment('');
            }}
          />
          <div className="mt-2">
            <Input
              value={manualEquipment}
              onChange={(e) => {
                setManualEquipment(e.target.value);
                if (e.target.value.trim()) setEquipmentId('');
              }}
              placeholder="Atau ketik nama mesin target secara manual..."
              maxLength={200}
            />
          </div>
          {equipmentId && !equipmentPickerOptions.some((eq) => eq.value === equipmentId) && (
            <p className="mt-1 text-xs text-amber-600">Mesin target yang tersimpan tidak sesuai dengan lokasi pilihan. Pilih lokasi lain.</p>
          )}
          {!loadingEquipment && areaId && equipmentPickerOptions.length === 0 && (
            <p className="mt-1 text-xs text-amber-600">Belum ada mesin target di lokasi ini. Nama mesin dapat diisi manual.</p>
          )}
        </div>

        <div>
          <Label>Teknisi (opsional)</Label>
          <MultiPicker
            value={technicianIds}
            onChange={setTechnicianIds}
            placeholder="Cari dan pilih teknisi, atau biarkan kosong..."
            options={technicians.filter((t) => (activeCounts[t.id] ?? 0) === 0 || technicianIds.includes(t.id)).map((t): MultiOption => ({
              value: t.id,
              label: t.full_name,
              sublabel: `${activeCounts[t.id] ?? 0} tugas aktif`,
            }))}
          />
          <p className="text-xs text-slate-500 mt-1">Penugasan dapat disimpan tanpa teknisi dan ditugaskan kemudian.</p>
          {technicians.length === 0 && (
            <p className="text-xs text-amber-600 mt-1">Belum ada user aktif dengan role Teknisi.</p>
          )}
          {technicians.length > 0 && technicians.every((t) => (activeCounts[t.id] ?? 0) > 0) && technicianIds.length === 0 && (
            <p className="text-xs text-amber-600 mt-1">Semua teknisi sedang memiliki Jobs Assignment aktif.</p>
          )}
          {technicianIds.length > 0 && (
            <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold text-slate-700">WO aktif teknisi ini</p>
              {loadingWorkOrders ? (
                <p className="mt-1 text-xs text-slate-500">Memuat Work Order...</p>
              ) : workOrderError ? (
                <p className="mt-1 text-xs text-red-600">Gagal memuat Work Order: {workOrderError}</p>
              ) : activeWorkOrders.length === 0 ? (
                <p className="mt-1 text-xs text-slate-500">Tidak ada Work Order aktif untuk teknisi ini.</p>
              ) : (
                <ul className="mt-1 space-y-1.5">
                  {activeWorkOrders.map((wo) => (
                    <li key={wo.id} className="text-xs text-slate-600">
                      <span className="font-medium text-slate-800">{wo.wo_number}</span>
                      <span className="mx-1">•</span>
                      <span>{WO_STATUS_LABELS[wo.status]}</span>
                      <span className="mx-1">•</span>
                      <span>{wo.problem_description}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {technicianIds.length > 0 && (
            <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 p-3">
              <p className="text-xs font-semibold text-blue-800">Histori Jobs Assignment terselesaikan hari ini</p>
              {loadingCompletedToday ? (
                <p className="mt-1 text-xs text-slate-500">Memuat histori Jobs Assignment...</p>
              ) : completedTodayError ? (
                <p className="mt-1 text-xs text-red-600">Gagal memuat histori Jobs Assignment: {completedTodayError}</p>
              ) : completedTodayJobs.length === 0 ? (
                <p className="mt-1 text-xs text-slate-500">Tidak ada Jobs Assignment yang diselesaikan teknisi ini hari ini.</p>
              ) : (
                <ul className="mt-1 space-y-1.5">
                  {completedTodayJobs.map((completedJob) => (
                    <li key={completedJob.id} className="text-xs text-slate-700">
                      <span className="font-medium text-slate-900">{completedJob.job_no}</span>
                      <span className="mx-1">•</span>
                      <span>{JOB_STATUS_LABELS[completedJob.status]}</span>
                      <span className="mx-1">•</span>
                      <span>{completedJob.title}</span>
                      <span className="ml-1 text-slate-500">({new Date(completedJob.done_at).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })})</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {technicianChanged && (
            <p className="text-xs text-amber-600 mt-1">
              {resetsProgress
                ? 'Mengganti teknisi mengembalikan status ke "Ditugaskan"; catatan laporan teknisi sebelumnya dihapus (foto tetap tersimpan).'
                : 'Teknisi akan diganti dan riwayat penggantian dicatat.'}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label>Deadline *</Label>
            <Input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </div>
          <div>
            <Label>Prioritas</Label>
            <div className="grid grid-cols-4 gap-1.5">
              {PRIORITIES.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={`px-1 py-2.5 rounded-lg border text-xs font-medium transition ${
                    priority === p
                      ? `${JOB_PRIORITY_COLORS[p]} ring-2 ring-offset-1 ring-blue-500`
                      : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {JOB_PRIORITY_LABELS[p]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Batal
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Menyimpan...' : editing ? 'Simpan Perubahan' : 'Tugaskan'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
