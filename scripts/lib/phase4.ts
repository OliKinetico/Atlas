// Phase 4 pure logic: name normalisation, exact-tier decisions, PSC mapping and chains.
// No I/O here, so it can be unit-tested (scripts/phase4.test.ts).

/**
 * The plan's exact-tier normalisation: lower-case, punctuation removed, "limited"/"ltd"
 * unified. Punctuation is deleted (not replaced by a space); whitespace is collapsed.
 * scripts/link-companies.ts applies the identical steps in SQL to the bulk snapshot.
 */
export function planNorm(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\blimited\b/g, "ltd");
}

/** Upper-case, letters and digits only. Formatting only; never corrects a postcode. */
export const pcNorm = (pc: string | null | undefined) => (pc ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const CO_SHAPE = /^(?:[A-Z]{2}\d{6}|\d{1,8})$/;
/** A listed company number in 8-character form (leading zeros restored), or "" if not that shape. */
export function canonicalCoNumber(v: unknown): string {
  const s = (typeof v === "string" || typeof v === "number" ? String(v) : "").toUpperCase().replace(/\s/g, "");
  if (!CO_SHAPE.test(s)) return "";
  return /^\d+$/.test(s) ? s.padStart(8, "0") : s;
}

export type ExactSignal = { rule: "register_company_number_in_snapshot" | "exact_name_and_postcode"; company_number: string };
export type MemberDecision =
  | { outcome: "link"; company_number: string; signals: ExactSignal[] }
  | { outcome: "conflict"; companies: string[]; signals: ExactSignal[]; reason: string }
  | { outcome: "none"; signals: [] };

/**
 * Exact tier (plan step 2, ruling 7), made cautious by ruling 15 (provisional ruling P2):
 * auto-link only when every exact signal points at the same single company and the member is
 * not already a ruling-15 conflict (pending duplicate proposals against other companies).
 */
export function decideMember(input: {
  listedInSnapshot: string | null; // canonical listed number, only if it exists in the snapshot
  exactNamePostcode: string[]; // companies with the same normalised name AND the same RO postcode
  otherPendingCompanies: string[]; // companies in this member's pending branch_duplicate proposals
}): MemberDecision {
  const signals: ExactSignal[] = [];
  if (input.listedInSnapshot) signals.push({ rule: "register_company_number_in_snapshot", company_number: input.listedInSnapshot });
  for (const c of [...new Set(input.exactNamePostcode)].sort()) signals.push({ rule: "exact_name_and_postcode", company_number: c });
  const exact = [...new Set(signals.map((s) => s.company_number))].sort();
  if (!exact.length) return { outcome: "none", signals: [] };
  if (exact.length > 1) return { outcome: "conflict", companies: exact, signals, reason: "exact signals point at different companies" };
  const others = [...new Set(input.otherPendingCompanies)].filter((c) => c !== exact[0]).sort();
  if (others.length) {
    return { outcome: "conflict", companies: [...exact, ...others].sort(), signals, reason: "pending duplicate proposals point at other companies (ruling 15)" };
  }
  return { outcome: "link", company_number: exact[0], signals };
}

export type PscKind = "individual" | "corporate" | "other";
export function pscKind(chKind: string | null | undefined): PscKind {
  const k = (chKind ?? "").toLowerCase();
  if (k.startsWith("individual-")) return "individual";
  if (k.startsWith("corporate-entity-")) return "corporate";
  return "other";
}

const UK_REGISTERS = /^(england|wales|england and wales|england & wales|scotland|northern ireland|united kingdom|uk|great britain|gb)$/i;
/**
 * The UK company number of a corporate PSC, only when the source says it is registered in the
 * UK and the number has a Companies House shape. Otherwise null: never guessed.
 */
export function ukCompanyNumber(identification: Record<string, unknown> | null | undefined): string | null {
  if (!identification) return null;
  const country = String(identification.country_registered ?? "").trim();
  const place = String(identification.place_registered ?? "").trim();
  const ukByCountry = UK_REGISTERS.test(country);
  const ukByPlace = /companies house|registrar of companies/i.test(place);
  if (!ukByCountry && !ukByPlace) return null;
  return canonicalCoNumber(identification.registration_number) || null;
}

export type ChainPsc = { name: string; kind: PscKind; ceased_on: string | null; uk_company_number: string | null };
export type ChainStep = { company_number: string; name: string | null; note?: string; candidates?: { company_number: string; name: string }[] };

/**
 * Follow active corporate PSCs with a UK company number, up to depth 5 (plan step 5).
 * Exactly one such PSC → follow it. More than one → record them and stop (no guess which
 * controls). A cycle or a missing PSC list stops the chain with a note.
 */
export function buildChain(
  start: { company_number: string; name: string | null },
  pscsOf: (companyNumber: string) => ChainPsc[] | null,
  maxDepth = 5,
): { chain: ChainStep[]; depth: number; top_entity_number: string } {
  const chain: ChainStep[] = [{ company_number: start.company_number, name: start.name }];
  const seen = new Set([start.company_number]);
  let current = start.company_number;
  for (let depth = 0; depth < maxDepth; depth++) {
    const pscs = pscsOf(current);
    if (!pscs) {
      chain[chain.length - 1].note = "PSC list not available";
      break;
    }
    const corp = pscs.filter((p) => p.kind === "corporate" && !p.ceased_on && p.uk_company_number);
    if (corp.length === 0) break;
    if (corp.length > 1) {
      chain[chain.length - 1].note = "multiple active UK corporate PSCs; not followed";
      chain[chain.length - 1].candidates = corp.map((p) => ({ company_number: p.uk_company_number!, name: p.name }));
      break;
    }
    const next = corp[0].uk_company_number!;
    if (seen.has(next)) {
      chain[chain.length - 1].note = `cycle back to ${next}; stopped`;
      break;
    }
    seen.add(next);
    chain.push({ company_number: next, name: corp[0].name });
    current = next;
  }
  if (chain.length - 1 === maxDepth && pscsOf(current)?.some((p) => p.kind === "corporate" && !p.ceased_on && p.uk_company_number)) {
    chain[chain.length - 1].note = `depth limit ${maxDepth} reached`;
  }
  return { chain, depth: chain.length - 1, top_entity_number: chain[chain.length - 1].company_number };
}
