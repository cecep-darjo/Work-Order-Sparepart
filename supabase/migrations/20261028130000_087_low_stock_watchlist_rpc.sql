-- Return only rows needed by the low-stock notification, instead of sending the
-- complete spare_parts catalog to every browser tab.
CREATE OR REPLACE FUNCTION public.get_low_stock_spare_parts()
RETURNS TABLE (
  id uuid,
  code text,
  name text,
  unit text,
  min_stock numeric,
  current_stock numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT sp.id, sp.code, sp.name, sp.unit, sp.min_stock, sp.current_stock
  FROM public.spare_parts AS sp
  WHERE sp.min_stock > 0
    AND sp.current_stock <= sp.min_stock
  ORDER BY sp.current_stock ASC, sp.id ASC;
$$;

REVOKE ALL ON FUNCTION public.get_low_stock_spare_parts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_low_stock_spare_parts() TO authenticated;
