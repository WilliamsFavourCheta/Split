export type LaunchDraft = {
  resumeStep: "details" | "market" | "split" | "review";
  name: string;
  symbol: string;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  discord: string;
  logoName: string;
  logoDataUrl: string;
  pendingLaunchTx: string;
  supply: string;
  initialLiquidity: string;
  initialLiquidityExplicit: boolean;
  tokenSeedAmount: string;
  feeRate: string;
  quoteAsset: string;
  projectTreasuryAddress: string;
  communityAddress: string;
  allocations: { creator: number; liquidity: number; projectTreasury: number; community: number };
};

export const DEFAULT_DRAFT: LaunchDraft = {
  resumeStep: "details",
  name: "", symbol: "", description: "", website: "", twitter: "", telegram: "", discord: "",
  logoName: "", logoDataUrl: "", pendingLaunchTx: "", supply: "1000000000", initialLiquidity: "", initialLiquidityExplicit: false, tokenSeedAmount: "1000000",
  feeRate: "1", quoteAsset: "ETH", projectTreasuryAddress: "", communityAddress: "",
  allocations: { creator: 40, liquidity: 30, projectTreasury: 20, community: 10 },
};

export function restoreLaunchDraft(serialized: string): LaunchDraft {
  let parsed: Partial<LaunchDraft> & { allocations?: Partial<LaunchDraft["allocations"]> & { treasury?: number } };
  try { parsed = JSON.parse(serialized); } catch { return DEFAULT_DRAFT; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_DRAFT;
  const stringValue = <K extends keyof LaunchDraft>(key: K) =>
    typeof parsed[key] === "string" ? parsed[key] as string : DEFAULT_DRAFT[key] as string;
  const percent = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 ? value : fallback;
  const logoDataUrl = typeof parsed.logoDataUrl === "string"
    && parsed.logoDataUrl.length <= 700_000
    && /^data:image\/(?:webp|png|jpeg);base64,/i.test(parsed.logoDataUrl)
    ? parsed.logoDataUrl : "";
  return {
    resumeStep: parsed.resumeStep === "market" || parsed.resumeStep === "split" || parsed.resumeStep === "review" ? parsed.resumeStep : "details",
    name: stringValue("name"), symbol: stringValue("symbol"), description: stringValue("description"),
    website: stringValue("website"), twitter: stringValue("twitter"), telegram: stringValue("telegram"),
    discord: stringValue("discord"), logoName: logoDataUrl ? stringValue("logoName") : "", logoDataUrl,
    pendingLaunchTx: /^0x[0-9a-fA-F]{64}$/.test(stringValue("pendingLaunchTx")) ? stringValue("pendingLaunchTx") : "",
    supply: stringValue("supply"),
    initialLiquidity: parsed.initialLiquidityExplicit === true ? stringValue("initialLiquidity") : "",
    initialLiquidityExplicit: parsed.initialLiquidityExplicit === true,
    tokenSeedAmount: stringValue("tokenSeedAmount"), feeRate: stringValue("feeRate"),
    quoteAsset: stringValue("quoteAsset"), projectTreasuryAddress: stringValue("projectTreasuryAddress"),
    communityAddress: stringValue("communityAddress"),
    allocations: {
      creator: percent(parsed.allocations?.creator, DEFAULT_DRAFT.allocations.creator),
      liquidity: percent(parsed.allocations?.liquidity, DEFAULT_DRAFT.allocations.liquidity),
      projectTreasury: percent(parsed.allocations?.projectTreasury ?? parsed.allocations?.treasury, DEFAULT_DRAFT.allocations.projectTreasury),
      community: percent(parsed.allocations?.community, DEFAULT_DRAFT.allocations.community),
    },
  };
}
