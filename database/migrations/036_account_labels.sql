-- 036: per-account wording, matching the weekly reports each account's leadership already reads.
--
-- segment_label names the account's groups (Amazon's weekly report calls Crane West / Crane IFS /
-- Sarus "BU"s; school districts keep "Segment"). vendor_label names the non-payroll labor cost that
-- counts toward Labor % (Amazon: "Agency sub", FedEx: "Subcontractor"). Editable in Admin > Accounts.

ALTER TABLE ops.account
  ADD COLUMN IF NOT EXISTS segment_label text NOT NULL DEFAULT 'Segment' CHECK (length(segment_label) BETWEEN 1 AND 30),
  ADD COLUMN IF NOT EXISTS vendor_label text NOT NULL DEFAULT 'Vendor' CHECK (length(vendor_label) BETWEEN 1 AND 30);

UPDATE ops.account SET segment_label = 'BU', vendor_label = 'Agency sub' WHERE slug = 'amazon';
UPDATE ops.account SET vendor_label = 'Subcontractor' WHERE slug IN ('fedex', 'whole-foods');
