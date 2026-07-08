import { timingSafeEqual } from 'node:crypto';

export function safeEqual(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function safeBearerEqual(header: string | undefined, expectedSecret: string): boolean {
  const prefix = 'Bearer ';
  if (typeof header !== 'string' || !header.startsWith(prefix)) return false;
  return safeEqual(header.slice(prefix.length), expectedSecret);
}
