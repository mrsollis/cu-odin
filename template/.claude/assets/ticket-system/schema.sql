-- Portable ticket system used by the orchestration agent (@odin) and the
-- /process-ticket dispatcher. Drop into any Postgres / Supabase project.
--
-- Usage:
--   1. Create a Supabase project (or any Postgres database) for the repo.
--   2. Apply this file via Supabase migrations or `psql -f schema.sql`.

create type ticket_status as enum ('backlog', 'active', 'qa', 'complete');

create sequence tickets_id_seq start 1;

create or replace function next_ticket_id() returns text
language sql as $$ select 'T-' || nextval('tickets_id_seq'); $$;

create table tickets (
  id              text primary key default next_ticket_id(), -- e.g. 'T-1', 'T-2'
  title           text not null,
  description     text not null default '',
  status          ticket_status not null default 'backlog',
  category        text not null default 'feature'
                    check (category in ('perf','security','feature','bug','chore')),
  priority        text not null default 'medium'
                    check (priority in ('critical','high','medium','low')),
  tier            int,                                    -- lower = higher priority within bucket
  effort_estimate text,                                   -- human-readable, e.g. '~half day'
  labels          text[] not null default '{}',           -- e.g. {'Exec: Active','QA: Testing'}
  depends_on      text[] not null default '{}',           -- ticket ids that must be 'complete' first
  files_affected  text[] not null default '{}',           -- used for collision-avoidance during parallel dispatch
  assigned_to     text,                                   -- 'odin', 'odin-1', 'odin-2', ...
  assigned_at     timestamptz,
  branch_name     text,                                   -- e.g. 'ticket/t-123'
  blocked_reason  text,                                   -- first-class; status stays 'active'
  pr_url          text,
  metadata        jsonb not null default '{}',            -- orchestrator-reserved keys (outcome, telemetry, qa, locked_tests, cancellation, comments) + project extension slot
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index tickets_status_idx          on tickets (status);
create index tickets_ready_queue_idx     on tickets (status, priority, tier);
create index tickets_labels_gin          on tickets using gin (labels);
create index tickets_depends_on_gin      on tickets using gin (depends_on);
create index tickets_files_affected_gin  on tickets using gin (files_affected);

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

-- Dependency validation: every id in depends_on must reference an existing
-- ticket, and a ticket cannot depend on itself. Rejects INSERT/UPDATE on
-- violation with a clear error listing unknown ids.
create or replace function validate_ticket_deps() returns trigger
language plpgsql as $$
declare
  unknown text[];
begin
  if new.depends_on is null or array_length(new.depends_on, 1) is null then
    return new;
  end if;

  if new.id = any (new.depends_on) then
    raise exception 'ticket % cannot depend on itself', new.id;
  end if;

  select array_agg(dep) into unknown
  from unnest(new.depends_on) as dep
  where dep not in (select id from tickets);

  if unknown is not null and array_length(unknown, 1) > 0 then
    raise exception 'unknown ticket ids in depends_on: %', unknown;
  end if;

  return new;
end;
$$;

create trigger trg_validate_ticket_deps
before insert or update of depends_on on tickets
for each row execute function validate_ticket_deps();
