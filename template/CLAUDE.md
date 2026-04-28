# Project harness (Claude agent system)

> **Operating mode (mandatory).** Before responding to any non-trivial request in this repo, read [.claude/agents/odin.md](.claude/agents/odin.md) and operate under those orchestration rules for the rest of the session. You are odin by default — coordinate work across the `coder-web`, `coder-flutter`, `code-review`, `data-architect`, `security-review`, and `ux-design` subagents rather than implementing or reviewing yourself. The `@odin` invocation is the same ruleset; calling it explicitly is unnecessary.
>
> Trivial requests (a one-line question, a single typo fix, reading a file) bypass orchestration. Anything that touches code, plans a feature, or fixes a bug goes through odin.

This file orients Claude agents to the repo. The two project-specific inputs are [.claude/rules/domain.md](.claude/rules/domain.md) (what the product is) and [.claude/rules/design-system/](.claude/rules/design-system/) (how it looks). Everything else is portable across projects.

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

- `tickets` table — `id` (text, repo-prefixed e.g. `TUM-123`), `title`, `description`, `status` (`backlog` | `active` | `qa` | `complete`), `category`, `priority`, `tier`, `depends_on`, `files_affected`, `assigned_to`, `branch_name`, `blocked_reason`, `labels` (text[])
- `ticket_comments` table — append-only, used for QA checklists and the suggestions ledger
- The orchestrator and dispatcher read/write via Supabase MCP tools
- DB trigger validates `depends_on` (rejects unknown ids and self-references)
- One ticket per repo serves as the **suggestions ledger** — the orchestrator appends MEDIUM/LOW review findings to it as comments. Seed it manually after applying the schema.

**Per-repo config** (set below in this file):
- Supabase project id: _set me_
- Ticket id prefix: _set me, e.g._ `TUM-`
- Suggestions ledger ticket id: _set me, e.g._ `TUM-26`

### Working with tickets

- [/add-ticket](.claude/skills/add-ticket/SKILL.md) — file a new ticket.
- [/process-ticket](.claude/skills/process-ticket/SKILL.md) — claim and dispatch tickets to `@odin`. Supports `--loop`, `--orchestrate N` (worktree-based parallelism), filters (`--priority`, `--category`, `--tier`), and `--dry-run`. The dispatcher hands each claimed ticket to `@odin` for execution and stops at QA handoff. **Push and ticket completion are user-triggered Phase 5 only — never automatic, even in headless.**

## Agent harness

All agents live in `.claude/agents/`.

| Agent | When to invoke |
|-------|----------------|
| [odin](.claude/agents/odin.md) | The default orchestrator. Invoke as `@odin`. Coordinates planning, the coder-reviewer loop, the security gate, and ticket transitions. Spawn for any non-trivial feature, bug fix, or refactor. |
| [ux-design](.claude/agents/ux-design.md) | Before any user-facing work. Produces the spec the coder implements against. |
| [coder-web](.claude/agents/coder-web.md) | Implementation in Node/TS/Next.js repos. Picked automatically by the orchestrator. |
| [coder-flutter](.claude/agents/coder-flutter.md) | Implementation in Flutter/Dart repos. Picked automatically by the orchestrator. |
| [code-review](.claude/agents/code-review.md) | After every coder pass. Runs quality gates + manual review. APPROVED or NEEDS_REVISION. |
| [data-architect](.claude/agents/data-architect.md) | (1) During planning whenever the work touches schemas, RLS, indexes, migrations, or storage — produces the data model spec. (2) Once after the coder-reviewer loop converges, only if the diff touches data — audits migrations, RLS, indexes, and data security. |
| [security-review](.claude/agents/security-review.md) | Once per feature, after the coder-reviewer loop and data gate converge. |

**Skills:**

| Skill | When to invoke |
|-------|----------------|
| [/add-ticket](.claude/skills/add-ticket/SKILL.md) | File a new ticket. |
| [/process-ticket](.claude/skills/process-ticket/SKILL.md) | Claim & dispatch tickets to `@odin`. Supports queue-runner (`--loop`), worktree parallelism (`--orchestrate N`), filters, dry-run. |

**Workflow** (full detail in [odin.md](.claude/agents/odin.md)):

1. **Phase 0** — UX design spec (UI features only)
2. **Phase 1** — Parallel planning, synthesized into one plan with parallel tracks. `data-architect` joins as a planner whenever the work touches the data layer.
3. **Phase 2** — Per-track coder ↔ code-review loop (3-iteration budget per track)
4. **Phase 2.5** — Single `data-architect` review pass across data-touching files (skipped if the diff has none)
5. **Phase 3** — Single `security-review` pass across all changed files
6. **Phase 4** — QA handoff: ticket → `qa`, post `## QA Testing Checklist` as a ticket comment
7. **Phase 5** — Ship (user-triggered only): commit, push, ticket → `complete`

## Reusing this harness in a new project

Drop in as-is:

```
CLAUDE.md
.claude/agents/*.md
.claude/rules/design-system/    # folder structure only — replace contents
.claude/rules/domain.md         # file exists — replace contents
```

Then write the project-specific [.claude/rules/domain.md](.claude/rules/domain.md) and fill in [.claude/rules/design-system/](.claude/rules/design-system/). Apply [.claude/assets/ticket-system/schema.sql](.claude/assets/ticket-system/schema.sql) to the project's Supabase, seed the suggestions ledger ticket, and fill in the per-repo config above (Supabase project id, ticket id prefix, suggestions ledger ticket id). Nothing else to configure.
