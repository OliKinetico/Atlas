// Phase 4 acceptance evidence (read-only). Prints:
//   - branches exact-linked / unlinked by source_type and scope, proposals by kind and basis;
//   - 10 random exact links with their evidence (seeded, reproducible);
//   - proof that no link lacks exact-tier evidence;
//   - API rate evidence from cache/ch/requests.jsonl;
//   - members in the 78 outcodes with a company number but no ch_registered_office row.
// Usage: pnpm tsx scripts/phase4-report.ts
import { existsSync, readFileSync } from "node:fs";
import { canonicalCoNumber } from "./lib/phase4";
import { readAll, serviceClient } from "./lib/db";

const EXACT_RULES = new Set(["register_company_number_in_snapshot", "exact_name_and_postcode"]);

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

async function main() {
  const db = serviceClient();
  const branches = await readAll<{ id: string; source_type: string; in_scope: boolean | null; likely_rmc: boolean; redress_member_id: string | null; redress_parent_member_id: string | null; company_number_listed: string | null; legal_name_as_listed: string | null; postcode: string | null; source_company_number: string | null }>(
    db,
    "branches",
    "id, source_type, in_scope, likely_rmc, redress_member_id, redress_parent_member_id, company_number_listed, legal_name_as_listed, postcode, source_company_number",
    "id",
  );
  const links = await readAll<{ branch_id: string; company_number: string; tier: string; evidence: Record<string, unknown> }>(db, "branch_company_links", "branch_id, company_number, tier, evidence", "branch_id");
  const props = await readAll<{ id: string; kind: string; status: string; subject_id: string; candidate: Record<string, unknown>; evidence: Record<string, unknown> }>(db, "match_proposals", "id, kind, status, subject_id, candidate, evidence", "id");
  const companies = await readAll<{ company_number: string; name: string }>(db, "companies", "company_number, name", "company_number");
  const coName = new Map(companies.map((c) => [c.company_number, c.name]));
  const byId = new Map(branches.map((b) => [b.id, b]));
  const linked = new Set(links.map((l) => l.branch_id));
  const key = (b: { source_type: string; in_scope: boolean | null }) => `${b.source_type}${b.in_scope ? " (in scope)" : b.in_scope === false ? " (outside Surrey)" : " (scope unknown)"}`;
  const tally = <T,>(xs: T[], k: (x: T) => string) => xs.reduce<Record<string, number>>((a, x) => ((a[k(x)] = (a[k(x)] ?? 0) + 1), a), {});

  const counts = {
    branches: branches.length,
    exact_linked: links.filter((l) => l.tier === "exact").length,
    accepted_proposal_links: links.filter((l) => l.tier === "accepted_proposal").length,
    linked_branches_by_type: tally(branches.filter((b) => linked.has(b.id)), key),
    unlinked_branches_by_type: tally(branches.filter((b) => !linked.has(b.id)), key),
    proposals_by_kind_status: tally(props, (p) => `${p.kind}: ${p.status}`),
    branch_company_proposals_by_basis: tally(props.filter((p) => p.kind === "branch_company").flatMap((p) => p.evidence.match_basis as string[]), (b) => b),
    ruling15_conflict_proposals: props.filter((p) => p.evidence.conflict).map((p) => ({ kind: p.kind, member: (p.evidence.conflict as Record<string, unknown>).member_id, company: p.candidate.company_number ?? p.evidence.other_company_number })),
  };

  // Proof: every link is tier exact with an exact-tier rule, and its company exists.
  const bad = links.filter(
    (l) =>
      l.tier !== "exact" ||
      !EXACT_RULES.has(String(l.evidence.rule)) ||
      !coName.has(l.company_number) ||
      (l.evidence.rule === "register_company_number_in_snapshot" &&
        byId.get(l.branch_id)?.source_type === "ch_registered_office" &&
        byId.get(l.branch_id)?.source_company_number !== l.company_number),
  );
  const fuzzyLinks = links.filter((l) => /similar|different_postcode|proposal/.test(JSON.stringify(l.evidence.rules ?? l.evidence.rule)));

  // 10 random exact links, stratified: 5 PRS-derived, 5 CH rows (seeded).
  const r = rng(20261002);
  const pickN = <T,>(xs: T[], n: number) => [...xs].sort(() => r() - 0.5).slice(0, n);
  const prsLinks = links.filter((l) => byId.get(l.branch_id)?.source_type !== "ch_registered_office").sort((a, b) => a.branch_id.localeCompare(b.branch_id));
  const chLinks = links.filter((l) => byId.get(l.branch_id)?.source_type === "ch_registered_office").sort((a, b) => a.branch_id.localeCompare(b.branch_id));
  const sample = [...pickN(prsLinks, 5), ...pickN(chLinks, 5)].map((l) => {
    const b = byId.get(l.branch_id)!;
    return {
      branch_id: l.branch_id,
      source_type: b.source_type,
      member: b.redress_member_id ?? b.redress_parent_member_id,
      listed_name: b.legal_name_as_listed,
      listed_number: b.company_number_listed,
      branch_postcode: b.postcode,
      company_number: l.company_number,
      company_name: coName.get(l.company_number),
      rule: l.evidence.rule,
      rules: l.evidence.rules,
      company_ro_postcode: (l.evidence.company as Record<string, unknown> | undefined)?.ro_postcode,
      name_matches: l.evidence.name_matches,
    };
  });

  // Rate evidence.
  let rate: unknown = "no request log";
  if (existsSync("cache/ch/requests.jsonl")) {
    const rows = readFileSync("cache/ch/requests.jsonl", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: string; status: number | string });
    const t = rows.map((x) => Date.parse(x.t)).sort((a, b) => a - b);
    let maxW = 0, minGap = Infinity;
    for (let i = 0, j = 0; i < t.length; i++) {
      while (t[i] - t[j] >= 300_000) j++;
      maxW = Math.max(maxW, i - j + 1);
      if (i) minGap = Math.min(minGap, t[i] - t[i - 1]);
    }
    rate = { requests: rows.length, by_status: tally(rows, (x) => String(x.status)), max_in_any_300s_window: maxW, documented_limit: "600 per 5 minutes", min_gap_ms: minGap, first: rows[0]?.t, last: rows[rows.length - 1]?.t };
  }

  // Members (78 outcodes) with a company number but no ch_registered_office row.
  const chNumbers = new Set(branches.filter((b) => b.source_type === "ch_registered_office").map((b) => b.source_company_number));
  const members = branches.filter((b) => b.source_type === "member_address");
  const withNo = members.filter((b) => b.company_number_listed && !chNumbers.has(canonicalCoNumber(b.company_number_listed) || b.company_number_listed));
  const coverage = {
    member_rows: members.length,
    with_company_number: members.filter((b) => b.company_number_listed).length,
    with_number_but_no_ch_row: withNo.length,
    in_scope_rows: members.filter((b) => b.in_scope).length,
    in_scope_with_number_but_no_ch_row: withNo.filter((b) => b.in_scope).length,
  };

  console.log(JSON.stringify({ counts, proof: { links: links.length, links_failing_exact_tier_check: bad.length, links_citing_a_non_exact_basis: fuzzyLinks.length }, sample_10_exact_links: sample, rate, coverage }, null, 1));
}

main().catch((e) => {
  console.error("phase4-report failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
