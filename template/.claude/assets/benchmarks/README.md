# Benchmark recipe — measure the conditional pipeline's token delta

Use this to verify the conditional pipeline reduces tokens vs. the prior unconditional pipeline on **your** repo. Run on a non-main branch; do not ship from a benchmarking session.

## What you measure

Per ticket: input + output tokens consumed by the orchestrator session, broken down by gate fired. Compare conditional default (`CU_ODIN_THOROUGH_MODE=false`) against thorough mode (`CU_ODIN_THOROUGH_MODE=true`) on the **same** ticket.

## Setup

1. Pick 4 tickets from your backlog representing the standard scope distribution:
   - **B1 — Trivial.** Typo, label change, single-file copy edit. No security/data scope.
   - **B2 — Small UI.** New component or screen change. Touches design system, no data layer.
   - **B3 — Sensitive refactor.** Encryption, auth, session, or RLS-adjacent code. No new schema.
   - **B4 — Full pipeline.** New table + RLS + matching UI. All gates fire.
2. Stash the conditional pipeline you're measuring on its own branch; keep `main` as the reference for thorough-mode runs (or just toggle the env var).
3. Make sure `metadata.telemetry` is being written on Phase-5 ship — that's the per-run record you'll diff against.

## Run

For each benchmark ticket:

1. Reset working tree to a clean baseline.
2. Run the conditional pipeline:
   ```sh
   /process-ticket --headless <ticket-id>
   ```
   When odin posts the activated gate set, capture it. Let the run go to QA handoff. Do **not** ship — discard or stash the changes.
3. Reset working tree.
4. Re-run with thorough mode:
   ```sh
   CU_ODIN_THOROUGH_MODE=true /process-ticket --headless <ticket-id>
   ```
   Same: stop at QA handoff, discard.
5. From each run, record:
   - Total input tokens (Claude Code session UI shows it; or sum from `/cost`)
   - Total output tokens
   - Number of `Task` dispatches
   - Activated gate set (conditional only — thorough fires all of them by definition)
   - Wall-clock duration

## Report shape

```
| Ticket | Mode        | Input tokens | Output tokens | Dispatches | Duration | Gates fired                                        |
|--------|-------------|--------------|---------------|------------|----------|----------------------------------------------------|
| B1     | conditional | …            | …             | 1          | …        | none                                               |
| B1     | thorough    | …            | …             | 8–13       | …        | ux/multi-plan/tdd/sep-ctx/data-A/data-B/security/  |
| B2     | conditional | …            | …             | 2–3        | …        | ux-design                                          |
| B2     | thorough    | …            | …             | 8–13       | …        | all                                                |
| B3     | conditional | …            | …             | 4–6        | …        | tdd, security-review                               |
| B3     | thorough    | …            | …             | 8–13       | …        | all                                                |
| B4     | conditional | …            | …             | 12–14      | …        | all                                                |
| B4     | thorough    | …            | …             | 12–14      | …        | all                                                |

| Ticket | Token Δ (input + output) | Ratio (conditional / thorough) |
|--------|--------------------------|--------------------------------|
| B1     | -X                       | ~0.10                          |
| B2     | -X                       | ~0.20                          |
| B3     | -X                       | ~0.50                          |
| B4     | -X                       | ~0.95                          |
```

## Targets

| Class | Target ratio (conditional / thorough) |
|-------|---------------------------------------|
| B1 (trivial) | ≤0.10 — about 10× cheaper |
| B2 (small UI) | ≤0.25 — about 4–5× cheaper |
| B3 (sensitive refactor) | ≤0.55 — about 2× cheaper |
| B4 (full pipeline) | 0.85–1.10 — within ~10% (gate set is the same) |

If your numbers diverge significantly from these, file an issue against [cu-odin](https://github.com/mrsollis/cu-odin) with the gate set and dispatch counts — the trigger table likely needs tuning for your repo's scope distribution.

## Notes

- The conditional pipeline reads `CLAUDE.md`, `domain.md`, and `design-system/` once per session, then passes adaptive briefs. The thorough-mode delta on B1/B2 comes mostly from *not* spawning gates that wouldn't have found anything anyway — not from a smaller corpus per dispatch.
- Counter-intuitively, full-pipeline runs (B4) should be ~equal in cost. The conditional pipeline is not "always cheaper" — it's "cheaper when scope warrants." That's the whole design.
- If you want a single repeatable number for CI tracking, run B2 weekly and watch the conditional ratio. Drift >0.05 over a month suggests the brief assembly or trigger table is regressing.
