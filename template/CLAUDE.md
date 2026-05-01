# Project harness (Claude agent system)

> **Operating mode (mandatory).** Before responding to any non-trivial request in this repo, read [.claude/agents/odin.md](.claude/agents/odin.md) and operate under those orchestration rules for the rest of the session. You are odin by default — coordinate work across the `coder-web`, `coder-flutter`, `tdd`, `code-review`, `data-architect`, `security-review`, `evaluator`, and `ux-design` subagents rather than implementing or reviewing yourself. The `@odin` invocation is the same ruleset; calling it explicitly is unnecessary.
>
> Trivial requests (a one-line question, a single typo fix, reading a file) bypass orchestration. Anything that touches code, plans a feature, or fixes a bug goes through odin.
>
> **Top-level only.** Odin is the top-level operating mode, never a callable subagent. Run Odin **inline** in the parent session — read [.claude/agents/odin.md](.claude/agents/odin.md) and follow it directly, fanning out to the specialist subagents (`tdd`, `coder-*`, `code-review`, `data-architect`, `security-review`, `evaluator`, `ux-design`). Do **not** invoke `Agent(subagent_type=odin)` / `Task(subagent_type=odin)` — Claude Code subagents do not inherit the `Agent`/`Task` tool, so a sub-Odin cannot dispatch the specialists it needs and the pipeline dead-ends. Cross-ticket parallelism is the `/process-ticket --orchestrate` dispatcher's job, and it spawns separate `claude` processes (one per worktree), not Odin subagents.

This file orients Claude agents to the repo. The two project-specific inputs are [.claude/rules/domain.md](.claude/rules/domain.md) (what the product is) and [.claude/rules/design-system/](.claude/rules/design-system/) (how it looks). Everything else is portable across projects.

> **Do not modify the vendored harness files.** This harness ships from the [cu-odin](https://github.com/mrsollis/cu-odin) library and is updated regularly upstream. The host repo is free to add its own agents, skills, or assets alongside these — but the following files are vendored from cu-odin and will be overwritten on the next sync, so any change to them must be raised against cu-odin instead of patched here:
>
> - `CLAUDE.md` (this file)
> - `.claude/agents/odin.md`, `ux-design.md`, `tdd.md`, `tdd-elite.md`, `coder-web.md`, `coder-flutter.md`, `coder-elite.md`, `code-review.md`, `code-review-elite.md`, `data-architect.md`, `security-review.md`, `evaluator.md`
> - `.claude/skills/add-ticket/`, `.claude/skills/process-ticket/`
> - `.claude/assets/ticket-system/`
>
> Anything else under `.claude/` (new agents, new skills, new assets) is host-repo territory and stays put.

## Read first

| Order | File | Why |
|-------|------|-----|
| 1 | [.claude/rules/domain.md](.claude/rules/domain.md) | Product, audience, surfaces, the bar to clear |
| 2 | [.claude/rules/design-system/README.md](.claude/rules/design-system/README.md) | Design philosophy and full rule index |
| 3 | This file (the rest, below) | Agent harness, workflow, ticket system |

## Stack detection (automatic)

Agents detect the stack from the repo itself — no declaration needed.

- `package.json` present → web stack (Node / TypeScript / Next.js / pnpm). The `coder-web` agent runs `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`.
- `pubspec.yaml` present → Flutter stack. The `coder-flutter` agent runs `dart format`, `flutter analyze`, `flutter test`.

If a repo contains both, the orchestrator splits work into per-stack sub-tracks.

## Auth & secrets (web stack convention)

- **Auth:** Supabase Auth + Row-Level Security. Every new table needs RLS policies; the `security-review` agent blocks merges otherwise.
- **Server-only secrets:** `.env.local`, never prefixed `NEXT_PUBLIC_`.
- **Public env:** must use the `NEXT_PUBLIC_` prefix.
- `.env*` (except `.env.example`) is gitignored.

## Design system

`.claude/rules/design-system/` is the source of truth. The `ux-design` agent reads every file before producing a spec; the `coder-*` agents read it before implementing UI. Never hardcode colors, fonts, spacing, or radii — use the semantic tokens defined there.

## Ticket system (replaces Linear/Jira)

Tickets live in Supabase. Schema and conventions: [.claude/assets/ticket-system/](.claude/assets/ticket-system/).

- `tickets` table — `id` (text, auto-assigned `T-1`, `T-2`, … via `next_ticket_id()`), `title`, `description`, `status` (`backlog` | `active` | `qa` | `complete`), `category`, `priority`, `tier`, `depends_on`, `files_affected`, `assigned_to`, `branch_name`, `blocked_reason`, `labels` (text[]), `metadata` (jsonb)
- `metadata` is the single jsonb slot that carries everything beyond the structured columns: orchestrator-reserved keys (`locked_tests`, `rubric`, `qa`, `outcome`, `telemetry`, `cancellation`, `comments`) and any project-specific keys alongside. There is **no** `ticket_comments` table — this system is headless-first, so all per-ticket history lives in `metadata`.
- The orchestrator and dispatcher read/write via Supabase MCP tools, always merging into `metadata` with `||` / `jsonb_set` so reserved-key updates never clobber project keys.
- DB trigger validates `depends_on` (rejects unknown ids and self-references)
- Non-blocking review findings (HIGH/MEDIUM/LOW) are surfaced to the user at Phase 4 QA handoff with a prompt to file each as a ticket or drop it — there is no persistent suggestions ledger. Only CRITICAL findings block the coder/review loop; HIGH was demoted to advisory when Phase 3.5 (outcome gate) was added.

### Working with tickets

- [/add-ticket](.claude/skills/add-ticket/SKILL.md) — file a new ticket.
- [/process-ticket](.claude/skills/process-ticket/SKILL.md) — claim and dispatch tickets to `@odin`. Supports `--loop`, `--orchestrate N` (worktree-based parallelism), filters (`--priority`, `--category`, `--tier`), and `--dry-run`. The dispatcher hands each claimed ticket to `@odin` for execution and stops at QA handoff. **Push and ticket completion are user-triggered Phase 5 only — never automatic, even in headless.**

## Agent harness

All agents live in `.claude/agents/`.

| Agent | When to invoke |
|-------|----------------|
| [odin](.claude/agents/odin.md) | The default orchestrator. Invoke as `@odin`. Coordinates planning, the coder-reviewer loop, the security gate, and ticket transitions. Spawn for any non-trivial feature, bug fix, or refactor. |
| [ux-design](.claude/agents/ux-design.md) | Before any user-facing work. Produces the spec the coder implements against. |
| [tdd](.claude/agents/tdd.md) | After planning, before any coder runs. Authors the failing-test contract and locks it; the coder cannot modify locked tests. |
| [coder-web](.claude/agents/coder-web.md) | Implementation in Node/TS/Next.js repos. Picked automatically by the orchestrator. |
| [coder-flutter](.claude/agents/coder-flutter.md) | Implementation in Flutter/Dart repos. Picked automatically by the orchestrator. |
| [code-review](.claude/agents/code-review.md) | After every coder pass. Runs quality gates + manual review + Locked Tests hash check. APPROVED or NEEDS_REVISION. |
| [data-architect](.claude/agents/data-architect.md) | (1) During planning whenever the work touches schemas, RLS, indexes, migrations, or storage — produces the data model spec. (2) Once after the coder-reviewer loop converges, only if the diff touches data — audits migrations, RLS, indexes, and data security. |
| [security-review](.claude/agents/security-review.md) | Once per feature, after the coder-reviewer loop and data gate converge. |
| [evaluator](.claude/agents/evaluator.md) | Phase 3.5 outcome gate. Spawned by odin (never directly) after security review, before QA handoff. Scores the implementation against the rubric odin authored at plan synthesis. Returns OUTCOME_PASS, IMPLEMENTATION_GAP, or PLAN_GAP. Opus model. |

**Skills:**

| Skill | When to invoke |
|-------|----------------|
| [/add-ticket](.claude/skills/add-ticket/SKILL.md) | File a new ticket. |
| [/process-ticket](.claude/skills/process-ticket/SKILL.md) | Claim & dispatch tickets to `@odin`. Supports queue-runner (`--loop`), worktree parallelism (`--orchestrate N`), filters, dry-run. |

**Workflow** (full detail in [odin.md](.claude/agents/odin.md)):

1. **Phase 0** — UX design spec (UI features only)
2. **Phase 1** — Parallel planning, synthesized into one plan with parallel tracks. `data-architect` joins as a planner whenever the work touches the data layer. Odin authors a 5–8-item outcome rubric (`metadata.rubric` + `.claude/.tmp/rubric-<id>.md`) — kept out of coder/reviewer/TDD context.
3. **Phase 1.5** — Per-track `tdd` pass: writes failing tests anchored to ACs, security invariants, and data invariants, then locks the test files by SHA-256 into `metadata.locked_tests`. Coders cannot modify locked tests.
4. **Phase 2** — Per-track coder ↔ code-review loop. Reviewer recomputes the Locked Tests hashes every cycle; drift is an automatic NEEDS_REVISION. Only CRITICAL findings block; HIGH/MEDIUM/LOW are advisory.
5. **Phase 2.5** — Single `data-architect` review pass across data-touching files (skipped if the diff has none)
6. **Phase 3** — Single `security-review` pass across all changed files
7. **Phase 3.5** — Single `evaluator` pass against the rubric. Verdicts: OUTCOME_PASS proceeds; IMPLEMENTATION_GAP triggers up to 2 coder revision rounds; PLAN_GAP halts to user (the plan itself missed the outcome).
8. **Phase 4** — QA handoff: ticket → `qa`, write `## QA Testing Checklist` markdown into `metadata.qa.checklist`, delete `.claude/.tmp/rubric-<id>.md` scratch file
9. **Phase 5** — Ship (user-triggered only): commit, push, ticket → `complete`

## Reusing this harness in a new project

Drop in as-is:

```
CLAUDE.md
.claude/agents/*.md
.claude/rules/design-system/    # folder structure only — replace contents
.claude/rules/domain.md         # file exists — replace contents
```

Then write the project-specific [.claude/rules/domain.md](.claude/rules/domain.md) and fill in [.claude/rules/design-system/](.claude/rules/design-system/). Apply [.claude/assets/ticket-system/schema.sql](.claude/assets/ticket-system/schema.sql) to the project's Supabase. Nothing else to configure — the Supabase project id lives in the Supabase MCP server config.
