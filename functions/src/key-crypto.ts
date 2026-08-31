// Reversible storage for administrator-only API-key reveal.
//
// Authentication continues to use the one-way key_hash. This module only
// protects the copy/reveal value at rest; it never stores the plaintext.
const VERSION = 'v1';
const IV_BYTES = 12;

function toHex(value: ArrayBuffer | Uint8Array): string {
  return Array.from(value instanceof Uint8Array ? value : new Uint8Array(value))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Invalid encrypted API key');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function resolveApiKeyEncryptionSecret(db: { getSetting(key: string): Promise<string | null>; setSettingIfAbsent(key: string, value: string): Promise<string> }, configured?: string): Promise<string> {
  // Once a database has a key, keep using it even if an operator later adds a
  // Worker secret. Otherwise every previously encrypted API key would become
  // undecryptable the moment the deployment configuration changed.
  const stored = await db.getSetting('api_key_encryption_secret');
  if (stored) return stored;

  const explicit = String(configured || '').trim();
  if (explicit) {
    return db.setSettingIfAbsent('api_key_encryption_secret', explicit);
  }

  return db.setSettingIfAbsent(
    'api_key_encryption_secret',
    toHex(crypto.getRandomValues(new Uint8Array(32)))
  );
}

export async function encryptApiKey(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(secret),
    new TextEncoder().encode(value)
  );
  return `${VERSION}:${toHex(iv)}:${toHex(encrypted)}`;
}

export async function decryptApiKey(payload: string, secret: string): Promise<string> {
  const [version, ivHex, ciphertextHex] = String(payload || '').split(':');
  if (version !== VERSION || !ivHex || !ciphertextHex) throw new Error('Invalid encrypted API key');
  const iv = fromHex(ivHex);
  if (iv.length !== IV_BYTES) throw new Error('Invalid encrypted API key');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(secret),
    fromHex(ciphertextHex)
  );
  return new TextDecoder().decode(plaintext);
}
