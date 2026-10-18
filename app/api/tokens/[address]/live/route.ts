import { isAddress, type Hash } from "viem";
import { indexerClient, poolSwapAbi, robinhoodPoolManager } from "../../../../lib/indexer/evm-source";
import { getProject } from "../../../../lib/projects/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RECENT_BLOCKS = BigInt(10_000);
const FINALITY_BLOCKS = BigInt(64);
const MAX_SWAPS = 20;

export async function GET(_request: Request, context: RouteContext<"/api/tokens/[address]/live">) {
  const { address } = await context.params;
  if (!isAddress(address)) return Response.json({ error: "Invalid token address." }, { status: 400 });

  try {
    const project = await getProject(address);
    if (!project || !/^0x[0-9a-f]{64}$/i.test(project.pool_id ?? "")) {
      return Response.json({ error: "Official SPLIT pool not found." }, { status: 404 });
    }
    const head = await indexerClient.getBlockNumber();
    if (head <= FINALITY_BLOCKS) return Response.json({ swaps: [], throughBlock: null });
    const through = head - FINALITY_BLOCKS;
    const from = through > RECENT_BLOCKS ? through - RECENT_BLOCKS + BigInt(1) : BigInt(0);
    const logs = await indexerClient.getLogs({
      address: robinhoodPoolManager,
      event: poolSwapAbi[0],
      args: { id: project.pool_id as Hash },
      fromBlock: from,
      toBlock: through,
    });
    const recent = logs.slice(-MAX_SWAPS).reverse();
    const timestamps = new Map<bigint, string>();
    await Promise.all([...new Set(recent.map((log) => log.blockNumber))].map(async (blockNumber) => {
      const block = await indexerClient.getBlock({ blockNumber });
      timestamps.set(blockNumber, new Date(Number(block.timestamp) * 1_000).toISOString());
    }));
    const swaps = recent.map((log) => {
      const { amount0, amount1, sqrtPriceX96 } = log.args;
      if (amount0 === undefined || amount1 === undefined || sqrtPriceX96 === undefined) {
        throw new Error("PoolManager returned an incomplete swap log.");
      }
      return {
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: Number(log.blockNumber),
        timestamp: timestamps.get(log.blockNumber) ?? null,
        direction: amount0 > BigInt(0) ? "buy" : "sell",
        ethAmountRaw: (amount0 < BigInt(0) ? -amount0 : amount0).toString(),
        tokenAmountRaw: (amount1 < BigInt(0) ? -amount1 : amount1).toString(),
        sqrtPriceX96: sqrtPriceX96.toString(),
      };
    });
    return Response.json({
      swaps,
      throughBlock: Number(through),
    }, { headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=15" } });
  } catch (error) {
    console.error("SPLIT recent swap query failed", error);
    return Response.json({ error: "Recent swaps are temporarily unavailable." }, { status: 503 });
  }
}
