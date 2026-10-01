# Decisions log

## 1 October 2026

- **TPO: no pages fetched.** Fetching the 38 TPO business sitemaps (to check whether member
  URLs carry location, ruling 0R.3) was refused by the session's safety classifier. Oli chose
  to skip TPO: ingestion uses Property Redress and Companies House only, and Oli will request
  a data extract from TPO separately. Recon samples (`/business-search/cheffins/`) suggest
  URLs carry the business name only.
- **`allowed_emails` table added** (not in the Phase 2 table list). RLS cannot read the
  `ALLOWED_EMAILS` env var, so the allowlist is mirrored into this table by
  `scripts/sync-allowed-emails.ts`. Service role only; users cannot read it. Agreed by Oli.
- **Snapshot restore is an upsert by primary key**, not delete-and-reinsert, so foreign keys
  hold. It restores changed and deleted rows; rows added after the snapshot stay. Rows with
  `manually_edited = true` are protected by a trigger, including during a restore.
- **Next.js 16 renamed middleware to proxy**: route protection is `src/proxy.ts`.

## 1 October 2026 (session 3)

- **Phase 2 applied to the live project** via the Supabase Management API (one transaction).
  `supabase_migrations.schema_migrations` did not exist, so nothing was recorded there. Before
  anyone runs `supabase db push` against this project, run
  `supabase migration repair --status applied 20261001000000` so the CLI does not re-apply it.
- **RLS tests** (`scripts/test-rls.ts`) run against the live project: 119/119 checks passed.
  Test users use the reserved `.invalid` TLD and are deleted at the end.

## 2 October 2026 — Phase 3 rulings (Oli)

**Status: stopped at gate A1.** Migration 20261002000000 is committed but NOT applied to the
live project, and no branches have been written. Property Redress returns `BranchListJson` (a
JSON string) on 27 members, holding 77 branch entries, each with a non-empty `fdBranchName`.
`TradingName` itself is present on all 1,804 records and empty on all of them. Waiting for
Oli's ruling. The rulings below are implemented in code, ready for when the gate clears.

- **Trading name:** left null when Property Redress supplies none; never copied from the legal
  name. `branch_overview.display_name` falls back to the legal name (PRS) or company name (CH)
  with `display_name_note = 'taken from legal name'`. Needed `trading_name` and
  `trading_name_norm` to become nullable (migration 20261002000000).
- **PRS address label:** `member_address` = an unverified member correspondence address. Not
  `head_office` (not known to be one). `branch` is kept for real branch-list entries.
- **Upsert keys:** source IDs only. PRS member ID (`redress_member_id`); CH company number
  (new column `source_company_number`, unique for `ch_registered_office`). No fallback to
  trading name + postcode while trading names are empty.
- **branch_duplicate** added to `proposal_kind`. Probable duplicates go to `match_proposals`
  with `evidence.match_basis` (identical_company_number / same_name_same_postcode /
  same_name_different_postcode). Nothing is merged.
- **fdIsHaveOtherBranch / fdNumberofBranches** added to the PRS allowlist; stored in
  `branches.sources` and `raw_source_rows` as self-declared by the member, not verified.
  Second pass cached to `cache/prs-v2/`; first pass kept in `cache/prs/`.
- **Residents' management company rule** unchanged (four-word rule) for this write; stronger
  signals tested read-only in `scripts/ch-signals.ts`.

### Migration versions not recorded in supabase_migrations.schema_migrations

The live project has no `supabase_migrations.schema_migrations` table (migrations are applied
through the Management API). Before anyone uses the Supabase CLI against the project, run:

```
supabase migration repair --status applied 20261001000000
supabase migration repair --status applied 20261002000000   # only once it has been applied
```
