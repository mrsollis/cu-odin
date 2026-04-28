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
│   ├── coder-elite.md           # opus escalation coder (gated)
│   ├── code-review.md           # standard reviewer (sonnet)
│   ├── code-review-elite.md     # opus escalation reviewer (gated)
│   ├── tdd.md                   # test custodian — writes & locks the test contract (sonnet)
│   ├── tdd-elite.md             # opus escalation custodian (gated)
│   ├── data-architect.md        # Supabase schema / RLS / data security (sonnet)
│   ├── security-review.md       # OWASP-focused review (sonnet)
│   └── ux-design.md             # design spec producer (sonnet)
├── rules/
│   ├── domain.md                # PLACEHOLDER — fill in your project brief
│   └── design-system/           # PLACEHOLDER — drop your design system here
└── assets/
    └── ticket-system/           # Supabase ticket-table schema (replaces Linear/Jira)
```

Stack is auto-detected from the repo: `package.json` → web track, `pubspec.yaml` → Flutter track.

## How odin works

For any non-trivial request, odin runs a multi-phase loop without you needing to invoke it explicitly:

1. **Phase 0 — Design gate** (UI features only). Spawns `ux-design` if no spec exists.
2. **Phase 1 — Planning.** Parallel planning subagents, then synthesis into one plan with parallel execution tracks. `data-architect` joins as a planner whenever the work touches the data layer. Plan is always posted publicly.
3. **Phase 1.5 — Test contract.** Per-track `tdd` writes failing tests anchored to acceptance criteria, security invariants, and (when relevant) data invariants, then locks the test files by SHA-256 in a ticket comment. Coders cannot modify locked tests; the reviewer recomputes the hashes every cycle. This is the structural fix to the "AI weakens the failing test instead of fixing the code" failure mode — the implementer literally does not own the contract.
4. **Phase 2 — Coder ↔ reviewer loop** per track. Up to 2 sonnet rounds. If still stuck *and* the failure mode is reasoning depth (not spec ambiguity), escalates to the opus elite pair for up to 2 more rounds. Hard cap of 4 total iterations per track. If the failure looks like a contract bug rather than an implementation bug, odin routes to `tdd-elite` first.
5. **Phase 2.5 — Data gate.** One pass of `data-architect` across migrations, RLS, and data-access changes (skipped if the diff has none).
6. **Phase 3 — Security gate.** One pass of `security-review` across all changed files.
7. **Phase 4 — QA handoff.** Ticket → `qa`, posts a QA testing checklist as a ticket comment.
8. **Phase 5 — Ship** (user-triggered only). Commit, push, ticket → `complete`.

### Headless mode

Include the word `headless` or `bifrost` in your request to skip the Phase 1 plan-approval gate. The plan still posts, the loop just proceeds in the same turn. **Quality gates, the elite escalation gate, security review, and the user-triggered ship phase still apply** — headless removes a workflow checkpoint, not the safety checkpoints.

The Claude Code harness's own `Auto mode active` signal also triggers headless.

## Customization (the only files you need to edit)

### `.claude/rules/domain.md`

Your project brief. What the product is, who it's for, what bar it has to clear, the voice. The agents read this first on every session. The placeholder shipped with cu-odin walks you through what to put where.

### `.claude/rules/design-system/`

Your design system. Convention is one topic per file with numeric prefixes (`00-principles.md`, `01-color.md`, ...). The shipped `README.md` documents the structure and what each file should cover. The `ux-design` agent reads every file before producing a spec; the `coder-*` agents read it before implementing UI.

### `.claude/assets/ticket-system/schema.sql`

Apply this to your Supabase project (or any Postgres) to set up the `tickets` and `ticket_comments` tables that replace Linear/Jira. Then seed a suggestions-ledger ticket per the folder's README.

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
| Node / TS / Next.js | `package.json` present | `coder-web` | `pnpm lint` / `type-check` / `test` / `build` |
| Flutter / Dart | `pubspec.yaml` present | `coder-flutter` | `dart format` / `flutter analyze` / `flutter test` |

If a repo contains both, odin splits work into per-stack sub-tracks.

## Requirements

- Claude Code (any recent version)
- Node 16.7+ (only for the installer)
- For the ticket system: a Supabase project + the Supabase MCP server configured in Claude Code

## Updating the harness in a project

Re-run `npx -y github:mrsollis/cu-odin` to pull in fresh agent definitions. Answer `y` to the first prompt (overwrite agents + CLAUDE.md) and hit enter through the other two (defaults to "no" so your `domain.md` and `design-system/*` stay untouched).

## Contributing

Issues and PRs welcome. The agents are markdown — improvements to one usually translate to all repos using the harness, so changes ship via a new package version.

## License

MIT
