import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { Badge, Button, Label, Modal, Spinner, Textarea } from '@/components/ui';
import {
  JOB_PHOTO_MAX_COUNT,
  JOB_PRIORITY_COLORS,
  JOB_PRIORITY_LABELS,
  JOB_STATUS_COLORS,
  JOB_STATUS_LABELS,
  JOB_DETAIL_SELECT,
  deadlineCountdown,
  deleteJobPhoto,
  fetchJobHistory,
  fmtJobDateTime,
  isJobActive,
  isJobFinal,
  isJobManager,
  isJobOverdue,
  jobErrorMessage,
  uploadJobPhotos,
  wasFinishedLate,
  type JobAssignment,
  type JobHistory,
  type JobPhoto,
  type JobStatus,
} from '@/lib/jobAssignments';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clock,
  Flag,
  MapPin,
  Navigation,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
  User,
  XCircle,
} from 'lucide-react';

function InfoItem({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 text-slate-400 flex-shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
        <div className="text-sm text-slate-800 break-words">{children}</div>
      </div>
    </div>
  );
}

export default function JobAssignmentDetail({
  jobId,
  onClose,
  onChanged,
  onEdit,
}: {
  jobId: string;
  onClose: () => void;
  /** Dipanggil setelah data berubah agar daftar & notifikasi dimuat ulang. */
  onChanged: () => void | Promise<void>;
  onEdit: (job: JobAssignment) => void;
}) {
  const { profile } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);

  const [job, setJob] = useState<JobAssignment | null>(null);
  const [photos, setPhotos] = useState<JobPhoto[]>([]);
  const [history, setHistory] = useState<JobHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [reportNotes, setReportNotes] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [showCancel, setShowCancel] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [jobRes, photoRes, hist] = await Promise.all([
      supabase.from('job_assignments').select(JOB_DETAIL_SELECT).eq('id', jobId).maybeSingle(),
      supabase.from('job_assignment_photos').select('*').eq('job_id', jobId).order('created_at', { ascending: true }),
      fetchJobHistory(jobId),
    ]);
    if (jobRes.error || !jobRes.data) {
      setLoadError(jobRes.error?.message ?? 'Tugas tidak ditemukan atau Anda tidak memiliki akses.');
      setLoading(false);
      return;
    }
    const j = jobRes.data as unknown as JobAssignment;
    setJob(j);
    setReportNotes(j.report_notes ?? '');
    setPhotos((photoRes.data as JobPhoto[] | null) ?? []);
    setHistory(hist);
    setLoadError(null);
    setLoading(false);
  }, [jobId]);

  useEffect(() => {
    load();
  }, [load]);

  async function refreshAll() {
    await load();
    await onChanged();
  }

  if (!profile) return null;

  if (loading) {
    return (
      <Modal open onClose={onClose} title="Memuat tugas..." maxWidth="max-w-2xl">
        <Spinner />
      </Modal>
    );
  }

  if (loadError || !job) {
    return (
      <Modal open onClose={onClose} title="Tugas tidak tersedia" maxWidth="max-w-md">
        <p className="text-sm text-slate-600 mb-4">{loadError}</p>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Tutup
          </Button>
        </div>
      </Modal>
    );
  }

  const isManager = isJobManager(profile.role);
  const isAssignee = profile.role === 'teknisi' && job.technician_id === profile.id;
  const overdue = isJobOverdue(job);
  const finishedLate = wasFinishedLate(job);
  const working = job.status === 'on_the_way' || job.status === 'in_progress';
  const canUpload = isAssignee && working;
  const canEditNotes = isAssignee && working;
  const rejectedNote = job.status === 'in_progress' && job.review_note && job.reviewed_at ? job.review_note : null;

  /** Ubah status dengan pengecekan "status masih sama" agar tidak menimpa perubahan orang lain. */
  async function applyUpdate(patch: Record<string, unknown>): Promise<boolean> {
    if (!job) return false;
    setActing(true);
    try {
      const { data, error } = await supabase
        .from('job_assignments')
        .update(patch)
        .eq('id', job.id)
        .eq('status', job.status)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) alert('Status tugas sudah berubah oleh pihak lain. Data dimuat ulang.');
      await refreshAll();
      return !!data && data.length > 0;
    } catch (e) {
      alert(jobErrorMessage(e));
      return false;
    } finally {
      setActing(false);
    }
  }

  async function techSetStatus(next: JobStatus) {
    const patch: Record<string, unknown> = { status: next };
    if (next === 'done') patch.report_notes = reportNotes.trim();
    await applyUpdate(patch);
  }

  async function saveNotesDraft() {
    if (!job) return;
    setActing(true);
    try {
      const { error } = await supabase
        .from('job_assignments')
        .update({ report_notes: reportNotes.trim() || null })
        .eq('id', job.id);
      if (error) throw error;
      await load();
    } catch (e) {
      alert(jobErrorMessage(e));
    } finally {
      setActing(false);
    }
  }

  async function handleFiles(list: FileList | null) {
    if (!list || list.length === 0 || !job) return;
    const files = Array.from(list);
    if (photos.length + files.length > JOB_PHOTO_MAX_COUNT) {
      alert(`Maksimal ${JOB_PHOTO_MAX_COUNT} foto per tugas (saat ini ${photos.length}).`);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setUploading(true);
    try {
      await uploadJobPhotos(job.id, files);
    } catch (e) {
      alert('Gagal mengunggah foto: ' + jobErrorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
      await refreshAll();
    }
  }

  async function removePhoto(p: JobPhoto) {
    if (!confirm('Hapus foto ini?')) return;
    try {
      await deleteJobPhoto(p);
      await refreshAll();
    } catch (e) {
      alert('Gagal menghapus foto: ' + jobErrorMessage(e));
    }
  }

  async function approve() {
    if (!confirm('Setujui laporan pekerjaan ini? Setelah disetujui, tugas dinyatakan selesai dan tidak dapat diubah.')) return;
    await applyUpdate({ status: 'approved', review_note: reviewNote.trim() || null });
  }

  async function reject() {
    if (!reviewNote.trim()) return alert('Isi catatan penolakan agar teknisi tahu apa yang harus diperbaiki.');
    if (await applyUpdate({ status: 'in_progress', review_note: reviewNote.trim() })) setReviewNote('');
  }

  async function cancelJob() {
    if (!reviewNote.trim()) return alert('Isi alasan pembatalan.');
    if (!confirm('Batalkan tugas ini? Tindakan ini tidak dapat dibatalkan.')) return;
    if (await applyUpdate({ status: 'canceled', review_note: reviewNote.trim() })) {
      setReviewNote('');
      setShowCancel(false);
    }
  }

  const canFinish = photos.length > 0 && reportNotes.trim().length > 0;

  return (
    <>
      <Modal open onClose={onClose} title={job.job_no} maxWidth="max-w-2xl">
        <div className="space-y-6">
          {/* Judul + badge */}
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <Badge className={JOB_STATUS_COLORS[job.status]}>{JOB_STATUS_LABELS[job.status]}</Badge>
              <Badge className={JOB_PRIORITY_COLORS[job.priority]}>{JOB_PRIORITY_LABELS[job.priority]}</Badge>
              {job.status === 'done' && isManager && (
                <Badge className="bg-amber-100 text-amber-800 border-amber-200">Menunggu approval</Badge>
              )}
              {overdue && <Badge className="bg-red-100 text-red-700 border-red-200">Terlambat</Badge>}
              {finishedLate && <Badge className="bg-orange-100 text-orange-700 border-orange-200">Selesai terlambat</Badge>}
            </div>
            <h3 className="text-lg font-semibold text-slate-900">{job.title}</h3>
            {job.description && <p className="text-sm text-slate-600 mt-1 whitespace-pre-wrap">{job.description}</p>}
          </div>

          {/* Info */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-slate-50 rounded-xl p-4">
            <InfoItem icon={<MapPin className="w-4 h-4" />} label="Lokasi">
              {job.location}
            </InfoItem>
            <InfoItem icon={<User className="w-4 h-4" />} label="Teknisi">
              {job.technician?.full_name ?? '-'}
            </InfoItem>
            <InfoItem icon={<Clock className="w-4 h-4" />} label="Deadline">
              <span className={overdue ? 'text-red-600 font-medium' : ''}>{fmtJobDateTime(job.deadline)}</span>
              {isJobActive(job.status) && (
                <span className={`block text-xs ${overdue ? 'text-red-500' : 'text-slate-500'}`}>
                  {deadlineCountdown(job.deadline)}
                </span>
              )}
            </InfoItem>
            <InfoItem icon={<Flag className="w-4 h-4" />} label="Dibuat oleh">
              {job.creator?.full_name ?? '-'}
              <span className="block text-xs text-slate-500">{fmtJobDateTime(job.created_at)}</span>
            </InfoItem>
          </div>

          {/* Penolakan terakhir */}
          {rejectedNote && (
            <div className="flex gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
              <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-red-800">Laporan ditolak — perbaiki lalu kirim ulang</p>
                <p className="text-red-700 mt-1 whitespace-pre-wrap">{rejectedNote}</p>
                <p className="text-xs text-red-500 mt-1">
                  {job.reviewer?.full_name ?? 'Atasan'} • {fmtJobDateTime(job.reviewed_at)}
                </p>
              </div>
            </div>
          )}

          {/* Catatan hasil review (approved / canceled) */}
          {(job.status === 'approved' || job.status === 'canceled') && (
            <div
              className={`rounded-xl border p-4 text-sm ${
                job.status === 'approved' ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'
              }`}
            >
              <p className={`font-medium ${job.status === 'approved' ? 'text-emerald-800' : 'text-rose-800'}`}>
                {job.status === 'approved' ? 'Laporan disetujui' : 'Tugas dibatalkan'}
                {job.reviewer?.full_name ? ` oleh ${job.reviewer.full_name}` : ''} • {fmtJobDateTime(job.reviewed_at)}
              </p>
              {job.review_note && <p className="mt-1 text-slate-700 whitespace-pre-wrap">{job.review_note}</p>}
            </div>
          )}

          {/* Laporan teknisi */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Foto bukti kerja ({photos.length}/{JOB_PHOTO_MAX_COUNT})</Label>
              {canUpload && (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    className="hidden"
                    onChange={(e) => handleFiles(e.target.files)}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading || photos.length >= JOB_PHOTO_MAX_COUNT}
                  >
                    <Camera className="w-4 h-4" />
                    {uploading ? 'Mengunggah...' : 'Tambah Foto'}
                  </Button>
                </>
              )}
            </div>

            {photos.length === 0 ? (
              <p className="text-sm text-slate-400 bg-slate-50 rounded-lg px-4 py-6 text-center">
                {canUpload ? 'Belum ada foto. Ambil foto hasil pekerjaan sebagai bukti.' : 'Belum ada foto bukti kerja.'}
              </p>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {photos.map((p) => (
                  <div key={p.id} className="relative group aspect-square rounded-lg overflow-hidden border border-slate-200 bg-slate-100">
                    <button type="button" className="w-full h-full" onClick={() => setPreview(p.url)}>
                      <img src={p.url} alt="Foto bukti kerja" className="w-full h-full object-cover" loading="lazy" />
                    </button>
                    {canUpload && p.uploaded_by === profile.id && (
                      <button
                        type="button"
                        onClick={() => removePhoto(p)}
                        className="absolute top-1 right-1 p-1.5 rounded-md bg-black/60 text-white hover:bg-red-600 transition"
                        title="Hapus foto"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {canUpload && (
              <p className="text-xs text-slate-400 mt-2">
                Foto besar dikecilkan otomatis hingga ≤ 500KB. Format JPG/PNG/WEBP.
              </p>
            )}
          </div>

          <div>
            <Label>Catatan laporan pekerjaan</Label>
            {canEditNotes ? (
              <>
                <Textarea
                  rows={4}
                  value={reportNotes}
                  onChange={(e) => setReportNotes(e.target.value)}
                  placeholder="Apa yang dikerjakan, temuan, part yang diganti, kondisi akhir..."
                />
                {reportNotes.trim() !== (job.report_notes ?? '').trim() && (
                  <div className="flex justify-end mt-2">
                    <Button size="sm" variant="secondary" onClick={saveNotesDraft} disabled={acting}>
                      Simpan catatan
                    </Button>
                  </div>
                )}
              </>
            ) : job.report_notes ? (
              <p className="text-sm text-slate-700 bg-slate-50 rounded-lg p-3 whitespace-pre-wrap">{job.report_notes}</p>
            ) : (
              <p className="text-sm text-slate-400">Belum ada catatan laporan.</p>
            )}
          </div>

          {/* ------------------------ Aksi TEKNISI ------------------------ */}
          {isAssignee && !isJobFinal(job.status) && (
            <div className="border-t border-slate-200 pt-4">
              {job.status === 'assigned' && (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => techSetStatus('on_the_way')} disabled={acting}>
                    <Navigation className="w-4 h-4" />
                    On the Way
                  </Button>
                  <Button variant="secondary" onClick={() => techSetStatus('in_progress')} disabled={acting}>
                    <Play className="w-4 h-4" />
                    Sudah di lokasi — mulai kerja
                  </Button>
                </div>
              )}
              {job.status === 'on_the_way' && (
                <Button onClick={() => techSetStatus('in_progress')} disabled={acting}>
                  <Play className="w-4 h-4" />
                  Mulai Kerja (In Progress)
                </Button>
              )}
              {job.status === 'in_progress' && (
                <div className="space-y-2">
                  <Button variant="success" onClick={() => techSetStatus('done')} disabled={acting || uploading || !canFinish}>
                    <CheckCircle2 className="w-4 h-4" />
                    Selesai (Done)
                  </Button>
                  {!canFinish && (
                    <p className="text-xs text-slate-500">
                      Untuk menyelesaikan tugas: unggah minimal 1 foto bukti dan isi catatan laporan.
                    </p>
                  )}
                </div>
              )}
              {job.status === 'done' && (
                <p className="text-sm text-teal-700 bg-teal-50 rounded-lg px-4 py-3">
                  Laporan terkirim. Menunggu approval atasan.
                </p>
              )}
            </div>
          )}

          {/* ------------------------ Aksi ATASAN ------------------------- */}
          {isManager && !isJobFinal(job.status) && (
            <div className="border-t border-slate-200 pt-4 space-y-3">
              {job.status === 'done' && (
                <>
                  <div>
                    <Label>Catatan review {`(wajib bila menolak)`}</Label>
                    <Textarea
                      rows={2}
                      value={reviewNote}
                      onChange={(e) => setReviewNote(e.target.value)}
                      placeholder="Mis. Foto kurang jelas, mohon tambahkan foto kondisi akhir"
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="success" onClick={approve} disabled={acting}>
                      <CheckCircle2 className="w-4 h-4" />
                      Approve Laporan
                    </Button>
                    <Button variant="danger" onClick={reject} disabled={acting}>
                      <RotateCcw className="w-4 h-4" />
                      Tolak (Kerjakan Ulang)
                    </Button>
                  </div>
                </>
              )}

              {showCancel && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 space-y-3">
                  <Label>Alasan pembatalan *</Label>
                  <Textarea rows={2} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} />
                  <div className="flex gap-2">
                    <Button variant="danger" size="sm" onClick={cancelJob} disabled={acting}>
                      Ya, batalkan tugas
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setShowCancel(false);
                        setReviewNote('');
                      }}
                    >
                      Tidak
                    </Button>
                  </div>
                </div>
              )}

              {!showCancel && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => onEdit(job)} disabled={acting}>
                    <Pencil className="w-4 h-4" />
                    Ubah Penugasan
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red-600 hover:bg-red-50"
                    onClick={() => {
                      setReviewNote('');
                      setShowCancel(true);
                    }}
                    disabled={acting}
                  >
                    <XCircle className="w-4 h-4" />
                    Batalkan Tugas
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Linimasa */}
          <div className="border-t border-slate-200 pt-4">
            <Label>Riwayat</Label>
            {history.length === 0 ? (
              <p className="text-sm text-slate-400">Belum ada riwayat.</p>
            ) : (
              <ul className="space-y-3 mt-2">
                {history.map((h) => (
                  <li key={h.id} className="flex gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-2 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm text-slate-800">{h.action}</p>
                      {h.notes && <p className="text-xs text-slate-500 mt-0.5 whitespace-pre-wrap break-words">{h.notes}</p>}
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        {h.performer?.full_name ?? 'Sistem'} • {fmtJobDateTime(h.performed_at)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Modal>

      {preview && (
        <Modal open onClose={() => setPreview(null)} title="Foto bukti kerja" maxWidth="max-w-3xl">
          <img src={preview} alt="Foto bukti kerja" className="w-full max-h-[70vh] object-contain rounded-lg" />
        </Modal>
      )}
    </>
  );
}
