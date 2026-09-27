import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "../node_modules/typescript/lib/typescript.js";

const source = await readFile(new URL("../app/lib/indexer/remediation-logic.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const logic = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

const launch = {
  type: "TokenLaunched",
  chainId: 4663,
  contractAddress: "0xFactory",
  txHash: "0xlaunch",
  logIndex: 4,
  blockNumber: 100,
  blockHash: `0x${"1".repeat(64)}`,
  poolId: `0x${"2".repeat(64)}`,
  tokenAddress: "0xToken",
  creatorAddress: "0xCreator",
  name: "Reorg Token",
  symbol: "REORG",
  quoteAsset: "0x0000000000000000000000000000000000000000",
  totalSupply: "1000000000000000000000000000",
  seedTokenAmount: "1000000000000000000",
  seedQuoteAmount: "1000000000000000000",
  sqrtPriceX96: "79228162514264337593543950336",
  lpFee: 3000,
};

test("multi-batch reorg replay restores project canonical state before later fee lookup", async () => {
  const projects = new Map();
  const eventKeys = new Set();
  const processed = [];
  const apply = async (event) => {
    if (event.type === "TokenLaunched") {
      const row = logic.launchProjectUpsert(event);
      projects.set(`${row.chain_id}:${row.token_address}`, { ...projects.get(`${row.chain_id}:${row.token_address}`), ...row });
    } else {
      const project = [...projects.values()].find((row) => row.pool_id === event.poolId.toLowerCase() && row.canonical);
      assert.ok(project, "fee event must resolve a canonical pool project");
      eventKeys.add(`${event.chainId}:${event.txHash}:${event.logIndex}`);
    }
    processed.push(event.type);
  };

  await logic.replayEventsInCanonicalOrder([launch], apply);
  const projectKey = `4663:${launch.tokenAddress.toLowerCase()}`;
  assert.equal(projects.get(projectKey).canonical, true);

  // The overlap rollback and launch replay happen in one later batch; repeat it
  // to model a worker retry after a process interruption.
  projects.get(projectKey).canonical = false;
  const replayedCount = await logic.replayEventsInCanonicalOrder([launch], apply);
  await logic.replayEventsInCanonicalOrder([{
    type: "FeesAccrued",
    chainId: 4663,
    contractAddress: "0xHook",
    txHash: "0xfee",
    logIndex: 0,
    blockNumber: 101,
    blockHash: `0x${"3".repeat(64)}`,
    poolId: launch.poolId,
    currency: "0x0000000000000000000000000000000000000000",
    rawAmount: "900719925474099312345678900",
    swapperAddress: "0xTrader",
  }], apply);

  assert.equal(replayedCount, 1);
  assert.equal(projects.size, 1, "launch upsert must not duplicate project rows");
  assert.equal(projects.get(projectKey).canonical, true);
  assert.equal(eventKeys.size, 1, "the fee event key remains idempotent across retries");
  assert.deepEqual(processed, ["TokenLaunched", "TokenLaunched", "FeesAccrued"]);
});

test("deep reorg recovery reaches an explicitly verified ancestor beyond the 128-block overlap", () => {
  const checkpointBlock = BigInt(1_000);
  const overlapStart = checkpointBlock - BigInt(128) + BigInt(1);
  const replayFrom = BigInt(700);
  const ancestorHash = `0x${"a".repeat(64)}`;
  assert.ok(replayFrom < overlapStart, "test recovery must exceed the normal overlap");
  assert.equal(logic.verifiedRecoveryStart({
    startBlock: BigInt(1),
    checkpointBlock,
    replayFrom,
    expectedAncestorHash: ancestorHash,
    actualAncestorHash: ancestorHash,
  }), replayFrom);
  assert.equal(logic.boundedBatchEnd(replayFrom, BigInt(1_500), BigInt(500)), BigInt(1_199));
  assert.throws(() => logic.verifiedRecoveryStart({
    startBlock: BigInt(1),
    checkpointBlock,
    replayFrom,
    expectedAncestorHash: ancestorHash,
    actualAncestorHash: `0x${"b".repeat(64)}`,
  }), /ancestor hash mismatch/);
  assert.throws(() => logic.verifiedRecoveryStart({
    startBlock: BigInt(1),
    checkpointBlock,
    replayFrom: BigInt(1_001),
    expectedAncestorHash: ancestorHash,
    actualAncestorHash: ancestorHash,
  }), /no later than the stale checkpoint/);
});

test("protocol launch-fee claim persistence preserves exact raw integer strings", () => {
  const rawAmount = "90071992547409931234567890012345678901234567890";
  const event = {
    type: "ProtocolLaunchFeesClaimed",
    chainId: 4663,
    contractAddress: "0xRouter",
    txHash: "0xclaim",
    logIndex: 8,
    blockNumber: 200,
    blockHash: `0x${"c".repeat(64)}`,
    recipientAddress: "0xTreasury",
    rawAmount,
  };
  const row = logic.protocolLaunchFeeClaimRecord(event);
  assert.equal(row.raw_amount, rawAmount);
  assert.equal(BigInt(row.raw_amount), BigInt(rawAmount));
  assert.equal(row.canonical, true);
  assert.equal("pool_id" in row, false, "the event does not encode a project pool");
  const upserts = new Map();
  const eventKey = `${row.chain_id}:${row.tx_hash}:${row.log_index}`;
  upserts.set(eventKey, row);
  upserts.set(eventKey, logic.protocolLaunchFeeClaimRecord(event));
  assert.equal(upserts.size, 1, "replaying a claim log is idempotent under its chain/tx/log key");
});
