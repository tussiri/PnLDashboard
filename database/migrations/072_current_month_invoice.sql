-- 072: every account's weekly invoice is the current month's billing ÷ the divisor (4.33), the CDO's rule.
--
-- The `contract` invoice basis already reads, per site: its contract in effect (Admin > Contracts, the store
-- award), else the AR billed for the week's month (current_month_invoice), else the last closed month. Accounts
-- billed in arrears (Amazon, FedEx) have no current-month billing until the month is over, so they read the last
-- closed month ÷ 4.33. New accounts start on it too.
UPDATE ops.account SET invoice_basis = 'contract', updated_at = now(), updated_by = 'migration 072' WHERE invoice_basis <> 'contract';
ALTER TABLE ops.account ALTER COLUMN invoice_basis SET DEFAULT 'contract';
