import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const envText = await readFile(new URL("../.env", import.meta.url), "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).flatMap((line) => {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  return match ? [[match[1], match[2].trim().replace(/^(['"])(.*)\1$/, "$2")]] : [];
}));
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  console.log("Supabase public read model: not configured locally");
  process.exitCode = 2;
} else {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket },
  });
  const checks = [
    ["canonical projects", () => client.from("projects").select("id", { count: "exact", head: true }).eq("chain_id", 4663).eq("canonical", true)],
    ["exact price view", () => client.from("project_price_events_exact").select("id", { count: "exact", head: true })],
    ["project metadata", () => client.from("project_metadata").select("id", { count: "exact", head: true })],
    ["public asset bucket", () => client.storage.from("project-assets").list("", { limit: 1 })],
  ];
  for (const [label, check] of checks) {
    try {
      const result = await check();
      console.log(`${label}: ${result.error ? `unavailable (${result.error.status ?? result.error.code ?? "API error"})` : "reachable"}${!result.error && typeof result.count === "number" ? `, count ${result.count}` : ""}`);
      if (result.error) process.exitCode = 1;
    } catch {
      console.log(`${label}: network request failed`);
      process.exitCode = 1;
    }
  }
  const { data: projects, error: projectError } = await client.from("projects")
    .select("token_address,pool_id,launch_tx_hash")
    .eq("chain_id", 4663).eq("canonical", true).limit(100);
  if (!projectError && projects) {
    const seedAddresses = new Set(["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"]);
    console.log(`known development seed addresses present: ${projects.filter((row) => seedAddresses.has(row.token_address)).length}`);
    console.log(`canonical rows with pool and launch transaction: ${projects.filter((row) => /^0x[0-9a-f]{64}$/.test(row.pool_id ?? "") && /^0x[0-9a-f]{64}$/.test(row.launch_tx_hash ?? "")).length}`);
  }
}
