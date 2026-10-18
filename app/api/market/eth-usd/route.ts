export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LlamaQuote = { timestamp: number; price: number };

function validQuote(value: unknown): value is LlamaQuote {
  if (!value || typeof value !== "object") return false;
  const quote = value as Record<string, unknown>;
  return typeof quote.timestamp === "number" && Number.isFinite(quote.timestamp)
    && typeof quote.price === "number" && Number.isFinite(quote.price) && quote.price > 0;
}

export async function GET(request: Request) {
  const now = Math.floor(Date.now() / 1_000);
  const requested = Number(new URL(request.url).searchParams.get("from"));
  if (!Number.isSafeInteger(requested) || requested < now - 5 * 365 * 86_400 || requested > now) {
    return Response.json({ error: "A valid history start time is required." }, { status: 400 });
  }

  // DefiLlama quotes are sampled hourly for shorter charts and daily for
  // longer histories. Their timestamps remain attached to every USD estimate.
  const periodSeconds = now - requested <= 60 * 86_400 ? 3_600 : 86_400;
  const start = Math.max(now - 5 * 365 * 86_400, requested - periodSeconds);
  const span = Math.min(2_000, Math.ceil((now - start) / periodSeconds) + 1);
  const period = periodSeconds === 3_600 ? "1h" : "1d";
  const historyUrl = `https://coins.llama.fi/chart/coingecko:ethereum?start=${start}&span=${span}&period=${period}`;
  const currentUrl = "https://coins.llama.fi/prices/current/coingecko:ethereum";

  try {
    const [historyResponse, currentResponse] = await Promise.all([
      fetch(historyUrl, { next: { revalidate: 300 }, signal: AbortSignal.timeout(8_000) }),
      fetch(currentUrl, { next: { revalidate: 300 }, signal: AbortSignal.timeout(8_000) }),
    ]);
    if (!historyResponse.ok || !currentResponse.ok) throw new Error("ETH/USD provider returned an error.");
    const history = await historyResponse.json() as { coins?: Record<string, { prices?: unknown }> };
    const current = await currentResponse.json() as { coins?: Record<string, unknown> };
    const historical = history.coins?.["coingecko:ethereum"]?.prices;
    const currentQuote = current.coins?.["coingecko:ethereum"];
    if (!Array.isArray(historical) || !validQuote(currentQuote)) throw new Error("ETH/USD provider response was incomplete.");
    const quotes = historical.filter(validQuote).map((quote) => ({ snapshotAt: new Date(quote.timestamp * 1_000).toISOString(), priceUsd: quote.price }));
    quotes.push({ snapshotAt: new Date(currentQuote.timestamp * 1_000).toISOString(), priceUsd: currentQuote.price });
    return Response.json({ quotes, source: "DefiLlama", sampledEvery: period },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300" } });
  } catch (error) {
    console.error("SPLIT ETH/USD history failed", error);
    return Response.json({ error: "USD conversion is temporarily unavailable." }, { status: 503 });
  }
}
