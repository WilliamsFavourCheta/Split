import { createHash, verify } from "node:crypto";
import { getBase58Encoder } from "@solana/kit";
import { Connection, PublicKey } from "@solana/web3.js";
import { solanaCluster, solanaRpcUrl } from "../../../../lib/solana/client";
import { isSolanaAddress } from "../../../../lib/solana/launch-config";
import { solanaMetadataMessage, type SolanaTokenMetadataDraft } from "../../../../lib/solana/metadata-message";
import { getSolanaDeploymentConfig } from "../../../../lib/solana/raydium-accounts";
import { getRouterlessPlatformConfig, routerBackedSolanaMode } from "../../../../lib/solana/raydium-accounts";
import { verifySolanaLaunch } from "../../../../lib/solana/verify-launch";
import { createIndexerSupabaseClient } from "../../../../lib/supabase/server";

export const runtime = "nodejs";
const INITIALIZE_V2 = createHash("sha256").update("global:initialize_v2").digest().subarray(0, 8);
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const CONTENT_HASH = /^[a-f0-9]{64}\.json$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function httpsOrEmpty(value: unknown) {
  if (typeof value !== "string" || !value) return "";
  try { return new URL(value).protocol === "https:" ? value : ""; } catch { return ""; }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { mint?: unknown; launchSignatures?: unknown };
    if (typeof body.mint !== "string" || !isSolanaAddress(body.mint)
      || !Array.isArray(body.launchSignatures) || body.launchSignatures.length < 1
      || body.launchSignatures.length > 5 || !body.launchSignatures.every((value) => typeof value === "string" && SIGNATURE.test(value))) {
      return Response.json({ error: "Invalid finalized launch request." }, { status: 400 });
    }
    const deployment = routerBackedSolanaMode ? getSolanaDeploymentConfig() : getRouterlessPlatformConfig();
    if (!deployment) return Response.json({ error: "SPLIT Solana deployment is not configured." }, { status: 503 });
    const launch = await verifySolanaLaunch(body.mint);
    const connection = new Connection(solanaRpcUrl, { commitment: "finalized" });
    let finalized: { signature: string; slot: number; launchedAt: string } | null = null;
    for (const signature of body.launchSignatures as string[]) {
      const tx = await connection.getParsedTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
      if (!tx || tx.meta?.err || !tx.blockTime) continue;
      const initialize = tx.transaction.message.instructions.some((instruction) => {
        if (!("data" in instruction) || !instruction.programId.equals(deployment.raydium)) return false;
        const bytes = Buffer.from(getBase58Encoder().encode(instruction.data));
        return bytes.subarray(0, 8).equals(INITIALIZE_V2)
          && instruction.accounts.some((account) => account.toBase58() === launch.pool);
      });
      if (initialize) {
        finalized = { signature, slot: tx.slot, launchedAt: new Date(tx.blockTime * 1000).toISOString() };
        break;
      }
    }
    if (!finalized) return Response.json({ error: "No finalized Raydium InitializeV2 transaction matched this pool." }, { status: 409 });

    const client = createIndexerSupabaseClient();
    const storage = client.storage.from("solana-token-metadata");
    const pathPrefix = `${solanaCluster}/${launch.mint}/`;
    const base = storage.getPublicUrl(`${pathPrefix}placeholder.json`).data.publicUrl;
    const publicPrefix = base.slice(0, -"placeholder.json".length);
    if (!launch.metadataUri.startsWith(publicPrefix)) {
      return Response.json({ error: "On-chain metadata is not stored in SPLIT's verified metadata bucket." }, { status: 409 });
    }
    const filename = launch.metadataUri.slice(publicPrefix.length);
    if (!CONTENT_HASH.test(filename)) return Response.json({ error: "Invalid on-chain metadata path." }, { status: 409 });
    const { data: metadataFile, error: downloadError } = await storage.download(`${pathPrefix}${filename}`);
    if (downloadError || !metadataFile || metadataFile.size > 16_384) throw new Error("Published token metadata is unavailable.");
    const metadata = JSON.parse(await metadataFile.text()) as {
      name?: unknown; symbol?: unknown; description?: unknown; image?: unknown;
      external_url?: unknown; extensions?: { website?: unknown; twitter?: unknown };
      split_attestation?: { cluster?: unknown; mint?: unknown; creator?: unknown; expiresAt?: unknown;
        metadata?: SolanaTokenMetadataDraft; logoSha256?: unknown; signature?: unknown };
      split_policy?: { model?: unknown; project_treasury?: unknown; community?: unknown;
        shares_of_project_90_percent?: { creator?: unknown; liquidity?: unknown; projectTreasury?: unknown; community?: unknown } };
    };
    if (metadata.name !== launch.name || metadata.symbol !== launch.symbol) {
      return Response.json({ error: "On-chain and stored token metadata do not match." }, { status: 409 });
    }
    const description = typeof metadata.description === "string" ? metadata.description.slice(0, 360) : "";
    const logoUrl = httpsOrEmpty(metadata.image);
    if (logoUrl && !logoUrl.startsWith(publicPrefix)) {
      return Response.json({ error: "Token logo is outside the verified metadata bucket." }, { status: 409 });
    }
    const policy = metadata.split_policy;
    if (!routerBackedSolanaMode) {
      const attestation = metadata.split_attestation;
      if (!attestation || attestation.cluster !== solanaCluster || attestation.mint !== launch.mint
        || attestation.creator !== launch.creator || typeof attestation.expiresAt !== "number"
        || !Number.isSafeInteger(attestation.expiresAt) || !attestation.metadata
        || typeof attestation.logoSha256 !== "string" || typeof attestation.signature !== "string"
        || !/^[a-f0-9]{64}$|^none$/.test(attestation.logoSha256)
        || !/^[A-Za-z0-9+/]{86}==$|^[A-Za-z0-9+/]{87}=$/.test(attestation.signature))
        return Response.json({ error: "Creator policy attestation is missing." }, { status: 409 });
      const signedMetadata = attestation.metadata;
      const contentHash = createHash("sha256").update(JSON.stringify(signedMetadata)).update(attestation.logoSha256).digest("hex");
      const signedImage = attestation.logoSha256 === "none" ? ""
        : `${publicPrefix}${attestation.logoSha256}.`;
      if (`${contentHash}.json` !== filename || signedMetadata.name !== metadata.name
        || signedMetadata.symbol !== metadata.symbol || signedMetadata.description !== metadata.description
        || signedMetadata.website !== metadata.external_url
        || signedMetadata.website !== metadata.extensions?.website || signedMetadata.x !== metadata.extensions?.twitter
        || (signedImage ? typeof metadata.image !== "string" || !metadata.image.startsWith(signedImage) : metadata.image !== ""))
        return Response.json({ error: "Published metadata differs from its creator-signed content." }, { status: 409 });
      const signed = Buffer.from(attestation.signature, "base64");
      const key = Buffer.concat([ED25519_SPKI_PREFIX, new PublicKey(launch.creator).toBuffer()]);
      const message = solanaMetadataMessage({ cluster: solanaCluster, mint: launch.mint,
        creator: launch.creator, expiresAt: attestation.expiresAt, metadata: signedMetadata,
        logoSha256: attestation.logoSha256 });
      if (signed.length !== 64 || !verify(null, Buffer.from(message), { key, format: "der", type: "spki" }, signed))
        return Response.json({ error: "Creator policy signature could not be verified." }, { status: 409 });
      if (policy?.project_treasury !== signedMetadata.projectTreasuryAddress
        || policy?.community !== signedMetadata.communityAddress
        || JSON.stringify(policy?.shares_of_project_90_percent) !== JSON.stringify(signedMetadata.split))
        return Response.json({ error: "Published policy differs from its creator-signed content." }, { status: 409 });
    }
    if (!routerBackedSolanaMode && (policy?.model !== "operator_managed_v1"
      || typeof policy.project_treasury !== "string" || !isSolanaAddress(policy.project_treasury)
      || typeof policy.community !== "string" || !isSolanaAddress(policy.community)
      || !policy.shares_of_project_90_percent
      || Object.keys(policy.shares_of_project_90_percent).sort().join(",") !== "community,creator,liquidity,projectTreasury"
      || Object.values(policy.shares_of_project_90_percent).some((value) => !Number.isInteger(value) || Number(value) < 0 || Number(value) > 100)
      || Object.values(policy.shares_of_project_90_percent).reduce<number>((sum, value) => sum + Number(value), 0) !== 100)) {
      return Response.json({ error: "Signed offchain payout policy is missing or invalid." }, { status: 409 });
    }
    const shares = routerBackedSolanaMode && "shares" in launch ? launch.shares : policy!.shares_of_project_90_percent!;
    const treasury = routerBackedSolanaMode && "projectTreasury" in launch ? launch.projectTreasury : policy!.project_treasury as string;
    const community = routerBackedSolanaMode && "community" in launch ? launch.community : policy!.community as string;
    const row = {
      cluster: solanaCluster, mint_address: launch.mint, pool_address: launch.pool,
      creator_address: launch.creator, platform_config_address: launch.platformConfig,
      project_treasury_address: treasury, community_address: community,
      name: launch.name, symbol: launch.symbol, decimals: launch.decimals,
      description, logo_url: logoUrl || null,
      website_url: httpsOrEmpty(metadata.extensions?.website || metadata.external_url) || null,
      x_url: httpsOrEmpty(metadata.extensions?.twitter) || null,
      creator_bps: Number(shares.creator) * (routerBackedSolanaMode ? 1 : 100),
      liquidity_bps: Number(shares.liquidity) * (routerBackedSolanaMode ? 1 : 100),
      treasury_bps: Number(shares.projectTreasury) * (routerBackedSolanaMode ? 1 : 100),
      community_bps: Number(shares.community) * (routerBackedSolanaMode ? 1 : 100),
      fee_model: routerBackedSolanaMode ? "router" : "operator_managed",
      status: launch.status, launch_signature: finalized.signature, launch_slot: finalized.slot,
      launched_at: finalized.launchedAt, finalized: true,
    };
    const { error } = await client.from("solana_projects").upsert(row, { onConflict: "cluster,mint_address" });
    if (error) throw error;
    return Response.json({ saved: true, mint: launch.mint, tokenPath: `/solana/token/${launch.mint}` },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Finalized Solana launch confirmation failed", error);
    return Response.json({ error: "Could not verify and save the finalized launch." }, { status: 503 });
  }
}
