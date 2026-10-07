import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Fernet wire format, retained for compatibility with the original Python data volume.
 * Uses Node's AES-CBC and HMAC implementations; authenticate before decrypting.
 * Expiration is enforced by the Store rather than the Fernet token timestamp.
 */
export class SecretCipher {
  private readonly signingKey: Buffer;
  private readonly encryptionKey: Buffer;
  constructor(encodedKey: string) {
    const key = Buffer.from(encodedKey.trim(), 'base64url');
    if (key.length !== 32 || !/^[A-Za-z0-9_-]+={0,2}$/.test(encodedKey.trim()))
      throw new Error(
        'Invalid Jellyport encryption key. Restore the original secret.key from backup.',
      );
    this.signingKey = key.subarray(0, 16);
    this.encryptionKey = key.subarray(16);
  }
  encrypt(value: unknown): Buffer {
    const header = Buffer.alloc(9);
    header[0] = 0x80;
    header.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)), 1);
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-128-cbc', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    const body = Buffer.concat([header, iv, ciphertext]);
    const signature = createHmac('sha256', this.signingKey).update(body).digest();
    // Python Fernet expects padded URL-safe base64.
    return Buffer.from(
      Buffer.concat([body, signature]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    );
  }
  decrypt<T>(value: Uint8Array | string): T {
    try {
      const encoded = typeof value === 'string' ? value : Buffer.from(value).toString('ascii');
      if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) throw new Error();
      const token = Buffer.from(encoded, 'base64url');
      if (token.length < 73 || token[0] !== 0x80 || (token.length - 57) % 16 !== 0)
        throw new Error();
      const body = token.subarray(0, -32);
      const signature = createHmac('sha256', this.signingKey).update(body).digest();
      if (!timingSafeEqual(signature, token.subarray(-32))) throw new Error();
      const decipher = createDecipheriv('aes-128-cbc', this.encryptionKey, token.subarray(9, 25));
      return JSON.parse(
        Buffer.concat([decipher.update(token.subarray(25, -32)), decipher.final()]).toString(
          'utf8',
        ),
      ) as T;
    } catch {
      throw new Error(
        'Saved Jellyport secrets could not be decrypted. Restore the matching database and secret.key.',
      );
    }
  }
}
