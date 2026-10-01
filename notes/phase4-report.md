# Phase 4 report — Companies House matching and enrichment

Run unattended on 1–2 October 2026 (UTC). Scope: notes/phase4-scope.md. Provisional rulings
P1–P8: notes/decisions.md. Evidence is reproducible with `pnpm tsx scripts/phase4-report.ts`.

## Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| Counts reported: exact-linked, proposals, unlinked | Met | Below |
| 10 random exact links with evidence | Met | Below (seeded sample: 5 PRS-derived, 5 CH rows) |
| No auto-link without exact-tier evidence | Met | 5,329 links; 0 fail the exact-tier check; 0 cite a non-exact basis |
| API calls within the documented rate limit | Met | 8,653 requests, all HTTP 200; max 492 in any 300 s window (limit 600); minimum gap 608 ms |

## Counts

Branch rows: 5,436 = 4,939 `ch_registered_office` + 486 `member_address` + 11 `branch`.

| | Exact-linked | Unlinked |
|---|---|---|
| ch_registered_office | 4,939 (3,087 in scope) | 0 |
| member_address | 381 (241 in scope) | 105 (68 in scope) |
| branch (via parent member) | 9 (7 in scope) | 2 (2 in scope) |
| **Total** | **5,329** | **107** |

- Exact links by rule: register company number in snapshot 5,291 (4,939 CH rows + 352 PRS rows);
  exact name + postcode 38. 199 PRS links satisfy both rules.
- PRS members: 488 (486 with a member row + parents 14143 and 19425 with in-area branches only):
  383 linked, 104 no exact signal, 1 conflict (21287).
- Proposals created (kind `branch_company`, all pending): 35 on 32 subjects. By basis:
  exact name, different postcode 22; similar name (Jaro-Winkler >= 0.9), same postcode 12;
  listed number (conflict) 1; pending duplicate proposal (conflict) 1.
- Ruling 15 conflicts marked: member 21287 (09882517, 09915156: both kinds), member 29679
  (11694821, 12309380), member 52673 (13226030, SC234181). None is linked.
- Companies: 5,134 rows inserted from the bulk snapshot (every linked company). 2,829 of them
  enriched from the API (P5): 9,452 officers (5,127 active), 4,526 PSCs (338 corporate with a UK
  company number), 2,829 PSC chains (depth 0: 2,598; 1: 182; 2: 30; 3: 5; 4: 7; 5: 7).
- Chains with notes (25): 24 stop at multiple active UK corporate PSCs (not followed, P7):
  06297263, 07067242, 07749029, 09748247, 11339187, 11375212, 11746603, 12169213, 12810084,
  13044572, 13943178, 15150639, 15150644, 15150651, 15511657, 15660305, 15788713, 16091796,
  16391472, 16578549, 16682059, 16785654, 17297165, OC373689; 1 stops at a cycle: 06716956.

## Unlinked PRS rows in scope (70)

Member IDs (`*` = has pending proposals; `(branch)` = branch-list row):
50089, 15238, 12755, 47606, 51649, 47002, 30527, 1884, 18286*, 27939, 55533, 48318, 14115, 22984, 29679*, 1759 (branch), 1475, 23837, 18227*, 18956*, 12271, 21287*, 18347, 55113, 12063 (branch), 20295, 18936*, 1210, 57274*, 39617, 1759, 44414, 737, 16427, 12565, 42101, 58455*, 49613, 713, 59377*, 40678*, 50679, 2642*, 12063, 53029*, 27986*, 13704, 18496, 51798, 18269, 31032, 16819*, 25409*, 48035, 12124, 35871, 58208*, 4322, 15786, 57151, 8124, 14070, 16338, 57896, 13212, 1565, 8342, 32742, 37289, 50577*

## Listed company numbers not found in the snapshot (10; left unlinked, never corrected)

| Member | Number as listed |
|---|---|
| 15238 | 02626915 |
| 12755 | 50723 |
| 47606 | 15499269 |
| 1884 | 0 |
| 23837 | 8429 |
| 4084 | 2295880 |
| 58895 | 1682933 |
| 35871 | 14363914 |
| 46086 | 11980276 |
| 54928 | 16781267 |

## Exact links where the listed name differs from the company name (54, for spot-checking)

Linked by the plan's first exact rule (listed number exists in the snapshot); `evidence.name_matches = false`. Many differences are cosmetic ("&" vs "and", "T/A ..." suffixes) because the plan's normalisation deletes "&" rather than reading it as "and".

| Member | Listed legal name | Company | Company name |
|---|---|---|---|
| 11631 | Logik Property Management Limited T/A Logik Property | 11308384 | LOGIK PROPERTY MANAGEMENT LIMITED |
| 20171 | Brookwood Lettings & Management Ltd | 07824287 | BROOKWOOD LETTINGS AND MANAGEMENT LTD |
| 4010 | Aspect Sales & Lettings Ltd | 06563021 | ASPECT SALES AND LETTINGS LIMITED |
| 19394 | Aston Green Estate Agents T/A S J Smith Estate Agents | 07908534 | ASTON GREEN PROPERTIES LTD |
| 19394 | Aston Green Estate Agents T/A S J Smith Estate Agents | 07908534 | ASTON GREEN PROPERTIES LTD |
| 12923 | Boddy & Edwards | OC359911 | SPECIALIST PROPERTY ADVISERS UK LLP |
| 4061 | Rice & Roman LIMITED | 08116091 | RICE AND ROMAN LIMITED |
| 4061 | Rice & Roman LIMITED | 08116091 | RICE AND ROMAN LIMITED |
| 46748 | Icona Asset Management | 11414226 | ICONA ASSET MANAGEMENT LTD |
| 5154 | Skelton Young Ltd T/A Mapp & Weston | 06853276 | SKELTON YOUNG LTD |
| 26023 | CTSF Ltd T/a Cerca Trova Property Consultants | 13061004 | CTSF LTD |
| 55578 | Birchwood Commercial td | 04306804 | BIRCHWOOD COMMERCIAL LTD |
| 12254 | Richards & Co (Uk) Ltd | 04500292 | RICHARDS & CO.(UK) LIMITED |
| 55268 | Stories. | 16839770 | STORIES HOMES LIMITED |
| 12408 | EDEN Lettings & Sales Ltd | 10648016 | EDEN LETTINGS AND SALES LIMITED |
| 12811 | Abraham Adam and Co Ltd | 07725557 | ABRAHAM ADAM & CO. LIMITED |
| 44333 | One Degree North | 12170912 | ONE DEGREE NORTH LTD |
| 14890 | SLM Property Services Ltd T/A SLM Property | 11789901 | SLM PROPERTY SERVICES LTD |
| 46484 | ZI Property Solutions | 15725364 | ZI PROPERTY SOLUTIONS LTD |
| 34626 | Derwent Hillside | 11305859 | DERWENT HILLSIDE LIMITED |
| 60685 | Harbour & May Residential | 17447594 | HARBOUR & MAY RESIDENTIAL LTD |
| 11185 | PMF Property Management | 11210708 | PMF PROPERTY MANAGEMENT LTD |
| 59558 | KB Leader Homes | 16177469 | KB LEADER HOMES LTD |
| 2116 | Lewis White Estate Agents | 07131919 | LEWIS & WHITE ESTATE AGENTS LIMITED |
| 55236 | Bright Venture Partners | 15414577 | BRIGHT VENTURE PARTNERS LTD |
| 1262 | Park & Bailey Lettings & Management Ltd | 03874896 | PARK & BAILEY LETTINGS AND MANAGEMENT LIMITED |
| 1262 | Park & Bailey Lettings & Management Ltd | 03874896 | PARK & BAILEY LETTINGS AND MANAGEMENT LIMITED |
| 58381 | Rooms Make A Home Portfolio | 16951387 | ROOMS MAKE A HOME PORTFOLIO LIMITED |
| 42222 | EDGEFIELD ESTATE MANAGEMENT (FARNHAM) LIMITED | 09630246 | EDGEFIELD ESTATES MANAGEMENT (FARNHAM) LIMITED |
| 8168 | Lintott Property Limited T/A Lintott and Company | 09531835 | LINTOTT PROPERTY LIMITED |
| 4019 | Barratt Sales & Lettings Limited | 07944278 | BARRATT SALES AND LETTINGS LIMITED |
| 27227 | Dreams Unlimited Property Consultants Ltd | 11995672 | DREAMS UNLIMITED CONSULTANTS LIMITED |
| 21742 | Business Venture Ltd T/A Property Venture | 06343172 | BUSINESS VENTURE LTD |
| 32111 | The Enhanced Property Media Group Limited T/A Te Koop | 14000066 | THE ENHANCED PROPERTY MEDIA GROUP LIMITED |
| 3445 | Sherwoods Consultants Ltd T/A Sherwoods International Properties | 03479423 | SHERWOODS CONSULTANTS LIMITED |
| 43295 | M&F Lettings Ltd | 15360177 | M&F PROPERTY GROUP LTD |
| 43281 | Cocoon UK | 07993326 | COCOON (UK) LTD |
| 40171 | Tunridge Property Managment LLP | OC447610 | TUNRIDGE PROPERTY MANAGEMENT LLP |
| 54169 | Maria Foti | 06277461 | AJEX LIMITED |
| 49999 | Callum Wand Estates | 13458800 | CALLUM WAND ESTATES LIMITED |
| 52645 | MILLERHUDSON MANAGEMENT LTD | 15841224 | AUTOSTAY UK LTD |
| 60930 | Royal Dry Cleaners | 14500979 | CHURCHILL REAL ESTATE LIMITED |
| 4258 | SAI Estates | 07405122 | SACHIN AGILE INDUSTRIES (SAI) LTD |
| 4417 | Langtry 42 Limited T/A Hills & Downham | 07202395 | LANGTRY 42 LIMITED |
| 23653 | Smart Move Residential | 12825713 | SMART MOVE RESIDENTIAL LIMITED |
| 36342 | Inventory Clerks 4 U LTD | 09089631 | INVENTORY CLERKS 4U LTD |
| 50349 | SOPHIE AND LUNA LIMITED T/A SB MANAGEMENT | 09367879 | SOPHIE AND LUNA LIMITED |
| 37821 | Martin & Co (Horsham) | 03458071 | REDHILL PROPERTY SERVICES LIMITED |
| 47726 | WJO Property | 15553090 | WJOPROPERTY LTD |
| 9760 | Hampton-Heath LTD | 10894014 | HAMPTON HEATH LTD |
| 57903 | Rapid Returns | 12856240 | RAPID RETURNS LIMITED |
| 55237 | JF Property Management | 15251946 | JF PROPERTY MANAGEMENT LTD |
| 12564 | Howard Morley & Sons | 07372584 | HOWARD MORLEY & SONS LIMITED |
| 14143 | Ibbett Mosely Surveyors LLP | OC341637 | IBBETT MOSELY SURVEYORS LIMITED LIABILITY PARTNERSHIP |

## 10 random exact links (seed 20261002)

| Branch | Type | Member | Listed name | Listed no. | Branch postcode | Company | Company name | Rule(s) | RO postcode |
|---|---|---|---|---|---|---|---|---|---|
| e520ff09 | member_address | 59243 | Newsham Gray Ltd | 16535858 | GU7 1LW | 16535858 | NEWSHAM GRAY LTD | register_company_number_in_snapshot | PO16 8SS |
| 3560d771 | member_address | 26449 | Bee Property Group Limited | - | GU16 9QF | 13201119 | BEE PROPERTY GROUP LIMITED | exact_name_and_postcode | GU16 9QF |
| 73b6edf7 | member_address | 58739 | Dodd and Sons Property Ltd | 17174916 | CR5 1SJ | 17174916 | DODD AND SONS PROPERTY LTD | register_company_number_in_snapshot + exact_name_and_postcode | CR5 1SJ |
| 8a109b7b | member_address | 52464 | Wyndham Row LTD | 16478540 | KT7 0XA | 16478540 | WYNDHAM ROW LTD | register_company_number_in_snapshot + exact_name_and_postcode | KT7 0XA |
| 027bf1e3 | member_address | 57273 | Baseri London Ltd | - | TW14 0BY | 15168373 | BASERI LONDON LTD | exact_name_and_postcode | TW14 0BY |
| ff8b81d2 | ch_registered_office | - | BROMPTON CLOSE REIGATE (MANAGEMENT) LTD | - | RH2 8FP | 13346119 | BROMPTON CLOSE REIGATE (MANAGEMENT) LTD | register_company_number_in_snapshot | RH2 8FP |
| 855282b8 | ch_registered_office | - | BRIDGEWAY LIVING CIC | - | SM7 1RN | 16919609 | BRIDGEWAY LIVING CIC | register_company_number_in_snapshot | SM7 1RN |
| bb7e9c56 | ch_registered_office | - | VISH BALA LTD | - | CR8 1DD | 16269880 | VISH BALA LTD | register_company_number_in_snapshot | CR8 1DD |
| 82c22ae1 | ch_registered_office | - | NORTHINGTON LIMITED | - | CR8 5DJ | 03922795 | NORTHINGTON LIMITED | register_company_number_in_snapshot | CR8 5DJ |
| 99c3b27e | ch_registered_office | - | H.T.M. SERVICES LTD | - | KT10 0PX | 04941207 | H.T.M. SERVICES LTD | register_company_number_in_snapshot | KT10 0PX |

## Data written

| Run (ingest_runs) | Table | Inserted | Updated |
|---|---|---|---|
| link-companies 992cfc7a | companies | 5,134 | 0 |
| | branch_company_links | 5,329 | 0 |
| | match_proposals | 35 | 0 |
| link-companies ee1c76b7 (second run) | all three | 0 | 0 |
| ch-enrich 19293af0 | companies | 0 | 2,829 (API profile replaces snapshot values) |
| | officers | 9,452 | 0 |
| | pscs | 4,526 | 0 |
| | psc_chains | 2,829 | 0 |
| ch-enrich cc51d785 (interrupted, see notes) | officers/companies | 0 new | re-wrote identical values only |
| ch-enrich 546b1558 (second run) | all four | 0 | 0 |

No rows deleted. No `manually_edited` rows exist (0 skipped). Run cc51d785 was stopped by
process ID because change detection compared `fetched_at` as text (`Z` vs `+00:00`) and was
re-writing identical values; its snapshots and restore commands are recorded in its row.

### Undo all Phase 4 data (in this order)

1. Enrichment, using the snapshots of run 19293af0 (taken before it wrote):
```sql
delete from public.psc_chains t where not exists (select 1 from public.psc_chains_snapshot_20261001_225709093 s where s.company_number = t.company_number);
delete from public.pscs t where not exists (select 1 from public.pscs_snapshot_20261001_225708940 s where s.id = t.id) and t.manually_edited = false;
delete from public.officers t where not exists (select 1 from public.officers_snapshot_20261001_225708788 s where s.id = t.id) and t.manually_edited = false;
```
   then run the `companies` restore line stored in ingest_runs 19293af0 (reverts the 2,829
   company updates to their snapshot values).
2. Matching, using the snapshots of run 992cfc7a:
```sql
delete from public.match_proposals t where not exists (select 1 from public.match_proposals_snapshot_20261001_212302174 s where s.id = t.id);
delete from public.branch_company_links t where not exists (select 1 from public.branch_company_links_snapshot_20261001_212301797 s where s.branch_id = t.branch_id and s.company_number = t.company_number);
delete from public.companies t where not exists (select 1 from public.companies_snapshot_20261001_212301296 s where s.company_number = t.company_number) and t.manually_edited = false;
```

## Gaps and blocked items

- **Live verification (merge gate) blocked.** The branch now builds on Vercel (deployment
  dpl_GZo6HadJrHJiqTp6veF6QwWc83uB, READY, after P8 added vercel.json). Three attempts to
  fetch it returned the Vercel Authentication (SSO) redirect, so live checks could not be run.
  The project also has no environment variables set; sign-in cannot work live until Oli sets
  them. Not bypassed: SSO protection was not changed.
- 2,305 linked companies (outside Surrey or likely residents' management companies) have no
  officers or PSCs (P5).
- 70 in-scope PRS rows have no company link (listed above); 17 of them have pending proposals (1 is the conflict member 21287).
- 10 listed company numbers are not in the snapshot (listed above), including member 1884's
  listed value "0".
- PSC entries with no name: 0 found, so none skipped.
- Agents registered only with The Property Ombudsman are not loaded by any phase.
- Members in the 78 outcodes with a company number but no `ch_registered_office` row: 192
  (125 in scope).
