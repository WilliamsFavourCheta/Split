import { address } from "@solana/kit";

export const SOLANA_TOKEN_SUPPLY = BigInt(1_000_000_000);
export const SPLIT_PROTOCOL_SHARE_BPS = 1_000;
export const SPLIT_PLATFORM_FEE_BPS = 100;

export type SolanaSplit = { creator: number; liquidity: number; projectTreasury: number; community: number };
export type SolanaLaunchDraft = {
  name: string;
  symbol: string;
  description: string;
  website: string;
  twitter: string;
  projectTreasuryAddress: string;
  communityAddress: string;
  graduationTargetSol: string;
  split: SolanaSplit;
};

export const DEFAULT_SOLANA_LAUNCH_DRAFT: SolanaLaunchDraft = {
  name: "", symbol: "", description: "", website: "", twitter: "",
  projectTreasuryAddress: "", communityAddress: "", graduationTargetSol: "24",
  split: { creator: 40, liquidity: 30, projectTreasury: 20, community: 10 },
};

export function isSolanaAddress(value: string) {
  try { address(value); return true; } catch { return false; }
}

export function validateSolanaLaunch(draft: SolanaLaunchDraft) {
  const errors: string[] = [];
  if (!draft.name.trim() || draft.name.trim().length > 32) errors.push("Token name must contain 1–32 characters.");
  if (!/^[A-Z0-9]{2,10}$/.test(draft.symbol.trim().toUpperCase())) errors.push("Symbol must contain 2–10 letters or numbers.");
  if (draft.description.length > 360) errors.push("Description must contain at most 360 characters.");
  for (const [label, value] of [["Website", draft.website], ["X", draft.twitter]] as const) {
    if (!value) continue;
    try { if (new URL(value).protocol !== "https:") throw new Error(); }
    catch { errors.push(`${label} must be an HTTPS URL.`); }
  }
  if (draft.twitter) {
    try { if (new URL(draft.twitter).hostname !== "x.com") errors.push("X must link to x.com."); }
    catch { /* The invalid URL was reported above. */ }
  }
  const target = Number(draft.graduationTargetSol);
  if (!Number.isFinite(target) || target < 24 || target > 10_000) errors.push("Graduation target must be between 24 and 10,000 SOL.");
  const shares = Object.values(draft.split);
  if (shares.some((value) => !Number.isInteger(value) || value < 0 || value > 100) || shares.reduce((sum, value) => sum + value, 0) !== 100) errors.push("The four destination shares must be whole percentages totaling 100%.");
  if (draft.split.projectTreasury > 0 && !isSolanaAddress(draft.projectTreasuryAddress)) errors.push("Enter the project treasury's Solana wallet address.");
  if (draft.split.community > 0 && !isSolanaAddress(draft.communityAddress)) errors.push("Enter the community's Solana wallet address.");
  return errors;
}

export function projectShareOfGrossFee(splitPercent: number) {
  return (10_000 - SPLIT_PROTOCOL_SHARE_BPS) * splitPercent / 100;
}
