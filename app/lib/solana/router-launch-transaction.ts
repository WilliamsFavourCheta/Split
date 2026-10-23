import BN from "bn.js";
import { LaunchpadConfig, Raydium, TxVersion, getPdaLaunchpadConfigId } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getBase58Decoder } from "@solana/kit";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { solanaCluster, solanaRpcUrl } from "./client";
import { validateSolanaLaunch, type SolanaLaunchDraft } from "./launch-config";
import { deriveSolanaProjectAccounts, getSolanaDeploymentConfig } from "./raydium-accounts";

type SignAndSend = (input: { transaction: Uint8Array }) => Promise<{ signature: Uint8Array }>;
type Progress = (step: string) => void;
const zeroSignature = (signature: Uint8Array) => signature.every((byte) => byte === 0);

async function finalize(connection: Connection, signature: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = result.value[0];
    if (status?.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Transaction ${signature} was sent but finalization is still pending. Check the explorer before retrying.`);
}

async function registerInstruction(mint: PublicKey, creator: PublicKey, draft: SolanaLaunchDraft, router: PublicKey) {
  const accounts = deriveSolanaProjectAccounts(mint.toBase58(), router);
  const discriminator = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("global:register_project"))).subarray(0, 8);
  const data = Buffer.alloc(16);
  Buffer.from(discriminator).copy(data, 0);
  data.writeUInt16LE(draft.split.creator * 100, 8);
  data.writeUInt16LE(draft.split.liquidity * 100, 10);
  data.writeUInt16LE(draft.split.projectTreasury * 100, 12);
  data.writeUInt16LE(draft.split.community * 100, 14);
  return new TransactionInstruction({ programId: router, data, keys: [
    { pubkey: creator, isSigner: true, isWritable: true },
    { pubkey: creator, isSigner: true, isWritable: false },
    { pubkey: accounts.protocol, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: true, isWritable: false },
    { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
    { pubkey: accounts.pool, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(draft.projectTreasuryAddress), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(draft.communityAddress), isSigner: false, isWritable: false },
    { pubkey: accounts.project, isSigner: false, isWritable: true },
    { pubkey: accounts.projectVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ] });
}

/** Caller must show a transaction summary and obtain an explicit UI click before invoking this. */
export async function executeSolanaLaunch(input: {
  mint: Keypair;
  creatorAddress: string;
  draft: SolanaLaunchDraft;
  metadataUri: string;
  signAndSend: SignAndSend;
  progress: Progress;
}) {
  const errors = validateSolanaLaunch(input.draft);
  if (errors.length) throw new Error(errors.join(" "));
  const deployment = getSolanaDeploymentConfig();
  if (!deployment) throw new Error("SPLIT Solana deployment is not configured.");
  const creator = new PublicKey(input.creatorAddress);
  const connection = new Connection(solanaRpcUrl, { commitment: "finalized" });
  const configId = getPdaLaunchpadConfigId(deployment.raydium, NATIVE_MINT, 0, 0).publicKey;
  const configAccount = await connection.getAccountInfo(configId, "finalized");
  if (!configAccount || !configAccount.owner.equals(deployment.raydium) || configAccount.data.length < LaunchpadConfig.span) {
    throw new Error("Raydium WSOL curve configuration is unavailable.");
  }
  const configInfo = LaunchpadConfig.decode(configAccount.data);
  const targetLamports = Number(input.draft.graduationTargetSol) * 1_000_000_000;
  if (!Number.isSafeInteger(targetLamports) || targetLamports < Number(configInfo.minFundRaisingB.toString())) {
    throw new Error("Graduation target is outside Raydium's supported range.");
  }
  input.progress("Simulating immutable split registration");
  const blockhash = await connection.getLatestBlockhash("finalized");
  const registration = new Transaction({ feePayer: creator, recentBlockhash: blockhash.blockhash })
    .add(await registerInstruction(input.mint.publicKey, creator, input.draft, deployment.router));
  registration.partialSign(input.mint);
  const simulation = await connection.simulateTransaction(registration);
  if (simulation.value.err) throw new Error(`Split registration simulation failed: ${JSON.stringify(simulation.value.err)}`);
  input.progress("Approve split registration in your wallet");
  const registrationResult = await input.signAndSend({ transaction: registration.serialize({ requireAllSignatures: false, verifySignatures: false }) });
  const registrationSignature = getBase58Decoder().decode(registrationResult.signature);
  await finalize(connection, registrationSignature);

  input.progress("Building Raydium LaunchLab CPMM curve");
  const raydium = await Raydium.load({ connection, owner: creator, cluster: solanaCluster === "devnet" ? "devnet" : "mainnet",
    disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: "finalized" });
  const built = await raydium.launchpad.createLaunchpad({
    programId: deployment.raydium, platformId: deployment.platform, mintA: input.mint.publicKey,
    decimals: 6, mintBDecimals: 9, name: input.draft.name.trim(), symbol: input.draft.symbol.trim().toUpperCase(),
    uri: input.metadataUri, migrateType: "cpmm", configId, configInfo,
    supply: new BN("1000000000000000"), totalFundRaisingB: new BN(String(targetLamports)),
    buyAmount: new BN(0), createOnly: true, extraSigners: [input.mint],
    mintBProgram: TOKEN_PROGRAM_ID, txVersion: TxVersion.V0,
  });
  const launchSignatures: string[] = [];
  for (let i = 0; i < built.transactions.length; i += 1) {
    const tx: VersionedTransaction = built.transactions[i];
    if (!tx.message.staticAccountKeys[0].equals(creator)) throw new Error("Unexpected Raydium transaction fee payer.");
    const signers = [...(built.signers[i] ?? [])];
    if (tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).some((key) => key.equals(input.mint.publicKey))
      && !signers.some((signer) => signer.publicKey.equals(input.mint.publicKey))) signers.push(input.mint);
    if (signers.length) tx.sign(signers);
    const required = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    if (required.some((key, index) => !key.equals(creator) && zeroSignature(tx.signatures[index]))) {
      throw new Error("Raydium launch transaction has an unexpected unsigned account.");
    }
    input.progress(`Simulating Raydium launch transaction ${i + 1} of ${built.transactions.length}`);
    const result = await connection.simulateTransaction(tx, { sigVerify: false });
    if (result.value.err) throw new Error(`Raydium launch simulation failed: ${JSON.stringify(result.value.err)}`);
    input.progress(`Approve Raydium launch transaction ${i + 1} of ${built.transactions.length} in your wallet`);
    const sent = await input.signAndSend({ transaction: tx.serialize() });
    const signature = getBase58Decoder().decode(sent.signature);
    launchSignatures.push(signature);
    await finalize(connection, signature);
  }
  if (!launchSignatures.length) throw new Error("Raydium returned no launch transactions.");
  return { mint: input.mint.publicKey.toBase58(), pool: built.extInfo.address.poolId.toBase58(),
    registrationSignature, launchSignatures };
}
