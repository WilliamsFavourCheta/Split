import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getBase58Decoder } from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { solanaRpcUrl } from "./client";
import { deriveSolanaProjectAccounts, getSolanaDeploymentConfig, SPLIT_PROTOCOL_TREASURY } from "./raydium-accounts";

export type SolanaClaimRole = "protocol" | "creator" | "project_treasury" | "community";
type SignAndSend = (input: { transaction: Uint8Array }) => Promise<{ signature: Uint8Array }>;
const ROLE_INDEX: Record<SolanaClaimRole, number> = { protocol: 0, creator: 1, project_treasury: 2, community: 3 };

async function instructionData(name: string, role?: SolanaClaimRole) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`)));
  return Buffer.from(role ? [...hash.subarray(0, 8), ROLE_INDEX[role]] : hash.subarray(0, 8));
}

async function sendTransaction(connection: Connection, tx: Transaction, signAndSend: SignAndSend) {
  const simulated = await connection.simulateTransaction(tx);
  if (simulated.value.err) throw new Error(`Transaction simulation failed: ${JSON.stringify(simulated.value.err)}`);
  const result = await signAndSend({ transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }) });
  const signature = getBase58Decoder().decode(result.signature);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "finalized") return signature;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Transaction sent but finalization is pending: ${signature}`);
}

export async function collectSolanaPlatformFees(mint: string, walletAddress: string, signAndSend: SignAndSend) {
  const config = getSolanaDeploymentConfig();
  if (!config) throw new Error("SPLIT Solana deployment is unavailable.");
  const wallet = new PublicKey(walletAddress);
  const accounts = deriveSolanaProjectAccounts(mint, config.router);
  const connection = new Connection(solanaRpcUrl, { commitment: "finalized" });
  const blockhash = await connection.getLatestBlockhash("finalized");
  const tx = new Transaction({ feePayer: wallet, recentBlockhash: blockhash.blockhash });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(wallet, accounts.feeWalletTokens,
    accounts.feeWallet, NATIVE_MINT, TOKEN_PROGRAM_ID));
  tx.add(new TransactionInstruction({ programId: config.router,
    data: await instructionData("collect_platform_fee"),
    keys: [
      { pubkey: accounts.protocol, isSigner: false, isWritable: false },
      { pubkey: accounts.project, isSigner: false, isWritable: true },
      { pubkey: accounts.projectVault, isSigner: false, isWritable: true },
      { pubkey: accounts.feeWallet, isSigner: false, isWritable: true },
      { pubkey: accounts.feeWalletTokens, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: accounts.raydiumAuthority, isSigner: false, isWritable: false },
      { pubkey: accounts.pool, isSigner: false, isWritable: true },
      { pubkey: accounts.poolQuoteVault, isSigner: false, isWritable: true },
      { pubkey: config.platform, isSigner: false, isWritable: false },
      { pubkey: config.raydium, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ] }));
  return sendTransaction(connection, tx, signAndSend);
}

export async function claimSolanaFees(mint: string, walletAddress: string, role: SolanaClaimRole, signAndSend: SignAndSend) {
  const config = getSolanaDeploymentConfig();
  if (!config) throw new Error("SPLIT Solana deployment is unavailable.");
  if (role === "protocol" && walletAddress !== SPLIT_PROTOCOL_TREASURY.toBase58()) {
    throw new Error("Only the protocol treasury can claim that allocation.");
  }
  const wallet = new PublicKey(walletAddress);
  const accounts = deriveSolanaProjectAccounts(mint, config.router);
  const recipientTokens = getAssociatedTokenAddressSync(NATIVE_MINT, wallet);
  const connection = new Connection(solanaRpcUrl, { commitment: "finalized" });
  const blockhash = await connection.getLatestBlockhash("finalized");
  const tx = new Transaction({ feePayer: wallet, recentBlockhash: blockhash.blockhash });
  tx.add(createAssociatedTokenAccountIdempotentInstruction(wallet, recipientTokens, wallet, NATIVE_MINT, TOKEN_PROGRAM_ID));
  tx.add(new TransactionInstruction({ programId: config.router, data: await instructionData("claim", role), keys: [
    { pubkey: accounts.project, isSigner: false, isWritable: true },
    { pubkey: accounts.projectVault, isSigner: false, isWritable: true },
    { pubkey: wallet, isSigner: true, isWritable: false },
    { pubkey: recipientTokens, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ] }));
  return sendTransaction(connection, tx, signAndSend);
}
