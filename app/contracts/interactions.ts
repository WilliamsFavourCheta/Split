import {
  formatUnits,
  isAddress,
  parseUnits,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { erc20Abi } from "./abis";
import { toWalletErrorMessage } from "../web3/errors";

export type ApprovalStep =
  | "CHECKING BALANCE"
  | "CHECKING APPROVAL"
  | "CONFIRM APPROVAL RESET IN WALLET"
  | "CONFIRMING APPROVAL RESET"
  | "CONFIRM APPROVAL IN WALLET"
  | "CONFIRMING APPROVAL"
  | "CONFIRMED";

export async function readErc20Balance(client: PublicClient, token: Address, owner: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

export async function readErc20Allowance(client: PublicClient, token: Address, owner: Address, spender: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
}

export async function waitForSuccessfulReceipt(client: PublicClient, hash: Hash) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted before confirmation.");
  return receipt;
}

export type TransactionStep = "CONFIRM TRANSACTION IN WALLET" | "CONFIRMING TRANSACTION" | "CONFIRMED";

export async function readLiveWalletState(connector: { getChainId: () => Promise<number>; getAccounts: () => Promise<readonly Address[]> }) {
  const [chainId, accounts] = await Promise.all([connector.getChainId(), connector.getAccounts()]);
  const account = accounts[0];
  if (!account) throw new Error("The connected wallet has no authorized account. Reconnect it before continuing.");
  return { chainId, account };
}

/** Typed, chain- and account-checked write helper for future configured SPLIT contracts. */
export async function writeContractOnTarget<
  const abi extends Abi,
  functionName extends ContractFunctionName<abi, "nonpayable" | "payable">,
>(input: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  getLiveChainId: () => Promise<number>;
  getLiveAccount: () => Promise<Address>;
  targetChainId: number;
  account: Address;
  address: string;
  abi: abi;
  functionName: functionName;
  args: ContractFunctionArgs<abi, "nonpayable" | "payable", functionName>;
  onStep?: (step: TransactionStep) => void;
  onConfirmed?: () => void | Promise<void>;
}) {
  if (!isAddress(input.address)) throw new Error("Contract address is missing or invalid.");
  if (input.walletClient.chain?.id !== undefined && input.walletClient.chain.id !== input.targetChainId) {
    throw new Error("Wallet client is on the wrong chain.");
  }
  if (input.publicClient.chain?.id !== undefined && input.publicClient.chain.id !== input.targetChainId) {
    throw new Error("Read client is configured for the wrong chain.");
  }
  const liveChainId = await input.getLiveChainId();
  const liveAccount = await input.getLiveAccount();
  if (liveChainId !== input.targetChainId) throw new Error("Wallet changed networks. Switch back before continuing.");
  if (!isAddress(liveAccount) || liveAccount.toLowerCase() !== input.account.toLowerCase()) {
    throw new Error("The active wallet account changed. Review the account and try again.");
  }

  const parameters = {
    address: input.address as Address,
    abi: input.abi,
    functionName: input.functionName,
    args: input.args,
    account: input.account,
    chain: input.walletClient.chain,
  } as Parameters<WalletClient["writeContract"]>[0];
  input.onStep?.("CONFIRM TRANSACTION IN WALLET");
  const hash = await input.walletClient.writeContract(parameters);
  input.onStep?.("CONFIRMING TRANSACTION");
  const receipt = await waitForSuccessfulReceipt(input.publicClient, hash);
  await input.onConfirmed?.();
  input.onStep?.("CONFIRMED");
  return { hash, receipt };
}

/**
 * Checks balance and allowance, then requests only the exact needed approval.
 * A non-zero insufficient allowance is reset first for tokens requiring that pattern.
 * getLiveChainId must query the currently connected EIP-1193 wallet immediately before each write.
 */
export async function ensureErc20Allowance(input: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  getLiveChainId: () => Promise<number>;
  getLiveAccount: () => Promise<Address>;
  targetChainId: number;
  token: string;
  owner: string;
  spender: string;
  amount: string;
  decimals: number;
  onStep?: (step: ApprovalStep) => void;
  onConfirmed?: () => void | Promise<void>;
}) {
  const { publicClient, walletClient, getLiveChainId, targetChainId } = input;
  if (!isAddress(input.token) || !isAddress(input.owner) || !isAddress(input.spender)) {
    throw new Error("Token, wallet, and spender must be valid EVM addresses.");
  }
  if (!/^(?:\d+)(?:\.\d+)?$/.test(input.amount) || input.decimals < 0 || input.decimals > 255) {
    throw new Error("Enter a valid positive token amount.");
  }
  const amount = parseUnits(input.amount, input.decimals);
  if (amount <= BigInt(0)) throw new Error("The amount must be greater than zero.");
  const token = input.token as Address;
  const owner = input.owner as Address;
  const spender = input.spender as Address;
  const walletChain = walletClient.chain?.id;
  if (walletChain !== undefined && walletChain !== targetChainId) throw new Error("Wallet client is on the wrong chain.");
  if (publicClient.chain?.id !== undefined && publicClient.chain.id !== targetChainId) throw new Error("Read client is configured for the wrong chain.");
  if (!walletClient.account) throw new Error("Connect a wallet before approving tokens.");
  if (walletClient.account.address.toLowerCase() !== owner.toLowerCase()) throw new Error("Connected account does not match the token owner.");

  input.onStep?.("CHECKING BALANCE");
  const balance = await readErc20Balance(publicClient, token, owner);
  if (balance < amount) throw new Error(`Insufficient token balance. Available: ${formatUnits(balance, input.decimals)}.`);

  input.onStep?.("CHECKING APPROVAL");
  const allowance = await readErc20Allowance(publicClient, token, owner, spender);
  const approvalHashes: Hash[] = [];
  const submitApproval = async (value: bigint, stage: "reset" | "approval") => {
    const liveChainId = await getLiveChainId();
    const liveAccount = await input.getLiveAccount();
    if (liveChainId !== targetChainId) throw new Error("Wallet changed networks. Switch back before approving.");
    if (!isAddress(liveAccount) || liveAccount.toLowerCase() !== owner.toLowerCase()) throw new Error("The active wallet account changed. Review the account and try again.");
    if (!isAddress(input.token) || !isAddress(input.spender)) throw new Error("Token or spender address is invalid.");
    input.onStep?.(stage === "reset" ? "CONFIRM APPROVAL RESET IN WALLET" : "CONFIRM APPROVAL IN WALLET");
    const hash = await walletClient.writeContract({
      account: owner,
      chain: walletClient.chain,
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, value],
    });
    approvalHashes.push(hash);
    input.onStep?.(stage === "reset" ? "CONFIRMING APPROVAL RESET" : "CONFIRMING APPROVAL");
    await waitForSuccessfulReceipt(publicClient, hash);
  };

  try {
    if (allowance >= amount) {
      input.onStep?.("CONFIRMED");
      return { amount, balance, allowance, approvalHashes, formattedAmount: formatUnits(amount, input.decimals) };
    }
    if (allowance > BigInt(0)) await submitApproval(BigInt(0), "reset");
    await submitApproval(amount, "approval");
    await input.onConfirmed?.();
    input.onStep?.("CONFIRMED");
    return { amount, balance, allowance, approvalHashes, formattedAmount: formatUnits(amount, input.decimals) };
  } catch (error) {
    throw new Error(toWalletErrorMessage(error), { cause: error });
  }
}
