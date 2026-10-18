import { connection } from "next/server";
import { HomePage } from "./components/home-page";
import { getProjectTokens } from "./lib/projects/repository";

export default async function Home() {
  await connection();
  let tokens: Awaited<ReturnType<typeof getProjectTokens>>["tokens"] = [];
  let dataUnavailable = true;
  try {
    const result = await getProjectTokens({ limit: 4 });
    tokens = result.tokens;
    dataUnavailable = result.source !== "supabase";
  } catch (error) {
    console.error("SPLIT home launch feed failed", error);
  }
  return <HomePage tokens={tokens} dataUnavailable={dataUnavailable} />;
}
