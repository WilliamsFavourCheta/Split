export function projectMetadataMessage(token: string, imageDigest: string, fieldsDigest: string, expiresAt: number) {
  return `SPLIT project metadata\nChain: 4663\nToken: ${token.toLowerCase()}\nImage SHA-256: ${imageDigest.toLowerCase()}\nFields SHA-256: ${fieldsDigest.toLowerCase()}\nExpires: ${expiresAt}`;
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
