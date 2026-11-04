// Deva keeps provider API keys in ~/.deva/secrets.json, encrypted with
// Electron's safeStorage: base64 of "v10" + 12-byte nonce + ciphertext + 16-byte
// GCM tag, under a 32-byte key that safeStorage itself stores in the app's
// Local State file, wrapped by the OS (DPAPI on Windows).
//
// Those two crypto steps are all this file does. Finding the key and the file is
// index.mjs's job; the tests run these against fixed vectors.

import crypto from "node:crypto"

const PREFIX = "v10"
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

/** The key safeStorage's Local State entry unwraps to, or null if it is not one. */
export function safeStorageKey(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== KEY_BYTES) return null
  return bytes
}

/** Encrypt like safeStorage does, so Deva can read it back. */
export function encodeSecret(plaintext, key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error("safeStorage 密钥长度不对")
  const nonce = crypto.randomBytes(NONCE_BYTES)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce)
  const body = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from(PREFIX, "ascii"), nonce, body, tag]).toString("base64")
}

/** Decrypt a value safeStorage wrote. Returns null when it is not ours to read. */
export function decodeSecret(encoded, key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) return null
  let raw
  try {
    raw = Buffer.from(String(encoded ?? ""), "base64")
  } catch {
    return null
  }
  if (raw.length < PREFIX.length + NONCE_BYTES + TAG_BYTES) return null
  if (raw.subarray(0, PREFIX.length).toString("ascii") !== PREFIX) return null

  const nonce = raw.subarray(PREFIX.length, PREFIX.length + NONCE_BYTES)
  const tag = raw.subarray(raw.length - TAG_BYTES)
  const body = raw.subarray(PREFIX.length + NONCE_BYTES, raw.length - TAG_BYTES)
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")
  } catch {
    return null
  }
}

/** Whether a stored value already holds this key, without ever touching a disk. */
export function secretHolds(encoded, key, expected) {
  return decodeSecret(encoded, key) === expected
}
