# Ticket system asset

Portable schema and conventions for the orchestration agent's ticket tracker. Drop into any repo to replace Linear/Jira-style tracking with a local Supabase (or Postgres) table. Used by [@odin](../../agents/odin.md) (the per-ticket worker) and the [/process-ticket](../../skills/process-ticket/SKILL.md) dispatcher (the queue runner).

## Files

- `schema.sql` — DDL for `tickets` and `ticket_comments`. Apply via Supabase migrations or `psql -f`.

## Schema

**`tickets`**

| Column | Type | Notes |
|---|---|---|
| id | text PK | Auto-assigned via `next_ticket_id()` → `T-1`, `T-2`, … (`T-0` reserved for the suggestions ledger) |
| title | text | |
| description | text | Markdown |
| status | enum | `backlog` \| `active` \| `qa` \| `complete` |
| category | text | `perf` \| `security` \| `feature` \| `bug` \| `chore` |
| priority | text | `critical` \| `high` \| `medium` \| `low` |
| tier | int | Lower = higher priority within a priority bucket |
| effort_estimate | text | e.g. `~half day` |
| labels | text[] | e.g. `{'Exec: Active', 'QA: Testing'}` |
| depends_on | text[] | Ticket ids that must be `complete` first |
| files_affected | text[] | Used for collision-avoidance during parallel dispatch |
| assigned_to | text | `odin`, `odin-1`, `odin-2`, … |
| assigned_at | timestamptz | |
| branch_name | text | e.g. `ticket/t-123` |
| blocked_reason | text | First-class field; status stays `active` |
| pr_url | text | Optional |
| metadata | jsonb | Project-specific extension slot (see below) |
| created_at, updated_at, completed_at | timestamptz | Auto-maintained |

`updated_at` auto-updates via trigger. `depends_on` is validated on every INSERT/UPDATE — unknown ids and self-references are rejected.

### Project-specific metadata

`metadata` is a free-form `jsonb` column (default `'{}'`). Use it to attach project-specific context that should travel with a ticket — for example, in-app source pointers when a ticket originates from inside the product, links to external systems, or feature flags. Cu-odin's stock skills don't read or write `metadata`; it's reserved for the project. Add expression indexes (`create index ... on tickets ((metadata->>'key'))`) per-project if you query into it frequently.

Project-specific Postgres triggers can also observe ticket status transitions to drive side effects (notifications, threaded replies, reactions on a source message, etc.) — those triggers live alongside the project's other migrations, never inside this asset.

**`ticket_comments`**
- `id` bigint PK
- `ticket_id` text → `tickets.id` (cascade delete)
- `body` text
- `created_at` timestamptz

## Conventions

### Ticket ids
Auto-assigned by `next_ticket_id()` as `T-1`, `T-2`, … . The `id` column has the function as its default, so callers omit `id` on insert. Each Supabase project has its own sequence; ids only need to be unique within a database.

### Suggestions ledger ticket
The fixed id `T-0` is reserved for the per-project suggestions ledger — the orchestrator appends MEDIUM/LOW review findings to it as `ticket_comments`. Seed it once after applying the schema, **before any other inserts** so the sequence still starts at 1:

```sql
insert into tickets (id, title, description, status, category, priority)
values ('T-0', 'Non-blocking suggestions ledger',
        'Accumulated MEDIUM/LOW review findings. Append as comments.',
        'backlog', 'chore', 'low');
```

### Status transitions during a run
- Plan accepted → `status='active'`, `labels` includes `'Exec: Active'`
- Phase 4 (QA handoff) → `status='qa'`, replace `'Exec: Active'` with `'QA: Testing'`
- Phase 5 (ship) → `status='complete'`, clear in-progress labels, clear `assigned_to`/`branch_name`/`blocked_reason`

### Blocked tickets
A blocked in-flight ticket stays `status='active'` and sets `blocked_reason`. There is no `blocked` enum value — keeping it `active` ensures it stays visible in in-flight queries instead of disappearing into a separate bucket.

### QA checklist
Posted as a `ticket_comments` row whose `body` starts with `## QA Testing Checklist`. Never written into `tickets.description`.

### Ready-queue query (used by `/process-ticket`)

```sql
SELECT * FROM tickets t
WHERE t.status = 'backlog'
  AND NOT EXISTS (
    SELECT 1 FROM unnest(t.depends_on) AS dep_id
    WHERE dep_id NOT IN (SELECT id FROM tickets WHERE status = 'complete')
  )
ORDER BY
  CASE t.priority
    WHEN 'critical' THEN 0 WHEN 'high' THEN 1
    WHEN 'medium' THEN 2 WHEN 'low' THEN 3
  END,
  t.tier ASC NULLS LAST,
  t.created_at ASC;
```

## Adopting in a new repo

1. Create a Supabase project (or use any Postgres).
2. Apply `schema.sql`.
3. Seed `T-0` (suggestions ledger) per the example above.

That's it — no per-repo config to fill in. The Supabase project id lives in the Supabase MCP server config; nothing else to set.
