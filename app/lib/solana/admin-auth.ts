import "server-only";
import { randomBytes, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { createIndexerSupabaseClient } from "../supabase/server";
import { solanaCluster } from "./client";
import { getRouterlessPlatformConfig } from "./raydium-accounts";

export type AdminPurpose = "claim" | "receipt" | "payout";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function adminMessage(purpose: AdminPurpose, mint: string, nonce: string) {
  return ["SPLIT_ADMIN_V1", solanaCluster, purpose, mint, nonce].join("\n");
}

export async function createAdminChallenge(purpose: AdminPurpose, mint: string) {
  const config = getRouterlessPlatformConfig();
  if (!config) throw new Error("SPLIT fee wallet is not configured.");
  new PublicKey(mint);
  const nonce = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
  const { error } = await createIndexerSupabaseClient().from("solana_admin_challenges")
    .insert({ nonce, cluster: solanaCluster, purpose, mint_address: mint, expires_at: expiresAt });
  if (error) throw error;
  return { nonce, message: adminMessage(purpose, mint, nonce), expiresAt, wallet: config.feeWallet.toBase58() };
}

export async function requireAdminSignature(input: { purpose: AdminPurpose; mint: string; nonce: string; signature: string; wallet: string }) {
  const config = getRouterlessPlatformConfig();
  if (!config || input.wallet !== config.feeWallet.toBase58() || !/^[a-f0-9]{64}$/.test(input.nonce)
    || (!/^[A-Za-z0-9+/]{86}==$/.test(input.signature) && !/^[A-Za-z0-9+/]{87}=$/.test(input.signature)))
    throw new Error("Unauthorized administrator.");
  const signature = Buffer.from(input.signature, "base64");
  const key = Buffer.concat([ED25519_SPKI_PREFIX, config.feeWallet.toBuffer()]);
  if (signature.length !== 64 || !verify(null, Buffer.from(adminMessage(input.purpose, input.mint, input.nonce)),
    { key, format: "der", type: "spki" }, signature)) throw new Error("Administrator wallet signature is invalid.");
  const { data, error } = await createIndexerSupabaseClient().rpc("consume_solana_admin_challenge",
    { p_nonce: input.nonce, p_cluster: solanaCluster, p_purpose: input.purpose, p_mint: input.mint });
  if (error || data !== true) throw new Error("Administrator challenge expired or was already used.");
  return config;
}
