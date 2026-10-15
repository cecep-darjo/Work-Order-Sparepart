import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Button, Input, Label, Modal, Select, Textarea } from '@/components/ui';
import {
  JOB_PRIORITY_COLORS,
  JOB_PRIORITY_LABELS,
  defaultDeadlineValue,
  jobErrorMessage,
  toLocalInputValue,
  type JobAssignment,
  type JobPerson,
  type JobPriority,
} from '@/lib/jobAssignments';

const PRIORITIES: JobPriority[] = ['low', 'normal', 'high', 'urgent'];

/**
 * Form penugasan. `job` terisi = mode ubah (hanya untuk tugas yang belum final);
 * mengganti teknisi mengembalikan status tugas ke "Ditugaskan" (diatur trigger database).
 */
export default function JobAssignmentForm({
  job,
  technicians,
  activeCounts,
  locationSuggestions,
  onClose,
  onSaved,
}: {
  job: JobAssignment | null;
  technicians: JobPerson[];
  /** technician_id -> jumlah tugas aktif, untuk membantu pemerataan beban. */
  activeCounts: Record<string, number>;
  locationSuggestions: string[];
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
}) {
  const { profile } = useAuth();
  const editing = !!job;

  const [title, setTitle] = useState(job?.title ?? '');
  const [description, setDescription] = useState(job?.description ?? '');
  const [location, setLocation] = useState(job?.location ?? '');
  const [technicianId, setTechnicianId] = useState(job?.technician_id ?? '');
  const [deadline, setDeadline] = useState(job ? toLocalInputValue(job.deadline) : defaultDeadlineValue());
  const [priority, setPriority] = useState<JobPriority>(job?.priority ?? 'normal');
  const [saving, setSaving] = useState(false);

  const technicianChanged = editing && technicianId !== '' && technicianId !== job.technician_id;
  const resetsProgress = technicianChanged && job.status !== 'assigned';

  async function handleSave() {
    if (!profile) return;
    if (!title.trim()) return alert('Judul tugas wajib diisi.');
    if (!location.trim()) return alert('Lokasi wajib diisi.');
    if (!technicianId) return alert('Pilih teknisi yang ditugaskan.');
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
        technician_id: technicianId,
        deadline: deadlineDate.toISOString(),
        priority,
      };
      if (editing) {
        const { error } = await supabase.from('job_assignments').update(payload).eq('id', job.id);
        if (error) throw error;
        await onSaved('Penugasan berhasil diperbarui.');
      } else {
        const { error } = await supabase.from('job_assignments').insert({ ...payload, created_by: profile.id });
        if (error) throw error;
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
          <Label>Lokasi *</Label>
          <Input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Ketik lokasi atau pilih dari saran"
            list="job-location-suggestions"
            maxLength={150}
          />
          <datalist id="job-location-suggestions">
            {locationSuggestions.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </div>

        <div>
          <Label>Teknisi *</Label>
          <Select value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
            <option value="">— Pilih teknisi —</option>
            {technicians.map((t) => {
              const n = activeCounts[t.id] ?? 0;
              return (
                <option key={t.id} value={t.id}>
                  {t.full_name} ({n} tugas aktif)
                </option>
              );
            })}
          </Select>
          {technicians.length === 0 && (
            <p className="text-xs text-amber-600 mt-1">Belum ada user aktif dengan role Teknisi.</p>
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
