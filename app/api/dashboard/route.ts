import { isAddress } from "viem";
import { getDashboardFinancials } from "../../lib/projects/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("wallet");
  if (!address || !isAddress(address)) return Response.json({ error: "A valid wallet query is required." }, { status: 400 });
  try {
    return Response.json(await getDashboardFinancials(address));
  } catch (error) {
    console.error("SPLIT dashboard query failed", error);
    return Response.json({ error: "Could not load indexed account data." }, { status: 500 });
  }
}
