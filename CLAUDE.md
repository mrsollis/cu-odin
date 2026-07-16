# cu-odin

Drop-in Claude Code agent harness. One command installs an opus-led orchestrator (`odin`) and a roster of specialized subagents into any repo.

```sh
npx -y github:mrsollis/cu-odin
```

> Not yet published to the npm registry, so install via the GitHub spec above. Do **not** add `@latest` — for `github:` specs, npm treats the part after `@` as a git ref, and there's no ref called `latest`. To pin to a release, use `github:mrsollis/cu-odin#v0.1.0`.

That's it. The installer asks three quick questions (stub in domain? stub in design-system? overwrite agents?), then drops the harness into your repo. Edit `.claude/rules/domain.md` and `.claude/rules/design-system/*` for your project, and you're running.

## What you get

```
CLAUDE.md
.claude/
├── agents/
│   ├── odin.md                  # orchestrator (opus) — auto-loaded by CLAUDE.md
│   ├── coder-web.md             # Node/TS/Next.js implementer (sonnet)
│   ├── coder-flutter.md         # Dart/Flutter implementer (sonnet)
│   ├── coder-elite.md           # escalation coder (gated; opus → fable)
│   ├── code-review.md           # standard reviewer (sonnet)
│   ├── code-review-elite.md     # escalation reviewer (gated; opus → fable)
│   ├── tdd.md                   # test custodian — writes & locks the test contract (sonnet)
│   ├── tdd-elite.md             # escalation custodian (gated; opus → fable)
│   ├── data-architect.md        # Supabase schema / RLS / data security (sonnet)
│   ├── security-review.md       # OWASP-focused review (opus)
│   └── ux-design.md             # design spec producer (sonnet)
├── rules/
│   ├── domain.md                # PLACEHOLDER — fill in your project brief
│   └── design-system/           # PLACEHOLDER — drop your design system here
└── assets/
    └── ticket-system/           # Supabase ticket-table schema (replaces Linear/Jira)
```

The installer detects `package.json` or `pubspec.yaml` and only copies the coder file you actually need (`coder-web` for web, `coder-flutter` for Flutter, both for fullstack repos).

Stack is auto-detected from the repo: `package.json` → web track, `pubspec.yaml` → Flutter track.

## How odin works

For any non-trivial request, odin runs a multi-phase loop without you needing to invoke it explicitly:

0. **Effort sizing** (up front). Odin gauges the level of work from the ticket itself (`effort_estimate`, `tier`, `category`, `files_affected`, description) and tunes discretionary effort — planning depth, review context, fan-out — so trivial tickets stay cheap in time, compute, and tokens. **Safety gates are never tuned down:** security, data, tdd-invariant, and elite-escalation gates fire on their scope triggers regardless of size — quality, security, and performance are never traded for tokens.
1. **Phase 0 — Design gate** (UI features only). Spawns `ux-design` if no spec exists.
2. **Phase 1 — Planning.** Parallel planning subagents, then synthesis into one plan with parallel execution tracks. Odin authors a flat list of acceptance criteria into `metadata.acceptance_criteria`; this is what `tdd` anchors locked tests to and what `code-review` checks the implementation against. `data-architect` joins as a planner whenever the work touches the data layer. Plan is always posted publicly.
3. **Phase 1.5 — Test contract.** Per-track `tdd` writes failing tests anchored to acceptance criteria, security invariants, and (when relevant) data invariants, then locks the test files by SHA-256 into the ticket's `metadata.locked_tests`. Coders cannot modify locked tests; the reviewer recomputes the hashes every cycle. This is the structural fix to the "AI weakens the failing test instead of fixing the code" failure mode — the implementer literally does not own the contract.
4. **Phase 2 — Coder ↔ reviewer loop** per track, strictly fail-driven. A clean `APPROVED` exits immediately with zero loops. On `NEEDS_REVISION`, odin spawns the coder again with the reviewer's findings, capped at **6 total attempts per track** (2 sonnet, then up to 2 opus elite, then up to 2 fable elite — each escalation rung gated separately). If the failure looks like a contract bug rather than an implementation bug, odin routes to `tdd-elite` first.
5. **Phase 2.5 — Data gate.** One pass of `data-architect` across migrations, RLS, and data-access changes (skipped if the diff has none).
6. **Phase 3 — Security gate.** One pass of `security-review` across all changed files. On findings, odin spawns one targeted coder fix scoped to the security findings, then re-runs `security-review` (not full code-review). The fix counts against the same per-track 6-attempt cap.
7. **Phase 4 — QA handoff.** Ticket → `qa`, writes a QA testing checklist into `metadata.qa.checklist`. On Phase 5 ship, a friendly "what changed" note is saved to `metadata.outcome` (authored by odin from the run transcripts) alongside structured run telemetry in `metadata.telemetry`.
8. **Phase 5 — Ship** (user-triggered only). Commit, then **offer to merge into the default branch** (`--auto-merge` merges without asking, local only; `--push` also pushes; headless merges only with `--auto-merge`), ticket → `complete`.

### Context-light specialist briefs

Odin reads `CLAUDE.md`, `domain.md`, and `design-system/` once at session start, then passes each specialist subagent a slim **task-scoped brief** instead of letting them re-read the corpus. A `coder-web` brief is typically a few hundred tokens of structured context (task scope, acceptance criteria, relevant design rules, locked-tests manifest, stack, ticket id, worktree path) — not the 2,000+ lines specialists used to reload on every spawn. If a specialist needs context the brief doesn't carry, it returns `STATUS: NEEDS_BRIEF_EXPANSION` so odin can re-brief; specialists never read the corpus to fill the gap.

Direct invocations (`@coder-web`, `@code-review`, etc.) still bootstrap fully from `CLAUDE.md` + rules/. The brief shortcut applies only when odin is the dispatcher.

### Headless mode

Include the word `headless` or `bifrost` in your request, or run with the harness's `Auto mode active` signal, to enter unattended operation. **Auto mode = zero operational prompts.** The plan still posts, but the loop proceeds without plan-approval, auto-commits each ticket as it completes, and never stops to ask for confirmation on operational decisions. **Quality, security, and elite-escalation gates still apply** — headless removes workflow checkpoints, not safety checkpoints.

One explicit exception: **a dirty working tree always prompts** (commit / stash / abort) regardless of mode. The user's uncommitted work is sacred, and the dispatcher will never silently abort or auto-clobber it.

### Cohort orchestration (`/process-ticket --orchestrate N`)

For multi-ticket runs, the parent Odin session manages all N tickets in-parallel itself, dispatching specialists via the `Task` tool — one specialist call per ticket per phase, run in parallel where independent. There are no `claude` CLI subprocesses, no nested sub-Odins, and no status-file polling. Every ticket — single or cohort — gets its own fresh git worktree under `.worktrees/<id-lower>/`, branched off a freshly-pulled base, so the diffs don't collide; merges back to the default branch happen at user-triggered Phase 5 ship (offered by default, silent under `--auto-merge`).

## Customization (the only files you need to edit)

### `.claude/rules/domain.md`

Your project brief. What the product is, who it's for, what bar it has to clear, the voice. The agents read this first on every session. The placeholder shipped with cu-odin walks you through what to put where.

### `.claude/rules/design-system/`

Your design system. Convention is one topic per file with numeric prefixes (`00-principles.md`, `01-color.md`, ...). The shipped `README.md` documents the structure and what each file should cover. The `ux-design` agent reads every file before producing a spec; the `coder-*` agents read it before implementing UI.

### `.claude/assets/ticket-system/schema.sql`

Apply this to your Supabase project (or any Postgres) to set up the `tickets` table that replaces Linear/Jira. Per-ticket history (locked-tests manifest, QA checklist, outcome notes, run telemetry, inter-agent comments) lives in the `metadata` jsonb column — there is no separate comments table.

The orchestrator reads/writes tickets via the Supabase MCP tool, so make sure that's wired up in your Claude Code config.

## When to invoke each agent

You usually don't — odin handles routing. But for the rare case you want to call one directly:

| Agent | Direct-invoke when |
|-------|---------------------|
| `@odin` | Same as the default, but explicit. Useful if you've drifted out of orchestrator behavior. |
| `@ux-design` | You want a design spec but no implementation yet. |
| `@tdd` | You want a failing-test contract for the current branch without an implementation. Locks the tests so a later coder can't quietly weaken them. |
| `@coder-web` / `@coder-flutter` | You want implementation only, bypassing planning (rare; usually a mistake). |
| `@code-review` | Review pending changes without implementing fixes. Includes Locked Tests hash check if a manifest exists. |
| `@data-architect` | One-off data-layer audit (schema, RLS, indexes, migrations) on the current branch. |
| `@security-review` | One-off security audit of the current branch. |

The three `*-elite` agents (`coder-elite`, `code-review-elite`, `tdd-elite`) are reserved for odin to spawn during escalation — don't invoke them directly.

## Stack detection

| Stack | Detected by | Coder | Quality gates |
|-------|-------------|-------|----------------|
| Node / TS / Next.js | `package.json` present | `coder-web` | `yarn lint` / `type-check` / `test` / `build` |
| Flutter / Dart | `pubspec.yaml` present | `coder-flutter` | `dart format` / `flutter analyze` / `flutter test` |

If a repo contains both, odin splits work into per-stack sub-tracks.

## Requirements

- Claude Code (any recent version)
- An Anthropic org with standard (30-day) data retention — the elite agents' fable rounds (`*-elite`, attempts 5–6) return API errors on zero-data-retention orgs
- Node 16.7+ (only for the installer)
- For the ticket system: a Supabase project + the Supabase MCP server configured in Claude Code

## Updating the harness in a project

Re-run `npx -y github:mrsollis/cu-odin` to pull in fresh agent definitions. Answer `y` to the `CLAUDE.md` and agents prompts, and hit enter through the rest (defaults to "no" so your `domain.md` and `design-system/*` stay untouched).

## Contributing

Issues and PRs welcome. The agents are markdown — improvements to one usually translate to all repos using the harness, so changes ship via a new package version.

## License

MIT
