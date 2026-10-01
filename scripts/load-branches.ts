// Phase 3 step 4: build branch rows from the allowlisted PRS cache and the CH candidate
// extract, geocode them from the postcodes.io cache, and load them.
//
//   (no flag)          dry run: report counts only; writes nothing.
//   --write-raw        insert/update allowlisted records in raw_source_rows (changed ones only).
//   --write-branches   insert/update branches (changed ones only), then write probable
//                      duplicates to match_proposals.
//
// Rulings applied (Oli; notes/decisions.md B1-B4, 1-13):
// - Member IDs 0 / null / empty are invalid everywhere. ID-0 rows are PRS returning branch-list
//   entries as top-level rows: kept in raw_source_rows, excluded from branches, but only when
//   each matches a fetched member's BranchListJson entry on exact name + postcode (else stop).
// - Repeated member IDs collapse only if the allowlisted records are identical (else stop).
// - Member correspondence address → source_type member_address, trading_name null.
// - Each BranchListJson entry → source_type branch, trading_name null, branch_label =
//   fdBranchName, parent's legal name + listed company number carried. Key = member ID +
//   normalised label + postcode + occurrence; list position is evidence only. Scoped by the
//   branch's own postcode against the 78 outcodes.
// - CH registered offices keyed by company number; likely_rmc = limited by guarantee OR broader
//   name rule (basis recorded); dormant = low_priority, not hidden.
// - Probable duplicates → match_proposals (branch_duplicate) with match basis. Never between a
//   member's own address and its own branches. Inactive branches excluded. Nothing merges.
// - A row missing from a later load is never deleted: its last_seen_at simply stops advancing.
// - Rows with manually_edited = true are skipped. Every table written is snapshotted first;
//   restore and undo commands go to ingest_runs. Only rows whose content changed are updated;
//   unchanged rows get last_seen_at refreshed (reported separately).
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readPrsCache, type PrsBranch, type PrsRecord } from "./prs-fetch";
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
const PREFIXES = ["GU", "KT", "RH", "TW", "SM", "CR", "TN", "SL"];

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
/** Ruling 9: 0, null and empty are never valid member IDs. */
export const isValidMemberId = (v: unknown) => !/^0*$/.test(str(v));
/** Self-declared value as given by the member: boolean/number/string kept, empty → null. */
const declared = (v: unknown) => (typeof v === "boolean" || typeof v === "number" ? v : str(v) || null);
/** JSON with sorted object keys, so jsonb round-trips compare equal. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

type SourceType = "member_address" | "branch" | "ch_registered_office";
type BranchRow = {
  trading_name: string | null;
  trading_name_norm: string | null;
  legal_name_as_listed: string | null;
  company_number_listed: string | null;
  address_lines: string[];
  postcode: string | null;
  outcode: string | null;
  source_type: SourceType;
  source_company_number: string | null;
  branch_label: string | null;
  redress_parent_member_id: string | null;
  branch_occurrence: number | null;
  branch_key: string | null;
  is_active: boolean | null;
  likely_rmc: boolean;
  likely_rmc_basis: string[] | null;
  low_priority: boolean;
  low_priority_reason: string | null;
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
const ROW_COLUMNS: (keyof BranchRow)[] = [
  "trading_name", "trading_name_norm", "legal_name_as_listed", "company_number_listed", "address_lines", "postcode",
  "outcode", "source_type", "source_company_number", "branch_label", "redress_parent_member_id", "branch_occurrence",
  "branch_key", "is_active", "likely_rmc", "likely_rmc_basis", "low_priority", "low_priority_reason", "lat", "lng",
  "admin_district", "admin_district_code", "in_scope", "redress_scheme", "redress_member_id", "does_lettings",
  "sources", "notes",
];
type Built = { key: string; row: BranchRow; memberId?: string };
type Raw = { source: "prs" | "ch_bulk"; id: string; payload: object };

const keyOf = (r: { source_type: string; redress_scheme: string | null; redress_member_id: string | null; source_company_number: string | null; branch_key: string | null }) => {
  if (r.source_type === "member_address" && r.redress_member_id) return `m|${r.redress_scheme}|${r.redress_member_id}`;
  if (r.source_type === "branch" && r.branch_key) return `b|${r.branch_key}`;
  if (r.source_type === "ch_registered_office" && r.source_company_number) return `c|${r.source_company_number}`;
  throw new Error(`branch row (${r.source_type}) has no source key`);
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
  const n = normPostcode(pcRaw);
  return {
    postcode: pcRaw || null, // as listed; never corrected
    outcode: n.length >= 5 && n.length <= 7 ? n.slice(0, -3) : null, // from the listed string
    lat: null,
    lng: null,
    admin_district: null,
    admin_district_code: null,
    in_scope: null,
    geoNote: `not geocoded: ${reason}`,
  };
}

/** A listed company number in canonical 8-character form (leading zeros restored), or "". */
export const canonicalCoNumber = (v: unknown) => {
  const s = str(v).toUpperCase().replace(/\s/g, "");
  return s ? s.padStart(8, "0") : "";
};

class Stop extends Error {}

function build() {
  const outcodes = new Set(Object.keys(JSON.parse(readFileSync("notes/phase0-surrey-outcodes.json", "utf8")).inscope));
  const surreyInfo = loadSurreyDistricts();
  const surrey = new Set(surreyInfo.codes);
  const lookup = loadLookup();
  const built: Built[] = [];
  const raws: Raw[] = [];
  const report: Record<string, unknown> = {};

  // --- PRS members: invalid IDs set aside; repeats collapse only when identical (ruling 5/11).
  const members = new Map<string, PrsRecord>();
  const id0: PrsRecord[] = [];
  let records = 0;
  let collapsed = 0;
  for (const { record } of readPrsCache()) {
    records++;
    if (!isValidMemberId(record.fdId)) {
      id0.push(record);
      continue;
    }
    const id = str(record.fdId);
    const prev = members.get(id);
    if (prev) {
      if (canon(prev) !== canon(record)) throw new Stop(`member ${id} appears twice with different content (ruling 5)`);
      collapsed++;
    } else members.set(id, record);
  }

  // --- ID-0 guard (ruling 9): each must match a fetched member's branch entry exactly.
  const entries: { memberId: string; position: number; b: PrsBranch }[] = [];
  for (const [id, m] of members) (m.BranchListJson ?? []).forEach((b, position) => entries.push({ memberId: id, position, b }));
  const matched = new Set<number>();
  const id0NoParent: number[] = [];
  id0.forEach((r, i) => {
    const hits = entries
      .map((e, j) => ({ e, j }))
      .filter(({ e }) => str(e.b.fdBranchName) === str(r.fdCompanyName) && normPostcode(e.b.fdPostCode) === normPostcode(r.fdPostCode));
    if (!hits.length) id0NoParent.push(i);
    hits.forEach(({ j }) => matched.add(j));
  });
  if (id0NoParent.length) throw new Stop(`${id0NoParent.length} ID-0 rows match no fetched member's branch entry (ruling 9)`);
  const unmatchedEntries = entries.filter((_, j) => !matched.has(j));
  report.id0 = {
    rows: id0.length,
    with_no_parent: id0NoParent.length,
    branch_entries: entries.length,
    branch_entries_without_id0_copy: unmatchedEntries.length,
    why_no_copy: unmatchedEntries.map((e) => {
      const pc = normPostcode(e.b.fdPostCode);
      return {
        member: e.memberId,
        active: e.b.fdIsActive,
        postcode_contains_a_searched_prefix: PREFIXES.some((p) => pc.includes(p)),
        member_listed_twice_in_list: entries.filter((x) => x.memberId === e.memberId && normName(str(x.b.fdBranchName)) === normName(str(e.b.fdBranchName)) && normPostcode(x.b.fdPostCode) === pc).length > 1,
      };
    }),
  };

  // --- Member correspondence addresses (member_address), in the 78 outcodes.
  const membersIn78 = new Set<string>();
  const workTypes = new Map<string, number>();
  for (const [id, r] of members) {
    const g = geoFields(str(r.fdPostCode), lookup, surrey);
    if (!g.outcode || !outcodes.has(g.outcode)) continue;
    membersIn78.add(id);
    const wt = str(r.fdWorkType) || "(empty)";
    workTypes.set(wt, (workTypes.get(wt) ?? 0) + 1);
    const row: BranchRow = {
      trading_name: str(r.TradingName) || null,
      trading_name_norm: str(r.TradingName) ? normName(str(r.TradingName)) : null,
      legal_name_as_listed: str(r.fdCompanyName) || null,
      company_number_listed: str(r.fdRegisteredCoNo) || null,
      address_lines: [str(r.fdCorrespondanceAddressLine1), str(r.fdCorrespondanceAddressLine2)].filter(Boolean),
      postcode: g.postcode,
      outcode: g.outcode,
      source_type: "member_address",
      source_company_number: null,
      branch_label: null,
      redress_parent_member_id: null,
      branch_occurrence: null,
      branch_key: null,
      is_active: null,
      likely_rmc: false,
      likely_rmc_basis: null,
      low_priority: false,
      low_priority_reason: null,
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
          other_branches_self_declared: declared(r.fdIsHaveOtherBranch),
          number_of_branches_self_declared: declared(r.fdNumberofBranches),
          branch_counts_verified: false,
          branch_list_entries: (r.BranchListJson ?? []).length,
        },
      ],
      notes: g.geoNote,
    };
    built.push({ key: keyOf(row), row, memberId: id });
  }

  // --- Branch-list entries (branch), scoped by their own postcode (ruling 3, 10, 12).
  const intraPairs: { a: string; b: string; memberId: string }[] = [];
  const listedTwice: Record<string, unknown>[] = [];
  const groups = new Map<string, { memberId: string; labelNorm: string; pc: string; items: { position: number; b: PrsBranch }[] }>();
  for (const e of entries) {
    const labelNorm = normName(str(e.b.fdBranchName));
    const pc = normPostcode(e.b.fdPostCode);
    const k = `${e.memberId}|${labelNorm}|${pc}`;
    const grp = groups.get(k) ?? { memberId: e.memberId, labelNorm, pc, items: [] };
    grp.items.push({ position: e.position, b: e.b });
    groups.set(k, grp);
  }
  const branchMembersIn78 = new Set<string>();
  let branchEntriesOutside78 = 0;
  for (const grp of groups.values()) {
    // Identical entries collapse to one (source listed it more than once); differing ones
    // become occurrences 1..n ordered by address text, with a duplicate proposal between them.
    const distinct = new Map<string, { b: PrsBranch; positions: number[] }>();
    for (const it of grp.items) {
      const c = canon(it.b);
      const d = distinct.get(c) ?? { b: it.b, positions: [] };
      d.positions.push(it.position);
      distinct.set(c, d);
    }
    const ordered = [...distinct.values()].sort((x, y) =>
      `${str(x.b.fdCorrespondanceAddressLine1)} ${str(x.b.fdCorrespondanceAddressLine2)}`.localeCompare(
        `${str(y.b.fdCorrespondanceAddressLine1)} ${str(y.b.fdCorrespondanceAddressLine2)}`,
      ),
    );
    if (grp.items.length > 1) {
      listedTwice.push({ member: grp.memberId, entries: grp.items.length, distinct_after_comparing_kept_fields: ordered.length });
    }
    const parent = members.get(grp.memberId)!;
    const keys: string[] = [];
    ordered.forEach((d, i) => {
      const g = geoFields(str(d.b.fdPostCode), lookup, surrey);
      if (!g.outcode || !outcodes.has(g.outcode)) {
        branchEntriesOutside78++;
        return;
      }
      branchMembersIn78.add(grp.memberId);
      const occurrence = i + 1;
      const branchKey = `${grp.memberId}|${grp.labelNorm}|${grp.pc}|${occurrence}`;
      const row: BranchRow = {
        trading_name: null, // ruling 12: fdBranchName is a location label, not a trading name
        trading_name_norm: null,
        legal_name_as_listed: str(parent.fdCompanyName) || null,
        company_number_listed: str(parent.fdRegisteredCoNo) || null,
        address_lines: [str(d.b.fdCorrespondanceAddressLine1), str(d.b.fdCorrespondanceAddressLine2)].filter(Boolean),
        postcode: g.postcode,
        outcode: g.outcode,
        source_type: "branch",
        source_company_number: null,
        branch_label: str(d.b.fdBranchName) || null,
        redress_parent_member_id: grp.memberId,
        branch_occurrence: occurrence,
        branch_key: branchKey,
        is_active: typeof d.b.fdIsActive === "boolean" ? d.b.fdIsActive : null,
        likely_rmc: false,
        likely_rmc_basis: null,
        low_priority: false,
        low_priority_reason: null,
        lat: g.lat,
        lng: g.lng,
        admin_district: g.admin_district,
        admin_district_code: g.admin_district_code,
        in_scope: g.in_scope,
        redress_scheme: "prs",
        redress_member_id: null,
        does_lettings: null,
        sources: [
          {
            source: "prs",
            kind: "member branch-list entry",
            parent_member_id: grp.memberId,
            list_positions: d.positions, // evidence only, never part of the key
            listed_times: d.positions.length,
            source_coordinates: { lat: d.b.Latitude ?? null, lng: d.b.Longitude ?? null },
          },
        ],
        notes: g.geoNote,
      };
      keys.push(keyOf(row));
      built.push({ key: keyOf(row), row, memberId: grp.memberId });
    });
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) intraPairs.push({ a: keys[i], b: keys[j], memberId: grp.memberId });
  }

  // --- Companies House registered-office candidates (0R.5, ruling 8).
  const ch = JSON.parse(readFileSync("cache/ch/candidates.json", "utf8")) as { snapshot: string; candidates: ChCandidate[] };
  for (const c of ch.candidates) {
    if (!c.company_number) throw new Stop("CH candidate without a company number (ruling A2)");
    const g = geoFields(c.postcode, lookup, surrey);
    const row: BranchRow = {
      trading_name: null,
      trading_name_norm: null,
      legal_name_as_listed: c.name,
      company_number_listed: null,
      address_lines: c.address_lines,
      postcode: g.postcode,
      outcode: g.outcode ?? c.outcode,
      source_type: "ch_registered_office",
      source_company_number: c.company_number,
      branch_label: null,
      redress_parent_member_id: null,
      branch_occurrence: null,
      branch_key: null,
      is_active: null,
      likely_rmc: c.likely_rmc,
      likely_rmc_basis: c.likely_rmc_basis.length ? c.likely_rmc_basis : null,
      low_priority: c.low_priority,
      low_priority_reason: c.low_priority ? "dormant (accounts category DORMANT)" : null,
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
    built.push({ key: keyOf(row), row });
    raws.push({ source: "ch_bulk", id: c.company_number, payload: c });
  }

  // --- raw_source_rows: members in the 78 outcodes or with a branch there; every ID-0 row.
  for (const [id, r] of members) if (membersIn78.has(id) || branchMembersIn78.has(id)) raws.push({ source: "prs", id, payload: r });
  for (const r of id0) raws.push({ source: "prs", id: `0|${normName(str(r.fdCompanyName))}|${normPostcode(r.fdPostCode)}`, payload: r });
  const rawIds = new Set(raws.map((r) => `${r.source}|${r.id}`));
  if (rawIds.size !== raws.length) throw new Stop("two raw records share a source_record_id");

  const inScopeMember = [...membersIn78].filter((id) => built.find((b) => b.key === `m|prs|${id}`)?.row.in_scope).length;
  report.prs = {
    records_cached: records,
    identical_repeats_collapsed: collapsed,
    id0_rows_excluded: id0.length,
    members_fetched: members.size,
    members_in_78_outcodes: membersIn78.size,
    members_in_scope: inScopeMember,
    fdWorkType_values: Object.fromEntries(workTypes),
    branch_entries: entries.length,
    branch_rows_after_collapsing: [...groups.values()].length,
    branch_entries_outside_78: branchEntriesOutside78,
    same_member_same_label_and_postcode: listedTwice,
    members_outside_78_with_a_branch_inside: [...branchMembersIn78].filter((id) => !membersIn78.has(id)),
  };
  return { built, raws, intraPairs, report, surreyInfo };
}

type Basis = "identical_company_number" | "same_name_same_postcode" | "same_name_different_postcode" | "same_member_same_label_and_postcode";
type Pair = { subject: string; other: string; bases: Basis[]; evidence: Record<string, unknown> };

/** Probable duplicates. Never merged; never member address ↔ its own branches (ruling 12). */
function duplicatePairs(built: Built[], intraPairs: { a: string; b: string; memberId: string }[]): Pair[] {
  const byKey = new Map(built.map((b) => [b.key, b]));
  const memberRows = built.filter((b) => b.row.source_type === "member_address");
  const activeBranches = built.filter((b) => b.row.source_type === "branch" && b.row.is_active !== false);
  const ch = built.filter((b) => b.row.source_type === "ch_registered_office");
  const chByNumber = new Map(ch.map((b) => [b.row.source_company_number!, b]));
  const chByName = new Map<string, Built[]>();
  for (const b of ch) {
    const n = normName(b.row.legal_name_as_listed ?? "");
    if (n) chByName.set(n, [...(chByName.get(n) ?? []), b]);
  }
  const pairs = new Map<string, Pair>();
  const add = (s: Built, o: Built, basis: Basis, extra: Record<string, unknown> = {}) => {
    const k = `${s.key}>${o.key}`;
    const p = pairs.get(k) ?? {
      subject: s.key,
      other: o.key,
      bases: [],
      evidence: {
        subject_type: s.row.source_type,
        subject_legal_name: s.row.legal_name_as_listed,
        subject_branch_label: s.row.branch_label,
        subject_company_number_listed: s.row.company_number_listed,
        subject_postcode: s.row.postcode,
        subject_member_id: s.row.redress_member_id ?? s.row.redress_parent_member_id,
        other_type: o.row.source_type,
        other_name: o.row.legal_name_as_listed,
        other_branch_label: o.row.branch_label,
        other_company_number: o.row.source_company_number,
        other_postcode: o.row.postcode,
        ...extra,
      },
    };
    if (!p.bases.includes(basis)) p.bases.push(basis);
    pairs.set(k, p);
  };
  for (const m of memberRows) {
    const co = canonicalCoNumber(m.row.company_number_listed);
    const byNum = co ? chByNumber.get(co) : undefined;
    if (byNum) add(m, byNum, "identical_company_number");
    for (const c of chByName.get(normName(m.row.legal_name_as_listed ?? "")) ?? []) {
      add(m, c, c.row.postcode === m.row.postcode ? "same_name_same_postcode" : "same_name_different_postcode");
    }
  }
  // Branch rows link to companies only through the parent member (ruling 12): a branch is a
  // probable duplicate of a CH registered office only when the parent's company number is
  // identical AND the branch sits at that postcode. The branch label is never name-matched.
  for (const b of activeBranches) {
    const co = canonicalCoNumber(b.row.company_number_listed);
    const c = co ? chByNumber.get(co) : undefined;
    if (c && c.row.postcode === b.row.postcode) add(b, c, "identical_company_number", { via: "parent member's listed company number" });
  }
  for (const ip of intraPairs) {
    const a = byKey.get(ip.a)!;
    const b = byKey.get(ip.b)!;
    if (a.row.is_active === false || b.row.is_active === false) continue;
    add(a, b, "same_member_same_label_and_postcode", { member_id: ip.memberId });
  }
  return [...pairs.values()];
}

function tally<T>(items: T[], key: (t: T) => string) {
  const m: Record<string, number> = {};
  for (const i of items) m[key(i)] = (m[key(i)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}

type Snap = { snapshot_table: string; restore_command: string; undo_command: string };
async function snapshot(db: SupabaseClient, table: string): Promise<Snap> {
  const { data, error } = await db.rpc("snapshot_table", { tbl: table });
  if (error) throw new Error(`snapshot ${table}: ${error.message}`);
  const s = (data as { snapshot_table: string; restore_command: string }[])[0];
  // Restore never deletes; this removes rows added after the snapshot (manual edits kept).
  const manual = table === "branches" ? " and t.manually_edited = false" : "";
  return { ...s, undo_command: `delete from public.${table} t where not exists (select 1 from public.${s.snapshot_table} s where s.id = t.id)${manual};` };
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

async function loadRaw(db: SupabaseClient, raws: Raw[], runId: string, snaps: Snap[]) {
  snaps.push(await snapshot(db, "raw_source_rows"));
  const existing = await readAll<{ id: string; source: string; source_record_id: string; payload: unknown }>(db, "raw_source_rows", "id, source, source_record_id, payload");
  const have = new Map(existing.map((e) => [`${e.source}|${e.source_record_id}`, e]));
  const now = new Date().toISOString();
  const inserts = [];
  const updates = [];
  for (const r of raws) {
    const e = have.get(`${r.source}|${r.id}`);
    const row = { source: r.source, source_record_id: r.id, payload: r.payload, fetched_at: now, ingest_run_id: runId };
    if (!e) inserts.push(row);
    else if (canon(e.payload) !== canon(r.payload)) updates.push(row);
  }
  for (const batch of [inserts, updates]) {
    for (let i = 0; i < batch.length; i += 500) {
      const { error } = await db.from("raw_source_rows").upsert(batch.slice(i, i + 500), { onConflict: "source,source_record_id" });
      if (error) throw new Error(`raw_source_rows write: ${error.message}`);
    }
  }
  const wanted = new Set(raws.map((r) => `${r.source}|${r.id}`));
  return { inserted: inserts.length, updated: updates.length, unchanged: raws.length - inserts.length - updates.length, not_in_this_load: existing.filter((e) => !wanted.has(`${e.source}|${e.source_record_id}`)).length };
}

type Existing = Record<string, unknown> & { id: string; manually_edited: boolean; source_type: string; redress_scheme: string | null; redress_member_id: string | null; source_company_number: string | null; branch_key: string | null };

async function loadBranches(db: SupabaseClient, built: Built[], snaps: Snap[]) {
  snaps.push(await snapshot(db, "branches"));
  const existing = await readAll<Existing>(db, "branches", ["id", "manually_edited", ...ROW_COLUMNS].join(", "));
  const byKey = new Map(existing.map((e) => [keyOf(e), e]));
  const now = new Date().toISOString();
  const inserts: BranchRow[] = [];
  const updates: { id: string; row: BranchRow }[] = [];
  const touch: string[] = [];
  let skippedManual = 0;
  for (const { key, row } of built) {
    const e = byKey.get(key);
    if (!e) inserts.push(row);
    else if (e.manually_edited) skippedManual++;
    else if (ROW_COLUMNS.some((c) => canon(e[c]) !== canon(row[c]))) updates.push({ id: e.id, row });
    else touch.push(e.id);
  }
  for (let i = 0; i < inserts.length; i += 500) {
    const { error } = await db.from("branches").insert(inserts.slice(i, i + 500).map((r) => ({ ...r, first_seen_at: now, last_seen_at: now })));
    if (error) throw new Error(`branches insert: ${error.message}`);
  }
  for (const u of updates) {
    // manually_edited re-checked in the filter so a row edited mid-run is not touched.
    const { error } = await db.from("branches").update({ ...u.row, last_seen_at: now, updated_at: now }).eq("id", u.id).eq("manually_edited", false);
    if (error) throw new Error(`branches update: ${error.message}`);
  }
  for (let i = 0; i < touch.length; i += 200) {
    const { error } = await db.from("branches").update({ last_seen_at: now }).in("id", touch.slice(i, i + 200)).eq("manually_edited", false);
    if (error) throw new Error(`branches last_seen_at: ${error.message}`);
  }
  const wanted = new Set(built.map((b) => b.key));
  return {
    inserted: inserts.length,
    updated: updates.length,
    unchanged_last_seen_refreshed: touch.length,
    skipped_manually_edited: skippedManual,
    not_seen_this_load: existing.filter((e) => !wanted.has(keyOf(e))).length, // never deleted
  };
}

async function loadProposals(db: SupabaseClient, pairs: Pair[], snaps: Snap[]) {
  snaps.push(await snapshot(db, "match_proposals"));
  const rows = await readAll<Existing>(db, "branches", "id, source_type, redress_scheme, redress_member_id, source_company_number, branch_key, manually_edited");
  const ids = new Map(rows.map((e) => [keyOf(e), e.id]));
  const existing = await readAll<{ subject_id: string; candidate: { branch_id?: string } }>(db, "match_proposals", "id, subject_id, candidate", ["kind", "branch_duplicate"]);
  const have = new Set(existing.map((p) => `${p.subject_id}>${p.candidate?.branch_id}`));
  const inserts = [];
  for (const p of pairs) {
    const subject = ids.get(p.subject);
    const other = ids.get(p.other);
    if (!subject || !other) throw new Error("duplicate pair refers to a branch row that is not in the table");
    if (have.has(`${subject}>${other}`)) continue;
    inserts.push({ kind: "branch_duplicate", subject_id: subject, candidate: { branch_id: other }, evidence: { match_basis: p.bases, ...p.evidence } });
  }
  for (let i = 0; i < inserts.length; i += 500) {
    const { error } = await db.from("match_proposals").insert(inserts.slice(i, i + 500));
    if (error) throw new Error(`match_proposals insert: ${error.message}`);
  }
  return { inserted: inserts.length, already_present: pairs.length - inserts.length };
}

async function main() {
  const { built, raws, intraPairs, report: prsReport, surreyInfo } = build();
  const pairs = duplicatePairs(built, intraPairs);
  const keys = new Set(built.map((b) => b.key));
  if (keys.size !== built.length) throw new Stop(`${built.length - keys.size} rows share a source key`);
  const rows = built.map((b) => b.row);
  const by = (t: SourceType) => rows.filter((r) => r.source_type === t);
  const scope = (rs: BranchRow[]) => ({ total: rs.length, in_scope: rs.filter((r) => r.in_scope).length, outside_surrey: rs.filter((r) => r.in_scope === false).length, unknown: rs.filter((r) => r.in_scope == null).length });
  const chRows = by("ch_registered_office");
  const report = {
    surrey_district_codes: surreyInfo.codes,
    ...prsReport,
    rows_by_source_type: { member_address: scope(by("member_address")), branch: scope(by("branch")), ch_registered_office: scope(chRows) },
    branch_rows_inactive: by("branch").filter((r) => r.is_active === false).length,
    ch_rule: {
      hidden_likely_rmc: chRows.filter((r) => r.likely_rmc).length,
      hidden_in_scope: chRows.filter((r) => r.likely_rmc && r.in_scope).length,
      hidden_by_basis: tally(chRows.filter((r) => r.likely_rmc), (r) => (r.likely_rmc_basis ?? []).join(" + ")),
      low_priority_dormant: chRows.filter((r) => r.low_priority).length,
      low_priority_in_scope: chRows.filter((r) => r.low_priority && r.in_scope).length,
      low_priority_and_hidden: chRows.filter((r) => r.low_priority && r.likely_rmc).length,
      shown_by_default_in_scope: chRows.filter((r) => !r.likely_rmc && r.in_scope).length,
    },
    in_scope_by_district: tally(rows.filter((r) => r.in_scope), (r) => `${r.admin_district} (${r.admin_district_code})`),
    not_geocoded: tally(rows.filter((r) => r.lat == null), (r) => `${r.source_type}: ${r.notes?.split(";")[0]}`),
    raw_source_rows_planned: tally(raws, (r) => r.source),
    duplicate_pairs: {
      total: pairs.length,
      by_basis: tally(pairs.flatMap((p) => p.bases), (b) => b),
      by_basis_combination: tally(pairs, (p) => [...p.bases].sort().join(" + ")),
      by_subject_type: tally(pairs, (p) => String(p.evidence.subject_type)),
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
  const { data: run, error: runErr } = await db.from("ingest_runs").insert({ script, rows_read: built.length + raws.length }).select("id").single();
  if (runErr) throw runErr;

  const out: Record<string, Record<string, number>> = {};
  const snaps: Snap[] = [];
  try {
    if (writeRaw) out.raw_source_rows = await loadRaw(db, raws, run.id, snaps);
    if (writeBranches) {
      out.branches = await loadBranches(db, built, snaps);
      out.match_proposals = await loadProposals(db, pairs, snaps);
    }
  } finally {
    const written = Object.values(out).reduce((s, o) => s + (o.inserted ?? 0) + (o.updated ?? 0), 0);
    await db
      .from("ingest_runs")
      .update({
        finished_at: new Date().toISOString(),
        rows_written: written,
        snapshot_table: snaps.map((s) => s.snapshot_table).join(", ") || null,
        restore_command: snaps.length
          ? ["-- restore (upsert snapshot back by primary key):", ...snaps.map((s) => s.restore_command), "-- undo rows added after the snapshot:", ...snaps.map((s) => s.undo_command)].join("\n")
          : null,
        notes: JSON.stringify(out),
      })
      .eq("id", run.id);
  }
  console.log(`\nwritten: ${JSON.stringify(out, null, 1)}\nsnapshots: ${snaps.map((s) => s.snapshot_table).join(", ")}\ningest_run: ${run.id}`);
}

main().catch((e) => {
  console.error(`${e instanceof Stop ? "STOP" : "load-branches failed"}: ${e instanceof Error ? e.message : e}`);
  process.exit(e instanceof Stop ? 3 : 1);
});
