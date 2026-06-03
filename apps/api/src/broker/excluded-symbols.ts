const EXCLUDED_BOT_SYMBOLS = new Set(['FDRXX']);

export function isExcludedBotSymbol(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return EXCLUDED_BOT_SYMBOLS.has(symbol.trim().toUpperCase());
}
