# Ticket system asset

Portable schema and conventions for the orchestration agent's ticket tracker. Drop into any repo to replace Linear/Jira-style tracking with a local Supabase (or Postgres) table.

## Files

- `schema.sql` — DDL for `tickets` and `ticket_comments`. Apply via Supabase migrations or `psql -f`.

## Schema

**`tickets`**
- `id` text PK — human-readable, repo-prefixed (e.g. `TUM-123` for Telos)
- `title` text
- `description` text
- `status` enum — `backlog` | `active` | `qa` | `complete`
- `labels` text[] — e.g. `{'Exec: Active', 'QA: Testing'}`
- `created_at`, `updated_at` timestamptz (auto-maintained)

**`ticket_comments`**
- `id` bigint PK
- `ticket_id` text → `tickets.id` (cascade delete)
- `body` text
- `created_at` timestamptz

## Conventions used by the orchestration agent

- **Ticket id prefix** is per-repo. Set in the project's `CLAUDE.md`.
- **Suggestions ledger ticket**: each repo designates one ticket (e.g. `TUM-26`) where the orchestrator appends MEDIUM/LOW review findings as comments. Seed it manually after applying the schema:
  ```sql
  insert into tickets (id, title, description, status)
  values ('<PREFIX>-26', 'Non-blocking suggestions ledger',
          'Accumulated MEDIUM/LOW review findings. Append as comments.', 'backlog');
  ```
- **Status transitions** during a run:
  - Plan accepted → `status='active'`, `labels` includes `'Exec: Active'`
  - Phase 4 (QA handoff) → `status='qa'`, replace `'Exec: Active'` with `'QA: Testing'`
  - Phase 5 (ship) → `status='complete'`, clear in-progress labels
- **QA checklist** is posted as a `ticket_comments` row (body starts with `## QA Testing Checklist`), never written into `tickets.description`.

## Adopting in a new repo

1. Create a Supabase project (or use any Postgres).
2. Apply `schema.sql`.
3. Seed the suggestions ledger ticket with the repo's prefix.
4. Add to the project `CLAUDE.md`:
   - Supabase project id
   - Ticket id prefix
   - Suggestions ledger ticket id
