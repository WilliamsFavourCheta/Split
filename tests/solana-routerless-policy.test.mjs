import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOperatorAllocation } from '../app/lib/solana/routerless-policy.ts';
import { solanaMetadataMessage } from '../app/lib/solana/metadata-message.ts';

const defaults = { creator: 40, liquidity: 30, projectTreasury: 20, community: 10 };

test('one SOL fee receipt follows the disclosed 10/36/27/18/9 policy', () => {
  const allocations = calculateOperatorAllocation(1_000_000_000n, defaults);
  assert.deepEqual(allocations, {
    protocol: 100_000_000n, creator: 360_000_000n, liquidity: 270_000_000n,
    projectTreasury: 180_000_000n, community: 90_000_000n,
  });
});

test('small receipts conserve every raw unit and reject malformed policy', () => {
  for (let raw = 0n; raw < 1_000n; raw++) {
    const result = calculateOperatorAllocation(raw, defaults);
    assert.equal(Object.values(result).reduce((sum, value) => sum + value, 0n), raw);
  }
  assert.throws(() => calculateOperatorAllocation(-1n, defaults));
  assert.throws(() => calculateOperatorAllocation(100n, { ...defaults, community: 11 }));
  assert.throws(() => calculateOperatorAllocation(100n, { ...defaults, creator: 40.5 }));
});

test('wallet-signed metadata message binds the offchain policy and cluster', () => {
  const input = { cluster: 'mainnet-beta', mint: 'mint', creator: 'creator', expiresAt: 123,
    logoSha256: 'logo', metadata: { name: 'Token', symbol: 'TOKEN', description: '', website: '', x: '',
      projectTreasuryAddress: 'treasury', communityAddress: 'community', split: defaults } };
  const message = solanaMetadataMessage(input);
  assert.notEqual(message, solanaMetadataMessage({ ...input, cluster: 'devnet' }));
  assert.notEqual(message, solanaMetadataMessage({ ...input, metadata: { ...input.metadata,
    split: { ...defaults, creator: 39, community: 11 } } }));
  assert.notEqual(message, solanaMetadataMessage({ ...input, metadata: { ...input.metadata,
    projectTreasuryAddress: 'other' } }));
});
