// Phase 3 step 4: build branch rows from the allowlisted PRS cache and the CH candidate
// extract, geocode them from the postcodes.io cache, and load them.
//
//   --dry-run (default)  report counts only; writes nothing.
//   --write-raw          upsert allowlisted records into raw_source_rows (no branch writes).
//   --write-branches     upsert branches. Refuses to run until the open Phase 3 decisions are
//                        recorded in DECISIONS below (see notes/decisions.md).
//
// Only records whose outcode is in the approved 78-outcode set are kept. in_scope comes from
// the full postcode's ONS district code (0R.6). Lookup-then-insert/update (supabase-js upsert
// cannot target the partial unique indexes). Rows with manually_edited = true are skipped.
// Before any run that updates existing rows, the table is snapshotted and the restore command
// written to ingest_runs.
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readPrsCache, type PrsRecord } from "./prs-fetch";
import { loadLookup, loadSurreyDistricts, normPostcode, type Geo } from "./geocode";
import type { ChCandidate } from "./ch-candidates";

// Open decisions (Oli). null = not decided yet; --write-branches refuses while any is null.
const DECISIONS: {
  prsSourceType: "branch" | "head_office" | null;
  emptyTradingName: "use_legal_name" | null;
  chTradingName: "use_company_name" | null;
} = { prsSourceType: null, emptyTradingName: null, chTradingName: null };

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const args = new Set(process.argv.slice(2));
const writeRaw = args.has("--write-raw");
const writeBranches = args.has("--write-branches");

export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\blimited\b/g, "ltd")
    .replace(/\s+/g, " ")
    .trim();
}
const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

type BranchRow = {
  trading_name: string;
  trading_name_norm: string;
  legal_name_as_listed: string | null;
  address_lines: string[];
  postcode: string | null;
  outcode: string | null;
  source_type: "branch" | "head_office" | "ch_registered_office";
  likely_rmc: boolean;
  lat: number | null;
  lng: number | null;
  admin_district: string | null;
  admin_district_code: string | null;
  in_scope: boolean | null;
  redress_scheme: "prs" | null;
  redress_member_id: string | null;
  does_lettings: boolean | null;
  sources: unknown[];
  notes: string | null;
};
type Built = { row: BranchRow; raw: { source: "prs" | "ch_bulk"; id: string; payload: object }; emptyTradingName?: boolean };

function geoFields(pcRaw: string, lookup: Record<string, Geo>, surrey: Set<string>) {
  const g = lookup[normPostcode(pcRaw)];
  if (g?.status === "ok") {
    return {
      postcode: g.postcode,
      outcode: g.outcode,
      lat: g.lat,
      lng: g.lng,
      admin_district: g.admin_district,
      admin_district_code: g.admin_district_code,
      in_scope: g.admin_district_code ? surrey.has(g.admin_district_code) : null,
      geoNote: g.lat == null ? "postcodes.io returned no coordinates" : null,
    };
  }
  const reason = g ? `postcode ${g.status.replace("_", " ")} at postcodes.io` : "postcode missing";
  return {
    postcode: pcRaw || null, // as listed; never corrected
    outcode: null,
    lat: null,
    lng: null,
    admin_district: null,
    admin_district_code: null,
    in_scope: null,
    geoNote: `not geocoded: ${reason}`,
  };
}

/** Outcode from the listed postcode string, without correcting it. */
const listedOutcode = (pc: string) => {
  const n = normPostcode(pc);
  return n.length >= 5 && n.length <= 7 ? n.slice(0, -3) : "";
};

function build() {
  const outcodes = new Set(Object.keys(JSON.parse(readFileSync("notes/phase0-surrey-outcodes.json", "utf8")).inscope));
  const surreyInfo = loadSurreyDistricts();
  const surrey = new Set(surreyInfo.codes);
  const lookup = loadLookup();
  const built: Built[] = [];
  const workTypes = new Map<string, number>();

  // PRS: dedupe by member ID (the same member can appear under several prefixes/pages).
  const prs = new Map<string, PrsRecord>();
  let prsRecords = 0;
  for (const { record } of readPrsCache()) {
    prsRecords++;
    const id = str(record.fdId);
    if (id) prs.set(id, record);
  }
  let prsOutOfArea = 0;
  for (const [id, r] of prs) {
    const pc = str(r.fdPostCode);
    const g = geoFields(pc, lookup, surrey);
    const oc = g.outcode ?? listedOutcode(pc);
    if (!outcodes.has(oc)) {
      prsOutOfArea++;
      continue;
    }
    const wt = str(r.fdWorkType);
    workTypes.set(wt || "(empty)", (workTypes.get(wt || "(empty)") ?? 0) + 1);
    const trading = str(r.TradingName);
    const legal = str(r.fdCompanyName);
    const shown = trading || (DECISIONS.emptyTradingName === "use_legal_name" ? legal : "");
    built.push({
      emptyTradingName: !trading,
      row: {
        trading_name: shown,
        trading_name_norm: normName(shown),
        legal_name_as_listed: legal || null,
        address_lines: [str(r.fdCorrespondanceAddressLine1), str(r.fdCorrespondanceAddressLine2)].filter(Boolean),
        postcode: g.postcode,
        outcode: oc,
        source_type: DECISIONS.prsSourceType ?? "branch",
        likely_rmc: false,
        lat: g.lat,
        lng: g.lng,
        admin_district: g.admin_district,
        admin_district_code: g.admin_district_code,
        in_scope: g.in_scope,
        redress_scheme: "prs",
        redress_member_id: id,
        does_lettings: null, // fdWorkType is empty in the source; never inferred
        sources: [{ source: "prs", member_id: id, membership_status: str(r.MemberStatus) || null, company_number_listed: str(r.fdRegisteredCoNo) || null }],
        notes: g.geoNote,
      },
      raw: { source: "prs", id, payload: r },
    });
  }

  // Companies House registered-office candidates (0R.5).
  const ch = JSON.parse(readFileSync("cache/ch/candidates.json", "utf8")) as { snapshot: string; candidates: ChCandidate[] };
  for (const c of ch.candidates) {
    const g = geoFields(c.postcode, lookup, surrey);
    built.push({
      row: {
        trading_name: DECISIONS.chTradingName === "use_company_name" ? c.name : "",
        trading_name_norm: normName(c.name),
        legal_name_as_listed: c.name,
        address_lines: c.address_lines,
        postcode: g.postcode,
        outcode: g.outcode ?? c.outcode,
        source_type: "ch_registered_office",
        likely_rmc: c.likely_rmc,
        lat: g.lat,
        lng: g.lng,
        admin_district: g.admin_district,
        admin_district_code: g.admin_district_code,
        in_scope: g.in_scope,
        redress_scheme: null,
        redress_member_id: null,
        does_lettings: null,
        sources: [{ source: "ch_bulk", company_number: c.company_number, snapshot: ch.snapshot.split("/").pop(), sic_codes: c.sic_codes }],
        notes: [g.geoNote, "registered office, not a verified branch"].filter(Boolean).join("; "),
      },
      raw: { source: "ch_bulk", id: c.company_number, payload: c },
    });
  }
  return { built, prsRecords, prsUnique: prs.size, prsOutOfArea, workTypes, surreyInfo };
}

/** Probable duplicates (never merged; would go to match_proposals once a kind exists). */
function probableDuplicates(built: Built[]) {
  const prs = built.filter((b) => b.raw.source === "prs");
  const ch = built.filter((b) => b.raw.source === "ch_bulk");
  const byKey = new Map<string, Built[]>();
  for (const b of prs) {
    const k = `${normName(b.row.legal_name_as_listed ?? "")}|${b.row.postcode}`;
    byKey.set(k, [...(byKey.get(k) ?? []), b]);
  }
  const prsSameNamePostcode = [...byKey.values()].filter((v) => v.length > 1).length;
  const chByNumber = new Map(ch.map((b) => [b.raw.id, b]));
  let sameCoSamePc = 0;
  let sameCoDiffPc = 0;
  for (const b of prs) {
    const listed = str((b.raw.payload as PrsRecord).fdRegisteredCoNo).toUpperCase().replace(/\s/g, "");
    const c = listed ? chByNumber.get(listed.padStart(8, "0")) : undefined;
    if (!c) continue;
    if (c.row.postcode === b.row.postcode) sameCoSamePc++;
    else sameCoDiffPc++;
  }
  return { prsSameNamePostcode, prsMemberAlsoChCandidate_samePostcode: sameCoSamePc, prsMemberAlsoChCandidate_diffPostcode: sameCoDiffPc };
}

function tally<T>(items: T[], key: (t: T) => string) {
  const m: Record<string, number> = {};
  for (const i of items) m[key(i)] = (m[key(i)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}

async function snapshot(db: SupabaseClient, table: string) {
  const { data, error } = await db.rpc("snapshot_table", { tbl: table });
  if (error) throw new Error(`snapshot ${table}: ${error.message}`);
  return (data as { snapshot_table: string; restore_command: string }[])[0];
}

async function loadRaw(db: SupabaseClient, built: Built[], runId: string) {
  const { count } = await db.from("raw_source_rows").select("*", { count: "exact", head: true });
  const snap = count ? await snapshot(db, "raw_source_rows") : null;
  const rows = built.map((b) => ({
    source: b.raw.source,
    source_record_id: b.raw.id,
    payload: b.raw.payload,
    fetched_at: new Date().toISOString(),
    ingest_run_id: runId,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("raw_source_rows").upsert(rows.slice(i, i + 500), { onConflict: "source,source_record_id" });
    if (error) throw new Error(`raw_source_rows upsert: ${error.message}`);
  }
  return { written: rows.length, snap };
}

async function loadBranches(db: SupabaseClient, built: Built[]) {
  const existing: { id: string; redress_scheme: string | null; redress_member_id: string | null; source_type: string; trading_name_norm: string; postcode: string | null; manually_edited: boolean; first_seen_at: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("branches")
      .select("id, redress_scheme, redress_member_id, source_type, trading_name_norm, postcode, manually_edited, first_seen_at")
      .range(from, from + 999);
    if (error) throw new Error(`read branches: ${error.message}`);
    existing.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const keyOf = (r: { redress_scheme: string | null; redress_member_id: string | null; source_type: string; trading_name_norm: string; postcode: string | null }) =>
    r.redress_member_id ? `m|${r.redress_scheme}|${r.redress_member_id}` : `n|${r.source_type}|${r.trading_name_norm}|${r.postcode ?? ""}`;
  const byKey = new Map(existing.map((e) => [keyOf(e), e]));

  const inserts: BranchRow[] = [];
  const updates: { id: string; row: BranchRow }[] = [];
  let skippedManual = 0;
  const seen = new Set<string>();
  for (const { row } of built) {
    const k = keyOf(row);
    if (seen.has(k)) continue; // same key twice in one run (e.g. two CH companies, same name + postcode)
    seen.add(k);
    const e = byKey.get(k);
    if (!e) inserts.push(row);
    else if (e.manually_edited) skippedManual++;
    else updates.push({ id: e.id, row });
  }

  const snap = updates.length ? await snapshot(db, "branches") : null;
  const now = new Date().toISOString();
  for (let i = 0; i < inserts.length; i += 500) {
    const { error } = await db.from("branches").insert(inserts.slice(i, i + 500).map((r) => ({ ...r, first_seen_at: now, last_seen_at: now })));
    if (error) throw new Error(`branches insert: ${error.message}`);
  }
  for (const u of updates) {
    // manually_edited re-checked in the filter so a row edited mid-run is not touched.
    const { error } = await db.from("branches").update({ ...u.row, last_seen_at: now, updated_at: now }).eq("id", u.id).eq("manually_edited", false);
    if (error) throw new Error(`branches update: ${error.message}`);
  }
  return { inserted: inserts.length, updated: updates.length, skippedManual, dedupedInRun: built.length - seen.size, snap };
}

async function main() {
  const { built, prsRecords, prsUnique, prsOutOfArea, workTypes, surreyInfo } = build();
  const rows = built.map((b) => b.row);
  const inScope = rows.filter((r) => r.in_scope);
  const report = {
    surrey_district_codes: surreyInfo.codes,
    prs: { cached_records: prsRecords, unique_members: prsUnique, outside_78_outcodes: prsOutOfArea, kept: built.filter((b) => b.raw.source === "prs").length, empty_trading_name: built.filter((b) => b.emptyTradingName).length, fdWorkType_values: Object.fromEntries(workTypes) },
    total: rows.length,
    in_scope: inScope.length,
    in_scope_false: rows.filter((r) => r.in_scope === false).length,
    in_scope_unknown: rows.filter((r) => r.in_scope == null).length,
    by_source: tally(built, (b) => b.raw.source),
    by_source_type: tally(rows, (r) => r.source_type),
    in_scope_by_source: tally(built.filter((b) => b.row.in_scope), (b) => b.raw.source),
    in_scope_by_district: tally(inScope, (r) => `${r.admin_district} (${r.admin_district_code})`),
    likely_rmc: rows.filter((r) => r.likely_rmc).length,
    likely_rmc_in_scope: inScope.filter((r) => r.likely_rmc).length,
    not_geocoded: tally(rows.filter((r) => r.lat == null), (r) => r.notes?.split(";")[0] ?? ""),
    probable_duplicates: probableDuplicates(built),
  };
  console.log(JSON.stringify(report, null, 2));

  if (!writeRaw && !writeBranches) {
    console.log("\ndry run: nothing written");
    return;
  }
  if (writeBranches && Object.values(DECISIONS).some((v) => v === null)) {
    throw new Error(`--write-branches refused: open decisions ${JSON.stringify(DECISIONS)}`);
  }

  const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const script = `load-branches${writeRaw ? " --write-raw" : ""}${writeBranches ? " --write-branches" : ""}`;
  const { data: run, error: runErr } = await db.from("ingest_runs").insert({ script, rows_read: built.length }).select("id").single();
  if (runErr) throw runErr;

  const out: Record<string, unknown> = {};
  const snaps: { snapshot_table: string; restore_command: string }[] = [];
  if (writeRaw) {
    const r = await loadRaw(db, built, run.id);
    out.raw_source_rows = r.written;
    if (r.snap) snaps.push(r.snap);
  }
  if (writeBranches) {
    const r = await loadBranches(db, built);
    out.branches = { inserted: r.inserted, updated: r.updated, skipped_manually_edited: r.skippedManual, same_key_in_run: r.dedupedInRun };
    if (r.snap) snaps.push(r.snap);
  }
  await db
    .from("ingest_runs")
    .update({
      finished_at: new Date().toISOString(),
      rows_written: Object.values(out).reduce<number>((s, v) => s + (typeof v === "number" ? v : ((v as { inserted: number; updated: number }).inserted + (v as { updated: number }).updated)), 0),
      snapshot_table: snaps.map((s) => s.snapshot_table).join(", ") || null,
      restore_command: snaps.map((s) => s.restore_command).join("\n") || null,
      notes: JSON.stringify({ ...out, total: report.total, in_scope: report.in_scope }),
    })
    .eq("id", run.id);
  console.log(`\nwritten: ${JSON.stringify(out)}${snaps.length ? `; snapshots: ${snaps.map((s) => s.snapshot_table).join(", ")}` : ""}`);
}

main().catch((e) => {
  console.error("load-branches failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
