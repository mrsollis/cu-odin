---
name: add-ticket
description: Add a ticket to the project's Supabase tickets table. Used to file work for the @odin orchestrator and the /process-ticket queue runner.
version: 1.0.0
---

# Add Ticket

Creates a row in `public.tickets`. The Supabase project id is read from the Supabase MCP server config — there is no per-repo config to fill in.

## When to use

When the user asks to create a ticket, track work, or file an issue.

## Instructions

1. Gather the following from the user (or infer from context):
   - **title** (required): one-line summary.
   - **description** (required): full markdown detail. Include problem, plan, risks, affected files.
   - **category** (required): `perf` | `security` | `feature` | `bug` | `chore`.
   - **priority** (required): `critical` | `high` | `medium` | `low`.
   - **tier** (optional): int, lower = higher priority within bucket.
   - **effort_estimate** (optional): human-readable, e.g. `~half day`.
   - **files_affected** (optional): array of file paths this ticket touches. Used by `/process-ticket --orchestrate` to avoid parallel collisions.
   - **depends_on** (optional): array of ticket ids that must be `complete` first.

   Do **not** ask the user for an `id` — the database assigns it via `next_ticket_id()` (`T-1`, `T-2`, …).

2. Insert via the Supabase MCP `execute_sql` tool. Omit `id` so the column default fires; capture the assigned id from `RETURNING`:

```sql
INSERT INTO public.tickets
  (title, description, category, priority, tier, effort_estimate,
   files_affected, depends_on)
VALUES (
  '<title>',
  '<description>',
  '<category>',
  '<priority>',
  <tier or NULL>,
  '<effort_estimate or NULL>',
  ARRAY[<files_affected or empty>]::text[],
  ARRAY[<depends_on or empty>]::text[]
)
RETURNING id;
```

- Escape single quotes in description by doubling them (`''`).
- Status defaults to `'backlog'`. Do not set it on creation.

3. **Validate dependencies.** The DB trigger `trg_validate_ticket_deps` enforces that all ids in `depends_on` reference existing tickets and that a ticket cannot depend on itself. If the INSERT fails with `unknown ticket ids in depends_on: {…}`, check for typos or create the missing tickets first.

4. Confirm the ticket was created and show the assigned id back to the user. If the ticket has dependencies, note which ones must complete before it becomes ready in the queue.

## Schema quick reference

| Column | Type | Notes |
|---|---|---|
| id | text | Auto-assigned `T-1`, `T-2`, … (`T-0` reserved for the suggestions ledger) |
| title | text | One-line summary |
| description | text | Markdown |
| category | text | perf, security, feature, bug, chore |
| priority | text | critical, high, medium, low |
| tier | int | Optional, lower = higher priority |
| effort_estimate | text | Optional |
| files_affected | text[] | Optional, used for parallel-collision avoidance |
| depends_on | text[] | Optional, validated by DB trigger |
| metadata | jsonb | Optional, project-specific extension slot |

## Dependency rules

- `depends_on` is optional. When provided, every id must reference an existing ticket.
- The DB trigger rejects unknown ids and self-references.
- Tickets with unresolved dependencies are skipped by `/process-ticket` until all deps reach `status='complete'`.
