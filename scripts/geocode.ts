// Phase 3 step 3: geocode every postcode in the PRS cache and the CH candidate extract via the
// postcodes.io bulk endpoint (100 per call). Results go to /cache/postcodes/lookup.json.
// Postcodes that do not resolve are checked against /terminated_postcodes and recorded as
// "terminated" or "not_found"; badly formed ones as "bad_format". None are ever corrected.
//
// Also derives the Surrey district codes (ruling 0R.6): every admin_district code whose
// admin_county is Surrey, from these responses. Asserts exactly 11 and reports them, and
// reports if postcodes.io starts returning the new East/West Surrey unitary codes.
//
// Usage: pnpm tsx scripts/geocode.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readPrsCache } from "./prs-fetch";
import type { ChCandidate } from "./ch-candidates";

export type Geo =
  | {
      status: "ok";
      postcode: string;
      outcode: string;
      lat: number | null;
      lng: number | null;
      admin_district: string | null;
      admin_district_code: string | null;
      admin_county: string | null;
      admin_county_code: string | null;
    }
  | { status: "terminated" | "not_found" | "bad_format" };

const LOOKUP = "cache/postcodes/lookup.json";
const DISTRICTS = "cache/postcodes/surrey-districts.json";
const PC_SHAPE = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/;

/** Upper-case, strip everything but letters and digits. Never alters the characters themselves. */
export const normPostcode = (pc: unknown) => (typeof pc === "string" ? pc.toUpperCase().replace(/[^A-Z0-9]/g, "") : "");

export function loadLookup(): Record<string, Geo> {
  return existsSync(LOOKUP) ? JSON.parse(readFileSync(LOOKUP, "utf8")) : {};
}
export function loadSurreyDistricts(): { codes: string[]; names: Record<string, string> } {
  return JSON.parse(readFileSync(DISTRICTS, "utf8"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson(url: string, body: unknown, attempt = 0): Promise<unknown> {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await sleep(2000 * 2 ** attempt);
    return postJson(url, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

type PioResult = {
  postcode: string;
  outcode: string;
  latitude: number | null;
  longitude: number | null;
  admin_district: string | null;
  admin_county: string | null;
  codes: { admin_district: string | null; admin_county: string | null };
};

async function main() {
  const wanted = new Set<string>();
  for (const { record } of readPrsCache()) wanted.add(normPostcode(record.fdPostCode));
  if (existsSync("cache/ch/candidates.json")) {
    const ch = JSON.parse(readFileSync("cache/ch/candidates.json", "utf8")).candidates as ChCandidate[];
    for (const c of ch) wanted.add(normPostcode(c.postcode));
  }
  wanted.delete("");

  const lookup = loadLookup();
  const todo = [...wanted].filter((pc) => !(pc in lookup));
  for (const pc of todo) if (!PC_SHAPE.test(pc)) lookup[pc] = { status: "bad_format" };
  const send = todo.filter((pc) => !(pc in lookup));
  console.log(`postcodes: ${wanted.size} unique; ${send.length} to look up; ${wanted.size - todo.length} cached`);

  const unresolved: string[] = [];
  for (let i = 0; i < send.length; i += 100) {
    const batch = send.slice(i, i + 100);
    const res = (await postJson("https://api.postcodes.io/postcodes", { postcodes: batch })) as {
      result: { query: string; result: PioResult | null }[];
    };
    for (const { query, result: r } of res.result) {
      if (!r) {
        unresolved.push(query);
        continue;
      }
      lookup[query] = {
        status: "ok",
        postcode: r.postcode,
        outcode: r.outcode,
        lat: r.latitude,
        lng: r.longitude,
        admin_district: r.admin_district,
        admin_district_code: r.codes.admin_district,
        admin_county: r.admin_county,
        admin_county_code: r.codes.admin_county,
      };
    }
    await sleep(200);
  }
  for (const pc of unresolved) {
    const t = await postJson(`https://api.postcodes.io/terminated_postcodes/${pc}`, null);
    lookup[pc] = { status: t ? "terminated" : "not_found" };
    await sleep(200);
  }

  mkdirSync("cache/postcodes", { recursive: true });
  writeFileSync(LOOKUP, JSON.stringify(lookup));

  // Surrey district codes, derived from the data (0R.6).
  const names: Record<string, string> = {};
  const unitary: string[] = [];
  for (const g of Object.values(lookup)) {
    if (g.status !== "ok") continue;
    if (g.admin_county === "Surrey" && g.admin_district_code && g.admin_district) {
      names[g.admin_district_code] = g.admin_district;
    }
    if (g.admin_district && /^(East|West) Surrey$/.test(g.admin_district) && g.admin_district_code) {
      unitary.push(`${g.admin_district} ${g.admin_district_code}`);
    }
  }
  const codes = Object.keys(names).sort();
  const statusCounts = Object.values(lookup).reduce<Record<string, number>>((m, g) => {
    m[g.status] = (m[g.status] ?? 0) + 1;
    return m;
  }, {});
  console.log(`lookup status counts: ${JSON.stringify(statusCounts)}`);
  console.log(`Surrey districts derived from postcodes.io (admin_county = Surrey): ${codes.length}`);
  for (const c of codes) console.log(`  ${c}  ${names[c]}`);
  if (unitary.length) console.log(`NOTE: new unitary authority codes returned: ${[...new Set(unitary)].join(", ")}`);
  if (codes.length !== 11 && !unitary.length) {
    throw new Error(`expected 11 Surrey district codes, derived ${codes.length}; stopping for review`);
  }
  writeFileSync(DISTRICTS, JSON.stringify({ derived_at: new Date().toISOString(), codes, names, unitary }, null, 1));
}

if (process.argv[1]?.endsWith("geocode.ts")) {
  main().catch((e) => {
    console.error("geocode failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
