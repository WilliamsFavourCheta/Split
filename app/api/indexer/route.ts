import { timingSafeEqual } from "node:crypto";
import { runIndexerBatch } from "../../lib/indexer/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request, expected: string) {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function POST(request: Request) {
  const secret = process.env.SPLIT_INDEXER_CRON_SECRET;
  if (!secret) return Response.json({ error: "Indexer is not configured." }, { status: 503 });
  if (!authorized(request, secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });

  try {
    return Response.json(await runIndexerBatch());
  } catch (error) {
    console.error("SPLIT indexer batch failed", error);
    return Response.json({ error: "Indexer batch failed. Check server logs." }, { status: 500 });
  }
}
