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

## 2 October 2026 — gate A1 rulings (Oli)

1. **BranchListJson approved**, parsed. Kept per entry: fdBranchName, address lines,
   fdPostCode, fdIsActive, fdPropertyAgentId, branch ID (none exists, see below), Latitude,
   Longitude. Phone, email and fdDisplay* never persisted; `check-personal-data.ts` asserts it
   on the cache and on raw_source_rows.
2. Each entry → `source_type = branch`, `trading_name = fdBranchName`, keyed member ID +
   branch ID; `is_active` stored; inactive branches written but excluded from duplicate
   proposals and default views.
3. Branches are scoped by their own postcode against the 78 outcodes, not the member's.
4. Member addresses: `member_address`, trading_name null (as before).
5. Repeated member IDs: collapse only if byte-identical; any difference → stop, no winner.
6. **Migration 20261002000000 approved, including relaxing NOT NULL on `trading_name` and
   `trading_name_norm`** (explicit decision by Oli). Display name must never be blank.
7. **Branch → company matching:** name similarity only creates human-review proposals with the
   match basis recorded; never auto-links. Exact signals (company number; postcode + exact
   name) may auto-link.
8. **CH hide rule:** hide where (a) limited by guarantee OR (f) the broader name rule
   (`likely_rmc = true`, basis recorded). DORMANT is not hidden; it gets a low-priority flag.
   Implemented in `scripts/ch-candidates.ts`: 542 hidden (388 in scope); 624 dormant flagged
   low priority, 166 of them also hidden.

**Status: stopped at ruling 5** (third pass, `cache/prs-v3/`). The 78 repeats are 9 member
IDs that appear twice, identical, plus member ID `0` appearing 70 times with 70 different
names and postcodes. All 70 ID-0 rows match a BranchListJson entry exactly on name +
postcode: the API returns branch entries as top-level rows with no member link. Also: no
branch ID exists (fdPropertyAgentId = parent fdId on all 77 entries; no other ID key).
Correction to the earlier A2 report: "0" was counted as a valid member ID.

## 2 October 2026 — rulings on the ruling-5 stop (Oli)

9. **Member-ID-0 rows** are kept in raw_source_rows and excluded from branches, but only when
   each matches a fetched member's BranchListJson entry on exact name + postcode (otherwise
   stop: a branch with no known parent). 0, null and empty are invalid member IDs everywhere;
   enforced in the loader and by check constraints `branches_valid_member_id` and
   `branches_valid_parent_member_id`.
10. **Branch key** = member ID + normalised branch label + postcode + occurrence (option b).
    Occurrence is 1 unless the same member lists the same label and postcode more than once:
    identical on every kept field → one row, "listed N times" recorded; any difference → both
    rows (occurrence 1, 2 ordered by address text) plus a branch_duplicate proposal. List
    position is evidence only. A branch missing from a later load is never deleted; its
    `last_seen_at` simply stops advancing (column already existed).
11. **The 9 identical repeats** collapse to one each.
12. **Replaces part of ruling 2:** fdBranchName is a location label, stored in `branch_label`;
    `trading_name` stays null on branch rows. Branch rows carry the parent member's legal name
    (`legal_name_as_listed`) and listed company number (`company_number_listed`), refreshed on
    each load. Display name = parent legal name + " - " + branch label. In Phase 4 branch rows
    link to a company only through the parent member; never name-match on the branch label.
    No duplicate proposals between a member's own address row and its own branch rows.
13. **Display-name check** `branches_has_display_name`: a trading name or a legal name must be
    present and non-blank. Branch rows satisfy it through the parent's legal name.

Migration 20261002000000 was amended before being applied (new columns branch_label,
redress_parent_member_id, branch_occurrence, branch_key, company_number_listed, is_active,
likely_rmc_basis, low_priority, low_priority_reason; the checks above; view columns
display_name, display_name_note, branch_label, redress_member_id, redress_parent_member_id,
is_active, low_priority, low_priority_reason, shown_by_default).

### Phase 3 load (1 October 2026, 18:56 UTC)

- Pre-migration snapshots (ingest_runs 9d284302-ceb1-4f1b-9017-ad768c31924f):
  `raw_source_rows_snapshot_20261001_185551950`, `branches_snapshot_20261001_185552253`,
  `match_proposals_snapshot_20261001_185552268`. Restore and undo commands are in that row.
- Migration 20261002000000 applied via the Management API in one transaction.
- Load run 1 (ingest_runs a7bf5e1b-2a7a-4deb-a522-322d95cb2e88): branches 5,434 inserted
  (member_address 484, branch 11, ch_registered_office 4,939); match_proposals 194;
  raw_source_rows 72 inserted, 5,423 updated.
- Load run 2 (ingest_runs f0cf227b-ea75-45b4-b51f-5f7f84059f49): 0 inserted, 0 updated in all
  three tables; last_seen_at refreshed on 5,434 unchanged rows.
- raw_source_rows keeps one stale row, source_record_id `0`, from the first raw write (the
  ID-0 record the early loader mistook for a member). Never deleted; not loaded as a branch.

## 1 October 2026 — correction pass rulings (Oli)

14. **Amends ruling 12:** when a branch label equals the member name, ignoring case and
    whitespace, the display name is the member name alone. Applied in the loader without a
    schema change: `branch_label` is stored null for such rows (so `branch_overview` shows the
    parent legal name alone) and the label as listed is kept in `sources.branch_label_as_listed`
    with `label_dropped = "equals member name (ruling 14)"`. The branch key still uses the label
    as listed, so the row keeps its identity.
15. **Conflicts:** a member with pending proposals against two or more different companies is a
    conflict. None of its proposals is accepted automatically; they are reviewed together.
    Marked without a schema change in `match_proposals.evidence.conflict`
    (rule, member_id, companies, note). The loader re-applies the mark on every run.

Correction to the narrow-query sweep report: the fetched total across the 78 outcodes is 484,
not 485 (387 + 97). Narrow and fetched both total 484. No member's in-area status differs
between its listed and geocoded outcode; the explanation given for the extra 1 was wrong.

### Correction pass load (1 October 2026, 21:01 UTC)

- Re-fetch to `cache/prs-v4/`: 186 requests, 0 failures; 1,724 valid members (+1756, +24178,
  +54521 outside area; −18269, −24196, −7777 and −48181 outside area).
- Run 1 (ingest_runs 77dc471c-cc41-47d0-8867-4e447cd0f4df): branches +2 member_address
  (24178, 1756), 1 update (Robinsons branch label dropped, ruling 14); match_proposals +1
  (24178 ↔ 12871483); 2 proposals of member 21287 marked as a conflict (ruling 15);
  raw_source_rows +2. Snapshots: raw_source_rows_snapshot_20261001_210134519,
  branches_snapshot_20261001_210138844, match_proposals_snapshot_20261001_210148896.
- Run 2 (ingest_runs 0cf943d9-b88e-4427-9e68-4ba3c68a3320): 0 inserts, 0 updates, 0 marks.
- Not seen and kept (last_seen_at stays 18:56 UTC): 18269, 24196.

## 2 October 2026 — Phase 4 provisional rulings (unattended run; need Oli's confirmation)

Each takes the most cautious, reversible option. All Phase 4 writes are snapshotted first and
can be undone with the commands stored in ingest_runs.

- **P1 — branch-list rows link through the parent member only.** Options: (a) match branch rows
  on their own label/postcode; (b) inherit the parent member's exact link. Chose (b): ruling 12
  forbids name-matching on the branch label. For the 2 parents with no member row in the area
  (14143, 19425) the parent's name, postcode and listed number come from their allowlisted raw
  record. Proposals for those parents attach to their branch rows.
- **P2 — conflicting exact signals are never auto-linked.** Options: (a) link on the listed
  company number whenever it exists in the snapshot, as the plan allows; (b) link only when
  every exact signal (listed number; exact name + postcode) points at one company and the
  member has no pending duplicate proposal against a different company. Chose (b): it applies
  ruling 15 to links as well as proposals. Every candidate of a conflicted member becomes a
  pending proposal carrying `evidence.conflict`. Currently affects member 21287 only.
- **P3 — what generates branch_company proposals.** For members with no exact link (and for
  conflicts): (i) exact normalised name at a different postcode; (ii) a different name with
  Jaro-Winkler similarity >= 0.9 at the same registered-office postcode. Options considered:
  similarity over the whole snapshot (too broad, noisy) or no similarity at all (misses
  near-identical names). Chose same-postcode similarity: narrow and reviewable. Members with an
  exact link get no extra proposals.
- **P4 — Phase 4 matching is insert-only.** New `companies` rows (from the bulk snapshot, minus
  RegAddress.CareOf), `branch_company_links` and `match_proposals` are inserted; existing rows are
  never changed or deleted by the matcher. Company details are refreshed only by the enrichment
  step from the CH API. Branch rows with `manually_edited = true` get no new link.
- **Note — listed numbers whose company name differs:** where a PRS member lists a company number
  that exists in the snapshot, the plan's exact tier links it even if the company's name differs
  from the member's legal name. These links carry `evidence.name_matches = false` and are listed
  in the Phase 4 report for spot-checking.
