import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, type Profile } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { Badge, Button, Card, Input, Label, Select, Spinner, Textarea } from '@/components/ui';
import { uuid } from '@/lib/uuid';
import { CalendarDays, Camera, ChevronLeft, ChevronRight, ClipboardCheck, ImagePlus, Plus, RefreshCw, Save, Trash2, Wrench, XCircle } from 'lucide-react';

type Mode = 'fixed_calendar' | 'execution_based';
type OccStatus = 'open' | 'completed' | 'not_done' | 'waived' | 'canceled';
type DepartmentOption = { id: string; name: string; code: string };
type DepartmentPMSetting = { department_id: string; pm_enabled: boolean };
type DepartmentEquipmentScope = { department_id: string; equipment_id: string };
type EquipmentType = 'HVAC' | 'Mesin' | 'LAF' | 'Lainnya';
const EQUIPMENT_TYPES: EquipmentType[] = ['HVAC', 'Mesin', 'LAF', 'Lainnya'];
type EquipmentOption = { id: string; name: string; code: string | null; equipment_types?: EquipmentType[]; area?: { id: string; name: string; department_id: string | null } | null };
type PMChecklistItem = { id: string; description: string };
type PMChecklistResult = 'ok' | 'not_ok' | '';
type PMAssignmentChecklistItem = PMChecklistItem & { result?: 'ok' | 'not_ok' | null; note?: string | null; checked?: boolean };
type PMSchedule = { id: string; department_id: string | null; equipment_id: string; title: string; description: string | null; checklist_items: PMChecklistItem[]; interval_months: number; schedule_mode: Mode; anchor_due_date: string; next_due_date: string | null; end_date: string | null; is_active: boolean; is_deleted?: boolean; equipment: EquipmentOption | null };
type PMAssignment = { id: string; assignment_no: string; status: string; planned_date: string | null; deadline: string; priority: string; report_notes: string | null; checklist_items: PMAssignmentChecklistItem[]; evidence_photos: string[]; pending_reason: string | null; review_note: string | null; assigned_technicians?: { technician_id: string; technician: { full_name: string } | null }[] };
 type PMOccurrence = { id: string; schedule_id: string; period_key: string; due_date: string; planned_month: string; planned_execution_date: string | null; reschedule_count: number; execution_status: OccStatus; job_assignment_id: string | null; pm_assignment_id: string | null; completed_at: string | null; schedule: PMSchedule | null; assignment: PMAssignment | null; job: { job_no: string; status: string; deadline: string; assigned_technicians?: { technician_id: string; technician: { full_name: string } | null }[] } | null };
type ShiftRow = { id: string; technician_id: string; shift_date: string; shift_name: string; starts_at: string; ends_at: string; technician?: { full_name: string } | null };
type CalendarJob = { id: string; job_no: string; title: string; deadline: string; status: string; work_category: string; department_id: string | null; assigned_technicians?: { technician_id: string; technician: { full_name: string } | null }[] };
type PMHistory = { id: string; action: string; details?: Record<string, unknown>; before_data?: Record<string, unknown> | null; after_data?: Record<string, unknown> | null; performed_at: string; occurrence?: { due_date: string; schedule?: { title: string; equipment?: { name: string } | null } | null } | null };
type Tab = 'calendar' | 'schedules' | 'assignments' | 'activation' | 'technicians' | 'history' | 'scope';
type CheckboxOption = { id: string; label: string };
type ScheduleSort = 'due-asc' | 'due-desc' | 'machine-asc' | 'area-asc';
const MONTHS = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
const dayKey = (value: string | Date) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? value
  : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(typeof value === 'string' ? new Date(value) : value);
const monthStart = (value: string) => `${value.slice(0, 7)}-01`;
function CheckboxFilter({ label, options, selected, onChange }: { label: string; options: CheckboxOption[]; selected: string[]; onChange: (ids: string[]) => void }) {
  return <details className="relative min-w-44 rounded-lg border border-slate-200 bg-white">
    <summary className="cursor-pointer list-none px-3 py-2 text-sm text-slate-700">{label}: {selected.length ? `${selected.length} dipilih` : 'Semua'} <span className="float-right text-slate-400">▾</span></summary>
    <div className="absolute left-0 top-full z-20 mt-1 max-h-60 min-w-full overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
      <button type="button" className="mb-1 w-full rounded px-2 py-1 text-left text-xs font-medium text-blue-700 hover:bg-blue-50" onClick={() => onChange([])}>Tampilkan semua</button>
      {options.map((option) => <label key={option.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"><input type="checkbox" checked={selected.includes(option.id)} onChange={(event) => onChange(event.target.checked ? [...new Set([...selected, option.id])] : selected.filter((id) => id !== option.id))} /><span className="truncate">{option.label}</span></label>)}
      {options.length === 0 && <p className="px-2 py-3 text-xs text-slate-400">Tidak ada pilihan.</p>}
    </div>
  </details>;
}
function CategoryCheckboxes({ selected, onChange }: { selected: EquipmentType[]; onChange: (categories: EquipmentType[]) => void }) {
  const colors: Record<EquipmentType, string> = {
    HVAC: 'border-cyan-200 bg-cyan-50 text-cyan-800',
    Mesin: 'border-blue-200 bg-blue-50 text-blue-800',
    LAF: 'border-violet-200 bg-violet-50 text-violet-800',
    Lainnya: 'border-slate-200 bg-slate-100 text-slate-600',
  };
  return <div className="space-y-1">
    <p className="text-sm font-medium text-slate-700">Filter kategori mesin</p>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">{EQUIPMENT_TYPES.map((category) => <label key={category} className="inline-flex cursor-pointer items-center gap-1.5">
      <input type="checkbox" checked={selected.includes(category)} onChange={(event) => onChange(event.target.checked ? [...selected, category] : selected.filter((item) => item !== category))} />
      <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${colors[category]}`}>{category}</span>
    </label>)}</div>
    <p className="text-xs text-slate-400">Pilih satu atau beberapa kategori; kosongkan semua untuk melihat seluruh mesin.</p>
  </div>;
}
const statusInfo = (row: PMOccurrence, today: string) => {
  if (row.execution_status === 'completed') return { label: 'Selesai', cls: 'bg-emerald-100 text-emerald-700' };
  if (row.execution_status === 'not_done') return { label: 'Tidak Dilakukan', cls: 'bg-slate-200 text-slate-700' };
  if (row.execution_status === 'waived') return { label: 'Dikecualikan', cls: 'bg-slate-100 text-slate-600' };
  if (row.execution_status === 'canceled') return { label: 'Dibatalkan', cls: 'bg-rose-100 text-rose-700' };
  const currentMonth = monthStart(today);
  const targetMonth = monthStart(row.planned_month);
  if (currentMonth < targetMonth) return { label: 'Akan Datang', cls: 'bg-blue-100 text-blue-700' };
  if (row.reschedule_count > 0 && currentMonth === targetMonth) return { label: 'Overdue · Carry-over', cls: 'bg-orange-100 text-orange-800' };
  if (currentMonth === targetMonth) return { label: 'Bulan Ini', cls: 'bg-cyan-100 text-cyan-800' };
  return { label: row.reschedule_count === 0 ? 'Overdue · Carry-over' : 'Tidak Dilakukan', cls: row.reschedule_count === 0 ? 'bg-orange-100 text-orange-800' : 'bg-slate-200 text-slate-700' };
};
const occurrenceCalendarDate = (row: PMOccurrence) => row.execution_status === 'completed' && row.completed_at
  ? dayKey(row.completed_at)
  : row.planned_execution_date;

function PMEvidenceGallery({ paths }: { paths: string[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const galleryRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = galleryRef.current;
    if (!element || visible || !paths.length) return;
    if (!('IntersectionObserver' in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '160px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [paths.length, visible]);
  useEffect(() => {
    if (!visible || !paths.length) return;
    let active = true;
    void Promise.all(paths.map(async (path) => {
      if (urls[path]) return [path, urls[path]] as const;
      const { data } = await supabase.storage.from('pm-evidence').createSignedUrl(path, 3600);
      return data?.signedUrl ? [path, data.signedUrl] as const : null;
    })).then((results) => {
      if (active) setUrls((current) => ({ ...current, ...Object.fromEntries(results.filter((item): item is readonly [string, string] => !!item)) }));
    });
    return () => { active = false; };
  }, [paths.join('|'), visible]);
  if (!paths.length) return null;
  return <div ref={galleryRef} className="flex flex-wrap gap-2">{paths.map((path, index) => urls[path]
    ? <a key={path} href={urls[path]} target="_blank" rel="noreferrer" className="block h-20 w-20 overflow-hidden rounded-lg border border-slate-200"><img src={urls[path]} alt={`Bukti PM ${index + 1}`} loading="lazy" className="h-full w-full object-cover" /></a>
    : <span key={path} className="flex h-20 w-20 items-center justify-center rounded-lg bg-slate-100 text-xs text-slate-400">Memuat foto</span>)}</div>;
}

function PMExecutionModal({
  assignment, machineName, scheduleTitle, areaName, busy, drafts, onDraftChange,
  onSaveChecklist, reportNotes, message, onReportChange, onUpload, onClose, onComplete,
}: {
  assignment: PMAssignment;
  machineName: string;
  scheduleTitle: string;
  areaName: string;
  busy: boolean;
  drafts: Record<string, { result: PMChecklistResult; note: string }>;
  onDraftChange: (item: PMAssignmentChecklistItem, result: PMChecklistResult, note: string) => void;
  onSaveChecklist: (item: PMAssignmentChecklistItem, result: PMChecklistResult, note: string) => void;
  reportNotes: string;
  message: string | null;
  onReportChange: (value: string) => void;
  onUpload: (file: File) => void;
  onClose: () => void;
  onComplete: () => void;
}) {
  const checklist = assignment.checklist_items ?? [];
  const isComplete = checklist.every((item) => item.result === 'ok'
    || (item.result === 'not_ok' ? !!item.note?.trim() : item.checked));
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-3 sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={`pm-form-${assignment.id}`} className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
      <div className="flex items-start gap-3 border-b border-slate-200 p-4 sm:p-5"><div className="min-w-0 flex-1"><h2 id={`pm-form-${assignment.id}`} className="text-lg font-semibold">Form pelaksanaan PM</h2><p className="mt-1 text-sm text-slate-500">{machineName} · {scheduleTitle} · {areaName}</p></div><button type="button" onClick={onClose} aria-label="Tutup form PM" className="rounded-lg px-3 py-1 text-xl text-slate-500 hover:bg-slate-100">×</button></div>
      <div className="space-y-4 overflow-y-auto p-4 sm:p-5">
        {message && <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{message}</p>}
        {checklist.length > 0 && <section className="space-y-2"><div className="flex items-center justify-between"><h3 className="font-semibold text-slate-800">Checklist PM</h3><span className="text-xs text-slate-500">{checklist.filter((item) => item.result === 'ok' || (item.result === 'not_ok' && !!item.note?.trim()) || item.checked).length}/{checklist.length} tersimpan</span></div>{checklist.map((item, index) => { const key = `${assignment.id}:${item.id}`; const draft = drafts[key]; const result = draft?.result ?? item.result ?? (item.checked ? 'ok' : ''); const note = draft?.note ?? item.note ?? ''; const hasUnsaved = result !== (item.result ?? (item.checked ? 'ok' : '')) || (result === 'not_ok' && note.trim() !== (item.note ?? '').trim()); return <div key={item.id} className="rounded-lg border border-slate-200 p-3"><p className="mb-2 text-sm font-medium text-slate-800">{index + 1}. {item.description}</p><div className="flex flex-wrap gap-4"><label className="inline-flex items-center gap-2 text-sm"><input type="radio" name={`pm-${assignment.id}-${item.id}`} checked={result === 'ok'} disabled={busy} onChange={() => onDraftChange(item, 'ok', '')} /><span className="font-medium text-emerald-700">OK</span></label><label className="inline-flex items-center gap-2 text-sm"><input type="radio" name={`pm-${assignment.id}-${item.id}`} checked={result === 'not_ok'} disabled={busy} onChange={() => onDraftChange(item, 'not_ok', note)} /><span className="font-medium text-rose-700">Not OK</span></label></div>{result === 'not_ok' && <div className="mt-2 space-y-2"><Textarea rows={2} maxLength={1000} placeholder="Keterangan wajib untuk hasil Not OK" value={note} disabled={busy} onChange={(event) => onDraftChange(item, 'not_ok', event.target.value)} /><Button size="sm" variant="secondary" disabled={busy || !note.trim() || !hasUnsaved} onClick={() => onSaveChecklist(item, result, note)}>Simpan hasil</Button></div>}{result === 'ok' && <div className="mt-2"><Button size="sm" variant="secondary" disabled={busy || !hasUnsaved} onClick={() => onSaveChecklist(item, result, note)}>Simpan hasil</Button></div>}{!result && <p className="mt-1 text-xs text-slate-400">Pilih OK atau Not OK, lalu simpan hasil.</p>}</div>; })}</section>}
        <section className="space-y-3 rounded-xl border border-cyan-200 bg-cyan-50/40 p-3 sm:p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-slate-800">Laporan dan bukti</h3><label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border border-cyan-200 bg-white px-3 py-2 text-sm font-medium text-cyan-800 hover:bg-cyan-50 ${(busy || (assignment.evidence_photos ?? []).length >= 10) ? 'pointer-events-none opacity-50' : ''}`}><Camera className="h-4 w-4" /><ImagePlus className="h-4 w-4" />Ambil / upload foto<input className="hidden" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={busy || (assignment.evidence_photos ?? []).length >= 10} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onUpload(file); event.currentTarget.value = ''; }} /></label></div><p className="text-xs text-slate-500">Maksimal 10 foto. Foto dikompresi di perangkat menjadi kurang dari 200 KB sebelum diunggah.</p><PMEvidenceGallery paths={assignment.evidence_photos ?? []} /><Textarea placeholder="Catatan laporan pekerjaan PM" value={reportNotes} onChange={(event) => onReportChange(event.target.value)} /></section>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 p-4"><Button variant="secondary" onClick={onClose}>Tutup</Button><Button size="sm" disabled={busy || !reportNotes.trim() || !isComplete} onClick={onComplete}><ClipboardCheck className="h-4 w-4" />Kirim Laporan & Selesaikan PM</Button></div>
    </div>
  </div>;
}

function PMReviewModal({
  assignment, machineName, scheduleTitle, areaName, busy, message, onClose, onApprove, onReject,
}: {
  assignment: PMAssignment;
  machineName: string;
  scheduleTitle: string;
  areaName: string;
  busy: boolean;
  message: string | null;
  onClose: () => void;
  onApprove: () => void;
  onReject: (note: string) => void;
}) {
  const [reviewNote, setReviewNote] = useState('');
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-3 sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={`pm-review-${assignment.id}`} className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
      <div className="flex items-start gap-3 border-b border-slate-200 p-4 sm:p-5"><div className="min-w-0 flex-1"><h2 id={`pm-review-${assignment.id}`} className="text-lg font-semibold">Tinjau hasil PM</h2><p className="mt-1 text-sm text-slate-500">{machineName} · {scheduleTitle} · {areaName}</p><p className="mt-1 text-xs text-slate-500">Penugasan {assignment.assignment_no} · Due {assignment.deadline}</p></div><button type="button" onClick={onClose} aria-label="Tutup review PM" className="rounded-lg px-3 py-1 text-xl text-slate-500 hover:bg-slate-100">×</button></div>
      <div className="space-y-4 overflow-y-auto p-4 sm:p-5">
        {message && <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{message}</p>}
        <section><h3 className="mb-2 font-semibold text-slate-800">Checklist pelaksanaan</h3>{assignment.checklist_items?.length ? <div className="space-y-2">{assignment.checklist_items.map((item, index) => <div key={item.id} className="rounded-lg border border-slate-200 p-3"><div className="flex flex-wrap items-center gap-2"><p className="min-w-0 flex-1 text-sm text-slate-800">{index + 1}. {item.description}</p><Badge className={item.result === 'ok' || (!item.result && item.checked) ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}>{item.result === 'ok' || (!item.result && item.checked) ? 'OK' : item.result === 'not_ok' ? 'Not OK' : 'Belum diisi'}</Badge></div>{item.result === 'not_ok' && item.note && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">Keterangan: {item.note}</p>}</div>)}</div> : <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500">Tidak ada checklist pada jadwal ini.</p>}</section>
        <section className="space-y-2"><h3 className="font-semibold text-slate-800">Laporan teknisi</h3><p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{assignment.report_notes || 'Tidak ada catatan laporan.'}</p></section>
        <section className="space-y-2"><h3 className="font-semibold text-slate-800">Foto bukti ({assignment.evidence_photos?.length ?? 0})</h3>{assignment.evidence_photos?.length ? <PMEvidenceGallery paths={assignment.evidence_photos} /> : <p className="text-sm text-slate-500">Tidak ada foto bukti.</p>}</section>
        <section className="space-y-2"><h3 className="font-semibold text-slate-800">Catatan penolakan</h3><Textarea rows={3} maxLength={1000} placeholder="Wajib diisi jika PM ditolak dan dikembalikan ke teknisi" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} disabled={busy} /></section>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 p-4"><Button variant="secondary" onClick={onClose} disabled={busy}>Tutup</Button><Button size="sm" variant="secondary" className="text-rose-700 hover:bg-rose-50" disabled={busy || !reviewNote.trim()} onClick={() => onReject(reviewNote.trim())}><XCircle className="h-4 w-4" />Tolak PM</Button><Button size="sm" disabled={busy} onClick={onApprove}><ClipboardCheck className="h-4 w-4" />Setujui PM</Button></div>
    </div>
  </div>;
}

const PM_PHOTO_MAX_BYTES = 190 * 1024;

async function compressPmPhoto(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    let quality = 0.82;
    for (let attempt = 0; attempt < 24; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Browser tidak dapat memproses gambar.');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Gagal mengompresi gambar.')), 'image/jpeg', quality);
      });
      if (blob.size <= PM_PHOTO_MAX_BYTES) {
        const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'pm-photo';
        return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
      }
      if (quality > 0.46) quality = Math.max(0.42, quality - 0.08);
      else { scale *= 0.86; quality = 0.78; }
    }
    throw new Error('Ukuran foto belum dapat diperkecil di bawah 200 KB. Pilih foto lain.');
  } finally {
    bitmap.close();
  }
}

export default function PreventiveMaintenance() {
  const { profile } = useAuth();
  const isManager = !!profile && ['admin','ss','spv'].includes(profile.role);
  const isAdmin = profile?.role === 'admin';
  const isScopeAdmin = !!profile && ['admin','ss'].includes(profile.role);
  const canEditSchedules = profile?.role === 'admin' || profile?.role === 'ss';
  const canEditDepartmentScope = !!profile && ['admin','ss','spv'].includes(profile.role);
  const canAssignTechnicians = isManager;
  const today = dayKey(new Date());
  const [tab, setTab] = useState<Tab>('calendar');
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [month, setMonth] = useState(Number(today.slice(5, 7)));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<PMSchedule[]>([]);
  const [occurrences, setOccurrences] = useState<PMOccurrence[]>([]);
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [departmentSettings, setDepartmentSettings] = useState<DepartmentPMSetting[]>([]);
  const [departmentScopes, setDepartmentScopes] = useState<DepartmentEquipmentScope[]>([]);
  const [selectedDepartmentId, setSelectedDepartmentId] = useState('');
  const [scopeEquipmentDraft, setScopeEquipmentDraft] = useState<string[]>([]);
  const [scopeAreaFilters, setScopeAreaFilters] = useState<string[]>([]);
  const [scopeMachineFilters, setScopeMachineFilters] = useState<string[]>([]);
  const [scopeSortBy, setScopeSortBy] = useState<'name-asc' | 'name-desc' | 'area-asc'>('name-asc');
  const [scopeEquipmentTypeFilters, setScopeEquipmentTypeFilters] = useState<EquipmentType[]>([]);
  const [scheduleAreaFilters, setScheduleAreaFilters] = useState<string[]>([]);
  const [scheduleMachineFilters, setScheduleMachineFilters] = useState<string[]>([]);
  const [scheduleEquipmentTypeFilters, setScheduleEquipmentTypeFilters] = useState<EquipmentType[]>([]);
  const [scheduleSortBy, setScheduleSortBy] = useState<ScheduleSort>('due-asc');
  const [equipment, setEquipment] = useState<EquipmentOption[]>([]);
  const [technicians, setTechnicians] = useState<Profile[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [calendarJobs, setCalendarJobs] = useState<CalendarJob[]>([]);
  const [occurrenceHistory, setOccurrenceHistory] = useState<PMHistory[]>([]);
  const [scheduleHistory, setScheduleHistory] = useState<PMHistory[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<PMSchedule | null>(null);
  const [busy, setBusy] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({ area_id: '', equipment_ids: [] as string[], title: '', description: '', interval_months: 1, schedule_mode: 'fixed_calendar' as Mode, anchor_due_date: today, end_date: '' });
  const [scheduleChecklist, setScheduleChecklist] = useState<PMChecklistItem[]>([]);
  const [assigning, setAssigning] = useState<PMOccurrence | null>(null);
  const [technicianIds, setTechnicianIds] = useState<string[]>([]);
  const [plannedDate, setPlannedDate] = useState('');
  const [assignmentPriority, setAssignmentPriority] = useState('normal');
  const [pmReportNotes, setPmReportNotes] = useState<Record<string, string>>({});
  const [pmChecklistDrafts, setPmChecklistDrafts] = useState<Record<string, { result: PMChecklistResult; note: string }>>({});
  const [executionAssignmentId, setExecutionAssignmentId] = useState<string | null>(null);
  const [reviewAssignmentId, setReviewAssignmentId] = useState<string | null>(null);
  const [selectedPmDate, setSelectedPmDate] = useState(`${today.slice(0, 7)}-01`);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    setHistoryLoaded(false);
    const cycle = isManager ? await supabase.rpc('pm_run_cycle') : { error: null };
    const [scheduleRes, occurrenceRes, equipmentRes, techRes, shiftRes, jobsRes, departmentRes, settingRes, scopeRes] = await Promise.all([
      supabase.from('pm_schedules').select('id,department_id,equipment_id,title,description,checklist_items,interval_months,schedule_mode,anchor_due_date,next_due_date,end_date,is_active,equipment:equipment(id,name,code,equipment_types,area:areas(id,name,department_id))').eq('is_deleted', false).order('anchor_due_date'),
      supabase.from('pm_occurrences').select('id,schedule_id,period_key,due_date,planned_month,planned_execution_date,reschedule_count,execution_status,job_assignment_id,pm_assignment_id,completed_at,schedule:pm_schedules(id,department_id,equipment_id,title,description,checklist_items,interval_months,schedule_mode,anchor_due_date,next_due_date,end_date,is_active,is_deleted,equipment:equipment(id,name,code,equipment_types,area:areas(id,name,department_id))),assignment:pm_assignments!pm_occurrences_pm_assignment_id_fkey(id,assignment_no,status,planned_date,deadline,priority,report_notes,checklist_items,evidence_photos,pending_reason,review_note,assigned_technicians:pm_assignment_technicians(technician_id,technician:profiles!technician_id(full_name))),job:job_assignments(job_no,status,deadline,assigned_technicians:job_assignment_technicians(technician_id,technician:profiles!technician_id(full_name)))').order('due_date'),
      supabase.from('equipment').select('id,name,code,equipment_types,area:areas(id,name,department_id)').order('name'),
      supabase.from('profiles').select('id,full_name,username,role,work_schedule_type,is_active,department_id,department_assignments:profile_departments(department_id)').eq('role','teknisi').eq('is_active',true).order('full_name'),
      supabase.from('technician_shift_assignments').select('id,technician_id,shift_date,shift_name,starts_at,ends_at,technician:profiles!technician_id(full_name)').gte('shift_date', `${year}-01-01`).lte('shift_date', `${year}-12-31`).order('shift_date'),
      supabase.from('job_assignments').select('id,job_no,title,deadline,status,work_category,department_id,assigned_technicians:job_assignment_technicians(technician_id,technician:profiles!technician_id(full_name))').neq('work_category','preventive_maintenance').gte('deadline', `${year}-01-01`).lt('deadline', `${year + 1}-01-01`).order('deadline'),
      supabase.from('departments').select('id,name,code').order('name'),
      supabase.from('department_pm_settings').select('department_id,pm_enabled'),
      supabase.from('department_equipment_scope').select('department_id,equipment_id'),
    ]);
    if (cycle.error) console.error('PM cycle:', cycle.error.message);
    if (scheduleRes.error || occurrenceRes.error || equipmentRes.error || departmentRes.error || settingRes.error || scopeRes.error) setError(scheduleRes.error?.message ?? occurrenceRes.error?.message ?? equipmentRes.error?.message ?? departmentRes.error?.message ?? settingRes.error?.message ?? scopeRes.error?.message ?? 'Gagal memuat Preventive Maintenance.');
    setSchedules((scheduleRes.data as unknown as PMSchedule[]) ?? []);
    setOccurrences((occurrenceRes.data as unknown as PMOccurrence[]) ?? []);
    setDepartments((departmentRes.data as DepartmentOption[]) ?? []);
    setDepartmentSettings((settingRes.data as DepartmentPMSetting[]) ?? []);
    setDepartmentScopes((scopeRes.data as DepartmentEquipmentScope[]) ?? []);
    setEquipment((equipmentRes.data as unknown as EquipmentOption[]) ?? []);
    const technicianRows = (techRes.data ?? []) as unknown as (Profile & { department_assignments?: { department_id: string }[] })[];
    setTechnicians(technicianRows.map((technician) => ({
      ...technician,
      department_ids: [...new Set([...(technician.department_assignments ?? []).map((assignment) => assignment.department_id), ...(technician.department_id ? [technician.department_id] : [])])],
    })));
    setShifts((shiftRes.data as unknown as ShiftRow[]) ?? []);
    setCalendarJobs((jobsRes.data as unknown as CalendarJob[]) ?? []);
    setLoading(false);
  }, [isManager, year]);

  useEffect(() => { void load(); }, [load]);

  // History contains JSON snapshots. Fetch it only when the user opens the History tab.
  useEffect(() => {
    if (tab !== 'history' || historyLoaded) return;
    let active = true;
    void Promise.all([
      supabase.from('pm_occurrence_history')
        .select('id,action,details,performed_at,occurrence:pm_occurrences(due_date,schedule:pm_schedules(title,equipment:equipment(name)))')
        .order('performed_at', { ascending: false }).limit(200),
      supabase.from('pm_schedule_history')
        .select('id,action,after_data,performed_at')
        .order('performed_at', { ascending: false }).limit(200),
    ]).then(([occurrenceRes, scheduleRes]) => {
      if (!active) return;
      setOccurrenceHistory((occurrenceRes.data as unknown as PMHistory[]) ?? []);
      setScheduleHistory((scheduleRes.data as unknown as PMHistory[]) ?? []);
      if (occurrenceRes.error || scheduleRes.error) {
        setError(occurrenceRes.error?.message ?? scheduleRes.error?.message ?? 'Gagal memuat riwayat PM.');
      }
      setHistoryLoaded(true);
    });
    return () => { active = false; };
  }, [historyLoaded, tab]);

  const availableDepartments = useMemo(() => {
    if (profile?.role === 'admin') return departments;
    if (profile?.role === 'ss' || profile?.role === 'spv') {
      const assigned = new Set(profile.profile_department_ids ?? []);
      return departments.filter((department) => assigned.has(department.id));
    }
    return [];
  }, [departments, profile]);
  useEffect(() => {
    if (!isManager || availableDepartments.length === 0) return;
    if (!availableDepartments.some((department) => department.id === selectedDepartmentId)) {
      setSelectedDepartmentId(availableDepartments[0].id);
    }
  }, [availableDepartments, isManager, selectedDepartmentId]);
  useEffect(() => {
    if (!selectedDepartmentId) return;
    setScopeEquipmentDraft(departmentScopes.filter((item) => item.department_id === selectedDepartmentId).map((item) => item.equipment_id));
    setScopeAreaFilters([]);
    setScopeMachineFilters([]);
    setScheduleAreaFilters([]);
    setScheduleMachineFilters([]);
  }, [selectedDepartmentId, departmentSettings, departmentScopes]);
  const selectedDepartment = departments.find((department) => department.id === selectedDepartmentId) ?? null;
  const selectedDepartmentEnabled = departmentSettings.find((setting) => setting.department_id === selectedDepartmentId)?.pm_enabled ?? false;
  const selectedScopeIds = departmentScopes.filter((item) => item.department_id === selectedDepartmentId).map((item) => item.equipment_id);
  const scopedEquipment = equipment.filter((item) => selectedScopeIds.includes(item.id));
  const departmentTechnicians = technicians.filter((technician) => !isManager || (!!selectedDepartmentId && (technician.department_ids?.includes(selectedDepartmentId) || technician.department_id === selectedDepartmentId)));
  const departmentTechnicianIds = new Set(departmentTechnicians.map((technician) => technician.id));
  const departmentShifts = shifts.filter((shift) => departmentTechnicianIds.has(shift.technician_id));
  const departmentJobs = calendarJobs.filter((job) => !isManager || (!!selectedDepartmentId && job.department_id === selectedDepartmentId));
  const scopeAreas = [...new Map(scopedEquipment.filter((item) => item.area).map((item) => [item.area!.id, item.area!])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const locations = scopeAreas;
  // Areas are independent of departments, so the selected PM department controls
  // which scope is being edited, while the catalog itself includes every machine.
  const departmentEquipment = equipment;
  const catalogAreas = [...new Map(departmentEquipment.filter((item) => item.area).map((item) => [item.area!.id, item.area!])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const visibleScopeEquipment = departmentEquipment.filter((item) =>
    (!scopeAreaFilters.length || (item.area?.id && scopeAreaFilters.includes(item.area.id)))
    && (!scopeMachineFilters.length || scopeMachineFilters.includes(item.id))
    && (!scopeEquipmentTypeFilters.length || !!item.equipment_types?.some((category) => scopeEquipmentTypeFilters.includes(category)))
  ).sort((a, b) => scopeSortBy === 'name-desc'
    ? b.name.localeCompare(a.name)
    : scopeSortBy === 'area-asc'
      ? (a.area?.name ?? '').localeCompare(b.area?.name ?? '') || a.name.localeCompare(b.name)
      : a.name.localeCompare(b.name));
  const visibleScopedEquipmentCount = visibleScopeEquipment.filter((item) => scopeEquipmentDraft.includes(item.id)).length;
  const visibleOutOfScopeEquipmentCount = visibleScopeEquipment.length - visibleScopedEquipmentCount;
  const allVisibleScopeEquipmentSelected = visibleScopeEquipment.length > 0
    && visibleScopeEquipment.every((item) => scopeEquipmentDraft.includes(item.id));
  const machinesInSelectedLocation = scopedEquipment.filter((item) => item.area?.id === scheduleForm.area_id);
  const allLocationMachinesSelected = machinesInSelectedLocation.length > 0
    && machinesInSelectedLocation.every((item) => scheduleForm.equipment_ids.includes(item.id));

  const rowsForYear = useMemo(() => occurrences.filter((row) =>
    row.schedule?.is_deleted !== true
    && (row.due_date.startsWith(String(year)) || row.planned_month.startsWith(String(year)))
    && (!isManager || (!!selectedDepartmentId && !!row.schedule
      && row.schedule.department_id === selectedDepartmentId
      && selectedScopeIds.includes(row.schedule.equipment_id)))
  ), [occurrences, year, isManager, selectedDepartmentId, selectedScopeIds]);
  const currentMonthRows = rowsForYear.filter((row) => row.planned_month.startsWith(`${year}-${String(month).padStart(2, '0')}`));
  const filteredCurrentMonthRows = currentMonthRows.filter((row) =>
    (!scheduleAreaFilters.length || (!!row.schedule?.equipment?.area?.id && scheduleAreaFilters.includes(row.schedule.equipment.area.id)))
    && (!scheduleMachineFilters.length || (!!row.schedule?.equipment_id && scheduleMachineFilters.includes(row.schedule.equipment_id)))
    && (!scheduleEquipmentTypeFilters.length || !!row.schedule?.equipment?.equipment_types?.some((category) => scheduleEquipmentTypeFilters.includes(category)))
  );
  const sortedCurrentMonthRows = [...filteredCurrentMonthRows].sort((a, b) => {
    if (scheduleSortBy === 'machine-asc') return (a.schedule?.equipment?.name ?? '').localeCompare(b.schedule?.equipment?.name ?? '');
    if (scheduleSortBy === 'area-asc') return (a.schedule?.equipment?.area?.name ?? '').localeCompare(b.schedule?.equipment?.area?.name ?? '') || (a.schedule?.equipment?.name ?? '').localeCompare(b.schedule?.equipment?.name ?? '');
    return scheduleSortBy === 'due-desc' ? b.due_date.localeCompare(a.due_date) : a.due_date.localeCompare(b.due_date);
  });
  // Soft-deleted schedules retain their occurrence history, but should no longer
  // create actionable entries in the technician assignment queue.
  const assignmentRows = sortedCurrentMonthRows.filter((row) => row.schedule?.is_deleted !== true);
  const selectedDayRows = sortedCurrentMonthRows.filter((row) => occurrenceCalendarDate(row) === selectedPmDate);
  const departmentSchedulesInScope = schedules.filter((schedule) => !isManager || (!!selectedDepartmentId
    && schedule.department_id === selectedDepartmentId
    && selectedScopeIds.includes(schedule.equipment_id)));
  const selectedDepartmentSchedules = departmentSchedulesInScope.filter((schedule) =>
    (!scheduleAreaFilters.length || (!!schedule.equipment?.area?.id && scheduleAreaFilters.includes(schedule.equipment.area.id)))
    && (!scheduleMachineFilters.length || scheduleMachineFilters.includes(schedule.equipment_id))
    && (!scheduleEquipmentTypeFilters.length || !!schedule.equipment?.equipment_types?.some((category) => scheduleEquipmentTypeFilters.includes(category))))
    .sort((a, b) => {
      if (scheduleSortBy === 'machine-asc') return (a.equipment?.name ?? '').localeCompare(b.equipment?.name ?? '');
      if (scheduleSortBy === 'area-asc') return (a.equipment?.area?.name ?? '').localeCompare(b.equipment?.area?.name ?? '') || (a.equipment?.name ?? '').localeCompare(b.equipment?.name ?? '');
      return scheduleSortBy === 'due-desc' ? b.anchor_due_date.localeCompare(a.anchor_due_date) : a.anchor_due_date.localeCompare(b.anchor_due_date);
    });
  const legacySchedules = schedules.filter((schedule) => schedule.department_id === null);
  const pendingRows = currentMonthRows.filter((row) => row.execution_status === 'open' && !row.pm_assignment_id);
  const scheduleFilterControls = <Card className="flex flex-wrap items-end gap-3 p-3">
    <CheckboxFilter label="Area" options={scopeAreas.map((area) => ({ id: area.id, label: area.name }))} selected={scheduleAreaFilters} onChange={setScheduleAreaFilters} />
    <CheckboxFilter label="Mesin target" options={scopedEquipment.map((item) => ({ id: item.id, label: `${item.name}${item.code ? ` (${item.code})` : ''}` }))} selected={scheduleMachineFilters} onChange={setScheduleMachineFilters} />
    <div className="min-w-48"><Label>Urutkan</Label><Select value={scheduleSortBy} onChange={(event) => setScheduleSortBy(event.target.value as ScheduleSort)}><option value="due-asc">Due terdekat</option><option value="due-desc">Due terjauh</option><option value="machine-asc">Nama mesin A–Z</option><option value="area-asc">Area A–Z</option></Select></div>
    <div className="w-full"><CategoryCheckboxes selected={scheduleEquipmentTypeFilters} onChange={setScheduleEquipmentTypeFilters} /></div>
    <p className="w-full text-xs text-slate-500">Pilih beberapa area atau mesin melalui checkbox. Kosongkan filter untuk menampilkan semua mesin dalam cakupan.</p>
  </Card>;
  const scopeFilterControls = <Card className="flex flex-wrap items-end gap-3 p-3">
    <CheckboxFilter label="Area" options={catalogAreas.map((area) => ({ id: area.id, label: area.name }))} selected={scopeAreaFilters} onChange={setScopeAreaFilters} />
    <CheckboxFilter label="Mesin target" options={departmentEquipment.map((item) => ({ id: item.id, label: `${item.name}${item.code ? ` (${item.code})` : ''}` }))} selected={scopeMachineFilters} onChange={setScopeMachineFilters} />
    <div className="w-full"><CategoryCheckboxes selected={scopeEquipmentTypeFilters} onChange={setScopeEquipmentTypeFilters} /></div>
    <div className="min-w-40"><Label>Urutkan</Label><Select value={scopeSortBy} onChange={(event) => setScopeSortBy(event.target.value as typeof scopeSortBy)}><option value="name-asc">Mesin A–Z</option><option value="name-desc">Mesin Z–A</option><option value="area-asc">Area A–Z</option></Select></div>
  </Card>;
  const calendarEntries = useMemo(() => {
    const entries = rowsForYear.map((row) => ({ key: row.id, schedule: row.schedule, due_date: row.due_date, planned_month: row.planned_month, label: statusInfo(row, today).label, projection: false }));
    const existing = new Set(rowsForYear.map((row) => `${row.schedule_id}:${row.due_date}`));
    const currentMonthKey = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7));
    for (const schedule of departmentSchedulesInScope.filter((item) => item.is_active && (!isManager || selectedDepartmentEnabled))) {
      const dueDates: string[] = [];
      if (schedule.schedule_mode === 'fixed_calendar') {
        const anchorYear = Number(schedule.anchor_due_date.slice(0, 4));
        const anchorMonth = Number(schedule.anchor_due_date.slice(5, 7));
        const anchorDay = Number(schedule.anchor_due_date.slice(8, 10));
        for (let targetMonth = 1; targetMonth <= 12; targetMonth += 1) {
          const monthIndex = (year - anchorYear) * 12 + targetMonth - anchorMonth;
          const absoluteMonth = year * 12 + targetMonth;
          if (monthIndex < 0 || monthIndex % schedule.interval_months !== 0 || absoluteMonth < currentMonthKey) continue;
          const lastDay = new Date(Date.UTC(year, targetMonth, 0)).getUTCDate();
          const dueDate = `${year}-${String(targetMonth).padStart(2, '0')}-${String(Math.min(anchorDay, lastDay)).padStart(2, '0')}`;
          if (!schedule.end_date || dueDate <= schedule.end_date) dueDates.push(dueDate);
        }
      } else if (schedule.next_due_date?.startsWith(String(year)) && Number(schedule.next_due_date.slice(0, 4)) * 12 + Number(schedule.next_due_date.slice(5, 7)) >= currentMonthKey) {
        dueDates.push(schedule.next_due_date);
      }
      for (const dueDate of dueDates) {
        if (existing.has(`${schedule.id}:${dueDate}`)) continue;
        entries.push({ key: `${schedule.id}:${dueDate}:projection`, schedule, due_date: dueDate, planned_month: monthStart(dueDate), label: 'Proyeksi', projection: true });
      }
    }
    return entries;
  }, [rowsForYear, departmentSchedulesInScope, today, year, isManager, selectedDepartmentEnabled]);
  const [formMessage, setFormMessage] = useState<string | null>(null);

  function startCreateSchedule() {
    if (!selectedDepartmentEnabled || !selectedDepartmentId) {
      setFormMessage('Aktifkan program PM dan atur cakupan mesin departemen terlebih dahulu.');
      return;
    }
    setEditingSchedule(null); setScheduleChecklist([]); setScheduleForm({ area_id: '', equipment_ids: [], title: '', description: '', interval_months: 1, schedule_mode: 'fixed_calendar', anchor_due_date: `${today.slice(0, 7)}-01`, end_date: '' }); setShowScheduleForm(true);
  }
  function startEditSchedule(schedule: PMSchedule) {
    if (!canEditSchedules || (profile?.role === 'ss' && schedule.department_id !== selectedDepartmentId)) {
      setFormMessage('Edit jadwal PM hanya dapat dilakukan Admin atau SS pada lingkup departemennya.');
      return;
    }
    const usedIds = new Set<string>();
    const checklist = (schedule.checklist_items ?? []).map((item) => {
      let id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || usedIds.has(id)) id = uuid();
      usedIds.add(id);
      return { id, description: typeof item.description === 'string' ? item.description : '' };
    });
    setEditingSchedule(schedule); setScheduleChecklist(checklist); setScheduleForm({ area_id: schedule.equipment?.area?.id ?? '', equipment_ids: [schedule.equipment_id], title: schedule.title, description: schedule.description ?? '', interval_months: schedule.interval_months, schedule_mode: schedule.schedule_mode, anchor_due_date: `${schedule.anchor_due_date.slice(0, 7)}-01`, end_date: schedule.end_date ?? '' }); setFormMessage(null); setShowScheduleForm(true);
  }
  async function saveSchedule() {
    if (editingSchedule && (!canEditSchedules || (profile?.role === 'ss' && editingSchedule.department_id !== selectedDepartmentId))) {
      setFormMessage('Edit jadwal PM hanya dapat dilakukan Admin atau SS pada lingkup departemennya.');
      return;
    }
    if (!isManager || !selectedDepartmentId || !selectedDepartmentEnabled || !scheduleForm.area_id || !scheduleForm.equipment_ids.length || !scheduleForm.title.trim() || !Number.isInteger(scheduleForm.interval_months) || scheduleForm.interval_months < 1) return;
    if (editingSchedule && scheduleForm.equipment_ids.length !== 1) return;
    const normalizedChecklist = scheduleChecklist.map((item) => ({ ...item, description: item.description.trim() }));
    const invalidChecklistIndex = normalizedChecklist.findIndex((item) => !item.description || item.description.length > 500);
    if (invalidChecklistIndex >= 0) {
      setFormMessage(`Deskripsi checklist item ${invalidChecklistIndex + 1} wajib diisi dan maksimal 500 karakter.`);
      return;
    }
    if (new Set(normalizedChecklist.map((item) => item.id)).size !== normalizedChecklist.length) {
      setFormMessage('Ada ID checklist yang duplikat. Hapus item duplikat, lalu tambahkan kembali.');
      return;
    }
    const targetEquipmentId = scheduleForm.equipment_ids[0];
    const cadenceChanged = !!editingSchedule && (
      editingSchedule.equipment_id !== targetEquipmentId
      || editingSchedule.department_id !== selectedDepartmentId
      || editingSchedule.interval_months !== scheduleForm.interval_months
      || editingSchedule.schedule_mode !== scheduleForm.schedule_mode
      || editingSchedule.anchor_due_date !== scheduleForm.anchor_due_date
    );
    if (cadenceChanged && occurrences.some((row) => row.schedule_id === editingSchedule?.id)) {
      setFormMessage('Jadwal ini sudah memiliki occurrence. Nonaktifkan jadwal lama lalu buat jadwal baru agar riwayat dan cadence tidak berubah.');
      return;
    }
    setBusy(true);
    const endDate = scheduleForm.end_date ? `${scheduleForm.end_date.slice(0, 7)}-${new Date(Number(scheduleForm.end_date.slice(0, 4)), Number(scheduleForm.end_date.slice(5, 7)), 0).getDate()}` : null;
    const values = { department_id: selectedDepartmentId, title: scheduleForm.title.trim(), description: scheduleForm.description.trim() || null, checklist_items: normalizedChecklist.map((item) => ({ id: item.id, description: item.description })), interval_months: scheduleForm.interval_months, schedule_mode: scheduleForm.schedule_mode, anchor_due_date: `${scheduleForm.anchor_due_date.slice(0, 7)}-01`, next_due_date: scheduleForm.schedule_mode === 'execution_based' ? (editingSchedule?.schedule_mode === 'execution_based' ? editingSchedule.next_due_date : `${scheduleForm.anchor_due_date.slice(0, 7)}-01`) : null, end_date: endDate, updated_at: new Date().toISOString() };
    const result = editingSchedule
      ? await supabase.from('pm_schedules').update({ ...values, equipment_id: targetEquipmentId }).eq('id', editingSchedule.id)
      : await supabase.from('pm_schedules').insert(scheduleForm.equipment_ids.map((equipment_id) => ({ ...values, equipment_id, created_by: profile!.id })));
    setBusy(false);
    if (result.error) { setFormMessage(result.error.message); return; }
    setShowScheduleForm(false); setFormMessage(null); await load();
  }
  function addScheduleChecklistItem() {
    if (scheduleChecklist.length >= 50) {
      setFormMessage('Checklist PM maksimal 50 item.');
      return;
    }
    setScheduleChecklist((items) => [...items, { id: uuid(), description: '' }]);
  }
  async function setPmChecklistItem(assignment: PMAssignment, item: PMAssignmentChecklistItem, result: PMChecklistResult, note: string) {
    if (!result) {
      setFormMessage('Pilih hasil checklist OK atau Not OK.');
      return;
    }
    if (result === 'not_ok' && !note.trim()) {
      setFormMessage('Keterangan wajib diisi untuk hasil Not OK.');
      return;
    }
    setBusy(true);
    const { error: saveError } = await supabase.rpc('pm_set_assignment_checklist_item', {
      p_assignment_id: assignment.id,
      p_item_id: item.id,
      p_result: result,
      p_note: result === 'not_ok' ? note.trim() : null,
    });
    setBusy(false);
    if (saveError) { setFormMessage(saveError.message); return; }
    setPmChecklistDrafts((drafts) => {
      const next = { ...drafts };
      delete next[`${assignment.id}:${item.id}`];
      return next;
    });
    setFormMessage(null);
    await load();
  }
  async function uploadPmEvidence(assignment: PMAssignment, file: File) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setFormMessage('Foto bukti harus berformat JPG, PNG, atau WEBP.');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setFormMessage('Ukuran foto sebelum kompresi maksimal 20 MB.');
      return;
    }
    if ((assignment.evidence_photos ?? []).length >= 10) {
      setFormMessage('Maksimal 10 foto bukti per penugasan PM.');
      return;
    }
    setBusy(true);
    let compressed: File;
    try {
      compressed = await compressPmPhoto(file);
    } catch (error) {
      setBusy(false);
      setFormMessage(error instanceof Error ? error.message : 'Gagal mengompresi foto PM.');
      return;
    }
    const path = `${assignment.id}/${uuid()}.jpg`;
    const { error: uploadError } = await supabase.storage.from('pm-evidence').upload(path, compressed, { contentType: 'image/jpeg', upsert: false });
    if (uploadError) {
      setBusy(false);
      setFormMessage(`Foto belum terunggah: ${uploadError.message}`);
      return;
    }
    const { error: linkError } = await supabase.rpc('pm_add_assignment_evidence', {
      p_assignment_id: assignment.id,
      p_storage_path: path,
    });
    if (linkError) {
      await supabase.storage.from('pm-evidence').remove([path]);
      setBusy(false);
      setFormMessage(`Foto terunggah, tetapi gagal ditautkan ke penugasan: ${linkError.message}`);
      return;
    }
    setBusy(false);
    setFormMessage(null);
    await load();
  }
  async function toggleSchedule(schedule: PMSchedule) {
    if (!isManager || !window.confirm(`${schedule.is_active ? 'Nonaktifkan' : 'Aktifkan'} jadwal “${schedule.title}”?`)) return;
    const { error: updateError } = await supabase.rpc('pm_set_schedule_active', { p_schedule_id: schedule.id, p_is_active: !schedule.is_active });
    if (updateError) setFormMessage(updateError.message); else await load();
  }
  async function deleteSchedule(schedule: PMSchedule) {
    if (!isAdmin || busy) return;
    const confirmed = window.confirm(`Hapus jadwal PM “${schedule.title}” untuk ${schedule.equipment?.name ?? 'mesin ini'}? Jadwal akan disembunyikan dari daftar aktif. Riwayat, foto, dan penugasan yang sudah berjalan tetap disimpan.`);
    if (!confirmed) return;
    setBusy(true);
    const { error: deleteError } = await supabase.rpc('pm_admin_delete_schedule', { p_schedule_id: schedule.id });
    setBusy(false);
    if (deleteError) { setFormMessage(`Jadwal PM gagal dihapus: ${deleteError.message}`); return; }
    setFormMessage('Jadwal PM dihapus dari daftar aktif; riwayat dan penugasan yang berjalan tetap tersimpan.');
    await load();
  }
  async function saveAssignment() {
    if (!canAssignTechnicians || !assigning || !technicianIds.length) return;
    setBusy(true);
    const { data, error: saveError } = assigning.pm_assignment_id
      ? await supabase.rpc('pm_reassign_pm_assignment', { p_occurrence_id: assigning.id, p_technician_ids: technicianIds, p_planned_date: plannedDate || null, p_priority: assignmentPriority })
      : await supabase.rpc('pm_create_pm_assignment', { p_occurrence_id: assigning.id, p_technician_ids: technicianIds, p_planned_date: plannedDate || null, p_priority: assignmentPriority });
    setBusy(false);
    if (saveError) { setFormMessage(saveError.message); return; }
    setAssigning(null); setTechnicianIds([]); setFormMessage(`Penugasan PM ${String(data).slice(0, 8)} berhasil disimpan.`); await load();
  }
  async function saveDepartmentScope() {
    if (!canEditDepartmentScope || !selectedDepartmentId) return;
    setBusy(true);
    const { error: saveError } = await supabase.rpc('pm_save_department_equipment_scope', {
      p_department_id: selectedDepartmentId,
      p_equipment_ids: scopeEquipmentDraft,
    });
    setBusy(false);
    if (saveError) { setFormMessage(`Cakupan belum tersimpan: ${saveError.message}`); return; }
    const { data: savedRows, error: reloadError } = await supabase.from('department_equipment_scope')
      .select('department_id,equipment_id').eq('department_id', selectedDepartmentId);
    if (reloadError) {
      setFormMessage(`Perubahan cakupan terkirim, tetapi data tersimpan gagal dimuat ulang: ${reloadError.message}`);
      return;
    }
    const persisted = (savedRows ?? []) as DepartmentEquipmentScope[];
    setDepartmentScopes((current) => [
      ...current.filter((item) => item.department_id !== selectedDepartmentId),
      ...persisted,
    ]);
    const requestedIds = [...new Set(scopeEquipmentDraft)].sort();
    const persistedIds = persisted.map((item) => item.equipment_id).sort();
    if (requestedIds.length !== persistedIds.length || requestedIds.some((id, index) => id !== persistedIds[index])) {
      setFormMessage('Data cakupan tersimpan belum sama dengan pilihan. Muat ulang halaman dan periksa kembali hak akses atau validasi database.');
      return;
    }
    setFormMessage(`Cakupan PM ${selectedDepartment?.name ?? 'departemen'} berhasil disimpan (${persisted.length} mesin).`);
  }
  async function mapLegacySchedule(schedule: PMSchedule) {
    if (!isScopeAdmin || !selectedDepartmentId || !selectedDepartmentEnabled) return;
    setBusy(true);
    const { error: mapError } = await supabase.rpc('pm_assign_legacy_schedule', { p_schedule_id: schedule.id, p_department_id: selectedDepartmentId });
    setBusy(false);
    if (mapError) { setFormMessage(mapError.message); return; }
    setFormMessage(`Jadwal “${schedule.title}” dipetakan ke ${selectedDepartment?.name}.`);
    await load();
  }
  function openAssignment(row: PMOccurrence, dateOverride?: string) {
    if (!canAssignTechnicians) return;
    setAssigning(row); setTechnicianIds(row.assignment?.assigned_technicians?.map((member) => member.technician_id) ?? row.job?.assigned_technicians?.map((member) => member.technician_id) ?? []);
    setAssignmentPriority(row.assignment?.priority ?? 'normal');
    const targetMonth = monthStart(row.planned_month);
    const minDate = targetMonth < today.slice(0, 7) + '-01' ? today : targetMonth;
    const oldDate = row.assignment?.planned_date ?? row.planned_execution_date ?? '';
    setPlannedDate(dateOverride && dateOverride >= minDate ? dateOverride : oldDate >= minDate && oldDate.startsWith(row.planned_month.slice(0, 7)) ? oldDate : '');
    setFormMessage(null);
  }

  function changeMonth(delta: number) {
    const next = new Date(year, month - 1 + delta, 1);
    const nextYear = next.getFullYear();
    const nextMonth = next.getMonth() + 1;
    setYear(nextYear);
    setMonth(nextMonth);
    setSelectedPmDate(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01`);
  }

  const tabs: { id: Tab; label: string }[] = isManager
    ? [
        { id: 'calendar', label: 'Ringkasan Tahunan' }, { id: 'schedules', label: 'Jadwal PM' },
        { id: 'assignments', label: `Penugasan PM (${pendingRows.length} belum ditugaskan)` }, { id: 'activation', label: 'Aktivasi Jadwal' }, { id: 'technicians', label: 'Kalender Teknisi' }, { id: 'history', label: 'Riwayat' },
        ...(canEditDepartmentScope ? [{ id: 'scope' as const, label: 'Cakupan Mesin' }] : []),
      ]
    : [{ id: 'calendar', label: 'Kalender PM' }, { id: 'assignments', label: 'Penugasan PM' }, { id: 'technicians', label: 'Kalender Teknisi' }];
  if (loading) return <Spinner />;
  return <div className="space-y-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div><div className="flex items-center gap-2 text-cyan-700"><CalendarDays className="h-5 w-5" /><span className="text-sm font-semibold">Preventive Maintenance and Work Order</span></div><h1 className="mt-1 text-2xl font-bold text-slate-900">Preventive Maintenance</h1><p className="mt-1 text-sm text-slate-500">Kalender PM, penugasan teknisi, dan pemantauan carry-over.</p></div>
      <div className="flex flex-wrap items-center justify-end gap-2">{isManager && <Select aria-label="Pilih departemen PM" className="min-w-48" value={selectedDepartmentId} onChange={(event) => setSelectedDepartmentId(event.target.value)}><option value="">Pilih departemen</option>{availableDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</Select>}<Button variant="secondary" onClick={() => void load()}><RefreshCw className="h-4 w-4" /> Muat ulang</Button>{isManager && tab === 'schedules' && <Button onClick={startCreateSchedule} disabled={!selectedDepartmentEnabled}><Plus className="h-4 w-4" /> Jadwal PM Baru</Button>}</div>
    </div>
    {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
    {formMessage && <div className={`rounded-lg border p-3 text-sm ${formMessage.startsWith('Cakupan belum tersimpan') || formMessage.startsWith('Data cakupan tersimpan belum') ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-blue-200 bg-blue-50 text-blue-700'}`}>{formMessage}<button className="float-right" onClick={() => setFormMessage(null)}>×</button></div>}
      {isManager && selectedDepartment && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"><span className="font-medium text-slate-700">Departemen: {selectedDepartment.name}</span><Badge className={selectedDepartmentEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>{selectedDepartmentEnabled ? 'PM aktif' : 'PM belum diaktifkan'}</Badge><span className="text-slate-400">{scopedEquipment.length} mesin dalam cakupan</span></div>}
      {isManager && !selectedDepartment && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Akun Anda belum memiliki departemen dengan akses Preventive Maintenance.</div>}
      <div className="flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1">{tabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium ${tab === item.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{item.label}</button>)}</div>

    {tab === 'scope' && canEditDepartmentScope && <Card className="space-y-4 p-5">
      <div>
        <h2 className="text-lg font-semibold">Cakupan Mesin</h2>
        <p className="text-sm text-slate-500">Mesin tercakup ditandai “Dalam cakupan”. Hilangkan centang untuk mengeluarkan mesin dari cakupan, lalu simpan perubahan.</p>
        <p className="mt-1 text-xs text-slate-500">Gunakan checkbox area dan mesin untuk menyaring daftar. Checkbox pada setiap baris menentukan apakah mesin masuk cakupan.</p>
        <p className="mt-1 text-xs text-slate-500">Status aktivasi PM hanya dapat diubah oleh Admin melalui Master Data WO.</p>
      </div>
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm"><span className="font-medium">Status PM: </span>{selectedDepartmentEnabled ? 'Aktif' : 'Nonaktif'}</div>
      {scopeFilterControls}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1 text-sm text-slate-500">
          <span>{scopeEquipmentDraft.length} dari {departmentEquipment.length} mesin departemen masuk cakupan.</span>
          <span>Area tampil: <strong className="font-medium text-emerald-700">{visibleScopedEquipmentCount} dalam cakupan</strong> · <strong className="font-medium text-slate-600">{visibleOutOfScopeEquipmentCount} di luar cakupan</strong></span>
      </div>
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" disabled={visibleScopeEquipment.length === 0} onClick={() => setScopeEquipmentDraft((current) => {
          if (allVisibleScopeEquipmentSelected) {
            const visibleIds = new Set(visibleScopeEquipment.map((item) => item.id));
            return current.filter((id) => !visibleIds.has(id));
          }
          return [...new Set([...current, ...visibleScopeEquipment.map((item) => item.id)])];
        })}>{allVisibleScopeEquipmentSelected ? 'Batalkan pilihan mesin tampil' : 'Pilih semua mesin tampil'}</Button>
      </div>
      <div className="max-h-[28rem] space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
        {visibleScopeEquipment.map((item) => {
          const isInScope = scopeEquipmentDraft.includes(item.id);
          return <label key={item.id} className="flex cursor-pointer items-center gap-3 rounded-md p-2 text-sm hover:bg-slate-50">
            <input type="checkbox" checked={isInScope} onChange={(event) => setScopeEquipmentDraft((current) => event.target.checked ? [...new Set([...current, item.id])] : current.filter((id) => id !== item.id))} />
            <span className="min-w-0 flex-1 truncate text-slate-800">{item.name}{item.code ? ` (${item.code})` : ''}</span>
            <span className="text-xs text-slate-400">{item.area?.name ?? 'Tanpa area'}</span>
            <span className="whitespace-nowrap rounded-full bg-blue-50 px-2 py-1 text-[10px] font-medium text-blue-700">{item.equipment_types?.join(', ') || 'Lainnya'}</span>
            <span className={`whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium ${isInScope ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{isInScope ? 'Dalam cakupan' : 'Di luar cakupan'}</span>
          </label>;
        })}
        {visibleScopeEquipment.length === 0 && <p className="p-6 text-center text-sm text-slate-500">Belum ada mesin tersedia untuk filter area ini.</p>}
      </div>
      <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium text-slate-800">Cakupan mesin tersimpan</h3>
          <span className="text-sm text-slate-500">{scopedEquipment.length} mesin</span>
        </div>
        {scopedEquipment.length > 0
          ? <div className="max-h-48 space-y-1 overflow-y-auto">{scopedEquipment.map((item) => <div key={item.id} className="flex items-center gap-3 rounded-md bg-white px-3 py-2 text-sm"><span className="min-w-0 flex-1 truncate text-slate-800">{item.name}{item.code ? ` (${item.code})` : ''}</span><span className="text-xs text-slate-500">{item.area?.name ?? 'Tanpa area'}</span><span className="whitespace-nowrap rounded-full bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-700">Tersimpan</span></div>)}</div>
          : <p className="text-sm text-slate-500">Belum ada mesin yang tersimpan dalam cakupan departemen ini.</p>}
      </div>
      <div className="flex justify-end"><Button onClick={() => void saveDepartmentScope()} disabled={busy || !selectedDepartmentId || !selectedDepartmentEnabled}><Save className="h-4 w-4" /> Simpan Cakupan</Button></div>
    </Card>}

    {tab === 'scope' && isScopeAdmin && legacySchedules.length > 0 && <Card className="overflow-hidden"><div className="border-b border-slate-100 p-4"><h3 className="font-semibold">Jadwal lama belum dipetakan</h3><p className="text-sm text-slate-500">Admin dapat memetakan jadwal lama setelah PM diaktifkan melalui Master Data WO dan mesin masuk ke cakupan departemen.</p></div><div className="divide-y divide-slate-100">{legacySchedules.map((schedule) => <div key={schedule.id} className="flex flex-wrap items-center gap-3 p-4"><div className="min-w-0 flex-1"><p className="font-medium text-slate-800">{schedule.title}</p><p className="text-sm text-slate-500">{schedule.equipment?.area?.name} · {schedule.equipment?.name} · due awal {schedule.anchor_due_date}</p></div><Button size="sm" onClick={() => void mapLegacySchedule(schedule)} disabled={busy || !selectedDepartmentEnabled || !selectedDepartmentId}>Petakan ke {selectedDepartment?.name ?? 'departemen'}</Button></div>)}</div></Card>}

    {tab === 'calendar' && <>
      <div className="flex items-center justify-between"><Button variant="secondary" size="sm" onClick={() => setYear((y) => y - 1)}><ChevronLeft className="h-4 w-4" /> Tahun</Button><h2 className="text-lg font-semibold">Kalender PM · {year}</h2><Button variant="secondary" size="sm" onClick={() => setYear((y) => y + 1)}>Tahun <ChevronRight className="h-4 w-4" /></Button></div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{MONTHS.map((name, index) => {
        const key = `${year}-${String(index + 1).padStart(2, '0')}`;
        const items = calendarEntries.filter((row) => row.planned_month.startsWith(key) || (!row.projection && row.label === 'Selesai' && row.due_date.startsWith(key)));
        return <button key={key} onClick={() => { setMonth(index + 1); setSelectedPmDate(`${key}-01`); setTab('schedules'); }} className="rounded-xl text-left"><Card className="h-full p-4 transition hover:border-cyan-300 hover:shadow-md"><div className="mb-3 flex items-center justify-between"><h3 className="font-semibold text-slate-800">{name}</h3><span className="text-xs text-slate-400">{items.length} jadwal</span></div><div className="space-y-1.5">{items.slice(0, 4).map((row) => <div key={row.key} className="flex min-w-0 items-center gap-2 text-xs"><span className={`h-2 w-2 shrink-0 rounded-full ${row.projection ? 'bg-blue-400' : row.label === 'Selesai' ? 'bg-emerald-500' : row.label.includes('Carry-over') ? 'bg-orange-500' : row.label === 'Tidak Dilakukan' ? 'bg-slate-500' : 'bg-cyan-500'}`} /><span className="truncate text-slate-700">{row.schedule?.equipment?.name} · {row.schedule?.title}</span><span className="ml-auto shrink-0 text-slate-400">{row.projection ? 'Proyeksi' : row.label}</span></div>)}{items.length === 0 && <p className="py-2 text-xs text-slate-400">Belum ada jadwal</p>}{items.length > 4 && <p className="text-xs text-cyan-700">+{items.length - 4} lainnya</p>}</div></Card></button>;
      })}</div>
    </>}

    {tab === 'schedules' && <div className="space-y-4">
      {scheduleFilterControls}
      {!selectedDepartmentEnabled && <Card className="border-amber-200 bg-amber-50 p-4"><p className="text-sm text-amber-800">Preventive Maintenance belum diaktifkan untuk {selectedDepartment?.name ?? 'departemen ini'}. Minta Admin mengaktifkannya di Master Data WO.</p></Card>}
      <Card className="p-4">
        <div className="mb-4 flex items-center justify-between">
          <div><h2 className="font-semibold">Kalender PM Harian · {MONTHS[month - 1]} {year}</h2><p className="text-sm text-slate-500">Tanggal bertanda menampilkan PM yang selesai atau sudah memiliki tanggal rencana. Pengaturan teknisi dan tanggal pelaksanaan tersedia di tab Penugasan PM.</p></div>
          <div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => changeMonth(-1)}><ChevronLeft className="h-4 w-4" /></Button><Button size="sm" variant="secondary" onClick={() => changeMonth(1)}><ChevronRight className="h-4 w-4" /></Button></div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold text-slate-500">{['Min','Sen','Sel','Rab','Kam','Jum','Sab'].map((day) => <div key={day} className="py-2">{day}</div>)}</div>
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: new Date(year, month - 1, 1).getDay() }, (_, index) => <div key={`blank-${index}`} />)}
          {Array.from({ length: new Date(year, month, 0).getDate() }, (_, index) => {
            const day = index + 1;
            const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const dayRows = filteredCurrentMonthRows.filter((row) => occurrenceCalendarDate(row) === date);
            return <button key={date} onClick={() => setSelectedPmDate(date)} className={`min-h-20 rounded-lg border p-2 text-left transition ${selectedPmDate === date ? 'border-cyan-500 bg-cyan-50 ring-1 ring-cyan-300' : 'border-slate-200 hover:border-cyan-300 hover:bg-slate-50'}`}><span className="text-sm font-semibold text-slate-800">{day}</span>{dayRows.slice(0, 2).map((row) => <span key={row.id} className={`mt-1 block truncate rounded px-1 py-0.5 text-[10px] ${row.execution_status === 'completed' ? 'bg-emerald-100 text-emerald-800' : 'bg-cyan-100 text-cyan-900'}`}>{row.execution_status === 'completed' ? 'Selesai · ' : 'Terjadwal · '}{row.schedule?.equipment?.name}</span>)}{dayRows.length > 2 && <span className="text-[10px] text-slate-500">+{dayRows.length - 2} PM</span>}</button>;
          })}
        </div>
      </Card>
      <Card className="overflow-hidden"><div className="border-b border-slate-100 p-4"><h3 className="font-semibold">PM pada {selectedPmDate}</h3><p className="text-sm text-slate-500">Jadwal PM yang selesai atau direncanakan pada tanggal ini.</p></div><div className="divide-y divide-slate-100">{selectedDayRows.map((row) => <div key={row.id} className="flex flex-wrap items-center gap-3 p-4"><div className="min-w-0 flex-1"><Badge className={row.execution_status === 'completed' ? 'bg-emerald-100 text-emerald-700' : 'bg-cyan-100 text-cyan-800'}>{row.execution_status === 'completed' ? 'Selesai' : 'Terjadwal'}</Badge><h4 className="mt-1 font-semibold text-slate-800">{row.schedule?.equipment?.name} · {row.schedule?.title}</h4><p className="text-sm text-slate-500">{row.schedule?.equipment?.area?.name} · due {row.due_date}</p></div></div>)}{selectedDayRows.length === 0 && <p className="p-5 text-sm text-slate-500">Tidak ada jadwal pada tanggal ini.</p>}</div></Card>
      <Card className="overflow-hidden"><div className="divide-y divide-slate-100">{sortedCurrentMonthRows.map((row) => { const info = statusInfo(row, today); return <div key={row.id} className="flex flex-wrap items-center gap-3 p-4"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><Badge className={info.cls}>{info.label}</Badge>{row.reschedule_count > 0 && <span className="text-xs text-orange-700">Beban carry-over · bulan asal {row.due_date.slice(0, 7)}</span>}</div><h4 className="mt-1 font-semibold text-slate-800">{row.schedule?.equipment?.area?.name} · {row.schedule?.equipment?.name} · {row.schedule?.title}</h4><p className="text-sm text-slate-500">Due {row.due_date} · interval {row.schedule?.interval_months} bulan · {row.schedule?.schedule_mode === 'fixed_calendar' ? 'Fixed Calendar' : 'Floating'}{row.planned_execution_date ? ` · rencana ${row.planned_execution_date}` : ''}</p></div>{row.execution_status === 'not_done' && <span className="text-sm font-semibold text-slate-600">Tidak Dilakukan</span>}</div>; })}{sortedCurrentMonthRows.length === 0 && <p className="p-8 text-center text-sm text-slate-500">Tidak ada jadwal PM yang cocok dengan filter.</p>}</div></Card>
    </div>}

    {tab === 'activation' && isManager && <div className="space-y-4">{scheduleFilterControls}<Card className="overflow-hidden"><div className="border-b border-slate-100 p-4"><h2 className="font-semibold">Aktivasi Jadwal PM · {selectedDepartment?.name ?? 'Departemen'}</h2><p className="text-sm text-slate-500">Atur jadwal PM yang aktif untuk departemen dan mesin dalam cakupan.</p></div><div className="divide-y divide-slate-100">{selectedDepartmentSchedules.map((schedule) => <div key={schedule.id} className="flex flex-wrap items-center gap-3 p-4"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-50 text-cyan-700"><Wrench className="h-5 w-5" /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-slate-800">{schedule.title}</h3><Badge className={schedule.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}>{schedule.is_active ? 'Aktif' : 'Nonaktif'}</Badge></div><p className="text-sm text-slate-500">{schedule.equipment?.area?.name} · {schedule.equipment?.name} · setiap {schedule.interval_months} bulan · {schedule.schedule_mode === 'fixed_calendar' ? 'Fixed Calendar' : 'Floating'} · bulan awal {schedule.anchor_due_date.slice(0, 7)}</p></div><div className="flex gap-2">{canEditSchedules && <Button size="sm" variant="secondary" onClick={() => startEditSchedule(schedule)}>Edit</Button>}{isAdmin && <Button size="sm" variant="secondary" className="text-rose-600 hover:bg-rose-50" disabled={busy} onClick={() => void deleteSchedule(schedule)}><Trash2 className="h-4 w-4" />Hapus</Button>}<Button size="sm" variant="secondary" disabled={busy} onClick={() => void toggleSchedule(schedule)}>{schedule.is_active ? 'Nonaktifkan' : 'Aktifkan'}</Button></div></div>)}{selectedDepartmentSchedules.length === 0 && <p className="p-8 text-center text-sm text-slate-500">Tidak ada jadwal untuk filter ini.</p>}</div></Card></div>}
    {tab === 'assignments' && <div className="space-y-3">{formMessage && <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{formMessage}</p>}{scheduleFilterControls}<div className="flex items-center justify-between"><div><h2 className="font-semibold">Penugasan PM · {MONTHS[month - 1]} {year}</h2><p className="text-sm text-slate-500">Penugasan PM berdiri sendiri, tanpa membuat Work Order atau JA.</p></div><div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => setMonth((m) => m === 1 ? (setYear((y) => y - 1), 12) : m - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button size="sm" variant="secondary" onClick={() => setMonth((m) => m === 12 ? (setYear((y) => y + 1), 1) : m + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>{assignmentRows.map((row) => { const info = statusInfo(row, today); const assignment = row.assignment; const executionChecklist: PMAssignmentChecklistItem[] = assignment?.checklist_items?.length ? assignment.checklist_items : (row.schedule?.checklist_items ?? []).map((item) => ({ ...item, result: null, note: null, checked: false })); const isAssignee = !!profile && !!assignment?.assigned_technicians?.some((a) => a.technician_id === profile.id); const changeStatus = async (next: string, notes?: string) => { if (!assignment) return; setBusy(true); const { error: e } = await supabase.rpc('pm_update_assignment_status', { p_assignment_id: assignment.id, p_next_status: next, p_report_notes: notes ?? null }); setBusy(false); if (e) { setFormMessage(e.message); return false; } else { setFormMessage(null); if (next === 'in_progress') setExecutionAssignmentId(assignment.id); await load(); return true; } }; return <Card key={row.id} className="flex flex-col gap-3 p-4"><div className="flex flex-wrap items-center gap-2"><Badge className={assignment ? 'bg-indigo-100 text-indigo-800' : info.cls}>{assignment ? assignment.status : info.label}</Badge><span className="text-xs text-slate-500">{assignment?.assignment_no ?? 'Belum ditugaskan'} · Due {row.due_date}</span><span className="ml-auto text-xs text-slate-500">{assignment?.planned_date ?? 'Tanggal fleksibel'}</span></div><div><h3 className="font-semibold text-slate-800">{row.schedule?.equipment?.name} · {row.schedule?.title}</h3><p className="text-sm text-slate-500">{row.schedule?.equipment?.area?.name} · {assignment?.assigned_technicians?.map((a) => a.technician?.full_name).filter(Boolean).join(', ') ?? 'Belum ada teknisi'}</p>{assignment && assignment.status !== 'in_progress' && <PMEvidenceGallery paths={assignment.evidence_photos ?? []} />}{assignment?.report_notes && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">Laporan: {assignment.report_notes}</p>}{assignment?.status === 'assigned' && assignment.review_note && <p className="mt-2 whitespace-pre-wrap rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">PM dikembalikan oleh reviewer: {assignment.review_note}</p>}</div>{row.execution_status === 'open' && canAssignTechnicians && <Button size="sm" className="self-start" onClick={() => openAssignment(row)}><ClipboardCheck className="h-4 w-4" />{assignment ? 'Ubah Penugasan PM' : 'Buat Penugasan PM'}</Button>}{assignment && isAssignee && ['assigned','on_the_way'].includes(assignment.status) && <Button size="sm" disabled={busy} onClick={() => void changeStatus('in_progress')}><ClipboardCheck className="h-4 w-4" /> Mulai PM</Button>}{assignment && isAssignee && assignment.status === 'in_progress' && <Button size="sm" onClick={() => setExecutionAssignmentId(assignment.id)}><ClipboardCheck className="h-4 w-4" />Isi Form PM</Button>}{assignment && executionAssignmentId === assignment.id && <PMExecutionModal assignment={{ ...assignment, checklist_items: executionChecklist }} machineName={row.schedule?.equipment?.name ?? '-'} scheduleTitle={row.schedule?.title ?? '-'} areaName={row.schedule?.equipment?.area?.name ?? '-'} busy={busy} drafts={pmChecklistDrafts} onDraftChange={(item, result, note) => setPmChecklistDrafts((current) => ({ ...current, [`${assignment.id}:${item.id}`]: { result, note } }))} onSaveChecklist={(item, result, note) => void setPmChecklistItem(assignment, item, result, note)} reportNotes={pmReportNotes[assignment.id] ?? assignment.report_notes ?? ''} message={formMessage} onReportChange={(value) => setPmReportNotes((current) => ({ ...current, [assignment.id]: value }))} onUpload={(file) => void uploadPmEvidence(assignment, file)} onClose={() => setExecutionAssignmentId(null)} onComplete={() => { const notes = pmReportNotes[assignment.id] ?? assignment.report_notes ?? ''; void changeStatus('done', notes).then((saved) => { if (saved) setExecutionAssignmentId(null); }); }} />}{assignment && isManager && assignment.status === 'done' && <Button size="sm" onClick={() => { setFormMessage(null); setReviewAssignmentId(assignment.id); }}><ClipboardCheck className="h-4 w-4" />Tinjau PM</Button>}{assignment && reviewAssignmentId === assignment.id && <PMReviewModal assignment={{ ...assignment, checklist_items: executionChecklist }} machineName={row.schedule?.equipment?.name ?? '-'} scheduleTitle={row.schedule?.title ?? '-'} areaName={row.schedule?.equipment?.area?.name ?? '-'} busy={busy} message={formMessage} onClose={() => setReviewAssignmentId(null)} onApprove={async () => { setBusy(true); const { error: reviewError } = await supabase.rpc('pm_update_assignment_status', { p_assignment_id: assignment.id, p_next_status: 'approved' }); setBusy(false); if (reviewError) setFormMessage(reviewError.message); else { setFormMessage(null); setReviewAssignmentId(null); await load(); } }} onReject={async (note) => { setBusy(true); const { error: reviewError } = await supabase.rpc('pm_update_assignment_status', { p_assignment_id: assignment.id, p_next_status: 'assigned', p_review_note: note }); setBusy(false); if (reviewError) setFormMessage(reviewError.message); else { setFormMessage(null); setReviewAssignmentId(null); await load(); } }} />}{row.execution_status === 'not_done' && <span className="text-sm font-semibold text-slate-600">Tidak Dilakukan</span>}</Card>; })}{assignmentRows.length === 0 && <Card className="p-10 text-center text-sm text-slate-500">Tidak ada occurrence untuk bulan ini.</Card>}</div>}

    {tab === 'history' && <div className="grid gap-4 xl:grid-cols-2"><Card className="overflow-hidden"><div className="border-b border-slate-100 p-4"><h2 className="font-semibold">Riwayat Eksekusi dan Assignment</h2></div><div className="divide-y divide-slate-100">{occurrenceHistory.map((entry) => <div key={entry.id} className="p-3"><div className="flex items-center justify-between gap-2"><span className="font-medium text-slate-800">{entry.occurrence?.schedule?.equipment?.name} · {entry.occurrence?.schedule?.title} · {entry.action}</span><time className="shrink-0 text-xs text-slate-400">{new Date(entry.performed_at).toLocaleString('id-ID')}</time></div><p className="mt-1 text-xs text-slate-500">Due {entry.occurrence?.due_date} · {JSON.stringify(entry.details ?? {})}</p></div>)}{occurrenceHistory.length === 0 && <p className="p-6 text-center text-sm text-slate-500">Belum ada riwayat occurrence.</p>}</div></Card><Card className="overflow-hidden"><div className="border-b border-slate-100 p-4"><h2 className="font-semibold">Riwayat Perubahan Jadwal</h2></div><div className="divide-y divide-slate-100">{scheduleHistory.map((entry) => <div key={entry.id} className="p-3"><div className="flex items-center justify-between gap-2"><span className="font-medium text-slate-800">{entry.action === 'created' ? 'Jadwal dibuat' : 'Jadwal diubah'}</span><time className="shrink-0 text-xs text-slate-400">{new Date(entry.performed_at).toLocaleString('id-ID')}</time></div><p className="mt-1 text-xs text-slate-500">{JSON.stringify(entry.after_data ?? {})}</p></div>)}{scheduleHistory.length === 0 && <p className="p-6 text-center text-sm text-slate-500">Belum ada perubahan jadwal.</p>}</div></Card></div>}

    {tab === 'technicians' && <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]"><Card className="p-4"><div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">Kalender Teknisi · {MONTHS[month - 1]} {year}</h2><p className="text-xs text-slate-500">Shift hanya membatasi teknisi bertipe shift.</p></div><div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => setMonth((m) => m === 1 ? (setYear((y) => y - 1), 12) : m - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button size="sm" variant="secondary" onClick={() => setMonth((m) => m === 12 ? (setYear((y) => y + 1), 1) : m + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div><div className="space-y-2">{Array.from({ length: new Date(year, month, 0).getDate() }, (_, i) => i + 1).map((day) => { const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; const dayShifts = departmentShifts.filter((s) => s.shift_date === date); const jobs = departmentJobs.filter((job) => dayKey(job.deadline) === date); if (!dayShifts.length && !jobs.length) return null; return <div key={date} className="grid grid-cols-[5rem_1fr] gap-3 border-b border-slate-100 py-2"><div className="text-xs font-semibold text-slate-600">{date.slice(8)}</div><div className="space-y-1">{dayShifts.map((s) => <div key={s.id} className="rounded-md bg-indigo-50 px-2 py-1 text-xs text-indigo-800">Shift {s.shift_name} · {s.technician?.full_name} · {s.starts_at}–{s.ends_at}</div>)}{jobs.map((job) => <div key={job.id} className={`rounded-md px-2 py-1 text-xs ${job.work_category === 'preventive_maintenance' ? 'bg-cyan-50 text-cyan-900' : 'bg-slate-100 text-slate-700'}`}>{job.work_category === 'preventive_maintenance' ? 'PM' : 'JA'} · {job.title} · {job.job_no} · {job.assigned_technicians?.map((a) => a.technician?.full_name).filter(Boolean).join(', ')}</div>)}</div></div>; })}{!departmentShifts.some((s) => s.shift_date.startsWith(`${year}-${String(month).padStart(2, '0')}`)) && !departmentJobs.some((job) => dayKey(job.deadline).startsWith(`${year}-${String(month).padStart(2, '0')}`)) && <p className="py-8 text-center text-sm text-slate-500">Belum ada shift atau assignment pada bulan ini.</p>}</div></Card>
      {isAdmin && <Card className="h-fit space-y-2 p-4"><h3 className="font-semibold">Program Shift Nonaktif</h3><p className="text-sm text-slate-500">Penjadwalan dan validasi shift teknisi sementara dinonaktifkan. Data roster dan penanda teknisi yang sudah tersimpan tetap dipertahankan.</p></Card>}</div>}

    {showScheduleForm && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"><Card className="max-h-[90vh] w-full max-w-xl space-y-4 overflow-y-auto p-5"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{editingSchedule ? 'Ubah Jadwal PM' : 'Jadwal PM Baru'}</h2><button onClick={() => setShowScheduleForm(false)} className="text-xl text-slate-400">×</button></div><div><Label>Lokasi</Label><Select value={scheduleForm.area_id} onChange={(e) => setScheduleForm((f) => ({ ...f, area_id: e.target.value, equipment_ids: [] }))}><option value="">Pilih lokasi terlebih dahulu</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</Select></div>{editingSchedule ? <div><Label>Mesin Target</Label><Select value={scheduleForm.equipment_ids[0] ?? ''} disabled={!scheduleForm.area_id} onChange={(e) => setScheduleForm((f) => ({ ...f, equipment_ids: e.target.value ? [e.target.value] : [] }))}><option value="">{scheduleForm.area_id ? 'Pilih mesin' : 'Pilih lokasi dahulu'}</option>{machinesInSelectedLocation.map((item) => <option key={item.id} value={item.id}>{item.name}{item.code ? ` (${item.code})` : ''}</option>)}</Select></div> : <div><div className="mb-1 flex items-center justify-between gap-2"><Label>Mesin Target</Label><Button type="button" variant="secondary" size="sm" disabled={!scheduleForm.area_id || machinesInSelectedLocation.length === 0} onClick={() => setScheduleForm((f) => ({ ...f, equipment_ids: allLocationMachinesSelected ? f.equipment_ids.filter((id) => !machinesInSelectedLocation.some((item) => item.id === id)) : [...new Set([...f.equipment_ids, ...machinesInSelectedLocation.map((item) => item.id)])] }))}>{allLocationMachinesSelected ? 'Batalkan pilihan' : 'Pilih semua mesin'}</Button></div><p className="mb-2 text-xs text-slate-500">{scheduleForm.equipment_ids.length} mesin dipilih dari {machinesInSelectedLocation.length} mesin di lokasi ini.</p><div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">{machinesInSelectedLocation.map((item) => <label key={item.id} className="flex cursor-pointer items-center gap-2 rounded p-2 text-sm hover:bg-slate-50"><input type="checkbox" checked={scheduleForm.equipment_ids.includes(item.id)} onChange={(e) => setScheduleForm((f) => ({ ...f, equipment_ids: e.target.checked ? [...new Set([...f.equipment_ids, item.id])] : f.equipment_ids.filter((id) => id !== item.id) }))} /><span className="flex-1">{item.name}{item.code ? ` (${item.code})` : ''}</span></label>)}{machinesInSelectedLocation.length === 0 && <p className="p-3 text-center text-sm text-slate-500">Tidak ada mesin dalam cakupan pada lokasi ini.</p>}</div></div>}<div><Label>Nama Program PM</Label><Input value={scheduleForm.title} onChange={(e) => setScheduleForm((f) => ({ ...f, title: e.target.value }))} placeholder="Ganti filter hidrolik" /></div><div><Label>Instruksi Pekerjaan</Label><Textarea rows={3} value={scheduleForm.description} onChange={(e) => setScheduleForm((f) => ({ ...f, description: e.target.value }))} /></div><div className="space-y-2 rounded-lg border border-slate-200 p-3"><div className="flex items-center justify-between gap-2"><div><Label>Checklist PM</Label><p className="text-xs text-slate-500">Teknisi akan mencentang setiap langkah saat pelaksanaan.</p></div><Button type="button" size="sm" variant="secondary" onClick={addScheduleChecklistItem} disabled={scheduleChecklist.length >= 50}><Plus className="h-4 w-4" /> Tambah item</Button></div>{scheduleChecklist.length === 0 && <p className="text-sm text-slate-400">Checklist opsional. Tambahkan item jika PM memiliki langkah pemeriksaan.</p>}{scheduleChecklist.map((item, index) => <div key={item.id} className="flex items-center gap-2"><span className="w-6 text-xs text-slate-400">{index + 1}.</span><Input value={item.description} maxLength={500} placeholder="Deskripsi item checklist" onChange={(e) => setScheduleChecklist((items) => items.map((entry) => entry.id === item.id ? { ...entry, description: e.target.value } : entry))} /><button type="button" aria-label="Hapus item checklist" title="Hapus item" onClick={() => setScheduleChecklist((items) => items.filter((entry) => entry.id !== item.id))} className="rounded p-2 text-rose-600 hover:bg-rose-50"><Trash2 className="h-4 w-4" /></button></div>)}</div><div className="grid gap-3 sm:grid-cols-2"><div><Label>Interval (bulan)</Label><Input type="number" min={1} value={scheduleForm.interval_months} onChange={(e) => setScheduleForm((f) => ({ ...f, interval_months: Number(e.target.value || 1) }))} /></div><div><Label>Metode</Label><Select value={scheduleForm.schedule_mode} onChange={(e) => setScheduleForm((f) => ({ ...f, schedule_mode: e.target.value as Mode }))}><option value="fixed_calendar">Fixed Calendar</option><option value="execution_based">Execution-Based / Floating</option></Select></div></div><div className="grid gap-3 sm:grid-cols-2"><div><Label>Bulan Awal PM</Label><Input type="month" value={scheduleForm.anchor_due_date.slice(0, 7)} onChange={(e) => setScheduleForm((f) => ({ ...f, anchor_due_date: e.target.value ? `${e.target.value}-01` : '' }))} /></div><div><Label>Bulan Akhir (opsional)</Label><Input type="month" value={scheduleForm.end_date.slice(0, 7)} onChange={(e) => setScheduleForm((f) => ({ ...f, end_date: e.target.value ? `${e.target.value}-01` : '' }))} /></div></div>{formMessage && <p className="text-sm text-rose-600">{formMessage}</p>}<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setShowScheduleForm(false)}>Batal</Button><Button onClick={() => void saveSchedule()} disabled={busy || !scheduleForm.area_id || !scheduleForm.equipment_ids.length || !scheduleForm.title.trim() || !scheduleForm.anchor_due_date}>{<Save className="h-4 w-4" />} Simpan</Button></div></Card></div>}

    {assigning && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"><Card className="max-h-[90vh] w-full max-w-xl space-y-4 overflow-y-auto p-5"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{assigning.pm_assignment_id ? 'Ubah Penugasan PM' : 'Buat Penugasan PM'}</h2><button onClick={() => setAssigning(null)} className="text-xl text-slate-400">×</button></div><p className="text-sm text-slate-600">{assigning.schedule?.equipment?.name} · {assigning.schedule?.title} · bulan {assigning.planned_month.slice(0, 7)}</p><div><Label>Tanggal pelaksanaan (opsional)</Label><Input type="date" min={monthStart(assigning.planned_month) < today ? today : monthStart(assigning.planned_month)} max={`${assigning.planned_month.slice(0, 7)}-${new Date(Number(assigning.planned_month.slice(0, 4)), Number(assigning.planned_month.slice(5, 7)), 0).getDate()}`} value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} /><p className="mt-1 text-xs text-slate-500">Pilih tanggal jika sudah pasti. Kosongkan agar teknisi menetapkan hari pelaksanaan selama bulan PM ini.</p></div><div><Label>Prioritas</Label><Select value={assignmentPriority} onChange={(e) => setAssignmentPriority(e.target.value)}><option value='low'>Rendah</option><option value='normal'>Normal</option><option value='high'>Tinggi</option><option value='urgent'>Urgent</option></Select></div><div><Label>Teknisi</Label><div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">{departmentTechnicians.map((tech) => <label key={tech.id} className="flex items-center gap-2 rounded p-2 text-sm hover:bg-slate-50"><input type="checkbox" checked={technicianIds.includes(tech.id)} onChange={(e) => setTechnicianIds((ids) => e.target.checked ? [...ids, tech.id] : ids.filter((id) => id !== tech.id))} /><span className="flex-1">{tech.full_name}</span></label>)}</div></div>{formMessage && <p className="text-sm text-rose-600">{formMessage}</p>}<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setAssigning(null)}>Batal</Button><Button onClick={() => void saveAssignment()} disabled={busy || !technicianIds.length}><ClipboardCheck className="h-4 w-4" /> {assigning.pm_assignment_id ? 'Simpan Perubahan' : 'Buat Penugasan PM'}</Button></div></Card></div>}
    <div className="border-t border-slate-200 pt-3"><p className="text-xs text-slate-400">PM yang belum selesai sampai akhir bulan dibawa ke bulan berikutnya satu kali; jika tetap belum terlaksana, statusnya Tidak Dilakukan. Penugasan PM terpisah dari Work Order dan Jobs Assignment; SPV/Admin/SS dapat menugaskan teknisi sesuai cakupan departemen.</p></div>
  </div>;
}
