-- Raw SQL guards: CHECK constraints, partial uniques, triggers, generated columns and special indexes.
-- Everything the application's correctness depends on at the database level lives here.

-- ---------------------------------------------------------------------------------------------
-- Value domains (TEXT + CHECK instead of enum types)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE users ADD CONSTRAINT users_role_chk CHECK (role IN ('admin', 'staff'));
ALTER TABLE users ADD CONSTRAINT users_open_count_chk CHECK (open_count >= 0);
ALTER TABLE users ADD CONSTRAINT users_ticket_limit_chk CHECK (ticket_limit >= 0);
ALTER TABLE users ADD CONSTRAINT users_email_lower_chk CHECK (email = lower(email));

ALTER TABLE teams ADD CONSTRAINT teams_hours_chk CHECK (
  work_start_min >= 0 AND work_end_min <= 1440 AND work_end_min > work_start_min
);
ALTER TABLE teams ADD CONSTRAINT teams_lang_chk CHECK (default_language IN ('en', 'uk', 'pl', 'de'));
ALTER TABLE team_members ADD CONSTRAINT team_members_role_chk CHECK (role IN ('agent', 'lead'));
ALTER TABLE routing_rules ADD CONSTRAINT routing_rules_priority_chk
  CHECK (priority IS NULL OR priority IN ('urgent', 'high', 'normal', 'low'));
ALTER TABLE customers ADD CONSTRAINT customers_email_lower_chk CHECK (email = lower(email));
ALTER TABLE mailboxes ADD CONSTRAINT mailboxes_lower_chk CHECK (address = lower(address));

ALTER TABLE tickets ADD CONSTRAINT tickets_status_chk
  CHECK (status IN ('new', 'open', 'waiting_customer', 'on_hold', 'resolved', 'closed'));
ALTER TABLE tickets ADD CONSTRAINT tickets_priority_chk CHECK (priority IN ('urgent', 'high', 'normal', 'low'));
ALTER TABLE tickets ADD CONSTRAINT tickets_source_chk CHECK (source IN ('email', 'web'));
ALTER TABLE tickets ADD CONSTRAINT tickets_lang_chk CHECK (language IN ('en', 'uk', 'pl', 'de'));
-- A ticket that was merged away is closed, is never assigned and never points at itself.
ALTER TABLE tickets ADD CONSTRAINT tickets_merge_self_chk CHECK (merged_into_id IS NULL OR merged_into_id <> id);
ALTER TABLE tickets ADD CONSTRAINT tickets_merge_closed_chk
  CHECK (merged_into_id IS NULL OR (status = 'closed' AND assignee_id IS NULL));
ALTER TABLE tickets ADD CONSTRAINT tickets_merged_into_fk
  FOREIGN KEY (merged_into_id) REFERENCES tickets (id);
ALTER TABLE tickets ADD CONSTRAINT tickets_follow_up_fk
  FOREIGN KEY (follow_up_of_id) REFERENCES tickets (id);
ALTER TABLE tickets ADD CONSTRAINT tickets_assignee_fk
  FOREIGN KEY (assignee_id) REFERENCES users (id);

ALTER TABLE messages ADD CONSTRAINT messages_kind_chk CHECK (kind IN ('public', 'note'));
ALTER TABLE messages ADD CONSTRAINT messages_direction_chk CHECK (direction IN ('inbound', 'outbound', 'internal'));
ALTER TABLE messages ADD CONSTRAINT messages_author_chk CHECK (author_kind IN ('customer', 'agent', 'system'));
ALTER TABLE messages ADD CONSTRAINT messages_auto_chk CHECK (auto_kind IS NULL OR auto_kind IN ('autoreply', 'bounce'));
ALTER TABLE messages ADD CONSTRAINT messages_user_fk FOREIGN KEY (author_user_id) REFERENCES users (id);
ALTER TABLE attachments ADD CONSTRAINT attachments_size_chk CHECK (size >= 0 AND size <= 10485760);

ALTER TABLE inbound_messages ADD CONSTRAINT inbound_state_chk CHECK (state IN ('pending', 'processed', 'rejected'));
ALTER TABLE outbound_emails ADD CONSTRAINT outbound_state_chk
  CHECK (state IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled', 'bounced'));
ALTER TABLE outbound_emails ADD CONSTRAINT outbound_purpose_chk
  CHECK (purpose IN ('reply', 'acknowledgement', 'survey'));
ALTER TABLE surveys ADD CONSTRAINT surveys_rating_chk CHECK (rating IS NULL OR rating BETWEEN 1 AND 5);
ALTER TABLE surveys ADD CONSTRAINT surveys_rated_chk CHECK ((rating IS NULL) = (rated_at IS NULL));
ALTER TABLE jobs ADD CONSTRAINT jobs_status_chk CHECK (status IN ('pending', 'done', 'cancelled', 'dead'));
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_chk CHECK (kind IN (
  'inbound_process', 'assign_team', 'sla_warning', 'sla_breach', 'outbound_send', 'auto_close'
));
ALTER TABLE ticket_events ADD CONSTRAINT ticket_events_actor_chk
  CHECK (actor_kind IN ('system', 'customer', 'agent', 'lead', 'admin'));
ALTER TABLE app_clock ADD CONSTRAINT app_clock_single_chk CHECK (id = 1);
ALTER TABLE seed_runs ADD CONSTRAINT seed_runs_single_chk CHECK (id = 1);
INSERT INTO app_clock (id, offset_ms, generation) VALUES (1, 0, 0);

-- ---------------------------------------------------------------------------------------------
-- Uniqueness that backs the invariants
-- ---------------------------------------------------------------------------------------------
-- The same email (Message-ID) becomes one message, even when sent to two support addresses.
CREATE UNIQUE INDEX messages_rfc_message_id_uq ON messages (rfc_message_id) WHERE rfc_message_id IS NOT NULL;
-- One member row per user and team is the primary key; one lead per user per team the same way.

-- ---------------------------------------------------------------------------------------------
-- Agent load: the limit is enforced in the database, for every code path
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION ticket_counts_for_load(status text, assignee uuid) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT assignee IS NOT NULL AND status IN ('new', 'open', 'waiting_customer', 'on_hold')
$$;

CREATE FUNCTION tickets_agent_load() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_counts boolean := false;
  new_counts boolean := false;
  old_id uuid;
  new_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_counts := ticket_counts_for_load(OLD.status, OLD.assignee_id);
    old_id := OLD.assignee_id;
  END IF;
  new_counts := ticket_counts_for_load(NEW.status, NEW.assignee_id);
  new_id := NEW.assignee_id;

  IF old_counts AND new_counts AND old_id = new_id THEN
    RETURN NEW;
  END IF;

  -- Touch user rows in id order so concurrent swaps cannot deadlock each other.
  IF old_counts AND new_counts AND old_id > new_id THEN
    PERFORM tickets_load_increment(new_id);
    PERFORM tickets_load_decrement(old_id);
  ELSE
    IF old_counts THEN PERFORM tickets_load_decrement(old_id); END IF;
    IF new_counts THEN PERFORM tickets_load_increment(new_id); END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION tickets_load_increment(agent uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- Single conditional UPDATE: the row lock serializes concurrent assignments to the same agent.
  UPDATE users
     SET open_count = open_count + 1
   WHERE id = agent AND open_count < ticket_limit;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AGENT_AT_LIMIT' USING ERRCODE = 'P0001', DETAIL = agent::text;
  END IF;
END;
$$;

CREATE FUNCTION tickets_load_decrement(agent uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE users SET open_count = open_count - 1 WHERE id = agent;
END;
$$;

CREATE TRIGGER tickets_agent_load_trg
AFTER INSERT OR UPDATE OF assignee_id, status ON tickets
FOR EACH ROW EXECUTE FUNCTION tickets_agent_load();

-- ---------------------------------------------------------------------------------------------
-- Merge safety: same customer, no chains, no cycles, no merging twice
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION tickets_merge_guard() RETURNS trigger
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
  -- The source must not already be the main ticket of other duplicates (that would form a chain).
  IF EXISTS (SELECT 1 FROM tickets WHERE merged_into_id = NEW.id) THEN
    RAISE EXCEPTION 'TICKETS_NOT_MERGEABLE' USING ERRCODE = 'P0001', DETAIL = 'source is a main ticket';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tickets_merge_guard_trg
BEFORE UPDATE OF merged_into_id ON tickets
FOR EACH ROW EXECUTE FUNCTION tickets_merge_guard();

-- ---------------------------------------------------------------------------------------------
-- Full-text search (the "simple" configuration works for every supported language)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE messages
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED;
ALTER TABLE tickets
  ADD COLUMN subject_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', subject)) STORED;

CREATE INDEX messages_search_gin ON messages USING gin (search_vector);
CREATE INDEX tickets_subject_gin ON tickets USING gin (subject_vector);
CREATE INDEX customers_email_trgm ON customers USING gin (email gin_trgm_ops);
CREATE INDEX customers_name_trgm ON customers USING gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------------------------
-- Query-shaped indexes
-- ---------------------------------------------------------------------------------------------
-- Agent queue: own active tickets by deadline.
CREATE INDEX tickets_agent_queue_idx ON tickets (assignee_id, next_due_at NULLS LAST, created_at)
  WHERE status IN ('new', 'open', 'waiting_customer', 'on_hold');
-- Team queue without an owner: most urgent first.
CREATE INDEX tickets_team_queue_idx ON tickets (team_id, next_due_at NULLS LAST, created_at)
  WHERE assignee_id IS NULL AND status IN ('new', 'open', 'waiting_customer', 'on_hold');
-- Team dashboards: active tickets by team and deadline.
CREATE INDEX tickets_team_active_idx ON tickets (team_id, next_due_at NULLS LAST)
  WHERE status IN ('new', 'open', 'waiting_customer', 'on_hold');
-- Reports: period scans per team with the timing columns included for index-only scans.
CREATE INDEX tickets_report_idx ON tickets (team_id, created_at)
  INCLUDE (assignee_id, priority, first_responded_at, resolved_at, first_response_breached, resolution_breached);
CREATE INDEX tickets_customer_idx ON tickets (customer_id, created_at DESC);
CREATE INDEX tickets_team_updated_idx ON tickets (team_id, updated_at DESC);
CREATE INDEX tickets_merged_into_idx ON tickets (merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE INDEX tickets_follow_up_idx ON tickets (follow_up_of_id) WHERE follow_up_of_id IS NOT NULL;
CREATE INDEX tickets_resolved_idx ON tickets (resolved_at) WHERE status = 'resolved';

CREATE INDEX messages_ticket_created_idx ON messages (ticket_id, created_at);
-- Pending actions, scanned by the reconciler and by workers.
CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE status = 'pending';
CREATE INDEX jobs_dead_idx ON jobs (created_at DESC) WHERE status = 'dead';
CREATE INDEX outbound_due_idx ON outbound_emails (send_after) WHERE state IN ('scheduled', 'sending');
CREATE INDEX inbound_pending_idx ON inbound_messages (received_at) WHERE state = 'pending';
CREATE INDEX notifications_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX team_holidays_idx ON team_holidays (team_id, date);
CREATE INDEX surveys_rated_idx ON surveys (rated_at) WHERE rating IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Test clock change notifications
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app_clock_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('app_clock', NEW.generation::text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER app_clock_notify_trg
AFTER UPDATE ON app_clock
FOR EACH ROW EXECUTE FUNCTION app_clock_notify();
