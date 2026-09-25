import "server-only";

/**
 * Boundary for a future SIWE-style nonce/signature session. Do not treat a
 * browser-provided address as authenticated until this contract is implemented.
 */
export type VerifiedWalletSession = { walletAddress: string; issuedAt: Date; expiresAt: Date };
export interface WalletAuthenticator {
  issueNonce(walletAddress: string): Promise<string>;
  verifySignature(input: { walletAddress: string; nonce: string; signature: string }): Promise<VerifiedWalletSession | null>;
}

export function requireVerifiedWalletSession(session: VerifiedWalletSession | null): VerifiedWalletSession {
  if (!session) throw new Error("Wallet signature authentication is required for this mutation.");
  return session;
}
