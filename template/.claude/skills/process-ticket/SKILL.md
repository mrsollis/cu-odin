---
name: process-ticket
description: Pick up, dispatch, and report on tickets from the project's Supabase tickets table. Hands each claimed ticket to @odin for execution, supports per-ticket queue runs and worktree-based parallel orchestration.
version: 1.0.0
---

# Process Ticket

Dispatcher / queue runner for the project's `public.tickets` table. The Supabase project id is read from the Supabase MCP server config — there is no per-repo config to fill in. Ticket ids follow the canonical `T-<N>` format assigned by the database (`next_ticket_id()`).

This skill **does not implement work**. Each claimed ticket is handed to [@odin](../../agents/odin.md), which runs the full pipeline (UX → planning + rubric → coder/review loop with elite gate → data gate → security gate → outcome gate → QA handoff). The dispatcher owns claim, branching, worktree lifecycle, dependency resolution, parallel collision avoidance, and end-of-run cleanup.

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

## Pre-flight 0: capability check

**Before claiming any ticket, confirm the dispatcher can actually deliver it.** The claim is a commitment; never make it before knowing the pipeline can run.

- **Single-agent path** (`/process-ticket`, `next`, `--loop`, `<id>`, `list` selection): you (parent Claude) will *become* Odin inline and fan out to specialists. Confirm the `Agent`/`Task` tool is in your tool list. At top-level Claude this is always true; if it isn't, you are running as a subagent — abort with `STATUS: HARNESS_ERROR — process-ticket invoked without dispatch capability` and do **not** mutate any ticket state.
- **Orchestrate path** (`--orchestrate N`): the dispatcher will spawn N separate `claude` processes (one per worktree). Probe spawn capability *actively* before any state mutation — `which claude` is necessary but not sufficient, because the harness's permission layer (e.g., `bypassPermissions=deny`) can deny the spawn after the binary resolves. Run a short non-interactive smoke spawn in a temp directory (e.g., `claude --print "ping"` with a few-second timeout) and confirm exit-success. If the probe fails, **do not abort blindly** — first apply the cohort-of-one shortcut (see "Cohort-of-one shortcut" in the dispatch loop). Only abort cleanly (no claim, no branch, no state writes) when the cohort-of-one shortcut does not apply.

If pre-flight 0 fails *and* the cohort-of-one shortcut does not apply, exit immediately with the abort message. Do not fall through to the clean-tree check or the claim.

## Pre-flight 1: clean working tree

**The working tree MUST be clean.** Uncommitted changes would muddy ticket diffs.

1. Run `git status --porcelain` in the repo root.
2. If output is non-empty:
   - Show the user the modified/untracked files.
   - Recommend committing first: "I recommend committing these so the ticket branch has a clean starting point. Commit, stash, or abort?"
   - Default `commit`. Do not auto-commit without confirmation.
3. Once clean, proceed with claim.

For `--orchestrate`, the main working tree stays on `main`; worktrees branch off `main` at pre-flight time, so the check still applies once.

## Claim sequencing

Order is load-bearing — each step can still abort cleanly without leaving residue:

1. Pre-flight 0 — capability check (above).
2. Pre-flight 1 — clean working tree (above).
3. Branch / worktree feasibility — verify `ticket/<id-lower>` is free (and, for orchestrate, that `.worktrees/<id-lower>` does not already exist).
4. **Atomic claim SQL** — only after 1–3 pass.
5. Branch creation (`git checkout -b ...` or `git worktree add ...`).
6. Hand to Odin (single-agent: become Odin inline; orchestrate: spawn `claude` process).

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

5. **Become Odin inline.** Read [.claude/agents/odin.md](../../agents/odin.md) and run the pipeline yourself in this same top-level session, fanning out to specialist subagents (`tdd`, `coder-*`, `code-review`, `data-architect`, `security-review`, `ux-design`). **Do not** invoke `Agent(subagent_type=odin)` — sub-agents do not inherit the `Agent`/`Task` tool, so a sub-Odin cannot dispatch specialists and the pipeline dead-ends. Carry into the run:
   - The ticket id and full description.
   - The session mode (interactive/headless).
   - A note to yourself: "Ticket already claimed; branch already created. Skip ticket-creation steps. Run through QA handoff (Phase 4). Do not ship — the dispatcher manages commit and the user controls Phase 5."

6. **Wait for `@odin`** to reach Phase 4 (status → `qa`, `metadata.qa.checklist` written) — or to halt (BLOCKED / elite-gate halt).

7. **Per-ticket commit policy** (see below).

8. **`--loop` only:** return to step 3 until no ready ticket remains.

9. **End-of-run summary** (always, both modes): tickets in `qa`, blocked, halted, branches present, newly-unblocked downstream tickets.

## Behavior: `--orchestrate N` (multi-process path)

The dispatcher orchestrates up to **N parallel `claude` processes**, each in its own git worktree with its own top-level Claude Code session. Each process becomes Odin via `CLAUDE.md`'s default operating mode and retains full `Agent`/`Task` fan-out for the specialist subagents (`tdd`, `coder-*`, `code-review`, `data-architect`, `security-review`). Each sub-process owns its branch; the dispatcher (this session) owns merges to `main`, and merges only happen when the user triggers Phase 5 ship.

> **Why processes, not subagents.** A Claude Code subagent does not inherit the `Agent`/`Task` tool. If the dispatcher tried `Agent(subagent_type=odin)`, the sub-Odin could not dispatch any specialists and the whole pipeline would dead-end. Separate top-level processes are the only way to get Odin-level fan-out across multiple tickets in parallel.

### Setup (once per run)

1. Pre-flight 0 — capability check (above): confirm `claude` CLI is invocable.
2. Pre-flight 1 — clean tree (above).
3. Mode check + auto-commit prompt (headless only).
4. Best-effort `git pull --ff-only origin main` if a remote is tracked.
5. Ensure `.worktrees/` exists and is git-ignored. Add to `.gitignore` if missing.

### Dispatch loop

Repeat until the ticket queue is empty OR fewer than N tickets are ready (in `--loop`, keep going as new tickets become ready):

1. **Plan the cohort.** Query up to N ready tickets (filters applied). Cohort size is bounded only by `N`, ticket-readiness, and the cohort-of-one shortcut below. **Do not serialize on `files_affected` overlap** — sub-processes work on isolated worktrees, and the dispatcher resolves cross-ticket conflicts at merge-back (see "Merge-back" below). For any ticket with empty `files_affected`, optionally infer likely scope from the ticket's title + description + category + labels and persist via `Update files_affected mid-flight` (below) to give the merge step better signal — but inference is **not** a gate on parallelism.

   **Cohort-of-one shortcut.** Before declaring orchestrate-path failure for any reason (capability block from pre-flight 0, dependency filtering leaving only one ready ticket), check the would-be cohort size. If it is 1, do not spawn a sub-process. Instead, run that single ticket via the single-agent inline path (see "Behavior: no-args / `next` / `--loop`" above) in this same session and announce the fallback explicitly: `Fallback: orchestrate → inline (cohort=1)`. Then continue the `--loop` normally. This silently resolves the common case where capability is denied but parallelism would have been zero anyway — never stop and ask the user which path to take, the prime directive forbids it.
2. **Claim the cohort** — one atomic UPDATE per ticket using the claim SQL above, with distinct `assigned_to` values: `odin-1`, `odin-2`, …
3. **For each claimed ticket, spawn a `claude` process:**
   - `git worktree add .worktrees/<id-lower> -b ticket/<id-lower> main`
   - Launch a non-interactive Claude Code process pinned to the worktree, e.g.:
     ```
     claude --cwd .worktrees/<id-lower> -p "<mandate prompt>" \
       --output-format stream-json > .worktrees/<id-lower>/.odin.log 2>&1 &
     ```
     (Use whichever headless invocation the host harness supports. The shape that matters: a fresh top-level Claude session whose working directory is the worktree.)
   - **Mandate prompt** carries:
     - Ticket id and full description.
     - Session mode (`interactive` or `headless`).
     - "You are running as a sub-process under `/process-ticket --orchestrate`. Become Odin (read `.claude/agents/odin.md`) and run the full pipeline through Phase 4 QA handoff. Commit on the ticket branch only if the per-ticket commit policy says so. **Do not merge. Do not push. Do not ship.** Write status to `.odin-status.json` in this worktree at every phase boundary."
   - Track per process: `{ticket_id, worktree, pid, status_path: ".worktrees/<id-lower>/.odin-status.json", last_heartbeat}`.
4. **Status protocol.** Each sub-process writes `.odin-status.json` at every phase boundary. The dispatcher polls these files instead of streaming stdout — keeps the dispatcher's own context tiny.
   ```json
   {
     "ticket_id": "T-42",
     "phase": "phase-2",
     "status": "running",         // running | qa | blocked | halted | harness_error
     "summary": "Track 1 iteration 1/2 in flight",
     "blocked_reason": null,
     "last_update": "2026-04-30T18:22:01Z"
   }
   ```
   Odin (in the sub-process) is responsible for keeping this file fresh; the dispatcher treats a stale heartbeat (no update for >30 minutes during active phases) as a likely process crash.
5. **Failure surfacing.** Surface immediately to the user (do not wait for the cohort) when a sub-process status flips to:
   - `blocked` — work-block. Mark `blocked_reason` on the ticket (status stays `active`), leave the worktree intact for human follow-up. See "Mark blocked" below.
   - `halted` — elite-gate halt or other deliberate halt. Same treatment as `blocked`.
   - `harness_error` or stale-heartbeat / process crash — **harness halt**, see "Harness halt vs. work block" below. Unclaim the ticket cleanly so it returns to the queue uncontaminated.
6. **Wait** for the cohort to complete (or fail), apply per-ticket commit policy as each finishes, then go to step 1.

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

The dispatcher does **not** merge during the run. Cross-ticket file overlap is resolved here, not by serializing the cohort. When the user triggers Phase 5 ("ship it" / "ship T-42" / "ship all"):

1. **Determine merge order.** Group ticket branches by file overlap (declared or inferred `files_affected`). Within an overlap group, merge in claim order (FIFO) so earlier tickets become the rebase base for later ones. Across non-overlapping groups the order does not matter.
2. **For each ticket branch, in order:**
   1. `git -C <repo-root> checkout main && git -C <repo-root> pull --ff-only` (best-effort).
   2. **Pre-rebase the ticket branch onto current main** in its worktree: `git -C .worktrees/<id-lower> rebase main`. This surfaces conflicts in the worktree where the sub-Odin's context still exists — not after a half-finished merge into `main`.
   3. **Auto-resolve disjoint-hunk conflicts.** If conflicts are limited to non-overlapping line ranges within the same file (no overlapping hunks, no same-symbol redefinition, no delete-vs-modify), apply both sides via a clean three-way merge. The dispatcher only stitches; it does not invent new code.
   4. **Escalate semantic conflicts to the user.** Overlapping hunks, the same symbol redefined two ways, deleted-vs-modified files, lock-file / generated-file divergence — present the conflict block plus both ticket descriptions plus a recommended resolution. Do not auto-pick a side.
   5. **Re-run the sub-Odin's quality gates in the rebased worktree** (`pnpm test` / `flutter test` / etc., per stack detection in CLAUDE.md). A passing rebased branch then merges into `main` with `git -C <repo-root> merge --no-ff ticket/<id-lower>`. A failing rebased branch routes back to the ticket's `coder-*` agent for one capped fix-up round before re-attempting merge.
   6. After a successful merge, hand off to `@odin` Phase 5 to update the ticket: `status='complete'`, `completed_at=now()`, clear `assigned_to`, `branch_name`, `blocked_reason`, in-progress labels. Then `git worktree remove .worktrees/<id-lower>` and `git branch -d ticket/<id-lower>`.
3. **Locked-tests integrity across merges.** When a later ticket's rebase touches a file an earlier-merged ticket locked in `metadata.locked_tests`, the dispatcher recomputes the SHA-256 hashes after rebase and **before** running gates. Drift means a later ticket weakened an earlier ticket's contract — escalate to the user, do not auto-merge. The user decides whether the change is an additive lock-update or a contract weakening.
4. Push only with explicit user confirmation (matches Odin's existing rule).

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
2. If `--orchestrate N`, also compute the merge-overlap plan (overlap groups based on declared/inferred `files_affected`) — used for merge ordering, not for serializing the cohort.
3. Print:
   - Tickets that would be claimed, in claim order.
   - Cohort: all ready tickets up to `N` run in parallel.
   - Merge-overlap groups: which tickets share files and will therefore merge in FIFO order at ship.
   - Whether the cohort-of-one shortcut would apply (capability block + cohort=1).
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
Append a comment object to `metadata.comments` (do **not** mutate the description). One element per note. Schema for each element: `{ author, when, body }` — `author` is the agent/role posting (e.g. `odin`, `coder-web`, `tdd`, `data-architect`, `dispatcher`).

```sql
UPDATE public.tickets
SET metadata = jsonb_set(
  metadata,
  '{comments}',
  COALESCE(metadata->'comments', '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'author', '<agent-or-role>',
      'when', to_jsonb(now()),
      'body', '<markdown body>'
    )
  ),
  true
)
WHERE id = '<id>';
```

Use this only when context genuinely needs to be shared between agents or with a future session. Most run state already lives in `metadata.locked_tests`, `metadata.rubric`, `metadata.qa`, `metadata.outcome`, and `metadata.telemetry`.

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

### Harness halt vs. work block

Two different failure shapes; treat them differently.

**Work-block (semantic):** the work itself can't proceed without human input — locked-test disputed, missing requirement, conflicting constraint, security finding the coder can't satisfy. Use the standard "Mark blocked" path: ticket stays `active`, `blocked_reason` is set, branch and worktree are kept for follow-up. Same as today.

**Harness halt:** the ticket never got a real run because the harness itself failed — sub-process crashed, sub-Odin emitted `STATUS: HARNESS_ERROR`, status file is stale past the threshold, `claude` CLI couldn't launch. The pipeline made no real progress, so the ticket should return to the queue clean. Unclaim and clean up:

```sql
UPDATE public.tickets
SET status = 'backlog',
    assigned_to = NULL,
    assigned_at = NULL,
    branch_name = NULL,
    blocked_reason = NULL,
    labels = array_remove(labels, 'Exec: Active'),
    metadata = jsonb_set(
      metadata,
      '{telemetry,harness_halts}',
      COALESCE(metadata->'telemetry'->'harness_halts', '[]'::jsonb) || jsonb_build_array(
        jsonb_build_object(
          'when', to_jsonb(now()),
          'cause', '<short cause: harness_error | crash | stale_heartbeat | cli_unavailable>',
          'detail', '<one-line context>',
          'worktree', '<worktree path or null>'
        )
      ),
      true
    )
WHERE id = '<id>';
```

Then: `git worktree remove --force .worktrees/<id-lower>` (if it exists), `git branch -D ticket/<id-lower>` (if no commits), and report the halt to the user with the cause. The ticket returns to `backlog` and any sibling cohort members continue.

The `metadata.telemetry.harness_halts` array preserves the audit trail — repeated harness halts on the same ticket are a signal the harness is misconfigured, not the work.

### Cancel

```sql
UPDATE public.tickets
SET status = 'backlog',
    assigned_to = NULL,
    assigned_at = NULL,
    branch_name = NULL,
    blocked_reason = NULL,
    labels = array_remove(labels, 'Exec: Active'),
    metadata = metadata || jsonb_build_object(
      'cancellation', jsonb_build_object('reason', '<why>', 'when', to_jsonb(now()))
    )
WHERE id = '<id>';
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
-- Inspect orchestrator-reserved metadata sections:
SELECT metadata->'outcome'      AS outcome,
       metadata->'telemetry'    AS telemetry,
       metadata->'qa'           AS qa,
       metadata->'rubric'       AS rubric,
       metadata->'locked_tests' AS locked_tests,
       metadata->'comments'     AS comments
FROM public.tickets WHERE id = '<id>';
```

## Multi-process rules

1. **Never ask to claim** — the user invoked the skill, that's the authorization.
2. **Capability pre-flight, then clean tree pre-flight** — in that order, always. Abort before any state mutation if either fails.
3. **One worktree per in-flight ticket** in orchestrate mode. Never share a working directory between sub-processes.
4. **Do not serialize on file overlap.** Sub-processes work in isolated worktrees and the dispatcher resolves cross-ticket conflicts at merge-back via rebase + auto-resolve-disjoint-hunks + re-run gates + escalate-semantic-conflicts. `files_affected` is signal for ordering merges, not a gate on parallelism.
5. **Sub-processes are top-level Odin sessions.** Spawn via the `claude` CLI, not via `Agent(subagent_type=odin)`. Each sub-process runs its own quality gates (code review, data, security) and stops at QA handoff. They do not merge, push, or ship.
6. **Dispatcher owns merges** — only on user-triggered ship. Conflicts are resolved by the dispatcher with user input on anything non-trivial.
7. **Worktrees stay until ship.** Tickets in `qa` keep their worktree so the user can review the work before shipping.
8. **Harness halts unclaim cleanly** — ticket back to `backlog`, worktree removed, branch deleted, audit row appended to `metadata.telemetry.harness_halts`. Work-blocks keep the ticket `active` with `blocked_reason` set.
9. **End-of-run invariant for shipped tickets:** branch deleted, worktree removed. In-QA tickets retain both intentionally.
10. **Headless never auto-pushes and never auto-completes.** Push and `status='complete'` require explicit user trigger every time.
