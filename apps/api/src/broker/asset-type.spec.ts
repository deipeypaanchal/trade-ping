import { contractMultiplier, inferAssetType, isOptionSymbol } from './asset-type';

describe('inferAssetType', () => {
  it('honors an explicit assetType', () => {
    expect(inferAssetType({ explicit: 'CRYPTO' })).toBe('CRYPTO');
  });

  it('classifies as OPTION when an option_symbol is present', () => {
    expect(inferAssetType({ hasOptionSymbol: true, symbol: 'AAPL' })).toBe('OPTION');
  });

  it('classifies as OPTION via OCC symbol shape', () => {
    expect(inferAssetType({ symbol: 'AAPL  250321C00150000' })).toBe('OPTION');
  });

  it('defaults to EQUITY for unknown plain tickers', () => {
    expect(inferAssetType({ symbol: 'AAPL' })).toBe('EQUITY');
  });
});

describe('contractMultiplier', () => {
  it('returns 100 for options', () => {
    expect(contractMultiplier('OPTION')).toBe(100);
  });

  it('returns 1 for equities/crypto/forex', () => {
    expect(contractMultiplier('EQUITY')).toBe(1);
    expect(contractMultiplier('CRYPTO')).toBe(1);
    expect(contractMultiplier('FOREX')).toBe(1);
  });

  it('falls back to OCC symbol shape when assetType is unknown (legacy rows)', () => {
    expect(contractMultiplier(undefined, 'AAPL  250321C00150000')).toBe(100);
    expect(contractMultiplier(null, 'AAPL')).toBe(1);
  });
});

describe('isOptionSymbol', () => {
  it.each([
    ['AAPL  250321C00150000', true],
    ['SPY   260116P00500000', true],
    ['AAPL', false],
    ['', false],
  ])('isOptionSymbol(%j) -> %j', (symbol, expected) => {
    expect(isOptionSymbol(symbol)).toBe(expected);
  });
});
