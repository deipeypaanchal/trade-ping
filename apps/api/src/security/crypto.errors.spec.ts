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
    const parts = enc.split('.');
    parts[3] = `${parts[3][0] === 'A' ? 'B' : 'A'}${parts[3].slice(1)}`;
    const tampered = parts.join('.');
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
