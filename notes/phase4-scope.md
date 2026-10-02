# Phase 4 — scope and acceptance (restated before building)

Source: notes/build-plan-v2.md, section 4 (verbatim there). Binding refinements: rulings
0R.1, 0R.5, 7, 12 and 15 in notes/decisions.md. Provisional rulings taken during this
unattended run are recorded in notes/decisions.md as P1, P2, ...

## Scope (from the plan)

1. Use the local BasicCompanyData bulk snapshot (`data/BasicCompanyDataAsOneFile-2026-10-01.csv`)
   with DuckDB. Never load the whole snapshot into Supabase.
2. **Exact tier (may auto-link)** only when:
   - the register supplies a company number that exists in the snapshot; or
   - the exact normalised legal name (lower-case, punctuation removed, "limited"/"ltd"
     unified) matches **and** the registered-office postcode equals the branch postcode.
3. Everything else → `match_proposals` (kind `branch_company`), pending, never auto-applied:
   trading name ≠ legal name, name similarity, postcode mismatch.
4. For linked companies, call the CH API for profile, officers and PSCs, within the documented
   rate limit; cache in `/cache/ch/`; retry failures from cache.
5. PSC chain: follow corporate PSCs with a UK company number up to depth 5 → `psc_chains`.
6. Skip `manually_edited` rows. Snapshot `companies`, `officers`, `pscs` before re-runs.

## How the rulings shape it

- **Ruling 7:** only exact signals auto-link; similarity only creates proposals.
- **Ruling 12:** branch-list rows (`source_type = branch`) link only through their parent
  member's link. The branch label is never name-matched.
- **Ruling 15:** a member whose signals point at two or more different companies is a
  conflict: no auto-link, all candidates go to proposals, reviewed together.
- **0R.1:** officers' names and month/year of birth are in scope; their addresses,
  nationality, occupation and country of residence are not stored or cached.
- **0R.5:** enrich only where `likely_rmc = false`.
- **Data safety (Oli, Phase 4 brief):** additive migrations only; snapshot before every load;
  never delete; never touch `manually_edited` rows; every loader run followed by a second run
  proving 0 inserts and 0 updates; stop a source if blocked or rate-limited; no paid services.

## Acceptance (verbatim from the plan)

- [ ] Counts reported: branches exact-linked, proposals created, unlinked.
- [ ] 10 random exact links listed with their evidence for Oli to spot-check.
- [ ] No auto-link exists without exact-tier evidence (query proves it).
- [ ] API calls stayed within the documented rate limit (log evidence).

Documented CH limit (developer guidelines, quoted in Phase 0 recon): "You can make up to 600
requests within a 5 minute period."
