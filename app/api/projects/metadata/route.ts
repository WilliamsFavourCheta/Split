import { createHash } from "node:crypto";
import { isAddress, isHex, verifyMessage, zeroHash } from "viem";
import { getSplitFactoryAddress } from "../../../contracts/addresses";
import { splitFactoryAbi } from "../../../contracts/abis";
import { indexerClient } from "../../../lib/indexer/evm-source";
import { canonicalProjectLogoPath, projectMetadataFields, projectMetadataMessage, validMetadataExpiry, versionedProjectLogoUrl } from "../../../lib/projects/metadata-signing";
import { matchesImageHeader, MAX_IMAGE_BYTES, mimeExtensions } from "../../../lib/projects/image-validation";
import { createIndexerSupabaseClient } from "../../../lib/supabase/server";

export const maxDuration = 30;

export async function GET(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get("token");
    if (!token || !isAddress(token)) return Response.json({ error: "Invalid token address." }, { status: 400 });
    const client = createIndexerSupabaseClient();
    const { data: project, error: projectError } = await client.from("projects")
      .select("id").eq("chain_id", 4663).eq("token_address", token.toLowerCase()).eq("canonical", true).maybeSingle();
    if (projectError) throw projectError;
    if (!project) return Response.json({ error: "This launch is not canonically indexed yet." }, { status: 409 });
    const { data: state, error: stateError } = await client.from("project_metadata_update_state")
      .select("nonce,next_allowed_at,claim_expires_at").eq("project_id", project.id).maybeSingle();
    if (stateError) throw stateError;
    const retryAt = Math.max(
      state ? Date.parse(state.next_allowed_at) : 0,
      state?.claim_expires_at ? Date.parse(state.claim_expires_at) : 0,
    );
    return Response.json({ nonce: state?.nonce ?? 0, retryAfter: Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) },
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Metadata update state is unavailable." }, { status: 503 });
  }
}

function safeUrl(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (value.length > 400) throw new Error("A profile link is too long.");
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Profile links must use HTTPS.");
  return url.toString();
}

export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 700_000) return Response.json({ error: "Upload is too large." }, { status: 413 });
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "Upload body is missing." }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > 700_000) {
        await reader.cancel();
        return Response.json({ error: "Upload is too large." }, { status: 413 });
      }
      chunks.push(value);
    }
    const uploadBody = new Uint8Array(totalBytes);
    let cursor = 0;
    for (const chunk of chunks) { uploadBody.set(chunk, cursor); cursor += chunk.length; }
    const form = await new Request(request.url, { method: "POST", headers: { "content-type": request.headers.get("content-type") ?? "" }, body: uploadBody }).formData();
    const token = form.get("token");
    const signature = form.get("signature");
    const expiry = Number(form.get("expiresAt"));
    const nonceValue = form.get("nonce");
    const nonce = Number(nonceValue);
    const file = form.get("image");
    const description = form.get("description");
    if (typeof token !== "string" || !isAddress(token) || typeof signature !== "string" || !isHex(signature) || !/^0x[0-9a-fA-F]{130}$/.test(signature)
      || !validMetadataExpiry(expiry, Date.now())
      || typeof nonceValue !== "string" || !/^\d+$/.test(nonceValue) || !Number.isSafeInteger(nonce) || nonce < 0
      || (file !== null && (!(file instanceof File) || file.size < 12 || file.size > MAX_IMAGE_BYTES || !mimeExtensions[file.type]))
      || typeof description !== "string" || description.length > 360) {
      return Response.json({ error: "Invalid or expired metadata request." }, { status: 400 });
    }
    const bytes = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : null;
    if (bytes && file instanceof File && !matchesImageHeader(bytes, file.type)) return Response.json({ error: "The image file does not match its type." }, { status: 400 });
    const digest = bytes ? `0x${createHash("sha256").update(bytes).digest("hex")}` : zeroHash;
    const website = safeUrl(form.get("website"));
    const x = safeUrl(form.get("twitter"));
    const telegram = safeUrl(form.get("telegram"));
    const discord = safeUrl(form.get("discord"));
    const fieldsDigest = `0x${createHash("sha256").update(projectMetadataFields({
      description,
      website: String(form.get("website") ?? ""),
      twitter: String(form.get("twitter") ?? ""),
      telegram: String(form.get("telegram") ?? ""),
      discord: String(form.get("discord") ?? ""),
    })).digest("hex")}`;

    const client = createIndexerSupabaseClient();
    const { data: project, error: lookupError } = await client.from("projects")
      .select("id,creator_address,pool_id,canonical")
      .eq("chain_id", 4663).eq("token_address", token.toLowerCase()).eq("canonical", true).maybeSingle();
    if (lookupError) throw lookupError;
    if (!project?.pool_id || !/^0x[0-9a-f]{64}$/.test(project.pool_id)) {
      return Response.json({ error: "This launch is not canonically indexed yet." }, { status: 409 });
    }
    const authenticated = await verifyMessage({
      address: project.creator_address as `0x${string}`,
      message: projectMetadataMessage(token, digest, fieldsDigest, expiry, nonce),
      signature: signature as `0x${string}`,
    });
    if (!authenticated) return Response.json({ error: "Creator signature is invalid." }, { status: 403 });

    const factory = getSplitFactoryAddress(4663);
    if (!factory) return Response.json({ error: "Verified SPLIT factory is not configured." }, { status: 503 });
    const poolId = await indexerClient.readContract({ address: factory, abi: splitFactoryAbi, functionName: "poolForToken", args: [token as `0x${string}`] });
    if (poolId === zeroHash || poolId.toLowerCase() !== project.pool_id) {
      return Response.json({ error: "Indexed and onchain official pools disagree." }, { status: 409 });
    }
    const registeredToken = await indexerClient.readContract({ address: factory, abi: splitFactoryAbi, functionName: "tokenForPool", args: [poolId] });
    if (registeredToken.toLowerCase() !== token.toLowerCase()) {
      return Response.json({ error: "The token is not registered to this official pool." }, { status: 409 });
    }

    const { data: claimedNonce, error: claimError } = await client.rpc("claim_project_metadata_update", {
      p_project_id: project.id, p_expected_nonce: nonce,
    });
    if (claimError) throw claimError;
    if (claimedNonce !== nonce + 1) {
      return Response.json({ error: "This metadata signature is stale or updates are temporarily limited. Refresh and retry shortly." }, { status: 409 });
    }

    let logoUrl: string | null = null;
    if (bytes && file instanceof File) {
      const path = canonicalProjectLogoPath(token);
      const storage = client.storage.from("project-assets");
      const { error: uploadError } = await storage.upload(path, bytes, { contentType: file.type, cacheControl: "60", upsert: true });
      if (uploadError) throw uploadError;
      logoUrl = versionedProjectLogoUrl(storage.getPublicUrl(path).data.publicUrl, digest);
    }
    const { data: completed, error: metadataError } = await client.rpc("complete_project_metadata_update", {
      p_project_id: project.id,
      p_claim_nonce: claimedNonce,
      p_logo_url: logoUrl,
      p_description: description.trim() || null,
      p_website_url: website,
      p_x_url: x,
      p_telegram_url: telegram,
      p_discord_url: discord,
      p_updated_by_wallet: project.creator_address,
    });
    if (metadataError) throw metadataError;
    if (!completed) return Response.json({ error: "This metadata update expired. Refresh and retry." }, { status: 409 });
    const { data: savedMetadata, error: savedError } = await client.from("project_metadata")
      .select("logo_url").eq("project_id", project.id).single();
    if (savedError) throw savedError;
    return Response.json({ logoUrl: savedMetadata.logo_url, saved: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Metadata could not be saved.";
    if (/Invalid URL|Profile links|link is too long/.test(message)) return Response.json({ error: message }, { status: 400 });
    return Response.json({ error: "Metadata could not be saved. Keep your draft and retry after indexing is available." }, { status: 503 });
  }
}
