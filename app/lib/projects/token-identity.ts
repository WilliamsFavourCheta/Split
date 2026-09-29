export const MAX_TOKEN_NAME_CHARACTERS = 50;
export const MIN_TOKEN_SYMBOL_CHARACTERS = 2;
export const MAX_TOKEN_SYMBOL_CHARACTERS = 8;
const MAX_ONCHAIN_NAME_BYTES = 64;

export function normalizeTokenName(value: string) {
  return value.trim();
}

export function normalizeTokenSymbol(value: string) {
  return value.trim().replace(/[a-z]/g, (letter) => letter.toUpperCase());
}

export function validateTokenIdentity(rawName: string, rawSymbol: string) {
  const name = normalizeTokenName(rawName);
  const symbol = normalizeTokenSymbol(rawSymbol);
  const nameCharacters = Array.from(name).length;
  const symbolCharacters = Array.from(symbol).length;
  const nameError = nameCharacters === 0
    ? "Enter a token name."
    : nameCharacters > MAX_TOKEN_NAME_CHARACTERS
      ? `Token name must be ${MAX_TOKEN_NAME_CHARACTERS} characters or fewer.`
      : new TextEncoder().encode(name).length > MAX_ONCHAIN_NAME_BYTES
        ? "Token name exceeds the contract's 64-byte UTF-8 limit. Shorten it."
        : null;
  const symbolError = symbolCharacters < MIN_TOKEN_SYMBOL_CHARACTERS
    ? `Token symbol must be at least ${MIN_TOKEN_SYMBOL_CHARACTERS} characters.`
    : symbolCharacters > MAX_TOKEN_SYMBOL_CHARACTERS
      ? `Token symbol must be ${MAX_TOKEN_SYMBOL_CHARACTERS} characters or fewer.`
      : !/^[A-Z0-9]+$/.test(symbol)
        ? "Use only A–Z and 0–9 in the token symbol."
        : null;

  return {
    name,
    symbol,
    nameCharacters,
    symbolCharacters,
    nameError,
    symbolError,
    valid: !nameError && !symbolError,
  };
}
