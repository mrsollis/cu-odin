-- Migration 001 — add the `images` column to an existing `tickets` table.
--
-- Run this ONCE against a database that was created with an earlier schema.sql
-- (before the `images` column existed). Fresh installs from schema.sql already
-- have the column and can skip this file.
--
-- Idempotent: safe to re-run. Adds the column and the "at most 5 attachments"
-- cap without touching existing rows.
--
-- Apply via Supabase migrations, the MCP apply_migration tool, or `psql -f`.

alter table public.tickets
  add column if not exists images jsonb not null default '[]';

alter table public.tickets
  drop constraint if exists tickets_images_is_array,
  add  constraint tickets_images_is_array check (jsonb_typeof(images) = 'array');

alter table public.tickets
  drop constraint if exists tickets_images_max_5,
  add  constraint tickets_images_max_5 check (jsonb_array_length(images) <= 5);
