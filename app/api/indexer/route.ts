import { timingSafeEqual } from "node:crypto";
import { runIndexerBatch } from "../../lib/indexer/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_BATCH_LIMIT = 20;
const CRON_TIME_BUDGET_MS = 240_000;

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

/** Vercel Hobby invokes this GET route once daily with CRON_SECRET. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Indexer cron is not configured." }, { status: 503 });
  if (!authorized(request, secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });

  const startedAt = Date.now();
  let batches = 0;
  let events = 0;
  let last: Awaited<ReturnType<typeof runIndexerBatch>> | null = null;
  try {
    while (batches < CRON_BATCH_LIMIT && Date.now() - startedAt < CRON_TIME_BUDGET_MS) {
      last = await runIndexerBatch();
      batches += 1;
      events += last.events;
      if (last.status !== "indexed") break;
    }
    return Response.json({ status: last?.status ?? "not-run", batches, events, indexedThrough: last?.indexedThrough ?? null },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("SPLIT scheduled indexer failed", error);
    return Response.json({ error: "Scheduled indexer failed. Check server logs.", batches, indexedThrough: last?.indexedThrough ?? null }, { status: 500 });
  }
}
