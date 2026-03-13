/**
 * Client-side encryption for settings sync
 * Uses Web Crypto API with AES-GCM encryption and PBKDF2 key derivation
 */

export interface EncryptedPayload {
  // Version of encryption format
  v: number;
  // Base64-encoded encrypted data
  data: string;
  // Base64-encoded IV (initialization vector)
  iv: string;
  // Base64-encoded salt for key derivation
  salt: string;
}

const ENCRYPTION_VERSION = 1;
const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

/**
 * Derive an encryption key from a passphrase using PBKDF2
 */
async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passphraseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passphraseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Convert ArrayBuffer to Base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert Base64 string to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encrypt settings data with a passphrase
 */
export async function encryptSettings(
  data: unknown,
  passphrase: string
): Promise<EncryptedPayload> {
  // Generate random salt and IV
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // Derive key from passphrase
  const key = await deriveKey(passphrase, salt);

  // Encrypt the data
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );

  return {
    v: ENCRYPTION_VERSION,
    data: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv),
    salt: arrayBufferToBase64(salt),
  };
}

/**
 * Decrypt settings data with a passphrase
 */
export async function decryptSettings<T = unknown>(
  payload: EncryptedPayload,
  passphrase: string
): Promise<T> {
  if (payload.v !== ENCRYPTION_VERSION) {
    throw new Error(`Unsupported encryption version: ${payload.v}`);
  }

  // Decode Base64 values
  const salt = base64ToUint8Array(payload.salt);
  const iv = base64ToUint8Array(payload.iv);
  const ciphertext = base64ToUint8Array(payload.data);

  // Derive key from passphrase
  const key = await deriveKey(passphrase, salt);

  // Decrypt the data
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch (error) {
    // AES-GCM will throw if the passphrase is wrong (authentication tag mismatch)
    throw new Error('Decryption failed. Wrong passphrase?');
  }
}

/**
 * Verify a passphrase can decrypt the payload without returning the data
 */
export async function verifyPassphrase(
  payload: EncryptedPayload,
  passphrase: string
): Promise<boolean> {
  try {
    await decryptSettings(payload, passphrase);
    return true;
  } catch {
    return false;
  }
}
