# Phase 0 recon — findings (1 October 2026)

Scratch notes only. No build code. Awaiting Oli's go-ahead.

## 0.1 Redress registers

### TPO (The Property Ombudsman) — classification (b), with caveats
- robots.txt (www.tpos.co.uk), quoted: `User-agent: *` / `Disallow: /wp-content/uploads/wpforms/` and `User-agent: *` / `Disallow:` (empty, i.e. everything else allowed) / `Sitemap: https://www.tpos.co.uk/sitemap_index.xml`.
- No website terms-of-use page exists in page-sitemap.xml (only terms-of-reference, privacy-cookies). Neither contains a clause on automated access or reuse of the member directory.
- Search by postcode/area: the public form (`/business-search/?business-name=&location=`) 302-redirects to /make-a-complaint/ for plain HTTP clients; Cloudflare challenge + reCAPTCHA on site. Not usable programmatically.
- Full enumeration: 38 `businesses-sitemap*.xml` files listing 37,802 URLs (37,801 member pages + the index).
- Per-page fields (sample: /business-search/cheffins/): branch address + postcode, registered name, phone, email, website, **Services** (e.g. "Residential Sales, Residential Lettings"). One page per branch.
- No company number, no explicit member/branch ID (URL slug + WordPress post id only).
- One page (/business-search/the-property-finder/) returned 403 from Cloudflare.

### PRS — now "Property Redress" (www.theprs.co.uk 301 → www.propertyredress.co.uk) — classification (b), with caveats
- robots.txt (www.propertyredress.co.uk), quoted: `User-agent: *` / `Disallow: ` (empty) / `Sitemap: https://www.propertyredress.co.uk/sitemap.xml`.
- portal.propertyredress.co.uk has no robots.txt (302 to NotFound).
- No website terms-of-use page found. Terms of Reference (7th ed.) L2(g): "include on our website a public search facility, so anyone wishing to make a complaint can check whether the person or business is our member".
- Agent finder (/agent-finder) calls an unauthenticated JSON endpoint from the page's own JS:
  `https://www.portal.propertyredress.co.uk/propertyagent/GetMemberByAPI?companyName=&postcode=<prefix>&status=Active&page=<n>` — 10 records/page; postcode is a prefix match on a stored string (formats vary: "GU147GZ", "GU15 1HB").
- Fields: fdId (member ID), fdCompanyName, TradingName, fdCorrespondanceAddressLine1/2, fdPostCode, fdRegisteredCoNo (company number, populated on 3 of first 4 sampled), MemberStatus. No lettings/sales flag (fdWorkType null). Member-level, not branch-level (BranchList empty in sample).
- **Personal data:** endpoint returns contact first/last name, email and phone on 10/10 sampled records — more than the page displays (UI gates them on fdDisplay* flags).
- Reliability: GU-prefix count run hit ~1 connection reset per 6 requests at 1 req/2s; page 58 returned a non-list payload. ≥57 pages / ≥570 active GU-prefix records before stopping (2 attempts).

## 0.2 Companies House
- API key: NOT available in this session (env var added after session start). Endpoint reachable (unauthenticated call → 401). Test on 14991567 pending.
- Rate limit (developer guidelines, quoted): "You can make up to 600 requests within a 5 minute period." 429 for remainder of window; "We reserve the right to ban without notice applications that regularly exceed or attempt to bypass the rate limits."
- Bulk snapshot: https://download.companieshouse.gov.uk/BasicCompanyDataAsOneFile-2026-10-01.zip — 493,990,184 bytes (page says 471Mb); last-modified 1 Oct 2026 08:10:21 GMT. Also 7 parts (~50–70Mb each).

## 0.3 postcodes.io
- Bulk: POST https://api.postcodes.io/postcodes, max 100 (101 → 400 "Up to 100 postcodes can be bulk requested at a time").
- Admin fields: admin_district, admin_county, admin_ward, parish, region, country, plus `codes.*` (ONS GSS codes, e.g. admin_district E07000209).
- GU1 1AA → admin_district "Guildford", admin_county "Surrey". Returns the 11 district names today.
- Surrey LGR: 11 districts + Surrey CC abolished on vesting day 1 April 2027; replaced by East Surrey (Elmbridge, Epsom and Ewell, Mole Valley, Reigate and Banstead, Tandridge) and West Surrey (Guildford, Runnymede, Spelthorne, Surrey Heath, Waverley, Woking). Source: surreycc.gov.uk LGR pages.

## 0.4 Surrey outcodes
Method: probed GET /outcodes/{AREA}{0..99} for areas GU KT RH TW SM CR TN SL RG BR SW SE BN ME DA UB W HA (367 valid outcodes); in scope if any admin_district is one of the 11 Surrey districts. Full data in phase0-surrey-outcodes.json.

78 outcodes: CR3, CR5, CR6, CR8, GU1–GU10, GU12, GU14–GU16, GU18–GU27, KT4, KT6–KT24, RH1–RH10, RH12, RH14, RH19, SL4, SL5, SM2, SM3, SM5, SM7, TN8, TN16, TW6, TW12, TW14–TW20.
44 straddle a boundary; 34 wholly Surrey. Branch-level in_scope must use the full postcode's district, not the outcode.
