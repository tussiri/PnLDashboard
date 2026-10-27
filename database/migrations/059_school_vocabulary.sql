-- 059: a school district report wording ('school'), following the CDO's district Labor P&L: District
-- Overview / Campuses tabs, Contract labor, Hours worked, the week's budget labor and Special Events.

ALTER TABLE ops.account DROP CONSTRAINT IF EXISTS account_vocabulary_check;
ALTER TABLE ops.account ADD CONSTRAINT account_vocabulary_check CHECK (vocabulary IN ('amazon', 'fedex', 'school'));

UPDATE ops.account SET vocabulary = 'school' WHERE slug = 'plano-isd' AND vocabulary = 'amazon';
