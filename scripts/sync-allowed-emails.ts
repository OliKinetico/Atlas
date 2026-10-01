// Mirrors ALLOWED_EMAILS into public.allowed_emails so RLS can enforce the allowlist.
// Usage: pnpm tsx scripts/sync-allowed-emails.ts
// Logs counts only, never the addresses.
import { createClient } from "@supabase/supabase-js";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function main() {
  const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const wanted = [
    ...new Set(
      env("ALLOWED_EMAILS")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];

  const { data: run, error: runErr } = await db
    .from("ingest_runs")
    .insert({ script: "sync-allowed-emails", rows_read: wanted.length })
    .select("id")
    .single();
  if (runErr) throw runErr;

  const { data: current, error: readErr } = await db.from("allowed_emails").select("email");
  if (readErr) throw readErr;
  const have = new Set((current ?? []).map((r) => r.email as string));
  const toAdd = wanted.filter((e) => !have.has(e));
  const toRemove = [...have].filter((e) => !wanted.includes(e));

  if (toAdd.length) {
    const { error } = await db.from("allowed_emails").insert(toAdd.map((email) => ({ email })));
    if (error) throw error;
  }
  if (toRemove.length) {
    const { error } = await db.from("allowed_emails").delete().in("email", toRemove);
    if (error) throw error;
  }

  const notes = `allowlist: ${wanted.length} configured, ${toAdd.length} added, ${toRemove.length} removed`;
  await db
    .from("ingest_runs")
    .update({ finished_at: new Date().toISOString(), rows_written: toAdd.length + toRemove.length, notes })
    .eq("id", run.id);
  console.log(notes);
}

main().catch((e) => {
  console.error("sync-allowed-emails failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
