import { createAdminChallenge, type AdminPurpose } from "../../../../lib/solana/admin-auth";
import { isSolanaAddress } from "../../../../lib/solana/launch-config";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { purpose?: AdminPurpose; mint?: string };
    if (!body.mint || !isSolanaAddress(body.mint) || !["claim", "receipt", "payout"].includes(body.purpose ?? ""))
      return Response.json({ error: "Invalid challenge request." }, { status: 400 });
    return Response.json(await createAdminChallenge(body.purpose!, body.mint),
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Administrator challenge unavailable." }, { status: 503 });
  }
}
