// Phase 3 section D (read-only): which Companies House candidates are really agents?
// Tests signals already in the BasicCompanyData snapshot against the 4,939 candidates.
// Reads the snapshot with DuckDB, the candidate extract, the postcodes.io cache and the PRS
// cache. Writes nothing to the database. Prints value tables, signal counts and samples.
//
// Usage: pnpm tsx scripts/ch-signals.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { isLikelyRmc, matchesBroadNameRule, type ChCandidate } from "./ch-candidates";
import { loadLookup, loadSurreyDistricts, normPostcode } from "./geocode";
import { readPrsCache } from "./prs-fetch";

const csv = join("data", readdirSync("data").filter((n) => /^BasicCompanyDataAsOneFile-.*\.csv$/.test(n)).sort().pop()!);
const cands = (JSON.parse(readFileSync("cache/ch/candidates.json", "utf8")) as { candidates: ChCandidate[] }).candidates;
const outcodes = new Set(Object.keys(JSON.parse(readFileSync("notes/phase0-surrey-outcodes.json", "utf8")).inscope));

const big = (v: unknown) => (typeof v === "bigint" ? Number(v) : v);
const jsonish = (rows: Record<string, unknown>[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, big(v)])));

// Existing four-word rule (0R.5) and the broader rule under test (signal f).
const RMC4 = { test: isLikelyRmc };
const broadName = matchesBroadNameRule;

/** Deterministic PRNG so the samples are reproducible. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function sample<T>(xs: T[], n: number, seed: number) {
  const r = rng(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

async function main() {
  const db = await (await DuckDBInstance.create(":memory:")).connect();
  await db.run(`create table cand (n varchar)`);
  const app = await db.createAppender("cand");
  for (const c of cands) {
    app.appendVarchar(c.company_number);
    app.endRow();
  }
  app.closeSync();
  await db.run(`create view raw as select * from read_csv('${csv}', header = true, all_varchar = true)`);
  await db.run(`create table c as
    select trim(r.CompanyNumber) as company_number, trim(r.CompanyName) as name, r.CompanyCategory as category,
      r."Accounts.AccountCategory" as accounts_category, r."Accounts.LastMadeUpDate" as last_made_up,
      list_filter([r."SICCode.SicText_1", r."SICCode.SicText_2", r."SICCode.SicText_3", r."SICCode.SicText_4"],
                  x -> x is not null and trim(x) <> '') as sic
    from raw r join cand on trim(r.CompanyNumber) = cand.n`);

  const show = async (title: string, sql: string) => {
    console.log(`\n## ${title}`);
    console.table(jsonish((await db.runAndReadAll(sql)).getRowObjects()));
  };
  console.log(`snapshot: ${csv}`);
  await show("CompanyCategory values (candidates)", `select category, count(*) n from c group by 1 order by 2 desc`);
  await show("Accounts.AccountCategory values (candidates)", `select accounts_category, count(*) n from c group by 1 order by 2 desc`);
  await show("Top SIC values (candidates)", `select s, count(*) n from (select unnest(sic) s from c) group by 1 order by 2 desc limit 15`);

  const rows = jsonish(
    // SIC list joined in SQL: DuckDB list values do not arrive as JS arrays.
    (await db.runAndReadAll(`select company_number, name, category, accounts_category, last_made_up, array_to_string(sic, '|') as sic from c`)).getRowObjects(),
  ) as { company_number: string; name: string; category: string | null; accounts_category: string | null; last_made_up: string | null; sic: string | null }[];
  if (rows.length !== cands.length) throw new Error(`joined ${rows.length} rows, expected ${cands.length}`);

  // In scope from the full postcode's district code (0R.6).
  const lookup = loadLookup();
  const surrey = new Set(loadSurreyDistricts().codes);
  const byNum = new Map(cands.map((c) => [c.company_number, c]));
  const inScope = (n: string) => {
    const g = lookup[normPostcode(byNum.get(n)!.postcode)];
    return g?.status === "ok" && !!g.admin_district_code && surrey.has(g.admin_district_code);
  };

  // Known agents: CH candidates whose company number a PRS member (in the approved outcodes) lists.
  const prsNumbers = new Set<string>();
  const seen = new Set<string>();
  for (const { record } of readPrsCache()) {
    const id = String(record.fdId);
    if (seen.has(id)) continue;
    seen.add(id);
    const pc = normPostcode(record.fdPostCode);
    const g = lookup[pc];
    const oc = g?.status === "ok" ? g.outcode : pc.slice(0, -3);
    const listed = String(record.fdRegisteredCoNo ?? "").toUpperCase().replace(/\s/g, "");
    if (outcodes.has(oc) && listed) prsNumbers.add(listed.padStart(8, "0"));
  }
  const known = new Set(rows.filter((r) => prsNumbers.has(r.company_number)).map((r) => r.company_number));

  // Postcode sharing (signal g).
  const pcCount = new Map<string, number>();
  for (const c of cands) pcCount.set(c.postcode, (pcCount.get(c.postcode) ?? 0) + 1);

  type Sig = "a" | "b" | "c" | "d" | "e" | "f" | "g";
  const labels: Record<Sig, string> = {
    a: "a. limited by guarantee",
    b: "b. accounts dormant / no accounts filed",
    c: "c. SIC 98000",
    d: "d. 68320 without 68310",
    e: "e. also 68100 or 68209",
    f: "f. broader name rule",
    g: "g. RO postcode shared by >=5 candidates",
  };
  const flags = new Map<string, Set<Sig>>();
  for (const r of rows) {
    const sic = (r.sic ?? "").split("|").map((s) => s.trim().slice(0, 5));
    if (!sic.includes("68310") && !sic.includes("68320")) throw new Error(`${r.company_number}: SIC parse failed`);
    const s = new Set<Sig>();
    if (/guarantee/i.test(r.category ?? "")) s.add("a");
    if (/^(dormant|no accounts filed)$/i.test((r.accounts_category ?? "").trim())) s.add("b");
    if (sic.includes("98000")) s.add("c");
    if (sic.includes("68320") && !sic.includes("68310")) s.add("d");
    if (sic.includes("68100") || sic.includes("68209")) s.add("e");
    if (broadName(r.name)) s.add("f");
    if ((pcCount.get(byNum.get(r.company_number)!.postcode) ?? 0) >= 5) s.add("g");
    flags.set(r.company_number, s);
  }

  const count = (pred: (n: string) => boolean) => {
    const all = rows.filter((r) => pred(r.company_number));
    return { total: all.length, in_scope: all.filter((r) => inScope(r.company_number)).length, known_agents_flagged: all.filter((r) => known.has(r.company_number)).length };
  };
  const has = (n: string, s: Sig) => flags.get(n)!.has(s);
  const acct = new Map(rows.map((r) => [r.company_number, r.accounts_category]));
  const sigs = Object.keys(labels) as Sig[];

  console.log(`\ncandidates: ${rows.length}; in scope: ${rows.filter((r) => inScope(r.company_number)).length}; known agents (CH candidate listed by a PRS member): ${known.size}`);
  console.log("\n## Each signal alone (any overlap allowed)");
  console.table(Object.fromEntries(sigs.map((s) => [labels[s], count((n) => has(n, s))])));
  console.log("\n## Each signal exclusively (flagged by this signal and no other)");
  console.table(Object.fromEntries(sigs.map((s) => [labels[s], count((n) => has(n, s) && flags.get(n)!.size === 1)])));
  console.log("\n## Pairwise overlaps (total)");
  console.table(Object.fromEntries(sigs.map((s) => [s, Object.fromEntries(sigs.map((t) => [t, count((n) => has(n, s) && has(n, t)).total]))])));
  console.log("\n## Combinations");
  console.table({
    "existing 4-word rule": count((n) => RMC4.test(byNum.get(n)!.name)),
    "a or b or c or f": count((n) => ["a", "b", "c", "f"].some((s) => has(n, s as Sig))),
    "a or c or f": count((n) => ["a", "c", "f"].some((s) => has(n, s as Sig))),
    "a or f (proposed hide rule)": count((n) => has(n, "a") || has(n, "f")),
    "b split: DORMANT": count((n) => /^dormant$/i.test((acct.get(n) ?? "").trim())),
    "b split: NO ACCOUNTS FILED": count((n) => /^no accounts filed$/i.test((acct.get(n) ?? "").trim())),
    "a or b or c or f or g": count((n) => ["a", "b", "c", "f", "g"].some((s) => has(n, s as Sig))),
    "any of a-g": count((n) => flags.get(n)!.size > 0),
    "none of a-g": count((n) => flags.get(n)!.size === 0),
  });

  console.log("\n## Top 20 registered-office postcodes by candidate count");
  console.table(
    [...pcCount]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 20)
      .map(([postcode, n]) => ({ postcode, candidates: n, known_agents: cands.filter((c) => c.postcode === postcode && known.has(c.company_number)).length })),
  );

  const flaggedAbcf = rows.filter((r) => ["a", "b", "c", "f"].some((s) => has(r.company_number, s as Sig)));
  const unflagged = rows.filter((r) => flags.get(r.company_number)!.size === 0);
  const fmt = (r: (typeof rows)[number]) => `${r.name}  [${r.company_number}; ${[...flags.get(r.company_number)!].join("") || "-"}${inScope(r.company_number) ? "; in scope" : ""}]`;
  console.log(`\n## Sample of 40 flagged by a, b, c or f (of ${flaggedAbcf.length})`);
  sample(flaggedAbcf, 40, 20261001).forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. ${fmt(r)}`));
  console.log(`\n## Sample of 40 flagged by no signal (of ${unflagged.length})`);
  sample(unflagged, 40, 20261002).forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. ${fmt(r)}`));

  console.log("\n## Known agents wrongly flagged, by signal (company names)");
  for (const s of sigs) {
    const hit = rows.filter((r) => known.has(r.company_number) && has(r.company_number, s));
    if (hit.length && s !== "d" && s !== "g") console.log(`${labels[s]}: ${hit.map((r) => r.name).join(" | ")}`);
  }
}

main().catch((e) => {
  console.error("ch-signals failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
