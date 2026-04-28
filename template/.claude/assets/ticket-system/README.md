# Ticket system asset

Portable schema and conventions for the orchestration agent's ticket tracker. Drop into any repo to replace Linear/Jira-style tracking with a local Supabase (or Postgres) table. Used by [@odin](../../agents/odin.md) (the per-ticket worker) and the [/process-ticket](../../skills/process-ticket/SKILL.md) dispatcher (the queue runner).

## Files

- `schema.sql` — DDL for `tickets` and `ticket_comments`. Apply via Supabase migrations or `psql -f`.

## Schema

**`tickets`**

| Column | Type | Notes |
|---|---|---|
| id | text PK | Human-readable, repo-prefixed (e.g. `TUM-123`) |
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
| branch_name | text | e.g. `ticket/tum-123` |
| blocked_reason | text | First-class field; status stays `active` |
| pr_url | text | Optional |
| created_at, updated_at, completed_at | timestamptz | Auto-maintained |

`updated_at` auto-updates via trigger. `depends_on` is validated on every INSERT/UPDATE — unknown ids and self-references are rejected.

**`ticket_comments`**
- `id` bigint PK
- `ticket_id` text → `tickets.id` (cascade delete)
- `body` text
- `created_at` timestamptz

## Conventions

### Ticket id prefix
Per-repo, set in the project's `CLAUDE.md` (e.g. `TUM-` for Telos).

### Suggestions ledger ticket
Each repo designates one ticket (e.g. `TUM-26`) where the orchestrator appends MEDIUM/LOW review findings as comments. Seed it manually after applying the schema:

```sql
insert into tickets (id, title, description, status, category, priority)
values ('<PREFIX>-26', 'Non-blocking suggestions ledger',
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
3. Seed the suggestions ledger ticket with the repo's prefix.
4. Add to the project `CLAUDE.md`:
   - Supabase project id
   - Ticket id prefix
   - Suggestions ledger ticket id
