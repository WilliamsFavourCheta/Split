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

test("deep reorg finds a saved common ancestor and rolls back orphan financial rows", async () => {
  const oldBranchHashAt1000 = `0x${"1".repeat(64)}`;
  const oldBranchHashAt980 = `0x${"2".repeat(64)}`;
  const commonHashAt700 = `0x${"a".repeat(64)}`;
  const checkpointBlock = BigInt(1_000);
  const overlapStart = checkpointBlock - BigInt(128) + BigInt(1);
  const canonicalHashes = new Map([
    [980, `0x${"b".repeat(64)}`], // Valid current-chain block/hash, but too high and not an old-branch ancestor.
    [700, commonHashAt700],
  ]);
  const checkpoints = [
    { block_number: 1_000, block_hash: oldBranchHashAt1000 },
    { block_number: 980, block_hash: oldBranchHashAt980 },
    { block_number: 700, block_hash: commonHashAt700 },
  ];
  const ancestor = await logic.findVerifiedCommonAncestor({
    startBlock: BigInt(1),
    checkpointBlock,
    checkpoints,
    getCanonicalHash: async (blockNumber) => canonicalHashes.get(Number(blockNumber)) ?? `0x${"c".repeat(64)}`,
  });
  assert.ok(ancestor.replayFrom < overlapStart, "recovery must exceed the normal overlap");
  assert.equal(ancestor.ancestorBlock, BigInt(700));
  assert.equal(ancestor.replayFrom, BigInt(701));
  assert.equal(logic.boundedBatchEnd(ancestor.replayFrom, BigInt(1_500), BigInt(500)), BigInt(1_200));

  const financialRows = [740, 880, 960, 980, 1_000].map((block_number) => ({ block_number, canonical: true }));
  for (const row of financialRows) if (row.block_number >= Number(ancestor.replayFrom)) row.canonical = false;
  assert.ok(financialRows.filter((row) => row.block_number > 700).every((row) => !row.canonical),
    "rows after the true common ancestor, including rows before the operator's too-high height, must be orphaned");
  assert.equal(financialRows.find((row) => row.block_number === 740).canonical, false);
});

test("deep reorg recovery halts without a saved current-chain ancestor", async () => {
  await assert.rejects(logic.findVerifiedCommonAncestor({
    startBlock: BigInt(1),
    checkpointBlock: BigInt(1_000),
    checkpoints: [
      { block_number: 1_000, block_hash: `0x${"1".repeat(64)}` },
      { block_number: 980, block_hash: `0x${"2".repeat(64)}` },
    ],
    getCanonicalHash: async () => `0x${"b".repeat(64)}`,
  }), /No previously indexed checkpoint matches/);
});

test("verified deep reorg rolls back above the finalized head and waits for replay", async () => {
  const rollbacks = [];
  const plan = await logic.prepareDeepReorgRecovery({
    ancestorBlock: BigInt(980),
    finalizedHead: BigInt(946),
    batchSize: BigInt(500),
    rollbackFrom: async (blockNumber) => rollbacks.push(blockNumber),
  });

  assert.deepEqual(rollbacks, [981], "orphan rows are invalidated even when no finalized replay range exists");
  assert.equal(plan.from, BigInt(981));
  assert.equal(plan.to, BigInt(946));
  assert.equal(plan.status, "waiting-for-finality");
});

test("event batches must match canonical event-block and range-end hashes", () => {
  const events = [
    { blockNumber: 100, blockHash: `0x${"a".repeat(64)}` },
    { blockNumber: 101, blockHash: `0x${"b".repeat(64)}` },
  ];
  const canonicalHashes = new Map([
    [100, `0x${"A".repeat(64)}`],
    [101, `0x${"b".repeat(64)}`],
  ]);
  assert.doesNotThrow(() => logic.assertEventBlockHashesCanonical(events, canonicalHashes));
  assert.throws(() => logic.assertEventBlockHashesCanonical(events, new Map([[100, `0x${"c".repeat(64)}`]])), /block hash mismatch/);
  assert.throws(() => logic.assertEventBlockHashesCanonical(events, new Map([[100, `0x${"a".repeat(64)}`]])), /Missing canonical block hash/);
  assert.doesNotThrow(() => logic.assertRangeEndHashStable(BigInt(101), `0x${"d".repeat(64)}`, `0x${"D".repeat(64)}`));
  assert.throws(() => logic.assertRangeEndHashStable(BigInt(101), `0x${"d".repeat(64)}`, `0x${"e".repeat(64)}`), /chain changed/);
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

test("pool price persistence preserves exact sqrtPriceX96 as a decimal string", () => {
  const rawPrice = "1461501637330902918203684832716283019655932542975";
  const record = logic.projectPriceEventRecord({
    type: "PoolPriceUpdated",
    chainId: 4663,
    contractAddress: "0xPoolManager",
    txHash: "0xPrice",
    logIndex: 7,
    blockNumber: 300,
    blockHash: `0x${"d".repeat(64)}`,
    poolId: `0x${"e".repeat(64)}`,
    sqrtPriceX96: rawPrice,
    source: "swap",
  }, "project-id");
  assert.equal(record.sqrt_price_x96, rawPrice);
  assert.equal(BigInt(record.sqrt_price_x96), BigInt(rawPrice));
  assert.equal(logic.sqrtPriceX96ToEthPerToken("79228162514264337593543950336"), 1);
  assert.equal(record.canonical, true);
});
