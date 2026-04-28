---
name: process-ticket
description: Pick up, dispatch, and report on tickets from the project's Supabase tickets table. Hands each claimed ticket to @odin for execution, supports per-ticket queue runs and worktree-based parallel orchestration.
version: 1.0.0
---

# Process Ticket

Dispatcher / queue runner for the project's `public.tickets` table. The Supabase project id and ticket id prefix are set in the project's `CLAUDE.md`.

This skill **does not implement work**. Each claimed ticket is handed to [@odin](../../agents/odin.md), which runs the full pipeline (UX → planning → coder/review loop with elite gate → data gate → security gate → QA handoff). The dispatcher owns claim, branching, worktree lifecycle, dependency resolution, parallel collision avoidance, and end-of-run cleanup.

## Prime directive

**Do not ask the user before claiming tickets.** When `/process-ticket` is invoked with no args, with `next`, with `--loop`, or with `--orchestrate N`, immediately claim and start work. Listing + asking is reserved for the `list` subcommand. Confirmation is friction the user has explicitly rejected.

## When to use

When the user wants to: pick up the next ready ticket, drain the queue, run multiple tickets in parallel, or query queue state.

## Subcommands & flags

- `/process-ticket` (no args) — Auto-claim the top ready ticket and hand to `@odin`. **Do not ask.**
- `/process-ticket next` — Alias for no-args.
- `/process-ticket --loop` — Keep claiming and processing tickets one at a time until none remain.
- `/process-ticket --orchestrate N` — Dispatch up to N parallel `@odin` instances, each in its own git worktree. `N` defaults to `3` if omitted, capped at `5`.
- `/process-ticket --loop --orchestrate N` — Combine: keep orchestrating cohorts of N until the queue is empty.
- `/process-ticket --dry-run` — Show the claim plan, dependency resolution, and parallelization decisions. Do not claim, branch, or modify anything. Combinable with `--orchestrate` and filters.
- `/process-ticket list` — List open tickets and let the user pick one. The only path that prompts.
- `/process-ticket <id>` — Show detail for a specific ticket.
- `/process-ticket status` — Dashboard summary by status.

### Filters (combinable with any non-`list` invocation)

- `--priority critical,high` — Only claim tickets in these priorities.
- `--category bug,chore` — Only claim tickets in these categories.
- `--tier 1` — Only claim tickets at this tier (or lower number = higher priority).

## Operating modes

The dispatcher inherits the session mode from `@odin`'s rules:

- **Interactive (default)** — per-ticket commit prompt after each QA handoff (see "Per-ticket commit policy"). Sub-Odins respect their own plan-approval gate.
- **Headless** — triggered by `headless` or `bifrost` in the user message, or harness `Auto mode active`. Sub-Odins skip plan approval. Single auto-commit confirmation prompt at run start; no further prompts during the run.

State the mode at the top of the first response: `Mode: headless — auto-commit ...` or `Mode: interactive`.

## Pre-flight: clean working tree

**Before claiming any ticket, the working tree MUST be clean.** Uncommitted changes would muddy ticket diffs.

1. Run `git status --porcelain` in the repo root.
2. If output is non-empty:
   - Show the user the modified/untracked files.
   - Recommend committing first: "I recommend committing these so the ticket branch has a clean starting point. Commit, stash, or abort?"
   - Default `commit`. Do not auto-commit without confirmation.
3. Once clean, proceed with claim.

For `--orchestrate`, the main working tree stays on `main`; worktrees branch off `main` at pre-flight time, so the check still applies once.

## Behavior: no-args / `next` / `--loop` (single-agent path)

1. **Pre-flight:** clean working tree (above).
2. **Mode check:** if headless, prompt **once**: `auto-commit each ticket as it completes? [Y/n]`. Remember the answer for the rest of the run.
3. **Claim atomically** — top ready ticket (deps satisfied, filters applied):

```sql
UPDATE public.tickets
SET status = 'active',
    assigned_to = 'odin',
    assigned_at = now(),
    branch_name = 'ticket/' || lower(id),
    labels = array_append(array_remove(labels, 'Exec: Active'), 'Exec: Active')
WHERE id = (
  SELECT t.id FROM public.tickets t
  WHERE t.status = 'backlog'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(t.depends_on) AS dep_id
      WHERE dep_id NOT IN (
        SELECT d.id FROM public.tickets d WHERE d.status = 'complete'
      )
    )
    -- Apply filters here when present:
    -- AND t.priority = ANY(ARRAY[...])
    -- AND t.category = ANY(ARRAY[...])
    -- AND t.tier = <tier>
  ORDER BY
    CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
    t.tier ASC NULLS LAST,
    t.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING id, title, category, priority, tier, effort_estimate, description,
          depends_on, files_affected;
```

- Priority: critical > high > medium > low. Tie-break: tier ASC, then FIFO.
- If no ready ticket, report queue state. In `--loop`, exit the loop.

4. **Branch:** `git checkout -b ticket/<id-lower>` from clean `main`.

5. **Hand to `@odin`** with:
   - The ticket id and full description.
   - The session mode (interactive/headless).
   - A note: "Ticket already claimed; branch already created. Skip ticket-creation steps. Run through QA handoff (Phase 4). Do not ship — the dispatcher manages commit and the user controls Phase 5."

6. **Wait for `@odin`** to reach Phase 4 (status → `qa`, QA checklist comment posted) — or to halt (BLOCKED / elite-gate halt).

7. **Per-ticket commit policy** (see below).

8. **`--loop` only:** return to step 3 until no ready ticket remains.

9. **End-of-run summary** (always, both modes): tickets in `qa`, blocked, halted, branches present, newly-unblocked downstream tickets.

## Behavior: `--orchestrate N` (multi-agent path)

The dispatcher orchestrates up to **N** parallel sub-`@odin` instances, each with its own context window and git worktree. Sub-agents commit on their branches; the dispatcher (not sub-agents) owns merges to `main` — but those happen only when the user triggers Phase 5 ship.

### Setup (once per run)

1. Pre-flight clean tree (above).
2. Mode check + auto-commit prompt (headless only).
3. Best-effort `git pull --ff-only origin main` if a remote is tracked.
4. Ensure `.worktrees/` exists and is git-ignored. Add to `.gitignore` if missing.

### Dispatch loop

Repeat until the ticket queue is empty OR fewer than N tickets are ready (in `--loop`, keep going as new tickets become ready):

1. **Plan the cohort.** Query up to N ready tickets (filters applied). Inspect `files_affected`:
   - If two tickets touch overlapping files → dispatch them **sequentially**, not in parallel.
   - If a ticket has empty `files_affected` → treat as potentially touching anything; do not parallelize with other unknowns. Run solo.
   - Prefer parallelizing tickets in different feature folders.
2. **Claim the cohort** — one atomic UPDATE per ticket using the claim SQL above, with distinct `assigned_to` values: `odin-1`, `odin-2`, …
3. **For each claimed ticket:**
   - `git worktree add .worktrees/<id-lower> -b ticket/<id-lower> main`
   - Spawn an `@odin` sub-agent (via the Agent tool) with:
     - **Working directory:** `.worktrees/<id-lower>`
     - **Mode:** the session mode
     - **Mandate:** Run the full Odin pipeline through Phase 4 QA handoff. Commit on the ticket branch only if the per-ticket commit policy says so. **Do not merge. Do not push. Do not ship.**
   - Track the sub-agent handle, ticket id, and worktree path.
4. **Failure surfacing.** If any sub-Odin emits `STATUS: BLOCKED` or HALTs at the elite gate, surface it immediately to the user — do not wait for the cohort to finish. Sibling tickets continue. Mark the ticket `blocked_reason` (status stays `active`), leave the worktree intact for human follow-up.
5. **Wait** for the cohort to complete (or fail), apply per-ticket commit policy as each finishes, then go to step 1.

### Per-ticket commit policy

Applied after each ticket reaches QA handoff, on the ticket's branch (or worktree's branch).

**Smart commit message** is derived from:
- `<ticket-id>: <title>` as the subject.
- Body: 1–3 lines summarizing the diff (changed files grouped by feature area).
- Trailer: `Refs: <ticket-id>`.

**Interactive mode**
- Present the smart commit message and prompt: `commit / edit message / skip`. Default `commit`.
- `commit` → `git -C <worktree> add -A && git -C <worktree> commit -m "<message>"`.
- `edit message` → open the message for the user to edit, then commit.
- `skip` → leave the branch uncommitted; warn that next dispatch tick will pre-flight-fail unless the user resolves.

**Headless mode**
- Use the answer captured at run start.
- `Y` → auto-commit with the smart message, no prompt.
- `n` → leave every ticket's branch uncommitted. End-of-run summary lists them clearly.

**Push and `status='complete'` are user-triggered Phase 5 only — never automatic, even in headless.**

### Merge-back (only on user ship)

The dispatcher does **not** merge during the run. When the user triggers Phase 5 ("ship it" / "ship TUM-42" / "ship all"):

1. `git -C <repo-root> checkout main`
2. `git -C <repo-root> pull --ff-only` (best-effort)
3. `git -C <repo-root> merge --no-ff ticket/<id-lower> -m "Merge ticket/<id-lower>"`
4. **If conflicts:** the dispatcher resolves directly (sub-agents lack sibling context). Ask the user before resolving anything non-trivial.
5. After successful merge, hand off to `@odin` Phase 5 to update the ticket: `status='complete'`, `completed_at=now()`, clear `assigned_to`, `branch_name`, `blocked_reason`, in-progress labels.
6. `git worktree remove .worktrees/<id-lower>` then `git branch -d ticket/<id-lower>`.
7. Push only with explicit user confirmation (matches Odin's existing rule).

### End-of-run cleanup

When the queue is empty (or `--loop` exits):

1. `git worktree list` — any leftover paths get `git worktree remove`'d only if their ticket is `complete`. Tickets in `qa` keep their worktrees so the user can review and ship.
2. Final summary:
   - Completed (shipped this session)
   - In QA (awaiting user ship): list with branch + worktree path
   - Blocked: list with reason
   - Halted (elite-gate / BLOCKED): list with last-known status
   - Newly-unblocked downstream tickets

**Clean-state acceptance test for shipped tickets:** their branch and worktree are gone. Tickets in `qa` retain both intentionally.

## Behavior: `list`

```sql
SELECT t.id, t.title, t.category, t.priority, t.tier, t.effort_estimate,
  t.assigned_to, t.depends_on,
  CASE
    WHEN array_length(t.depends_on, 1) IS NULL THEN 'ready'
    WHEN NOT EXISTS (
      SELECT 1 FROM unnest(t.depends_on) AS dep_id
      WHERE dep_id NOT IN (SELECT d.id FROM public.tickets d WHERE d.status = 'complete')
    ) THEN 'ready'
    ELSE 'blocked'
  END AS dep_status
FROM public.tickets t
WHERE t.status = 'backlog'
ORDER BY
  CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
  t.tier ASC NULLS LAST,
  t.created_at ASC;
```

Show the table with `dep_status`. Ask which id to pick up. Warn on blocked selections. Pre-flight clean-tree, then claim via the atomic query above.

## Behavior: `--dry-run`

1. Run the same ready-queue query the dispatcher would.
2. If `--orchestrate N`, also compute the parallelization plan (collision groups based on `files_affected`).
3. Print:
   - Tickets that would be claimed, in claim order.
   - Cohort grouping (which run in parallel, which serialize, why).
   - Filters applied.
4. Do not claim, branch, or modify anything. `git status` and `git worktree list` are unchanged after.

## Operations

### Pick up a specific ticket

```sql
UPDATE public.tickets
SET status = 'active',
    assigned_to = 'odin',
    assigned_at = now(),
    branch_name = 'ticket/' || lower(id),
    labels = array_append(array_remove(labels, 'Exec: Active'), 'Exec: Active')
WHERE id = '<id>'
  AND status = 'backlog'
RETURNING id, title;
```

The `AND status = 'backlog'` guard prevents double-assignment.

### Append progress / notes
Write to `ticket_comments` (do **not** mutate the description):

```sql
INSERT INTO public.ticket_comments (ticket_id, body)
VALUES ('<id>', '<markdown body>');
```

### Update files_affected mid-flight

```sql
UPDATE public.tickets
SET files_affected = ARRAY[<file1>, <file2>]::text[]
WHERE id = '<id>';
```

### Mark blocked
Status stays `active`; record the reason:

```sql
UPDATE public.tickets
SET blocked_reason = '<why it''s blocked>'
WHERE id = '<id>';
```

### Unblock

```sql
UPDATE public.tickets
SET blocked_reason = NULL
WHERE id = '<id>';
```

### Cancel

```sql
UPDATE public.tickets
SET status = 'backlog',
    assigned_to = NULL,
    assigned_at = NULL,
    branch_name = NULL,
    blocked_reason = NULL,
    labels = array_remove(labels, 'Exec: Active')
WHERE id = '<id>';

INSERT INTO public.ticket_comments (ticket_id, body)
VALUES ('<id>', '## Cancelled\n<reason>');
```

### My in-flight tickets

```sql
SELECT id, title, branch_name, blocked_reason, assigned_at
FROM public.tickets
WHERE assigned_to LIKE 'odin%' AND status IN ('active','qa');
```

### Dashboard summary

```sql
SELECT status, count(*) FROM public.tickets GROUP BY status ORDER BY status;
```

### View ticket detail

```sql
SELECT * FROM public.tickets WHERE id = '<id>';
SELECT body, created_at FROM public.ticket_comments WHERE ticket_id = '<id>' ORDER BY created_at;
```

## Multi-agent rules

1. **Never ask to claim** — the user invoked the skill, that's the authorization.
2. **Clean tree pre-flight** — always. Recommend commit over stash.
3. **One worktree per in-flight ticket** in orchestrate mode. Never share a working directory between sub-agents.
4. **Inspect `files_affected` before parallelizing** — serialize overlapping or unknown-set tickets.
5. **Sub-agents are `@odin` instances.** They run their own quality gates (code review, data, security) and stop at QA handoff. They do not merge, push, or ship.
6. **Dispatcher owns merges** — only on user-triggered ship. Conflicts are resolved by the dispatcher with user input on anything non-trivial.
7. **Worktrees stay until ship.** Tickets in `qa` keep their worktree so the user can review the work before shipping.
8. **End-of-run invariant for shipped tickets:** branch deleted, worktree removed. In-QA tickets retain both intentionally.
9. **Headless never auto-pushes and never auto-completes.** Push and `status='complete'` require explicit user trigger every time.
