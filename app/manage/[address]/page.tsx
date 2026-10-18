import { connection } from "next/server";
import { ManageProjectPage } from "../../components/account-pages";
import { ProjectDataUnavailablePage, ProjectNotIndexedPage } from "../../components/marketplace-pages";
import { getProjectFeeHistory, getProjectToken } from "../../lib/projects/repository";
export default async function Page({ params }: PageProps<"/manage/[address]">) {
  await connection();
  const { address } = await params;
  const result = await (async () => {
    try {
    const token = await getProjectToken(address);
    if (!token) return { status: "not-indexed" as const };
    const routingEvents = await getProjectFeeHistory(address);
    return { status: "ready" as const, token, routingEvents };
    } catch (error) {
      console.error("SPLIT project management data failed", error);
      return { status: "unavailable" as const };
    }
  })();
  if (result.status === "not-indexed") return <ProjectNotIndexedPage address={address} />;
  if (result.status === "unavailable") return <ProjectDataUnavailablePage />;
  return <ManageProjectPage token={result.token} routingEvents={result.routingEvents} />;
}
