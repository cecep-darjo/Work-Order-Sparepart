-- Categories used as badges and quick filters for WO/Jobs Assignment machine targets.
ALTER TABLE public.equipment
  ADD COLUMN IF NOT EXISTS equipment_types text[] NOT NULL DEFAULT ARRAY['Lainnya']::text[];

UPDATE public.equipment
SET equipment_types = ARRAY['Lainnya']::text[]
WHERE equipment_types IS NULL OR cardinality(equipment_types) = 0;

ALTER TABLE public.equipment
  ALTER COLUMN equipment_types SET DEFAULT ARRAY['Lainnya']::text[],
  ALTER COLUMN equipment_types SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.equipment'::regclass
      AND conname = 'equipment_types_valid_check'
  ) THEN
    ALTER TABLE public.equipment
      ADD CONSTRAINT equipment_types_valid_check
      CHECK (
        cardinality(equipment_types) > 0
        AND equipment_types <@ ARRAY['HVAC', 'Mesin', 'LAF', 'Lainnya']::text[]
      );
  END IF;
END;
$$;
