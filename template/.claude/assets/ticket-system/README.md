# Ticket system asset

Portable schema and conventions for the orchestration agent's ticket tracker. Drop into any repo to replace Linear/Jira-style tracking with a local Supabase (or Postgres) table. Used by [@odin](../../agents/odin.md) (the per-ticket worker) and the [/process-ticket](../../skills/process-ticket/SKILL.md) dispatcher (the queue runner).

## Files

- `schema.sql` — complete DDL for the `tickets` table (greenfield). Apply via Supabase migrations or `psql -f`. Complete and current — new installs need only this (RLS enabled, `images` column included).
- `migrations/001_add_images.sql` — incremental upgrade for installs created before the `images` column existed. New installs skip it (see "Migrating an existing install" below).
- `migrations/002_enable_rls.sql` — for projects created from an **older** `schema.sql` that predates RLS. New installs skip it (running it anyway is harmless).

## Security posture (read this)

The `tickets` table is a **trust boundary**: whoever can INSERT/UPDATE a ticket can steer the agent pipeline, because ticket `description`/`metadata` is fed to [@odin](../../agents/odin.md) as instructions. `schema.sql` therefore enables **Row-Level Security with no policies**, which denies all access to the Supabase `anon`/`authenticated` roles (the anon key is public by design and would otherwise expose every ticket through the PostgREST API). The orchestrator's Supabase MCP connection uses `service_role`, which bypasses RLS, so nothing breaks.

If you created your project before RLS shipped, apply `migrations/002_enable_rls.sql`. Verify with:

```sql
select relrowsecurity from pg_class where relname = 'tickets';  -- expect: t
select count(*) from pg_policies where tablename = 'tickets';   -- expect: 0
```

Only add policies if you deliberately need client (anon-key) access — never leave RLS off.

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
| images | jsonb | Up to 5 attachments fed to odin/specialists as visual context (see below). Default `'[]'`. |
| metadata | jsonb | Orchestrator-reserved keys + project extension slot (see below) |
| created_at, updated_at, completed_at | timestamptz | Auto-maintained |

`updated_at` auto-updates via trigger. `depends_on` is validated on every INSERT/UPDATE — unknown ids and self-references are rejected.

### Image attachments (`images`)

`images` is a `jsonb` array (default `'[]'`), capped at **5 entries** by a `CHECK` constraint. Attach screenshots, mockups, or reference images to a ticket and the harness feeds them to odin and the relevant specialists as visual context alongside the text description — a bug screenshot to the coder, a design mockup to `ux-design`, and so on.

Each entry is one of two shapes:

**base64** (the zero-infra default — works over the Supabase MCP `execute_sql` tool with no bucket or extra credentials):

```json
{ "id": "img-1", "source": "base64", "mime": "image/png",
  "data": "iVBORw0KGgoAAAANS…", "caption": "Login screen shows the error toast",
  "added_at": "2026-07-31T14:00:00Z" }
```

`data` is the raw base64 of the file bytes (no `data:image/png;base64,` prefix). Keep each image reasonably small — downscale to ≤ ~1.5 MB before encoding, since base64 inflates bytes ~33% and the row travels over the MCP on every read that selects the column.

**storage ref** (lean rows — bytes live in Supabase Storage; requires you to create a bucket and upload out-of-band, since the MCP has no Storage-upload tool):

```json
{ "id": "img-1", "source": "storage", "mime": "image/png",
  "path": "ticket-images/T-42/img-1.png", "caption": "…",
  "added_at": "2026-07-31T14:00:00Z" }
```

`path` is bucket-relative. `/add-ticket` accepts either shape; `/process-ticket` materializes both to files under the ticket worktree (`.ticket-images/`) at claim time so vision-capable models can `Read` them. Mixed arrays (some base64, some storage) are fine.

> **Keep base64 out of `SELECT *` in hot paths.** The ready-queue and list queries don't need image bytes. Select `images` only when you actually intend to render or materialize attachments (claim time), or select a lightweight projection like `jsonb_array_length(images) AS image_count` for queue views.

### Metadata namespace

`metadata` is a `jsonb` column (default `'{}'`) shared by the orchestrator and the project. The orchestrator owns a fixed set of top-level keys; everything else is yours. Stock cu-odin reads and writes only the reserved keys below.

> **Reserved namespace — do not reuse these top-level key names for project data.** The orchestrator writes them via `jsonb_set` / `||` and will overwrite anything it finds at these paths. New reserved keys may be added in future cu-odin releases; if you need future-proofing, scope project keys under a single project-owned namespace key (e.g. `metadata.app.*`) so additions upstream can't collide.

**Orchestrator-reserved keys** (written by [@odin](../../agents/odin.md)):

| Key | Writer phase | jsonb shape | Reserved — do not use for project data |
|---|---|---|---|
| `acceptance_criteria` | Phase 1 — odin authors after plan synthesis | array of `{ id, text }` — flat list of testable acceptance criteria. `tdd` anchors locked tests to these (each test tags its `AC-N`); `code-review` checks the implementation against the list at Phase 2. | ✗ reserved |
| `locked_tests` | Phase 1.5 — TDD locks the test contract | `{ files: [{path, sha256}], coverage: [{ac, file}], locked_at }` | ✗ reserved |
| `qa` | Phase 4 — QA handoff | `{ checklist: "<markdown>", posted_at }` | ✗ reserved |
| `outcome` | Phase 5 — ship; authored by odin from run transcripts | markdown string ("what changed" summary) | ✗ reserved |
| `telemetry` | Phase 5 — ship; `/process-ticket` on harness halt | run-telemetry block (mode, completed_at, duration, diff stats, per-track attempt counts, gate outcomes, blocked events). Also carries `telemetry.harness_halts: [{ when, cause, detail, worktree }]` — appended by the dispatcher when a ticket is unclaimed after the parent session crashed mid-cohort. Distinct from `blocked_reason`, which records work-blocks on still-active tickets. | ✗ reserved |
| `cancellation` | `/process-ticket` cancel | `{ reason, when }` | ✗ reserved |
| `comments` | Any phase — append-only inter-agent context, used sparingly since most run state has a dedicated key | array of `{ author, when, body }` | ✗ reserved |

Writes use `jsonb_set` / `||` so reserved-key updates never clobber project keys. See odin.md and process-ticket/SKILL.md for the canonical UPDATE statements.

**Project keys** live alongside under any other top-level name — for example, in-app source pointers when a ticket originates from inside the product, links to external systems, or feature flags. Add expression indexes (`create index ... on tickets ((metadata->>'key'))`) per-project if you query into them frequently.

Project-specific Postgres triggers can also observe ticket status transitions to drive side effects (notifications, threaded replies, reactions on a source message, etc.) — those triggers live alongside the project's other migrations, never inside this asset.

## Conventions

### Ticket ids
Auto-assigned by `next_ticket_id()` as `T-1`, `T-2`, … . The `id` column has the function as its default, so callers omit `id` on insert. Each Supabase project has its own sequence; ids only need to be unique within a database.

### Non-blocking suggestions
There is no persistent suggestions ledger. At Phase 4 QA handoff, odin surfaces accumulated HIGH/MEDIUM/LOW findings to the user and asks whether to file each as its own ticket (via `/add-ticket`) or drop it. Suggestions the user skips are gone — by design, since this system is headless-first and a queue of un-triaged debt entries adds noise without adding signal. Only CRITICAL findings block the coder/review loop; HIGH/MEDIUM/LOW are advisory.

### Status transitions during a run
- Plan accepted → `status='active'`, `labels` includes `'Exec: Active'`, `metadata.acceptance_criteria` written by odin
- Phase 4 (QA handoff) → `status='qa'`, replace `'Exec: Active'` with `'QA: Testing'`, write `metadata.qa.checklist`
- Phase 5 (ship) → `status='complete'`, clear in-progress labels, clear `assigned_to`/`branch_name`/`blocked_reason`, write `metadata.outcome` and `metadata.telemetry`

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
2. Apply `schema.sql` (it already enables RLS — see Security posture above).
3. If you're updating a project created from an older schema, apply the relevant `migrations/*.sql` too (`001_add_images.sql`, `002_enable_rls.sql`).

That's it — no per-repo config to fill in. The Supabase project id lives in the Supabase MCP server config; nothing else to set.

## Migrating an existing install (add the `images` column)

`schema.sql` already includes the `images` column, so **new installs need nothing extra** — just apply it.

If you adopted cu-odin before the `images` column existed, apply the standalone migration once instead of re-running the whole schema:

```
migrations/001_add_images.sql
```

It's idempotent (`add column if not exists` + `drop/add constraint`), adds the ≤ 5 cap, and touches no existing rows. Apply via Supabase migrations, the MCP `apply_migration` tool, or `psql -f migrations/001_add_images.sql`.
