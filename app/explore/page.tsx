import { connection } from "next/server";
import { ExplorePage } from "../components/marketplace-pages";
import { getProjectTokens } from "../lib/projects/repository";

export default async function Page() {
  await connection();
  const result = await getProjectTokens({ limit: 100 });
  return <ExplorePage tokens={result.tokens} dataUnavailable={result.source !== "supabase"} />;
}
