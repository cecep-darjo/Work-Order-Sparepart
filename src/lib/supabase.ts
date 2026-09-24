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

export type Role = 'admin' | 'spv' | 'teknisi' | 'inventory';

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
  department_id: string;
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
  | 'closed';

export type WorkOrder = {
  id: string;
  wo_number: string;
  created_at: string;
  date_created: string;
  department_id: string;
  area_id: string | null;
  equipment_id: string | null;
  problem_description: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: WOStatus;
  spv_id: string | null;
  technician_id: string | null;
  analysis: string | null;
  action_taken: string | null;
  result: string | null;
  pending_reason: string | null;
  attachments: string[] | null;
  closed_at: string | null;
  updated_at: string;
  department?: Department;
  area?: Area;
  equipment?: Equipment;
  spv?: Profile;
  technician?: Profile;
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

export const STATUS_LABELS: Record<WOStatus, string> = {
  new: 'New',
  assigned: 'Assigned',
  analysis: 'Analysis',
  on_progress: 'On Progress',
  pending: 'Pending',
  done: 'Done',
  verified: 'Verified',
  closed: 'Closed',
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
};

export const PRIORITY_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

export const PRIORITY_COLORS: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600 border-slate-200',
  medium: 'bg-blue-100 text-blue-700 border-blue-200',
  high: 'bg-orange-100 text-orange-700 border-orange-200',
  urgent: 'bg-red-100 text-red-700 border-red-200',
};

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
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
