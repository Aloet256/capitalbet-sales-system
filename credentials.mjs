import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const digest = token => createHash('sha256').update(token).digest('hex');
export function randomPin(previous) {
  let pin;
  do { pin = String(randomInt(100_000, 1_000_000)); } while (pin === previous);
  return pin;
}

export async function hashSecret(secret) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(secret, salt, 32);
  return `${salt}:${hash.toString('hex')}`;
}

export async function matches(secret, stored) {
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(await derive(secret, salt, 32), Buffer.from(hash, 'hex'));
}

export function createPinVault(keyHex) {
  if (!keyHex) return null;
  if (!/^[\da-f]{64}$/i.test(keyHex)) throw new Error('CAPITALBET_PIN_KEY must be a 32-byte hexadecimal key.');
  const key = Buffer.from(keyHex, 'hex');
  return {
    async protect(name, pin = randomPin()) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(name));
      const ciphertext = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()]);
      return { hash: await hashSecret(pin), cipher: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url') };
    },
    reveal(name, sealed) {
      const bytes = Buffer.from(sealed, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(name));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
