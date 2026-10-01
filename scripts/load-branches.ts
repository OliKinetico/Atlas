// Phase 3 step 4: build branch rows from the allowlisted PRS cache and the CH candidate
// extract, geocode them from the postcodes.io cache, and load them.
//
//   (no flag)          dry run: report counts only; writes nothing.
//   --write-raw        upsert allowlisted records into raw_source_rows.
//   --write-branches   upsert branches, then write probable duplicates to match_proposals.
//
// Rulings applied (Oli, Phase 3, see notes/decisions.md):
// - trading_name stays null when the source supplies none; never copied from the legal name.
//   branch_overview.display_name falls back to the legal name, tagged "taken from legal name".
// - PRS correspondence addresses are source_type member_address (unverified), not branch.
// - Upsert keys are source IDs only: PRS member ID; CH company number. No row without one.
// - fdIsHaveOtherBranch / fdNumberofBranches are stored as self-declared, not verified.
// - Probable duplicates go to match_proposals (kind branch_duplicate) with their match basis.
//   Nothing is merged.
//
// Only records whose outcode is in the approved 78-outcode set are kept. in_scope comes from
// the full postcode's ONS district code (0R.6). Lookup-then-insert/update (supabase-js upsert
// cannot target the partial unique indexes). Rows with manually_edited = true are skipped.
// Every table written is snapshotted first; restore commands go to ingest_runs.
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readPrsCache, type PrsRecord } from "./prs-fetch";
import { loadLookup, loadSurreyDistricts, normPostcode, type Geo } from "./geocode";
import type { ChCandidate } from "./ch-candidates";

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
/** Self-declared value as given by the member: boolean/number/string kept, empty → null. */
const declared = (v: unknown) => (typeof v === "boolean" || typeof v === "number" ? v : str(v) || null);

type BranchRow = {
  trading_name: string | null;
  trading_name_norm: string | null;
  legal_name_as_listed: string | null;
  address_lines: string[];
  postcode: string | null;
  outcode: string | null;
  source_type: "member_address" | "ch_registered_office";
  source_company_number: string | null;
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
type Built = { key: string; row: BranchRow; raw: { source: "prs" | "ch_bulk"; id: string; payload: object } };

const keyOf = (r: { redress_scheme: string | null; redress_member_id: string | null; source_type: string; source_company_number: string | null }) => {
  if (r.redress_member_id) return `m|${r.redress_scheme}|${r.redress_member_id}`;
  if (r.source_type === "ch_registered_office" && r.source_company_number) return `c|${r.source_company_number}`;
  throw new Error("branch row has no source ID (PRS member ID or CH company number)");
};

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

/** A listed company number in canonical 8-character form (leading zeros restored), or "". */
export const canonicalCoNumber = (v: unknown) => {
  const s = str(v).toUpperCase().replace(/\s/g, "");
  return s ? s.padStart(8, "0") : "";
};

function build() {
  const outcodes = new Set(Object.keys(JSON.parse(readFileSync("notes/phase0-surrey-outcodes.json", "utf8")).inscope));
  const surreyInfo = loadSurreyDistricts();
  const surrey = new Set(surreyInfo.codes);
  const lookup = loadLookup();
  const built: Built[] = [];
  const workTypes = new Map<string, number>();
  const otherBranch = new Map<string, number>();

  // PRS: dedupe by member ID (the same member can appear under several prefixes/pages).
  const prs = new Map<string, PrsRecord>();
  let prsRecords = 0;
  let prsMissingId = 0;
  for (const { record } of readPrsCache()) {
    prsRecords++;
    const id = str(record.fdId);
    if (id) prs.set(id, record);
    else prsMissingId++;
  }
  if (prsMissingId) throw new Error(`${prsMissingId} PRS records have no member ID; stopping (ruling A2)`);
  let prsOutOfArea = 0;
  let prsWithTradingName = 0;
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
    const ob = String(declared(r.fdIsHaveOtherBranch));
    otherBranch.set(ob, (otherBranch.get(ob) ?? 0) + 1);
    const trading = str(r.TradingName) || null;
    if (trading) prsWithTradingName++;
    const row: BranchRow = {
      trading_name: trading,
      trading_name_norm: trading ? normName(trading) : null,
      legal_name_as_listed: str(r.fdCompanyName) || null,
      address_lines: [str(r.fdCorrespondanceAddressLine1), str(r.fdCorrespondanceAddressLine2)].filter(Boolean),
      postcode: g.postcode,
      outcode: oc,
      source_type: "member_address",
      source_company_number: null,
      likely_rmc: false,
      lat: g.lat,
      lng: g.lng,
      admin_district: g.admin_district,
      admin_district_code: g.admin_district_code,
      in_scope: g.in_scope,
      redress_scheme: "prs",
      redress_member_id: id,
      does_lettings: null, // fdWorkType is empty in the source; never inferred
      sources: [
        {
          source: "prs",
          member_id: id,
          address_kind: "member correspondence address (unverified)",
          membership_status: str(r.MemberStatus) || null,
          company_number_listed: str(r.fdRegisteredCoNo) || null,
          other_branches_self_declared: declared(r.fdIsHaveOtherBranch),
          number_of_branches_self_declared: declared(r.fdNumberofBranches),
          branch_counts_verified: false,
        },
      ],
      notes: g.geoNote,
    };
    built.push({ key: keyOf(row), row, raw: { source: "prs", id, payload: r } });
  }

  // Companies House registered-office candidates (0R.5).
  const ch = JSON.parse(readFileSync("cache/ch/candidates.json", "utf8")) as { snapshot: string; candidates: ChCandidate[] };
  for (const c of ch.candidates) {
    if (!c.company_number) throw new Error("CH candidate without a company number; stopping (ruling A2)");
    const g = geoFields(c.postcode, lookup, surrey);
    const row: BranchRow = {
      trading_name: null,
      trading_name_norm: null,
      legal_name_as_listed: c.name,
      address_lines: c.address_lines,
      postcode: g.postcode,
      outcode: g.outcode ?? c.outcode,
      source_type: "ch_registered_office",
      source_company_number: c.company_number,
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
    };
    built.push({ key: keyOf(row), row, raw: { source: "ch_bulk", id: c.company_number, payload: c } });
  }
  return { built, prsRecords, prsUnique: prs.size, prsOutOfArea, prsWithTradingName, workTypes, otherBranch, surreyInfo };
}

type Basis = "identical_company_number" | "same_name_same_postcode" | "same_name_different_postcode";
type Pair = { prs: Built; ch: Built; bases: Basis[] };

/** Probable duplicates between PRS member addresses and CH registered offices. Never merged. */
function duplicatePairs(built: Built[]): Pair[] {
  const prs = built.filter((b) => b.raw.source === "prs");
  const ch = built.filter((b) => b.raw.source === "ch_bulk");
  const chByNumber = new Map(ch.map((b) => [b.raw.id, b]));
  const chByName = new Map<string, Built[]>();
  for (const b of ch) {
    const n = normName(b.row.legal_name_as_listed ?? "");
    if (n) chByName.set(n, [...(chByName.get(n) ?? []), b]);
  }
  const pairs = new Map<string, Pair>();
  const add = (p: Built, c: Built, basis: Basis) => {
    const k = `${p.key}>${c.key}`;
    const pair = pairs.get(k) ?? { prs: p, ch: c, bases: [] };
    if (!pair.bases.includes(basis)) pair.bases.push(basis);
    pairs.set(k, pair);
  };
  for (const p of prs) {
    const co = canonicalCoNumber((p.raw.payload as PrsRecord).fdRegisteredCoNo);
    const byNum = co ? chByNumber.get(co) : undefined;
    if (byNum) add(p, byNum, "identical_company_number");
    for (const c of chByName.get(normName(p.row.legal_name_as_listed ?? "")) ?? []) {
      add(p, c, c.row.postcode === p.row.postcode ? "same_name_same_postcode" : "same_name_different_postcode");
    }
  }
  return [...pairs.values()];
}

function tally<T>(items: T[], key: (t: T) => string) {
  const m: Record<string, number> = {};
  for (const i of items) m[key(i)] = (m[key(i)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}

type Snap = { snapshot_table: string; restore_command: string };
async function snapshot(db: SupabaseClient, table: string): Promise<Snap> {
  const { data, error } = await db.rpc("snapshot_table", { tbl: table });
  if (error) throw new Error(`snapshot ${table}: ${error.message}`);
  return (data as Snap[])[0];
}

async function readAll<T>(db: SupabaseClient, table: string, cols: string, filter?: [string, string]): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(cols).order("id").range(from, from + 999);
    if (filter) q = q.eq(filter[0], filter[1]);
    const { data, error } = await q;
    if (error) throw new Error(`read ${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function loadRaw(db: SupabaseClient, built: Built[], runId: string, snaps: Snap[]) {
  snaps.push(await snapshot(db, "raw_source_rows"));
  const now = new Date().toISOString();
  const rows = built.map((b) => ({ source: b.raw.source, source_record_id: b.raw.id, payload: b.raw.payload, fetched_at: now, ingest_run_id: runId }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("raw_source_rows").upsert(rows.slice(i, i + 500), { onConflict: "source,source_record_id" });
    if (error) throw new Error(`raw_source_rows upsert: ${error.message}`);
  }
  return rows.length;
}

type ExistingBranch = { id: string; redress_scheme: string | null; redress_member_id: string | null; source_type: string; source_company_number: string | null; manually_edited: boolean };

async function loadBranches(db: SupabaseClient, built: Built[], snaps: Snap[]) {
  const existing = await readAll<ExistingBranch>(db, "branches", "id, redress_scheme, redress_member_id, source_type, source_company_number, manually_edited");
  const byKey = new Map(existing.map((e) => [keyOf(e), e]));

  const inserts: BranchRow[] = [];
  const updates: { id: string; row: BranchRow }[] = [];
  let skippedManual = 0;
  for (const { key, row } of built) {
    const e = byKey.get(key);
    if (!e) inserts.push(row);
    else if (e.manually_edited) skippedManual++;
    else updates.push({ id: e.id, row });
  }

  snaps.push(await snapshot(db, "branches"));
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
  return { inserted: inserts.length, updated: updates.length, skippedManual, insertedAt: now };
}

async function loadProposals(db: SupabaseClient, pairs: Pair[], snaps: Snap[]) {
  const ids = new Map(
    (await readAll<ExistingBranch>(db, "branches", "id, redress_scheme, redress_member_id, source_type, source_company_number, manually_edited")).map((e) => [keyOf(e), e.id]),
  );
  const existing = await readAll<{ id: string; subject_id: string; candidate: { branch_id?: string } }>(db, "match_proposals", "id, subject_id, candidate", ["kind", "branch_duplicate"]);
  const have = new Set(existing.map((p) => `${p.subject_id}>${p.candidate?.branch_id}`));
  const rows = [];
  for (const p of pairs) {
    const subject = ids.get(p.prs.key);
    const other = ids.get(p.ch.key);
    if (!subject || !other) throw new Error("duplicate pair refers to a branch that was not written");
    if (have.has(`${subject}>${other}`)) continue;
    rows.push({
      kind: "branch_duplicate",
      subject_id: subject,
      candidate: { branch_id: other, source_type: "ch_registered_office", company_number: p.ch.raw.id },
      evidence: {
        match_basis: p.bases,
        prs_member_id: p.prs.raw.id,
        prs_legal_name: p.prs.row.legal_name_as_listed,
        prs_company_number_listed: str((p.prs.raw.payload as PrsRecord).fdRegisteredCoNo) || null,
        prs_postcode: p.prs.row.postcode,
        ch_company_number: p.ch.raw.id,
        ch_name: p.ch.row.legal_name_as_listed,
        ch_postcode: p.ch.row.postcode,
      },
    });
  }
  snaps.push(await snapshot(db, "match_proposals"));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("match_proposals").insert(rows.slice(i, i + 500));
    if (error) throw new Error(`match_proposals insert: ${error.message}`);
  }
  return { inserted: rows.length, already_present: pairs.length - rows.length };
}

async function main() {
  const { built, prsRecords, prsUnique, prsOutOfArea, prsWithTradingName, workTypes, otherBranch, surreyInfo } = build();
  const pairs = duplicatePairs(built);
  const rows = built.map((b) => b.row);
  const inScope = rows.filter((r) => r.in_scope);
  const keys = new Set(built.map((b) => b.key));
  if (keys.size !== built.length) throw new Error(`${built.length - keys.size} rows share a source key; stopping`);
  const report = {
    surrey_district_codes: surreyInfo.codes,
    prs: {
      cached_records: prsRecords,
      unique_members: prsUnique,
      outside_78_outcodes: prsOutOfArea,
      kept: built.filter((b) => b.raw.source === "prs").length,
      with_trading_name: prsWithTradingName,
      fdWorkType_values: Object.fromEntries(workTypes),
      fdIsHaveOtherBranch_values: Object.fromEntries(otherBranch),
    },
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
    duplicate_pairs: {
      total: pairs.length,
      by_basis: tally(pairs.flatMap((p) => p.bases), (b) => b),
      by_basis_combination: tally(pairs, (p) => [...p.bases].sort().join(" + ")),
    },
  };
  console.log(JSON.stringify(report, null, 2));

  if (!writeRaw && !writeBranches) {
    console.log("\ndry run: nothing written");
    return;
  }

  const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const script = `load-branches${writeRaw ? " --write-raw" : ""}${writeBranches ? " --write-branches" : ""}`;
  const { data: run, error: runErr } = await db.from("ingest_runs").insert({ script, rows_read: built.length }).select("id").single();
  if (runErr) throw runErr;

  const out: Record<string, unknown> = {};
  const snaps: Snap[] = [];
  let written = 0;
  const undo: string[] = [];
  try {
    if (writeRaw) {
      out.raw_source_rows = await loadRaw(db, built, run.id, snaps);
      written += out.raw_source_rows as number;
    }
    if (writeBranches) {
      const b = await loadBranches(db, built, snaps);
      const p = await loadProposals(db, pairs, snaps);
      out.branches = { inserted: b.inserted, updated: b.updated, skipped_manually_edited: b.skippedManual };
      out.match_proposals = p;
      written += b.inserted + b.updated + p.inserted;
      // The snapshot restore never deletes, so log how to remove rows this run inserted.
      undo.push(
        `-- undo rows inserted by this run:\ndelete from public.match_proposals where kind = 'branch_duplicate' and created_at >= '${b.insertedAt}';\n` +
          `delete from public.branches where first_seen_at = '${b.insertedAt}' and manually_edited = false;`,
      );
    }
  } finally {
    await db
      .from("ingest_runs")
      .update({
        finished_at: new Date().toISOString(),
        rows_written: written,
        snapshot_table: snaps.map((s) => s.snapshot_table).join(", ") || null,
        restore_command: [...snaps.map((s) => s.restore_command), ...undo].join("\n") || null,
        notes: JSON.stringify({ ...out, total: report.total, in_scope: report.in_scope }),
      })
      .eq("id", run.id);
  }
  console.log(`\nwritten: ${JSON.stringify(out)}\nsnapshots: ${snaps.map((s) => s.snapshot_table).join(", ")}`);
}

main().catch((e) => {
  console.error("load-branches failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
