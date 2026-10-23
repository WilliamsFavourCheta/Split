import { createHash, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { solanaCluster } from "../../../lib/solana/client";
import { isSolanaAddress } from "../../../lib/solana/launch-config";
import { solanaMetadataMessage, type SolanaTokenMetadataDraft } from "../../../lib/solana/metadata-message";
import { createIndexerSupabaseClient } from "../../../lib/supabase/server";

export const runtime = "nodejs";
const MAX_LOGO_BYTES = 512 * 1024;
const ALLOWED_LOGOS = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"]]);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function field(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function validHttps(value: string) {
  if (!value) return true;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function parseSplit(value: string) {
  try { return JSON.parse(value) as SolanaTokenMetadataDraft["split"]; }
  catch { return null; }
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 1024 * 1024) return Response.json({ error: "Metadata request is too large." }, { status: 413 });
  try {
    const form = await request.formData();
    const mint = field(form, "mint");
    const creator = field(form, "creator");
    const expiresAt = Number(field(form, "expiresAt"));
    const metadata: SolanaTokenMetadataDraft = {
      name: field(form, "name"), symbol: field(form, "symbol").toUpperCase(),
      description: field(form, "description"), website: field(form, "website"), x: field(form, "x"),
      projectTreasuryAddress: field(form, "projectTreasuryAddress"),
      communityAddress: field(form, "communityAddress"),
      split: parseSplit(field(form, "split")) as SolanaTokenMetadataDraft["split"],
    };
    if (!isSolanaAddress(mint) || !isSolanaAddress(creator)
      || metadata.name.length < 1 || metadata.name.length > 32
      || !/^[A-Z0-9]{2,10}$/.test(metadata.symbol)
      || metadata.description.length > 360 || !validHttps(metadata.website) || !validHttps(metadata.x)
      || (metadata.x && new URL(metadata.x).hostname !== "x.com")
      || !isSolanaAddress(metadata.projectTreasuryAddress) || !isSolanaAddress(metadata.communityAddress)
      || !metadata.split || typeof metadata.split !== "object" || Array.isArray(metadata.split)
      || Object.keys(metadata.split).sort().join(",") !== "community,creator,liquidity,projectTreasury"
      || Object.values(metadata.split).some((share) => !Number.isInteger(share) || (share as number) < 0 || (share as number) > 100)
      || Object.values(metadata.split).reduce<number>((sum, share) => sum + Number(share), 0) !== 100) {
      return Response.json({ error: "Invalid token metadata." }, { status: 400 });
    }
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 5 * 60_000) {
      return Response.json({ error: "Metadata signature has expired." }, { status: 400 });
    }
    const logo = form.get("logo");
    if (logo && !(logo instanceof File)) return Response.json({ error: "Invalid logo." }, { status: 400 });
    if (logo instanceof File && (logo.size > MAX_LOGO_BYTES || !ALLOWED_LOGOS.has(logo.type))) {
      return Response.json({ error: "Logo must be a PNG, JPEG, or WebP under 512 KB." }, { status: 400 });
    }
    const logoBytes = logo instanceof File ? Buffer.from(await logo.arrayBuffer()) : null;
    const logoSha256 = logoBytes ? createHash("sha256").update(logoBytes).digest("hex") : "none";
    const message = solanaMetadataMessage({ cluster: solanaCluster, mint, creator, expiresAt, metadata, logoSha256 });
    const signatureText = field(form, "signature");
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signatureText) && !/^[A-Za-z0-9+/]{87}=$/.test(signatureText)) {
      return Response.json({ error: "Invalid wallet signature." }, { status: 401 });
    }
    const signature = Buffer.from(signatureText, "base64");
    const key = Buffer.concat([ED25519_SPKI_PREFIX, new PublicKey(creator).toBuffer()]);
    if (signature.length !== 64 || !verify(null, Buffer.from(message), { key, format: "der", type: "spki" }, signature)) {
      return Response.json({ error: "Creator wallet signature did not match metadata." }, { status: 401 });
    }
    const contentHash = createHash("sha256").update(JSON.stringify(metadata)).update(logoSha256).digest("hex");
    const storage = createIndexerSupabaseClient().storage.from("solana-token-metadata");
    let image = "";
    if (logoBytes && logo instanceof File) {
      const logoPath = `${solanaCluster}/${mint}/${logoSha256}.${ALLOWED_LOGOS.get(logo.type)}`;
      const result = await storage.upload(logoPath, logoBytes, { contentType: logo.type, upsert: false, cacheControl: "31536000" });
      if (result.error && result.error.statusCode !== "409") throw result.error;
      image = storage.getPublicUrl(logoPath).data.publicUrl;
    }
    const json = JSON.stringify({ name: metadata.name, symbol: metadata.symbol,
      description: metadata.description, image, external_url: metadata.website,
      extensions: { website: metadata.website, twitter: metadata.x },
      split_attestation: { cluster: solanaCluster, mint, creator, expiresAt, metadata, logoSha256, signature: signatureText },
      split_policy: { model: "operator_managed_v1", project_treasury: metadata.projectTreasuryAddress,
        community: metadata.communityAddress, shares_of_project_90_percent: metadata.split } });
    const jsonPath = `${solanaCluster}/${mint}/${contentHash}.json`;
    const result = await storage.upload(jsonPath, Buffer.from(json),
      { contentType: "application/json", upsert: false, cacheControl: "31536000" });
    if (result.error && result.error.statusCode !== "409") throw result.error;
    return Response.json({ uri: storage.getPublicUrl(jsonPath).data.publicUrl },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Solana token metadata upload failed", error);
    return Response.json({ error: "Metadata storage is unavailable." }, { status: 503 });
  }
}
