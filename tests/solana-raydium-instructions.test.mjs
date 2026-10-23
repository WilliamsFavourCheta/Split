import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const BN = require("bn.js");
const { Keypair, PublicKey } = require("@solana/web3.js");
const { claimPlatformFee, createPlatformConfig, getPdaPlatformId } = require("@raydium-io/raydium-sdk-v2");

const program = new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
const address = () => Keypair.generate().publicKey;
const discriminator = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

test("SDK per-pool claim requires the platform fee wallet and binds the pool and recipient", () => {
  const wallet = address();
  const pool = address();
  const platform = address();
  const quoteVault = address();
  const recipient = address();
  const ix = claimPlatformFee(program, wallet, address(), pool, platform, quoteVault,
    recipient, address(), address());
  assert.ok(ix.programId.equals(program));
  assert.deepEqual(ix.data, discriminator("claim_platform_fee"));
  assert.ok(ix.keys[0].pubkey.equals(wallet));
  assert.equal(ix.keys[0].isSigner, true);
  assert.ok(ix.keys[2].pubkey.equals(pool));
  assert.ok(ix.keys[3].pubkey.equals(platform));
  assert.ok(ix.keys[4].pubkey.equals(quoteVault));
  assert.ok(ix.keys[5].pubkey.equals(recipient));
});

test("SDK platform setup uses the admin PDA and 1% / zero creator fee", () => {
  const admin = address();
  const wallet = address();
  const platform = getPdaPlatformId(program, admin).publicKey;
  const ix = createPlatformConfig(program, admin, wallet, admin, admin, platform,
    address(), admin, { platformScale: new BN(0), creatorScale: new BN(0),
      burnScale: new BN(1_000_000) }, new BN(10_000), new BN(0), "SPLIT", "", "", new BN(0));
  assert.ok(ix.programId.equals(program));
  assert.deepEqual(ix.data.subarray(0, 8), discriminator("create_platform_config"));
  assert.ok(ix.keys[0].pubkey.equals(admin));
  assert.equal(ix.keys[0].isSigner, true);
  assert.ok(ix.keys.some((account) => account.pubkey.equals(wallet)));
  assert.ok(ix.keys.some((account) => account.pubkey.equals(platform)));
});
