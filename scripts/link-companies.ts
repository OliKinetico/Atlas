// Phase 4 steps 1-3: match branch rows to Companies House companies using the local bulk
// snapshot (DuckDB). Exact-tier matches become branch_company_links (tier exact); everything
// else becomes pending match_proposals (kind branch_company). Nothing fuzzy is ever applied.
//
//   (no flag)  dry run: report counts only; writes nothing.
//   --write    snapshot companies / branch_company_links / match_proposals, then insert new rows.
//
// Exact tier (plan step 2, ruling 7):
//   - register_company_number_in_snapshot: the register supplies a company number that exists
//     in the snapshot (PRS fdRegisteredCoNo for members; the CH row's own number for
//     ch_registered_office rows);
//   - exact_name_and_postcode: planNorm(legal name) equals planNorm(company name) AND the
//     registered-office postcode equals the member's postcode.
// Provisional rulings (notes/decisions.md): P1 branch-list rows link only through the parent
// member (ruling 12); P2 a member whose signals point at more than one company is a conflict
// (ruling 15): no link, every candidate becomes a proposal; P3 proposals for unlinked members
// cover the same name at a different postcode and a similar name (Jaro-Winkler >= 0.9) at the
// same postcode; P4 links and companies rows are insert-only (enrichment owns company updates).
//
// Writes are insert-only: existing links, proposals and companies rows are never changed or
// deleted. Branch rows with manually_edited = true get no new link.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { canonicalCoNumber, decideMember, pcNorm, planNorm, type MemberDecision } from "./lib/phase4";
import { canon, finishRun, readAll, serviceClient, snapshot, startRun, type Snap } from "./lib/db";

const write = process.argv.includes("--write");
const SIMILARITY = 0.9;
const csv = join("data", readdirSync("data").filter((n) => /^BasicCompanyDataAsOneFile-.*\.csv$/.test(n)).sort().pop()!);

type Branch = {
  id: string;
  source_type: "member_address" | "branch" | "ch_registered_office";
  redress_member_id: string | null;
  redress_parent_member_id: string | null;
  legal_name_as_listed: string | null;
  company_number_listed: string | null;
  postcode: string | null;
  source_company_number: string | null;
  in_scope: boolean | null;
  likely_rmc: boolean;
  manually_edited: boolean;
};
type Company = {
  company_number: string;
  name: string;
  status: string | null;
  category: string | null;
  sic: string | null;
  incorporated: string | null;
  acct_category: string | null;
  last_made_up: string | null;
  line1: string | null;
  line2: string | null;
  post_town: string | null;
  county: string | null;
  country: string | null;
  postcode: string | null;
  name_norm: string;
  pc_norm: string;
};
type Member = { id: string; name: string; postcode: string; listedRaw: string | null; listed: string; rows: Branch[]; hasMemberRow: boolean };

const isoDate = (v: string | null) => {
  const m = v ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim()) : null;
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const sql = (s: string) => `'${s.replace(/'/g, "''")}'`;
const big = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]));

async function main() {
  const db = serviceClient();
  const branches = await readAll<Branch>(
    db,
    "branches",
    "id, source_type, redress_member_id, redress_parent_member_id, legal_name_as_listed, company_number_listed, postcode, source_company_number, in_scope, likely_rmc, manually_edited",
    "id",
  );
  const raw = await readAll<{ source_record_id: string; payload: Record<string, unknown> }>(db, "raw_source_rows", "source_record_id, payload", "id", [["source", "prs"]]);
  const rawById = new Map(raw.map((r) => [r.source_record_id, r.payload]));
  const dupProps = await readAll<{ status: string; evidence: Record<string, unknown> }>(db, "match_proposals", "status, evidence", "id", [["kind", "branch_duplicate"]]);
  const pendingDupCompanies = new Map<string, Set<string>>();
  for (const p of dupProps.filter((x) => x.status === "pending")) {
    const m = String(p.evidence.subject_member_id ?? "");
    const c = String(p.evidence.other_company_number ?? "");
    if (m && c) pendingDupCompanies.set(m, new Set([...(pendingDupCompanies.get(m) ?? []), c]));
  }

  // --- PRS members: from their member_address row, or (parent of an in-area branch with no
  // member row) from the allowlisted raw payload.
  const members = new Map<string, Member>();
  for (const b of branches.filter((x) => x.source_type === "member_address")) {
    members.set(b.redress_member_id!, {
      id: b.redress_member_id!,
      name: b.legal_name_as_listed ?? "",
      postcode: b.postcode ?? "",
      listedRaw: b.company_number_listed,
      listed: canonicalCoNumber(b.company_number_listed),
      rows: [b],
      hasMemberRow: true,
    });
  }
  for (const b of branches.filter((x) => x.source_type === "branch")) {
    const pid = b.redress_parent_member_id!;
    let m = members.get(pid);
    if (!m) {
      const p = rawById.get(pid);
      if (!p) throw new Error(`branch ${b.id}: parent member ${pid} has no member row and no raw record`);
      m = {
        id: pid,
        name: String(p.fdCompanyName ?? "").trim(),
        postcode: String(p.fdPostCode ?? "").trim(),
        listedRaw: (String(p.fdRegisteredCoNo ?? "").trim() || null) as string | null,
        listed: canonicalCoNumber(p.fdRegisteredCoNo),
        rows: [],
        hasMemberRow: false,
      };
      members.set(pid, m);
    }
    m.rows.push(b);
  }
  const chRows = branches.filter((x) => x.source_type === "ch_registered_office");

  // --- DuckDB: the plan's normalisation in SQL (identical steps to planNorm in lib/phase4.ts).
  const duck = await (await DuckDBInstance.create(":memory:")).connect();
  await duck.run(`create table m (id varchar, name_norm varchar, pc_norm varchar, listed varchar)`);
  const ap = await duck.createAppender("m");
  for (const m of members.values()) {
    ap.appendVarchar(m.id);
    ap.appendVarchar(planNorm(m.name));
    ap.appendVarchar(pcNorm(m.postcode));
    ap.appendVarchar(m.listed);
    ap.endRow();
  }
  ap.closeSync();
  await duck.run(`create table wanted (n varchar)`);
  const aw = await duck.createAppender("wanted");
  for (const n of new Set([...[...members.values()].map((m) => m.listed).filter(Boolean), ...chRows.map((r) => r.source_company_number!)])) {
    aw.appendVarchar(n);
    aw.endRow();
  }
  aw.closeSync();
  await duck.run(`create view raw as select * from read_csv(${sql(csv)}, header = true, all_varchar = true)`);
  await duck.run(`create table s as
    with x as (
      select trim(CompanyNumber) as company_number, trim(CompanyName) as name, CompanyStatus as status, CompanyCategory as category,
        array_to_string(list_filter([r."SICCode.SicText_1", r."SICCode.SicText_2", r."SICCode.SicText_3", r."SICCode.SicText_4"], v -> v is not null and trim(v) <> ''), '|') as sic,
        IncorporationDate as incorporated, r."Accounts.AccountCategory" as acct_category, r."Accounts.LastMadeUpDate" as last_made_up,
        r."RegAddress.AddressLine1" as line1, r."RegAddress.AddressLine2" as line2, r."RegAddress.PostTown" as post_town,
        r."RegAddress.County" as county, r."RegAddress.Country" as country, r."RegAddress.PostCode" as postcode,
        regexp_replace(trim(regexp_replace(regexp_replace(lower(coalesce(CompanyName, '')), '[^a-z0-9\\s]', '', 'g'), '\\s+', ' ', 'g')), '\\blimited\\b', 'ltd', 'g') as name_norm,
        upper(regexp_replace(coalesce(r."RegAddress.PostCode", ''), '[^A-Za-z0-9]', '', 'g')) as pc_norm
      from raw r
    )
    select * from x
    where company_number in (select n from wanted)
       or name_norm in (select name_norm from m where name_norm <> '')
       or pc_norm in (select pc_norm from m where pc_norm <> '')`);
  const rows = async (q: string) => (await duck.runAndReadAll(q)).getRowObjects().map(big);
  const companies = new Map<string, Company>();
  for (const r of await rows(`select * from s`)) companies.set(String(r.company_number), r as unknown as Company);
  const exists = (n: string) => !!n && companies.has(n);

  const exactNP = new Map<string, string[]>();
  for (const r of await rows(`select m.id, s.company_number from m join s on s.name_norm = m.name_norm and s.pc_norm = m.pc_norm where m.name_norm <> '' and m.pc_norm <> ''`)) {
    exactNP.set(String(r.id), [...(exactNP.get(String(r.id)) ?? []), String(r.company_number)]);
  }
  const nameOnly = new Map<string, string[]>();
  for (const r of await rows(`select m.id, s.company_number from m join s on s.name_norm = m.name_norm and s.pc_norm <> m.pc_norm where m.name_norm <> ''`)) {
    nameOnly.set(String(r.id), [...(nameOnly.get(String(r.id)) ?? []), String(r.company_number)]);
  }
  const similar = new Map<string, { company_number: string; score: number }[]>();
  for (const r of await rows(
    `select m.id, s.company_number, jaro_winkler_similarity(s.name_norm, m.name_norm) as score from m join s on s.pc_norm = m.pc_norm
     where m.pc_norm <> '' and m.name_norm <> '' and s.name_norm <> m.name_norm and jaro_winkler_similarity(s.name_norm, m.name_norm) >= ${SIMILARITY}`,
  )) {
    similar.set(String(r.id), [...(similar.get(String(r.id)) ?? []), { company_number: String(r.company_number), score: Math.round(Number(r.score) * 1000) / 1000 }]);
  }

  // --- Decisions.
  type LinkRow = { branch_id: string; company_number: string; tier: "exact"; evidence: Record<string, unknown> };
  type PropRow = { kind: "branch_company"; subject_id: string; candidate: { company_number: string }; evidence: Record<string, unknown> };
  const links: LinkRow[] = [];
  const props: PropRow[] = [];
  const decisions = new Map<string, MemberDecision>();
  const listedNotInSnapshot: { member: string; listed: string | null }[] = [];
  const snapshotName = csv.split("/").pop();
  const companyBrief = (n: string) => {
    const c = companies.get(n)!;
    return { company_number: n, name: c.name, status: c.status, ro_postcode: c.postcode };
  };

  for (const r of chRows) {
    const n = r.source_company_number!;
    if (!exists(n)) throw new Error(`CH row ${r.id}: company ${n} not in snapshot`);
    links.push({
      branch_id: r.id,
      company_number: n,
      tier: "exact",
      evidence: { rule: "register_company_number_in_snapshot", register: "ch_bulk", company_number: n, snapshot: snapshotName },
    });
  }

  for (const m of members.values()) {
    if (m.listedRaw && !exists(m.listed)) listedNotInSnapshot.push({ member: m.id, listed: m.listedRaw });
    const d = decideMember({
      listedInSnapshot: exists(m.listed) ? m.listed : null,
      exactNamePostcode: exactNP.get(m.id) ?? [],
      otherPendingCompanies: [...(pendingDupCompanies.get(m.id) ?? [])],
    });
    decisions.set(m.id, d);
    const base = { member_id: m.id, member_legal_name: m.name, member_postcode: m.postcode, company_number_as_listed: m.listedRaw, snapshot: snapshotName };
    if (d.outcome === "link") {
      for (const b of m.rows) {
        links.push({
          branch_id: b.id,
          company_number: d.company_number,
          tier: "exact",
          evidence: {
            rule: d.signals[0].rule,
            rules: d.signals.map((s) => s.rule),
            register: "prs",
            ...base,
            company: companyBrief(d.company_number),
            name_matches: planNorm(m.name) === companies.get(d.company_number)!.name_norm,
            ...(b.source_type === "branch" ? { via: "parent member (ruling 12)" } : {}),
          },
        });
      }
      continue;
    }
    // Proposals: conflicts (P2) and, for members with no exact link, P3 candidates.
    const cands = new Map<string, Record<string, unknown>>();
    const add = (n: string, basis: string, extra: Record<string, unknown> = {}) => {
      const e = cands.get(n) ?? { basis: [] as string[], company: companyBrief(n) };
      (e.basis as string[]).push(basis);
      Object.assign(e, extra);
      cands.set(n, e);
    };
    if (d.outcome === "conflict") {
      for (const s of d.signals) add(s.company_number, s.rule);
      for (const c of d.companies) if (!cands.has(c) && exists(c)) add(c, "pending_duplicate_proposal");
    }
    for (const n of nameOnly.get(m.id) ?? []) add(n, "exact_name_different_postcode");
    for (const s of similar.get(m.id) ?? []) add(s.company_number, "similar_name_same_postcode", { similarity: s.score });
    const subjects = m.hasMemberRow ? m.rows.filter((b) => b.source_type === "member_address") : m.rows;
    const companySet = new Set([...cands.keys(), ...(pendingDupCompanies.get(m.id) ?? [])]);
    const conflict =
      companySet.size >= 2 || d.outcome === "conflict"
        ? { rule: "ruling 15", member_id: m.id, companies: [...companySet].sort(), note: "member has pending proposals against more than one company; review together, never accept automatically" }
        : undefined;
    for (const b of subjects) {
      for (const [n, e] of cands) {
        props.push({
          kind: "branch_company",
          subject_id: b.id,
          candidate: { company_number: n },
          evidence: { match_basis: e.basis, ...base, ...e, ...(d.outcome === "conflict" ? { conflict_reason: d.reason } : {}), ...(conflict ? { conflict } : {}), ...(b.source_type === "branch" ? { via: "parent member (ruling 12)" } : {}) },
        });
      }
    }
  }

  // Manually edited branch rows get no new link (ruling: never touch manually edited rows).
  const manual = new Set(branches.filter((b) => b.manually_edited).map((b) => b.id));
  const linksToWrite = links.filter((l) => !manual.has(l.branch_id));
  const linkedCompanies = [...new Set(linksToWrite.map((l) => l.company_number))].sort();

  // --- Report.
  const byId = new Map(branches.map((b) => [b.id, b]));
  const linkedBranchIds = new Set(linksToWrite.map((l) => l.branch_id));
  const tally = <T,>(xs: T[], k: (x: T) => string) => xs.reduce<Record<string, number>>((a, x) => ((a[k(x)] = (a[k(x)] ?? 0) + 1), a), {});
  const unlinked = branches.filter((b) => !linkedBranchIds.has(b.id));
  const outcomeOf = (b: Branch) => {
    const mid = b.redress_member_id ?? b.redress_parent_member_id;
    return mid ? decisions.get(mid)?.outcome ?? "none" : "ch";
  };
  const report = {
    snapshot: snapshotName,
    branches: branches.length,
    exact_linked_branches: tally(linksToWrite.map((l) => byId.get(l.branch_id)!), (b) => `${b.source_type}${b.in_scope ? " (in scope)" : ""}`),
    exact_linked_total: linkedBranchIds.size,
    exact_links_by_rule: tally(linksToWrite, (l) => String(l.evidence.rule)),
    prs_links_with_both_rules: linksToWrite.filter((l) => (l.evidence.rules as string[] | undefined)?.length === 2).length,
    prs_links_where_listed_name_differs_from_company_name: linksToWrite.filter((l) => l.evidence.name_matches === false).map((l) => ({ member: l.evidence.member_id, listed_name: l.evidence.member_legal_name, company: l.evidence.company })),
    member_outcomes: tally([...decisions.values()], (d) => d.outcome),
    conflict_members: [...decisions].filter(([, d]) => d.outcome === "conflict").map(([id, d]) => ({ member: id, ...(d.outcome === "conflict" ? { companies: d.companies, reason: d.reason } : {}) })),
    proposals: props.length,
    proposals_by_basis: tally(props.flatMap((p) => p.evidence.match_basis as string[]), (b) => b),
    proposal_subjects: new Set(props.map((p) => p.subject_id)).size,
    unlinked_branches: tally(unlinked, (b) => `${b.source_type}${b.in_scope ? " (in scope)" : ""}`),
    unlinked_prs_rows_in_scope: unlinked
      .filter((b) => b.source_type !== "ch_registered_office" && b.in_scope)
      .map((b) => ({ branch_id: b.id, member: b.redress_member_id ?? b.redress_parent_member_id, type: b.source_type, outcome: outcomeOf(b), has_proposals: props.some((p) => p.subject_id === b.id) })),
    listed_company_number_not_in_snapshot: listedNotInSnapshot,
    companies_to_insert: linkedCompanies.length,
    manually_edited_skipped: links.length - linksToWrite.length,
  };
  console.log(JSON.stringify(report, null, 1));
  if (!write) {
    console.log("\ndry run: nothing written");
    return;
  }

  // --- Write (insert-only), after snapshots.
  const runId = await startRun(db, "link-companies --write", branches.length);
  const snaps: Snap[] = [];
  const out: Record<string, number> = {};
  try {
    snaps.push(await snapshot(db, "companies", ["company_number"]));
    snaps.push(await snapshot(db, "branch_company_links", ["branch_id", "company_number"]));
    snaps.push(await snapshot(db, "match_proposals", ["id"]));

    const haveCo = new Set((await readAll<{ company_number: string }>(db, "companies", "company_number", "company_number")).map((r) => r.company_number));
    const coRows = linkedCompanies
      .filter((n) => !haveCo.has(n))
      .map((n) => {
        const c = companies.get(n)!;
        return {
          company_number: n,
          name: c.name,
          status: c.status,
          sic_codes: (c.sic ?? "").split("|").map((v) => v.trim().slice(0, 5)).filter((v) => /^\d{5}$/.test(v)),
          incorporated_on: isoDate(c.incorporated),
          registered_office: { address_line_1: c.line1, address_line_2: c.line2, post_town: c.post_town, county: c.county, country: c.country, postcode: c.postcode, source: `bulk snapshot ${snapshotName}` },
          accounts_type: c.acct_category,
          last_accounts_made_up_to: isoDate(c.last_made_up),
        };
      });
    for (let i = 0; i < coRows.length; i += 500) {
      const { error } = await db.from("companies").insert(coRows.slice(i, i + 500));
      if (error) throw new Error(`companies insert: ${error.message}`);
    }
    out.companies_inserted = coRows.length;
    out.companies_already_present = linkedCompanies.length - coRows.length;

    const haveLinks = new Set((await readAll<{ branch_id: string; company_number: string }>(db, "branch_company_links", "branch_id, company_number", "branch_id")).map((l) => `${l.branch_id}|${l.company_number}`));
    const newLinks = linksToWrite.filter((l) => !haveLinks.has(`${l.branch_id}|${l.company_number}`));
    for (let i = 0; i < newLinks.length; i += 500) {
      const { error } = await db.from("branch_company_links").insert(newLinks.slice(i, i + 500));
      if (error) throw new Error(`branch_company_links insert: ${error.message}`);
    }
    out.links_inserted = newLinks.length;
    out.links_already_present = linksToWrite.length - newLinks.length;

    const existing = await readAll<{ subject_id: string; candidate: { company_number?: string } }>(db, "match_proposals", "subject_id, candidate", "id", [["kind", "branch_company"]]);
    const haveProps = new Set(existing.map((p) => `${p.subject_id}|${p.candidate?.company_number}`));
    const newProps = props.filter((p) => !haveProps.has(`${p.subject_id}|${p.candidate.company_number}`));
    for (let i = 0; i < newProps.length; i += 500) {
      const { error } = await db.from("match_proposals").insert(newProps.slice(i, i + 500));
      if (error) throw new Error(`match_proposals insert: ${error.message}`);
    }
    out.proposals_inserted = newProps.length;
    out.proposals_already_present = props.length - newProps.length;
    // Evidence that differs from what is stored is reported, never overwritten (insert-only).
    const stored = await readAll<{ subject_id: string; candidate: { company_number?: string }; evidence: unknown }>(db, "match_proposals", "subject_id, candidate, evidence", "id", [["kind", "branch_company"]]);
    const storedMap = new Map(stored.map((p) => [`${p.subject_id}|${p.candidate?.company_number}`, canon(p.evidence)]));
    out.proposals_evidence_differs_not_updated = props.filter((p) => storedMap.get(`${p.subject_id}|${p.candidate.company_number}`) !== canon(p.evidence)).length;
  } finally {
    await finishRun(db, runId, (out.companies_inserted ?? 0) + (out.links_inserted ?? 0) + (out.proposals_inserted ?? 0), snaps, { ...out, report_summary: { exact_linked_total: report.exact_linked_total, proposals: report.proposals } });
  }
  console.log(`\nwritten: ${JSON.stringify(out)}\nsnapshots: ${snaps.map((s) => s.snapshot_table).join(", ")}\ningest_run: ${runId}`);
}

main().catch((e) => {
  console.error("link-companies failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
