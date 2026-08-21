# Workflow defaults — `/process-ticket` + `@odin`

One-page reference for the **out-of-the-box** behavior of the dispatcher and the orchestrator: what happens when you pass no flags and answer no prompts. Full detail lives in [../skills/process-ticket/SKILL.md](../skills/process-ticket/SKILL.md) and [../agents/odin.md](../agents/odin.md); this is the quick reminder.

---

## `/process-ticket` — dispatcher / queue runner

### Claiming
- `/process-ticket`, `next`, `--loop`, `--orchestrate N` → **claim immediately, never ask.** Only `list` prompts you to choose.
- Picks the **top ready ticket**: priority `critical > high > medium > low`, tie-break `tier ASC`, then FIFO (`created_at`). "Ready" = `status='backlog'` **and** every `depends_on` id is `complete`.
- Claim is atomic (`FOR UPDATE SKIP LOCKED`) — parallel dispatch never double-assigns.

### Mode
- **Interactive by default.** Headless only when the message contains `headless` / `bifrost`, or the harness signals `Auto mode active`.
- Interactive → plan-approval gate + per-ticket commit prompt after QA.
- **Always prompts regardless of mode:** a **dirty working tree** (commit / stash / abort; default `commit`). Uncommitted work is never silently clobbered.

### Workspace
- **Fresh per-ticket git worktree by default** at `.worktrees/<id>/`, branched off a **freshly-pulled** base.
- Base = the **detected default branch** (not assumed `main`) unless `--branch <name>` is given. `--branch` changes the *base*, never the *merge target*.
- `--no-worktree` → in-place branch (single ticket only; **ignored under `--orchestrate`**).

### Cohort (`--orchestrate N`)
- `N` defaults to **3**, capped at **5**.
- Runs **in-session** via parallel `Task` dispatches — no `claude` CLI subprocesses, no sub-Odins, no status-file polling.
- **Cohort-of-one shortcut:** if only 1 ticket is ready, falls back to the inline single-ticket path.
- Does **not** serialize on `files_affected` overlap — cross-ticket conflicts resolve at merge-back.

### Where a run stops (default endpoint)
- Default endpoint is **QA handoff (Phase 4)**: claim → run odin → stop. It does **not** ship.
- **Commit:** auto in headless; prompted (default `commit`) in interactive.
- **Push and `status='complete'` are user-triggered Phase 5 only** — never automatic, even in headless, unless explicitly pre-authorized in the invocation.
- **Merge on ship:**
  - Interactive, no flag → **offers** per ticket (default `merge`).
  - `--auto-merge` → merges silently, **local only** (does not push).
  - Headless, no `--auto-merge` → **no merge**; the committed branch + worktree stay for later.
  - `--push` → pushes the default branch **after** a merge. A bare `--auto-merge` stays local.
- **Cleanup:** shipped (`complete`) tickets → branch + worktree removed. Tickets in `qa` **keep** their worktree so you can review before shipping.

---

## `@odin` — orchestrator

### Posture
- Coordinates specialists via `Task`; **never writes, runs, or reviews code itself.** Never `Task(subagent_type=odin)`.
- **Top-level only, fail fast.** If `Task` is absent from odin's tool list, odin is nested (e.g. dispatched via `Task(subagent_type=odin)`) and cannot orchestrate — it emits `STATUS: HARNESS_ERROR` with the "run at the session top level / invoke specialists directly" remediation and halts, rather than attempting to orchestrate and stalling.
- **Blocking, single continuous turn.** Odin awaits every specialist `Task` inline and runs plan → coder → review → security → QA handoff straight through to a terminal state (QA handoff, halt-to-user, or explicit blocker) in **one turn**. It never spawns a specialist as a background child and yields its turn to wait for an async wakeup — "wait for `STATUS: X`" means await the `Task` result in the same turn. Parallel dispatch (planners, per-track tdd, cohort batches) issues all calls in one message and awaits the whole batch before advancing.
- Interactive default: posts the plan + activated gate set and **waits for approval**. Headless: proceeds without operational prompts (safety gates still run).

### Conditional pipeline (the default cost lever)
Every gate has a trigger evaluated against planned scope; **gates fire only on match.** Defaults when no trigger fires:

| Gate | Trigger | Default if no trigger |
|------|---------|----------------------|
| Phase 0 — ux-design | new screen / flow / nav / copy change | **skip** |
| Phase 1 — multi-planner | >2 subsystems, cross-stack, or new public API | **single planner** |
| Phase 1.5 — tdd locked tests | security/data invariant, regression-risk fix, or user request | **skip** — coder writes tests inline, reviewer verifies; no hash lock |
| Phase 2 — separate-context review | scope >10 files or cross-cutting refactor | **inline review** (coder + reviewer share context) |
| Phase 1/2.5 — data-architect | `*.sql`, `supabase/migrations/`, RLS/schema/index/policy edits | **skip** |
| Phase 3 — security-review | auth, session/token, new public route, new RLS, secret handling, trust-boundary IO | **skip** |
| Phase 3.5 — evaluator | ≥3 gates active **and** data + security both fired | **skip** |
| Elite escalation | standard loop fails after 2 attempts **and** three-check passes | **halt to user** |

- Adjust the activated set with one message: `+tdd`, `-security-review`, or approve to proceed.
- **Escape hatch:** `CU_ODIN_THOROUGH_MODE=true` treats every trigger as matched (the prior unconditional behavior).

### Effort sizing (runs first, every ticket)
- Classifies **Trivial / Small / Medium / Large** from `effort_estimate`, `tier`, `category`, `files_affected`, description, and tunes **discretionary** effort only (planning depth, review context, fan-out, model defaults).
- **Trivial default:** skip planners entirely → single coder + inline review.
- **Safety floor:** sizing **never** downgrades a safety gate — security, data, tdd-invariant, and elite gates fire on their triggers regardless of size. When a size boundary is unclear, size **up**.

### Coder ↔ reviewer loop (fail-driven)
- A clean `APPROVED` **exits with zero iterations** — the cap is a ceiling, not a target.
- **6 attempts max per track:** 2 sonnet → up to 2 opus-elite → up to 2 fable-elite. Each escalation rung is gated by a three-check (reasoning-depth failure? findings actually correct? any progress?); any **no** → halt rather than escalate.
- Only **CRITICAL** findings block. HIGH / MEDIUM / LOW are advisory and accumulate for QA handoff.
- Locked tests (when they exist) are off-limits to the coder; the reviewer recomputes SHA-256s every cycle — drift is an automatic CRITICAL.

### Ship (Phase 5 — user-triggered)
- Advisory-findings default at QA: interactive asks which to file as tickets; **auto mode defaults to "skip"** (there is no persistent suggestions ledger).
- `status='complete'` + `metadata.outcome` + `metadata.telemetry` are written in a **single atomic UPDATE**, guarded by a pre-flight assertion and a post-write read-back.
- **Merge is dispatcher-owned, not odin's** — odin never runs `git merge` itself.

### Context discipline (default operating principle)
- Holds: synthesized plan, AC list, gate-set decision, locked-tests pointer, per-phase digests, ticket id, attempt state, advisory findings.
- Does **not** hold: raw subagent transcripts, file bodies, test-output dumps, full diffs. Passes paths and brief slices, never contents.

### Image attachments (default when present)
- A ticket may carry ≤ 5 images (`images` column). When the dispatcher's handoff includes an image manifest, odin **reads them at intake** — before sizing/planning — and routes each into the brief of the specialist it informs (bug shot → coder, mockup → ux-design, data diagram → data-architect). No attachments → nothing changes.

---

## One-line summary

> `/process-ticket` claims the top ready ticket into a fresh worktree, runs odin's **conditional** pipeline (gates fire only on scope match, effort sized up front), and **stops at QA** — commit is auto only in headless; **merge, push, and completion are user-triggered.** A dirty tree always prompts.
