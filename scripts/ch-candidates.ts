// Phase 3 step 2 (ruling 0R.5): extract Companies House candidate agents from the local
// BasicCompanyData bulk snapshot with DuckDB. Candidates are active companies with SIC 68310
// or 68320 whose registered-office outcode is in the approved 78-outcode search set.
// Surrey scope (in_scope) is decided later from the full postcode's district code, not here.
//
// RegAddress.CareOf is never read: it can name an individual. Only company-level fields leave
// the snapshot. Output: /cache/ch/candidates.json
//
// Usage: pnpm tsx scripts/ch-candidates.ts [path/to/BasicCompanyData.csv]
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

const RMC_PATTERN = /\bresidents\b|\brtm\b|\bfreehold\b|management company/i;
export const isLikelyRmc = (name: string) => RMC_PATTERN.test(name);

export type ChCandidate = {
  company_number: string;
  name: string;
  status: string;
  category: string;
  address_lines: string[];
  post_town: string | null;
  county: string | null;
  postcode: string;
  outcode: string;
  sic_codes: string[];
  incorporated_on: string | null;
  accounts_category: string | null;
  last_accounts_made_up_to: string | null;
  likely_rmc: boolean;
};

function findCsv(): string {
  const arg = process.argv[2];
  if (arg) return arg;
  const f = readdirSync("data").filter((n) => /^BasicCompanyDataAsOneFile-.*\.csv$/.test(n)).sort().pop();
  if (!f) throw new Error("No BasicCompanyDataAsOneFile-*.csv in /data");
  return join("data", f);
}

/** UK date dd/mm/yyyy → yyyy-mm-dd, else null. */
function isoDate(v: unknown): string | null {
  const m = typeof v === "string" ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim()) : null;
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

async function main() {
  const csv = findCsv();
  const outcodes: string[] = Object.keys(
    JSON.parse(readFileSync("notes/phase0-surrey-outcodes.json", "utf8")).inscope,
  );
  if (outcodes.length !== 78) throw new Error(`expected 78 approved outcodes, found ${outcodes.length}`);

  const db = await (await DuckDBInstance.create(":memory:")).connect();
  // all_varchar: keep company numbers like 01234567 intact. Column names in the header carry
  // leading spaces on some fields, so normalise them before selecting.
  await db.run(`create view raw as select * from read_csv('${csv.replace(/'/g, "''")}',
    header = true, all_varchar = true, normalize_names = false)`);
  const cols = (await db.runAndReadAll(`select column_name from (describe raw)`)).getRowObjects().map((r) => String(r.column_name));
  const col = (want: string) => {
    const c = cols.find((x) => x.trim() === want);
    if (!c) throw new Error(`column ${want} missing from snapshot`);
    return `"${c.replace(/"/g, '""')}"`;
  };
  const sic = [1, 2, 3, 4].map((i) => col(`SICCode.SicText_${i}`));
  const pcNorm = `upper(replace(coalesce(${col("RegAddress.PostCode")}, ''), ' ', ''))`;

  const total = (await db.runAndReadAll(`select count(*) as n from raw`)).getRowObjects()[0].n;
  const sql = `
    select
      ${col("CompanyNumber")} as company_number,
      ${col("CompanyName")} as name,
      ${col("CompanyStatus")} as status,
      ${col("CompanyCategory")} as category,
      ${col("RegAddress.AddressLine1")} as line1,
      ${col("RegAddress.AddressLine2")} as line2,
      ${col("RegAddress.PostTown")} as post_town,
      ${col("RegAddress.County")} as county,
      ${col("RegAddress.PostCode")} as postcode,
      ${pcNorm} as pc_norm,
      ${sic.map((s, i) => `${s} as sic${i + 1}`).join(", ")},
      ${col("IncorporationDate")} as incorporated_on,
      ${col("Accounts.AccountCategory")} as accounts_category,
      ${col("Accounts.LastMadeUpDate")} as last_made_up
    from raw
    where ${col("CompanyStatus")} = 'Active'
      and (${sic.map((s) => `left(coalesce(${s}, ''), 5) in ('68310', '68320')`).join(" or ")})
      and length(${pcNorm}) between 5 and 7
      and left(${pcNorm}, length(${pcNorm}) - 3) in (${outcodes.map((o) => `'${o}'`).join(", ")})`;
  const rows = (await db.runAndReadAll(sql)).getRowObjects();

  const out: ChCandidate[] = rows.map((r) => {
    const pc = String(r.pc_norm);
    const sicCodes = [r.sic1, r.sic2, r.sic3, r.sic4]
      .map((v) => (typeof v === "string" ? v.split(" ")[0].trim() : ""))
      .filter((v) => /^\d{5}$/.test(v));
    const name = String(r.name).trim();
    return {
      company_number: String(r.company_number).trim(),
      name,
      status: String(r.status),
      category: String(r.category ?? ""),
      address_lines: [r.line1, r.line2].map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean),
      post_town: typeof r.post_town === "string" && r.post_town.trim() ? r.post_town.trim() : null,
      county: typeof r.county === "string" && r.county.trim() ? r.county.trim() : null,
      postcode: `${pc.slice(0, -3)} ${pc.slice(-3)}`,
      outcode: pc.slice(0, -3),
      sic_codes: sicCodes,
      incorporated_on: isoDate(r.incorporated_on),
      accounts_category: typeof r.accounts_category === "string" ? r.accounts_category : null,
      last_accounts_made_up_to: isoDate(r.last_made_up),
      likely_rmc: isLikelyRmc(name),
    };
  });

  mkdirSync("cache/ch", { recursive: true });
  writeFileSync("cache/ch/candidates.json", JSON.stringify({ snapshot: csv, extracted_at: new Date().toISOString(), candidates: out }, null, 1));
  const rmc = out.filter((c) => c.likely_rmc).length;
  console.log(`snapshot rows: ${total}; candidates (active, SIC 68310/68320, approved outcode): ${out.length}`);
  console.log(`likely_rmc: ${rmc}; enrichable: ${out.length - rmc}`);
  console.log(`by SIC: 68310=${out.filter((c) => c.sic_codes.includes("68310")).length}, 68320=${out.filter((c) => c.sic_codes.includes("68320")).length}`);
}

if (process.argv[1]?.endsWith("ch-candidates.ts")) {
  main().catch((e) => {
    console.error("ch-candidates failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
