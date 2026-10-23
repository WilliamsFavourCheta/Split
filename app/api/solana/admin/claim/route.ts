import { claimPlatformFee, LaunchpadPool } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { requireAdminSignature } from "../../../../lib/solana/admin-auth";
import { solanaRpcUrl } from "../../../../lib/solana/client";
import { isSolanaAddress } from "../../../../lib/solana/launch-config";
import { verifySolanaLaunch } from "../../../../lib/solana/verify-launch";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { mint?: string; wallet?: string; nonce?: string; signature?: string };
    if (!body.mint || !isSolanaAddress(body.mint) || !body.wallet || !body.nonce || !body.signature)
      return Response.json({ error: "Invalid claim request." }, { status: 400 });
    const config = await requireAdminSignature({ purpose: "claim", mint: body.mint,
      wallet: body.wallet, nonce: body.nonce, signature: body.signature });
    const launch = await verifySolanaLaunch(body.mint);
    const connection = new Connection(solanaRpcUrl, "finalized");
    const poolAddress = new PublicKey(launch.pool);
    const poolAccount = await connection.getAccountInfo(poolAddress, "finalized");
    if (!poolAccount || !poolAccount.owner.equals(config.raydium) || poolAccount.data.length !== LaunchpadPool.span)
      throw new Error("Raydium pool is unavailable.");
    const pool = LaunchpadPool.decode(poolAccount.data);
    if (!pool.platformFee.gt(new BN(0)))
      return Response.json({ error: "No pool-specific platform fee is available." }, { status: 409 });
    const feeWalletAta = getAssociatedTokenAddressSync(NATIVE_MINT, config.feeWallet);
    const [authority] = PublicKey.findProgramAddressSync([Buffer.from("vault_auth_seed")], config.raydium);
    const blockhash = await connection.getLatestBlockhash("finalized");
    const tx = new Transaction({ feePayer: config.feeWallet, recentBlockhash: blockhash.blockhash })
      .add(createAssociatedTokenAccountIdempotentInstruction(config.feeWallet, feeWalletAta,
        config.feeWallet, NATIVE_MINT, TOKEN_PROGRAM_ID))
      .add(claimPlatformFee(config.raydium, config.feeWallet, authority, poolAddress,
        config.platform, pool.vaultB, feeWalletAta, NATIVE_MINT, TOKEN_PROGRAM_ID));
    return Response.json({ transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      mint: body.mint, pool: launch.pool, wallet: config.feeWallet.toBase58(),
      recipientTokenAccount: feeWalletAta.toBase58(), expectedAvailableWsolRaw: pool.platformFee.toString(),
      lastValidBlockHeight: blockhash.lastValidBlockHeight }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Claim preparation failed." }, { status: 403 });
  }
}
