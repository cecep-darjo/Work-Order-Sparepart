import { supabase, type Role } from '@/lib/supabase';
import { uuid } from '@/lib/uuid';

/* ------------------------------------------------------------------ */
/* Tipe                                                                */
/* ------------------------------------------------------------------ */

export type JobStatus = 'assigned' | 'on_the_way' | 'in_progress' | 'done' | 'approved' | 'canceled';
export type JobPriority = 'low' | 'normal' | 'high' | 'urgent';

export type JobPerson = { id: string; full_name: string; username?: string | null };

export type JobPhoto = {
  id: string;
  job_id: string;
  storage_path: string;
  url: string;
  uploaded_by: string;
  created_at: string;
};

export type JobHistory = {
  id: string;
  job_id: string;
  status: string;
  action: string;
  notes: string | null;
  performed_by: string;
  performed_at: string;
  performer?: JobPerson | null;
};

export type JobAssignment = {
  id: string;
  job_no: string;
  title: string;
  description: string | null;
  location: string;
  technician_id: string;
  deadline: string;
  priority: JobPriority;
  status: JobStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  on_the_way_at: string | null;
  started_at: string | null;
  done_at: string | null;
  report_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  technician?: JobPerson | null;
  creator?: JobPerson | null;
  reviewer?: JobPerson | null;
  /** Pada daftar: hasil `photos:job_assignment_photos(count)`. */
  photos?: { count: number }[];
};

/** Peran atasan: boleh membuat, memantau, dan meng-approve penugasan. */
export const JOB_MANAGER_ROLES: Role[] = ['admin', 'ss', 'spv'];
export function isJobManager(role: Role | undefined | null): boolean {
  return !!role && JOB_MANAGER_ROLES.includes(role);
}

/* ------------------------------------------------------------------ */
/* Select string (FK ke profiles dibuat di migration 048)              */
/* ------------------------------------------------------------------ */

export const JOB_LIST_SELECT =
  '*, technician:profiles!technician_id(id, full_name, username), creator:profiles!created_by(id, full_name), photos:job_assignment_photos(count)';

export const JOB_DETAIL_SELECT =
  '*, technician:profiles!technician_id(id, full_name, username), creator:profiles!created_by(id, full_name), reviewer:profiles!reviewed_by(id, full_name)';

/* ------------------------------------------------------------------ */
/* Label & warna                                                       */
/* ------------------------------------------------------------------ */

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  assigned: 'Ditugaskan',
  on_the_way: 'On the Way',
  in_progress: 'In Progress',
  done: 'Done',
  approved: 'Disetujui',
  canceled: 'Dibatalkan',
};

export const JOB_STATUS_COLORS: Record<JobStatus, string> = {
  assigned: 'bg-slate-100 text-slate-700 border-slate-200',
  on_the_way: 'bg-sky-100 text-sky-700 border-sky-200',
  in_progress: 'bg-amber-100 text-amber-700 border-amber-200',
  done: 'bg-teal-100 text-teal-700 border-teal-200',
  approved: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  canceled: 'bg-rose-100 text-rose-700 border-rose-200',
};

export const JOB_PRIORITY_LABELS: Record<JobPriority, string> = {
  low: 'Rendah',
  normal: 'Normal',
  high: 'Tinggi',
  urgent: 'Urgent',
};

export const JOB_PRIORITY_COLORS: Record<JobPriority, string> = {
  low: 'bg-slate-100 text-slate-600 border-slate-200',
  normal: 'bg-blue-100 text-blue-700 border-blue-200',
  high: 'bg-orange-100 text-orange-700 border-orange-200',
  urgent: 'bg-red-100 text-red-700 border-red-200',
};

/** Warna garis di sisi kiri kartu tugas. */
export const JOB_PRIORITY_BAR: Record<JobPriority, string> = {
  low: 'bg-slate-300',
  normal: 'bg-blue-400',
  high: 'bg-orange-400',
  urgent: 'bg-red-500',
};

export const JOB_PRIORITY_WEIGHT: Record<JobPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export const JOB_ACTIVE_STATUSES: JobStatus[] = ['assigned', 'on_the_way', 'in_progress'];

export function isJobActive(status: JobStatus): boolean {
  return JOB_ACTIVE_STATUSES.includes(status);
}

export function isJobFinal(status: JobStatus): boolean {
  return status === 'approved' || status === 'canceled';
}

/* ------------------------------------------------------------------ */
/* Deadline                                                            */
/* ------------------------------------------------------------------ */

/** Tugas aktif yang sudah lewat deadline. */
export function isJobOverdue(job: Pick<JobAssignment, 'status' | 'deadline'>, now = Date.now()): boolean {
  return isJobActive(job.status) && new Date(job.deadline).getTime() < now;
}

/** Tugas yang selesai (Done / Disetujui) setelah deadline. */
export function wasFinishedLate(job: Pick<JobAssignment, 'status' | 'deadline' | 'done_at'>): boolean {
  return (job.status === 'done' || job.status === 'approved') && !!job.done_at && new Date(job.done_at) > new Date(job.deadline);
}

/** "2 jam lagi" / "Terlambat 1 hari" / "Tersisa 25 menit". */
export function deadlineCountdown(deadline: string, now = Date.now()): string {
  const diff = new Date(deadline).getTime() - now;
  const abs = Math.abs(diff);
  const min = Math.floor(abs / 60000);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  let span: string;
  if (day >= 1) span = `${day} hari`;
  else if (hr >= 1) span = `${hr} jam`;
  else span = `${Math.max(min, 1)} menit`;
  return diff < 0 ? `Terlambat ${span}` : `${span} lagi`;
}

export function fmtJobDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

/** ISO -> nilai <input type="datetime-local"> (waktu lokal). */
export function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Default deadline untuk form baru: besok jam 17:00. */
export function defaultDeadlineValue(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(17, 0, 0, 0);
  return toLocalInputValue(d.toISOString());
}

/* ------------------------------------------------------------------ */
/* Foto bukti kerja                                                    */
/* ------------------------------------------------------------------ */

export const JOB_PHOTO_BUCKET = 'job-photo-files';
export const JOB_PHOTO_MAX_BYTES = 500 * 1024;
export const JOB_PHOTO_MAX_COUNT = 10;
const JOB_PHOTO_MAX_SIDE = 1600;
const JOB_PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp'];

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Gambar tidak dapat dibaca.'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/**
 * Siapkan foto untuk diunggah. Foto kamera HP umumnya 2–6 MB, jadi dikecilkan otomatis
 * (maks. sisi 1600px, JPEG) hingga <= 500KB. File yang sudah kecil dipakai apa adanya.
 */
export async function prepareJobPhoto(file: File): Promise<File> {
  if (!JOB_PHOTO_MIME.includes(file.type)) {
    throw new Error(`${file.name}: hanya JPG, PNG, atau WEBP yang didukung.`);
  }
  if (file.size <= JOB_PHOTO_MAX_BYTES) return file;

  const img = await loadImage(file);
  let scale = Math.min(1, JOB_PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));

  for (let attempt = 0; attempt < 5; attempt++) {
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Browser tidak mendukung pengolahan gambar.');
    ctx.fillStyle = '#ffffff'; // PNG transparan -> latar putih saat jadi JPEG
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    for (const q of [0.85, 0.75, 0.65, 0.55, 0.45]) {
      const blob = await canvasToBlob(canvas, q);
      if (blob && blob.size <= JOB_PHOTO_MAX_BYTES) {
        const base = file.name.replace(/\.[^/.]+$/, '') || 'foto';
        return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
      }
    }
    scale *= 0.75; // masih terlalu besar: kecilkan dimensi lalu coba lagi
  }
  throw new Error(`${file.name}: foto terlalu besar dan tidak bisa dikompres hingga 500KB.`);
}

/**
 * Unggah foto ke storage lalu catat di tabel foto. Bila pencatatan gagal, file storage
 * dihapus kembali agar tidak ada file yatim. Mengembalikan jumlah foto yang berhasil.
 */
export async function uploadJobPhotos(jobId: string, files: File[]): Promise<number> {
  let ok = 0;
  for (const original of files) {
    const file = await prepareJobPhoto(original);
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
    const path = `jobs/${jobId}/${Date.now()}-${uuid()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(JOB_PHOTO_BUCKET)
      .upload(path, file, { upsert: false, contentType: file.type });
    if (upErr) throw upErr;

    const { data } = supabase.storage.from(JOB_PHOTO_BUCKET).getPublicUrl(path);
    const { error: dbErr } = await supabase
      .from('job_assignment_photos')
      .insert({ job_id: jobId, storage_path: path, url: data.publicUrl });
    if (dbErr) {
      await supabase.storage.from(JOB_PHOTO_BUCKET).remove([path]);
      throw dbErr;
    }
    ok += 1;
  }
  return ok;
}

export async function deleteJobPhoto(photo: Pick<JobPhoto, 'id' | 'storage_path'>): Promise<void> {
  const { error } = await supabase.from('job_assignment_photos').delete().eq('id', photo.id);
  if (error) throw error;
  // Hapus file-nya juga (kegagalan di sini tidak kritis: baris sudah terhapus).
  await supabase.storage.from(JOB_PHOTO_BUCKET).remove([photo.storage_path]);
}

/* ------------------------------------------------------------------ */
/* Riwayat                                                             */
/* ------------------------------------------------------------------ */

export async function fetchJobHistory(jobId: string): Promise<JobHistory[]> {
  const { data, error } = await supabase
    .from('job_assignment_history')
    .select('*')
    .eq('job_id', jobId)
    .order('performed_at', { ascending: false });
  if (error) {
    console.warn('Gagal memuat riwayat tugas:', error.message);
    return [];
  }
  const rows = (data as JobHistory[] | null) ?? [];
  const ids = [...new Set(rows.map((r) => r.performed_by).filter(Boolean))];
  if (ids.length > 0) {
    const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', ids);
    const byId = new Map(((profs as JobPerson[] | null) ?? []).map((p) => [p.id, p]));
    for (const r of rows) r.performer = byId.get(r.performed_by) ?? null;
  }
  return rows;
}

/** Pesan error Postgres dari trigger (RAISE EXCEPTION) sudah berbahasa Indonesia; tampilkan apa adanya. */
export function jobErrorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
