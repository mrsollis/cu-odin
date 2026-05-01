# Ticket system asset

Portable schema and conventions for the orchestration agent's ticket tracker. Drop into any repo to replace Linear/Jira-style tracking with a local Supabase (or Postgres) table. Used by [@odin](../../agents/odin.md) (the per-ticket worker) and the [/process-ticket](../../skills/process-ticket/SKILL.md) dispatcher (the queue runner).

## Files

- `schema.sql` — DDL for the `tickets` table. Apply via Supabase migrations or `psql -f`.

## Schema

**`tickets`**

| Column | Type | Notes |
|---|---|---|
| id | text PK | Auto-assigned via `next_ticket_id()` → `T-1`, `T-2`, … |
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
| metadata | jsonb | Orchestrator-reserved keys + project extension slot (see below) |
| created_at, updated_at, completed_at | timestamptz | Auto-maintained |

`updated_at` auto-updates via trigger. `depends_on` is validated on every INSERT/UPDATE — unknown ids and self-references are rejected.

### Metadata namespace

`metadata` is a `jsonb` column (default `'{}'`) shared by the orchestrator and the project. The orchestrator owns a fixed set of top-level keys; everything else is yours. Stock cu-odin reads and writes only the reserved keys below.

> **Reserved namespace — do not reuse these top-level key names for project data.** The orchestrator writes them via `jsonb_set` / `||` and will overwrite anything it finds at these paths. New reserved keys may be added in future cu-odin releases; if you need future-proofing, scope project keys under a single project-owned namespace key (e.g. `metadata.app.*`) so additions upstream can't collide.

**Orchestrator-reserved keys** (written by [@odin](../../agents/odin.md)):

| Key | Writer phase | jsonb shape | Reserved — do not use for project data |
|---|---|---|---|
| `locked_tests` | Phase 1.5 — TDD locks the test contract | `{ files: [{path, sha256}], coverage: [{ac, file}], locked_at }` | ✗ reserved |
| `qa` | Phase 4 — QA handoff | `{ checklist: "<markdown>", posted_at }` | ✗ reserved |
| `outcome` | Phase 5 — ship | markdown string ("what changed" summary) | ✗ reserved |
| `telemetry` | Phase 5 — ship | run-telemetry block (mode, completed_at, duration, diff stats, per-track iterations, gate outcomes, blocked events) | ✗ reserved |
| `cancellation` | `/process-ticket` cancel | `{ reason, when }` | ✗ reserved |
| `comments` | Any phase — append-only inter-agent context, used sparingly since most run state has a dedicated key | array of `{ author, when, body }` | ✗ reserved |

Writes use `jsonb_set` / `||` so reserved-key updates never clobber project keys. See odin.md and process-ticket/SKILL.md for the canonical UPDATE statements.

**Project keys** live alongside under any other top-level name — for example, in-app source pointers when a ticket originates from inside the product, links to external systems, or feature flags. Add expression indexes (`create index ... on tickets ((metadata->>'key'))`) per-project if you query into them frequently.

Project-specific Postgres triggers can also observe ticket status transitions to drive side effects (notifications, threaded replies, reactions on a source message, etc.) — those triggers live alongside the project's other migrations, never inside this asset.

## Conventions

### Ticket ids
Auto-assigned by `next_ticket_id()` as `T-1`, `T-2`, … . The `id` column has the function as its default, so callers omit `id` on insert. Each Supabase project has its own sequence; ids only need to be unique within a database.

### Non-blocking suggestions
There is no persistent suggestions ledger. At Phase 4 QA handoff, odin surfaces accumulated MEDIUM/LOW findings to the user and asks whether to file each as its own ticket (via `/add-ticket`) or drop it. Suggestions the user skips are gone — by design, since this system is headless-first and a queue of un-triaged debt entries adds noise without adding signal.

### Status transitions during a run
- Plan accepted → `status='active'`, `labels` includes `'Exec: Active'`
- Phase 4 (QA handoff) → `status='qa'`, replace `'Exec: Active'` with `'QA: Testing'`
- Phase 5 (ship) → `status='complete'`, clear in-progress labels, clear `assigned_to`/`branch_name`/`blocked_reason`

### Blocked tickets
A blocked in-flight ticket stays `status='active'` and sets `blocked_reason`. There is no `blocked` enum value — keeping it `active` ensures it stays visible in in-flight queries instead of disappearing into a separate bucket.

### QA checklist
Written to `metadata.qa.checklist` (markdown string) at Phase 4 handoff. Never written into `tickets.description`.

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

That's it — no per-repo config to fill in. The Supabase project id lives in the Supabase MCP server config; nothing else to set.
