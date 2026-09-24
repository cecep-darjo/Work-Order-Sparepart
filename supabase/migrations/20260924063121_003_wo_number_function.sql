/*
# WO Number sequence function

Creates a function to get the next WO number from the sequence.
*/

CREATE OR REPLACE FUNCTION public.nextval_wo_number()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT nextval('public.wo_number_seq');
$$;

GRANT EXECUTE ON FUNCTION public.nextval_wo_number() TO authenticated;
