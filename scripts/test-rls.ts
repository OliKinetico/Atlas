// RLS tests against the live project. Proves, for every table and the branch_overview view:
//   (a) anon reads nothing (and cannot write);
//   (b) a signed-in user who is NOT allowlisted reads nothing and cannot write;
//   (c) a signed-in allowlisted user can read and write.
// allowed_emails is service-role only, so all three roles must read nothing from it.
//
// Test users live on the reserved .invalid TLD (RFC 2606), so no real inbox exists. They are
// created with the service-role admin API and deleted at the end. The allowlisted test user
// is added to allowed_emails for the run and removed afterwards; both steps are logged in
// ingest_runs. Every test row is tagged RLS-TEST and deleted at the end.
//
// Usage: pnpm tsx scripts/test-rls.ts      (exit code 1 if any check fails)
// Logs table names and pass/fail only, never secrets.
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const URL = env("NEXT_PUBLIC_SUPABASE_URL");
const ANON = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(URL, env("SUPABASE_SERVICE_ROLE_KEY"), opts);

const ALLOWED_EMAIL = "rls-test-allowlisted@atlas-rls-test.invalid";
const OUTSIDER_EMAIL = "rls-test-not-allowlisted@atlas-rls-test.invalid";
const TAG = "RLS-TEST";
const CO = "RLSTEST1"; // not a valid CH number format, so it cannot collide with real data

type Row = Record<string, unknown>;
// FK order. `key` identifies the test row; `mutate` is a harmless update to attempt.
type Spec = { table: string; row: () => Row; key: Row; mutate: Row };
const ids: Record<string, string> = {};

const specs: Spec[] = [
  {
    table: "ingest_runs",
    row: () => ({ script: TAG, notes: TAG }),
    key: { script: TAG },
    mutate: { notes: `${TAG} changed` },
  },
  {
    table: "raw_source_rows",
    row: () => ({ source: "prs", source_record_id: TAG, payload: { test: true } }),
    key: { source_record_id: TAG },
    mutate: { payload: { test: "changed" } },
  },
  {
    table: "known_groups",
    row: () => ({ group_name: TAG, company_number: CO, confirmed_by_oli_at: new Date().toISOString() }),
    key: { group_name: TAG },
    mutate: { group_name: TAG }, // update to same value: affected-row count is what matters
  },
  {
    table: "franchise_brands",
    row: () => ({ brand_name: TAG, confirmed_by_oli_at: new Date().toISOString() }),
    key: { brand_name: TAG },
    mutate: { franchisor: `${TAG} changed` },
  },
  {
    table: "branches",
    row: () => ({ trading_name: TAG, trading_name_norm: "rls test", source_type: "branch", notes: TAG }),
    key: { trading_name: TAG },
    mutate: { notes: `${TAG} changed` },
  },
  {
    table: "companies",
    row: () => ({ company_number: CO, name: TAG }),
    key: { company_number: CO },
    mutate: { status: `${TAG} changed` },
  },
  {
    table: "officers",
    row: () => ({ company_number: CO, name: TAG, role: "director" }),
    key: { company_number: CO },
    mutate: { role: `${TAG} changed` },
  },
  {
    table: "pscs",
    row: () => ({ company_number: CO, name: TAG, kind: "individual" }),
    key: { company_number: CO },
    mutate: { name: `${TAG} changed` },
  },
  {
    table: "psc_chains",
    row: () => ({ company_number: CO, chain: [], depth: 0 }),
    key: { company_number: CO },
    mutate: { depth: 1 },
  },
  {
    table: "branch_company_links",
    row: () => ({ branch_id: ids.branches, company_number: CO, tier: "exact", evidence: { test: TAG } }),
    key: { company_number: CO },
    mutate: { evidence: { test: `${TAG} changed` } },
  },
  {
    table: "match_proposals",
    row: () => ({ kind: "branch_company", subject_id: TAG, candidate: { test: true }, evidence: { test: true } }),
    key: { subject_id: TAG },
    mutate: { reviewed_by: `${TAG} changed` },
  },
];

type Result = { table: string; check: string; pass: boolean; detail?: string };
const results: Result[] = [];
function record(table: string, check: string, pass: boolean, detail?: string) {
  results.push({ table, check, pass, detail });
}

function applyKey<T extends { eq: (c: string, v: unknown) => T }>(q: T, key: Row): T {
  for (const [c, v] of Object.entries(key)) q = q.eq(c, v);
  return q;
}

async function readCount(db: SupabaseClient, table: string, key?: Row) {
  let q = db.from(table).select("*");
  if (key) q = applyKey(q, key);
  const { data, error } = await q;
  return { n: data?.length ?? 0, error };
}

async function serviceRowSnapshot(table: string, key: Row) {
  const { data, error } = await applyKey(admin.from(table).select("*"), key);
  if (error) throw new Error(`service read ${table}: ${error.message}`);
  return JSON.stringify(data);
}

async function logRun(notes: string) {
  const { error } = await admin
    .from("ingest_runs")
    .insert({ script: "test-rls", finished_at: new Date().toISOString(), notes });
  if (error) throw new Error(`ingest_runs log: ${error.message}`);
}

async function deleteTestUsers() {
  // Paginate through users to find leftovers from an earlier run.
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    for (const u of data.users) {
      if (u.email === ALLOWED_EMAIL || u.email === OUTSIDER_EMAIL) {
        const { error: delErr } = await admin.auth.admin.deleteUser(u.id);
        if (delErr) throw new Error(`deleteUser: ${delErr.message}`);
      }
    }
    if (data.users.length < 200) break;
  }
}

async function cleanupRows() {
  // Reverse FK order; service role so cleanup works even if a check failed midway.
  for (const s of [...specs].reverse()) {
    const { error } = await applyKey(admin.from(s.table).delete(), s.key);
    if (error) console.error(`cleanup ${s.table}: ${error.message}`);
  }
}

async function signIn(email: string, password: string) {
  const db = createClient(URL, ANON, opts);
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn: ${error.message}`);
  return db;
}

async function main() {
  await deleteTestUsers();
  await cleanupRows();

  const password = randomBytes(24).toString("base64url");
  for (const email of [ALLOWED_EMAIL, OUTSIDER_EMAIL]) {
    const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`createUser: ${error.message}`);
  }

  const { error: addErr } = await admin.from("allowed_emails").insert({ email: ALLOWED_EMAIL });
  if (addErr) throw new Error(`allowed_emails add: ${addErr.message}`);
  await logRun("test-rls: added 1 test address (atlas-rls-test.invalid) to allowed_emails");

  try {
    const anon = createClient(URL, ANON, opts);
    const outsider = await signIn(OUTSIDER_EMAIL, password);
    const allowed = await signIn(ALLOWED_EMAIL, password);

    // (c) allowlisted user writes then reads back every table.
    for (const s of specs) {
      const { data, error } = await allowed.from(s.table).insert(s.row()).select();
      const ok = !error && data?.length === 1;
      if (ok && s.table === "branches") ids.branches = (data[0] as Row).id as string;
      record(s.table, "(c) allowlisted insert", ok, error?.message);
      const r = await readCount(allowed, s.table, s.key);
      record(s.table, "(c) allowlisted read", !r.error && r.n === 1, r.error?.message ?? `rows=${r.n}`);
      const { data: up, error: upErr } = await applyKey(allowed.from(s.table).update(s.mutate), s.key).select();
      record(s.table, "(c) allowlisted update", !upErr && up?.length === 1, upErr?.message ?? `rows=${up?.length}`);
    }
    {
      const r = await readCount(allowed, "branch_overview", { trading_name: TAG });
      record("branch_overview", "(c) allowlisted read", !r.error && r.n === 1, r.error?.message ?? `rows=${r.n}`);
    }

    // (a) anon and (b) outsider: test rows now exist, so "reads nothing" is meaningful.
    for (const [label, db] of [["(a) anon", anon], ["(b) not-allowlisted", outsider]] as const) {
      for (const s of specs) {
        const before = await serviceRowSnapshot(s.table, s.key);

        const r = await readCount(db, s.table);
        record(s.table, `${label} reads nothing`, r.n === 0, r.error ? `denied: ${r.error.message}` : `rows=${r.n}`);

        const ins = await db.from(s.table).insert(s.row()).select();
        record(s.table, `${label} insert blocked`, ins.error?.code === "42501", ins.error ? `${ins.error.code}` : "insert succeeded");

        const up = await applyKey(db.from(s.table).update(s.mutate), s.key).select();
        const del = await applyKey(db.from(s.table).delete(), s.key).select();
        const after = await serviceRowSnapshot(s.table, s.key);
        const unchanged = before === after && (up.data?.length ?? 0) === 0 && (del.data?.length ?? 0) === 0;
        record(s.table, `${label} update/delete blocked`, unchanged, unchanged ? "row unchanged" : "row changed");
      }
      const v = await readCount(db, "branch_overview");
      record("branch_overview", `${label} reads nothing`, v.n === 0, v.error ? `denied: ${v.error.message}` : `rows=${v.n}`);
    }

    // allowed_emails: service role only; nobody signed in may read or write it.
    for (const [label, db] of [["(a) anon", anon], ["(b) not-allowlisted", outsider], ["(c) allowlisted", allowed]] as const) {
      const r = await readCount(db, "allowed_emails");
      record("allowed_emails", `${label} reads nothing`, r.n === 0, r.error ? "denied" : `rows=${r.n}`);
      const ins = await db.from("allowed_emails").insert({ email: `x-${randomBytes(4).toString("hex")}@atlas-rls-test.invalid` });
      record("allowed_emails", `${label} insert blocked`, ins.error?.code === "42501", ins.error ? `${ins.error.code}` : "insert succeeded");
    }

    // (c) allowlisted user can delete (reverse FK order) — the final write check.
    for (const s of [...specs].reverse()) {
      const { data, error } = await applyKey(allowed.from(s.table).delete(), s.key).select();
      record(s.table, "(c) allowlisted delete", !error && data?.length === 1, error?.message ?? `rows=${data?.length}`);
    }
  } finally {
    await cleanupRows();
    const { error: rmErr } = await admin.from("allowed_emails").delete().eq("email", ALLOWED_EMAIL);
    if (rmErr) console.error(`allowed_emails remove: ${rmErr.message}`);
    await admin.from("allowed_emails").delete().like("email", "%@atlas-rls-test.invalid");
    await logRun("test-rls: removed test address (atlas-rls-test.invalid) from allowed_emails");
    await deleteTestUsers();
  }

  const tables = [...new Set(results.map((r) => r.table))];
  let failed = 0;
  for (const t of tables) {
    const rows = results.filter((r) => r.table === t);
    const bad = rows.filter((r) => !r.pass);
    failed += bad.length;
    console.log(`${bad.length ? "FAIL" : "PASS"}  ${t}  (${rows.length - bad.length}/${rows.length})`);
    for (const b of bad) console.log(`        ${b.check}: ${b.detail ?? ""}`);
  }
  console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${results.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error("test-rls failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
