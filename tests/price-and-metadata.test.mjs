import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "../node_modules/typescript/lib/typescript.js";

async function loadPureModule(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const price = await loadPureModule("../app/lib/projects/price.ts");
const metadata = await loadPureModule("../app/lib/projects/metadata-signing.ts");
const image = await loadPureModule("../app/lib/projects/image-validation.ts");
const drafts = await loadPureModule("../app/lib/projects/launch-draft.ts");
const Q96 = 2n ** 96n;

test("ETH per token inverts the native/token v4 price without zeroing extreme valid prices", () => {
  assert.equal(price.sqrtPriceX96ToEthPerToken(Q96.toString()), 1);
  assert.equal(price.sqrtPriceX96ToEthPerToken((Q96 * 2n).toString()), 0.25);
  assert.equal(price.sqrtPriceX96ToEthPerToken((Q96 / 2n).toString()), 4);
  const tiny = price.sqrtPriceX96ToEthPerToken("1461446703485210103287273052203988822378723970341");
  assert.ok(tiny > 0 && Number.isFinite(tiny));
  assert.equal(price.sqrtPriceX96ToEthPerToken("0"), null);
  assert.equal(price.sqrtPriceX96ToEthPerToken("1e30"), null);
});

test("chart period selection handles zero, one, and many canonical observations", () => {
  assert.deepEqual(price.selectPriceSnapshots([], "1D"), []);
  const one = [{ priceEth: 1, snapshotAt: "2026-09-28T00:00:00Z" }];
  assert.deepEqual(price.selectPriceSnapshots(one, "1D"), one);
  const many = [
    { priceEth: 0.5, snapshotAt: "2026-09-01T00:00:00Z" },
    { priceEth: 0.75, snapshotAt: "2026-09-27T12:00:00Z" },
    { priceEth: 1, snapshotAt: "2026-09-28T00:00:00Z" },
  ];
  assert.equal(price.selectPriceSnapshots(many, "1D").length, 2);
  assert.equal(price.selectPriceSnapshots(many, "ALL").length, 3);
});

test("metadata signature binds token, image, fields, and expiry", () => {
  const fields = { description: "A", website: "", twitter: "", telegram: "", discord: "" };
  assert.notEqual(metadata.projectMetadataFields(fields), metadata.projectMetadataFields({ ...fields, description: "B" }));
  const base = metadata.projectMetadataMessage("0xabc", "0x123", "0x456", 100, 0);
  assert.notEqual(base, metadata.projectMetadataMessage("0xdef", "0x123", "0x456", 100, 0));
  assert.notEqual(base, metadata.projectMetadataMessage("0xabc", "0x124", "0x456", 100, 0));
  assert.notEqual(base, metadata.projectMetadataMessage("0xabc", "0x123", "0x457", 100, 0));
  assert.notEqual(base, metadata.projectMetadataMessage("0xabc", "0x123", "0x456", 101, 0));
  assert.notEqual(base, metadata.projectMetadataMessage("0xabc", "0x123", "0x456", 100, 1));
});

test("upload validation rejects mismatched executable data and accepts supported image headers", () => {
  assert.equal(image.matchesImageHeader(new TextEncoder().encode("<script>alert(1)</script>"), "image/png"), false);
  assert.equal(image.matchesImageHeader(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), "image/png"), true);
  assert.equal(image.matchesImageHeader(Uint8Array.of(255, 216, 255, 0), "image/jpeg"), true);
  assert.equal(image.matchesImageHeader(new TextEncoder().encode("RIFF1234WEBP"), "image/webp"), true);
  assert.equal(image.matchesImageHeader(new TextEncoder().encode("RIFF1234WEBP"), "text/html"), false);
  assert.equal(image.MAX_IMAGE_BYTES, 512 * 1024);
});

test("launch draft restoration preserves legacy treasury allocation and safe local logo preview", () => {
  const restored = drafts.restoreLaunchDraft(JSON.stringify({
    name: "Legacy", symbol: "OLD", logoName: "logo.webp", logoDataUrl: "data:image/webp;base64,AAAA",
    allocations: { creator: 40, liquidity: 30, treasury: 20, community: 10 },
  }));
  assert.equal(restored.allocations.projectTreasury, 20);
  assert.equal(restored.logoName, "logo.webp");
  assert.equal(restored.logoDataUrl, "data:image/webp;base64,AAAA");
  const malformed = drafts.restoreLaunchDraft(JSON.stringify({ logoName: "bad.svg", logoDataUrl: "data:image/svg+xml;base64,AAAA", allocations: { treasury: 1000 } }));
  assert.equal(malformed.logoDataUrl, "");
  assert.equal(malformed.logoName, "");
  assert.equal(malformed.allocations.projectTreasury, 20);
  assert.equal(drafts.restoreLaunchDraft("not-json").name, "");
});
