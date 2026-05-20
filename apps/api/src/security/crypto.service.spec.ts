import { CryptoService } from './crypto.service';

describe('CryptoService', () => {
  beforeAll(() => { process.env.ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64'); });
  it('encrypts and decrypts', () => {
    const svc = new CryptoService();
    const encrypted = svc.encrypt('secret');
    expect(encrypted).not.toContain('secret');
    expect(svc.decrypt(encrypted)).toBe('secret');
  });
});
