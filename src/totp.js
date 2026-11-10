import crypto from "node:crypto";

// RFC 6238, SHA-1 / 30-second steps / 6 digits for authenticator-app compatibility.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_MS = 30_000;

export function encodeBase32(bytes) {
  let bits = 0, value = 0, result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += ALPHABET[(value >>> (bits -= 5)) & 31];
    }
  }
  if (bits) result += ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

export function decodeBase32(value) {
  if (typeof value !== "string" || !/^[A-Z2-7]{16,64}$/.test(value)) throw new Error("Invalid TOTP secret.");
  let bits = 0, n = 0;
  const bytes = [];
  for (const char of value) {
    n = (n << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) bytes.push((n >>> (bits -= 8)) & 255);
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return encodeBase32(crypto.randomBytes(20));
}

export function totpAt(secret, counter, digits = 6) {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("Invalid TOTP counter.");
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const n = (digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits);
  return String(n).padStart(digits, "0");
}

export function matchTotp(secret, code, { now = Date.now(), lastCounter = -1, skew = 1 } = {}) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / TOTP_STEP_MS);
  for (let counter = current - skew; counter <= current + skew; counter++) {
    if (counter < 0 || counter <= lastCounter) continue;
    const candidate = totpAt(secret, counter);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) return counter;
  }
  return null;
}

function encryptionKey(env = process.env) {
  const input = env.ORAC_TOTP_ENCRYPTION_KEY;
  if (!input || !/^[A-Za-z0-9+/]{43}=$/.test(input)) throw new Error("ORAC_TOTP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  const key = Buffer.from(input, "base64");
  if (key.length !== 32) throw new Error("ORAC_TOTP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}

export function validateTotpEncryptionKey(env = process.env) {
  encryptionKey(env);
}

export function encryptTotpSecret(secret, env = process.env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptTotpSecret(value, env = process.env) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted TOTP secret.");
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted TOTP secret.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(env), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function digestOpaque(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function equalDigest(a, b) {
  return typeof a === "string" && typeof b === "string" && /^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b)
    && crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
