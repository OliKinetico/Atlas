// Phase 3 step 1: fetch Property Redress (PRS) members for the approved postcode prefixes and
// cache them to /cache/prs/, keeping ONLY the business-field allowlist (ruling 0R.1).
// The raw response never touches disk or logs: it is filtered in memory, then written.
//
// Note: the endpoint's postcode filter is a substring match ("GU" also matches "N1 7GU"),
// so results are filtered to the approved outcodes downstream.
//
// Rules (0R.2 / 0R.4): prefixes GU KT RH TW SM CR TN SL only; at most 1 request every 2s;
// up to 3 retries per page with exponential backoff on network errors; 403/429 backs off and
// three blocks stop the run; 10 consecutive failed requests stop the run. One honest UA.
//
// Usage: pnpm tsx scripts/prs-fetch.ts [--prefix GU] [--from-cache]
//   Cached pages are reused (resume). --from-cache makes no network requests at all.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export const PRS_ALLOWLIST = [
  "fdId",
  "TradingName",
  "fdCompanyName",
  "fdRegisteredCoNo",
  "fdCorrespondanceAddressLine1",
  "fdCorrespondanceAddressLine2",
  "fdPostCode",
  "MemberStatus",
  "fdWorkType",
] as const;
export type PrsRecord = Partial<Record<(typeof PRS_ALLOWLIST)[number], string | number | null>>;

const PREFIXES = ["GU", "KT", "RH", "TW", "SM", "CR", "TN", "SL"];
const ENDPOINT = "https://www.portal.propertyredress.co.uk/propertyagent/GetMemberByAPI";
const CACHE = join(process.cwd(), "cache", "prs");
const MIN_INTERVAL_MS = 2000;
const MAX_RETRIES = 3;
const MAX_CONSECUTIVE_FAILURES = 10;
const MAX_BLOCKS = 3;
const MAX_PAGES = 1000; // safety stop per prefix

const args = process.argv.slice(2);
const fromCache = args.includes("--from-cache");
const onlyPrefix = args.includes("--prefix") ? args[args.indexOf("--prefix") + 1]?.toUpperCase() : undefined;

const EMAIL_LIKE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_LIKE = /(?:\+44\s?|\b0)(?:\d\s?){9,10}\b/;
const CO_NUMBER_SHAPE = /^(?:[A-Z]{2}\d{6}|\d{1,8})$/i;

/**
 * Keep allowlisted keys only. Values are coerced to string|number|null; nothing else survives.
 * Members sometimes type contact details into business fields (an email and a phone number
 * were found in fdRegisteredCoNo), so any email- or phone-shaped value is dropped, and a
 * company number is kept only if it has a company-number shape. Dropped, never corrected.
 */
export function allowlist(raw: unknown): PrsRecord {
  const out: PrsRecord = {};
  if (raw && typeof raw === "object") {
    for (const k of PRS_ALLOWLIST) {
      const v = (raw as Record<string, unknown>)[k];
      let keep = typeof v === "string" || typeof v === "number" ? v : null;
      if (typeof keep === "string" && (EMAIL_LIKE.test(keep) || PHONE_LIKE.test(keep))) keep = null;
      if (k === "fdRegisteredCoNo" && keep != null && !CO_NUMBER_SHAPE.test(String(keep).replace(/\s/g, ""))) keep = null;
      out[k] = keep;
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;
let requests = 0;
let consecutiveFailures = 0;
let blocks = 0;
const failures: { prefix: string; page: number; reason: string }[] = [];
const oddPayloads: { prefix: string; page: number; shape: string }[] = [];

class StopRun extends Error {}

async function throttle() {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/** Returns allowlisted records, or null when the payload is not a list (end or error). */
async function fetchPage(prefix: string, page: number): Promise<PrsRecord[] | null> {
  const url = `${ENDPOINT}?companyName=&postcode=${encodeURIComponent(prefix)}&status=Active&page=${page}`;
  const ua = `LettingsAtlas/0.1 (private research; low-rate; contact ${env("CRAWLER_CONTACT_EMAIL")})`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    requests++;
    let reason: string;
    try {
      const res = await fetch(url, { headers: { "User-Agent": ua, Accept: "application/json" } });
      if (res.status === 403 || res.status === 429) {
        blocks++;
        consecutiveFailures++;
        reason = `HTTP ${res.status}`;
        console.log(`  ${prefix} p${page}: ${reason} (block ${blocks}/${MAX_BLOCKS}), backing off 60s`);
        if (blocks >= MAX_BLOCKS) throw new StopRun(`${blocks} blocks (403/429): stopping as ruled in 0R.4`);
        await sleep(60_000);
      } else if (!res.ok) {
        consecutiveFailures++;
        reason = `HTTP ${res.status}`;
      } else {
        const body: unknown = await res.json();
        consecutiveFailures = 0;
        if (!Array.isArray(body)) {
          // Record the shape only (type and key names), never values.
          const shape = body && typeof body === "object" ? `object keys=${Object.keys(body).join(",")}` : typeof body;
          oddPayloads.push({ prefix, page, shape });
          return null;
        }
        return body.map(allowlist);
      }
    } catch (e) {
      if (e instanceof StopRun) throw e;
      consecutiveFailures++;
      reason = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : "error";
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      throw new StopRun(`${consecutiveFailures} consecutive failed requests: stopping as ruled in 0R.2`);
    }
    if (attempt < MAX_RETRIES) {
      const backoff = 4000 * 2 ** attempt;
      console.log(`  ${prefix} p${page}: ${reason}; retry ${attempt + 1}/${MAX_RETRIES} in ${backoff / 1000}s`);
      await sleep(backoff);
    } else {
      failures.push({ prefix, page, reason });
      console.log(`  ${prefix} p${page}: ${reason}; giving up on this page (recorded for retry)`);
    }
  }
  return undefined as never; // unreachable in practice; caller treats as failure
}

function pagePath(prefix: string, page: number) {
  return join(CACHE, prefix, `page-${String(page).padStart(4, "0")}.json`);
}

async function main() {
  const prefixes = onlyPrefix ? PREFIXES.filter((p) => p === onlyPrefix) : PREFIXES;
  if (!prefixes.length) throw new Error(`prefix must be one of ${PREFIXES.join(" ")}`);
  const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: run, error: runErr } = await db
    .from("ingest_runs")
    .insert({ script: "prs-fetch", notes: fromCache ? "from cache" : "fetching" })
    .select("id")
    .single();
  if (runErr) throw runErr;

  const counts: Record<string, { pages: number; records: number; cachedPages: number }> = {};
  let stopReason: string | undefined;
  try {
    for (const prefix of prefixes) {
      mkdirSync(join(CACHE, prefix), { recursive: true });
      const c = (counts[prefix] = { pages: 0, records: 0, cachedPages: 0 });
      for (let page = 1; page <= MAX_PAGES; page++) {
        const path = pagePath(prefix, page);
        let records: PrsRecord[] | null;
        if (existsSync(path)) {
          records = JSON.parse(readFileSync(path, "utf8"));
          c.cachedPages++;
        } else if (fromCache) {
          break;
        } else {
          const got = await fetchPage(prefix, page);
          if (got === undefined) continue; // failed page, recorded; move on
          records = got;
          if (records) writeFileSync(path, JSON.stringify(records, null, 1));
        }
        if (!records || records.length === 0) break;
        c.pages++;
        c.records += records.length;
        // Page sizes vary (9-12 seen), so a short page is not the end: only an empty or
        // non-list payload is.
      }
      console.log(`${prefix}: ${c.pages} pages, ${c.records} records (${c.cachedPages} pages from cache)`);
    }
  } catch (e) {
    stopReason = e instanceof Error ? e.message : String(e);
    console.error(`STOPPED: ${stopReason}`);
  }

  writeFileSync(join(CACHE, "failures.json"), JSON.stringify({ failures, oddPayloads }, null, 1));
  const total = Object.values(counts).reduce((s, c) => s + c.records, 0);
  const notes = JSON.stringify({ counts, requests, failures: failures.length, oddPayloads, stopReason });
  await db
    .from("ingest_runs")
    .update({ finished_at: new Date().toISOString(), rows_read: total, rows_written: 0, notes })
    .eq("id", run.id);
  console.log(`total records: ${total}; requests: ${requests}; failed pages: ${failures.length}`);
  if (oddPayloads.length) console.log(`non-list payloads: ${JSON.stringify(oddPayloads)}`);
  if (stopReason) process.exit(2);
}

// Exported helpers are reused by other scripts; only run when invoked directly.
if (process.argv[1]?.endsWith("prs-fetch.ts")) {
  main().catch((e) => {
    console.error("prs-fetch failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

export function readPrsCache(): { prefix: string; record: PrsRecord }[] {
  const out: { prefix: string; record: PrsRecord }[] = [];
  if (!existsSync(CACHE)) return out;
  for (const prefix of readdirSync(CACHE)) {
    const dir = join(CACHE, prefix);
    if (!PREFIXES.includes(prefix)) continue;
    for (const f of readdirSync(dir).sort()) {
      for (const record of JSON.parse(readFileSync(join(dir, f), "utf8")) as PrsRecord[]) {
        out.push({ prefix, record });
      }
    }
  }
  return out;
}
