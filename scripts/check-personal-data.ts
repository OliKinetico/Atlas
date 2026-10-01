// Proves no personal contact fields are stored or cached (Phase 3 acceptance, ruling 0R.1).
// Checks: (1) every JSON file under /cache for forbidden keys and for email- or phone-shaped
// values; (2) every raw_source_rows payload in the database for the same; (3) any key outside
// the per-source allowlist. PRS branch entries (BranchListJson) are checked against the branch
// allowlist and must never carry phone, email or display-flag fields (gate A1 ruling 1).
// Reports counts and offending key NAMES only, never values.
//
// Usage: pnpm tsx scripts/check-personal-data.ts      (exit code 1 on any finding)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { PRS_ALLOWLIST, PRS_BRANCH_ALLOWLIST } from "./prs-fetch";

const FORBIDDEN_KEYS = [
  "fdTitle", "fdFirstName", "fdLastName", "fdTelephoneNo", "fdEmail", "fdUserId", "fdUserName",
  "fdSubmitedBY", "fdSubmitedByPosition", "ReEnterEmail", "ActivationLink", "CareOf", "RegAddress.CareOf",
];
const KEY_PATTERN = /(e-?mail|phone|tel(ephone)?$|mobile|fax|first_?name|last_?name|surname|forename|contact|careof)/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const UK_PHONE = /(?:\+44\s?|\b0)(?:\d\s?){9,10}\b/;
const CH_KEYS = new Set([
  "company_number", "name", "status", "category", "address_lines", "post_town", "county", "postcode",
  "outcode", "sic_codes", "incorporated_on", "accounts_category", "last_accounts_made_up_to", "likely_rmc", "likely_rmc_basis", "low_priority",
]);
const PRS_KEYS = new Set<string>([...PRS_ALLOWLIST, "BranchListJson"]);
const BRANCH_KEYS = new Set<string>(PRS_BRANCH_ALLOWLIST);
const BRANCH_FORBIDDEN = ["fdTelephoneNo", "fdEmail", "fdDisplayAddress", "fdDisplayTelephone", "fdDisplayEmail"];
let branchEntries = 0;

/** A PRS record: top level against the PRS allowlist, each branch entry against the branch one. */
function walkPrs(r: unknown, where: string) {
  walk(r, where, PRS_KEYS);
  const list = r && typeof r === "object" ? (r as { BranchListJson?: unknown }).BranchListJson : undefined;
  if (list === undefined) return;
  if (!Array.isArray(list)) return void findings.push({ where, issue: "BranchListJson is not a parsed array" });
  for (const b of list) {
    branchEntries++;
    for (const k of Object.keys(b ?? {})) {
      if (BRANCH_FORBIDDEN.includes(k)) findings.push({ where, issue: `branch entry has forbidden key "${k}"` });
      if (!BRANCH_KEYS.has(k) && !/^(fd)?(branch)?id$/i.test(k)) findings.push({ where, issue: `branch key "${k}" not on allowlist` });
    }
  }
}

type Finding = { where: string; issue: string };
const findings: Finding[] = [];

function walk(v: unknown, where: string, allowed?: Set<string>) {
  if (Array.isArray(v)) return v.forEach((x) => walk(x, where, allowed));
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.includes(k) || KEY_PATTERN.test(k)) findings.push({ where, issue: `forbidden key "${k}"` });
      if (allowed && !allowed.has(k)) findings.push({ where, issue: `key "${k}" not on allowlist` });
      walk(x, where); // nested objects are not record-level, so no allowlist below the top
    }
    return;
  }
  if (typeof v === "string") {
    if (EMAIL.test(v)) findings.push({ where, issue: "email-shaped value" });
    if (UK_PHONE.test(v)) findings.push({ where, issue: "phone-shaped value" });
  }
}

function files(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  } catch {
    return [];
  }
}

async function main() {
  const cacheFiles = files("cache").filter((f) => f.endsWith(".json"));
  for (const f of cacheFiles) {
    const data = JSON.parse(readFileSync(f, "utf8"));
    if (f.startsWith(join("cache", "prs")) && /page-\d+\.json$/.test(f)) data.forEach((r: unknown) => walkPrs(r, f));
    else if (f === join("cache", "ch", "candidates.json")) data.candidates.forEach((r: unknown) => walk(r, f, CH_KEYS));
    else walk(data, f);
  }
  console.log(`cache: ${cacheFiles.length} JSON files scanned`);

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let n = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("raw_source_rows").select("source, source_record_id, payload").range(from, from + 999);
    if (error) throw new Error(`raw_source_rows: ${error.message}`);
    for (const r of data ?? []) if (r.source === "prs") walkPrs(r.payload, "raw_source_rows prs");
    else walk(r.payload, `raw_source_rows ${r.source}`, CH_KEYS);
    n += data?.length ?? 0;
    if (!data || data.length < 1000) break;
  }
  console.log(`raw_source_rows: ${n} payloads scanned; branch entries checked (cache + db): ${branchEntries}`);

  const grouped = new Map<string, number>();
  for (const f of findings) {
    const k = `${f.where.replace(/page-\d+\.json$/, "page-*.json")}: ${f.issue}`;
    grouped.set(k, (grouped.get(k) ?? 0) + 1);
  }
  for (const [k, c] of grouped) console.log(`FINDING ${k} (x${c})`);
  console.log(findings.length ? `${findings.length} finding(s)` : "PASS: no personal contact fields or values found");
  if (findings.length) process.exit(1);
}

main().catch((e) => {
  console.error("check-personal-data failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
