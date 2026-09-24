/*
# Work Order & Inventory Engineering — Initial Schema

## Purpose
Full multi-role engineering maintenance app with Work Orders, Inventory, and role-based access control.

## Tables created
1. `profiles` — extends auth.users with role + department link.
2. `departments` — MTC, UTL, Otomasi, HVAC, etc. Admin-managed.
3. `areas` — areas within a department.
4. `equipment` — equipment within an area.
5. `spare_parts` — master spare part catalog with min/max stock.
6. `inventory_transactions` — Stock In, Stock Out, Adjustment, Opname.
7. `work_orders` — main WO table with full workflow status.
8. `work_order_parts` — spare parts used on a WO (links to Stock Out).
9. `work_order_history` — audit trail of every WO status change.
10. `activity_log` — global audit log of admin interventions and key actions.

## Security
- RLS enabled on every table.
- Profiles: authenticated users can read all profiles (needed for SPV/technician selection), but only update their own.
- Admins (role = admin) get full access to all tables via policies.
- SPV/teknisi/inventory roles get scoped access based on their department.
- All policies use auth.uid() and profile-based role checks.
*/

-- ============ PROFILES (must come first, referenced by other policies) ============
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'teknisi'
    CHECK (role IN ('admin','spv','teknisi','inventory')),
  department_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_profiles" ON profiles;
CREATE POLICY "read_profiles" ON profiles FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "update_own_profile" ON profiles;
CREATE POLICY "update_own_profile" ON profiles FOR UPDATE
  TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "admin_insert_profile" ON profiles;
CREATE POLICY "admin_insert_profile" ON profiles FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

DROP POLICY IF EXISTS "admin_delete_profile" ON profiles;
CREATE POLICY "admin_delete_profile" ON profiles FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- ============ DEPARTMENTS ============
CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;

-- Add FK from profiles.department_id to departments after departments exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'profiles_department_id_fkey'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_department_id_fkey
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL;
  END IF;
END $$;

DROP POLICY IF EXISTS "read_departments" ON departments;
CREATE POLICY "read_departments" ON departments FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "admin_insert_departments" ON departments;
CREATE POLICY "admin_insert_departments" ON departments FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

DROP POLICY IF EXISTS "admin_update_departments" ON departments;
CREATE POLICY "admin_update_departments" ON departments FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

DROP POLICY IF EXISTS "admin_delete_departments" ON departments;
CREATE POLICY "admin_delete_departments" ON departments FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- ============ AREAS ============
CREATE TABLE IF NOT EXISTS areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(department_id, name)
);

ALTER TABLE areas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_areas" ON areas;
CREATE POLICY "read_areas" ON areas FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "admin_insert_areas" ON areas;
CREATE POLICY "admin_insert_areas" ON areas FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

DROP POLICY IF EXISTS "admin_update_areas" ON areas;
CREATE POLICY "admin_update_areas" ON areas FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

DROP POLICY IF EXISTS "admin_delete_areas" ON areas;
CREATE POLICY "admin_delete_areas" ON areas FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- ============ EQUIPMENT ============
CREATE TABLE IF NOT EXISTS equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_id uuid NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(area_id, name)
);

ALTER TABLE equipment ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_equipment" ON equipment;
CREATE POLICY "read_equipment" ON equipment FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "admin_insert_equipment" ON equipment;
CREATE POLICY "admin_insert_equipment" ON equipment FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

DROP POLICY IF EXISTS "admin_update_equipment" ON equipment;
CREATE POLICY "admin_update_equipment" ON equipment FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

DROP POLICY IF EXISTS "admin_delete_equipment" ON equipment;
CREATE POLICY "admin_delete_equipment" ON equipment FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- ============ SPARE PARTS (Master) ============
CREATE TABLE IF NOT EXISTS spare_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  category text,
  unit text NOT NULL DEFAULT 'pcs',
  min_stock numeric NOT NULL DEFAULT 0,
  max_stock numeric NOT NULL DEFAULT 0,
  current_stock numeric NOT NULL DEFAULT 0,
  location text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE spare_parts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_spare_parts" ON spare_parts;
CREATE POLICY "read_spare_parts" ON spare_parts FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "manage_spare_parts_insert" ON spare_parts;
CREATE POLICY "manage_spare_parts_insert" ON spare_parts FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','inventory'))
  );

DROP POLICY IF EXISTS "manage_spare_parts_update" ON spare_parts;
CREATE POLICY "manage_spare_parts_update" ON spare_parts FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','inventory'))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','inventory'))
  );

DROP POLICY IF EXISTS "manage_spare_parts_delete" ON spare_parts;
CREATE POLICY "manage_spare_parts_delete" ON spare_parts FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','inventory'))
  );

-- ============ INVENTORY TRANSACTIONS ============
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spare_part_id uuid NOT NULL REFERENCES spare_parts(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('stock_in','stock_out','adjustment','opname')),
  quantity numeric NOT NULL,
  balance_after numeric,
  reference text,
  notes text,
  work_order_id uuid,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE inventory_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_inventory_transactions" ON inventory_transactions;
CREATE POLICY "read_inventory_transactions" ON inventory_transactions FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "insert_inventory_transactions" ON inventory_transactions;
CREATE POLICY "insert_inventory_transactions" ON inventory_transactions FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','inventory'))
  );

DROP POLICY IF EXISTS "admin_delete_inventory_tx" ON inventory_transactions;
CREATE POLICY "admin_delete_inventory_tx" ON inventory_transactions FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- ============ WORK ORDERS ============
CREATE TABLE IF NOT EXISTS work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_number text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now(),
  date_created date NOT NULL DEFAULT CURRENT_DATE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  area_id uuid REFERENCES areas(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL,
  problem_description text NOT NULL,
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','assigned','analysis','on_progress','pending','done','verified','closed')),
  spv_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  analysis text,
  action_taken text,
  result text,
  pending_reason text,
  attachments text[],
  closed_at timestamptz,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_work_orders" ON work_orders;
CREATE POLICY "read_work_orders" ON work_orders FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','inventory'))
    OR
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'spv' AND p.department_id = work_orders.department_id)
    OR
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'teknisi' AND p.id = work_orders.technician_id)
  );

DROP POLICY IF EXISTS "insert_work_orders" ON work_orders;
CREATE POLICY "insert_work_orders" ON work_orders FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

DROP POLICY IF EXISTS "update_work_orders" ON work_orders;
CREATE POLICY "update_work_orders" ON work_orders FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    OR
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'spv' AND p.department_id = work_orders.department_id)
    OR
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'teknisi' AND p.id = work_orders.technician_id)
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    OR
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'spv' AND p.department_id = work_orders.department_id)
    OR
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'teknisi' AND p.id = work_orders.technician_id)
  );

DROP POLICY IF EXISTS "delete_work_orders" ON work_orders;
CREATE POLICY "delete_work_orders" ON work_orders FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- ============ WORK ORDER PARTS ============
CREATE TABLE IF NOT EXISTS work_order_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  spare_part_id uuid NOT NULL REFERENCES spare_parts(id) ON DELETE RESTRICT,
  quantity numeric NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE work_order_parts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_wo_parts" ON work_order_parts;
CREATE POLICY "read_wo_parts" ON work_order_parts FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "insert_wo_parts" ON work_order_parts;
CREATE POLICY "insert_wo_parts" ON work_order_parts FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','spv','teknisi','inventory'))
  );

DROP POLICY IF EXISTS "delete_wo_parts" ON work_order_parts;
CREATE POLICY "delete_wo_parts" ON work_order_parts FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','spv','teknisi','inventory'))
  );

-- ============ WORK ORDER HISTORY ============
CREATE TABLE IF NOT EXISTS work_order_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  status text NOT NULL,
  action text,
  notes text,
  performed_by uuid NOT NULL REFERENCES auth.users(id),
  performed_at timestamptz DEFAULT now()
);

ALTER TABLE work_order_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_wo_history" ON work_order_history;
CREATE POLICY "read_wo_history" ON work_order_history FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "insert_wo_history" ON work_order_history;
CREATE POLICY "insert_wo_history" ON work_order_history FOR INSERT
  TO authenticated WITH CHECK (auth.uid() IS NOT NULL);

-- ============ ACTIVITY LOG (global audit) ============
CREATE TABLE IF NOT EXISTS activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  details text,
  reason text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_activity_log" ON activity_log;
CREATE POLICY "read_activity_log" ON activity_log FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    OR auth.uid() = user_id
  );

DROP POLICY IF EXISTS "insert_activity_log" ON activity_log;
CREATE POLICY "insert_activity_log" ON activity_log FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);

-- ============ INDEXES ============
CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_work_orders_department ON work_orders(department_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_technician ON work_orders(technician_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_spv ON work_orders(spv_id);
CREATE INDEX IF NOT EXISTS idx_inventory_tx_part ON inventory_transactions(spare_part_id);
CREATE INDEX IF NOT EXISTS idx_spare_parts_stock ON spare_parts(current_stock);
CREATE INDEX IF NOT EXISTS idx_wo_history_wo ON work_order_history(work_order_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id);
