import { getSolanaLaunchReadiness } from "../../../lib/solana/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getSolanaLaunchReadiness(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Solana launch readiness check failed", error);
    return Response.json({ ready: false, reasons: ["Solana RPC is unavailable or returned invalid data."] },
      { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
