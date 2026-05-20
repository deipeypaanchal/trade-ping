import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual } from 'crypto';

@Injectable()
export class CryptoService {
  private key(): Buffer {
    const raw = process.env.ENCRYPTION_KEY_BASE64;
    if (!raw) throw new Error('ENCRYPTION_KEY_BASE64 is required');
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes');
    return key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  decrypt(payload: string): string {
    const [version, ivB64, tagB64, ctB64] = payload.split('.');
    if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) throw new Error('Invalid encrypted payload');
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  }

  hmacBase64(key: string, body: string): string {
    return createHmac('sha256', key).update(body).digest('base64');
  }

  safeEqual(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }

  hash(input: string): string {
    return createHmac('sha256', this.key()).update(input).digest('hex');
  }
}
