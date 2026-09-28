import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import ts from "../node_modules/typescript/lib/typescript.js";

async function loadPureModule(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const metadata = await loadPureModule("../app/lib/projects/metadata-signing.ts");
const image = await loadPureModule("../app/lib/projects/image-validation.ts");
const migration = await readFile(new URL("../supabase/migrations/202609280005_throttle_project_metadata_updates.sql", import.meta.url), "utf8");

test("real creator signature rejects cross-token, changed image, changed fields, wrong creator, and stale nonce", async () => {
  const creator = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const token = "0x1111111111111111111111111111111111111111";
  const otherToken = "0x2222222222222222222222222222222222222222";
  const imageDigest = `0x${createHash("sha256").update("image-a").digest("hex")}`;
  const changedImageDigest = `0x${createHash("sha256").update("image-b").digest("hex")}`;
  const fields = { description: "Original", website: "", twitter: "", telegram: "", discord: "" };
  const fieldsDigest = `0x${createHash("sha256").update(metadata.projectMetadataFields(fields)).digest("hex")}`;
  const changedFieldsDigest = `0x${createHash("sha256").update(metadata.projectMetadataFields({ ...fields, description: "Changed" })).digest("hex")}`;
  const expiresAt = Date.now() + 60_000;
  const signed = metadata.projectMetadataMessage(token, imageDigest, fieldsDigest, expiresAt, 0);
  const signature = await creator.signMessage({ message: signed });
  const verifies = (address, message) => verifyMessage({ address, message, signature });

  assert.equal(await verifies(creator.address, signed), true);
  assert.equal(await verifies(other.address, signed), false);
  assert.equal(await verifies(creator.address, metadata.projectMetadataMessage(otherToken, imageDigest, fieldsDigest, expiresAt, 0)), false);
  assert.equal(await verifies(creator.address, metadata.projectMetadataMessage(token, changedImageDigest, fieldsDigest, expiresAt, 0)), false);
  assert.equal(await verifies(creator.address, metadata.projectMetadataMessage(token, imageDigest, changedFieldsDigest, expiresAt, 0)), false);
  assert.equal(await verifies(creator.address, metadata.projectMetadataMessage(token, imageDigest, fieldsDigest, expiresAt, 1)), false);
  assert.equal(metadata.validMetadataExpiry(expiresAt, expiresAt), false);
  assert.equal(metadata.validMetadataExpiry(expiresAt, expiresAt - 60_001), true);
  assert.equal(metadata.validMetadataExpiry(expiresAt, expiresAt - 300_001), false);
});

test("many distinct uploads reuse one token path and cannot cross projects or use a malicious filename", () => {
  const token = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const other = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const path = metadata.canonicalProjectLogoPath(token);
  for (let i = 0; i < 1000; i++) {
    const digest = `0x${createHash("sha256").update(String(i)).digest("hex")}`;
    assert.equal(metadata.canonicalProjectLogoPath(token), path);
    assert.equal(metadata.versionedProjectLogoUrl(`https://example.test/${path}`, digest), `https://example.test/${path}?v=${digest.slice(2)}`);
  }
  assert.notEqual(path, metadata.canonicalProjectLogoPath(other));
  assert.throws(() => metadata.canonicalProjectLogoPath(`${token}/../../other/logo`));
  assert.throws(() => metadata.canonicalProjectLogoPath("../logo.png"));
  assert.equal(path.endsWith("/logo"), true);
});

test("upload type and size rules still reject unsupported and oversized files", () => {
  const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0);
  assert.equal(image.matchesImageHeader(png, "image/png"), true);
  assert.equal(image.matchesImageHeader(png, "image/jpeg"), false);
  assert.equal(image.matchesImageHeader(png, "image/svg+xml"), false);
  assert.equal(image.mimeExtensions["image/svg+xml"], undefined);
  assert.equal(image.MAX_IMAGE_BYTES, 512 * 1024);
  assert.equal(512 * 1024 + 1 > image.MAX_IMAGE_BYTES, true);
});

test("migration defines an atomic nonce claim with cooldown and single-use completion", () => {
  assert.match(migration, /project_id uuid primary key/);
  assert.match(migration, /where project_id = p_project_id\s+and nonce = p_expected_nonce/);
  assert.match(migration, /next_allowed_at <= now\(\)/);
  assert.match(migration, /claim_expires_at is null or claim_expires_at <= now\(\)/);
  assert.match(migration, /next_allowed_at = now\(\) \+ interval '60 seconds'/);
  assert.match(migration, /claim_expires_at = now\(\) \+ interval '120 seconds'/);
  assert.match(migration, /and nonce = p_claim_nonce\s+and claim_expires_at > now\(\)/);
  assert.match(migration, /revoke execute on function public\.claim_project_metadata_update.*from public, anon, authenticated/);
});
