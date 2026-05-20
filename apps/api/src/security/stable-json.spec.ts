import { stableStringify } from './stable-json';

describe('stableStringify', () => {
  it('sorts nested object keys', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
