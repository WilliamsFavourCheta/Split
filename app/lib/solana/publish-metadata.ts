import { solanaMetadataMessage, type SolanaTokenMetadataDraft } from "./metadata-message";
import { solanaCluster } from "./client";

type SignMessage = (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;

export async function publishSolanaTokenMetadata(input: {
  mint: string;
  creator: string;
  draft: SolanaTokenMetadataDraft;
  logo: File | null;
  signMessage: SignMessage;
}) {
  const metadata: SolanaTokenMetadataDraft = {
    name: input.draft.name.trim(), symbol: input.draft.symbol.trim().toUpperCase(),
    description: input.draft.description.trim(), website: input.draft.website.trim(), x: input.draft.x.trim(),
    projectTreasuryAddress: input.draft.projectTreasuryAddress,
    communityAddress: input.draft.communityAddress,
    split: input.draft.split,
  };
  const logoBytes = input.logo ? new Uint8Array(await input.logo.arrayBuffer()) : null;
  const logoDigest = logoBytes ? new Uint8Array(await crypto.subtle.digest("SHA-256", logoBytes)) : null;
  const logoSha256 = logoDigest ? Array.from(logoDigest, (byte) => byte.toString(16).padStart(2, "0")).join("") : "none";
  const expiresAt = Date.now() + 5 * 60_000;
  const message = solanaMetadataMessage({ cluster: solanaCluster, mint: input.mint,
    creator: input.creator, expiresAt, metadata, logoSha256 });
  const signed = await input.signMessage({ message: new TextEncoder().encode(message) });
  const signature = btoa(String.fromCharCode(...signed.signature));
  const form = new FormData();
  form.set("mint", input.mint);
  form.set("creator", input.creator);
  form.set("expiresAt", String(expiresAt));
  form.set("signature", signature);
  for (const [key, value] of Object.entries(metadata)) form.set(key, typeof value === "string" ? value : JSON.stringify(value));
  if (input.logo) form.set("logo", input.logo, input.logo.name);
  const response = await fetch("/api/solana/metadata", { method: "POST", body: form });
  const result = await response.json() as { uri?: string; error?: string };
  if (!response.ok || !result.uri) throw new Error(result.error || "Token metadata could not be published.");
  return result.uri;
}
