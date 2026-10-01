// Unit tests for Phase 4 pure logic. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChain, canonicalCoNumber, decideMember, pcNorm, planNorm, pscKind, ukCompanyNumber, type ChainPsc } from "./lib/phase4";

test("planNorm: lower-case, punctuation removed, limited/ltd unified", () => {
  assert.equal(planNorm("SIMPLYLET.NET (GUILDFORD) LIMITED"), "simplyletnet guildford ltd");
  assert.equal(planNorm("Simplylet.net (Guildford) Ltd."), "simplyletnet guildford ltd");
  assert.equal(planNorm("  A   B  Ltd "), "a b ltd");
  assert.equal(planNorm("Smith & Jones Limited"), "smith jones ltd");
  assert.equal(planNorm("Unlimited Homes Ltd"), "unlimited homes ltd"); // whole word only
  assert.equal(planNorm(null), "");
});

test("pcNorm only reformats", () => {
  assert.equal(pcNorm("gu1 1aa"), "GU11AA");
  assert.equal(pcNorm(" GU14 7GZ "), "GU147GZ");
});

test("canonicalCoNumber pads digits, keeps prefixes, rejects other shapes", () => {
  assert.equal(canonicalCoNumber("1234567"), "01234567");
  assert.equal(canonicalCoNumber("sc 123456"), "SC123456");
  assert.equal(canonicalCoNumber(9882517), "09882517");
  assert.equal(canonicalCoNumber("123456789"), "");
  assert.equal(canonicalCoNumber("Reg No 12345678"), "");
  assert.equal(canonicalCoNumber(""), "");
});

test("decideMember: single agreeing exact signal links", () => {
  const d = decideMember({ listedInSnapshot: "01234567", exactNamePostcode: ["01234567"], otherPendingCompanies: [] });
  assert.equal(d.outcome, "link");
  if (d.outcome === "link") {
    assert.equal(d.company_number, "01234567");
    assert.equal(d.signals.length, 2);
  }
});

test("decideMember: disagreeing exact signals are a conflict, never a link", () => {
  const d = decideMember({ listedInSnapshot: "01234567", exactNamePostcode: ["07654321"], otherPendingCompanies: [] });
  assert.equal(d.outcome, "conflict");
});

test("decideMember: ruling 15 - other pending companies block the auto-link", () => {
  const d = decideMember({ listedInSnapshot: "09882517", exactNamePostcode: [], otherPendingCompanies: ["09882517", "09915156"] });
  assert.equal(d.outcome, "conflict");
  if (d.outcome === "conflict") assert.deepEqual(d.companies, ["09882517", "09915156"]);
});

test("decideMember: pending proposal for the same company does not block", () => {
  const d = decideMember({ listedInSnapshot: "01234567", exactNamePostcode: [], otherPendingCompanies: ["01234567"] });
  assert.equal(d.outcome, "link");
});

test("decideMember: no exact signal → none", () => {
  assert.equal(decideMember({ listedInSnapshot: null, exactNamePostcode: [], otherPendingCompanies: ["x"] }).outcome, "none");
});

test("pscKind maps CH kinds", () => {
  assert.equal(pscKind("individual-person-with-significant-control"), "individual");
  assert.equal(pscKind("corporate-entity-person-with-significant-control"), "corporate");
  assert.equal(pscKind("legal-person-person-with-significant-control"), "other");
  assert.equal(pscKind("super-secure-person-with-significant-control"), "other");
  assert.equal(pscKind(undefined), "other");
});

test("ukCompanyNumber only for UK registers with a CH-shaped number", () => {
  assert.equal(ukCompanyNumber({ country_registered: "England", registration_number: "1234567" }), "01234567");
  assert.equal(ukCompanyNumber({ country_registered: "United Kingdom", registration_number: "SC123456" }), "SC123456");
  assert.equal(ukCompanyNumber({ place_registered: "Companies House", registration_number: "12345678" }), "12345678");
  assert.equal(ukCompanyNumber({ country_registered: "Jersey", registration_number: "12345" }), null);
  assert.equal(ukCompanyNumber({ country_registered: "England", registration_number: "unknown" }), null);
  assert.equal(ukCompanyNumber(null), null);
});

test("buildChain follows a single UK corporate PSC and stops at individuals", () => {
  const data: Record<string, ChainPsc[]> = {
    A: [{ name: "B LTD", kind: "corporate", ceased_on: null, uk_company_number: "B" }],
    B: [{ name: "C LTD", kind: "corporate", ceased_on: null, uk_company_number: "C" }],
    C: [{ name: "Jane", kind: "individual", ceased_on: null, uk_company_number: null }],
  };
  const r = buildChain({ company_number: "A", name: "A LTD" }, (n) => data[n] ?? null);
  assert.deepEqual(r.chain.map((s) => s.company_number), ["A", "B", "C"]);
  assert.equal(r.depth, 2);
  assert.equal(r.top_entity_number, "C");
});

test("buildChain ignores ceased PSCs, stops at multiple corporates, cycles and depth 5", () => {
  const ceased = buildChain({ company_number: "A", name: null }, () => [{ name: "X", kind: "corporate", ceased_on: "2020-01-01", uk_company_number: "X" }]);
  assert.equal(ceased.depth, 0);
  const multi = buildChain({ company_number: "A", name: null }, () => [
    { name: "X", kind: "corporate", ceased_on: null, uk_company_number: "X" },
    { name: "Y", kind: "corporate", ceased_on: null, uk_company_number: "Y" },
  ]);
  assert.equal(multi.depth, 0);
  assert.equal(multi.chain[0].candidates?.length, 2);
  const cyc = buildChain({ company_number: "A", name: null }, (n) => [{ name: "n", kind: "corporate", ceased_on: null, uk_company_number: n === "A" ? "B" : "A" }]);
  assert.equal(cyc.depth, 1);
  assert.match(cyc.chain[1].note ?? "", /cycle/);
  let i = 0;
  const deep = buildChain({ company_number: "C0", name: null }, () => [{ name: "n", kind: "corporate", ceased_on: null, uk_company_number: `C${++i}` }]);
  assert.equal(deep.depth, 5);
  const missing = buildChain({ company_number: "A", name: null }, () => null);
  assert.equal(missing.depth, 0);
  assert.match(missing.chain[0].note ?? "", /not available/);
});
