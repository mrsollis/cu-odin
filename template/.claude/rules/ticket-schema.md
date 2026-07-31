# Ticket schema (Supabase, replaces Linear/Jira)

Schema lives in [../assets/ticket-system/schema.sql](../assets/ticket-system/schema.sql). Apply once per project.

## Columns

`tickets`:

- `id` (text, auto `T-1`, `T-2`, … via `next_ticket_id()`)
- `title`, `description`
- `status` — `backlog` | `active` | `qa` | `complete`
- `category`, `priority`, `tier`, `depends_on`, `files_affected`, `assigned_to`, `assigned_at`, `branch_name`, `blocked_reason`, `completed_at`, `pr_url`
- `labels` (text[])
- `images` (jsonb) — up to 5 image attachments (base64 or Supabase Storage refs), fed to odin/specialists as visual context. Shape + cap: [../assets/ticket-system/README.md](../assets/ticket-system/README.md#image-attachments-images).
- `metadata` (jsonb) — single slot for everything else

A DB trigger validates `depends_on` (rejects unknown ids and self-references). A `CHECK` constraint caps `images` at 5 entries. Read/write via Supabase MCP tools, always merging into `metadata` with `||` / `jsonb_set` so reserved keys never clobber project keys.

## Image attachments (`images`)

Each entry is `{ id, source, mime, caption, added_at }` plus either `data` (base64, `source: "base64"`) or `path` (bucket-relative, `source: "storage"`). Base64 is the zero-infra default — it round-trips over the Supabase MCP `execute_sql` tool with no bucket. `/add-ticket` writes the array; `/process-ticket` materializes it to files under the ticket worktree (`.ticket-images/`) at claim time; odin reads those files (vision) alongside the description and routes the relevant ones into specialist briefs (`IMAGES:` field). Full shape, size guidance, and the migration for existing installs: [../assets/ticket-system/README.md](../assets/ticket-system/README.md#image-attachments-images).

## Reserved `metadata` keys (orchestrator-managed)

| Key | Written by | Shape |
|-----|------------|-------|
| `acceptance_criteria` | odin (Phase 1) | `[{id: "AC-1", text: "..."}, ...]` |
| `gate_set` | odin (Phase 1) | activated gates + reasons (see odin.md) |
| `locked_tests` | tdd (Phase 1.5) | `{locked_at, files: [{path, sha256}], coverage: [...], red_run}` |
| `qa` | odin (Phase 4) | `{checklist, posted_at}` |
| `outcome` | odin (Phase 5) | markdown body |
| `telemetry` | odin (Phase 5) | structured run data |
| `comments` | any agent | `[{at, by, text}]` |

There is **no** `ticket_comments` table. Per-ticket history lives in `metadata`. Non-blocking review findings are surfaced at QA handoff for the user to file (or drop) — there is no persistent suggestions ledger.

## Phase-4 QA handoff (single UPDATE)

```sql
UPDATE public.tickets
SET status = 'qa',
    labels = array_append(array_remove(labels, 'Exec: Active'), 'QA: Testing'),
    metadata = metadata || jsonb_build_object(
      'qa', jsonb_build_object(
        'checklist', '<markdown body>',
        'posted_at', to_jsonb(now())
      )
    )
WHERE id = '<this-ticket-id>';
```

Checklist starts with `## QA Testing Checklist` and uses `- [ ]` boxes organized by feature area, derived from the plan + edge cases surfaced during review.

## Phase-5 ship (single UPDATE)

```sql
UPDATE public.tickets
SET status = 'complete',
    completed_at = now(),
    pr_url = COALESCE(<pr_url>, pr_url),
    assigned_to = NULL, assigned_at = NULL,
    branch_name = NULL, blocked_reason = NULL,
    labels = array_remove(array_remove(labels, 'QA: Testing'), 'Exec: Active'),
    metadata = metadata || jsonb_build_object(
      'outcome', '<markdown body>',
      'telemetry', '<telemetry jsonb>'::jsonb
    )
WHERE id = '<this-ticket-id>';
```

## Telemetry shape

```json
{
  "telemetry": {
    "started_at": "2026-04-29T16:51:40Z",
    "completed_at": "2026-04-29T18:22:01Z",
    "duration_seconds": 5421,
    "tokens": {
      "total": 1822951,
      "by_agent": {
        "coder-web":       { "total": 204100, "calls": 3 },
        "code-review":     { "total": 151019, "calls": 3 },
        "tdd":             { "total":  75964, "calls": 1 },
        "security-review": { "total":  90160, "calls": 1 }
      }
    },
    "mode": "interactive",
    "commit_sha": "a1b2c3d",
    "commit_subject": "T-42: add invoice export",
    "branch": "ticket/t-42",
    "diff": { "files_changed": 7, "insertions": 312, "deletions": 48, "files": ["..."] },
    "tracks": [
      { "name": "Track 1", "sonnet_attempts": 1, "opus_elite_attempts": 0, "fable_elite_attempts": 0 }
    ],
    "gates": {
      "activated": ["data-architect", "tdd", "security-review"],
      "skipped": ["ux-design", "evaluator"],
      "elite_gate": "not_triggered",
      "tdd_elite_invoked": false,
      "data_gate": "approved",
      "security_gate": "secure"
    },
    "blocked_events": []
  }
}
```

## Outcome note format

```
## What Changed

<2–4 sentence plain-English summary, framed from the user's perspective.>

### Highlights
- <bullet 1>
- <bullet 2>
- <bullet 3>
```

Honest and concrete. No marketing voice.
