CREATE OR REPLACE FUNCTION public.delete_purchase_requirement(p_pr_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pr public.purchase_requirements%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sesi login tidak ditemukan.';
  END IF;

  SELECT * INTO v_pr
  FROM public.purchase_requirements
  WHERE id = p_pr_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase Requirement tidak ditemukan.';
  END IF;

  IF NOT public.is_admin() AND v_pr.created_by <> auth.uid() THEN
    RAISE EXCEPTION 'Hanya pembuat PR atau admin yang dapat menghapus Purchase Requirement.';
  END IF;

  INSERT INTO public.activity_log (user_id, action, entity_type, entity_id, details, reason)
  VALUES (
    auth.uid(),
    'delete_purchase_requirement',
    'purchase_requirement',
    v_pr.id,
    'Deleted Purchase Requirement ' || COALESCE(v_pr.pr_no, v_pr.sap_no, v_pr.id::text),
    'Dihapus oleh pembuat PR atau admin.'
  );

  -- PR items and service receipt rows cascade; inventory transactions retain
  -- their stock history and simply lose the optional PR item reference.
  DELETE FROM public.purchase_requirements WHERE id = v_pr.id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_purchase_requirement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_purchase_requirement(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
