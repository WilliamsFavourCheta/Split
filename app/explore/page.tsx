import { connection } from "next/server";
import { ExplorePage } from "../components/marketplace-pages";
import { getProjectTokens } from "../lib/projects/repository";

export default async function Page() {
  await connection();
  let tokens: Awaited<ReturnType<typeof getProjectTokens>>["tokens"] = [];
  let dataUnavailable = true;
  try {
    const result = await getProjectTokens({ limit: 100 });
    tokens = result.tokens;
    dataUnavailable = result.source !== "supabase";
  } catch (error) {
    console.error("SPLIT explore launch feed failed", error);
  }
  return <ExplorePage tokens={tokens} dataUnavailable={dataUnavailable} />;
}
