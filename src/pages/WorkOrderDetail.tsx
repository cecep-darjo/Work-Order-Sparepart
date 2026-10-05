import { uuid } from '@/lib/uuid';
import { useEffect, useState, useCallback, useMemo } from 'react';
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
  type Department,
  type Area,
  type Equipment,
  type WorkOrderHistory,
  type WorkOrderPart,
  type Profile,
  type SparePart,
  type InventoryGroup,
  type WOStatus,
} from '@/lib/supabase';
import { Card, Badge, Button, Select, Textarea, Label, Spinner, Modal, Input } from '@/components/ui';
import { MultiPicker, SearchablePicker } from '@/components/Pickers';
import { PartRequestCard } from '@/components/PartRequests';
import { PR_SELECT, type PartRequest } from '@/lib/partRequests';
import { downloadWoCompletionReport } from '@/lib/woReportPdf';
import { fetchWoHistory, fmtWoTime, woWorkTimes } from '@/lib/woHistory';
import { ArrowLeft, UserCog, Play, Pause, CheckCircle2, RotateCcw, Lock, Unlock, Package, Plus, Trash2, Pencil, History as HistoryIcon, FileDown, ImagePlus, X, XCircle, Undo2 } from 'lucide-react';

const WO_PHOTO_MAX_BYTES = 500 * 1024;
const ALLOWED_WO_PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp'];

function filterWoPhotoFiles(files: File[], existing: File[]): File[] {
  const next: File[] = [];
  for (const f of files) {
    if (f.size > WO_PHOTO_MAX_BYTES) {
      alert(`File ${f.name} melebihi 500KB.`);
      continue;
    }
    if (!ALLOWED_WO_PHOTO_MIME.includes(f.type)) {
      alert(`Tipe file ${f.name} tidak didukung. Hanya JPG/PNG/WEBP.`);
      continue;
    }
    const duplicate = [...existing, ...next].some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified);
    if (!duplicate) next.push(f);
  }
  return next;
}

export default function WorkOrderDetail({
  woId,
  onBack,
}: {
  woId: string;
  onBack: () => void;
}) {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [wo, setWo] = useState<WorkOrder | null>(null);
  const [history, setHistory] = useState<WorkOrderHistory[]>([]);
  const workTimes = useMemo(() => woWorkTimes(history, wo?.status ?? ''), [history, wo?.status]);
  const [parts, setParts] = useState<WorkOrderPart[]>([]);
  const [techList, setTechList] = useState<Profile[]>([]);
  const [spvList, setSpvList] = useState<Profile[]>([]);
  const [spareParts, setSpareParts] = useState<SparePart[]>([]);
  const [groups, setGroups] = useState<InventoryGroup[]>([]);
  const [requests, setRequests] = useState<PartRequest[]>([]);
  const [draft, setDraft] = useState<{ spare_part_id: string; quantity: number; note: string }[]>([]);
  const [purpose, setPurpose] = useState('');
  const [partNote, setPartNote] = useState('');

  // Action form state
  const [analysis, setAnalysis] = useState('');
  const [actionTaken, setActionTaken] = useState('');
  const [result, setResult] = useState('');
  const [pendingReason, setPendingReason] = useState('');
  const [selectedPart, setSelectedPart] = useState('');
  const [partQty, setPartQty] = useState(1);
  const [assignTechs, setAssignTechs] = useState<string[]>([]);
  const [assignSpv, setAssignSpv] = useState('');
  const [interventionReason, setInterventionReason] = useState('');
  const [showIntervention, setShowIntervention] = useState(false);
  const [interventionStatus, setInterventionStatus] = useState<WOStatus>('new');
  const [acting, setActing] = useState(false);
  const [woPhotoFiles, setWoPhotoFiles] = useState<File[]>([]);

  // Edit / delete (admin)
  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({
    department_id: '',
    area_id: '',
    equipment_id: '',
    problem_description: '',
    priority: 'standard' as WorkOrder['priority'],
    work_types: [] as string[],
    spv_id: '',
    // Khusus admin: tanggal WO, isi hasil pekerjaan, dan alasan perubahan
    date_created: '',
    analysis: '',
    action_taken: '',
    result: '',
    pending_reason: '',
    reason: '',
  });
  const [deptList, setDeptList] = useState<Department[]>([]);
  const [areaList, setAreaList] = useState<Area[]>([]);
  const [equipList, setEquipList] = useState<Equipment[]>([]);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showReactivate, setShowReactivate] = useState(false);
  const [reactivateReason, setReactivateReason] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);

    const { data: woData } = await supabase
      .from('work_orders')
      .select(WO_SELECT)
      .eq('id', woId)
      .maybeSingle();
    setWo(woData as unknown as WorkOrder);
    setAnalysis(woData?.analysis ?? '');
    setActionTaken(woData?.action_taken ?? '');
    setResult(woData?.result ?? '');
    setPendingReason(woData?.pending_reason ?? '');

    setHistory(await fetchWoHistory(woId));

    const { data: partsData } = await supabase
      .from('work_order_parts')
      .select('*, spare_part:spare_parts(*)')
      .eq('work_order_id', woId)
      .order('created_at', { ascending: false });
    setParts((partsData as unknown as WorkOrderPart[]) ?? []);

    const { data: reqData } = await supabase
      .from('wo_part_requests')
      .select(PR_SELECT)
      .eq('work_order_id', woId)
      .order('requested_at', { ascending: false });
    setRequests((reqData as unknown as PartRequest[]) ?? []);

    const [{ data: techs }, { data: spvs }, { data: sp }, { data: grp }] = await Promise.all([
      supabase.from('profiles').select('*').eq('role', 'teknisi').eq('is_active', true).order('full_name'),
      supabase.from('profiles').select('*').in('role', ['spv', 'ss']).eq('is_active', true).order('full_name'),
      supabase.from('spare_parts').select('*').order('name'),
      supabase.from('inventory_groups').select('*').order('name'),
    ]);
    setGroups((grp as InventoryGroup[]) ?? []);
    setTechList((techs as Profile[]) ?? []);
    setSpvList((spvs as Profile[]) ?? []);
    setSpareParts((sp as SparePart[]) ?? []);
    setAssignTechs(woTechnicians(woData as unknown as WorkOrder).map((t) => t.id));
    setAssignSpv(woData?.spv_id ?? '');

    setLoading(false);
  }, [woId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function logHistory(woId: string, status: string, action: string, notes?: string) {
    if (!profile) return;
    await supabase.from('work_order_history').insert({
      work_order_id: woId,
      status,
      action,
      notes: notes ?? null,
      performed_by: profile.id,
    });
  }

  async function logActivity(action: string, details: string, reason?: string) {
    if (!profile) return;
    await supabase.from('activity_log').insert({
      user_id: profile.id,
      action,
      entity_type: 'work_order',
      entity_id: woId,
      details,
      reason: reason ?? null,
    });
  }

  async function updateStatus(newStatus: WOStatus, action: string, extraData?: Record<string, unknown>, notes?: string): Promise<boolean> {
    if (!profile || !wo) return false;
    setActing(true);

    try {
      const updateData: Record<string, unknown> = { status: newStatus, updated_at: new Date().toISOString() };
      if (extraData) Object.assign(updateData, extraData);
      if (newStatus === 'closed') updateData.closed_at = new Date().toISOString();
      if (newStatus !== 'pending') updateData.pending_reason = null;

      const { error } = await supabase.from('work_orders').update(updateData).eq('id', wo.id);
      if (error) {
        alert('Gagal mengubah status WO: ' + error.message);
        return false;
      }

      await logHistory(wo.id, newStatus, action, notes);
      await logActivity(action, `${wo.wo_number}: ${action}`, notes);
      await loadData();
      return true;
    } finally {
      setActing(false);
    }
  }

  async function handleGenerateReport() {
    if (!profile) return;
    setActing(true);
    try {
      const [{ data: woData }, hist, { data: partsData }] = await Promise.all([
        supabase.from('work_orders').select(WO_SELECT).eq('id', woId).maybeSingle(),
        fetchWoHistory(woId),
        supabase
          .from('work_order_parts')
          .select('*, spare_part:spare_parts(*)')
          .eq('work_order_id', woId)
          .order('created_at', { ascending: false }),
      ]);

      const woReport = woData as unknown as WorkOrder | null;
      if (!woReport) {
        alert('Data WO tidak ditemukan.');
        return;
      }

      const usedParts = (partsData as unknown as WorkOrderPart[]) ?? [];
      const verifiedEvent = [...hist]
        .filter((h) => h.status === 'verified' || (h.action ?? '').toLowerCase().includes('verified'))
        .sort((a, b) => new Date(b.performed_at).getTime() - new Date(a.performed_at).getTime())[0];

      await downloadWoCompletionReport({
        wo: woReport,
        parts: usedParts,
        history: hist,
        technicians: woTechnicians(woReport).map((t) => t.full_name),
        verifiedBy: verifiedEvent?.performer?.full_name ?? woReport.spv?.full_name ?? null,
        verifiedAt: verifiedEvent?.performed_at ?? null,
        generatedBy: profile.full_name,
      });
    } catch (e) {
      alert('Gagal membuat report PDF: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setActing(false);
    }
  }

  async function handleVerifyAndGenerateReport() {
    const ok = await updateStatus('verified', 'WO verified by SPV');
    if (ok) await handleGenerateReport();
  }

  function handlePickWoPhotoFiles(files: FileList | null) {
    if (!files) return;
    const next = filterWoPhotoFiles(Array.from(files), woPhotoFiles);
    if (next.length > 0) setWoPhotoFiles((prev) => [...prev, ...next]);
  }

  function removeWoPhotoFile(index: number) {
    setWoPhotoFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleUploadWoPhotos() {
    if (!profile || !wo || woPhotoFiles.length === 0) return;
    setActing(true);
    try {
      const uploaded: string[] = [];
      for (const file of woPhotoFiles) {
        const ext = file.name.includes('.') ? file.name.split('.').pop() : '';
        const safeBase = file.name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'photo';
        const objectPath = `wo/${new Date().getFullYear()}/${wo.id}/${Date.now()}-${uuid()}-${safeBase}${ext ? `.${ext}` : ''}`;
        const { error: uploadError } = await supabase.storage
          .from('wo-photo-files')
          .upload(objectPath, file, { upsert: false, contentType: file.type });
        if (uploadError) throw uploadError;
        const { data } = supabase.storage.from('wo-photo-files').getPublicUrl(objectPath);
        uploaded.push(data.publicUrl);
      }

      const merged = Array.from(new Set([...(wo.attachments ?? []), ...uploaded]));
      const { error } = await supabase
        .from('work_orders')
        .update({ attachments: merged, updated_at: new Date().toISOString() })
        .eq('id', wo.id);

      if (error) {
        alert('Gagal menyimpan lampiran foto: ' + error.message);
        return;
      }

      await logHistory(wo.id, wo.status, 'WO photo attachment added', `${uploaded.length} foto ditambahkan`);
      await logActivity('wo_photo_attachment', `${wo.wo_number}: ${uploaded.length} foto ditambahkan`);
      setWoPhotoFiles([]);
      await loadData();
    } catch (e) {
      alert('Gagal upload foto: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setActing(false);
    }
  }

  function techName(id: string): string {
    const all = [...techList, ...(wo ? woTechnicians(wo) : [])];
    return all.find((t) => t.id === id)?.full_name ?? id;
  }

  // Samakan daftar teknisi WO dengan `newIds`: hapus yang dilepas, tambah yang baru.
  async function applyTechnicianChanges(newIds: string[]): Promise<{ ok: boolean; added: string[]; removed: string[] }> {
    if (!wo) return { ok: false, added: [], removed: [] };
    const current = woTechnicians(wo).map((t) => t.id);
    const toAdd = newIds.filter((id) => !current.includes(id));
    const toRemove = current.filter((id) => !newIds.includes(id));

    if (toRemove.length > 0) {
      const { error } = await supabase
        .from('work_order_technicians')
        .delete()
        .eq('work_order_id', wo.id)
        .in('technician_id', toRemove);
      if (error) {
        alert('Gagal melepas teknisi: ' + error.message);
        return { ok: false, added: [], removed: [] };
      }
    }
    if (toAdd.length > 0) {
      const { error } = await supabase
        .from('work_order_technicians')
        .insert(toAdd.map((id) => ({ work_order_id: wo.id, technician_id: id })));
      if (error) {
        alert('Gagal menugaskan teknisi: ' + error.message);
        return { ok: false, added: [], removed: [] };
      }
    }
    return { ok: true, added: toAdd.map(techName), removed: toRemove.map(techName) };
  }

  function technicianSummary(added: string[], removed: string[]): string {
    const parts: string[] = [];
    if (added.length) parts.push(`Ditugaskan: ${added.join(', ')}`);
    if (removed.length) parts.push(`Dilepas: ${removed.join(', ')}`);
    return parts.join(' | ');
  }

  async function handleAssign() {
    if (!wo) return;
    const currentIds = woTechnicians(wo).map((t) => t.id);
    const techChanged =
      assignTechs.length !== currentIds.length || assignTechs.some((id) => !currentIds.includes(id));
    const spvChanged = Boolean(assignSpv) && assignSpv !== wo.spv_id;
    if (!techChanged && !spvChanged) {
      alert('Tidak ada perubahan assignment.');
      return;
    }

    setActing(true);
    let added: string[] = [];
    let removed: string[] = [];
    if (techChanged) {
      const res = await applyTechnicianChanges(assignTechs);
      if (!res.ok) {
        setActing(false);
        await loadData();
        return;
      }
      added = res.added;
      removed = res.removed;
    }

    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (spvChanged) updateData.spv_id = assignSpv;
    // Status jadi 'assigned' begitu SPV (oleh admin) atau teknisi pertama (oleh SPV) ditugaskan;
    // kembali 'new' hanya jika tidak ada SPV maupun teknisi sama sekali.
    const hasAssignee = Boolean(assignSpv) || assignTechs.length > 0;
    let newStatus: WOStatus = wo.status;
    if (wo.status === 'new' && hasAssignee) newStatus = 'assigned';
    else if (wo.status === 'assigned' && !hasAssignee) newStatus = 'new';
    if (newStatus !== wo.status) updateData.status = newStatus;

    const { error } = await supabase.from('work_orders').update(updateData).eq('id', wo.id);
    if (error) {
      alert('Gagal menyimpan assignment: ' + error.message);
    } else {
      const summary = [technicianSummary(added, removed), spvChanged ? 'SPV diubah' : ''].filter(Boolean).join(' | ');
      await logHistory(wo.id, newStatus, techChanged ? 'Technician assignment updated' : 'SPV assigned', summary);
      await logActivity('assign_wo', `${wo.wo_number}: assignment updated (${summary})`);
    }
    await loadData();
    setActing(false);
  }

  function handleAddDraft() {
    if (!selectedPart) return;
    const part = spareParts.find((p) => p.id === selectedPart);
    if (!part) return;
    if (partQty <= 0) { alert('Quantity harus lebih besar dari 0.'); return; }
    const already = draft.find((d) => d.spare_part_id === selectedPart)?.quantity ?? 0;
    if (already + partQty > part.current_stock) {
      alert(`Stok tidak mencukupi. Tersedia ${part.current_stock} ${part.unit}${already ? ` (sudah ${already} di daftar)` : ''}.`);
      return;
    }
    setDraft((prev) =>
      already
        ? prev.map((d) =>
            d.spare_part_id === selectedPart
              ? { ...d, quantity: d.quantity + partQty, note: partNote.trim() || d.note }
              : d
          )
        : [...prev, { spare_part_id: selectedPart, quantity: partQty, note: partNote.trim() }]
    );
    setSelectedPart('');
    setPartQty(1);
    setPartNote('');
  }

  async function handleSubmitRequest() {
    if (!wo || draft.length === 0) return;
    if (!purpose.trim()) { alert('Keperluan wajib diisi.'); return; }
    setActing(true);
    const { data, error } = await supabase.rpc('create_part_request', {
      p_work_order_id: wo.id,
      p_purpose: purpose.trim(),
      p_items: draft.map((d) => ({ spare_part_id: d.spare_part_id, quantity: d.quantity, note: d.note || null })),
    });
    if (error) {
      alert('Gagal mengajukan permintaan: ' + error.message);
    } else {
      const req = data as { request_no?: string } | null;
      const names = draft.map((d) => `${spareParts.find((p) => p.id === d.spare_part_id)?.name ?? '?'} x${d.quantity}`).join(', ');
      await logHistory(wo.id, wo.status, 'Spare part requested', `${req?.request_no ?? ''}: ${names}`);
      setDraft([]);
      setPurpose('');
      await loadData();
    }
    setActing(false);
  }

  async function handleRemovePart(partId: string, _sparePartId: string, _qty: number) {
    if (!wo) return;
    setActing(true);
    const { error } = await supabase.rpc('return_work_order_part', { p_work_order_part_id: partId });
    if (error) alert('Gagal mengembalikan spare part: ' + error.message);
    else await loadData();
    setActing(false);
  }

  async function handleIntervention() {
    if (!wo || !interventionReason) return;
    setActing(true);
    const { error } = await supabase
      .from('work_orders')
      .update({
        status: interventionStatus,
        updated_at: new Date().toISOString(),
        ...(interventionStatus === 'closed' ? { closed_at: null } : {}),
        ...(interventionStatus !== 'closed' ? { closed_at: null } : {}),
      })
      .eq('id', wo.id);

    if (!error) {
      await logHistory(wo.id, interventionStatus, 'Admin intervention', interventionReason);
      await logActivity('admin_intervention', `${wo.wo_number}: status changed to ${interventionStatus}`, interventionReason);
      setShowIntervention(false);
      setInterventionReason('');
      await loadData();
    }
    setActing(false);
  }

  async function loadEditAreas(deptId: string) {
    const { data } = await supabase.from('areas').select('*').eq('department_id', deptId).order('name');
    setAreaList((data as Area[]) ?? []);
  }

  async function loadEditEquipment(areaId: string) {
    const { data } = await supabase.from('equipment').select('*').eq('area_id', areaId).order('name');
    setEquipList((data as Equipment[]) ?? []);
  }

  async function openEdit() {
    if (!wo) return;
    setEditForm({
      department_id: wo.department_id,
      area_id: wo.area_id ?? '',
      equipment_id: wo.equipment_id ?? '',
      problem_description: wo.problem_description,
      priority: wo.priority,
      work_types: wo.work_types ?? [],
      spv_id: wo.spv_id ?? '',
      date_created: (wo.date_created ?? '').slice(0, 10),
      analysis: wo.analysis ?? '',
      action_taken: wo.action_taken ?? '',
      result: wo.result ?? '',
      pending_reason: wo.pending_reason ?? '',
      reason: '',
    });
    setAreaList([]);
    setEquipList([]);
    setShowEdit(true);
    const { data: depts } = await supabase.from('departments').select('*').order('name');
    setDeptList((depts as Department[]) ?? []);
    await loadEditAreas(wo.department_id);
    if (wo.area_id) await loadEditEquipment(wo.area_id);
  }

  async function handleEditDepartment(deptId: string) {
    setEditForm((f) => ({ ...f, department_id: deptId, area_id: '', equipment_id: '' }));
    setEquipList([]);
    if (deptId) await loadEditAreas(deptId);
    else setAreaList([]);
  }

  async function handleEditArea(areaId: string) {
    setEditForm((f) => ({ ...f, area_id: areaId, equipment_id: '' }));
    if (areaId) await loadEditEquipment(areaId);
    else setEquipList([]);
  }

  async function handleSaveEdit() {
    if (!wo || !profile) return;
    if (!editForm.department_id || !editForm.problem_description.trim()) {
      alert('Departemen dan deskripsi masalah wajib diisi.');
      return;
    }
    const isRealAdmin = profile.role === 'admin';
    const needReason = isRealAdmin && ['done', 'verified', 'closed'].includes(wo.status);
    if (needReason && editForm.reason.trim().length < 3) {
      alert('Alasan perubahan wajib diisi untuk WO yang sudah selesai/diverifikasi/ditutup.');
      return;
    }
    if (isRealAdmin && !editForm.date_created) {
      alert('Tanggal WO wajib diisi.');
      return;
    }
    setActing(true);

    const updateData: Record<string, unknown> = {
      department_id: editForm.department_id,
      area_id: editForm.area_id || null,
      equipment_id: editForm.equipment_id || null,
      problem_description: editForm.problem_description.trim(),
      priority: editForm.priority,
      work_types: editForm.work_types,
      spv_id: editForm.spv_id || null,
      updated_at: new Date().toISOString(),
    };
    if (isRealAdmin) {
      updateData.date_created = editForm.date_created;
      updateData.analysis = editForm.analysis.trim() || null;
      updateData.action_taken = editForm.action_taken.trim() || null;
      updateData.result = editForm.result.trim() || null;
      if (wo.status === 'pending') updateData.pending_reason = editForm.pending_reason.trim() || null;
    }
    // Admin hanya menugaskan SPV di sini; penugasan teknisi adalah wewenang SPV (lihat kartu Assignment).
    const currentTechCount = woTechnicians(wo).length;
    const hasAssignee = Boolean(editForm.spv_id) || currentTechCount > 0;
    let newStatus: WOStatus = wo.status;
    if (wo.status === 'new' && hasAssignee) {
      updateData.status = 'assigned';
      newStatus = 'assigned';
    } else if (wo.status === 'assigned' && !hasAssignee) {
      updateData.status = 'new';
      newStatus = 'new';
    }

    const { error } = await supabase.from('work_orders').update(updateData).eq('id', wo.id);
    if (error) {
      alert('Gagal menyimpan perubahan: ' + error.message);
      setActing(false);
      await loadData();
      return;
    }

    const changes: string[] = [];
    if (editForm.department_id !== wo.department_id) changes.push('department');
    if ((editForm.area_id || null) !== wo.area_id) changes.push('area');
    if ((editForm.equipment_id || null) !== wo.equipment_id) changes.push('equipment');
    if (editForm.priority !== wo.priority) changes.push(`priority ${wo.priority} -> ${editForm.priority}`);
    const wtA = [...(editForm.work_types ?? [])].sort().join(',');
    const wtB = [...(wo.work_types ?? [])].sort().join(',');
    if (wtA !== wtB) changes.push('jenis pekerjaan');
    if (editForm.problem_description.trim() !== wo.problem_description) changes.push('problem description');
    if ((editForm.spv_id || null) !== wo.spv_id) changes.push('SPV');
    if (isRealAdmin) {
      const n = (v: string | null | undefined) => (v ?? '').trim();
      if (editForm.date_created !== (wo.date_created ?? '').slice(0, 10)) changes.push(`date created ${(wo.date_created ?? '').slice(0, 10)} -> ${editForm.date_created}`);
      if (n(editForm.analysis) !== n(wo.analysis)) changes.push('analysis');
      if (n(editForm.action_taken) !== n(wo.action_taken)) changes.push('action taken');
      if (n(editForm.result) !== n(wo.result)) changes.push('result');
      if (wo.status === 'pending' && n(editForm.pending_reason) !== n(wo.pending_reason)) changes.push('pending reason');
    }
    const summary = changes.length ? `Changed: ${changes.join(', ')}` : 'No field changed';
    const editReason = isRealAdmin ? editForm.reason.trim() : '';

    await logHistory(wo.id, newStatus, 'WO edited by admin', editReason ? `${summary} | Alasan: ${editReason}` : summary);
    await logActivity('edit_wo', `${wo.wo_number}: edited by admin (${summary})`, editReason || undefined);
    setShowEdit(false);
    await loadData();
    setActing(false);
  }

  async function handleCancelWO() {
    if (!wo || !cancelReason.trim()) return;
    setActing(true);
    const { error } = await supabase.rpc('admin_cancel_work_order', {
      p_wo_id: wo.id,
      p_reason: cancelReason.trim(),
    });
    if (error) {
      alert('Gagal membatalkan WO: ' + error.message);
      setActing(false);
      return;
    }
    setActing(false);
    setShowCancel(false);
    setCancelReason('');
    await loadData();
  }

  async function handleReactivateWO() {
    if (!wo || !reactivateReason.trim()) return;
    setActing(true);
    const { error } = await supabase.rpc('admin_reactivate_work_order', {
      p_wo_id: wo.id,
      p_reason: reactivateReason.trim(),
    });
    if (error) {
      alert('Gagal mengaktifkan kembali WO: ' + error.message);
      setActing(false);
      return;
    }
    setActing(false);
    setShowReactivate(false);
    setReactivateReason('');
    await loadData();
  }

  async function handleReopen() {
    if (!wo) return;
    setActing(true);
    const { error } = await supabase
      .from('work_orders')
      .update({ status: 'verified', closed_at: null, updated_at: new Date().toISOString() })
      .eq('id', wo.id);
    if (!error) {
      await logHistory(wo.id, 'verified', 'WO reopened by admin');
      await logActivity('reopen_wo', `${wo.wo_number}: reopened from CLOSED`);
      await loadData();
    }
    setActing(false);
  }

  if (loading) return <Spinner />;
  if (!wo) return <div className="text-center text-slate-400 py-12">Work order not found</div>;

  const isAdmin = profile?.role === 'admin' || profile?.role === 'ss';
  const needEditReason = profile?.role === 'admin' && ['done', 'verified', 'closed'].includes(wo.status);
  const isSPV = profile?.role === 'spv' && (profile?.department_id === wo.department_id || wo.spv_id === profile?.id);
  const canGenerateReport = profile?.role === 'spv' || profile?.role === 'ss' || profile?.role === 'admin';
  const assignedTechs = woTechnicians(wo);
  const isTech = profile?.role === 'teknisi' && assignedTechs.some((t) => t.id === profile.id);
  const canUploadWoPhoto = isTech || isSPV;
  const isCanceled = wo.status === 'canceled';
  // Teknisi yang sudah ditugaskan tetap muncul di pilihan walau nonaktif.
  const techOptions = (
    [...techList, ...assignedTechs.filter((a) => !techList.some((t) => t.id === a.id))]
  ).map((t) => ({ value: t.id, label: t.full_name, sublabel: t.username ? `@${t.username}` : undefined }));
  const groupName = (p: SparePart) => groups.find((g) => g.id === p.group_id)?.name ?? '';
  const partOptions = spareParts.map((p) => ({
    value: p.id,
    label: p.name,
    sublabel: [p.code, groupName(p), p.category, p.location].filter(Boolean).join(' • '),
    right: p.current_stock <= 0 ? 'Stok habis' : `${p.current_stock} ${p.unit}`,
    search: [p.name, p.code, p.category, groupName(p), p.location].filter(Boolean).join(' '),
    disabled: p.current_stock <= 0,
  }));
  const chosenPart = spareParts.find((p) => p.id === selectedPart);

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold text-slate-900">{wo.wo_number}</h2>
            <Badge className={STATUS_COLORS[wo.status]}>{STATUS_LABELS[wo.status]}</Badge>
            <Badge className={PRIORITY_COLORS[wo.priority]}>{PRIORITY_LABELS[wo.priority]}</Badge>
            {(wo.work_types ?? []).map((t) => (
              <Badge key={t} className="bg-indigo-100 text-indigo-700 border-indigo-200">
                {WORK_TYPE_LABELS[t] ?? t}
              </Badge>
            ))}
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Created {new Date(wo.created_at).toLocaleString()}
          </p>
        </div>
      </div>

      {isCanceled && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3">
          <p className="text-sm text-rose-700">
            <span className="font-semibold">Work Order dibatalkan.</span>{' '}
            {wo.cancel_reason ? `Alasan: ${wo.cancel_reason}` : 'WO ini tidak perlu diproses lebih lanjut.'}
          </p>
        </div>
      )}

      {/* Info Card */}
      <Card className="p-5 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <InfoRow label="Department" value={wo.department?.name ?? '-'} />
          <InfoRow label="Peminta" value={wo.requester_name || '-'} />
          <InfoRow label="Dept. Peminta" value={wo.requester_department || '-'} />
          <InfoRow label="Area" value={wo.area?.name ?? '-'} />
          <InfoRow label="Equipment" value={wo.equipment?.name ?? '-'} />
          <InfoRow label="Mulai Dikerjakan" value={fmtWoTime(workTimes.startedAt)} />
          <InfoRow label="Selesai" value={fmtWoTime(workTimes.finishedAt)} />
          <InfoRow label="Date Created" value={new Date(wo.date_created).toLocaleDateString()} />
          <InfoRow label="SPV" value={wo.spv?.full_name ?? '-'} />
          <InfoRow label="Technician" value={assignedTechs.length ? assignedTechs.map((t) => t.full_name).join(', ') : '-'} />
        </div>
        <div>
          <p className="text-xs text-slate-400 mb-1">Problem Description</p>
          <p className="text-sm text-slate-700">{wo.problem_description}</p>
        </div>
      </Card>

      {/* Lampiran foto WO */}
      {(canUploadWoPhoto || (wo.attachments?.length ?? 0) > 0) && (
        <Card className="p-5">
          <h3 className="font-semibold text-slate-900 mb-1 flex items-center gap-2">
            <ImagePlus className="w-4 h-4" /> Lampiran Foto WO
          </h3>
          <p className="text-xs text-slate-400 mb-3">Format: JPG/PNG/WEBP, maksimal 500KB per foto.</p>

          {(wo.attachments?.length ?? 0) === 0 ? (
            <p className="text-sm text-slate-400 mb-3">Belum ada foto lampiran.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
              {(wo.attachments ?? []).map((url, idx) => (
                <a
                  key={`${url}-${idx}`}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-lg border border-slate-200 overflow-hidden hover:border-slate-300"
                >
                  <img src={url} alt={`WO attachment ${idx + 1}`} className="w-full h-24 object-cover bg-slate-100" />
                  <p className="text-[11px] text-slate-500 px-2 py-1">Foto {idx + 1}</p>
                </a>
              ))}
            </div>
          )}

          {canUploadWoPhoto && wo.status !== 'closed' && wo.status !== 'canceled' && (
            <div className="space-y-3">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={(e) => {
                  handlePickWoPhotoFiles(e.target.files);
                  e.currentTarget.value = '';
                }}
                className="block w-full text-sm text-slate-600 file:mr-3 file:px-3 file:py-2 file:rounded-md file:border-0 file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
              />

              {woPhotoFiles.length > 0 && (
                <div className="rounded-lg bg-slate-50 divide-y divide-slate-100">
                  {woPhotoFiles.map((file, idx) => (
                    <div key={`${file.name}-${file.size}-${file.lastModified}-${idx}`} className="flex items-center justify-between gap-2 px-3 py-2">
                      <p className="text-xs text-slate-600 truncate">{file.name} ({Math.ceil(file.size / 1024)}KB)</p>
                      <button
                        type="button"
                        onClick={() => removeWoPhotoFile(idx)}
                        className="text-slate-500 hover:text-red-600"
                        aria-label="Hapus file"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div>
                <Button variant="secondary" onClick={handleUploadWoPhotos} disabled={acting || woPhotoFiles.length === 0}>
                  <ImagePlus className="w-4 h-4" /> Upload Foto WO
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Assignment section: admin menunjuk SPV, SPV yang berwenang menugaskan teknisi */}
      {(isAdmin || isSPV) && wo.status !== 'closed' && wo.status !== 'canceled' && (
        <Card className="p-5">
          <h3 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
            <UserCog className="w-4 h-4" /> Assignment
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {isAdmin && (
              <div className="sm:col-span-2">
                <Label>SPV (PIC Work Order)</Label>
                <Select value={assignSpv} onChange={(e) => setAssignSpv(e.target.value)}>
                  <option value="">Select SPV...</option>
                  {spvList.map((s) => (
                    <option key={s.id} value={s.id}>{s.full_name}</option>
                  ))}
                </Select>
                <p className="text-xs text-slate-400 mt-1">
                  Penugasan teknisi adalah wewenang SPV yang ditunjuk, bukan admin.
                </p>
              </div>
            )}
            {isSPV && (
              <div className="sm:col-span-2">
                <Label>Technician (bisa lebih dari satu)</Label>
                <MultiPicker
                  options={techOptions}
                  value={assignTechs}
                  onChange={setAssignTechs}
                  placeholder="Cari teknisi..."
                />
              </div>
            )}
          </div>
          <div className="mt-3">
            <Button size="sm" onClick={handleAssign} disabled={acting}>
              Update Assignment
            </Button>
          </div>
        </Card>
      )}

      {/* Teknisi actions */}
      {isTech && wo.status !== 'closed' && wo.status !== 'verified' && wo.status !== 'canceled' && (
        <Card className="p-5 space-y-4">
          <h3 className="font-semibold text-slate-900">Work Execution</h3>

          {wo.status === 'assigned' && (
            <Button variant="primary" onClick={() => updateStatus('analysis', 'Started analysis')} disabled={acting}>
              <Play className="w-4 h-4" /> Start Analysis
            </Button>
          )}

          {(wo.status === 'analysis' || wo.status === 'on_progress' || wo.status === 'pending') && (
            <>
              <div>
                <Label>Analysis</Label>
                <Textarea
                  rows={3}
                  value={analysis}
                  onChange={(e) => setAnalysis(e.target.value)}
                  placeholder="Describe your analysis of the problem..."
                />
              </div>
              <div>
                <Label>Action Taken</Label>
                <Textarea
                  rows={3}
                  value={actionTaken}
                  onChange={(e) => setActionTaken(e.target.value)}
                  placeholder="Describe actions taken..."
                />
              </div>
              <div>
                <Label>Result</Label>
                <Textarea
                  rows={2}
                  value={result}
                  onChange={(e) => setResult(e.target.value)}
                  placeholder="Describe the result..."
                />
              </div>

              <div>
                <Label>Pending Reason {wo.status !== 'pending' && <span className="text-xs font-normal text-slate-400">(wajib diisi bila WO di-set Pending)</span>}</Label>
                <Input
                  value={pendingReason}
                  onChange={(e) => setPendingReason(e.target.value)}
                  placeholder="Why is this WO pending?"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                {wo.status !== 'on_progress' && (
                  <Button
                    variant="primary"
                    onClick={() =>
                      updateStatus('on_progress', 'Started work', {
                        analysis,
                        action_taken: actionTaken,
                      })
                    }
                    disabled={acting}
                  >
                    <Play className="w-4 h-4" /> Start Work
                  </Button>
                )}
                <Button
                  variant="warning"
                  onClick={() => {
                    if (!pendingReason.trim()) {
                      alert('Please enter a pending reason');
                      return;
                    }
                    updateStatus('pending', 'Set to pending', { pending_reason: pendingReason.trim() });
                  }}
                  disabled={acting}
                >
                  <Pause className="w-4 h-4" /> Set Pending
                </Button>
                {wo.status === 'pending' && pendingReason && (
                  <Button
                    variant="primary"
                    onClick={() => updateStatus('on_progress', 'Resumed from pending')}
                    disabled={acting}
                  >
                    <Play className="w-4 h-4" /> Resume Work
                  </Button>
                )}
                <Button
                  variant="success"
                  onClick={() =>
                    updateStatus('done', 'Work completed', {
                      analysis,
                      action_taken: actionTaken,
                      result,
                    })
                  }
                  disabled={acting}
                >
                  <CheckCircle2 className="w-4 h-4" /> Submit Done
                </Button>
              </div>
            </>
          )}
        </Card>
      )}

      {/* Spare parts used */}
      <Card className="p-5">
        <h3 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Package className="w-4 h-4" /> Spare Parts Used
        </h3>
        {parts.length === 0 ? (
          <p className="text-sm text-slate-400">No spare parts used yet</p>
        ) : (
          <div className="space-y-2 mb-3">
            {parts.map((p) => (
              <div key={p.id} className="flex items-center justify-between p-3 rounded-lg bg-slate-50">
                <div>
                  <p className="text-sm font-medium text-slate-900">{p.spare_part?.name}</p>
                  <p className="text-xs text-slate-400">{p.spare_part?.code} • {p.quantity} {p.spare_part?.unit}</p>
                </div>
                {(isAdmin || isTech) && wo.status !== 'closed' && wo.status !== 'canceled' && (
                  <button
                    onClick={() => handleRemovePart(p.id, p.spare_part_id, p.quantity)}
                    disabled={acting}
                    className="text-red-500 hover:text-red-700 p-1"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

      </Card>

      {/* Permintaan spare part (approval SS, lalu diproses inventory) */}
      <Card className="p-5">
        <h3 className="font-semibold text-slate-900 mb-1 flex items-center gap-2">
          <Package className="w-4 h-4" /> Permintaan Spare Part
        </h3>
        <p className="text-xs text-slate-400 mb-4">
          Alur: teknisi mengajukan → disetujui SS/admin → diproses pengeluaran oleh inventory/admin. Stok berkurang saat tahap proses inventory.
        </p>

        {(isAdmin || isTech) && wo.status !== 'closed' && wo.status !== 'verified' && wo.status !== 'canceled' && (
          <div className="rounded-lg border border-slate-200 p-4 mb-4 space-y-3">
            <div className="flex flex-col sm:flex-row gap-2 items-end">
              <div className="flex-1 w-full">
                <Label>Cari Spare Part</Label>
                <SearchablePicker
                  options={partOptions}
                  value={selectedPart}
                  onChange={(v) => {
                    setSelectedPart(v);
                    setPartQty(1);
                  }}
                  placeholder="Cari & pilih spare part..."
                  emptyText="Spare part tidak ditemukan"
                />
                {chosenPart && (
                  <p className="text-xs text-slate-400 mt-1">
                    {chosenPart.code}
                    {groupName(chosenPart) ? ` • ${groupName(chosenPart)}` : ''} • Stok tersedia:{' '}
                    <span className="font-medium text-slate-600">{chosenPart.current_stock} {chosenPart.unit}</span>
                  </p>
                )}
              </div>
              <div className="w-24">
                <Label>Qty</Label>
                <Input
                  type="number"
                  min={1}
                  max={chosenPart?.current_stock}
                  value={partQty}
                  onChange={(e) => setPartQty(Number(e.target.value))}
                />
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 items-end">
              <div className="flex-1 w-full">
                <Label>Keterangan barang (opsional)</Label>
                <Input value={partNote} onChange={(e) => setPartNote(e.target.value)} placeholder="Mis. untuk motor pompa #2" />
              </div>
              <Button size="sm" variant="secondary" onClick={handleAddDraft} disabled={acting || !selectedPart}>
                <Plus className="w-4 h-4" /> Tambah ke daftar
              </Button>
            </div>

            {draft.length > 0 && (
              <>
                <div className="rounded-lg bg-slate-50 divide-y divide-slate-100">
                  {draft.map((d) => {
                    const part = spareParts.find((p) => p.id === d.spare_part_id);
                    return (
                      <div key={d.spare_part_id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-900 truncate">{part?.name}</p>
                          <p className="text-xs text-slate-400 truncate">{part?.code}{d.note ? ` • ${d.note}` : ''}</p>
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <span className="text-sm font-bold text-slate-900">{d.quantity} {part?.unit}</span>
                          <button
                            onClick={() => setDraft((prev) => prev.filter((x) => x.spare_part_id !== d.spare_part_id))}
                            className="text-red-500 hover:text-red-700 p-1"
                            aria-label="Hapus dari daftar"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div>
                  <Label>Keperluan *</Label>
                  <Textarea
                    rows={2}
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    placeholder="Jelaskan keperluan barang untuk pekerjaan ini..."
                  />
                </div>
                <div className="flex justify-end">
                  <Button onClick={handleSubmitRequest} disabled={acting || !purpose.trim()}>
                    {acting ? 'Mengirim...' : `Ajukan Permintaan (${draft.length} barang)`}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {requests.length === 0 ? (
          <p className="text-sm text-slate-400">Belum ada permintaan spare part</p>
        ) : (
          <div className="space-y-3">
            {requests.map((r) => (
              <PartRequestCard key={r.id} request={r} viewer={profile!} showWO={false} onChanged={loadData} />
            ))}
          </div>
        )}
      </Card>

      {/* SPV verify / rework */}
      {isSPV && wo.status === 'done' && (
        <Card className="p-5">
          <h3 className="font-semibold text-slate-900 mb-3">Verification</h3>
          <div className="flex gap-2 flex-wrap">
            <Button variant="success" onClick={handleVerifyAndGenerateReport} disabled={acting}>
              <CheckCircle2 className="w-4 h-4" /> Verify & Generate Report
            </Button>
            <Button variant="warning" onClick={() => updateStatus('on_progress', 'Sent back for rework', {}, 'SPV requested rework')} disabled={acting}>
              <RotateCcw className="w-4 h-4" /> Request Rework
            </Button>
          </div>
        </Card>
      )}

      {/* Report WO (SPV ke atas) */}
      {canGenerateReport && (wo.status === 'verified' || wo.status === 'closed') && (
        <Card className="p-5">
          <h3 className="font-semibold text-slate-900 mb-2">Report WO</h3>
          <p className="text-xs text-slate-500 mb-3">
            Report PDF tersedia setelah WO selesai dan disetujui SPV.
          </p>
          <Button variant="secondary" onClick={handleGenerateReport} disabled={acting}>
            <FileDown className="w-4 h-4" /> Download PDF Report
          </Button>
        </Card>
      )}

      {/* Admin actions */}
      {isAdmin && (
        <Card className="p-5">
          <h3 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
            <Lock className="w-4 h-4" /> Admin Controls
          </h3>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={openEdit} disabled={acting}>
              <Pencil className="w-4 h-4" /> Edit WO
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setShowIntervention(true)}>
              Change Status (Intervention)
            </Button>
            {wo.status === 'closed' && (
              <Button variant="warning" size="sm" onClick={handleReopen} disabled={acting}>
                <Unlock className="w-4 h-4" /> Reopen WO
              </Button>
            )}
            {wo.status === 'verified' && (
              <Button variant="success" size="sm" onClick={() => updateStatus('closed', 'WO closed by admin')} disabled={acting}>
                <Lock className="w-4 h-4" /> Close WO
              </Button>
            )}
            {wo.status === 'canceled' ? (
              <Button variant="success" size="sm" onClick={() => setShowReactivate(true)} disabled={acting}>
                <Undo2 className="w-4 h-4" /> Reactivate WO
              </Button>
            ) : (
              wo.status !== 'closed' && wo.status !== 'verified' && (
                <Button variant="danger" size="sm" onClick={() => setShowCancel(true)} disabled={acting}>
                  <XCircle className="w-4 h-4" /> Cancel WO
                </Button>
              )
            )}
          </div>
        </Card>
      )}

      {/* History */}
      <Card className="p-5">
        <h3 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <HistoryIcon className="w-4 h-4" /> History
        </h3>
        {history.length === 0 ? (
          <p className="text-sm text-slate-400">No history yet</p>
        ) : (
          <div className="space-y-2">
            {history.map((h) => (
              <div key={h.id} className="flex items-start gap-3 text-sm">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-2 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-slate-900">{h.action}</span>
                    <Badge className={STATUS_COLORS[h.status as WOStatus] ?? 'bg-slate-100 text-slate-600 border-slate-200'}>
                      {STATUS_LABELS[h.status as WOStatus] ?? h.status}
                    </Badge>
                    <span className="ml-auto shrink-0 text-xs text-slate-400">
                      {h.performer?.full_name ?? 'Unknown'} • {fmtWoTime(h.performed_at)}
                    </span>
                  </div>
                  {h.notes && <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{h.notes}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Edit modal */}
      <Modal open={showEdit} onClose={() => setShowEdit(false)} title={`Edit ${wo.wo_number}`} maxWidth="max-w-2xl">
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Department *</Label>
              <Select value={editForm.department_id} onChange={(e) => handleEditDepartment(e.target.value)}>
                <option value="">Select department...</option>
                {deptList.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Priority</Label>
              <Select value={editForm.priority} onChange={(e) => setEditForm((f) => ({ ...f, priority: e.target.value as WorkOrder['priority'] }))}>
                {Object.keys(PRIORITY_LABELS).map((k) => (
                  <option key={k} value={k}>{PRIORITY_LABELS[k]}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Jenis Pekerjaan</Label>
              <div className="flex flex-wrap gap-3 mt-1 pt-2">
                {WORK_TYPES.map((t) => (
                  <label key={t} className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editForm.work_types.includes(t)}
                      onChange={(e) =>
                        setEditForm((f) => ({
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
            </div>
            <div>
              <Label>Area</Label>
              <Select value={editForm.area_id} onChange={(e) => handleEditArea(e.target.value)}>
                <option value="">None</option>
                {areaList.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Equipment</Label>
              <Select value={editForm.equipment_id} onChange={(e) => setEditForm((f) => ({ ...f, equipment_id: e.target.value }))}>
                <option value="">None</option>
                {equipList.map((q) => (
                  <option key={q.id} value={q.id}>{q.name}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>SPV</Label>
              <Select value={editForm.spv_id} onChange={(e) => setEditForm((f) => ({ ...f, spv_id: e.target.value }))}>
                <option value="">None</option>
                {(wo.spv && !spvList.some((x) => x.id === wo.spv!.id) ? [wo.spv, ...spvList] : spvList).map((x) => (
                  <option key={x.id} value={x.id}>{x.full_name}</option>
                ))}
              </Select>
            </div>
          </div>
          <p className="text-xs text-slate-400 -mt-2">
            Penugasan teknisi dilakukan oleh SPV yang ditunjuk, dari kartu Assignment di halaman ini.
          </p>
          <div>
            <Label>Problem Description *</Label>
            <Textarea
              rows={4}
              value={editForm.problem_description}
              onChange={(e) => setEditForm((f) => ({ ...f, problem_description: e.target.value }))}
            />
          </div>
          {profile?.role === 'admin' && (
            <div className="rounded-lg border border-slate-200 p-3 space-y-3">
              <p className="text-sm font-semibold text-slate-800">Tanggal &amp; hasil pekerjaan (khusus admin)</p>
              <div className="sm:w-56">
                <Label>Tanggal WO</Label>
                <Input type="date" value={editForm.date_created} onChange={(e) => setEditForm((f) => ({ ...f, date_created: e.target.value }))} />
              </div>
              <div>
                <Label>Analysis</Label>
                <Textarea rows={2} value={editForm.analysis} onChange={(e) => setEditForm((f) => ({ ...f, analysis: e.target.value }))} />
              </div>
              <div>
                <Label>Action Taken</Label>
                <Textarea rows={2} value={editForm.action_taken} onChange={(e) => setEditForm((f) => ({ ...f, action_taken: e.target.value }))} />
              </div>
              <div>
                <Label>Result</Label>
                <Textarea rows={2} value={editForm.result} onChange={(e) => setEditForm((f) => ({ ...f, result: e.target.value }))} />
              </div>
              {wo.status === 'pending' && (
                <div>
                  <Label>Pending Reason</Label>
                  <Textarea rows={2} value={editForm.pending_reason} onChange={(e) => setEditForm((f) => ({ ...f, pending_reason: e.target.value }))} />
                </div>
              )}
              <div>
                <Label>Alasan perubahan{needEditReason ? ' *' : ''}</Label>
                <Textarea
                  rows={2}
                  value={editForm.reason}
                  onChange={(e) => setEditForm((f) => ({ ...f, reason: e.target.value }))}
                  placeholder={needEditReason ? 'Wajib untuk WO yang sudah selesai/diverifikasi/ditutup' : 'Opsional'}
                />
              </div>
            </div>
          )}
          <p className="text-xs text-slate-400">
            Nomor WO tidak berubah walau departemen diganti. Untuk mengubah status gunakan Change Status.
            Perubahan dicatat di History dan Activity Log.
          </p>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setShowEdit(false)}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={acting || !editForm.department_id || !editForm.problem_description.trim() || (needEditReason && editForm.reason.trim().length < 3)}>
              {acting ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Cancel modal */}
      <Modal open={showCancel} onClose={() => setShowCancel(false)} title="Cancel Work Order">
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            Batalkan <span className="font-semibold">{wo?.wo_number}</span>? WO tidak akan dihapus,
            hanya tidak perlu diproses lebih lanjut (status menjadi <b>Canceled</b>) dan bisa diaktifkan
            kembali oleh admin.
          </p>
          <div>
            <Label>Alasan pembatalan *</Label>
            <Textarea
              rows={3}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Mis. pekerjaan tidak jadi dilaksanakan..."
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setShowCancel(false)}>Kembali</Button>
            <Button variant="danger" onClick={handleCancelWO} disabled={acting || !cancelReason.trim()}>
              {acting ? 'Membatalkan...' : 'Cancel WO'}
            </Button>
          </div>
          <p className="text-xs text-slate-400">
            Pembatalan dicatat di Activity Log beserta nama Anda dan alasan di atas.
          </p>
        </div>
      </Modal>

      {/* Reactivate modal */}
      <Modal open={showReactivate} onClose={() => setShowReactivate(false)} title="Reactivate Work Order">
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            Aktifkan kembali <span className="font-semibold">{wo?.wo_number}</span>? Status WO akan
            dikembalikan menjadi <b>Waiting Assignment (new)</b>. Assignment SPV/teknisi &amp;
            permintaan part yang ada dipertahankan.
          </p>
          <div>
            <Label>Alasan reaktivasi *</Label>
            <Textarea
              rows={3}
              value={reactivateReason}
              onChange={(e) => setReactivateReason(e.target.value)}
              placeholder="Mis. pekerjaan dilanjutkan kembali..."
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setShowReactivate(false)}>Kembali</Button>
            <Button variant="success" onClick={handleReactivateWO} disabled={acting || !reactivateReason.trim()}>
              {acting ? 'Mengaktifkan...' : 'Reactivate WO'}
            </Button>
          </div>
          <p className="text-xs text-slate-400">
            Reaktivasi dicatat di Activity Log beserta nama Anda dan alasan di atas.
          </p>
        </div>
      </Modal>
          </p>
        </div>
      </Modal>

      {/* Intervention modal */}
      <Modal open={showIntervention} onClose={() => setShowIntervention(false)} title="Admin Intervention">
        <div className="space-y-4">
          <div>
            <Label>Change Status To</Label>
            <Select value={interventionStatus} onChange={(e) => setInterventionStatus(e.target.value as WOStatus)}>
              {(Object.keys(STATUS_LABELS) as WOStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Reason / Command *</Label>
            <Textarea
              rows={3}
              value={interventionReason}
              onChange={(e) => setInterventionReason(e.target.value)}
              placeholder="Explain the reason for this intervention..."
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setShowIntervention(false)}>Cancel</Button>
            <Button variant="danger" onClick={handleIntervention} disabled={acting || !interventionReason}>
              {acting ? 'Processing...' : 'Confirm Intervention'}
            </Button>
          </div>
          <p className="text-xs text-slate-400">
            This action will be recorded in the Activity Log with your name, timestamp, and reason.
          </p>
        </div>
      </Modal>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className="text-sm font-medium text-slate-700">{value}</p>
    </div>
  );
}
