# Project harness (Claude agent system)

> **Operating mode.** For any non-trivial request in this repo, read [.claude/agents/odin.md](.claude/agents/odin.md) and operate under those orchestration rules. You are odin by default — coordinate work across specialist subagents (`coder-*`, `code-review`, `data-architect` / `firebase-architect`, `security-review`, `ux-design`) rather than implementing yourself. Trivial requests (one-line questions, single typo fixes, file reads) bypass orchestration.

> **Top-level only.** Odin runs at the top level of the session — the only place `Task` is available — and dispatches every specialist via `Task`. Never call `Task(subagent_type=odin)`. Cohort parallelism (`/process-ticket --orchestrate N`) issues parallel `Task` calls within the parent session; there are no sub-Odins or `claude` CLI subprocesses.

> **Auto mode = headless = zero operational prompts.** When the harness signals `Auto mode active` or the user message contains `headless`/`bifrost`, the pipeline runs to completion without operational prompts (no plan-approval, no commit confirmation, no ship prompt). Quality, security, and elite-escalation gates still apply. **One exception: a dirty working tree always prompts** — uncommitted work is sacred.

> **Context-light briefs.** Odin reads `CLAUDE.md`, `.claude/rules/domain.md`, and `.claude/rules/design-system/` once at session start, then passes each specialist a slim task-scoped brief. Specialists do **not** re-read the corpus when dispatched by odin — they trust the brief or return `STATUS: NEEDS_BRIEF_EXPANSION`. Direct invocations (`@coder-web` etc.) bootstrap fully.

> **Worktree by default.** Every ticket runs in its own fresh git worktree under `.worktrees/<id>/`, branched off a freshly-pulled base — the detected default branch (not assumed to be `main`), or `--branch <name>`. `--no-worktree` runs a single ticket in-place instead. On successful ship the dispatcher **offers** to merge into the default branch; `--auto-merge` merges without asking (local only), and `--push` pushes the default branch after merging. In headless mode nothing merges unless `--auto-merge` is set.

> **Effort-adaptive pipeline.** Odin runs an up-front effort-sizing pass on each ticket (`effort_estimate`, `tier`, `category`, `files_affected`, description) and tunes discretionary effort — planning depth, review context, fan-out — to keep small tickets cheap in time, compute, and tokens. **Safety gates are never tuned down:** security, data, and elite-escalation gates fire on their scope triggers regardless of size. Quality, security, and performance are never traded for tokens.

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

- `package.json` with `next` (or plain Node) → web stack. `coder-web` runs whichever of `lint`, `typecheck`/`type-check`, `test`, `build` the project's `package.json` actually defines (absent scripts are skipped, never run or "fixed" into existence).
- `package.json` with `react` and no `next` → React SPA stack (Vite / CRA / Rsbuild). `coder-react` runs the same script-driven gates as `coder-web`.
- `pubspec.yaml` → Flutter stack. `coder-flutter` runs `dart format`, `flutter analyze`, `flutter test`.
- Multiple present → odin splits per-stack sub-tracks.

Backend (independent of stack — any combination works):

- `supabase/`, `@supabase/*`, or `supabase_flutter` → Supabase. Data gate: `data-architect`.
- `firebase.json` / `.firebaserc` / `*.rules`, `firebase` / `firebase-admin`, or `firebase_core` / `cloud_firestore` → Firebase (Firestore, Auth, Storage, Realtime Database, Cloud Functions). Data gate: `firebase-architect`.

## Auth & secrets

- **Supabase:** Supabase Auth + Row-Level Security. Every new table needs RLS policies; `security-review` blocks merges otherwise. The anon key is public; the service-role key is server-only.
- **Firebase:** Firebase Auth + Security Rules (Firestore, Storage, Realtime Database). Every new collection/path needs default-deny rules with write validation and emulator rules tests; `firebase-architect` and `security-review` block merges otherwise. The web config is public; `firebase-admin` and service-account credentials live only in Cloud Functions / server code. Rules and indexes are version-controlled files, never console-only edits.
- **Client bundles are public.** `NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*`, and `--dart-define` values ship to users — never put secrets there. Server-only secrets in `.env.local` (Next.js) or Secret Manager (Cloud Functions). `.env*` (except `.env.example`) is gitignored.

## Design system

`.claude/rules/design-system/` is the source of truth. `ux-design` reads it before producing a spec; `coder-*` reads it before implementing UI. Never hardcode colors, fonts, spacing, or radii — use semantic tokens.

## Ticket system

Tickets live in Supabase (regardless of the app's backend — Firebase projects still use a small Supabase project for the tracker). Schema, reserved metadata keys, and Phase-4/5 SQL templates: [.claude/rules/ticket-schema.md](.claude/rules/ticket-schema.md). Apply [.claude/assets/ticket-system/schema.sql](.claude/assets/ticket-system/schema.sql) once per project. Tickets support up to 5 image attachments (`images` jsonb column) that odin and the specialists read as visual context; upgrading an older install is a one-file migration ([.claude/assets/ticket-system/migrations/001_add_images.sql](.claude/assets/ticket-system/migrations/001_add_images.sql)).

- [/add-ticket](.claude/skills/add-ticket/SKILL.md) — file a new ticket.
- [/process-ticket](.claude/skills/process-ticket/SKILL.md) — claim, dispatch to `@odin`. Supports `--loop`, `--orchestrate N`, filters, `--dry-run`, and the worktree/merge flags `--no-worktree`, `--branch <name>`, `--auto-merge`, `--push`. Push and ticket completion are user-triggered Phase 5 only.

## Agents

| Agent | When |
|-------|------|
| [odin](.claude/agents/odin.md) | Default orchestrator. Spawn for any non-trivial feature, bug fix, or refactor. |
| [ux-design](.claude/agents/ux-design.md) | Triggered by Phase-0 gate (new screen / flow / nav / copy change). |
| [coder-web](.claude/agents/coder-web.md) / [coder-react](.claude/agents/coder-react.md) / [coder-flutter](.claude/agents/coder-flutter.md) | Stack-routed implementer (Next.js/Node, React SPA, Flutter). Only the ones for your stack are installed. |
| [code-review](.claude/agents/code-review.md) | After every coder pass. Inline review on small scope, separate-context on >10 files or cross-cutting. |
| [data-architect](.claude/agents/data-architect.md) | Supabase backend. Triggered when the diff or plan touches `*.sql`, `supabase/migrations/`, or RLS/schema/index/policy code. Mode A planner + Mode B audit. |
| [firebase-architect](.claude/agents/firebase-architect.md) | Firebase backend. Triggered when the diff or plan touches `*.rules`, `firestore.indexes.json`, `firebase.json`, `functions/`, or Firestore/RTDB/Storage data shape. Mode A planner + Mode B audit. |
| [security-review](.claude/agents/security-review.md) | Triggered by auth code, session/token handling, new public route, new RLS or Security Rules, custom claims, Cloud Functions endpoints, secret handling, trust-boundary IO. |

`*-elite` agents (`coder-elite`, `code-review-elite`) are reserved for odin escalation — don't invoke directly.

## Reusing this harness in a new project

See [.claude/rules/harness-reuse.md](.claude/rules/harness-reuse.md).
