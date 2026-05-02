# Reusing this harness in a new project

Drop in as-is:

```
CLAUDE.md
.claude/agents/*.md
.claude/rules/ticket-schema.md
.claude/rules/harness-reuse.md
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
