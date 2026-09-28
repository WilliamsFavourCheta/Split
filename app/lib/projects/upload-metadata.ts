import type { WalletClient } from "viem";
import { projectMetadataFields, projectMetadataMessage } from "./metadata-signing";

type DraftMetadata = {
  logoDataUrl: string;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  discord: string;
};

export async function uploadConfirmedProjectMetadata(input: {
  token: `0x${string}`;
  account: `0x${string}`;
  walletClient: WalletClient;
  draft: DraftMetadata;
}) {
  const blob = input.draft.logoDataUrl ? await (await fetch(input.draft.logoDataUrl)).blob() : null;
  if (blob && (blob.size > 512 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(blob.type))) {
    throw new Error("The saved logo is invalid. Choose it again in the Token step.");
  }
  const digestBytes = blob ? new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())) : null;
  const digest = digestBytes ? `0x${Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` : `0x${"0".repeat(64)}`;
  const fieldsBytes = new TextEncoder().encode(projectMetadataFields(input.draft));
  const fieldsHash = new Uint8Array(await crypto.subtle.digest("SHA-256", fieldsBytes));
  const fieldsDigest = `0x${Array.from(fieldsHash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const expiresAt = Date.now() + 5 * 60_000;
  const signature = await input.walletClient.signMessage({ account: input.account, message: projectMetadataMessage(input.token, digest, fieldsDigest, expiresAt) });
  const form = new FormData();
  form.set("token", input.token);
  form.set("expiresAt", String(expiresAt));
  form.set("signature", signature);
  if (blob) form.set("image", blob, "token-logo.webp");
  for (const key of ["description", "website", "twitter", "telegram", "discord"] as const) form.set(key, input.draft[key]);
  const response = await fetch("/api/projects/metadata", { method: "POST", body: form });
  const result = await response.json() as { logoUrl?: string | null; saved?: boolean; error?: string };
  if (!response.ok || !result.saved) throw new Error(result.error || "The project metadata could not be saved.");
  return result.logoUrl ?? null;
}
