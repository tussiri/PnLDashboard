-- 051: labor budget workbooks mailed to the reports mailbox (app/budget_file.py) are logged in
-- ops.import_file as kind 'budget': companies holds the account slug, period_from / period_to the
-- plan's first and last month. The plan itself is saved to ops.account_budget_month / _week.

ALTER TABLE ops.import_file DROP CONSTRAINT IF EXISTS import_file_kind_check;
ALTER TABLE ops.import_file ADD CONSTRAINT import_file_kind_check
  CHECK (kind IN ('pay_report', 'job_cost', 'income_statement', 'service_feedback', 'qa_score', 'budget'));
