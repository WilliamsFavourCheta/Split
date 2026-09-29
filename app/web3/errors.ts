function getErrorCode(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ("code" in current && typeof current.code === "number") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

function getSafeWalletDetail(error: unknown): string | null {
  let current: unknown = error;
  const details: string[] = [];
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const detail = "shortMessage" in current && typeof current.shortMessage === "string"
      ? current.shortMessage
      : getErrorText(current);
    if (detail) {
      const safe = detail.split(/\r?\n/)[0].trim()
        .replace(/https?:\/\/[^\s"'`]+/g, "[RPC endpoint]")
        .replace(/0x[\da-fA-F]{64,}/g, "[hex data]");
      if (safe && !details.includes(safe)) details.push(safe);
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return details.length ? details.slice(0, 2).join(" / ").slice(0, 240) : null;
}

export function toWalletErrorMessage(error: unknown): string {
  const code = getErrorCode(error);
  const message = getErrorText(error).toLowerCase();

  if (code === 4001 || message.includes("user rejected") || message.includes("user denied")) {
    return "Request rejected in your wallet. Nothing was submitted.";
  }
  if (code === 4902) return "This network is not in your wallet yet. Approve adding Robinhood Chain to continue.";
  if (code === -32002 || message.includes("request already pending")) return "A wallet request is already open. Finish or dismiss it in your wallet first.";
  if (message.includes("provider not found") || message.includes("connector not found") || message.includes("no wallet")) {
    return "No EVM wallet was detected. Install MetaMask or another EVM-compatible wallet, then refresh this page.";
  }
  if (message.includes("insufficient funds") || message.includes("insufficient native")) {
    return "There is not enough ETH in this wallet to cover the amount and network gas.";
  }
  if (message.includes("allowance") || message.includes("approval")) return "The token approval failed. Check the token, spender, and wallet network, then try again.";
  if (message.includes("balance") || message.includes("transfer amount exceeds")) return "The token balance is lower than the amount required for this action.";
  if (message.includes("revert") || message.includes("execution reverted") || message.includes("contractfunctionreverted")) {
    return "The contract rejected this transaction. Check its requirements and try again.";
  }
  if (message.includes("chain") || message.includes("network")) return "The wallet is on the wrong network or the RPC is unavailable.";
  if (message.includes("fetch") || message.includes("timeout") || message.includes("rpc") || message.includes("http request failed")) {
    return "Could not reach the Robinhood Chain RPC. Check your connection and try again.";
  }
  return "Wallet request failed. Please try again.";
}

export function toLaunchErrorMessage(error: unknown): string {
  const message = toWalletErrorMessage(error);
  const detail = getSafeWalletDetail(error);
  if (!detail || message.toLowerCase().includes(detail.toLowerCase())) return message;
  const code = getErrorCode(error);
  return `${message} Wallet/RPC detail: ${detail}${code === undefined ? "" : ` (code ${code})`}.`;
}
