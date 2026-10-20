-- 057: feedback rows loaded before the importer dropped placeholder comments ('-', "'-", N/A, NO COMMENT)
-- kept the placeholder as the comment text. Clear them so they read as no comment, as a re-import would.
UPDATE core.fact_service_feedback
SET comment = NULL
WHERE comment IS NOT NULL
  AND regexp_replace(lower(comment), '[^a-z0-9]', '', 'g') IN ('', 'nocomment', 'nocomments', 'na', 'none');
