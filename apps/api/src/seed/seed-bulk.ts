import { createHash } from 'node:crypto';
import type { Tx } from '@helpdesk/core';
import type { SeededBase } from './seed-base';
import type { SeedSizes } from './profiles';
import type { Rng } from './rng';
import { FIRST_NAMES, LAST_NAMES, buildBodyPool, buildSubjectPool } from './text-data';

/** Same value as Postgres `md5(text)::uuid`, used for deterministic bulk ids. */
export const md5Uuid = (text: string): string => {
  const h = createHash('md5').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export const BODY_POOL_SIZE = 20_000;
export const SUBJECT_POOL_SIZE = 3_000;

export type BulkResult = {
  readonly bodies: readonly string[];
  readonly subjects: readonly string[];
};

const SEARCH_INDEXES = [
  'messages_search_gin',
  'tickets_subject_gin',
  'customers_email_trgm',
  'customers_name_trgm',
] as const;

export const dropSearchIndexes = async (tx: Tx): Promise<void> => {
  for (const i of SEARCH_INDEXES) await tx.$executeRawUnsafe(`DROP INDEX IF EXISTS ${i}`);
};

export const createSearchIndexes = async (tx: Tx): Promise<void> => {
  await tx.$executeRawUnsafe(
    'CREATE INDEX messages_search_gin ON messages USING gin (search_vector)',
  );
  await tx.$executeRawUnsafe(
    'CREATE INDEX tickets_subject_gin ON tickets USING gin (subject_vector)',
  );
  await tx.$executeRawUnsafe(
    'CREATE INDEX customers_email_trgm ON customers USING gin (email gin_trgm_ops)',
  );
  await tx.$executeRawUnsafe(
    'CREATE INDEX customers_name_trgm ON customers USING gin (name gin_trgm_ops)',
  );
};

/**
 * Bulk-inserts customers, closed historic tickets, their messages, two history events each and
 * surveys with plain INSERT ... SELECT generate_series, so 500k tickets / 3M messages stay fast.
 * `liveCount` tickets of the total are created separately (open tickets with running timers).
 */
export const seedHistoric = async (
  tx: Tx,
  o: {
    readonly sizes: SeedSizes;
    readonly now: Date;
    readonly rng: Rng;
    readonly base: SeededBase;
    readonly liveCount: number;
    readonly liveMessageTarget: number;
  },
): Promise<BulkResult> => {
  const { sizes, now } = o;
  const bodies = buildBodyPool(o.rng, BODY_POOL_SIZE);
  const subjects = buildSubjectPool(o.rng, SUBJECT_POOL_SIZE);
  const historic = sizes.tickets - o.liveCount;

  await tx.$executeRawUnsafe('SET LOCAL synchronous_commit = off');
  await tx.$executeRawUnsafe("SET LOCAL maintenance_work_mem = '512MB'");
  await tx.$executeRawUnsafe('SELECT setseed(0.4242)');
  await dropSearchIndexes(tx);

  await tx.$executeRawUnsafe(
    'CREATE TEMP TABLE seed_body (i int PRIMARY KEY, body text NOT NULL) ON COMMIT DROP',
  );
  await tx.$executeRawUnsafe(
    'CREATE TEMP TABLE seed_subject (i int PRIMARY KEY, subject text NOT NULL) ON COMMIT DROP',
  );
  await tx.$executeRawUnsafe(
    'INSERT INTO seed_body SELECT ord - 1, b FROM unnest($1::text[]) WITH ORDINALITY AS t(b, ord)',
    [...bodies],
  );
  await tx.$executeRawUnsafe(
    'INSERT INTO seed_subject SELECT ord - 1, s FROM unnest($1::text[]) WITH ORDINALITY AS t(s, ord)',
    [...subjects],
  );
  await tx.$executeRawUnsafe(
    'CREATE TEMP TABLE seed_team (idx int PRIMARY KEY, id uuid NOT NULL, mailbox text NOT NULL) ON COMMIT DROP',
  );
  await tx.$executeRawUnsafe(
    'CREATE TEMP TABLE seed_agent (team_idx int, k int, id uuid NOT NULL, PRIMARY KEY (team_idx, k)) ON COMMIT DROP',
  );
  for (const [i, t] of o.base.teams.entries()) {
    await tx.$executeRawUnsafe(
      'INSERT INTO seed_team VALUES ($1, $2::uuid, $3)',
      i + 1,
      t.id,
      t.mailbox,
    );
    const agents = o.base.agents.filter((a) => a.teamId === t.id);
    for (const [k, a] of agents.entries()) {
      await tx.$executeRawUnsafe(
        'INSERT INTO seed_agent VALUES ($1, $2, $3::uuid)',
        i + 1,
        k + 1,
        a.id,
      );
    }
  }

  // Customers: deterministic ids so tickets can reference them without a join.
  await tx.$executeRawUnsafe(
    `INSERT INTO customers (id, email, name, created_at)
     SELECT md5('cust:' || g)::uuid,
            lower(f || '.' || l) || '.' || g || '@mail.example',
            f || ' ' || l,
            $1::timestamptz - random() * $2::int * interval '1 day'
       FROM generate_series(1, $3::int) g,
            LATERAL (SELECT ($4::text[])[1 + (g % array_length($4::text[], 1))] AS f,
                            ($5::text[])[1 + ((g / array_length($4::text[], 1)) % array_length($5::text[], 1))] AS l) n`,
    now,
    sizes.historyDays,
    sizes.customers,
    FIRST_NAMES,
    LAST_NAMES,
  );

  await tx.$executeRawUnsafe(
    `INSERT INTO tickets (id, subject, status, priority, language, source, team_id, customer_id, assignee_id,
                          mailbox_address, version, message_seq, created_at, updated_at, first_responded_at,
                          resolved_at, closed_at, last_customer_msg_at, last_public_reply_at,
                          first_response_breached, resolution_breached)
     WITH base AS MATERIALIZED (
       SELECT g, random() r_team, random() r_created, random() r_resp, random() r_res, random() r_prio,
              random() r_cust, random() r_agent, random() r_b1, random() r_b2, random() r_subj, random() r_src
         FROM generate_series(1, $1::int) g
     ), t AS MATERIALIZED (
       SELECT b.*,
              CASE WHEN r_team < 0.35 THEN 1 WHEN r_team < 0.55 THEN 2 WHEN r_team < 0.8 THEN 3 ELSE 4 END AS team_idx,
              $2::timestamptz - interval '10 days' - r_created * ($3::int - 10) * interval '1 day' AS created_at
         FROM base b
     ), s AS MATERIALIZED (
       SELECT t.*,
              t.created_at + interval '5 minutes' + interval '12 hours' * r_resp * r_resp AS first_resp,
              t.created_at + interval '15 minutes' + interval '12 hours' * r_resp * r_resp + interval '96 hours' * r_res * r_res AS resolved
         FROM t
     )
     SELECT md5('ticket:' || g)::uuid,
            sub.subject,
            'closed',
            CASE WHEN r_prio < 0.05 THEN 'urgent' WHEN r_prio < 0.25 THEN 'high' WHEN r_prio < 0.8 THEN 'normal' ELSE 'low' END,
            CASE s.team_idx WHEN 1 THEN CASE WHEN r_subj < 0.7 THEN 'en' ELSE 'uk' END
                            WHEN 2 THEN CASE WHEN r_subj < 0.7 THEN 'en' ELSE 'uk' END
                            WHEN 3 THEN CASE WHEN r_subj < 0.5 THEN 'en' WHEN r_subj < 0.8 THEN 'pl' ELSE 'de' END
                            ELSE CASE WHEN r_subj < 0.6 THEN 'en' ELSE 'pl' END END,
            CASE WHEN r_src < 0.8 THEN 'email' ELSE 'web' END,
            st.id,
            md5('cust:' || (1 + floor(r_cust * $4::int)::int))::uuid,
            sa.id,
            st.mailbox,
            1,
            0,
            s.created_at,
            s.resolved + interval '72 hours',
            s.first_resp,
            s.resolved,
            s.resolved + interval '72 hours',
            s.created_at,
            s.resolved - interval '1 minute',
            r_b1 < 0.08,
            r_b2 < 0.12
       FROM s
       JOIN seed_team st ON st.idx = s.team_idx
       JOIN seed_agent sa ON sa.team_idx = s.team_idx AND sa.k = 1 + floor(s.r_agent * $5::int)::int
       JOIN seed_subject sub ON sub.i = floor(s.r_subj * $6::int)::int`,
    historic,
    now,
    sizes.historyDays,
    sizes.customers,
    sizes.agentsPerTeam,
    SUBJECT_POOL_SIZE,
  );

  // Messages: 4..8 per ticket (average 6); every fifth is an internal note, the rest alternate customer/agent.
  await tx.$executeRawUnsafe(
    `INSERT INTO messages (ticket_id, seq, kind, direction, author_kind, author_user_id, body, created_at, released_at)
     SELECT t.id, s,
            CASE WHEN s % 5 = 0 THEN 'note' ELSE 'public' END,
            CASE WHEN s % 5 = 0 THEN 'internal' WHEN s % 2 = 1 THEN 'inbound' ELSE 'outbound' END,
            CASE WHEN s % 5 = 0 OR s % 2 = 0 THEN 'agent' ELSE 'customer' END,
            CASE WHEN s % 5 = 0 OR s % 2 = 0 THEN t.assignee_id END,
            p.body,
            LEAST(t.created_at + (s - 1) * interval '90 minutes' * (0.5 + ((t.number * 31 + s * 17) % 100) / 100.0), t.closed_at),
            CASE WHEN s % 5 <> 0 AND s % 2 = 0
                 THEN LEAST(t.created_at + (s - 1) * interval '90 minutes' * (0.5 + ((t.number * 31 + s * 17) % 100) / 100.0), t.closed_at) END
       FROM tickets t
      CROSS JOIN LATERAL generate_series(1, (ARRAY[4, 5, 6, 7, 8])[1 + (t.number % 5)::int]) s
       JOIN seed_body p ON p.i = ((t.number * 31 + s * 17) % $1::int)::int
      WHERE t.closed_at IS NOT NULL`,
    BODY_POOL_SIZE,
  );

  // Top up with internal notes so the grand total (including the live set) hits the target exactly.
  const counted = await tx.$queryRawUnsafe<{ count: bigint }[]>(
    'SELECT count(*)::bigint AS count FROM messages',
  );
  const deficit = sizes.messages - o.liveMessageTarget - Number(counted[0]?.count ?? 0);
  if (deficit < 0 || deficit > historic) {
    throw new Error(
      `Seed message count cannot be tuned: deficit ${deficit} for ${historic} historic tickets`,
    );
  }
  if (deficit > 0) {
    await tx.$executeRawUnsafe(
      `INSERT INTO messages (ticket_id, seq, kind, direction, author_kind, author_user_id, body, created_at)
       SELECT t.id, (ARRAY[4, 5, 6, 7, 8])[1 + (t.number % 5)::int] + 1, 'note', 'internal', 'agent', t.assignee_id,
              p.body, t.closed_at
         FROM (SELECT * FROM tickets WHERE closed_at IS NOT NULL ORDER BY number LIMIT $1::int) t
         JOIN seed_body p ON p.i = ((t.number * 13) % $2::int)::int`,
      deficit,
      BODY_POOL_SIZE,
    );
  }
  await tx.$executeRawUnsafe(
    `UPDATE tickets t SET message_seq = m.n
       FROM (SELECT ticket_id, max(seq) AS n FROM messages GROUP BY ticket_id) m
      WHERE m.ticket_id = t.id`,
  );

  await tx.$executeRawUnsafe(
    `INSERT INTO ticket_events (ticket_id, type, actor_kind, data, created_at)
     SELECT id, 'created', 'customer', '{}'::jsonb, created_at FROM tickets WHERE closed_at IS NOT NULL
     UNION ALL
     SELECT id, 'status_changed', 'system', '{"from":"resolved","to":"closed"}'::jsonb, closed_at FROM tickets WHERE closed_at IS NOT NULL`,
  );

  // Surveys for about 35% of closed tickets, skewed towards good ratings.
  await tx.$executeRawUnsafe(
    `INSERT INTO surveys (ticket_id, token_hash, expires_at, rating, comment, rated_at, created_at)
     SELECT id, md5(id::text || 's') || md5(id::text || 't'), closed_at + interval '7 days', rating,
            CASE WHEN number % 5 = 0 THEN 'Thanks for the quick help' END,
            closed_at + interval '3 hours', closed_at
       FROM (SELECT t.*, CASE WHEN x < 0.45 THEN 5 WHEN x < 0.7 THEN 4 WHEN x < 0.82 THEN 3 WHEN x < 0.92 THEN 2 ELSE 1 END AS rating
               FROM (SELECT tickets.*, ((number * 2654435761) % 1000) / 1000.0 AS x FROM tickets) t) q
      WHERE closed_at IS NOT NULL AND number % 100 < 35`,
  );

  await createSearchIndexes(tx);
  return { bodies, subjects };
};
