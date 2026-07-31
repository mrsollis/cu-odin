# Reusing this harness in a new project

Drop in as-is:

```
CLAUDE.md
.claude/agents/*.md
.claude/rules/ticket-schema.md
.claude/rules/harness-reuse.md
.claude/rules/workflow-defaults.md
.claude/rules/design-system/      # folder structure only — replace contents
.claude/rules/domain.md           # file exists — replace contents
.claude/skills/{add-ticket,process-ticket}/
.claude/assets/ticket-system/
.claude/assets/benchmarks/        # optional — token-cost measurement recipe
```

Then:

1. Write the project-specific [.claude/rules/domain.md](domain.md).
2. Fill in [.claude/rules/design-system/](design-system/).
3. Apply [.claude/assets/ticket-system/schema.sql](../assets/ticket-system/schema.sql) to the project's Supabase.

Nothing else to configure — the Supabase project id lives in the Supabase MCP server config.

## Updating the harness

Re-run `npx -y github:mrsollis/cu-odin`. Answer `y` to the `CLAUDE.md` and agents prompts; defaults preserve your `domain.md` and `design-system/*`.

## Worktree & merge flags (`/process-ticket`)

Every ticket runs in a fresh per-ticket worktree off a freshly-pulled base by default. Adjust with `--no-worktree` (in-place branch, single ticket only), `--branch <name>` (base off a branch other than the detected default), `--auto-merge` (merge into the default branch on ship without prompting — local only), and `--push` (push the default branch after merging). See the [process-ticket skill](../skills/process-ticket/SKILL.md).

## Configuration: thorough mode (backwards compat)

The default pipeline is **conditional** — every gate has an explicit trigger evaluated against planned scope. To force the prior behavior (every gate fires on every ticket), set this in the host repo's `.claude/settings.local.json`:

```json
{
  "env": {
    "CU_ODIN_THOROUGH_MODE": "true"
  }
}
```

When set, odin treats every gate trigger as matched. Use this while validating the conditional pipeline against your repo, or when running a high-stakes ticket where you want every gate regardless of scope.
