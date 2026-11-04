import assert from "node:assert/strict"
import test from "node:test"
import { decodeSecret, encodeSecret, safeStorageKey, secretHolds } from "../lib/deva-secrets.mjs"

// safeStorage's own format: base64 of "v10" + 12-byte nonce + ciphertext + 16-byte tag.
const key = Buffer.alloc(32, 7)

test("the encoding is the one safeStorage writes", () => {
  const raw = Buffer.from(encodeSecret("magpie-deva", key), "base64")
  assert.equal(raw.subarray(0, 3).toString("ascii"), "v10")
  assert.equal(raw.length, 3 + 12 + "magpie-deva".length + 16)
})

test("a key written here reads back the same", () => {
  assert.equal(decodeSecret(encodeSecret("magpie-deva", key), key), "magpie-deva")
})

test("a wrong key yields nothing rather than garbage", () => {
  const encoded = encodeSecret("magpie-deva", key)
  assert.equal(decodeSecret(encoded, Buffer.alloc(32, 9)), null)
})

test("junk is refused instead of thrown", () => {
  assert.equal(decodeSecret("", key), null)
  assert.equal(decodeSecret("not-base64-at-all", key), null)
  assert.equal(decodeSecret(Buffer.alloc(8).toString("base64"), key), null)
  // A value with the right length but the wrong marker is someone else's format.
  assert.equal(decodeSecret(Buffer.alloc(3 + 12 + 5 + 16, 1).toString("base64"), key), null)
})

test("a key of the wrong size is refused", () => {
  assert.equal(safeStorageKey(Buffer.alloc(16)), null)
  assert.equal(safeStorageKey(null), null)
  assert.equal(safeStorageKey(Buffer.alloc(32)).length, 32)
  assert.throws(() => encodeSecret("x", Buffer.alloc(8)))
})

test("secretHolds compares without exposing the value", () => {
  const encoded = encodeSecret("magpie-deva", key)
  assert.equal(secretHolds(encoded, key, "magpie-deva"), true)
  assert.equal(secretHolds(encoded, key, "magpie"), false)
})

test("each write uses a fresh nonce", () => {
  assert.notEqual(encodeSecret("same", key), encodeSecret("same", key))
})
