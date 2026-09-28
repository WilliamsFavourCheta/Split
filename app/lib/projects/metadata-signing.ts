export function projectMetadataMessage(token: string, imageDigest: string, fieldsDigest: string, expiresAt: number, nonce: number) {
  return `SPLIT project metadata\nChain: 4663\nToken: ${token.toLowerCase()}\nImage SHA-256: ${imageDigest.toLowerCase()}\nFields SHA-256: ${fieldsDigest.toLowerCase()}\nExpires: ${expiresAt}\nNonce: ${nonce}`;
}

export function validMetadataExpiry(expiresAt: number, now: number) {
  return Number.isSafeInteger(expiresAt) && expiresAt > now && expiresAt <= now + 5 * 60_000;
}

export function canonicalProjectLogoPath(token: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("Invalid token address for logo path.");
  return `4663/${token.toLowerCase()}/logo`;
}

export function versionedProjectLogoUrl(publicUrl: string, imageDigest: string) {
  const url = new URL(publicUrl);
  url.searchParams.set("v", imageDigest.slice(2));
  return url.toString();
}

export function projectMetadataFields(fields: { description: string; website: string; twitter: string; telegram: string; discord: string }) {
  return JSON.stringify({
    description: fields.description,
    website: fields.website,
    twitter: fields.twitter,
    telegram: fields.telegram,
    discord: fields.discord,
  });
}
