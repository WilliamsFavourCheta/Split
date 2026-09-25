import "server-only";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const isSupabaseConfigured = Boolean(url && anonKey);

export function createServerSupabaseClient() {
  if (!url || !anonKey) throw new Error("Supabase server client is not configured.");
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Trusted indexers only. Never import this from a Client Component. */
export function createIndexerSupabaseClient() {
  if (!url || !serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for indexer writes.");
  return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
