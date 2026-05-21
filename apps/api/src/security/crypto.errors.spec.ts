import { CryptoService } from './crypto.service';
import { EncryptedSecretError } from './errors';

describe('CryptoService', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  beforeAll(() => { process.env.ENCRYPTION_KEY_BASE64 = KEY; });

  it('round-trips encrypt/decrypt', () => {
    const svc = new CryptoService();
    const out = svc.decrypt(svc.encrypt('hello'));
    expect(out).toBe('hello');
  });

  it('throws EncryptedSecretError on a corrupted payload', () => {
    const svc = new CryptoService();
    const enc = svc.encrypt('hello');
    const tampered = enc.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect(() => svc.decrypt(tampered)).toThrow(EncryptedSecretError);
  });

  it('throws EncryptedSecretError when the key changes', () => {
    const svc = new CryptoService();
    const enc = svc.encrypt('hello');
    // Force a different key by clearing cache + flipping env temporarily.
    process.env.ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 9).toString('base64');
    const fresh = new CryptoService();
    expect(() => fresh.decrypt(enc)).toThrow(EncryptedSecretError);
    process.env.ENCRYPTION_KEY_BASE64 = KEY;
  });
});
