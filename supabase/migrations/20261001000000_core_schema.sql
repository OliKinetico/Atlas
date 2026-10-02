-- Phase 2: core schema. Additive only: later changes add columns, tables or enum values;
-- nothing here is ever renamed or dropped without Oli's explicit decision.

-- ---------------------------------------------------------------------------
-- Enums (extend with ALTER TYPE ... ADD VALUE, which is additive)
-- ---------------------------------------------------------------------------
create type public.source_kind as enum ('tpo', 'prs', 'ch_bulk');
create type public.branch_source_type as enum ('branch', 'head_office', 'ch_registered_office');
create type public.ownership_class as enum ('independent', 'group', 'franchise', 'unknown');
create type public.link_tier as enum ('exact', 'accepted_proposal');
create type public.proposal_kind as enum ('branch_company', 'known_group', 'franchise_brand');
create type public.proposal_status as enum ('pending', 'accepted', 'rejected');
create type public.psc_kind as enum ('individual', 'corporate', 'other');

-- ---------------------------------------------------------------------------
-- Allowlist (mirrors ALLOWED_EMAILS; written only by scripts/sync-allowed-emails.ts)
-- ---------------------------------------------------------------------------
create table public.allowed_emails (
  email text primary key check (email = lower(btrim(email)) and email like '%@%'),
  added_at timestamptz not null default now()
);

-- True when the caller's JWT email is allowlisted. SECURITY DEFINER so RLS policies can
-- consult allowed_emails without users being able to read it.
create function public.is_allowlisted()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.allowed_emails
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---------------------------------------------------------------------------
-- Run log
-- ---------------------------------------------------------------------------
create table public.ingest_runs (
  id uuid primary key default gen_random_uuid(),
  script text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows_read integer,
  rows_written integer,
  snapshot_table text,
  restore_command text,
  notes text
);

-- ---------------------------------------------------------------------------
-- Source rows after the business-field allowlist (ruling 0R.1)
-- ---------------------------------------------------------------------------
create table public.raw_source_rows (
  id uuid primary key default gen_random_uuid(),
  source public.source_kind not null,
  source_record_id text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  fetched_at timestamptz not null default now(),
  ingest_run_id uuid references public.ingest_runs (id),
  unique (source, source_record_id)
);

-- Defence in depth for 0R.1: reject any payload whose keys look like personal contact
-- fields. The fetch-time allowlist is the primary control; this catches mistakes.
create function public.reject_personal_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  bad text;
begin
  select k into bad
  from jsonb_object_keys(new.payload) as k
  where k ~* '(e-?mail|phone|tel(ephone)?$|mobile|fax|first_?name|last_?name|surname|forename|contact)'
  limit 1;
  if bad is not null then
    raise exception 'raw_source_rows: personal field "%" is not allowed in payload', bad;
  end if;
  return new;
end;
$$;

create trigger raw_source_rows_no_personal_fields
before insert or update on public.raw_source_rows
for each row execute function public.reject_personal_fields();

-- ---------------------------------------------------------------------------
-- Groups and franchise brands (rows only once Oli confirms)
-- ---------------------------------------------------------------------------
create table public.known_groups (
  id uuid primary key default gen_random_uuid(),
  group_name text not null,
  company_number text not null unique,
  confirmed_by_oli_at timestamptz not null
);

create table public.franchise_brands (
  id uuid primary key default gen_random_uuid(),
  brand_name text not null unique,
  franchisor text,
  confirmed_by_oli_at timestamptz not null
);

-- ---------------------------------------------------------------------------
-- Branches
-- ---------------------------------------------------------------------------
create table public.branches (
  id uuid primary key default gen_random_uuid(),
  -- identity
  trading_name text not null,
  trading_name_norm text not null,
  legal_name_as_listed text,
  address_lines text[],
  postcode text,
  outcode text,
  source_type public.branch_source_type not null,
  likely_rmc boolean not null default false,
  -- location
  lat double precision,
  lng double precision,
  admin_district text,
  admin_district_code text,
  in_scope boolean,
  -- source
  redress_scheme public.source_kind,
  redress_member_id text,
  does_lettings boolean,
  sources jsonb not null default '[]'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- ownership
  ownership_class public.ownership_class not null default 'unknown',
  ownership_reason text,
  parent_group_id uuid references public.known_groups (id),
  -- succession
  oldest_active_director_age integer,
  succession_flag boolean,
  -- manual edits
  notes text,
  manually_edited boolean not null default false,
  manually_edited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upsert keys (Phase 3): the source's own member ID where provided, otherwise exact
-- normalised trading name + exact postcode.
create unique index branches_member_key
  on public.branches (redress_scheme, redress_member_id)
  where redress_member_id is not null;
create unique index branches_name_postcode_key
  on public.branches (source_type, trading_name_norm, postcode)
  where redress_member_id is null;
create index branches_district_code_idx on public.branches (admin_district_code);
create index branches_ownership_idx on public.branches (ownership_class);

-- ---------------------------------------------------------------------------
-- Companies House
-- ---------------------------------------------------------------------------
create table public.companies (
  company_number text primary key,
  name text not null,
  status text,
  sic_codes text[],
  incorporated_on date,
  registered_office jsonb,
  accounts_type text,
  last_accounts_made_up_to date,
  fetched_at timestamptz not null default now(),
  manually_edited boolean not null default false,
  manually_edited_at timestamptz
);

create table public.officers (
  id uuid primary key default gen_random_uuid(),
  company_number text not null references public.companies (company_number),
  name text not null,
  role text,
  appointed_on date,
  resigned_on date,
  dob_month smallint check (dob_month between 1 and 12),
  dob_year smallint,
  fetched_at timestamptz not null default now(),
  manually_edited boolean not null default false,
  manually_edited_at timestamptz,
  unique nulls not distinct (company_number, name, role, appointed_on)
);

create table public.pscs (
  id uuid primary key default gen_random_uuid(),
  company_number text not null references public.companies (company_number),
  name text not null,
  kind public.psc_kind not null,
  corporate_company_number text,
  notified_on date,
  ceased_on date,
  fetched_at timestamptz not null default now(),
  manually_edited boolean not null default false,
  manually_edited_at timestamptz,
  unique nulls not distinct (company_number, name, kind, notified_on)
);

create table public.psc_chains (
  company_number text primary key references public.companies (company_number),
  chain jsonb not null check (jsonb_typeof(chain) = 'array'),
  depth integer not null check (depth between 0 and 5),
  top_entity_number text,
  computed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Links and proposals
-- ---------------------------------------------------------------------------
create table public.branch_company_links (
  branch_id uuid not null references public.branches (id),
  company_number text not null references public.companies (company_number),
  tier public.link_tier not null,
  -- No link without evidence: exact links must say which exact-tier rule matched.
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object' and evidence <> '{}'::jsonb),
  created_at timestamptz not null default now(),
  primary key (branch_id, company_number)
);
create index branch_company_links_company_idx on public.branch_company_links (company_number);

create table public.match_proposals (
  id uuid primary key default gen_random_uuid(),
  kind public.proposal_kind not null,
  subject_id text not null,
  candidate jsonb not null,
  evidence jsonb not null,
  status public.proposal_status not null default 'pending',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text
);
-- Re-runs must not duplicate the same proposal.
create unique index match_proposals_dedupe
  on public.match_proposals (kind, subject_id, md5(candidate::text));
create index match_proposals_status_idx on public.match_proposals (status, kind);

-- ---------------------------------------------------------------------------
-- manually_edited guard (CLAUDE.md: never overwrite a manually edited row).
-- Scripts must skip these rows themselves; this trigger is the backstop. An update
-- from anyone other than a signed-in allowlisted user leaves the row unchanged.
-- ---------------------------------------------------------------------------
create function public.protect_manual_edits()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.manually_edited and not public.is_allowlisted() then
    raise warning '%: skipped update to manually edited row', tg_table_name;
    return null;
  end if;
  return new;
end;
$$;

create trigger branches_protect_manual_edits before update on public.branches
  for each row execute function public.protect_manual_edits();
create trigger companies_protect_manual_edits before update on public.companies
  for each row execute function public.protect_manual_edits();
create trigger officers_protect_manual_edits before update on public.officers
  for each row execute function public.protect_manual_edits();
create trigger pscs_protect_manual_edits before update on public.pscs
  for each row execute function public.protect_manual_edits();

-- ---------------------------------------------------------------------------
-- Snapshot helper (CLAUDE.md: snapshot before any mass write, log the restore command).
-- Service role only. Snapshot tables get RLS with no policies, so users cannot read them.
-- ---------------------------------------------------------------------------
create function public.snapshot_table(tbl text)
returns table (snapshot_table text, restore_command text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  snap text := tbl || '_snapshot_' || to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDD"_"HH24MISSMS');
  cols text;
  sets text;
  pk text;
begin
  if tbl not in ('branches', 'companies', 'officers', 'pscs', 'psc_chains',
                 'branch_company_links', 'match_proposals', 'raw_source_rows') then
    raise exception 'snapshot_table: % is not a snapshot-able table', tbl;
  end if;
  execute format('create table public.%I as table public.%I', snap, tbl);
  execute format('alter table public.%I enable row level security', snap);

  select string_agg(quote_ident(a.attname), ', ' order by a.attnum),
         string_agg(format('%1$I = excluded.%1$I', a.attname), ', ' order by a.attnum)
    into cols, sets
  from pg_attribute a
  where a.attrelid = format('public.%I', tbl)::regclass and a.attnum > 0 and not a.attisdropped;
  select c.conname into pk
  from pg_constraint c
  where c.conrelid = format('public.%I', tbl)::regclass and c.contype = 'p';

  -- Restore = upsert the snapshot back by primary key: changed rows get their snapshot
  -- values, deleted rows come back. It never deletes (so foreign keys hold) and rows
  -- added after the snapshot are left in place. Manually edited rows stay protected.
  snapshot_table := snap;
  restore_command := format(
    'insert into public.%1$I (%3$s) select %3$s from public.%2$I on conflict on constraint %4$I do update set %5$s;',
    tbl, snap, cols, pk, sets);
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security: every table. Allowlisted signed-in users read and write;
-- scripts use the service role (bypasses RLS). anon gets nothing.
-- ---------------------------------------------------------------------------
alter table public.allowed_emails enable row level security; -- no policies: service role only
alter table public.ingest_runs enable row level security;
alter table public.raw_source_rows enable row level security;
alter table public.known_groups enable row level security;
alter table public.franchise_brands enable row level security;
alter table public.branches enable row level security;
alter table public.companies enable row level security;
alter table public.officers enable row level security;
alter table public.pscs enable row level security;
alter table public.psc_chains enable row level security;
alter table public.branch_company_links enable row level security;
alter table public.match_proposals enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'ingest_runs', 'raw_source_rows', 'known_groups', 'franchise_brands', 'branches',
    'companies', 'officers', 'pscs', 'psc_chains', 'branch_company_links', 'match_proposals'
  ] loop
    execute format(
      'create policy %I on public.%I for all to authenticated
         using ((select public.is_allowlisted())) with check ((select public.is_allowlisted()))',
      t || '_allowlisted', t);
  end loop;
end;
$$;

revoke all on function public.is_allowlisted() from public, anon;
grant execute on function public.is_allowlisted() to authenticated, service_role;
revoke all on function public.snapshot_table(text) from public, anon, authenticated;
grant execute on function public.snapshot_table(text) to service_role;
revoke all on table public.allowed_emails from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Read view. security_invoker so the caller's RLS applies.
-- ---------------------------------------------------------------------------
create view public.branch_overview
with (security_invoker = true)
as
select
  b.id as branch_id,
  b.trading_name,
  b.legal_name_as_listed,
  b.postcode,
  b.admin_district,
  b.admin_district_code,
  b.in_scope,
  b.lat,
  b.lng,
  b.source_type,
  b.likely_rmc,
  b.redress_scheme,
  b.ownership_class,
  b.ownership_reason,
  g.group_name as parent_group_name,
  l.company_number,
  l.tier as link_tier,
  c.name as company_name,
  c.status as company_status,
  b.oldest_active_director_age,
  b.succession_flag,
  pc.top_entity_number,
  top_c.name as top_entity_name,
  b.manually_edited,
  b.last_seen_at,
  b.updated_at
from public.branches b
left join lateral (
  select bcl.company_number, bcl.tier
  from public.branch_company_links bcl
  where bcl.branch_id = b.id
  order by (bcl.tier = 'exact') desc, bcl.created_at
  limit 1
) l on true
left join public.companies c on c.company_number = l.company_number
left join public.psc_chains pc on pc.company_number = l.company_number
left join public.companies top_c on top_c.company_number = pc.top_entity_number
left join public.known_groups g on g.id = b.parent_group_id;

revoke all on public.branch_overview from anon;
