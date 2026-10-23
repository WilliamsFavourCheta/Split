import BN from "bn.js";
import { getPdaLaunchpadConfigId, LaunchpadConfig, PlatformConfig, Raydium, TxVersion } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getBase58Decoder } from "@solana/kit";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { solanaCluster, solanaRpcUrl } from "./client";
import { validateSolanaLaunch, type SolanaLaunchDraft } from "./launch-config";
import { getRouterlessPlatformConfig, routerBackedSolanaMode } from "./raydium-accounts";
import { executeSolanaLaunch as executeRouterLaunch } from "./router-launch-transaction";

type SignAndSend = (input: { transaction: Uint8Array }) => Promise<{ signature: Uint8Array }>;
const unsigned = (value: Uint8Array) => value.every((byte) => byte === 0);

async function finalized(connection: Connection, signature: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (result?.err) throw new Error(`Launch transaction failed: ${JSON.stringify(result.err)}`);
    if (result?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Launch transaction ${signature} was sent; finalization is pending. Check the explorer before retrying.`);
}

export async function executeSolanaLaunch(input: {
  mint: Keypair; creatorAddress: string; draft: SolanaLaunchDraft; metadataUri: string;
  signAndSend: SignAndSend; progress: (step: string) => void;
}) {
  if (routerBackedSolanaMode) return executeRouterLaunch(input);
  const errors = validateSolanaLaunch(input.draft);
  if (errors.length) throw new Error(errors.join(" "));
  const config = getRouterlessPlatformConfig();
  if (!config) throw new Error("SPLIT PlatformConfig and fee wallet are not configured.");
  const creator = new PublicKey(input.creatorAddress);
  const connection = new Connection(solanaRpcUrl, "finalized");
  const configId = getPdaLaunchpadConfigId(config.raydium, NATIVE_MINT, 0, 0).publicKey;
  const [globalAccount, platformAccount] = await connection.getMultipleAccountsInfo([configId, config.platform], "finalized");
  if (!globalAccount || !globalAccount.owner.equals(config.raydium) || globalAccount.data.length !== LaunchpadConfig.span
    || !platformAccount || !platformAccount.owner.equals(config.raydium) || platformAccount.data.length !== PlatformConfig.span)
    throw new Error("Raydium configuration is missing or invalid.");
  const global = LaunchpadConfig.decode(globalAccount.data);
  const platform = PlatformConfig.decode(platformAccount.data);
  if (!global.mintB.equals(NATIVE_MINT) || !platform.platformClaimFeeWallet.equals(config.feeWallet)
    || !platform.feeRate.eqn(10_000) || !platform.creatorFeeRate.isZero())
    throw new Error("Raydium platform fee settings changed.");
  const target = Number(input.draft.graduationTargetSol) * 1_000_000_000;
  if (!Number.isSafeInteger(target) || target < Number(global.minFundRaisingB.toString())) throw new Error("Unsupported graduation target.");
  input.progress("Building Raydium LaunchLab transaction");
  const raydium = await Raydium.load({ connection, owner: creator,
    cluster: solanaCluster === "devnet" ? "devnet" : "mainnet", disableFeatureCheck: true,
    disableLoadToken: true, blockhashCommitment: "finalized" });
  const built = await raydium.launchpad.createLaunchpad({ programId: config.raydium,
    platformId: config.platform, mintA: input.mint.publicKey, decimals: 6, mintBDecimals: 9,
    name: input.draft.name.trim(), symbol: input.draft.symbol.trim().toUpperCase(), uri: input.metadataUri,
    migrateType: "cpmm", configId, configInfo: global, supply: new BN("1000000000000000"),
    totalFundRaisingB: new BN(String(target)), buyAmount: new BN(0), createOnly: true,
    extraSigners: [input.mint], mintBProgram: TOKEN_PROGRAM_ID, txVersion: TxVersion.V0 });
  if (!built.transactions.length) throw new Error("Raydium returned no launch transaction.");
  const launchSignatures: string[] = [];
  for (const tx of built.transactions as VersionedTransaction[]) {
    if (!tx.message.staticAccountKeys[0].equals(creator)) throw new Error("Unexpected launch fee payer.");
    const signers = [...(built.signers[launchSignatures.length] ?? [])];
    const required = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    if (required.some((key) => key.equals(input.mint.publicKey)) && !signers.some((signer) => signer.publicKey.equals(input.mint.publicKey))) signers.push(input.mint);
    if (signers.length) tx.sign(signers);
    if (required.some((key, index) => !key.equals(creator) && unsigned(tx.signatures[index]))) throw new Error("Unexpected unsigned Raydium authority.");
    input.progress("Simulating Raydium launch");
    const simulation = await connection.simulateTransaction(tx, { sigVerify: false });
    if (simulation.value.err) throw new Error(`Raydium launch simulation failed: ${JSON.stringify(simulation.value.err)}`);
    input.progress("Approve Raydium launch in your wallet");
    const sent = await input.signAndSend({ transaction: tx.serialize() });
    const signature = getBase58Decoder().decode(sent.signature);
    launchSignatures.push(signature);
    await finalized(connection, signature);
  }
  return { mint: input.mint.publicKey.toBase58(), pool: built.extInfo.address.poolId.toBase58(),
    launchSignatures, registrationSignature: "" };
}
