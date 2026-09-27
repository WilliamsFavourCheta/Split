import "server-only";
import { isSupabaseConfigured, createServerSupabaseClient } from "../supabase/server";
import type { DestinationType, ProjectStatus } from "../supabase/database.types";
import { DEFAULT_SPLIT, type Allocation, type Token } from "../../data/mock";
import { isAddress, zeroAddress } from "viem";
import { splitHookAbi, splitLiquidityVaultAbi } from "../../contracts/abis";
import { indexerClient } from "../indexer/evm-source";

export type ProjectListFilters = { query?: string; creatorAddress?: string; status?: ProjectStatus | "all"; limit?: number; offset?: number };
export type IndexedProject = { id:string; chainId:number; tokenAddress:string; poolId:string|null; quoteAsset:string|null; creatorAddress:string; name:string; symbol:string; description:string; website:string; twitter:string; telegram:string; discord:string; status:ProjectStatus; launchedAt:string|null; verified:boolean; split:Allocation[]; metrics?: { marketCapUsd:string|null; volume24hUsd:string|null; liquidityUsd:string|null; holderCount:number|null } };

const normalizeAddress = (value: string) => value.trim().toLowerCase();
const isProtocolIndexMigrationMissing = (message: string) =>
  /column .*?(pool_id|canonical|gross_amount_raw|block_hash).* does not exist/i.test(message)
  || /schema cache.*(pool_id|canonical)/i.test(message)
  || /(?:relation|table).*?(fee_allocation_events|fee_claim_events|fee_accrual_events)_exact.*does not exist/i.test(message)
  || /(fee_allocation_events|fee_claim_events|fee_accrual_events)_exact.*schema cache/i.test(message)
  || /(?:relation|table).*?(fee_allocation_events|fee_claim_events).*does not exist/i.test(message)
  || /schema cache.*(fee_allocation_events|fee_claim_events)/i.test(message);

export async function getProjects(filters: ProjectListFilters = {}) {
  if (!isSupabaseConfigured) return { projects: [] as IndexedProject[], nextOffset: null, source: "unconfigured" as const };
  const client = createServerSupabaseClient();
  const limit = Math.min(Math.max(filters.limit ?? 24, 1), 100);
  let query = client.from("projects").select("id,chain_id,token_address,pool_id,quote_asset,creator_address,name,symbol,description,website_url,x_url,telegram_url,discord_url,status,launched_at,verified,fee_configs(creator_bps,liquidity_bps,project_treasury_bps,community_bps,creator_destination,project_treasury_destination,community_destination),project_metrics(market_cap_usd,volume_24h_usd,liquidity_usd,holder_count),project_metadata(description,website_url,x_url,telegram_url,discord_url)").eq("canonical", true).order("launched_at", { ascending:false, nullsFirst:false }).range(filters.offset ?? 0, (filters.offset ?? 0) + limit);
  if (filters.status && filters.status !== "all") query = query.eq("status", filters.status);
  if (filters.creatorAddress) query = query.eq("creator_address", normalizeAddress(filters.creatorAddress));
  if (filters.query?.trim()) { const q = filters.query.trim().replaceAll(",", " "); query = query.or(`name.ilike.%${q}%,symbol.ilike.%${q}%,token_address.ilike.%${normalizeAddress(q)}%`); }
  const { data, error } = await query;
  if (error) {
    if (isProtocolIndexMigrationMissing(error.message)) {
      return { projects: [] as IndexedProject[], nextOffset: null, source: "migration-required" as const };
    }
    throw new Error(`Could not load indexed projects: ${error.message}`);
  }
  const projects = (data ?? []).slice(0, limit).map((row) => {
    const fee = Array.isArray(row.fee_configs) ? row.fee_configs[0] : row.fee_configs;
    const metadata = Array.isArray(row.project_metadata) ? row.project_metadata[0] : row.project_metadata;
    const metrics = Array.isArray(row.project_metrics) ? row.project_metrics[0] : row.project_metrics;
    const split = fee ? DEFAULT_SPLIT.map((item) => ({
      ...item,
      value: Number(fee[item.key === "projectTreasury" ? "project_treasury_bps" : `${item.key}_bps` as "creator_bps" | "liquidity_bps" | "community_bps"]) / 100,
      address: item.key === "creator" ? fee.creator_destination ?? undefined
        : item.key === "projectTreasury" ? fee.project_treasury_destination ?? undefined
          : item.key === "community" ? fee.community_destination ?? undefined
            : process.env.NEXT_PUBLIC_SPLIT_VAULT_MAINNET_ADDRESS ?? undefined,
      type: item.key === "liquidity" ? "SPLIT Liquidity Vault" : item.label,
    })) : [];
    return {
      id:row.id, chainId:row.chain_id, tokenAddress:row.token_address, poolId:row.pool_id,
      quoteAsset:row.quote_asset, creatorAddress:row.creator_address, name:row.name, symbol:row.symbol,
      description:metadata?.description ?? row.description ?? "", website:metadata?.website_url ?? row.website_url ?? "",
      twitter:metadata?.x_url ?? row.x_url ?? "", telegram:metadata?.telegram_url ?? row.telegram_url ?? "",
      discord:metadata?.discord_url ?? row.discord_url ?? "", status:row.status, launchedAt:row.launched_at,
      verified:row.verified, split,
      metrics:metrics ? { marketCapUsd:metrics.market_cap_usd, volume24hUsd:metrics.volume_24h_usd, liquidityUsd:metrics.liquidity_usd, holderCount:metrics.holder_count } : undefined,
    };
  });
  return { projects, nextOffset: data?.length === limit + 1 ? (filters.offset ?? 0) + limit : null, source:"supabase" as const };
}

function displayUsd(value: string | null | undefined) {
  return value === null || value === undefined ? "â€”" : `$${Number(value).toLocaleString()}`;
}

function asToken(project: IndexedProject): Token {
  return {
    address: project.tokenAddress,
    name: project.name,
    ticker: project.symbol,
    status: project.status === "pending" ? "upcoming" : project.status,
    marketCap: displayUsd(project.metrics?.marketCapUsd),
    volume: displayUsd(project.metrics?.volume24hUsd),
    liquidity: displayUsd(project.metrics?.liquidityUsd),
    holders: project.metrics?.holderCount?.toLocaleString() ?? "â€”",
    price: "â€”",
    launched: project.launchedAt ? new Date(project.launchedAt).toLocaleDateString() : "â€”",
    color: "#9b64ff",
    description: project.description,
    website: project.website,
    twitter: project.twitter,
    telegram: project.telegram,
    discord: project.discord,
    owner: project.creatorAddress,
    split: project.split,
  };
}

export async function getProjectTokens(filters: ProjectListFilters = {}) {
  const result = await getProjects(filters);
  return { ...result, tokens: result.projects.filter((project) => project.split.length === 4).map(asToken) };
}

export async function getProject(address: string) {
  if (!isSupabaseConfigured) return null;
  const client = createServerSupabaseClient();
  // Do not select raw numeric(78,0) project/metric columns from base tables:
  // PostgREST serializes those as JSON numbers. Read financial raw values only
  // from the *_exact views, which cast them to decimal text in SQL.
  const { data, error } = await client.from("projects").select("id,chain_id,token_address,creator_address,name,symbol,description,website_url,x_url,telegram_url,discord_url,status,launched_at,verified,canonical,fee_configs(*),project_metrics(price_usd,market_cap_usd,volume_24h_usd,liquidity_usd,holder_count),project_metadata(*)").eq("canonical", true).eq("token_address", normalizeAddress(address)).maybeSingle();
  if (error) {
    if (isProtocolIndexMigrationMissing(error.message)) return null;
    throw new Error(`Could not load indexed project: ${error.message}`);
  }
  return data;
}

export async function getProjectToken(address: string): Promise<Token | null> {
  const project = await getProject(address);
  if (!project) return null;
  const feeRaw = project.fee_configs;
  const fee = Array.isArray(feeRaw) ? feeRaw[0] : feeRaw;
  const metricsRaw = project.project_metrics;
  const metrics = Array.isArray(metricsRaw) ? metricsRaw[0] : metricsRaw;
  const metadataRaw = project.project_metadata;
  const metadata = Array.isArray(metadataRaw) ? metadataRaw[0] : metadataRaw;
  if (!fee) return null;
  const status = project.status as ProjectStatus;
  const split = DEFAULT_SPLIT.map((item) => ({
    ...item,
    value: Number(fee[item.key === "projectTreasury" ? "project_treasury_bps" : `${item.key}_bps` as "creator_bps" | "liquidity_bps" | "community_bps"]) / 100,
    address: item.key === "creator" ? fee.creator_destination ?? undefined
      : item.key === "projectTreasury" ? fee.project_treasury_destination ?? undefined
        : item.key === "community" ? fee.community_destination ?? undefined
          : process.env.NEXT_PUBLIC_SPLIT_VAULT_MAINNET_ADDRESS ?? undefined,
    type: item.key === "liquidity" ? "SPLIT Liquidity Vault" : item.label,
  }));
  return {
    address: project.token_address,
    name: project.name,
    ticker: project.symbol,
    status: status === "pending" ? "upcoming" : status,
    marketCap: metrics?.market_cap_usd ? `$${Number(metrics.market_cap_usd).toLocaleString()}` : "â€”",
    volume: metrics?.volume_24h_usd ? `$${Number(metrics.volume_24h_usd).toLocaleString()}` : "â€”",
    liquidity: metrics?.liquidity_usd ? `$${Number(metrics.liquidity_usd).toLocaleString()}` : "â€”",
    holders: metrics?.holder_count?.toLocaleString() ?? "â€”",
    price: "â€”",
    launched: project.launched_at ? new Date(project.launched_at).toLocaleDateString() : "â€”",
    color: "#9b64ff",
    description: metadata?.description ?? project.description ?? "",
    website: metadata?.website_url ?? project.website_url ?? "",
    twitter: metadata?.x_url ?? project.x_url ?? "",
    telegram: metadata?.telegram_url ?? project.telegram_url ?? "",
    discord: metadata?.discord_url ?? project.discord_url ?? "",
    owner: project.creator_address,
    split,
  };
}

export async function getProjectFeeHistory(address: string, limit = 50, offset = 0) {
  if (!isSupabaseConfigured) return [];
  const project = await getProject(address); if (!project) return [];
  const { data, error } = await createServerSupabaseClient().from("fee_allocation_events_exact").select("*").eq("project_id", project.id).eq("canonical", true).order("block_number", { ascending:false }).range(offset, offset + Math.min(limit, 100) - 1);
  if (error) {
    if (isProtocolIndexMigrationMissing(error.message)) return [];
    throw new Error(`Could not load fee allocation events: ${error.message}`);
  }
  return (data ?? []).flatMap((event) => ([
    ["protocol treasury", event.protocol_allocation_raw],
    ["creator", event.creator_allocation_raw],
    ["project treasury", event.project_treasury_allocation_raw],
    ["community", event.community_allocation_raw],
    ["liquidity", event.liquidity_allocation_raw],
  ] as const).filter(([, raw_amount]) => BigInt(raw_amount) > BigInt(0)).map(([destination_type, raw_amount]) => ({
    id: `${event.id}:${destination_type}`,
    tx_hash: event.tx_hash,
    block_number: event.block_number,
    destination_type: `${destination_type} allocated`,
    destination_address: null,
    raw_amount,
    currency: event.currency,
    token_decimals: 18,
  })));
}

export async function getProjectAccrualHistory(address: string, limit = 50, offset = 0) {
  if (!isSupabaseConfigured) return [];
  const project = await getProject(address);
  if (!project) return [];
  const { data, error } = await createServerSupabaseClient().from("fee_accrual_events_exact").select("*").eq("project_id", project.id).eq("canonical", true).order("block_number", { ascending:false }).range(offset, offset + Math.min(limit, 100) - 1);
  if (error) throw new Error(`Could not load accrual events: ${error.message}`);
  return data;
}

export async function getDashboardProjects(walletAddress: string) { return getProjects({ creatorAddress: normalizeAddress(walletAddress), limit:100 }); }
export async function getDashboardFeeStats(walletAddress: string) {
  if (!isSupabaseConfigured) return null;
  const { projects } = await getDashboardProjects(walletAddress);
  return projects.reduce((totals, project) => ({ launches:totals.launches + 1, volumeUsd:totals.volumeUsd + Number(project.metrics?.volume24hUsd ?? 0), marketCapUsd:totals.marketCapUsd + Number(project.metrics?.marketCapUsd ?? 0) }), { launches:0, volumeUsd:0, marketCapUsd:0 });
}

export async function getDashboardFinancials(walletAddress: string) {
  const client = isSupabaseConfigured ? createServerSupabaseClient() : null;
  const allProjects: IndexedProject[] = [];
  const claimProjects: IndexedProject[] = [];
  let migrationRequired = false;
  if (client) {
    let offset = 0;
    do {
      const page = await getProjects({ creatorAddress: normalizeAddress(walletAddress), limit: 100, offset });
      if (page.source === "migration-required") {
        migrationRequired = true;
        break;
      }
      allProjects.push(...page.projects);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (true);
    for (let offset = 0; ; offset += 100) {
      const page = await getProjects({ limit: 100, offset });
      if (page.source === "migration-required") {
        migrationRequired = true;
        break;
      }
      claimProjects.push(...page.projects);
      if (page.nextOffset === null) break;
    }
  }
  const projectResult = { projects: allProjects };
  const projects = allProjects.filter((project) => project.split.length === 4).map(asToken);
  const claimTargets = claimProjects.filter((project) => project.split.length === 4 && project.poolId).map((project) => ({
    poolId: project.poolId!,
    tokenAddress: project.tokenAddress,
    name: project.name,
    symbol: project.symbol,
  }));
  if (migrationRequired) {
    return { projects, claimTargets: [], accrued: [], unrouted: null, allocated: [], claimed: [], liquidityReserved: null, indexed: false };
  }
  if (!client || projects.length === 0) {
    return { projects, claimTargets, accrued: [], unrouted: null as Array<{ currency: string; rawAmount: string; count: number }> | null, allocated: [], claimed: [], liquidityReserved: null as Array<{ currency: string; rawAmount: string }> | null, indexed: Boolean(client) };
  }
  const projectIds = projectResult.projects.filter((project) => project.split.length === 4).map((project) => project.id);
  const accrualRows: Array<{ currency: string | null; raw_amount: string }> = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await client.from("fee_accrual_events_exact").select("currency,raw_amount").in("project_id", projectIds).eq("canonical", true).range(offset, offset + 999);
    if (error) throw new Error(`Could not load accrued fee totals: ${error.message}`);
    accrualRows.push(...(data ?? []));
    if (!data || data.length < 1_000) break;
  }
  const allocatedRows: Array<{ currency: string | null; gross_amount_raw: string; protocol_allocation_raw: string; creator_allocation_raw: string; project_treasury_allocation_raw: string; community_allocation_raw: string; liquidity_allocation_raw: string }> = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await client.from("fee_allocation_events_exact").select("currency,gross_amount_raw,protocol_allocation_raw,creator_allocation_raw,project_treasury_allocation_raw,community_allocation_raw,liquidity_allocation_raw").in("project_id", projectIds).eq("canonical", true).range(offset, offset + 999);
    if (error) {
      if (isProtocolIndexMigrationMissing(error.message)) return { projects, claimTargets, accrued: [], unrouted: null, allocated: [], claimed: [], liquidityReserved: null, indexed: false };
      throw new Error(`Could not load allocated fee totals: ${error.message}`);
    }
    allocatedRows.push(...(data ?? []));
    if (!data || data.length < 1_000) break;
  }
  const claimedRows: Array<{ currency: string | null; raw_amount: string }> = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await client.from("fee_claim_events_exact").select("currency,raw_amount").eq("recipient_address", normalizeAddress(walletAddress)).eq("canonical", true).range(offset, offset + 999);
    if (error) {
      if (isProtocolIndexMigrationMissing(error.message)) return { projects, claimTargets, accrued: [], unrouted: null, allocated: [], claimed: [], liquidityReserved: null, indexed: false };
      throw new Error(`Could not load claimed fee totals: ${error.message}`);
    }
    claimedRows.push(...(data ?? []));
    if (!data || data.length < 1_000) break;
  }
  const group = (rows: Array<{ currency: string | null; raw_amount: string; destination_type?: DestinationType }>, includeDestination = false) => {
    const result = new Map<string, { currency: string; destinationType?: DestinationType; rawAmount: bigint; count: number }>();
    for (const row of rows) {
      const currency = (row.currency ?? zeroAddress).toLowerCase();
      const destinationType = includeDestination ? row.destination_type : undefined;
      const key = `${currency}:${destinationType ?? ""}`;
      const previous = result.get(key) ?? { currency, destinationType, rawAmount: BigInt(0), count: 0 };
      previous.rawAmount += BigInt(row.raw_amount);
      previous.count += 1;
      result.set(key, previous);
    }
    return Array.from(result.values()).map((item) => ({ ...item, rawAmount: item.rawAmount.toString() }));
  };

  let liquidityReserved: Array<{ currency: string; rawAmount: string }> | null = null;
  let unrouted: Array<{ currency: string; rawAmount: string; count: number }> | null = null;
  const hookAddress = process.env.NEXT_PUBLIC_SPLIT_HOOK_MAINNET_ADDRESS;
  if (hookAddress && isAddress(hookAddress)) {
    const balances = new Map<string, bigint>();
    for (const project of projectResult.projects) {
      if (!project.poolId) continue;
      for (const currency of [zeroAddress, project.tokenAddress.toLowerCase()]) {
        const amount = await indexerClient.readContract({
          address: hookAddress,
          abi: splitHookAbi,
          functionName: "accrued",
          args: [project.poolId as `0x${string}`, currency as `0x${string}`],
        });
        balances.set(currency, (balances.get(currency) ?? BigInt(0)) + amount);
      }
    }
    unrouted = Array.from(balances, ([currency, amount]) => ({ currency, rawAmount: amount.toString(), count: 0 }));
  }
  const vaultAddress = process.env.NEXT_PUBLIC_SPLIT_VAULT_MAINNET_ADDRESS;
  if (vaultAddress && isAddress(vaultAddress)) {
    const balances = new Map<string, bigint>();
    for (const project of projectResult.projects) {
      if (!project.poolId) continue;
      for (const currency of [zeroAddress, project.tokenAddress.toLowerCase()]) {
        const amount = await indexerClient.readContract({
          address: vaultAddress,
          abi: splitLiquidityVaultAbi,
          functionName: "pendingLiquidity",
          args: [project.poolId as `0x${string}`, currency as `0x${string}`],
        });
        balances.set(currency, (balances.get(currency) ?? BigInt(0)) + amount);
      }
    }
    liquidityReserved = Array.from(balances, ([currency, amount]) => ({ currency, rawAmount: amount.toString() }));
  }
  const allocations = ([
    ["creator", "creator_allocation_raw"],
    ["protocol_treasury", "protocol_allocation_raw"],
    ["project_treasury", "project_treasury_allocation_raw"],
    ["community", "community_allocation_raw"],
    ["liquidity", "liquidity_allocation_raw"],
  ] as const).flatMap(([destination_type, field]) => allocatedRows.map((row) => ({ currency: row.currency, destination_type, raw_amount: row[field] })));
  return { projects, claimTargets, accrued: group(accrualRows), unrouted, allocated: group(allocations, true), claimed: group(claimedRows), liquidityReserved, indexed: true };
}

export type IndexedRoutingEvent = { chainId:number; txHash:string; logIndex:number; projectId:string; blockNumber:number; destinationType:DestinationType; rawAmount:string; tokenAddress?:string; destinationAddress?:string; tokenDecimals?:number; blockTimestamp?:string };
