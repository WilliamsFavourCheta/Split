import { connection } from "next/server";
import { ManageProjectPage } from "../../components/account-pages";
import { ProjectNotIndexedPage } from "../../components/marketplace-pages";
import { getProjectFeeHistory, getProjectToken } from "../../lib/projects/repository";
export default async function Page({ params }: PageProps<"/manage/[address]">) {
  await connection();
  const { address } = await params;
  const token = await getProjectToken(address);
  if (!token) return <ProjectNotIndexedPage address={address} />;
  const routingEvents = await getProjectFeeHistory(address);
  return <ManageProjectPage token={token} routingEvents={routingEvents} />;
}
