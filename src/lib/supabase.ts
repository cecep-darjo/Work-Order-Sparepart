import { createClient } from '@supabase/supabase-js';

const supabaseUrl = ((import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '').trim();
const supabaseAnonKey = ((import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '').trim();

// Jika env belum diisi saat build, App menampilkan pesan konfigurasi (bukan layar putih).
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  }
);

export interface PartCategory {
  id: string;
  code: string;
  name: string;
  created_at: string;
}

export interface InventoryGroup {
  id: string;
  code: string;
  name: string;
  created_at: string;
}

export interface UnitOfMeasure {
  id: string;
  code: string;
  name: string;
  created_at: string;
}

export interface PartLocation {
  id: string;
  code: string;
  name: string;
  created_at: string;
}

export interface InventorySupplier {
  id: string;
  code: string;
  name: string;
  created_at: string;
}

export type Role = 'admin' | 'ss' | 'spv' | 'teknisi' | 'inventory';

export type Profile = {
  id: string;
  full_name: string;
  username: string | null;
  role: Role;
  department_id: string | null;
  is_active: boolean;
  created_at: string;
};

export type Department = {
  id: string;
  name: string;
  code: string;
  created_at: string;
};

export type Area = {
  id: string;
  /** Legacy: area kini terlepas dari departemen; kolom dipertahankan tetapi tidak dipakai. */
  department_id: string | null;
  name: string;
  created_at: string;
};

export type Equipment = {
  id: string;
  area_id: string;
  name: string;
  code: string | null;
  created_at: string;
};

export type SparePart = {
  id: string;
  code: string;
  name: string;
  category: string | null;
  unit: string;
  min_stock: number;
  max_stock: number;
  current_stock: number;
  location: string | null;
  group_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type InventoryTransaction = {
  id: string;
  spare_part_id: string;
  type: 'stock_in' | 'stock_out' | 'adjustment' | 'opname';
  quantity: number;
  balance_after: number | null;
  reference: string | null;
  notes: string | null;
  work_order_id: string | null;
  created_by: string;
  created_at: string;
  transaction_no?: string | null;
  stock_before?: number | null;
  source?: string | null;
  destination?: string | null;
  reversed_transaction_id?: string | null;
  issue_slip_no?: string | null;
  recipient?: string | null;
  gr_no?: string | null;
  gr_kind?: 'credit' | 'cash' | 'import' | null;
  gr_attachments?: string[] | null;
  spare_part?: SparePart;
};

export type WOStatus =
  | 'new'
  | 'assigned'
  | 'analysis'
  | 'on_progress'
  | 'pending'
  | 'done'
  | 'verified'
  | 'closed'
  | 'canceled';

export type WorkOrder = {
  id: string;
  wo_number: string;
  created_at: string;
  date_created: string;
  department_id: string;
  area_id: string | null;
  equipment_id: string | null;
  problem_description: string;
  priority: 'standard' | 'urgent';
  work_types: string[];
  status: WOStatus;
  spv_id: string | null;
  technician_id: string | null;
  requester_id: string | null;
  requester_name: string | null;
  requester_department: string | null;
  analysis: string | null;
  action_taken: string | null;
  result: string | null;
  pending_reason: string | null;
  cancel_reason: string | null;
  attachments: string[] | null;
  closed_at: string | null;
  updated_at: string;
  department?: Department;
  area?: Area;
  equipment?: Equipment;
  spv?: Profile;
  technicians?: { technician: Profile | null }[];
};

export type WorkOrderPart = {
  id: string;
  work_order_id: string;
  spare_part_id: string;
  quantity: number;
  created_at: string;
  spare_part?: SparePart;
};

export type WorkOrderHistory = {
  id: string;
  work_order_id: string;
  status: string;
  action: string | null;
  notes: string | null;
  performed_by: string;
  performed_at: string;
  performer?: Profile;
};

export type ActivityLog = {
  id: string;
  user_id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: string | null;
  reason: string | null;
  created_at: string;
  user?: Profile;
};

// Kolom teknisi utama (work_orders.technician_id) diisi otomatis oleh database; UI memakai daftar `technicians`.
export const WO_SELECT =
  '*, department:departments(*), area:areas(*), equipment:equipment(*), spv:profiles!spv_id(*), technicians:work_order_technicians(technician:profiles!technician_id(*))';

/**
 * Filter untuk .or(): WO yang bisa dilihat SPV — departemennya sendiri, ATAU WO manapun
 * di mana dia ditunjuk langsung sebagai PIC (spv_id), walau beda departemen.
 */
export function spvOrFilter(profile: Pick<Profile, 'id' | 'department_id'>): string {
  const parts = [`spv_id.eq.${profile.id}`];
  if (profile.department_id) parts.push(`department_id.eq.${profile.department_id}`);
  return parts.join(',');
}

export function woTechnicians(wo: Pick<WorkOrder, 'technicians'>): Profile[] {
  return (wo.technicians ?? [])
    .map((t) => t.technician)
    .filter((t): t is Profile => Boolean(t))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export const STATUS_LABELS: Record<WOStatus, string> = {
  new: 'Waiting Assignment',
  assigned: 'Assigned',
  analysis: 'Analysis',
  on_progress: 'On Progress',
  pending: 'Pending',
  done: 'Done',
  verified: 'Verified',
  closed: 'Closed',
  canceled: 'Canceled',
};

export const STATUS_COLORS: Record<WOStatus, string> = {
  new: 'bg-slate-100 text-slate-700 border-slate-200',
  assigned: 'bg-blue-100 text-blue-700 border-blue-200',
  analysis: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  on_progress: 'bg-amber-100 text-amber-700 border-amber-200',
  pending: 'bg-orange-100 text-orange-700 border-orange-200',
  done: 'bg-teal-100 text-teal-700 border-teal-200',
  verified: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  closed: 'bg-gray-200 text-gray-600 border-gray-300',
  canceled: 'bg-rose-100 text-rose-700 border-rose-200',
};

export const PRIORITY_LABELS: Record<string, string> = {
  standard: 'Standard',
  urgent: 'Urgent',
};

export const PRIORITY_COLORS: Record<string, string> = {
  standard: 'bg-blue-100 text-blue-700 border-blue-200',
  urgent: 'bg-red-100 text-red-700 border-red-200',
};

// Jenis pekerjaan (checkpoint) pada Work Order — dapat diisi lebih dari satu.
export const WORK_TYPES = ['pembuatan', 'perbaikan', 'modifikasi', 'pengadaan'] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export const WORK_TYPE_LABELS: Record<string, string> = {
  pembuatan: 'Pembuatan',
  perbaikan: 'Perbaikan',
  modifikasi: 'Modifikasi',
  pengadaan: 'Pengadaan',
};

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  ss: 'Senior Supervisor',
  spv: 'SPV',
  teknisi: 'Teknisi',
  inventory: 'Inventory Control',
};

export function stockStatus(part: SparePart): 'normal' | 'low' | 'over' {
  if (part.current_stock <= part.min_stock) return 'low';
  if (part.max_stock > 0 && part.current_stock > part.max_stock) return 'over';
  return 'normal';
}

export const TX_TYPE_LABELS: Record<string, string> = {
  stock_in: 'Stock In',
  stock_out: 'Stock Out',
  adjustment: 'Adjustment',
  opname: 'Stock Opname',
};

export const TX_TYPE_COLORS: Record<string, string> = {
  stock_in: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  stock_out: 'bg-red-100 text-red-700 border-red-200',
  adjustment: 'bg-amber-100 text-amber-700 border-amber-200',
  opname: 'bg-blue-100 text-blue-700 border-blue-200',
};

export const GR_KIND_LABELS: Record<'credit' | 'cash' | 'import', string> = {
  credit: 'Kredit (SKSB)',
  cash: 'Cash (STSB)',
  import: 'Import (SKIS)',
};

/**
 * Ambil SEMUA baris dari suatu tabel sekaligus, melewati batas default PostgREST
 * (±1.000 baris/query) dengan pagination `.range()` (chunk 1000).
 * Mengembalikan array kosong jika gagal (supaya tidak menghentikan aliran UI yang
 * memakai `?? []`). Cocok untuk data master yang bisa > 1000 baris (mis. inventory_suppliers).
 */
export async function fetchAllRows<T>(
  table: string,
  select: string,
  order: string,
  ascending = true
): Promise<T[]> {
  const chunk = 1000;
  const all: T[] = [];
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .order(order, { ascending })
      .range(offset, offset + chunk - 1);
    if (error) return all; // gagal sebagian → kembali data yang sudah terkumpul
    const rows = (data as T[]) ?? [];
    all.push(...rows);
    if (rows.length < chunk) break;
    offset += chunk;
  }
  return all;
}
