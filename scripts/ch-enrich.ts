// Phase 4 steps 4-6: enrich linked companies from the Companies House REST API (profile,
// officers, PSCs) and resolve PSC chains (depth <= 5).
//
//   --fetch    call the API for anything not yet cached (rate-limited), cache to cache/ch/api/.
//   --write    snapshot companies / officers / pscs / psc_chains, then insert new and update
//              changed rows from the cache (never rows with manually_edited = true; never delete).
//   (neither)  dry run from the cache: report what would be written.
//
// Which companies (provisional ruling P5): linked companies whose linked branch is in scope and
// not likely_rmc (0R.5). Rate (P6): at most 500 requests in any 300 s window and at least 610 ms
// apart, under the documented 600 per 5 minutes. A 429 (rate limited), 401 or 403 stops the
// source immediately. Network errors and 5xx retry up to 3 times with backoff; 10 consecutive
// failures stop the source. Every request is logged to cache/ch/requests.jsonl (no key).
//
// Personal data (0R.1, P7): officers keep name, role, appointment/resignation dates and the month
// and year of birth as published; PSCs keep name, kind, notified/ceased dates and corporate
// identification. Addresses, nationality, occupation and country of residence are dropped
// before anything is cached.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildChain, pscKind, ukCompanyNumber, type ChainPsc } from "./lib/phase4";
import { canon, env, finishRun, readAll, serviceClient, snapshot, startRun, type Snap } from "./lib/db";

const doFetch = process.argv.includes("--fetch");
const doWrite = process.argv.includes("--write");
const limitArg = process.argv.includes("--limit") ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : undefined; // trial runs only
const API = "https://api.company-information.service.gov.uk";
const DIR = join("cache", "ch", "api");
const LOG = join("cache", "ch", "requests.jsonl");
const FAILURES = join("cache", "ch", "failures.json");
const MIN_SPACING_MS = 610; // 600 ms minimum plus a margin for timer rounding
const WINDOW_MS = 300_000;
const WINDOW_MAX = 500;

type Kind = "profile" | "officers" | "pscs";
type Cached = { fetched_at: string; status: number; data: unknown };

// --- Allowlists (applied before caching).
const pick = (o: unknown, keys: string[]) =>
  o && typeof o === "object" ? Object.fromEntries(keys.filter((k) => k in (o as object)).map((k) => [k, (o as Record<string, unknown>)[k]])) : null;
function allowProfile(p: Record<string, unknown>) {
  const acc = (p.accounts as Record<string, unknown> | undefined)?.last_accounts;
  return {
    company_name: p.company_name ?? null,
    company_number: p.company_number ?? null,
    company_status: p.company_status ?? null,
    type: p.type ?? null,
    date_of_creation: p.date_of_creation ?? null,
    sic_codes: Array.isArray(p.sic_codes) ? p.sic_codes : [],
    registered_office_address: pick(p.registered_office_address, ["premises", "address_line_1", "address_line_2", "locality", "region", "postal_code", "country"]),
    last_accounts: pick(acc, ["made_up_to", "type"]),
  };
}
const allowOfficer = (o: Record<string, unknown>) => ({
  name: o.name ?? null,
  officer_role: o.officer_role ?? null,
  appointed_on: o.appointed_on ?? null,
  resigned_on: o.resigned_on ?? null,
  date_of_birth: pick(o.date_of_birth, ["month", "year"]),
});
const allowPsc = (p: Record<string, unknown>) => ({
  name: p.name ?? null,
  kind: p.kind ?? null,
  notified_on: p.notified_on ?? null,
  ceased_on: p.ceased_on ?? null,
  identification: pick(p.identification, ["registration_number", "country_registered", "place_registered", "legal_form", "legal_authority"]),
});

// --- Cache.
const cachePath = (n: string, k: Kind) => join(DIR, n, `${k}.json`);
const readCache = (n: string, k: Kind): Cached | null => (existsSync(cachePath(n, k)) ? JSON.parse(readFileSync(cachePath(n, k), "utf8")) : null);
function writeCache(n: string, k: Kind, c: Cached) {
  mkdirSync(join(DIR, n), { recursive: true });
  writeFileSync(cachePath(n, k), JSON.stringify(c));
}

// --- Rate-limited client.
class StopSource extends Error {}
const auth = `Basic ${Buffer.from(`${env("COMPANIES_HOUSE_API_KEY")}:`).toString("base64")}`;
const sent: number[] = [];
let consecutiveFailures = 0;
let requests = 0;
const failures: { company: string; kind: Kind; reason: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function slot() {
  for (;;) {
    const now = Date.now();
    while (sent.length && now - sent[0] >= WINDOW_MS) sent.shift();
    const last = sent[sent.length - 1] ?? 0;
    const waitSpacing = last + MIN_SPACING_MS - now;
    const waitWindow = sent.length >= WINDOW_MAX ? sent[0] + WINDOW_MS - now : 0;
    const wait = Math.max(waitSpacing, waitWindow);
    if (wait <= 0) break;
    await sleep(wait);
  }
  sent.push(Date.now());
}

async function getJson(path: string, company: string, kind: Kind): Promise<{ status: number; body: unknown }> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    await slot();
    requests++;
    const t0 = Date.now();
    let status = 0;
    try {
      const res = await fetch(`${API}${path}`, { headers: { Authorization: auth, Accept: "application/json" } });
      status = res.status;
      appendFileSync(LOG, `${JSON.stringify({ t: new Date(t0).toISOString(), kind, company, status, ms: Date.now() - t0 })}\n`);
      if (status === 429) throw new StopSource("HTTP 429 rate limited: stopping the Companies House source");
      if (status === 401 || status === 403) throw new StopSource(`HTTP ${status}: stopping the Companies House source`);
      if (status === 404) {
        consecutiveFailures = 0;
        return { status, body: null };
      }
      if (res.ok) {
        consecutiveFailures = 0;
        return { status, body: await res.json() };
      }
    } catch (e) {
      if (e instanceof StopSource) throw e;
      appendFileSync(LOG, `${JSON.stringify({ t: new Date(t0).toISOString(), kind, company, status: "network_error", ms: Date.now() - t0 })}\n`);
    }
    if (++consecutiveFailures >= 10) throw new StopSource("10 consecutive failures: stopping the Companies House source");
    if (attempt < 3) await sleep(2000 * 2 ** attempt);
  }
  throw new Error(`failed after retries (last status ${requests})`);
}

async function fetchList(path: string, company: string, kind: Kind, allow: (x: Record<string, unknown>) => unknown) {
  const items: unknown[] = [];
  for (let start = 0; ; start += 100) {
    const r = await getJson(`${path}?items_per_page=100&start_index=${start}`, company, kind);
    if (r.status === 404) return { status: 404, items };
    const body = r.body as { items?: Record<string, unknown>[]; total_results?: number };
    const page = body.items ?? [];
    items.push(...page.map(allow));
    const total = body.total_results ?? page.length;
    if (page.length < 100 || items.length >= total) return { status: 200, items };
  }
}

async function ensure(n: string, k: Kind) {
  if (readCache(n, k)) return;
  try {
    if (k === "profile") {
      const r = await getJson(`/company/${n}`, n, k);
      writeCache(n, k, { fetched_at: new Date().toISOString(), status: r.status, data: r.body ? allowProfile(r.body as Record<string, unknown>) : null });
    } else if (k === "officers") {
      const r = await fetchList(`/company/${n}/officers`, n, k, allowOfficer);
      writeCache(n, k, { fetched_at: new Date().toISOString(), status: r.status, data: r.items });
    } else {
      const r = await fetchList(`/company/${n}/persons-with-significant-control`, n, k, allowPsc);
      writeCache(n, k, { fetched_at: new Date().toISOString(), status: r.status, data: r.items });
    }
  } catch (e) {
    if (e instanceof StopSource) throw e;
    failures.push({ company: n, kind: k, reason: e instanceof Error ? e.message : String(e) });
  }
}

function chainPscs(n: string): ChainPsc[] | null {
  const c = readCache(n, "pscs");
  if (!c || c.status !== 200) return null;
  return (c.data as ReturnType<typeof allowPsc>[]).map((p) => ({
    name: String(p.name ?? ""),
    kind: pscKind(p.kind as string),
    ceased_on: (p.ceased_on as string) ?? null,
    uk_company_number: pscKind(p.kind as string) === "corporate" ? ukCompanyNumber(p.identification as Record<string, unknown>) : null,
  }));
}

function rateEvidence() {
  if (!existsSync(LOG)) return null;
  const ts = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: string; status: number | string });
  const times = ts.map((x) => Date.parse(x.t)).sort((a, b) => a - b);
  let maxWindow = 0;
  let minGap = Infinity;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i] - times[j] >= WINDOW_MS) j++;
    maxWindow = Math.max(maxWindow, i - j + 1);
    if (i) minGap = Math.min(minGap, times[i] - times[i - 1]);
  }
  const byStatus = ts.reduce<Record<string, number>>((a, x) => ((a[String(x.status)] = (a[String(x.status)] ?? 0) + 1), a), {});
  return { logged_requests: ts.length, by_status: byStatus, max_in_any_300s_window: maxWindow, documented_limit_per_300s: 600, min_gap_ms: Number.isFinite(minGap) ? minGap : null, first: ts[0]?.t, last: ts[ts.length - 1]?.t };
}

async function main() {
  const db = serviceClient();
  const linked = await readAll<{ company_number: string; branch_id: string }>(db, "branch_company_links", "company_number, branch_id", "branch_id");
  const br = await readAll<{ id: string; in_scope: boolean | null; likely_rmc: boolean }>(db, "branches", "id, in_scope, likely_rmc", "id");
  const brById = new Map(br.map((b) => [b.id, b]));
  const allTargets = [...new Set(linked.filter((l) => brById.get(l.branch_id)?.in_scope === true && !brById.get(l.branch_id)?.likely_rmc).map((l) => l.company_number))].sort();
  const targets = limitArg ? allTargets.slice(0, limitArg) : allTargets;
  if (limitArg && doWrite) throw new Error("--limit is for trial fetches only; never write a partial set");

  if (doFetch) {
    mkdirSync(DIR, { recursive: true });
    // Seed the rate window from the request log so a restarted run cannot exceed the limit
    // across the restart (requests sent in the last 300 s still count).
    if (existsSync(LOG)) {
      const cutoff = Date.now() - WINDOW_MS;
      const recent = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => Date.parse((JSON.parse(l) as { t: string }).t)).filter((t) => t > cutoff).sort((x, y) => x - y);
      sent.push(...recent);
      console.log(`rate window seeded with ${recent.length} requests from the last 300 s`);
    }
    let stop: string | undefined;
    try {
      let i = 0;
      for (const n of targets) {
        for (const k of ["profile", "officers", "pscs"] as Kind[]) await ensure(n, k);
        if (++i % 100 === 0) console.log(`fetched ${i}/${targets.length} companies; requests this run ${requests}`);
      }
      // Chain parents: follow single active UK corporate PSCs up to depth 5.
      let frontier = targets;
      const seen = new Set(targets);
      for (let depth = 1; depth <= 5 && frontier.length; depth++) {
        const next: string[] = [];
        for (const n of frontier) {
          const corp = (chainPscs(n) ?? []).filter((p) => p.kind === "corporate" && !p.ceased_on && p.uk_company_number);
          if (corp.length !== 1) continue;
          const parent = corp[0].uk_company_number!;
          if (seen.has(parent)) continue;
          seen.add(parent);
          await ensure(parent, "pscs");
          next.push(parent);
        }
        console.log(`chain depth ${depth}: ${next.length} parent companies`);
        frontier = next;
      }
    } catch (e) {
      stop = e instanceof Error ? e.message : String(e);
      console.error(`STOPPED: ${stop}`);
    }
    writeFileSync(FAILURES, JSON.stringify(failures, null, 1));
    console.log(JSON.stringify({ requests_this_run: requests, failures: failures.length, stop, rate: rateEvidence() }, null, 1));
    if (stop) process.exit(2);
    return;
  }

  // --- Build rows from the cache.
  const companies: Record<string, unknown>[] = [];
  const officers = new Map<string, Record<string, unknown>>();
  const pscs = new Map<string, Record<string, unknown>>();
  const chains: Record<string, unknown>[] = [];
  const missing: { company: string; kind: Kind }[] = [];
  const pscsWithoutName: { company: string; kind: string | null }[] = [];
  const notFound: { company: string; kind: Kind }[] = [];
  for (const n of targets) {
    const p = readCache(n, "profile");
    const o = readCache(n, "officers");
    const s = readCache(n, "pscs");
    for (const [k, c] of [["profile", p], ["officers", o], ["pscs", s]] as [Kind, Cached | null][]) {
      if (!c) missing.push({ company: n, kind: k });
      else if (c.status === 404) notFound.push({ company: n, kind: k });
    }
    if (p?.status === 200 && p.data) {
      const d = p.data as ReturnType<typeof allowProfile>;
      companies.push({
        company_number: n,
        name: d.company_name,
        status: d.company_status,
        sic_codes: d.sic_codes,
        incorporated_on: d.date_of_creation,
        registered_office: { ...(d.registered_office_address ?? {}), source: "companies house api" },
        accounts_type: d.last_accounts?.type ?? null,
        last_accounts_made_up_to: d.last_accounts?.made_up_to ?? null,
        fetched_at: p.fetched_at,
      });
    }
    if (o?.status === 200) {
      for (const x of o.data as ReturnType<typeof allowOfficer>[]) {
        const row = {
          company_number: n,
          name: x.name,
          role: x.officer_role,
          appointed_on: x.appointed_on,
          resigned_on: x.resigned_on,
          dob_month: (x.date_of_birth?.month as number | undefined) ?? null,
          dob_year: (x.date_of_birth?.year as number | undefined) ?? null,
          fetched_at: o.fetched_at,
        };
        officers.set(`${n}|${row.name}|${row.role}|${row.appointed_on}`, row);
      }
    }
    if (s?.status === 200) {
      for (const x of s.data as ReturnType<typeof allowPsc>[]) {
        // pscs.name is NOT NULL and names are never invented: nameless entries (e.g. super-secure
        // PSCs) are skipped and reported.
        if (!x.name) {
          pscsWithoutName.push({ company: n, kind: (x.kind as string) ?? null });
          continue;
        }
        const kind = pscKind(x.kind as string);
        const row = {
          company_number: n,
          name: x.name,
          kind,
          corporate_company_number: kind === "corporate" ? ukCompanyNumber(x.identification as Record<string, unknown>) : null,
          notified_on: x.notified_on,
          ceased_on: x.ceased_on,
          fetched_at: s.fetched_at,
        };
        pscs.set(`${n}|${row.name}|${row.kind}|${row.notified_on}`, row);
      }
    }
    if (p?.status === 200 && s) {
      const r = buildChain({ company_number: n, name: (p.data as ReturnType<typeof allowProfile>).company_name as string }, chainPscs);
      chains.push({ company_number: n, chain: r.chain, depth: r.depth, top_entity_number: r.top_entity_number });
    }
  }
  const depthTally = chains.reduce<Record<string, number>>((a, c) => ((a[String(c.depth)] = (a[String(c.depth)] ?? 0) + 1), a), {});
  const report = {
    targets: targets.length,
    profiles: companies.length,
    officers: officers.size,
    active_officers: [...officers.values()].filter((o) => !o.resigned_on).length,
    pscs: pscs.size,
    corporate_pscs_with_uk_number: [...pscs.values()].filter((p) => p.corporate_company_number).length,
    chains: chains.length,
    chain_depths: depthTally,
    chains_with_notes: chains.filter((c) => (c.chain as { note?: string }[]).some((s) => s.note)).length,
    pscs_skipped_without_name: pscsWithoutName,
    not_cached: missing.length,
    not_found_404: notFound,
    rate: rateEvidence(),
  };
  console.log(JSON.stringify(report, null, 1));
  if (!doWrite) {
    console.log("\ndry run: nothing written");
    return;
  }

  const runId = await startRun(db, "ch-enrich --write", targets.length);
  const snaps: Snap[] = [];
  const out: Record<string, number> = {};
  try {
    snaps.push(await snapshot(db, "companies", ["company_number"]));
    snaps.push(await snapshot(db, "officers", ["id"]));
    snaps.push(await snapshot(db, "pscs", ["id"]));
    snaps.push(await snapshot(db, "psc_chains", ["company_number"]));

    // companies: update changed, never manually edited (rows exist from link-companies).
    const coCols = ["name", "status", "sic_codes", "incorporated_on", "registered_office", "accounts_type", "last_accounts_made_up_to", "fetched_at"];
    const haveCo = new Map((await readAll<Record<string, unknown>>(db, "companies", `company_number, manually_edited, ${coCols.join(", ")}`, "company_number")).map((r) => [String(r.company_number), r]));
    let coUpd = 0, coIns = 0, coManual = 0;
    for (const c of companies) {
      const e = haveCo.get(String(c.company_number));
      if (!e) {
        const { error } = await db.from("companies").insert(c);
        if (error) throw new Error(`companies insert: ${error.message}`);
        coIns++;
      } else if (e.manually_edited) coManual++;
      else if (coCols.some((k) => canon(e[k] ?? null) !== canon(c[k] ?? null))) {
        const { error } = await db.from("companies").update(c).eq("company_number", c.company_number as string).eq("manually_edited", false);
        if (error) throw new Error(`companies update: ${error.message}`);
        coUpd++;
      }
    }
    Object.assign(out, { companies_inserted: coIns, companies_updated: coUpd, companies_manually_edited_skipped: coManual });

    // officers / pscs: insert new keys, update changed fields, skip manually edited, never delete.
    async function sync(table: "officers" | "pscs", rows: Map<string, Record<string, unknown>>, keyCols: string[], cols: string[]) {
      const have = await readAll<Record<string, unknown>>(db, table, `id, manually_edited, ${[...keyCols, ...cols].join(", ")}`, "id");
      const byKey = new Map(have.map((r) => [keyCols.map((k) => String(r[k] ?? null)).join("|"), r]));
      const ins: Record<string, unknown>[] = [];
      let upd = 0, manual = 0;
      for (const r of rows.values()) {
        const e = byKey.get(keyCols.map((k) => String(r[k] ?? null)).join("|"));
        if (!e) ins.push(r);
        else if (e.manually_edited) manual++;
        else if (cols.some((k) => canon(e[k] ?? null) !== canon(r[k] ?? null))) {
          const { error } = await db.from(table).update(r).eq("id", e.id as string).eq("manually_edited", false);
          if (error) throw new Error(`${table} update: ${error.message}`);
          upd++;
        }
      }
      for (let i = 0; i < ins.length; i += 500) {
        const { error } = await db.from(table).insert(ins.slice(i, i + 500));
        if (error) throw new Error(`${table} insert: ${error.message}`);
      }
      out[`${table}_inserted`] = ins.length;
      out[`${table}_updated`] = upd;
      out[`${table}_manually_edited_skipped`] = manual;
    }
    await sync("officers", officers, ["company_number", "name", "role", "appointed_on"], ["resigned_on", "dob_month", "dob_year", "fetched_at"]);
    await sync("pscs", pscs, ["company_number", "name", "kind", "notified_on"], ["corporate_company_number", "ceased_on", "fetched_at"]);

    // psc_chains: one row per company; insert or update when the chain changes.
    const haveCh = new Map((await readAll<Record<string, unknown>>(db, "psc_chains", "company_number, chain, depth, top_entity_number", "company_number")).map((r) => [String(r.company_number), r]));
    let chIns = 0, chUpd = 0;
    for (const c of chains) {
      const e = haveCh.get(String(c.company_number));
      if (!e) {
        const { error } = await db.from("psc_chains").insert(c);
        if (error) throw new Error(`psc_chains insert: ${error.message}`);
        chIns++;
      } else if (["chain", "depth", "top_entity_number"].some((k) => canon(e[k]) !== canon(c[k]))) {
        const { error } = await db.from("psc_chains").update({ ...c, computed_at: new Date().toISOString() }).eq("company_number", c.company_number as string);
        if (error) throw new Error(`psc_chains update: ${error.message}`);
        chUpd++;
      }
    }
    Object.assign(out, { psc_chains_inserted: chIns, psc_chains_updated: chUpd });
  } finally {
    const written = Object.entries(out).filter(([k]) => /_(inserted|updated)$/.test(k)).reduce((s, [, v]) => s + v, 0);
    await finishRun(db, runId, written, snaps, { ...out, rate: report.rate });
  }
  console.log(`\nwritten: ${JSON.stringify(out)}\nsnapshots: ${snaps.map((s) => s.snapshot_table).join(", ")}\ningest_run: ${runId}`);
}

main().catch((e) => {
  console.error("ch-enrich failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
