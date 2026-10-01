-- Phase 3 rulings (Oli, 1 October 2026). Additive: new enum values, new nullable column,
-- new index, view columns appended at the end. Two NOT NULL constraints are relaxed because
-- ruling B1 requires trading_name to stay null when the source supplies none; no column is
-- renamed or dropped and no data changes.

-- B2: an unverified member correspondence address (Property Redress). Not a branch, and not
-- known to be a head office.
alter type public.branch_source_type add value if not exists 'member_address';

-- B3: probable duplicate branches go to review, never merged automatically.
alter type public.proposal_kind add value if not exists 'branch_duplicate';

-- B1: trading_name is left null when the source supplies none (display falls back to the
-- legal name, tagged "taken from legal name"). trading_name_norm follows it.
alter table public.branches alter column trading_name drop not null;
alter table public.branches alter column trading_name_norm drop not null;

-- Upsert key for ch_registered_office rows: the company number from the bulk snapshot.
-- (A2: never fall back to trading name + postcode while trading names are empty.)
alter table public.branches add column if not exists source_company_number text;
create unique index if not exists branches_ch_company_key
  on public.branches (source_company_number)
  where source_type = 'ch_registered_office';

-- branch_overview: same columns as before, plus the display name and its provenance at the end.
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
  coalesce(b.trading_name, b.legal_name_as_listed) as display_name,
  case when b.trading_name is null and b.legal_name_as_listed is not null
       then 'taken from legal name' end as display_name_note
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
