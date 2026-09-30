import { connection } from "next/server";
import { ProjectNotIndexedPage, TokenDetailPage } from "../../components/marketplace-pages";
import { getProjectAccrualHistory, getProjectFeeHistory, getProjectPriceHistory, getProjectToken } from "../../lib/projects/repository";
import { priceToMarketCapEth } from "../../lib/projects/price";

export default async function Page({ params }: PageProps<"/token/[address]">) {
  await connection();
  const { address } = await params;
  const token = await getProjectToken(address);
  if (!token) return <ProjectNotIndexedPage address={address} />;
  const [routingEvents, accrualEvents, priceHistory] = await Promise.all([getProjectFeeHistory(address), getProjectAccrualHistory(address), getProjectPriceHistory(address)]);
  const latestPrice = priceHistory.snapshots.at(-1)?.priceEth;
  const marketCapEth = latestPrice ? priceToMarketCapEth(latestPrice) : null;
  const tokenWithPrice = { ...token, price: latestPrice ? `${latestPrice.toPrecision(6)} ETH / token` : "-",
    marketCap: marketCapEth === null ? token.marketCap : `${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(marketCapEth)} ETH` };
  return <TokenDetailPage token={tokenWithPrice} routingEvents={routingEvents} accrualEvents={accrualEvents} priceHistory={priceHistory.snapshots} priceHistoryStatus={priceHistory.status} />;
}
