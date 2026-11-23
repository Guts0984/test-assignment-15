-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SEQUENCE IF NOT EXISTS ticket_number_seq START 100000;

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'staff',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "on_shift" BOOLEAN NOT NULL DEFAULT false,
    "ticket_limit" INTEGER NOT NULL DEFAULT 20,
    "open_count" INTEGER NOT NULL DEFAULT 0,
    "languages" TEXT[] DEFAULT ARRAY['en']::TEXT[],
    "last_assigned_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "time_zone" TEXT NOT NULL,
    "workdays" INTEGER[],
    "work_start_min" INTEGER NOT NULL,
    "work_end_min" INTEGER NOT NULL,
    "default_language" TEXT NOT NULL DEFAULT 'en',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_holidays" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "team_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'agent',

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id","user_id")
);

-- CreateTable
CREATE TABLE "mailboxes" (
    "address" TEXT NOT NULL,
    "default_team_id" UUID NOT NULL,

    CONSTRAINT "mailboxes_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "routing_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "position" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "recipient" TEXT,
    "subject_keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "language" TEXT,
    "team_id" UUID NOT NULL,
    "priority" TEXT,

    CONSTRAINT "routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" BIGINT NOT NULL DEFAULT nextval('ticket_number_seq'),
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "language" TEXT NOT NULL DEFAULT 'en',
    "source" TEXT NOT NULL DEFAULT 'email',
    "team_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "assignee_id" UUID,
    "mailbox_address" TEXT,
    "merged_into_id" UUID,
    "follow_up_of_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "message_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queued_at" TIMESTAMPTZ(3),
    "first_responded_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "last_customer_msg_at" TIMESTAMPTZ(3),
    "last_public_reply_at" TIMESTAMPTZ(3),
    "first_response_due_at" TIMESTAMPTZ(3),
    "first_response_warn_at" TIMESTAMPTZ(3),
    "resolution_due_at" TIMESTAMPTZ(3),
    "resolution_warn_at" TIMESTAMPTZ(3),
    "sla_paused" BOOLEAN NOT NULL DEFAULT false,
    "next_due_at" TIMESTAMPTZ(3),
    "first_response_breached" BOOLEAN NOT NULL DEFAULT false,
    "resolution_breached" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "author_kind" TEXT NOT NULL,
    "author_user_id" UUID,
    "author_name" TEXT,
    "body" TEXT NOT NULL,
    "rfc_message_id" TEXT,
    "inbound_message_id" UUID,
    "auto_kind" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mailbox_address" TEXT NOT NULL,
    "rfc_message_id" TEXT NOT NULL,
    "raw" BYTEA NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "ticket_id" UUID,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_emails" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "message_id" UUID,
    "purpose" TEXT NOT NULL,
    "to_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "rfc_message_id" TEXT NOT NULL,
    "in_reply_to" TEXT,
    "references_hdr" TEXT,
    "auto_generated" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'scheduled',
    "send_after" TIMESTAMPTZ(3) NOT NULL,
    "lease_until" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_events" (
    "id" BIGSERIAL NOT NULL,
    "ticket_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_user_id" UUID,
    "actor_label" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_pauses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "sla_pauses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_access_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "surveys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "rating" INTEGER,
    "comment" TEXT,
    "rated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "ticket_id" UUID,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "run_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "last_error" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_clock" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "offset_ms" BIGINT NOT NULL DEFAULT 0,
    "generation" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "app_clock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seed_runs" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "profile" TEXT NOT NULL,
    "random_seed" INTEGER NOT NULL,
    "finished_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "seed_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "teams_name_key" ON "teams"("name");

-- CreateIndex
CREATE UNIQUE INDEX "team_holidays_team_id_date_key" ON "team_holidays"("team_id", "date");

-- CreateIndex
CREATE INDEX "team_members_user_id_idx" ON "team_members"("user_id");

-- CreateIndex
CREATE INDEX "routing_rules_position_idx" ON "routing_rules"("position");

-- CreateIndex
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_number_key" ON "tickets"("number");

-- CreateIndex
CREATE UNIQUE INDEX "messages_inbound_message_id_key" ON "messages"("inbound_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_ticket_id_seq_key" ON "messages"("ticket_id", "seq");

-- CreateIndex
CREATE INDEX "attachments_message_id_idx" ON "attachments"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_messages_mailbox_address_rfc_message_id_key" ON "inbound_messages"("mailbox_address", "rfc_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_emails_message_id_key" ON "outbound_emails"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_emails_rfc_message_id_key" ON "outbound_emails"("rfc_message_id");

-- CreateIndex
CREATE INDEX "outbound_emails_ticket_id_idx" ON "outbound_emails"("ticket_id");

-- CreateIndex
CREATE INDEX "ticket_events_ticket_id_id_idx" ON "ticket_events"("ticket_id", "id");

-- CreateIndex
CREATE INDEX "sla_pauses_ticket_id_idx" ON "sla_pauses"("ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_access_tokens_token_hash_key" ON "ticket_access_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "ticket_access_tokens_ticket_id_idx" ON "ticket_access_tokens"("ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "surveys_ticket_id_key" ON "surveys"("ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "surveys_token_hash_key" ON "surveys"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_dedupe_key_key" ON "jobs"("dedupe_key");

-- AddForeignKey
ALTER TABLE "team_holidays" ADD CONSTRAINT "team_holidays_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_default_team_id_fkey" FOREIGN KEY ("default_team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_pauses" ADD CONSTRAINT "sla_pauses_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_access_tokens" ADD CONSTRAINT "ticket_access_tokens_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

