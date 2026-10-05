import { useCallback, useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ClipboardCheck, Lock, ShieldCheck, UserPlus, Wrench } from 'lucide-react';
import { supabase, stockStatus, type Profile, type SparePart, type WorkOrder } from '@/lib/supabase';
import type { PageKey } from '@/components/Layout';

/**
 * Item yang MENUNGGU AKSI dari user yang sedang login.
 * Dipakai bersama oleh kartu Dashboard dan lonceng notifikasi.
 * Tidak butuh migration: semua dihitung dari tabel yang sudah ada (RLS tetap berlaku).
 */

export type ActionTone = 'blue' | 'amber' | 'orange' | 'emerald' | 'red';

export const TONE_CLASSES: Record<ActionTone, { icon: string; badge: string; ring: string }> = {
  blue: { icon: 'bg-blue-50 text-blue-600', badge: 'bg-blue-600', ring: 'hover:border-blue-300' },
  amber: { icon: 'bg-amber-50 text-amber-600', badge: 'bg-amber-500', ring: 'hover:border-amber-300' },
  orange: { icon: 'bg-orange-50 text-orange-600', badge: 'bg-orange-500', ring: 'hover:border-orange-300' },
  emerald: { icon: 'bg-emerald-50 text-emerald-600', badge: 'bg-emerald-600', ring: 'hover:border-emerald-300' },
  red: { icon: 'bg-red-50 text-red-600', badge: 'bg-red-500', ring: 'hover:border-red-300' },
};

export type ActionRow = {
  id: string;
  title: string;
  subtitle?: string;
  /** Jika diisi, klik baris langsung membuka detail WO ini. */
  woId?: string;
};

export type ActionGroup = {
  key: string;
  title: string;
  description: string;
  count: number;
  tone: ActionTone;
  /** Halaman tujuan saat kartu/grup diklik. */
  page: PageKey;
  rows: ActionRow[];
};

/* ------------------------------------------------------------------ */
/* Aksi per Work Order (dipakai halaman daftar WO dan Dashboard)       */
/* ------------------------------------------------------------------ */

export type WoActionKind =
  | 'assign_spv' // admin/SS menunjuk SPV (PIC)
  | 'assign_tech' // SPV menugaskan teknisi
  | 'verify' // SPV memverifikasi WO yang sudah done
  | 'close' // SS/admin menutup WO yang sudah verified
  | 'start' // teknisi memulai WO yang baru ditugaskan
  | 'work' // teknisi sedang mengerjakan
  | 'approve_part' // SS/admin menyetujui permintaan part
  | 'process_part'; // inventory/admin memproses pengeluaran part

export const WO_ACTION_META: Record<
  WoActionKind,
  { chip: string; title: string; description: string; tone: ActionTone; icon: LucideIcon }
> = {
  assign_spv: {
    chip: 'Perlu assignment SPV',
    title: 'WO menunggu assignment SPV',
    description: 'Belum ada SPV (PIC) yang ditunjuk.',
    tone: 'amber',
    icon: UserPlus,
  },
  assign_tech: {
    chip: 'Perlu assignment teknisi',
    title: 'WO menunggu assignment teknisi',
    description: 'Anda PIC WO ini; tugaskan teknisi.',
    tone: 'amber',
    icon: UserPlus,
  },
  verify: {
    chip: 'Perlu verifikasi',
    title: 'WO menunggu verifikasi Anda',
    description: 'Teknisi sudah selesai; verifikasi atau minta rework.',
    tone: 'emerald',
    icon: ShieldCheck,
  },
  close: {
    chip: 'Siap di-close',
    title: 'WO siap di-close',
    description: 'Sudah diverifikasi SPV, menunggu close oleh SS/admin.',
    tone: 'emerald',
    icon: Lock,
  },
  start: {
    chip: 'Mulai pengerjaan',
    title: 'WO baru ditugaskan',
    description: 'Mulai analisis untuk WO ini.',
    tone: 'blue',
    icon: Wrench,
  },
  work: {
    chip: 'Sedang dikerjakan',
    title: 'WO sedang Anda kerjakan',
    description: 'Lanjutkan pekerjaan atau update status.',
    tone: 'orange',
    icon: Wrench,
  },
  approve_part: {
    chip: 'Approval permintaan part',
    title: 'Permintaan part menunggu approval',
    description: 'Setujui atau tolak permintaan spare part dari WO.',
    tone: 'amber',
    icon: ClipboardCheck,
  },
  process_part: {
    chip: 'Proses permintaan part',
    title: 'Permintaan part siap diproses',
    description: 'Sudah disetujui SS; proses pengeluaran stok.',
    tone: 'blue',
    icon: ClipboardCheck,
  },
};

/** Urutan tampil: yang paling mendesak lebih dulu. */
export const WO_ACTION_ORDER: WoActionKind[] = [
  'assign_spv',
  'assign_tech',
  'approve_part',
  'process_part',
  'verify',
  'close',
  'start',
  'work',
];

export type WoPartRequestCounts = { pending: number; ssApproved: number };

type ActionableWo = Pick<WorkOrder, 'status' | 'spv_id' | 'department_id'> & { technicians?: unknown[] | null };

/**
 * Aksi yang sedang menunggu `profile` pada satu WO.
 * Aturan mengikuti WorkOrderDetail: admin/SS menunjuk SPV & approve part, SPV menugaskan
 * teknisi & verifikasi, SS/admin close, inventory/admin memproses part, teknisi mengerjakan.
 */
export function woActionsFor(wo: ActionableWo, profile: Profile, req?: WoPartRequestCounts): WoActionKind[] {
  const out: WoActionKind[] = [];
  const role = profile.role;
  const isAdminOrSs = role === 'admin' || role === 'ss';
  const isSpv = role === 'spv' && (profile.department_id === wo.department_id || wo.spv_id === profile.id);
  const techCount = (wo.technicians ?? []).length;

  if (isAdminOrSs && wo.status === 'new' && !wo.spv_id) out.push('assign_spv');
  if (isSpv && wo.status === 'assigned' && techCount === 0) out.push('assign_tech');

  if (isAdminOrSs && wo.status !== 'closed' && wo.status !== 'verified' && (req?.pending ?? 0) > 0) out.push('approve_part');
  if (role === 'admin' && wo.status !== 'closed' && wo.status !== 'verified' && (req?.ssApproved ?? 0) > 0)
    out.push('process_part');

  if (isSpv && wo.status === 'done') out.push('verify');
  if (isAdminOrSs && wo.status === 'verified') out.push('close');

  if (role === 'teknisi' && wo.status === 'assigned') out.push('start');
  if (role === 'teknisi' && (wo.status === 'analysis' || wo.status === 'on_progress')) out.push('work');
  return out;
}

/** Ambil jumlah permintaan part yang masih menunggu, per WO (admin/SS saja yang berwenang). */
export async function fetchPartRequestCounts(profile: Profile): Promise<Record<string, WoPartRequestCounts>> {
  if (profile.role !== 'admin' && profile.role !== 'ss') return {};
  const { data } = await supabase
    .from('wo_part_requests')
    .select('work_order_id, status')
    .in('status', ['pending', 'ss_approved'])
    .limit(1000);
  const map: Record<string, WoPartRequestCounts> = {};
  for (const r of (data as { work_order_id: string; status: string }[]) ?? []) {
    const c = (map[r.work_order_id] ??= { pending: 0, ssApproved: 0 });
    if (r.status === 'pending') c.pending += 1;
    else c.ssApproved += 1;
  }
  return map;
}

type Role = Profile['role'];

const POLL_MS = 30000;
const LIMIT = 200;

type WoRow = Pick<WorkOrder, 'id' | 'wo_number' | 'problem_description' | 'status' | 'spv_id' | 'department_id'> & {
  technicians: { technician_id: string }[] | null;
};

async function fetchWorkOrders(profile: Profile, statuses: string[]): Promise<WoRow[]> {
  let q = supabase
    .from('work_orders')
    .select('id, wo_number, problem_description, status, spv_id, department_id, technicians:work_order_technicians(technician_id)')
    .in('status', statuses)
    .order('created_at', { ascending: true })
    .limit(LIMIT);
  // SPV: tanpa filter tambahan — RLS (migration 033) memungkinkan SPV membaca semua WO.
  // Aksi per-WO tetap lewat woActionsFor() yang membatasi hanya pada WO yang relevan untuk user.
  const { data } = await q;
  return (data as WoRow[]) ?? [];
}

function woRows(rows: WoRow[]): ActionRow[] {
  return rows.map((w) => ({ id: w.id, title: w.wo_number, subtitle: w.problem_description, woId: w.id }));
}

async function buildGroups(profile: Profile): Promise<ActionGroup[]> {
  const role: Role = profile.role;
  const groups: ActionGroup[] = [];
  const isAdmin = role === 'admin';
  const isSS = role === 'ss';
  const isInv = role === 'inventory';
  const isSpv = role === 'spv';
  const isTech = role === 'teknisi';

  // ---- Work Order ----------------------------------------------------------
  const woStatuses: string[] = [];
  if (isAdmin || isSS) woStatuses.push('new');
  if (isAdmin || isSS) woStatuses.push('verified');
  if (isSpv) woStatuses.push('done', 'assigned');
  if (isTech) woStatuses.push('assigned', 'analysis', 'on_progress');

  const woPromise = woStatuses.length ? fetchWorkOrders(profile, woStatuses) : Promise.resolve<WoRow[]>([]);

  // ---- Permintaan spare part dari WO --------------------------------------
  const prStatuses: string[] = [];
  if (isAdmin || isSS) prStatuses.push('pending'); // approval SS
  if (isAdmin || isInv) prStatuses.push('ss_approved'); // proses inventory
  const reqPromise = prStatuses.length
    ? supabase
        .from('wo_part_requests')
        .select('id, request_no, status, work_order_id, work_order:work_orders(wo_number)')
        .in('status', prStatuses)
        .order('requested_at', { ascending: true })
        .limit(LIMIT)
    : Promise.resolve({ data: [] as unknown[] });

  // ---- Bon sparepart, PR numbering, stok menipis (admin / inventory) -------
  const staff = isAdmin || isInv;
  const bonPromise = staff
    ? supabase
        .from('spare_part_bons')
        .select('id, bon_no, notes, requester:profiles!requester_id(full_name)')
        .in('status', ['pending', 'partial'])
        .order('created_at', { ascending: true })
        .limit(LIMIT)
    : Promise.resolve({ data: [] as unknown[] });
  const numPromise = staff
    ? supabase
        .from('purchase_requirements')
        .select('id, created_at')
        .eq('status', 'pending_numbering')
        .order('created_at', { ascending: true })
        .limit(LIMIT)
    : Promise.resolve({ data: [] as unknown[] });
  const stockPromise = staff
    ? supabase
        .from('spare_parts')
        .select('id, code, name, unit, min_stock, max_stock, current_stock')
        .order('current_stock', { ascending: true })
        .limit(1000)
    : Promise.resolve({ data: [] as unknown[] });

  const [wos, reqRes, bonRes, numRes, stockRes] = await Promise.all([
    woPromise,
    reqPromise,
    bonPromise,
    numPromise,
    stockPromise,
  ]);

  // WO: dikelompokkan memakai aturan yang sama dengan halaman daftar WO
  const buckets: Partial<Record<WoActionKind, WoRow[]>> = {};
  for (const w of wos) {
    for (const kind of woActionsFor(w, profile)) (buckets[kind] ??= []).push(w);
  }
  for (const kind of WO_ACTION_ORDER) {
    const list = buckets[kind];
    if (!list?.length) continue;
    const meta = WO_ACTION_META[kind];
    groups.push({
      key: `wo_${kind}`,
      title: meta.title,
      description: meta.description,
      count: list.length,
      tone: meta.tone,
      page: 'workorders',
      rows: woRows(list),
    });
  }

  // Permintaan spare part
  type ReqRow = {
    id: string;
    request_no: string;
    status: string;
    work_order_id: string;
    work_order: { wo_number: string } | null;
  };
  const reqs = (reqRes.data as unknown as ReqRow[]) ?? [];
  const toRow = (r: ReqRow): ActionRow => ({
    id: r.id,
    title: r.request_no,
    subtitle: r.work_order?.wo_number ? `untuk ${r.work_order.wo_number}` : undefined,
    woId: r.work_order_id,
  });
  const pendingReqs = reqs.filter((r) => r.status === 'pending');
  if ((isAdmin || isSS) && pendingReqs.length)
    groups.push({
      key: 'req_pending',
      title: 'Permintaan part menunggu approval',
      description: 'Setujui atau tolak permintaan spare part dari WO.',
      count: pendingReqs.length,
      tone: 'amber',
      page: 'workorders',
      rows: pendingReqs.map(toRow),
    });
  const approvedReqs = reqs.filter((r) => r.status === 'ss_approved');
  if ((isAdmin || isInv) && approvedReqs.length)
    groups.push({
      key: 'req_ss_approved',
      title: 'Permintaan part siap diproses',
      description: 'Sudah disetujui SS; proses pengeluaran stok.',
      count: approvedReqs.length,
      tone: 'blue',
      page: 'workorders',
      rows: approvedReqs.map(toRow),
    });

  // Bon
  type BonRow = { id: string; bon_no: string; notes: string; requester: { full_name: string } | null };
  const bons = (bonRes.data as unknown as BonRow[]) ?? [];
  if (staff && bons.length)
    groups.push({
      key: 'bon',
      title: 'Bon sparepart menunggu diproses',
      description: 'Proses pengeluaran di halaman Inventory Transactions.',
      count: bons.length,
      tone: 'amber',
      page: 'transactions',
      rows: bons.map((b) => ({
        id: b.id,
        title: b.bon_no,
        subtitle: b.requester?.full_name ? `oleh ${b.requester.full_name}` : b.notes,
      })),
    });

  // PR menunggu nomor
  type NumRow = { id: string; created_at: string };
  const nums = (numRes.data as unknown as NumRow[]) ?? [];
  if (staff && nums.length)
    groups.push({
      key: 'pr_numbering',
      title: 'PR menunggu nomor SAP & PR',
      description: 'Lengkapi nomor di halaman Purchase Requirements.',
      count: nums.length,
      tone: 'orange',
      page: 'purchase_requirements',
      rows: nums.map((n) => ({
        id: n.id,
        title: 'Purchase Requirement',
        subtitle: `dibuat ${new Date(n.created_at).toLocaleDateString('id-ID', { dateStyle: 'medium' })}`,
      })),
    });

  // Stok menipis
  const low = ((stockRes.data as unknown as SparePart[]) ?? []).filter((p) => stockStatus(p) === 'low');
  if (staff && low.length)
    groups.push({
      key: 'low_stock',
      title: 'Stok menipis',
      description: 'Stok sudah di bawah atau sama dengan minimum.',
      count: low.length,
      tone: 'red',
      page: 'inventory',
      rows: low.map((p) => ({
        id: p.id,
        title: p.name,
        subtitle: `${p.code} • stok ${p.current_stock} / min ${p.min_stock} ${p.unit}`,
      })),
    });

  return groups;
}

export function useActionItems(profile: Profile | null) {
  const [groups, setGroups] = useState<ActionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const reload = useCallback(
    async (silent = false) => {
      if (!profile) return;
      if (!silent) setLoading(true);
      try {
        const g = await buildGroups(profile);
        if (alive.current) setGroups(g);
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [profile],
  );

  useEffect(() => {
    alive.current = true;
    reload();
    // Permintaan/bon/WO baru muncul otomatis: polling berkala + saat tab kembali aktif.
    const timer = setInterval(() => reload(true), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  const total = groups.reduce((n, g) => n + g.count, 0);
  return { groups, total, loading, reload };
}
