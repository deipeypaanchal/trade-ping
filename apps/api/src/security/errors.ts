/**
 * Thrown when a user's encrypted SnapTrade secret cannot be decrypted (key
 * mismatch, corrupted ciphertext, etc). Callers should mark the user's
 * brokerage connections as DISCONNECTED and prompt re-auth via /connect.
 */
export class EncryptedSecretError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'EncryptedSecretError';
  }
}
