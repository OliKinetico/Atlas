// Shared helpers for Phase 4 scripts: service-role client, paged reads, snapshots, ingest_runs.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function serviceClient(): SupabaseClient {
  return createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** JSON with sorted object keys, so jsonb round-trips compare equal. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export async function readAll<T>(db: SupabaseClient, table: string, cols: string, orderBy: string, filters: [string, string][] = []): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(cols).order(orderBy).range(from, from + 999);
    for (const [c, v] of filters) q = q.eq(c, v);
    const { data, error } = await q;
    if (error) throw new Error(`read ${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export type Snap = { snapshot_table: string; restore_command: string; undo_command: string };

/**
 * Snapshot a table through public.snapshot_table(). The restore command upserts the snapshot
 * back by primary key and never deletes; the undo command removes rows added after it.
 */
export async function snapshot(db: SupabaseClient, table: string, keyCols: string[]): Promise<Snap> {
  const { data, error } = await db.rpc("snapshot_table", { tbl: table });
  if (error) throw new Error(`snapshot ${table}: ${error.message}`);
  const s = (data as { snapshot_table: string; restore_command: string }[])[0];
  const match = keyCols.map((c) => `s.${c} = t.${c}`).join(" and ");
  const manual = ["companies", "officers", "pscs", "branches"].includes(table) ? " and t.manually_edited = false" : "";
  return { ...s, undo_command: `delete from public.${table} t where not exists (select 1 from public.${s.snapshot_table} s where ${match})${manual};` };
}

export async function startRun(db: SupabaseClient, script: string, rowsRead: number): Promise<string> {
  const { data, error } = await db.from("ingest_runs").insert({ script, rows_read: rowsRead }).select("id").single();
  if (error) throw new Error(`ingest_runs: ${error.message}`);
  return data.id as string;
}

export async function finishRun(db: SupabaseClient, id: string, rowsWritten: number, snaps: Snap[], notes: unknown) {
  const { error } = await db
    .from("ingest_runs")
    .update({
      finished_at: new Date().toISOString(),
      rows_written: rowsWritten,
      snapshot_table: snaps.map((s) => s.snapshot_table).join(", ") || null,
      restore_command: snaps.length
        ? ["-- restore (upsert snapshot back by primary key):", ...snaps.map((s) => s.restore_command), "-- undo rows added after the snapshot:", ...snaps.map((s) => s.undo_command)].join("\n")
        : null,
      notes: JSON.stringify(notes),
    })
    .eq("id", id);
  if (error) throw new Error(`ingest_runs update: ${error.message}`);
}
