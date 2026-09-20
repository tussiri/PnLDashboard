-- 015: Vendor cost projection and the live AP look (docs/executive-pl.md section 9,
--      docs/api-contract.md "Vendor cost: projection and live AP look").
--
-- mart.job_week.sub_dollars for a week in a month that is NOT closed used to carry the site's
-- latest known month's weekly subcontract rate forward (sub_basis 'carry_forward'). July 2026
-- carried unusually large one-off subcontract lines into every August / September week, so the
-- non-closed months now take a PROJECTION instead: the site's average weekly subcontract cost over
-- its job-cost months among the last three closed months, apportioned to the week's days in the
-- month (sub_basis 'trailing_3mo_projection', sub_estimated = true). A site with no job-cost month
-- in that window projects 0 (sub_basis 'none'). Closed months (job_cost) and the agency rule
-- (agency_ap) are unchanged. 'carry_forward' stays in the CHECK so a mart built before this
-- migration remains valid until the next rebuild; app.weekly no longer emits it.
ALTER TABLE mart.job_week DROP CONSTRAINT IF EXISTS job_week_sub_basis_check;
ALTER TABLE mart.job_week
  ADD CONSTRAINT job_week_sub_basis_check
  CHECK (sub_basis IN ('job_cost', 'agency_ap', 'carry_forward', 'trailing_3mo_projection', 'none'));

-- The live AP look on /executive/labor-pl (`vendor.ap_live`) counts AP invoices of vendors that look
-- like subcontractors: a term of this list matched case-insensitively as a substring of the
-- invoice's vendor_type or vendor name (an integer entry matches core.dim_vendor.vendor_type_id
-- exactly, for tenants whose AP feed carries the type id but not its label). WinTeam AP is not
-- job-linked, so the look is company-wide; the setting is editable through the admin settings API.
INSERT INTO ops.app_setting (key, value, description) VALUES
  ('subcontractor_vendor_types',
   '["subcontract", "sub contract", "janitorial", "labor", "staffing", "agency"]'::jsonb,
   'Executive labor P&L live AP look: AP invoices count as subcontractor spend when a term of this list occurs (case-insensitive substring) in the invoice''s vendor_type or vendor name; an integer entry matches core.dim_vendor.vendor_type_id exactly. Company-wide: WinTeam AP invoices are not linked to jobs.')
ON CONFLICT (key) DO NOTHING;
