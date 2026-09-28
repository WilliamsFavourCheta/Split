import { connection } from "next/server";
import { HomePage } from "./components/home-page";
import { getProjectTokens } from "./lib/projects/repository";

export default async function Home() {
  await connection();
  const { tokens } = await getProjectTokens({ limit: 4 });
  return <HomePage tokens={tokens} />;
}
