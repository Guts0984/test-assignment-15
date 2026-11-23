-- The reconciler looks for open tickets that have no SLA timer rows at all; this keeps that lookup cheap.
CREATE INDEX jobs_sla_ref_idx ON jobs (ref) WHERE kind IN ('sla_warning', 'sla_breach');
