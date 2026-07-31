---
name: add-ticket
description: Add a ticket to the project's Supabase tickets table. Used to file work for the @odin orchestrator and the /process-ticket queue runner. Supports up to 5 image attachments.
version: 1.1.0
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
   - **effort_estimate** (optional, recommended): human-readable, e.g. `~half day`. Feeds odin's effort-sizing pass — well-estimated small tickets skip planning overhead and run cheaper.
   - **files_affected** (optional, recommended): array of file paths this ticket touches. Feeds odin's effort-sizing pass and orders merges at ship.
   - **depends_on** (optional): array of ticket ids that must be `complete` first.
   - **images** (optional): up to **5** image attachments (screenshots, mockups, reference shots). Fed to odin and the relevant specialists as visual context alongside the description. See "Attaching images" below.

   Do **not** ask the user for an `id` — the database assigns it via `next_ticket_id()` (`T-1`, `T-2`, …).

2. Insert via the Supabase MCP `execute_sql` tool. Omit `id` so the column default fires; capture the assigned id from `RETURNING`:

```sql
INSERT INTO public.tickets
  (title, description, category, priority, tier, effort_estimate,
   files_affected, depends_on, images)
VALUES (
  '<title>',
  '<description>',
  '<category>',
  '<priority>',
  <tier or NULL>,
  '<effort_estimate or NULL>',
  ARRAY[<files_affected or empty>]::text[],
  ARRAY[<depends_on or empty>]::text[],
  '<images json array or []>'::jsonb
)
RETURNING id;
```

- Escape single quotes in description by doubling them (`''`).
- Status defaults to `'backlog'`. Do not set it on creation.
- `images` defaults to `'[]'` — omit it from the column list entirely when the ticket has no attachments.

3. **Validate dependencies.** The DB trigger `trg_validate_ticket_deps` enforces that all ids in `depends_on` reference existing tickets and that a ticket cannot depend on itself. If the INSERT fails with `unknown ticket ids in depends_on: {…}`, check for typos or create the missing tickets first.

4. Confirm the ticket was created and show the assigned id back to the user. If the ticket has dependencies, note which ones must complete before it becomes ready in the queue. If images were attached, confirm the count (e.g. "2 images attached").

## Attaching images

Up to **5** images per ticket (a DB `CHECK` constraint rejects more). Each entry in the `images` array is one of two shapes — you can mix them in one ticket:

**base64** (the default — no bucket, no extra credentials; round-trips over the `execute_sql` tool):

1. Read the image bytes from the path the user gave you and base64-encode them. Downscale to ≤ ~1.5 MB first if the source is large — base64 inflates size ~33% and the bytes travel over the MCP.
2. Build the entry:

```json
{ "id": "img-1", "source": "base64", "mime": "image/png",
  "data": "<base64 with no data: prefix>",
  "caption": "<what the image shows / why it matters>",
  "added_at": "<ISO timestamp>" }
```

**storage ref** (only if the project already has a Supabase Storage bucket and the file is uploaded — the MCP has no Storage-upload tool, so you cannot create these from a local path yourself):

```json
{ "id": "img-1", "source": "storage", "mime": "image/png",
  "path": "ticket-images/<id>/img-1.png",
  "caption": "…", "added_at": "<ISO timestamp>" }
```

Assemble the entries into a JSON array and pass it as the `images` value in the INSERT (cast `::jsonb`). Give each a short, specific `caption` — odin uses captions to decide which specialist an image is routed to (a UI mockup → `ux-design`, a bug screenshot → the coder). Ids just need to be unique within the ticket (`img-1`, `img-2`, …).

If the user references an image you can't access (no readable path, no uploaded storage object), tell them rather than inventing a `data`/`path` value — a broken attachment is worse than none.

## Schema quick reference

| Column | Type | Notes |
|---|---|---|
| id | text | Auto-assigned `T-1`, `T-2`, … |
| title | text | One-line summary |
| description | text | Markdown |
| category | text | perf, security, feature, bug, chore |
| priority | text | critical, high, medium, low |
| tier | int | Optional, lower = higher priority |
| effort_estimate | text | Optional |
| files_affected | text[] | Optional, used for parallel-collision avoidance |
| depends_on | text[] | Optional, validated by DB trigger |
| images | jsonb | Optional, ≤ 5 attachments (base64 or storage refs); default `[]` |
| metadata | jsonb | Optional, project-specific extension slot |

## Dependency rules

- `depends_on` is optional. When provided, every id must reference an existing ticket.
- The DB trigger rejects unknown ids and self-references.
- Tickets with unresolved dependencies are skipped by `/process-ticket` until all deps reach `status='complete'`.
