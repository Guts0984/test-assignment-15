-- Ticket domain adjustments.

-- Cancelled replies stay in the table (history and audit) but are hidden from threads and from customers.
ALTER TABLE messages ADD COLUMN cancelled_at timestamptz(3);
-- Messages moved by a merge remember where they came from.
ALTER TABLE messages ADD COLUMN origin_ticket_id uuid;
CREATE INDEX messages_ticket_public_idx ON messages (ticket_id, seq) WHERE kind = 'public' AND cancelled_at IS NULL;

-- A main ticket may collect several duplicates and later be merged itself; chains are followed when reading.
-- Cycles stay impossible: a merge target must not have been merged away, and a merged ticket cannot be merged again.
CREATE OR REPLACE FUNCTION tickets_merge_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target tickets%ROWTYPE;
BEGIN
  IF NEW.merged_into_id IS NULL OR NEW.merged_into_id IS NOT DISTINCT FROM OLD.merged_into_id THEN
    RETURN NEW;
  END IF;
  IF OLD.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'TICKET_ALREADY_MERGED' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO target FROM tickets WHERE id = NEW.merged_into_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TICKETS_NOT_MERGEABLE' USING ERRCODE = 'P0001', DETAIL = 'target missing';
  END IF;
  IF target.customer_id <> NEW.customer_id THEN
    RAISE EXCEPTION 'TICKETS_NOT_MERGEABLE' USING ERRCODE = 'P0001', DETAIL = 'different customers';
  END IF;
  IF target.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'TICKET_ALREADY_MERGED' USING ERRCODE = 'P0001', DETAIL = 'target was merged away';
  END IF;
  IF target.status = 'closed' THEN
    RAISE EXCEPTION 'TICKETS_NOT_MERGEABLE' USING ERRCODE = 'P0001', DETAIL = 'target is closed';
  END IF;
  RETURN NEW;
END;
$$;

-- Lookups used by threading.
CREATE INDEX outbound_ticket_rfc_idx ON outbound_emails (rfc_message_id);
