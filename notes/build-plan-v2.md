# Lettings Atlas (working name) — Surrey Lettings Agent Map — Build Prompt v2

> Copied verbatim into the repo on 2 October 2026 from the v2 build prompt Oli supplied at the
> start of the Phase 2/3 session (the handover file only held a placeholder). Section 0R
> rulings and the later rulings in notes/decisions.md take precedence where they refine it.

> **v2 supersedes v1.** Phase 0 recon was completed in a previous session (notes on branch `claude/gallant-wozniak-6xydp5`: notes/phase0-recon.md, notes/phase0-surrey-outcodes.json). Oli's rulings on that report are in section 0R below and override anything in v1 that conflicts.

## Context header (read first)

- **What this is:** a new, private, standalone web app for Oli Abrams' new venture (a UK lettings buy-and-build). It maps every lettings agent branch in Surrey and shows who owns each one (independent, group-owned, franchise), the directors' ages and the company details.
- **Separation rule (binding):** this project is entirely separate from Kinetico Health and from the `kinetico-crm` / Masterboard repo. Do not read, copy, import or reference any code, data, schema, env vars or credentials from `kinetico-crm`, its Supabase project, its Railway worker or any Kinetico-named account. Do not clone or fork it.
- **Identifiers (obtain from Oli; do not infer):**
  - GitHub repo URL (private): `<FROM OLI>`
  - Supabase project ref: `<FROM OLI>`
  - Vercel project name: `<FROM OLI>`
  - If any of these is missing, STOP and ask. Do not create accounts or projects yourself.
- **Secrets:** Oli puts these in `.env.local` and Vercel himself. Never commit them, print them or echo them in logs:
  - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  - `COMPANIES_HOUSE_API_KEY`
  - `ALLOWED_EMAILS` (comma-separated)
  - `CRAWLER_CONTACT_EMAIL` (used in the crawler's user agent)
- **Stack:** Next.js (App Router) + TypeScript + pnpm + Supabase (Postgres, Auth, RLS). Ingestion scripts are TypeScript, run locally via `pnpm tsx scripts/<name>.ts`. Use DuckDB locally for the Companies House bulk snapshot.
- **Data sources (all free):**
  - Property Redress (PRS) public search endpoint: member records for the Surrey postcode areas, business fields only (see 0R).
  - The Property Ombudsman (TPO): only if Surrey pages can be selected without crawling the national register (see 0R).
  - Companies House: free monthly BasicCompanyData bulk snapshot (also used to find candidate agents by SIC code), plus the REST API for officers and persons with significant control (PSC).
  - postcodes.io for geocoding and district codes.
  - OpenStreetMap tiles for the map.
- **Out of scope for this prompt:**
  - Rightmove/Zoopla/OnTheMarket scraping
  - Google Places
  - Parsing iXBRL accounts
  - Any county other than Surrey
  - Outreach or CRM features

---

## 0R. Oli's rulings on the Phase 0 report (binding)

1. **Personal data: business fields only.**
   - PRS returns contact first name, last name, email and phone. Never store, cache, log or commit these, or any other field about a named individual.
   - Apply an allowlist at fetch time, before anything is written to disk or the database. Cached responses are stored filtered, never raw.
   - Allowlist: member ID (`fdId`), trading name, legal company name, company number (`fdRegisteredCoNo`), business address lines, postcode, business website, membership status, and any lettings/sales flag.
   - This replaces v1's "store each record unchanged".
   - Directors' names and month/year of birth from the Companies House public register remain in scope (Phase 4).
2. **PRS route: approved.**
   - Prefix searches for GU, KT, RH, TW, SM, CR, TN and SL only, at no more than 1 request every 2 seconds.
   - On a connection reset, wait and retry with exponential backoff, up to 3 retries per page.
   - If 10 consecutive requests fail, stop and report.
3. **TPO route: full national crawl NOT approved.**
   - First check whether the sitemap URLs or sitemap metadata identify location (e.g. town or postcode in the URL) so that Surrey pages can be selected without fetching other members' pages.
   - If yes: fetch only those pages, at no more than 1 request every 2 seconds. Report the page count before fetching. If it exceeds 1,500, stop and ask.
   - If no: do not fetch TPO pages. Report this and continue with PRS and Companies House. Oli will request a data extract from TPO separately.
4. **Never circumvent bot protection.**
   - No headless browsers to get past Cloudflare, no rotating user agents or proxies, no CAPTCHA solving.
   - Use a single honest user agent identifying the project and a contact email from env `CRAWLER_CONTACT_EMAIL` (obtain from Oli).
   - A 403 or 429 means back off. Repeated blocks mean stop and report.
5. **Companies House candidates fill the TPO gap.**
   - From the bulk snapshot, take every active company with SIC 68310 or 68320 whose registered-office postcode resolves (via postcodes.io) to a Surrey district.
   - Add each as a branch row with `source_type = ch_registered_office`, shown on the map with a distinct marker labelled "registered office, not a verified branch".
   - Flag names containing "residents", "RTM", "freehold" or "management company" as `likely_rmc = true` (likely a residents' management company, not an agent). Hide them by default. Never delete them.
   - Enrich only candidates where `likely_rmc = false`.
6. **Surrey scope uses ONS codes, not names.**
   - Surrey's 11 districts become East Surrey and West Surrey on 1 April 2027.
   - Store both `admin_district` and `admin_district_code` from postcodes.io. Set `in_scope` from the full postcode's district code, never from the outcode.
   - Derive the 11 Surrey district codes from postcodes.io responses and list them in the run report. Do not type them from memory.
   - Accept the new unitary authority codes once postcodes.io returns them; report when that happens.
   - The 78-outcode list in notes/phase0-surrey-outcodes.json is approved as the search set.
7. **Housekeeping before anything else:**
   - Check notes/phase0-recon.md, the JSON notes and any local caches from the recon session for personal data (names, emails, phone numbers of individuals).
   - Delete local caches that contain it.
   - If any committed file contains it: report first. Then remove it, recreate the scratch branch from a clean commit, and force-push that scratch branch only.

### Remaining Phase 0 item (do first in this session)
- [ ] Call the Companies House company profile for `14991567` with `COMPANIES_HOUSE_API_KEY` and confirm a 200 response. If it fails, STOP and report.
- [ ] Housekeeping check (0R.7) done and reported.
- [ ] TPO sitemap location check (0R.3) done and reported.

Once these three are done, proceed to Phase 1 without a further stop unless something contradicts the rulings above.

---

## 0. Recon (completed in the previous session — kept for reference)

Investigate, then report and wait for Oli's go-ahead. If any finding contradicts the plan below, say so explicitly. Do not adapt silently.

**0.1 Redress registers (TPO and PRS).** For each register, establish:

- Can members be searched by postcode, outcode or area?
- What fields come back: branch address, trading name, legal company name, company number, member/branch ID, and whether the member does lettings or sales?
- Is there an official API, export or downloadable dataset?
- What do the terms of use and `robots.txt` say about automated access?

Classify each register as one of:
- **(a)** official bulk or API access;
- **(b)** web search where low-rate automated access is permitted;
- **(c)** automated access prohibited or unclear.

If **both** are (c): STOP. Do not scrape. Report alternatives instead, for example requesting a data extract from the scheme, or a manual export Oli can do.

**0.2 Companies House.**
- Confirm `COMPANIES_HOUSE_API_KEY` works by calling the company profile for `14991567` (Prospire Technologies Ltd, a known test record).
- Report the documented API rate limit.
- Confirm the current BasicCompanyData bulk snapshot URL and its file size.

**0.3 postcodes.io.**
- Confirm the bulk lookup endpoint and its maximum batch size.
- Report the admin fields returned (e.g. `admin_district`, `admin_county`).
- Report whether Surrey postcodes return the 11 district councils (Elmbridge, Epsom and Ewell, Guildford, Mole Valley, Reigate and Banstead, Runnymede, Spelthorne, Surrey Heath, Tandridge, Waverley, Woking) or newer unitary authority names. The scope filter depends on this.

**0.4 Surrey scope definition.**
- Using postcodes.io data, produce the list of postcode outcodes whose postcodes fall in Surrey's districts or unitary authorities, with a count.
- Do not hand-type outcodes from memory.
- Note any outcodes that straddle the boundary with London, Sussex, Hampshire, Berkshire or Kent.

**0.5 Report back:**
- Findings per source.
- The proposed ingestion method per source.
- Estimated request volumes and run times.
- Anything that blocks the plan.

**STOP and wait for Oli's approval.**

### Phase 0 acceptance
- [ ] TPO and PRS each classified (a)/(b)/(c), with the terms-of-use evidence quoted.
- [ ] CH API key confirmed working on 14991567; rate limit stated; bulk snapshot URL and size stated.
- [ ] postcodes.io admin fields and Surrey naming behaviour reported.
- [ ] Surrey outcode list produced from data, with count and boundary notes.
- [ ] No code written to the repo beyond scratch notes; report delivered; waiting for go-ahead.

---

## 1. Scaffold the repo

1. In the private repo Oli supplied, create a Next.js App Router + TypeScript project with pnpm.
2. Add the Supabase client (server and browser).
3. Add Supabase Auth with email magic link:
   - Only addresses listed in `ALLOWED_EMAILS` may sign in.
   - Add middleware protecting every route except `/login` and `/api/health`.
4. Add `/api/health`, returning `{ ok: true }` with status 200.
5. Add `.env.example` with variable **names only**, and `.gitignore` covering `.env*` (except `.env.example`), `/data`, `/cache`, `*.duckdb`.
6. Save `CLAUDE.md` at the repo root **verbatim** (see CLAUDE.md in the repo).
7. Save .claude/skills/verify/SKILL.md **verbatim** (see the file in the repo).

### Phase 1 acceptance
- [ ] App builds; `/api/health` returns 200; every other route redirects to `/login` when signed out.
- [ ] Sign-in works only for an address in `ALLOWED_EMAILS`.
- [ ] `CLAUDE.md` and the verify skill exist with exactly the text above.
- [ ] No secrets in the repo (`git grep` for key patterns returns nothing).
- [ ] Verify skill run and passed.

---

## 2. Schema (additive migrations only)

Create these tables via Supabase migrations. Enable RLS on **every** table:
- Read and write for authenticated users whose email is in the allowlist.
- Scripts use the service role.

| Table | Purpose | Key fields |
|---|---|---|
| `ingest_runs` | Log of every script run | id, script, started_at, finished_at, rows_read, rows_written, snapshot_table, restore_command, notes |
| `raw_source_rows` | Source rows after the business-field allowlist (0R.1); never personal fields | id, source (`tpo`/`prs`/`ch_bulk`), source_record_id, payload jsonb, fetched_at, ingest_run_id |
| `branches` | One row per physical branch | see below |
| `companies` | Companies House company records | company_number (PK), name, status, sic_codes text[], incorporated_on, registered_office jsonb, accounts_type, last_accounts_made_up_to, fetched_at |
| `officers` | Active and resigned officers | company_number, name, role, appointed_on, resigned_on, dob_month, dob_year (as published by CH) |
| `pscs` | Persons with significant control | company_number, name, kind (individual/corporate/other), corporate_company_number (nullable), notified_on, ceased_on |
| `psc_chains` | Resolved ownership chain per company | company_number, chain jsonb (ordered list), depth, top_entity_number |
| `branch_company_links` | Confirmed branch → company links | branch_id, company_number, tier (`exact`/`accepted_proposal`), evidence jsonb, created_at |
| `match_proposals` | Anything not exact; human review only | id, kind (`branch_company`/`known_group`/`franchise_brand`), subject_id, candidate jsonb, evidence jsonb, status (`pending`/`accepted`/`rejected`), reviewed_at, reviewed_by |
| `known_groups` | Confirmed consolidator entities | id, group_name, company_number, confirmed_by_oli_at |
| `franchise_brands` | Confirmed franchise brand names | id, brand_name, franchisor, confirmed_by_oli_at |

**`branches` fields:**
- Identity: id, trading_name, legal_name_as_listed, address_lines, postcode, outcode, source_type (`branch` / `head_office` / `ch_registered_office`), likely_rmc bool default false
- Location: lat, lng, admin_district, admin_district_code, in_scope bool
- Source: redress_scheme, redress_member_id, does_lettings bool (nullable), sources jsonb, first_seen_at, last_seen_at
- Ownership: ownership_class (`independent`/`group`/`franchise`/`unknown`), ownership_reason, parent_group_id
- Succession: oldest_active_director_age, succession_flag bool
- Manual edits: notes, manually_edited bool default false, manually_edited_at

Also create a read view, `branch_overview`, joining branch, linked company, oldest active director age, top PSC entity and ownership class.

### Phase 2 acceptance
- [ ] All migrations are additive; RLS enabled and tested (a non-allowlisted user can read nothing).
- [ ] `branch_overview` returns rows once data exists.

---

## 3. Branch ingestion (redress registers)

Use only the routes approved in 0R.

1. Fetch PRS records for the approved postcode areas, and TPO pages only if 0R.3 allows. Apply the business-field allowlist (0R.1) before caching or storing. Store the allowlisted record in `raw_source_rows`.
2. Throttle to the 0R rates. Cache allowlisted responses to `/cache/<source>/` so re-runs read from cache (`--from-cache`). Record failures for retry rather than restarting from scratch.
3. Upsert `branches`. The upsert key is the source's own member/branch ID where provided. Otherwise it is the exact normalised trading name plus exact postcode.
4. Never merge two records on similarity. Probable duplicates go to `match_proposals`.
5. Geocode postcodes via the postcodes.io bulk endpoint (100 per call). Store lat, lng, admin_district and admin_district_code, and set `in_scope` from the district code (0R.6). Invalid or terminated postcodes are flagged in `ownership_reason`/notes and left un-geocoded, never corrected by guesswork.
6. Skip any row or field where `manually_edited = true`.
7. Snapshot `branches` before any re-run that updates existing rows (`create table branches_snapshot_<timestamp> as table branches;`). Write the restore command to `ingest_runs`.

8. Add the Companies House candidates (0R.5) as `ch_registered_office` rows, with `likely_rmc` set.

### Phase 3 acceptance
- [ ] Branch counts reported: total, in-scope, by source, by source_type, by district, likely_rmc count, and number of duplicates proposed.
- [ ] A query proves that no stored payload, cache file or log contains personal contact fields.
- [ ] Re-running the script is idempotent (same counts, no duplicates).
- [ ] Every in-scope branch either has lat/lng or a recorded reason why not.
- [ ] `ingest_runs` row written with the snapshot table and restore command.

---

## 4. Companies House matching and enrichment

1. Download the current BasicCompanyData bulk snapshot to `/data` (git-ignored) and query it with DuckDB locally. Do not load the whole snapshot into Supabase.
2. **Exact tier (may auto-link)**, only when one of these holds:
   - the register supplies a company number and that number exists in the snapshot; or
   - the exact normalised legal name (lower-case, punctuation removed, "limited"/"ltd" unified) matches **and** the registered-office postcode equals the branch postcode.
3. **Everything else goes to `match_proposals`** with evidence and is never auto-applied. That includes trading name ≠ legal name, name similarity, and postcode mismatch.
4. For linked companies (exact or accepted proposals), call the CH API for company profile, officers and PSC:
   - Honour the documented rate limit with backoff.
   - Cache responses in `/cache/ch/`; retry failures from cache.
5. **PSC chain:** where a PSC is a corporate entity with a UK company number, fetch that company's PSCs, up to a depth of 5. Store the result in `psc_chains`.
6. Skip `manually_edited` rows. Snapshot `companies`, `officers` and `pscs` before any re-run that updates existing rows.

### Phase 4 acceptance
- [ ] Counts reported: branches exact-linked, proposals created, unlinked.
- [ ] 10 random exact links listed with their evidence for Oli to spot-check.
- [ ] No auto-link exists without exact-tier evidence (query proves it).
- [ ] API calls stayed within the documented rate limit (log evidence).

---

## 5. Classification

1. **Known groups:**
   - Seed `known_groups` with only these two confirmed entries: Prospire Technologies Ltd `14991567` and Prospire Operations Ltd `15595867` (both Dwelly).
   - For Foxtons, Lomond, Leaders Romans Group (LRG), Campions, Sourced, The Property Franchise Group/Belvoir and Connells/Countrywide: look up candidate parent company numbers and write them to `match_proposals` (kind `known_group`) for Oli to confirm.
   - Do not seed them until confirmed.
2. **Group:** if a company's PSC chain reaches a confirmed `known_groups` company number, set `ownership_class = group`, with `ownership_reason` naming the chain.
3. **Franchise:**
   - Propose a franchise brand list (e.g. Belvoir, Martin & Co, Northwood, Whitegates, CJ Hole, Ellis & Co, Winkworth), with the source for each, as `franchise_brand` proposals.
   - Once Oli confirms a brand, branches whose trading name contains it become a `franchise` **proposal** per branch. They are shown as "franchise (proposed)" until accepted.
4. **Independent:** a linked company whose PSCs are all individuals and whose chain contains no confirmed group.
5. **Unknown:** no confirmed company link.
6. **Succession:**
   - Compute each active director's age from the CH month and year of birth.
   - `oldest_active_director_age` = the maximum.
   - `succession_flag = true` if any active director is 60 or older.
7. Never change `ownership_class` where `manually_edited = true`.

### Phase 5 acceptance
- [ ] Counts by ownership class, by district, and succession-flagged independents.
- [ ] Known-group and franchise-brand proposals listed for Oli.
- [ ] No group or franchise classification rests on an unconfirmed entity or brand.

---

## 6. UI

Clean, neutral styling. No Kinetico or Masterboard branding.

**`/map`**
- Leaflet with OpenStreetMap tiles and the required attribution (low-volume private use).
- Markers coloured by ownership class.
- Filters: ownership class, district, succession flag, redress scheme.
- Clicking a marker opens a detail drawer.

**`/branches`**
- Sortable table with the same filters.
- Columns: trading name, district, ownership class, parent group, oldest director age, succession flag, company number, last updated.
- CSV export of the filtered view.

**`/branch/[id]`**
- Full detail: sources, linked company, directors with ages, PSC chain, notes.
- Manual edit of ownership class and notes, which sets `manually_edited = true` and `manually_edited_at`.

**`/review`**
- Pending `match_proposals` grouped by kind, with the evidence shown.
- Accept or reject; record `reviewed_at` and `reviewed_by`.
- Accepting a branch–company proposal creates the link (tier `accepted_proposal`) and triggers enrichment for that company only.

### Phase 6 acceptance
- [ ] Map renders all in-scope geocoded branches; filters change the marker count correctly.
- [ ] Table and CSV export match the filters.
- [ ] Manual edit sets `manually_edited`; a subsequent ingest re-run leaves it untouched (prove it).
- [ ] Accepting and rejecting proposals works and is recorded.
- [ ] Verify skill passed.

---

## 7. Deployment

1. Push the branch. List the env var **names** Oli must set in the Vercel project; Oli sets the values.
2. Manually deploy the branch to the Vercel project Oli supplied.
3. Verify live with evidence:
   - `/api/health` returns 200;
   - signed-out requests redirect to `/login`;
   - a non-allowlisted email cannot sign in;
   - the map and table show the expected counts.
4. Only then open or merge the PR.

---

## Data safety (binding)

- Additive-only migrations. No renames or drops.
- Snapshot before any mass or re-run write, with the restore command logged in `ingest_runs`.
- Never write to rows or fields where `manually_edited = true`.
- No fuzzy matching auto-applied. Fuzzy and similarity output goes only to `match_proposals`.
- Never guess company numbers, postcodes or addresses.
- **Blast radius:**
  - Writes go only to the new Supabase project, to the tables listed in Phase 2 (plus snapshot tables), and to local `/data` and `/cache`.
  - Nothing in this build touches `kinetico-crm`, its database, its Railway worker or its sweeps.
  - No sweeps exist in this project.

## Verification (governing)

- Run .claude/skills/verify/SKILL.md after any frontend or API change.
- Never run `pnpm dev` in the foreground.
- A failing gate is never bypassed. The verify skill may only be made stricter.

## Stuck and escalation policy

- After 3 failed attempts on the same error: stop, write up what was tried and what was observed, and report.
- Never widen scope to fix an unrelated blocker without reporting first.
- If a data source changes its terms, structure or rate limits mid-build: stop and report.

## Acceptance criteria (whole prompt)

- [ ] Phase 0 recon reported and approved by Oli before any build.
- [ ] Repo is separate; no `kinetico-crm` code, data or credentials used (state how you checked).
- [ ] `CLAUDE.md` and the verify skill saved verbatim.
- [ ] All phase acceptance boxes ticked with evidence.
- [ ] RLS enforced on every table; allowlisted sign-in only.
- [ ] Every automated write path checks `manually_edited` and has a snapshot and restore path.
- [ ] No auto-applied fuzzy matches.
- [ ] Branch deployed and verified live before merge; one PR only.
- [ ] No personal contact fields stored, cached, logged or committed anywhere (state how you checked).
- [ ] Bot protection never circumvented; request logs show the 0R rates were respected.
- [ ] Final report: branch counts by ownership class and district, succession-flagged independents, open proposals count, and known gaps.
