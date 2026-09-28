import { createHash } from "node:crypto";
import { isAddress, isHex, verifyMessage, zeroHash } from "viem";
import { getSplitFactoryAddress } from "../../../contracts/addresses";
import { splitFactoryAbi } from "../../../contracts/abis";
import { indexerClient } from "../../../lib/indexer/evm-source";
import { projectMetadataFields, projectMetadataMessage } from "../../../lib/projects/metadata-signing";
import { matchesImageHeader, MAX_IMAGE_BYTES, mimeExtensions } from "../../../lib/projects/image-validation";
import { createIndexerSupabaseClient } from "../../../lib/supabase/server";

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
    const file = form.get("image");
    const description = form.get("description");
    if (typeof token !== "string" || !isAddress(token) || typeof signature !== "string" || !isHex(signature) || !/^0x[0-9a-fA-F]{130}$/.test(signature)
      || !Number.isSafeInteger(expiry) || expiry < Date.now() || expiry > Date.now() + 5 * 60_000
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
      message: projectMetadataMessage(token, digest, fieldsDigest, expiry),
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

    let logoUrl: string | null = null;
    if (bytes && file instanceof File) {
      const path = `4663/${token.toLowerCase()}/logo-${digest.slice(2)}.${mimeExtensions[file.type]}`;
      const { error: uploadError } = await client.storage.from("project-assets").upload(path, bytes, { contentType: file.type, upsert: false });
      if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) throw uploadError;
      logoUrl = client.storage.from("project-assets").getPublicUrl(path).data.publicUrl;
    }
    const { data: existingMetadata, error: existingError } = await client.from("project_metadata").select("logo_url").eq("project_id", project.id).maybeSingle();
    if (existingError) throw existingError;
    const { error: metadataError } = await client.from("project_metadata").upsert({
      project_id: project.id,
      logo_url: logoUrl ?? existingMetadata?.logo_url ?? null,
      description: description.trim() || null,
      website_url: website,
      x_url: x,
      telegram_url: telegram,
      discord_url: discord,
      updated_by_wallet: project.creator_address,
      updated_at: new Date().toISOString(),
    }, { onConflict: "project_id" });
    if (metadataError) throw metadataError;
    return Response.json({ logoUrl: logoUrl ?? existingMetadata?.logo_url ?? null, saved: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Metadata could not be saved.";
    if (/Invalid URL|Profile links|link is too long/.test(message)) return Response.json({ error: message }, { status: 400 });
    return Response.json({ error: "Metadata could not be saved. Keep your draft and retry after indexing is available." }, { status: 503 });
  }
}
