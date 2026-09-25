import { connection } from "next/server";
import { ProjectNotIndexedPage, TokenDetailPage } from "../../components/marketplace-pages";
import { getProjectAccrualHistory, getProjectFeeHistory, getProjectToken } from "../../lib/projects/repository";

export default async function Page({ params }: PageProps<"/token/[address]">) {
  await connection();
  const { address } = await params;
  const token = await getProjectToken(address);
  if (!token) return <ProjectNotIndexedPage address={address} />;
  const [routingEvents, accrualEvents] = await Promise.all([getProjectFeeHistory(address), getProjectAccrualHistory(address)]);
  return <TokenDetailPage token={token} routingEvents={routingEvents} accrualEvents={accrualEvents} />;
}
