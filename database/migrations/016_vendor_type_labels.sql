-- 016: Labels for WinTeam vendor type ids (docs/executive-pl.md section 9.2).
--
-- The WinTeam vendors endpoint returns vendorTypeId only (no label) and neither AP source carries a
-- vendor_type text, so the live AP look's `by_vendor_type` grouped subcontractor invoices matched by
-- type id under "type 6". This setting maps the id to a display label; 6 is the type the tenant's
-- subcontractors carry (KM Group, Inc., ProClean Facility Services, Industrial Cleaning Pros, ...).
-- Editable through the admin settings API; an id without a label still shows as "type N".
INSERT INTO ops.app_setting (key, value, description) VALUES
  ('vendor_type_labels',
   '{"6": "Subcontractor"}'::jsonb,
   'WinTeam vendorTypeId -> label, used by the executive labor P&L live AP look (vendor.ap_live.by_vendor_type) because the vendors endpoint returns ids only. An id without a label shows as "type N".')
ON CONFLICT (key) DO NOTHING;
