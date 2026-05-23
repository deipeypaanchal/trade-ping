/**
 * Pure asset-type helpers. The "is this an option / what's the contract
 * multiplier" rules live here so PnL math and alert rendering never disagree.
 */

export type AssetType = 'EQUITY' | 'OPTION' | 'CRYPTO' | 'FOREX' | 'UNKNOWN';

/** OCC option symbol shape: "AAPL  250321C00150000" — 6-digit yymmdd, C/P, 8-digit strike×1000. */
const OCC_OPTION_PATTERN = /\s\d{6}[CP]\d{8}$/;

export function inferAssetType(params: { explicit?: AssetType | null; hasOptionSymbol?: boolean; symbol?: string }): AssetType {
  if (params.explicit && params.explicit !== 'UNKNOWN') return params.explicit;
  if (params.hasOptionSymbol) return 'OPTION';
  if (params.symbol && OCC_OPTION_PATTERN.test(params.symbol)) return 'OPTION';
  return 'EQUITY';
}

export function contractMultiplier(assetType: AssetType | null | undefined, symbol?: string): number {
  if (assetType === 'OPTION') return 100;
  if (!assetType && symbol && OCC_OPTION_PATTERN.test(symbol)) return 100; // legacy rows
  return 1;
}

export function isOptionSymbol(symbol: string): boolean {
  return OCC_OPTION_PATTERN.test(symbol);
}
