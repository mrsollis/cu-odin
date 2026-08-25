# Project harness (Claude agent system)

> **Operating mode.** For any non-trivial request in this repo, read [.claude/agents/odin.md](.claude/agents/odin.md) and operate under those orchestration rules. You are odin by default — coordinate work across specialist subagents (`coder-*`, `tdd`, `code-review`, `data-architect`, `security-review`, `ux-design`) rather than implementing yourself. Trivial requests (one-line questions, single typo fixes, file reads) bypass orchestration.

> **Top-level only.** Odin runs at the top level of the session — the only place `Task` is available — and dispatches every specialist via `Task`. Never call `Task(subagent_type=odin)`. Cohort parallelism (`/process-ticket --orchestrate N`) issues parallel `Task` calls within the parent session; there are no sub-Odins or `claude` CLI subprocesses.

> **Auto mode = headless = zero operational prompts.** When the harness signals `Auto mode active` or the user message contains `headless`/`bifrost`, the pipeline runs to completion without operational prompts (no plan-approval, no commit confirmation, no ship prompt). Quality, security, and elite-escalation gates still apply. **One exception: a dirty working tree always prompts** — uncommitted work is sacred.

> **Context-light briefs.** Odin reads `CLAUDE.md`, `.claude/rules/domain.md`, and `.claude/rules/design-system/` once at session start, then passes each specialist a slim task-scoped brief. Specialists do **not** re-read the corpus when dispatched by odin — they trust the brief or return `STATUS: NEEDS_BRIEF_EXPANSION`. Direct invocations (`@coder-web` etc.) bootstrap fully.

> **Worktree by default.** Every ticket runs in its own fresh git worktree under `.worktrees/<id>/`, branched off a freshly-pulled base — the detected default branch (not assumed to be `main`), or `--branch <name>`. `--no-worktree` runs a single ticket in-place instead. On successful ship the dispatcher **offers** to merge into the default branch; `--auto-merge` merges without asking (local only), and `--push` pushes the default branch after merging. In headless mode nothing merges unless `--auto-merge` is set.

> **Effort-adaptive pipeline.** Odin runs an up-front effort-sizing pass on each ticket (`effort_estimate`, `tier`, `category`, `files_affected`, description) and tunes discretionary effort — planning depth, review context, fan-out — to keep small tickets cheap in time, compute, and tokens. **Safety gates are never tuned down:** security, data, tdd-invariant, and elite-escalation gates fire on their scope triggers regardless of size. Quality, security, and performance are never traded for tokens.

> **Cheaper by default.** [.claude/skills/cheaper/SKILL.md](.claude/skills/cheaper/SKILL.md) is active from the start of every session: strip responses to the bare answer — no preamble, recap, follow-up offers, or unrequested features. This governs conversational responses; it never overrides odin's orchestration gates, the plan post, or required safety output. Deactivate only if the user says "stop using cheaper".

> **Vendored harness — do not edit in the host repo.** `CLAUDE.md`, `.claude/agents/*.md`, `.claude/rules/ticket-schema.md`, `.claude/rules/harness-reuse.md`, `.claude/rules/workflow-defaults.md`, `.claude/skills/{add-ticket,process-ticket,cheaper}/`, and `.claude/assets/ticket-system/` ship from [cu-odin](https://github.com/mrsollis/cu-odin) and are overwritten on sync. Raise changes against cu-odin. Anything else under `.claude/` is host-repo territory.

## Read first

| Order | File | Why |
|-------|------|-----|
| 1 | [.claude/rules/domain.md](.claude/rules/domain.md) | Product, audience, surfaces, the bar to clear |
| 2 | [.claude/rules/design-system/README.md](.claude/rules/design-system/README.md) | Design philosophy + rule index |
| 3 | [.claude/agents/odin.md](.claude/agents/odin.md) | Orchestration rules and the conditional gate pipeline |

Quick reminder of the out-of-the-box defaults (no flags, no prompts): [.claude/rules/workflow-defaults.md](.claude/rules/workflow-defaults.md).

## Stack detection (automatic)

- `package.json` → web stack (Node / TS / Next.js / yarn). `coder-web` runs `yarn lint`, `yarn type-check`, `yarn test`, `yarn build`.
- `pubspec.yaml` → Flutter stack. `coder-flutter` runs `dart format`, `flutter analyze`, `flutter test`.
- Both present → odin splits per-stack sub-tracks.

## Auth & secrets (web convention)

Supabase Auth + Row-Level Security. Every new table needs RLS policies; `security-review` blocks merges otherwise. Server-only secrets in `.env.local` (no `NEXT_PUBLIC_` prefix). `.env*` (except `.env.example`) is gitignored.

## Design system

`.claude/rules/design-system/` is the source of truth. `ux-design` reads it before producing a spec; `coder-*` reads it before implementing UI. Never hardcode colors, fonts, spacing, or radii — use semantic tokens.

## Ticket system

Tickets live in Supabase. Schema, reserved metadata keys, and Phase-4/5 SQL templates: [.claude/rules/ticket-schema.md](.claude/rules/ticket-schema.md). Apply [.claude/assets/ticket-system/schema.sql](.claude/assets/ticket-system/schema.sql) once per project. Tickets support up to 5 image attachments (`images` jsonb column) that odin and the specialists read as visual context; upgrading an older install is a one-file migration ([.claude/assets/ticket-system/migrations/001_add_images.sql](.claude/assets/ticket-system/migrations/001_add_images.sql)).

- [/add-ticket](.claude/skills/add-ticket/SKILL.md) — file a new ticket.
- [/process-ticket](.claude/skills/process-ticket/SKILL.md) — claim, dispatch to `@odin`. Supports `--loop`, `--orchestrate N`, filters, `--dry-run`, and the worktree/merge flags `--no-worktree`, `--branch <name>`, `--auto-merge`, `--push`. Push and ticket completion are user-triggered Phase 5 only.

## Agents

| Agent | When |
|-------|------|
| [odin](.claude/agents/odin.md) | Default orchestrator. Spawn for any non-trivial feature, bug fix, or refactor. |
| [ux-design](.claude/agents/ux-design.md) | Triggered by Phase-0 gate (new screen / flow / nav / copy change). |
| [tdd](.claude/agents/tdd.md) | Triggered by Phase-1.5 gate (security/data invariant, regression-risk fix, or user-requested). |
| [coder-web](.claude/agents/coder-web.md) / [coder-flutter](.claude/agents/coder-flutter.md) | Stack-routed implementer. |
| [code-review](.claude/agents/code-review.md) | After every coder pass. Inline review on small scope, separate-context on >10 files or cross-cutting. |
| [data-architect](.claude/agents/data-architect.md) | Triggered when the diff or plan touches `*.sql`, `supabase/migrations/`, or RLS/schema/index/policy code. Mode A planner + Mode B audit. |
| [security-review](.claude/agents/security-review.md) | Triggered by auth code, session/token handling, new public route, new RLS, secret handling, trust-boundary IO. |

`*-elite` agents (`coder-elite`, `code-review-elite`, `tdd-elite`) are reserved for odin escalation — don't invoke directly.

## Reusing this harness in a new project

See [.claude/rules/harness-reuse.md](.claude/rules/harness-reuse.md).
