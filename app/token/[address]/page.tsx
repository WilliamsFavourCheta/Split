import { connection } from "next/server";
import { ProjectDataUnavailablePage, ProjectNotIndexedPage } from "../../components/marketplace-pages";
import { TokenTerminal } from "../../components/token-terminal";
import { getProjectAllocationHistory, getProjectFeeActivity, getProjectPriceHistory, getProjectToken } from "../../lib/projects/repository";
import { priceToMarketCapEth } from "../../lib/projects/price";
import { formatEthPrice } from "../../lib/projects/token-display";

export default async function Page({ params }: PageProps<"/token/[address]">) {
  await connection();
  const { address } = await params;
  const result = await (async () => {
    try {
    const token = await getProjectToken(address);
    if (!token) return { status: "not-indexed" as const };
    const [allocationEvents, feeActivity, priceHistory] = await Promise.all([getProjectAllocationHistory(address, 50), getProjectFeeActivity(address), getProjectPriceHistory(address)]);
    const latestPrice = priceHistory.snapshots.at(-1)?.priceEth;
    const marketCapEth = latestPrice ? priceToMarketCapEth(latestPrice) : null;
    const tokenWithPrice = { ...token, price: latestPrice ? formatEthPrice(latestPrice) : "-",
      marketCap: marketCapEth === null ? "-" : `${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(marketCapEth)} ETH` };
    return { status: "ready" as const, tokenWithPrice, feeActivity, allocationEvents, priceHistory };
    } catch (error) {
      console.error("SPLIT token data failed", error);
      return { status: "unavailable" as const };
    }
  })();
  if (result.status === "not-indexed") return <ProjectNotIndexedPage address={address} />;
  if (result.status === "unavailable") return <ProjectDataUnavailablePage />;
  return <TokenTerminal token={result.tokenWithPrice} feeActivity={result.feeActivity} allocationEvents={result.allocationEvents} priceHistory={result.priceHistory.snapshots} priceHistoryStatus={result.priceHistory.status} />;
}
