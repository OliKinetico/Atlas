-- Phase 3 rulings (Oli, 1-2 October 2026; notes/decisions.md rulings B1-B4 and 1-13).
-- Additive: new enum values, new nullable columns, new indexes and checks, view columns appended
-- at the end. Ruling 6 explicitly approves relaxing NOT NULL on trading_name and
-- trading_name_norm. No column is renamed or dropped and no data changes.

-- B2: an unverified member correspondence address (Property Redress). Not a branch, and not
-- known to be a head office.
alter type public.branch_source_type add value if not exists 'member_address';

-- B3: probable duplicate branches go to review, never merged automatically.
alter type public.proposal_kind add value if not exists 'branch_duplicate';

-- B1 / ruling 6: trading_name stays null when the source supplies none.
alter table public.branches alter column trading_name drop not null;
alter table public.branches alter column trading_name_norm drop not null;

alter table public.branches
  -- CH registered-office rows: the company number from the bulk snapshot (upsert key).
  add column if not exists source_company_number text,
  -- Company number as listed by the PRS member (member rows and their branch rows).
  add column if not exists company_number_listed text,
  -- Ruling 12: PRS branch-list entries. fdBranchName is a location label, not a trading name.
  add column if not exists branch_label text,
  add column if not exists redress_parent_member_id text,
  add column if not exists branch_occurrence smallint,
  -- Ruling 10: member ID + normalised label + postcode + occurrence. List position is
  -- evidence only and never part of the key.
  add column if not exists branch_key text,
  add column if not exists is_active boolean,
  -- Ruling 8: why likely_rmc is set (limited_by_guarantee / name_rule); dormant = low priority.
  add column if not exists likely_rmc_basis text[],
  add column if not exists low_priority boolean not null default false,
  add column if not exists low_priority_reason text;

create unique index if not exists branches_ch_company_key
  on public.branches (source_company_number)
  where source_type = 'ch_registered_office';
create unique index if not exists branches_branch_key
  on public.branches (branch_key)
  where source_type = 'branch';

-- Ruling 9: 0, null and empty are never valid member IDs.
alter table public.branches add constraint branches_valid_member_id
  check (redress_member_id is null or btrim(redress_member_id) !~ '^0*$');
alter table public.branches add constraint branches_valid_parent_member_id
  check (redress_parent_member_id is null or btrim(redress_parent_member_id) !~ '^0*$');
-- Branch rows must say which member they belong to and carry their key.
alter table public.branches add constraint branches_branch_row_complete
  check (source_type <> 'branch' or (redress_parent_member_id is not null and branch_key is not null));
-- Ruling 6 / 13: nothing renders blank. Branch rows satisfy it through the parent's legal name.
alter table public.branches add constraint branches_has_display_name
  check (coalesce(nullif(btrim(trading_name), ''), nullif(btrim(legal_name_as_listed), '')) is not null);

-- branch_overview: same columns as before, new columns appended at the end.
create or replace view public.branch_overview
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
  b.updated_at,
  case
    when b.source_type = 'branch' then concat_ws(' - ', b.legal_name_as_listed, b.branch_label)
    else coalesce(b.trading_name, b.legal_name_as_listed)
  end as display_name,
  case
    when b.source_type = 'branch' then 'parent legal name - branch label'
    when b.trading_name is null then 'taken from legal name'
  end as display_name_note,
  b.branch_label,
  b.redress_member_id,
  b.redress_parent_member_id,
  b.is_active,
  b.low_priority,
  b.low_priority_reason,
  -- Default views hide likely residents' management companies and inactive branches.
  (not b.likely_rmc and b.is_active is not false) as shown_by_default
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
