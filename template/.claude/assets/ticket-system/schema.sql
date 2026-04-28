-- Telos-style ticket system. Portable schema used by the orchestration agent
-- (.claude/agents/orchestration) to track work items across any repo.
--
-- Usage:
--   1. Create a Supabase project (or any Postgres database) for the repo.
--   2. Copy this file into the repo's migrations directory, or run it directly:
--        psql $DATABASE_URL -f schema.sql
--   3. Ticket id prefix is per-repo (e.g. TUM- for Telos). Set the prefix in
--      the orchestration agent's config / project CLAUDE.md.

create type ticket_status as enum ('backlog', 'active', 'qa', 'complete');

create table tickets (
  id           text primary key,                       -- human-readable, e.g. 'TUM-123'
  title        text not null,
  description  text not null default '',
  status       ticket_status not null default 'backlog',
  labels       text[] not null default '{}',           -- e.g. {'Exec: Active','QA: Testing'}
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index tickets_status_idx on tickets (status);
create index tickets_labels_idx on tickets using gin (labels);

create table ticket_comments (
  id          bigint generated always as identity primary key,
  ticket_id   text not null references tickets(id) on delete cascade,
  body        text not null,
  created_at  timestamptz not null default now()
);

create index ticket_comments_ticket_id_idx on ticket_comments (ticket_id, created_at desc);

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tickets_set_updated_at
before update on tickets
for each row execute function set_updated_at();
